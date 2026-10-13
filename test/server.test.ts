import { afterAll, expect, test } from "bun:test"
import {
  mkdir,
  mkdtemp,
  open as openFile,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { connect } from "node:net"
import { networkInterfaces, tmpdir } from "node:os"
import { dirname, join, sep } from "node:path"
import { requireCleanTreeForNewRun, requireUsableRepo, resumeTaskBranch, taskBranchName } from "../src/git"
import { addProject, defaults, loadProjects } from "../src/projects"
import type { Project } from "../src/projects"
import { taskKey } from "../src/runindex"
import { createRunLog, runLogPath } from "../src/runlog"
import type { RunHeader, RunLog, RunRecord } from "../src/runlog"
import { ROUTES, TOKEN_EXEMPT, createServer, type Launch, type RouteContext } from "../src/server"
import type { Ask } from "../src/draft"
import type { Acted, Runner, StartRequest, Started } from "../src/server"
/* Type-only, so nothing of the component - React included - is loaded by this
 * suite or by the server. The payload is the component's own type, borrowed
 * rather than restated, so a renamed field is a compile error here. */
import type { TreeProject } from "../src/ui/Tree.tsx"

// These endpoints hand arbitrary text to an agent with file-write and shell
// access, so the guards below are the project's only security boundary.
// "it only listens on localhost" is not one of them: any page the owner visits
// can POST to a localhost port, and DNS rebinding can make the attacker's
// domain resolve to 127.0.0.1 so their page becomes same-origin with us. The
// Host header is what catches that, which is why an absent Host is refused
// rather than read as local.

const launched: Launch[] = []

/** A loopback launch on an OS-assigned port, stopped when the suite ends. */
/**
 * A refusing model, which every launch here gets unless it asks for one.
 *
 * Structural rather than careful. `askHaiku` spawns the real `claude` binary
 * and bills a real account, so a route that reaches a model is a test that
 * costs money and takes seconds - and the first one to do it did so by
 * accident, in a case that was only ever about a guard. Defaulting to a throw
 * means a billed call cannot happen without someone writing `ask` down.
 */
const NO_MODEL: Ask = async () => {
  throw new Error("this launch has no model; pass `ask` to exercise a drafting route")
}

function serve(opts: Parameters<typeof createServer>[0] = {}): Launch {
  /* `distDir` points at nothing, for the reason `runsDir` is always injected:
   * the default is the repo's real `dist/`, so without this every test that
   * loads a page would pass or fail on whether the developer had run `bun run
   * build`. The build's own route is covered by `test/assets.test.ts`. */
  /* `homeDir` points at an empty scratch directory for the reason `distDir`
   * does, and it was not injected at first: `discoverProfiles` defaults to the
   * real home, so the tree answered the developer's own `~/.claude-work`
   * inside `bun test` and the suite's result depended on whose machine it ran
   * on. `test/profiles.test.ts` builds a fake home to test discovery itself. */
  const l = createServer({
    port: 0,
    ask: NO_MODEL,
    distDir: join(tmpdir(), "orch-no-dist"),
    homeDir: join(tmpdir(), "orch-no-home"),
    ...opts,
  })
  launched.push(l)
  return l
}

/** A launch whose model answers `reply`, and the prompts it was given. */
function serveAsking(reply: string, opts: Parameters<typeof createServer>[0] = {}): {
  l: Launch
  prompts: string[]
} {
  const prompts: string[] = []
  const l = serve({
    ...opts,
    ask: async (prompt: string) => {
      prompts.push(prompt)
      return reply
    },
  })
  return { l, prompts }
}

afterAll(() => {
  for (const l of launched) l.stop()
})

interface Call {
  path?: string
  method?: string
  /** Forged freely: Bun's fetch sends what we ask and still connects to the
   * real authority, which is how the rebinding guard is exercised for real. */
  host?: string
  /** `null` omits the header, as a top-level navigation does. */
  origin?: string | null
  /** `null` omits it. Absent means the launch's own token. */
  cookie?: string | null
  /** Absent sends no body at all, which on a POST is indistinguishable on the
   * wire from an empty one: probed, Bun declares `Content-Length: 0` for both.
   * A `ReadableStream` is sent chunked, with no declared length. */
  body?: string | ReadableStream<Uint8Array>
  /** Absent sends whatever `fetch` chooses, which for a string body is
   * `text/plain`. Nothing in the server reads it; see the body enumeration. */
  contentType?: string
}

async function call(l: Launch, c: Call = {}): Promise<{ status: number; headers: Headers; body: string }> {
  const headers = new Headers({ Host: c.host ?? `127.0.0.1:${l.port}` })
  const origin = c.origin === undefined ? `http://127.0.0.1:${l.port}` : c.origin
  if (origin !== null) headers.set("Origin", origin)
  const cookie = c.cookie === undefined ? `kantan_token=${l.token}` : c.cookie
  if (cookie !== null) headers.set("Cookie", cookie)
  if (c.contentType !== undefined) headers.set("Content-Type", c.contentType)

  const res = await fetch(`http://127.0.0.1:${l.port}${c.path ?? "/api/health"}`, {
    method: c.method ?? "GET",
    headers,
    redirect: "manual",
    // `duplex` is required for a stream body and is not in the DOM typings.
    ...(c.body === undefined ? {} : ({ body: c.body, duplex: "half" } as RequestInit)),
  })
  return { status: res.status, headers: res.headers, body: await res.text() }
}

/** Speaks HTTP by hand, for the rows fetch cannot express: no Host header at
 * all, an empty one, or two of them. */
function raw(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1", () => sock.write(payload))
    let seen = ""
    const giveUp = setTimeout(() => {
      sock.destroy()
      resolve(seen || "(no response)")
    }, 2000)
    const done = (value: string) => {
      clearTimeout(giveUp)
      resolve(value)
    }
    sock.on("data", (d) => {
      seen += d
    })
    sock.on("end", () => done(seen))
    sock.on("error", (e) => {
      clearTimeout(giveUp)
      reject(e)
    })
  })
}

/** A path no route will ever claim, so a 404 means "cleared every guard" for
 * as long as this suite lives, whatever Tasks 17 and 18 add. */
const UNROUTED = "/api/__guard_probe__"

const app = serve()
const PORT = app.port

// ---------------------------------------------------------------------------
// 1. The bind address, proved rather than read
// ---------------------------------------------------------------------------

/** Every non-loopback IPv4 this machine answers on. */
function outsideAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((addrs) => addrs ?? [])
    .filter((a) => a.family === "IPv4" && !a.internal)
    .map((a) => a.address)
}

const outside = outsideAddresses()[0]

/** Resolves to the status, or to the connection error, without throwing. */
async function reach(address: string, port: number): Promise<string> {
  try {
    const res = await fetch(`http://${address}:${port}/api/health`, { signal: AbortSignal.timeout(3000) })
    await res.arrayBuffer()
    return `status ${res.status}`
  } catch (e) {
    return `unreachable: ${(e as Error).message}`
  }
}

test.skipIf(outside === undefined)(
  "binds 127.0.0.1 only: unreachable on this machine's outside address, where a 0.0.0.0 server answers",
  async () => {
    const [address] = outsideAddresses()
    if (address === undefined) throw new Error("no non-loopback IPv4: this test should have been skipped, not passed")

    // The control comes first. If a wide-bound server were also unreachable
    // here, the assertion below would pass for the wrong reason - a firewall,
    // a broken route - and would keep passing after someone bound 0.0.0.0.
    const wide = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => new Response("wide") })
    try {
      if (wide.port === undefined) throw new Error("the control server bound no TCP port")
      expect(await reach(address, wide.port)).toBe("status 200")
    } finally {
      wide.stop(true)
    }

    // Same probe, same address, against our server: refused at the TCP layer.
    expect(await reach(address, PORT)).toStartWith("unreachable")

    // And it is up, so "unreachable" is about the address and not about the
    // server being dead.
    expect((await call(app)).status).toBe(200)

    // Cheap corroboration only. On its own this just echoes the config back.
    expect(app.server.hostname).toBe("127.0.0.1")
  },
)

test("takes no hostname option, so it cannot be widened by configuration", () => {
  // The absence is the point: there is no knob to set to 0.0.0.0, so a wide
  // bind would have to be a code edit rather than a config mistake.
  const probe = serve({ port: 0, hostname: "0.0.0.0" } as Parameters<typeof createServer>[0])
  expect(probe.server.hostname).toBe("127.0.0.1")
})

// ---------------------------------------------------------------------------
// 2. The per-launch token
// ---------------------------------------------------------------------------

test("mints a different token each launch", () => {
  const a = serve()
  const b = serve()
  expect(a.token).not.toBe(b.token)
  expect(a.token).not.toBe(app.token)
  // Guessing has to be hopeless, not merely unlikely.
  expect(a.token.length).toBeGreaterThanOrEqual(32)
  expect(a.token).toMatch(/^[A-Za-z0-9_-]+$/)
})

test("requires the token on a GET, not only on writes", async () => {
  expect((await call(app, { cookie: null })).status).toBe(401)
  expect((await call(app, { cookie: "kantan_token=" })).status).toBe(401)
  expect((await call(app, { cookie: `kantan_token=${app.token}x` })).status).toBe(401)
  expect((await call(app, { cookie: `kantan_token=${app.token.slice(0, -1)}` })).status).toBe(401)
  expect((await call(app, { cookie: "nottheone=1" })).status).toBe(401)
  // Another launch's token is somebody else's.
  expect((await call(app, { cookie: `kantan_token=${serve().token}` })).status).toBe(401)
})

test("a cookie-authenticated request succeeds where an unauthenticated one fails", async () => {
  expect((await call(app, { cookie: null })).status).toBe(401)
  expect((await call(app, { cookie: `kantan_token=${app.token}` })).status).toBe(200)
})

test("reads the token from a cookie, never from a header, because EventSource cannot send headers", async () => {
  // Task 17 streams the run over SSE. EventSource has no API for custom
  // headers, so a header-only token would make the run stream impossible.
  const l = serve()
  const res = await fetch(`http://127.0.0.1:${l.port}/api/health`, {
    headers: { Host: `127.0.0.1:${l.port}`, Authorization: `Bearer ${l.token}`, "X-Orch-Token": l.token },
  })
  await res.arrayBuffer()
  expect(res.status).toBe(401)
})

test("accepts the token among other cookies, and when a local neighbour has tossed a decoy", async () => {
  // Cookies ignore ports, so any page on another localhost port can set
  // kantan_token for this host. It cannot know the real value, so the browser
  // sends both and we accept if any value matches: a decoy is then noise
  // rather than a denial of service, and still never a bypass.
  expect((await call(app, { cookie: `theme=dark; kantan_token=${app.token}; tz=UTC` })).status).toBe(200)
  expect((await call(app, { cookie: `kantan_token=decoy; kantan_token=${app.token}` })).status).toBe(200)
  expect((await call(app, { cookie: `kantan_token=${app.token}; kantan_token=decoy` })).status).toBe(200)
  // A name that merely contains ours is a different cookie.
  expect((await call(app, { cookie: `xkantan_token=${app.token}` })).status).toBe(401)
  expect((await call(app, { cookie: `kantan_token_x=${app.token}` })).status).toBe(401)
})

// ---------------------------------------------------------------------------
// 3. Page load sets the cookie, and is the only thing exempt from the token
// ---------------------------------------------------------------------------

test("page load sets the token as a SameSite=Strict cookie", async () => {
  const l = serve()
  const res = await call(l, { path: "/", cookie: null, origin: null })
  expect(res.status).toBe(200)

  const setCookie = res.headers.get("set-cookie") ?? ""
  expect(setCookie).toContain(`kantan_token=${l.token}`)
  expect(setCookie).toContain("SameSite=Strict")
  expect(setCookie).toContain("HttpOnly")
  expect(setCookie).toContain("Path=/")
  // No Max-Age or Expires: the token dies with the launch, so the cookie
  // should too rather than linger and 401 after a restart.
  expect(setCookie).not.toContain("Max-Age")
  expect(setCookie).not.toContain("Expires")

  // The body must not carry the token, or a page that can read a response
  // gains what the HttpOnly cookie was hiding.
  expect(res.body).not.toContain(l.token)

  // And the cookie it handed out works.
  expect((await call(l, { cookie: `kantan_token=${l.token}` })).status).toBe(200)
})

test("the bootstrap route is behind the guards: a bad Host gets no cookie", async () => {
  for (const path of ["/", "/api/session"]) {
    const res = await call(app, { path, cookie: null, origin: null, host: "evil.example.com" })
    expect(res.status).toBe(403)
    expect(res.headers.get("set-cookie")).toBeNull()
    expect(res.body).not.toContain(app.token)
  }
})

test("exactly the two bootstrap routes are exempt from the token", () => {
  // A new route is non-exempt by default, and widening this set has to be a
  // deliberate edit that fails this test first.
  expect([...TOKEN_EXEMPT].sort()).toEqual(["GET /", "GET /api/session"])
  for (const key of TOKEN_EXEMPT) expect(Object.keys(ROUTES)).toContain(key)
})

// ---------------------------------------------------------------------------
// 4. Host: the DNS-rebinding guard, enumerated
// ---------------------------------------------------------------------------

interface Row {
  host: string
  status: number
  why: string
}

const hostRows: Row[] = [
  { host: `127.0.0.1:${PORT}`, status: 200, why: "allowlisted exactly; the control for every row below" },
  { host: `localhost:${PORT}`, status: 200, why: "allowlisted exactly; what the owner usually types" },
  { host: "evil.example.com", status: 403, why: "the rebinding case: resolves to 127.0.0.1, is not us" },
  { host: `127.0.0.1.evil.com:${PORT}`, status: 403, why: "the prefix trap a startsWith check would accept" },
  { host: `localhost.evil.com:${PORT}`, status: 403, why: "the suffix trap an endsWith check would accept" },
  { host: `evil.com:${PORT}#127.0.0.1:${PORT}`, status: 403, why: "no substring of an allowlist entry counts" },
  { host: `LOCALHOST:${PORT}`, status: 403, why: "browsers lowercase the host; only a hand-written client loses" },
  { host: `localhost.:${PORT}`, status: 403, why: "trailing dot is a separate browser origin with separate cookies" },
  { host: `[::1]:${PORT}`, status: 403, why: "we never bind IPv6, so this cannot be a real request to us" },
  { host: `[::ffff:127.0.0.1]:${PORT}`, status: 403, why: "IPv4-mapped IPv6, unreachable for the same reason" },
  { host: "127.0.0.1", status: 403, why: "no port means port 80, which needs root; we are not there" },
  { host: `127.0.0.1:${PORT + 1}`, status: 403, why: "another service's port; a mismatch means a proxy or a forgery" },
  { host: `0.0.0.0:${PORT}`, status: 403, why: "reachable on Linux and historically soft in browsers, so not allowlisted" },
  { host: `127.1:${PORT}`, status: 403, why: "shorthand spelling of loopback; allowlist is of strings, not addresses" },
  { host: `2130706433:${PORT}`, status: 403, why: "decimal spelling of 127.0.0.1, the classic bypass" },
]

for (const row of hostRows) {
  test(`Host ${JSON.stringify(row.host)} -> ${row.status} (${row.why})`, async () => {
    // Otherwise a fully valid request, so the status can only be about Host.
    expect((await call(app, { host: row.host })).status).toBe(row.status)
  })
}

test("Host absent entirely -> 403, never read as local", async () => {
  // HTTP/1.1 without a Host is malformed and Bun answers 400 itself, before
  // our handler sees it. HTTP/1.0 has no such requirement, so that is the
  // shape that actually reaches us, and it must be refused.
  const eleven = await raw(PORT, "GET /api/health HTTP/1.1\r\nConnection: close\r\n\r\n")
  expect(eleven).toStartWith("HTTP/1.1 400")

  const ten = await raw(
    PORT,
    `GET /api/health HTTP/1.0\r\nCookie: kantan_token=${app.token}\r\nConnection: close\r\n\r\n`,
  )
  expect(ten).toStartWith("HTTP/1.1 403")
})

test("Host empty, or sent twice, -> 403", async () => {
  const empty = await raw(PORT, `GET /api/health HTTP/1.1\r\nHost:\r\nCookie: kantan_token=${app.token}\r\nConnection: close\r\n\r\n`)
  expect(empty).toStartWith("HTTP/1.1 403")

  // Two Host headers arrive joined as "a, b", which matches no allowlist
  // entry. Smuggling one good value past us needs the pair to be accepted.
  const twice = await raw(
    PORT,
    `GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nHost: evil.example.com\r\nCookie: kantan_token=${app.token}\r\nConnection: close\r\n\r\n`,
  )
  expect(twice).toStartWith("HTTP/1.1 403")
})

test("a whitespace-padded Host never reaches the guard: the parser strips it first", async () => {
  // Probed: both Headers and Bun's HTTP parser strip leading and trailing
  // whitespace from a header value, as the spec requires. So " 127.0.0.1:p "
  // arrives already trimmed and matches exactly. Worth a test because the
  // alternative reading - that the guard accepts padding - would be a hole,
  // and because the day a parser stops trimming, this fails and says so.
  const padded = await raw(
    PORT,
    `GET /api/health HTTP/1.1\r\nHost: \t127.0.0.1:${PORT} \t\r\nCookie: kantan_token=${app.token}\r\nConnection: close\r\n\r\n`,
  )
  expect(padded).toStartWith("HTTP/1.1 200")
})

test("0.0.0.0 really reaches a loopback-bound server, and is refused there", async () => {
  // Not a hypothetical row: Linux routes a connect to 0.0.0.0 to loopback, so
  // this is a live request with a Host we do not allowlist.
  const res = await fetch(`http://0.0.0.0:${PORT}/api/health`, {
    headers: { Cookie: `kantan_token=${app.token}` },
    signal: AbortSignal.timeout(3000),
  })
  await res.arrayBuffer()
  expect(res.status).toBe(403)
})

// ---------------------------------------------------------------------------
// 5. Origin, enumerated
// ---------------------------------------------------------------------------

interface OriginRow {
  origin: string | null
  method?: string
  path?: string
  status: number
  why: string
}

/** 404 means the request cleared every guard and only then found no route. */
const originRows: OriginRow[] = [
  { origin: null, status: 200, why: "a top-level navigation sends no Origin; refusing it would refuse page loads" },
  { origin: null, method: "HEAD", path: UNROUTED, status: 404, why: "safe method, no Origin expected; the 404 shows it cleared the guards" },
  { origin: null, method: "POST", path: UNROUTED, status: 403, why: "browsers always send Origin on a POST, so absent means not a browser" },
  { origin: null, method: "DELETE", path: UNROUTED, status: 403, why: "keyed on 'not GET or HEAD', so a later verb cannot slip through" },
  { origin: `http://127.0.0.1:${PORT}`, status: 200, why: "our own origin" },
  { origin: `http://localhost:${PORT}`, status: 200, why: "our own origin, the other spelling" },
  { origin: `http://127.0.0.1:${PORT}`, method: "POST", path: UNROUTED, status: 404, why: "a POST from our own origin clears the guards" },
  // The POST rows go to an unrouted path, so a cleared guard shows up as 404
  // and a refusal as 403: the difference is the Origin check and nothing else.
  { origin: "http://evil.example.com", method: "POST", path: UNROUTED, status: 403, why: "a POST from a foreign origin, the case the guard exists for" },
  { origin: "http://127.0.0.1", method: "POST", path: UNROUTED, status: 403, why: "no port means port 80, which is not where we serve" },
  { origin: `http://localhost.:${PORT}`, method: "POST", path: UNROUTED, status: 403, why: "trailing dot: a separate browser origin, so not ours" },
  { origin: `http://[::ffff:127.0.0.1]:${PORT}`, method: "POST", path: UNROUTED, status: 403, why: "IPv4-mapped IPv6 spelling, an origin we never serve" },
  { origin: `http://0.0.0.0:${PORT}`, method: "POST", path: UNROUTED, status: 403, why: "reachable as loopback on Linux, and still not an allowlist member" },
  { origin: "null", status: 403, why: "the literal opaque origin a sandboxed iframe or file: page sends" },
  { origin: "", status: 403, why: "present but empty is not absent, and matches nothing" },
  { origin: "http://evil.example.com", status: 403, why: "the plain cross-site case" },
  { origin: `https://127.0.0.1:${PORT}`, status: 403, why: "scheme is part of an origin; we are not https" },
  { origin: `http://127.0.0.1:${PORT}/`, status: 403, why: "a serialised origin has no path, so this is a forgery" },
  { origin: `http://127.0.0.1.evil.com:${PORT}`, status: 403, why: "the prefix trap again" },
  { origin: `http://localhost.evil.com:${PORT}`, status: 403, why: "the suffix trap again" },
  { origin: `http://LOCALHOST:${PORT}`, status: 403, why: "browsers lowercase it; no normalisation here either" },
  { origin: `http://localhost:${PORT + 1}`, status: 403, why: "another local service's page is still a stranger" },
  { origin: `http://[::1]:${PORT}`, status: 403, why: "not an origin we ever serve" },
  { origin: "http://localhost:5173", status: 403, why: "the Vite dev origin, with dev mode off: an exception that cannot be turned off is not an exception" },
]

for (const row of originRows) {
  const label = `${row.method ?? "GET"} Origin ${JSON.stringify(row.origin)}`
  test(`${label} -> ${row.status} (${row.why})`, async () => {
    const got = await call(app, { origin: row.origin, method: row.method, path: row.path })
    expect(got.status).toBe(row.status)
  })
}

// ---------------------------------------------------------------------------
// 6. Dev mode, and only dev mode
// ---------------------------------------------------------------------------

// In production Bun serves the built dist/, so there is one origin. In
// development Vite serves the page on its own port and proxies /api here, so
// its requests carry its Origin, and its Host too unless the proxy rewrites
// it. Both are loopback names, so the rebinding guard still holds.

test("the vite dev flow works end to end in dev mode: bootstrap, cookie, then an API call", async () => {
  const l = serve({ dev: true })
  const viteHost = "localhost:5173"
  const viteOrigin = "http://localhost:5173"

  // Vite serves index.html, so the browser never loads Bun's "/" and the
  // cookie has to arrive through the proxy.
  const boot = await call(l, { path: "/api/session", cookie: null, host: viteHost, origin: viteOrigin })
  expect(boot.status).toBe(200)
  expect(boot.headers.get("set-cookie") ?? "").toContain(`kantan_token=${l.token}`)

  expect((await call(l, { host: viteHost, origin: viteOrigin })).status).toBe(200)
  // http-proxy with changeOrigin rewrites Host but never Origin, so the other
  // combination has to work too.
  expect((await call(l, { host: `127.0.0.1:${l.port}`, origin: viteOrigin })).status).toBe(200)
})

test("the vite dev origin is rejected when dev mode is off", async () => {
  for (const l of [serve({ dev: false }), serve()]) {
    expect((await call(l, { origin: "http://localhost:5173" })).status).toBe(403)
    expect((await call(l, { host: "localhost:5173" })).status).toBe(403)
    expect((await call(l, { path: "/api/session", cookie: null, host: "localhost:5173", origin: "http://localhost:5173" })).status).toBe(403)
  }
})

test("dev mode widens nothing else", async () => {
  const l = serve({ dev: true })
  expect((await call(l, { host: "evil.example.com" })).status).toBe(403)
  expect((await call(l, { origin: "http://evil.example.com" })).status).toBe(403)
  expect((await call(l, { origin: "http://localhost:5174" })).status).toBe(403)
  expect((await call(l, { host: "localhost:5174" })).status).toBe(403)
  expect((await call(l, { cookie: null })).status).toBe(401)
})

test("the dev port is configurable, and only its own port is allowed", async () => {
  const l = serve({ dev: true, devPort: 4321 })
  expect((await call(l, { host: "localhost:4321", origin: "http://localhost:4321" })).status).toBe(200)
  expect((await call(l, { host: "127.0.0.1:4321", origin: "http://127.0.0.1:4321" })).status).toBe(200)
  expect((await call(l, { origin: "http://localhost:5173" })).status).toBe(403)
})

// ---------------------------------------------------------------------------
// 7. The chain runs ahead of every route, including routes not yet written
// ---------------------------------------------------------------------------

test("the guards run before routing, so an unknown path is refused before it is a 404", async () => {
  expect((await call(app, { path: UNROUTED, host: "evil.example.com" })).status).toBe(403)
  expect((await call(app, { path: UNROUTED, cookie: null })).status).toBe(401)
  expect((await call(app, { path: UNROUTED, method: "POST", origin: null })).status).toBe(403)
  // Only a request that clears all three gets as far as the router.
  expect((await call(app, { path: UNROUTED })).status).toBe(404)
})

test("every registered route sits behind all three guards", async () => {
  // Written as a loop over the table so the routes Tasks 17 and 18 add are
  // covered the moment they are registered, which is the slip this task is
  // meant to prevent.
  const keys = Object.keys(ROUTES)
  expect(keys.length).toBeGreaterThan(0)

  for (const key of keys) {
    const [method = "", path = ""] = key.split(" ")
    expect(method).not.toBe("")
    expect(path).toStartWith("/")

    const bad = await call(app, { method, path, host: "evil.example.com" })
    expect(bad.status, `${key} with an outside Host`).toBe(403)

    const noToken = await call(app, { method, path, cookie: null })
    if (TOKEN_EXEMPT.has(key)) {
      expect(noToken.status, `${key} is exempt, so it must not 401`).not.toBe(401)
    } else {
      expect(noToken.status, `${key} without a token`).toBe(401)
    }

    if (method !== "GET" && method !== "HEAD") {
      const noOrigin = await call(app, { method, path, origin: null })
      expect(noOrigin.status, `${key} without an Origin`).toBe(403)
      const badOrigin = await call(app, { method, path, origin: "http://evil.example.com" })
      expect(badOrigin.status, `${key} with an outside Origin`).toBe(403)
    }
  }
})

test("the refusals say which guard refused, since a reverse proxy is the likely cause", async () => {
  const host = await call(app, { host: "evil.example.com" })
  expect(host.body.toLowerCase()).toContain("host")
  const origin = await call(app, { origin: "http://evil.example.com" })
  expect(origin.body.toLowerCase()).toContain("origin")
  const token = await call(app, { cookie: null })
  expect(token.body.toLowerCase()).toContain("token")
  // Not the token itself, in a body a page might be able to read.
  for (const res of [host, origin, token]) expect(res.body).not.toContain(app.token)
})

// ---------------------------------------------------------------------------
// 8. The minimal route surface this task owns
// ---------------------------------------------------------------------------

test("health reports the server is up", async () => {
  const res = await call(app, { path: "/api/health" })
  expect(res.status).toBe(200)
  expect(JSON.parse(res.body)).toMatchObject({ ok: true })
  expect(res.body).not.toContain(app.token)
})

test("an unknown route is a 404, not a 500", async () => {
  expect((await call(app, { path: "/api/nope" })).status).toBe(404)
  expect((await call(app, { path: "/api/health/", method: "GET" })).status).toBe(404)
  expect((await call(app, { path: "/api/health", method: "PUT", origin: `http://127.0.0.1:${PORT}` })).status).toBe(404)
})

// ---------------------------------------------------------------------------
// 9. The run stream: SSE, replayed from byte 0, then live
// ---------------------------------------------------------------------------

// Design §4.4: the server owns the child process, so closing the browser does
// not touch the run. A reconnecting client replays the whole log from byte 0
// and then tails. There is no cursor and no reconnect state machine.
//
// The failure this section exists for is not a wrong byte, it is a leak.
// `replay({ follow: true })` ends ONLY on its abort signal - never at the `end`
// record, because deciding a record is terminal is interpretation and
// `runlog.ts` is framing. So a handler that forgets to abort leaves a poller
// and an open file descriptor behind for every closed tab, on finished runs
// too, and nothing in the type signature hints at it. That is the first test
// below, and the one worth keeping if the rest were deleted.

const STREAM_ROUTE = "GET /api/runs/:id/stream"

/** Resolves to the descriptors *this process* holds on `path`, or `null` where
 * a descriptor's target cannot be read. The server runs in the test process,
 * so its handles are visible here: the poller inside `replay` cannot exist
 * without one, which makes a count of zero a proof and not a hope. */
async function fdsFor(path: string): Promise<number | null> {
  let names: string[]
  try {
    names = await readdir("/proc/self/fd")
  } catch {
    return null
  }
  let held = 0
  for (const name of names) {
    try {
      if ((await readlink(`/proc/self/fd/${name}`)) === path) held++
    } catch {
      // The descriptor closed between the readdir and the readlink.
    }
  }
  return held
}

/** Whether a descriptor's target can be read on this machine. Linux can; where
 * it cannot, the precise assertions are skipped rather than quietly passing. */
const FD_PATHS = (await fdsFor("/")) !== null

/** Total descriptors held, as a portable backstop to the precise count.
 * `/dev/fd` rather than `/proc/self/fd`, so it also answers on macOS. */
async function openHandles(): Promise<number> {
  return (await readdir("/dev/fd")).length
}

const scratchDirs: string[] = []

afterAll(async () => {
  for (const dir of scratchDirs) await rm(dir, { recursive: true, force: true })
})

/** A runs directory of its own, canonicalised: a descriptor's readlink target
 * is the real path, so the fd assertions compare like with like. */
async function runsDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "orch-sse-")))
  scratchDirs.push(dir)
  return dir
}

const FEATURE_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

function header(over: Partial<RunHeader> = {}): RunHeader {
  return {
    claudeVersion: "2.1.3",
    runId: "11111111-1111-4111-8111-111111111111",
    planSessionId: "22222222-2222-4222-8222-222222222222",
    profile: null,
    planModel: "claude-opus-5-5",
    implementModel: "claude-sonnet-5-5",
    planEffort: "high",
    implementEffort: "medium",
    projectPath: "/repo",
    featureFile: "docs/features/run-log.md",
    taskRef: "T7",
    featureFileHash: FEATURE_HASH,
    budgetUsd: 50,
    startedAt: "2026-10-11T09:00:00.000Z",
    ...over,
  }
}

/** A real run log in `dir` under `id`, header already on disk. No fakes: the
 * thing under test is how the server reads what `runlog.ts` writes. */
async function startLog(dir: string, id: string): Promise<RunLog> {
  return await createRunLog(runLogPath(id, dir), header({ runId: id }))
}

async function until(check: () => boolean | Promise<boolean>, label: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface Frame {
  event: string
  data: string
}

interface Stream {
  status: number
  headers: Headers
  /** Dispatched events in arrival order. A comment is not one. */
  frames: Frame[]
  /** Every comment line seen, which is how a keep-alive shows up. */
  comments: string[]
  /** Every byte received, for assertions about the wire format itself. */
  wire(): string
  records(): RunRecord[]
  /** True once the server closed the stream, without anyone disconnecting. */
  closed(): boolean
  waitForRecords(n: number): Promise<RunRecord[]>
  waitForEvent(name: string): Promise<Frame>
  waitForClose(): Promise<void>
  /** What a closed tab does: the connection goes, mid-stream. */
  disconnect(): Promise<void>
}

interface StreamCall {
  cookie?: string | null
  host?: string
  /** `null` omits it, which is what `EventSource` does not do - but a
   * hand-written client might. */
  accept?: string | null
  /** Overrides the whole path, for the ids a template cannot express. */
  path?: string
}

/**
 * Opens the run stream and parses it the way `EventSource` would: blocks
 * separated by a blank line, a line starting with `:` is a comment and
 * dispatches nothing, `data:` lines are joined with a newline.
 *
 * Deliberately not the `call()` helper above: that reads the body to
 * completion, which on a live stream never returns.
 */
async function stream(l: Launch, runId: string, c: StreamCall = {}): Promise<Stream> {
  const ac = new AbortController()
  const headers = new Headers({ Host: c.host ?? `127.0.0.1:${l.port}` })
  const accept = c.accept === undefined ? "text/event-stream" : c.accept
  if (accept !== null) headers.set("Accept", accept)
  const cookie = c.cookie === undefined ? `kantan_token=${l.token}` : c.cookie
  if (cookie !== null) headers.set("Cookie", cookie)

  const path = c.path ?? `/api/runs/${runId}/stream`
  const res = await fetch(`http://127.0.0.1:${l.port}${path}`, { headers, signal: ac.signal })

  const frames: Frame[] = []
  const comments: string[] = []
  let text = ""
  let done = false

  function dispatch(block: string): void {
    let event = "message"
    const data: string[] = []
    let sawData = false
    for (const line of block.split("\n")) {
      if (line === "") continue
      if (line.startsWith(":")) {
        comments.push(line)
        continue
      }
      const colon = line.indexOf(":")
      const field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? "" : line.slice(colon + 1)
      if (value.startsWith(" ")) value = value.slice(1)
      if (field === "event") event = value
      else if (field === "data") {
        data.push(value)
        sawData = true
      }
    }
    // A comment-only block carries no event, which is the whole point of the
    // keep-alive: it must never arrive as a record.
    if (sawData) frames.push({ event, data: data.join("\n") })
  }

  const pump = (async () => {
    const body = res.body
    if (body === null) {
      done = true
      return
    }
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffered = ""
    try {
      for (;;) {
        const { done: finished, value } = await reader.read()
        if (finished) break
        // `stream: true`, or a multi-byte character split across two reads
        // becomes U+FFFD here and the test lies about the server.
        const chunk = decoder.decode(value, { stream: true })
        text += chunk
        buffered += chunk
        for (;;) {
          const at = buffered.indexOf("\n\n")
          if (at === -1) break
          dispatch(buffered.slice(0, at))
          buffered = buffered.slice(at + 2)
        }
      }
    } catch {
      // Our own abort, which is how a disconnect is spelled.
    }
    done = true
  })()

  const records = (): RunRecord[] =>
    frames.filter((f) => f.event === "record").map((f) => JSON.parse(f.data) as RunRecord)

  return {
    status: res.status,
    headers: res.headers,
    frames,
    comments,
    wire: () => text,
    records,
    closed: () => done,
    async waitForRecords(n) {
      await until(() => records().length >= n, `${n} records on the stream`)
      return records()
    },
    async waitForEvent(name) {
      await until(() => frames.some((f) => f.event === name), `an SSE "${name}" event`)
      const found = frames.find((f) => f.event === name)
      if (found === undefined) throw new Error(`"${name}" vanished after it arrived`)
      return found
    },
    waitForClose: () => until(() => done, "the server to close the stream"),
    async disconnect() {
      ac.abort()
      await pump
    },
  }
}

function kindOf(record: RunRecord): string {
  return record.kind
}

// --- The leak, first --------------------------------------------------------

test("a disconnecting client leaves no poller and no open descriptor behind", async () => {
  const dir = await runsDir()
  const l = serve({ runsDir: dir, streamPollMs: 2 })
  const log = await startLog(dir, "leak")
  const path = runLogPath("leak", dir)

  // No `end` record, so this is a live run and replay({follow:true}) will poll
  // for ever. A finished run leaks exactly the same way, which is why the
  // handler cannot lean on the log having ended.
  const writer = await fdsFor(path)
  if (FD_PATHS) expect(writer).toBe(1) // the log's own append handle, and only it

  const baseline = await openHandles()
  const clients = []
  for (let i = 0; i < 12; i++) clients.push(await stream(l, "leak"))
  for (const client of clients) await client.waitForRecords(1)

  // The control comes first. Without it, the zero below could mean the
  // measurement cannot see a poller rather than that there is none.
  if (FD_PATHS) expect(await fdsFor(path)).toBe(12 + (writer ?? 0))
  expect(await openHandles()).toBeGreaterThanOrEqual(baseline + 12)

  for (const client of clients) await client.disconnect()

  // Every poller returned through replay's own `finally`, which is the only
  // thing that closes its descriptor - so zero here is the abort, observed.
  if (FD_PATHS) await until(async () => (await fdsFor(path)) === (writer ?? 0), "every poller's descriptor to close")
  await until(async () => (await openHandles()) < baseline + 6, "the sockets and descriptors to be released")

  // And the run is untouched by twelve tabs closing.
  await log.append({ kind: "phase", phase: "plan", state: "running" })
  const after = await stream(l, "leak")
  expect((await after.waitForRecords(2)).map(kindOf)).toEqual(["header", "phase"])
  await after.disconnect()
  await log.close()
})

test("a finished run's stream closes itself, so a tab on history leaves nothing running", async () => {
  const dir = await runsDir()
  const l = serve({ runsDir: dir, streamPollMs: 2 })
  const log = await startLog(dir, "over")
  await log.append({ kind: "end", state: "done", costUsd: 1.5 })
  await log.close()
  const path = runLogPath("over", dir)

  const client = await stream(l, "over")
  await client.waitForClose()

  expect(client.records().map(kindOf)).toEqual(["header", "end"])
  // Nobody disconnected: the server let go on its own.
  if (FD_PATHS) expect(await fdsFor(path)).toBe(0)
})

// --- Replay from byte 0, then live ------------------------------------------

test("a connecting client gets the whole log from byte 0, in order", async () => {
  const dir = await runsDir()
  const l = serve({ runsDir: dir, streamPollMs: 2 })
  const log = await startLog(dir, "whole")
  await log.append({ kind: "phase", phase: "plan", state: "running", planPath: "docs/plans/x.md" })
  await log.appendCli(JSON.stringify({ type: "assistant", seq: 1 }))
  await log.append({ kind: "phase", phase: "plan", state: "waiting", reason: "gate" })
  await log.append({ kind: "human", action: "approve" })

  const client = await stream(l, "whole")
  const records = await client.waitForRecords(5)
  expect(records.map(kindOf)).toEqual(["header", "phase", "cli", "phase", "human"])
  expect(records[0]).toMatchObject({ kind: "header", runId: "whole", featureFileHash: FEATURE_HASH })
  /* `toMatchObject`, not `toEqual`: a `cli` record also carries `at`, the
     epoch-ms stamp `CliRecord` grew so a rate-limit reading could be dated.
     What this case is about is that the event arrives whole and in order. */
  expect(records[2]).toMatchObject({ kind: "cli", event: { type: "assistant", seq: 1 } })
  await client.disconnect()
  await log.close()
})

test("a client connecting mid-run misses nothing: everything before it, then everything after", async () => {
  const dir = await runsDir()
  const l = serve({ runsDir: dir, streamPollMs: 2 })
  const log = await startLog(dir, "midrun")
  for (let i = 1; i <= 40; i++) await log.appendCli(JSON.stringify({ type: "assistant", seq: i }))

  const client = await stream(l, "midrun")
  await client.waitForRecords(41)

  for (let i = 41; i <= 120; i++) await log.appendCli(JSON.stringify({ type: "assistant", seq: i }))
  const records = await client.waitForRecords(121)

  // A short count is a lost record and a long one is a duplicate, so the
  // length pins both at once; the sequence pins the order.
  expect(records).toHaveLength(121)
  expect(records.slice(1).map((r) => ((r as { event: { seq: number } }).event.seq))).toEqual(
    Array.from({ length: 120 }, (_, i) => i + 1),
  )
  await sleep(20)
  expect(client.records()).toHaveLength(121)
  await client.disconnect()
  await log.close()
})

test("a record appended in two writes arrives once and whole, not split or doubled", async () => {
  const dir = await runsDir()
  const l = serve({ runsDir: dir, streamPollMs: 2 })
  const log = await startLog(dir, "split")
  const client = await stream(l, "split")
  await client.waitForRecords(1)

  // runlog's replay holds bytes until their newline arrives. This asserts the
  // SSE layer puts no second framing layer on top of that, which is where a
  // record would be lost or doubled at the boundary.
  const line = JSON.stringify({ kind: "test", exitCode: 0, attempt: 1 })
  const fh = await openFile(runLogPath("split", dir), "a")
  try {
    await fh.write(line.slice(0, 11))
    await sleep(30) // many poll cycles at 2ms
    expect(client.records()).toHaveLength(1)
    await fh.write(`${line.slice(11)}\n`)
  } finally {
    await fh.close()
  }

  const records = await client.waitForRecords(2)
  expect(records[1]).toEqual({ kind: "test", exitCode: 0, attempt: 1 })
  await sleep(30)
  expect(client.records()).toHaveLength(2)
  await client.disconnect()
  await log.close()
})

test("two clients on one run both see every record, and one leaving does not disturb the other", async () => {
  const dir = await runsDir()
  const l = serve({ runsDir: dir, streamPollMs: 2 })
  const log = await startLog(dir, "pair")
  const a = await stream(l, "pair")
  const b = await stream(l, "pair")
  await a.waitForRecords(1)
  await b.waitForRecords(1)

  await log.append({ kind: "phase", phase: "plan", state: "running" })
  expect((await a.waitForRecords(2))[1]).toMatchObject({ kind: "phase", phase: "plan" })
  expect((await b.waitForRecords(2))[1]).toMatchObject({ kind: "phase", phase: "plan" })

  await a.disconnect()
  await log.append({ kind: "test", exitCode: 1, signature: "boom", attempt: 1 })
  expect((await b.waitForRecords(3))[2]).toMatchObject({ kind: "test", exitCode: 1 })
  // a's abort tore down a's poller, not b's.
  expect(a.records()).toHaveLength(2)
  await b.disconnect()
  await log.close()
})

test("a reconnect replays from byte 0 again, because there is no cursor to resume from", async () => {
  const dir = await runsDir()
  const l = serve({ runsDir: dir, streamPollMs: 2 })
  const log = await startLog(dir, "again")
  await log.append({ kind: "phase", phase: "plan", state: "running" })

  const first = await stream(l, "again")
  expect((await first.waitForRecords(2)).map(kindOf)).toEqual(["header", "phase"])
  await first.disconnect()

  await log.append({ kind: "test", exitCode: 0, attempt: 1 })

  const second = await stream(l, "again")
  expect((await second.waitForRecords(3)).map(kindOf)).toEqual(["header", "phase", "test"])

  // Design §4.4 replays from byte 0 deliberately, so there is no `id:` on the
  // wire: an id invites Last-Event-ID, which is the reconnect state machine
  // the design rejects.
  expect(second.wire()).not.toContain("id:")
  await second.disconnect()
  await log.close()
})

test("the stream stops at the end record, which is what it costs not to leak a poller per finished run", async () => {
  const dir = await runsDir()
  const l = serve({ runsDir: dir, streamPollMs: 2 })
  const log = await startLog(dir, "past")
  await log.append({ kind: "end", state: "failed", why: "budget", costUsd: 2 })
  // replay() does not stop at `end` - that is interpretation, and runlog is
  // framing - so a record can follow it on disk. The stream stops anyway,
  // because the other direction is a poller and a descriptor per tab on every
  // finished run, for the life of the process. This test pins the price.
  await log.append({ kind: "test", exitCode: 0, attempt: 9 })
  await log.close()

  const client = await stream(l, "past")
  await client.waitForClose()
  expect(client.records().map(kindOf)).toEqual(["header", "end"])
  // And a reconnect does not reach it either, so it is invisible rather than
  // merely late.
  const again = await stream(l, "past")
  await again.waitForClose()
  expect(again.records().map(kindOf)).toEqual(["header", "end"])
})

// --- How a client learns the run is over ------------------------------------

test("the end record is forwarded, and then an eof event tells the client not to reconnect", async () => {
  const dir = await runsDir()
  const l = serve({ runsDir: dir, streamPollMs: 2 })
  const log = await startLog(dir, "eof")
  const client = await stream(l, "eof")
  await client.waitForRecords(1)

  await log.append({ kind: "end", state: "done", costUsd: 3.25 })
  await log.close()

  // The record itself, so nothing is withheld from the fold of the log...
  const records = await client.waitForRecords(2)
  expect(records[1]).toEqual({ kind: "end", state: "done", costUsd: 3.25 })
  // ...and then an explicit frame, so the client does not have to fold the log
  // to know it should call close(). A stream that merely drops is a dropped
  // connection, which EventSource is right to retry; eof is how "the run is
  // over, stop retrying" is said out loud.
  const eof = await client.waitForEvent("eof")
  expect(JSON.parse(eof.data)).toEqual({ reason: "end" })
  expect(client.frames.at(-1)).toBe(eof)
  await client.waitForClose()
})

// --- Keep-alive -------------------------------------------------------------

test("an idle stream is held open by comments, which never arrive as events", async () => {
  const dir = await runsDir()
  const l = serve({ runsDir: dir, streamPollMs: 2, streamKeepAliveMs: 15 })
  const log = await startLog(dir, "idle")
  const client = await stream(l, "idle")
  await client.waitForRecords(1)

  // A run waiting at the gate is idle for as long as the human takes, and an
  // idle connection is what a proxy or a browser reclaims.
  await until(() => client.comments.length >= 3, "keep-alive comments on an idle stream")

  // The log has one record and the stream has one event, however many
  // keep-alives went past: a comment is not a record.
  expect(client.records()).toHaveLength(1)
  expect(client.frames).toHaveLength(1)
  expect(client.comments).toContain(": keep-alive")
  await client.disconnect()
  await log.close()
})

// --- The wire format --------------------------------------------------------

test("every record is one SSE event named record, with the record as its data", async () => {
  const dir = await runsDir()
  const l = serve({ runsDir: dir, streamPollMs: 2 })
  const log = await startLog(dir, "shape")
  await log.append({ kind: "phase", phase: "implement", state: "running", sessionId: "33333333-3333-4333-8333-333333333333" })
  await log.close()

  const client = await stream(l, "shape")
  await client.waitForRecords(2)

  // One constant event name, not one per kind: runlog's own rule is that a
  // record whose kind this version does not know passes through, and an
  // addEventListener per kind has no listener for a kind a newer writer
  // invented. The client switches on data.kind, where unknown is visible.
  expect(client.frames.map((f) => f.event)).toEqual(["record", "record"])
  expect(JSON.parse(client.frames[1]?.data ?? "null")).toMatchObject({ kind: "phase", phase: "implement" })
  await client.disconnect()
})

test("a record with an unknown kind reaches the client unchanged", async () => {
  const dir = await runsDir()
  const l = serve({ runsDir: dir, streamPollMs: 2 })
  const path = runLogPath("future", dir)
  const log = await startLog(dir, "future")
  await log.close()
  const fh = await openFile(path, "a")
  try {
    await fh.write(`{"kind":"snapshot","at":"later"}\n`)
  } finally {
    await fh.close()
  }

  const client = await stream(l, "future")
  const records = await client.waitForRecords(2)
  expect(records[1]).toEqual({ kind: "snapshot", at: "later" } as unknown as RunRecord)
  await client.disconnect()
})

test("a record carrying newlines, carriage returns and multi-byte text survives the framing", async () => {
  const dir = await runsDir()
  const l = serve({ runsDir: dir, streamPollMs: 2 })
  const log = await startLog(dir, "text")
  const event = { type: "assistant", text: "line one\nline two\r\n\r\nend", path: "/tmp/café/✓/🙂" }
  await log.appendCli(JSON.stringify(event))
  await log.close()

  const client = await stream(l, "text")
  const records = await client.waitForRecords(2)
  // A raw newline in the payload would end the SSE data line, and a raw blank
  // line would end the event: JSON.stringify escapes both, so one data: line
  // per record is always enough and no second framing layer is needed.
  // `toMatchObject` for the reason above: `at` rides alongside `event`, and
  // this case is about the payload surviving the framing untouched.
  expect(records[1]).toMatchObject({ kind: "cli", event })
  expect(client.wire().split("\n").filter((line) => line.startsWith("data:"))).toHaveLength(2)
  await client.disconnect()
})

test("the stream declares text/event-stream and forbids caching", async () => {
  const dir = await runsDir()
  const l = serve({ runsDir: dir, streamPollMs: 2 })
  const log = await startLog(dir, "heads")
  await log.close()

  const client = await stream(l, "heads")
  expect(client.status).toBe(200)
  expect(client.headers.get("content-type")).toStartWith("text/event-stream")
  // A cached run stream would replay a finished run as if it were live.
  expect(client.headers.get("cache-control")).toBe("no-store")
  await client.disconnect()
})

// --- Auth: the reason the token is a cookie ---------------------------------

test("an EventSource-shaped request authenticates: the cookie alone, no Authorization header", async () => {
  // EventSource has no API for custom headers, which is why Task 16 put the
  // token in a SameSite=Strict cookie. That limitation is spec-level: no real
  // browser was involved here, and HANDOFF records the gap.
  const dir = await runsDir()
  const l = serve({ runsDir: dir, streamPollMs: 2 })
  const log = await startLog(dir, "es")
  await log.close()
  const url = `http://127.0.0.1:${l.port}/api/runs/es/stream`

  const ok = await fetch(url, {
    headers: { Host: `127.0.0.1:${l.port}`, Accept: "text/event-stream", Cookie: `kantan_token=${l.token}` },
  })
  expect(ok.status).toBe(200)
  expect(ok.headers.get("content-type")).toStartWith("text/event-stream")
  await ok.body?.cancel()

  // The same request with the token only in a header, which is what a
  // header-only scheme would have forced on the UI, is refused.
  const headerOnly = await fetch(url, {
    headers: { Host: `127.0.0.1:${l.port}`, Accept: "text/event-stream", Authorization: `Bearer ${l.token}` },
  })
  expect(headerOnly.status).toBe(401)
  await headerOnly.body?.cancel()

  // And a top-level EventSource sends no Origin, as every GET does not.
  const noOrigin = await fetch(url, {
    headers: { Host: `127.0.0.1:${l.port}`, Cookie: `kantan_token=${l.token}` },
  })
  expect(noOrigin.status).toBe(200)
  await noOrigin.body?.cancel()
})

test("the run stream is registered in ROUTES, behind the guards, and is not token-exempt", async () => {
  expect(Object.keys(ROUTES)).toContain(STREAM_ROUTE)
  // A pattern must never make a route exempt: the token check keys on the
  // request's own literal "METHOD /path", which no pattern is.
  expect(TOKEN_EXEMPT.has(STREAM_ROUTE)).toBe(false)
  expect([...TOKEN_EXEMPT].sort()).toEqual(["GET /", "GET /api/session"])

  // Section 7's loop probes the literal pattern path. A concrete id has to
  // meet the same three guards, which it only does if the matcher runs after
  // them rather than before.
  const dir = await runsDir()
  const l = serve({ runsDir: dir })
  expect((await call(l, { path: "/api/runs/abc/stream", host: "evil.example.com" })).status).toBe(403)
  expect((await call(l, { path: "/api/runs/abc/stream", cookie: null })).status).toBe(401)
  expect((await call(l, { path: "/api/runs/abc/stream", cookie: `kantan_token=${l.token}x` })).status).toBe(401)
})

// --- Ids the matcher and runLogPath must refuse -----------------------------

test("an unknown run id is a 404, not a 500", async () => {
  const dir = await runsDir()
  const l = serve({ runsDir: dir })
  // runlog's replay raises ENOENT for a missing log, and the status cannot be
  // taken back once an SSE body has started, so this has to be decided before
  // the stream opens.
  const res = await call(l, { path: "/api/runs/11111111-1111-4111-8111-111111111111/stream" })
  expect(res.status).toBe(404)
  expect(res.body).not.toContain(l.token)
})

test("the default runs directory is used when none is given", async () => {
  // Only ever stat()ed here, so this reads the real ~/.orch/runs and writes
  // nothing. It is the one assertion that the option is wired to a default at
  // all rather than to undefined.
  const l = serve()
  expect((await call(l, { path: "/api/runs/f0f0f0f0-0000-4000-8000-000000000000/stream" })).status).toBe(404)
})

interface IdRow {
  path: string
  status: number
  why: string
}

/** The matcher is a guard that decides whether to skip a route, so its input
 * dimension - what a `:id` segment may be - is enumerated rather than sampled.
 * Over-accepting here hands a path to `runLogPath`; over-rejecting costs a 404
 * on a request nothing generates. */
const idRows: IdRow[] = [
  { path: "/api/runs/abc/stream", status: 404, why: "a well-formed id with no log: the control for every row below" },
  { path: "/api/runs//stream", status: 404, why: "an empty segment is not an id, and // survives URL parsing" },
  { path: "/api/runs/abc/stream/", status: 404, why: "no trailing-slash normalisation, here as anywhere else" },
  { path: "/api/runs/abc", status: 404, why: "the pattern is the whole path, not a prefix of it" },
  { path: "/api/runs/abc/stream/extra", status: 404, why: "nor a prefix in the other direction" },
  { path: "/api/runs/a/b/stream", status: 404, why: "a :id segment is exactly one segment" },
  { path: "/api/runs/abc/STREAM", status: 404, why: "segments are compared as sent; nothing lowercases" },
  { path: "/api/runs/abc/stream?x=1", status: 404, why: "the query is not part of the path and cannot smuggle a segment" },
  { path: "/api/runs/../stream", status: 404, why: "the URL parser resolves dot segments before dispatch sees them" },
  { path: "/api/runs/./stream", status: 404, why: "and the single-dot spelling too" },
  { path: "/api/runs/..%2F..%2F.ssh%2Fauthorized_keys/stream", status: 404, why: "percent-encoded traversal: never decoded, so %2F never becomes a separator" },
  { path: "/api/runs/%2E%2E/stream", status: 404, why: "an encoded .. stays two percent-escapes, so it is not the parent directory" },
  { path: "/api/runs/%00/stream", status: 404, why: "an encoded NUL stays an escape, so it cannot truncate a path" },
  { path: "/api/runs/:id/stream", status: 404, why: "the pattern's own key is a requestable path, and must not match itself into an empty id" },
  { path: "/api/runs/a:b/stream", status: 404, why: "a colon inside a segment is part of the id, not a pattern marker" },
]

for (const row of idRows) {
  test(`${row.path} -> ${row.status} (${row.why})`, async () => {
    const dir = await runsDir()
    const l = serve({ runsDir: dir })
    expect((await call(l, { path: row.path })).status).toBe(row.status)
    // Nothing outside the runs directory was created, whatever the id spelled.
    expect(await readdir(dir)).toEqual([])
  })
}

test("a path that only shares a prefix with the pattern does not match it", async () => {
  // Every row above asks for a log that does not exist, so a matcher wide
  // enough to claim the wrong path still answers 404 and the row passes for
  // the wrong reason. Proven: widening the segment-count check from `!==` to
  // `>` leaves all of them green. The log has to exist for the width of a
  // `:id` segment to be observable at all.
  const dir = await runsDir()
  const l = serve({ runsDir: dir, streamPollMs: 2 })
  const log = await startLog(dir, "real")
  await log.append({ kind: "end", state: "done", costUsd: 0 })
  await log.close()

  const control = await stream(l, "real")
  expect(control.status).toBe(200)
  await control.waitForClose()

  for (const path of [
    "/api/runs/real/stream/extra",
    "/api/runs/real/stream/",
    "/api/runs/real/streamx",
    "/api/runs/real/x/stream",
    "/api/runs/extra/real/stream",
    "/api/runs/real",
    "/api/real/stream",
  ]) {
    expect((await call(l, { path })).status, path).toBe(404)
  }
})

test("a traversal attempt reads nothing outside the runs directory", async () => {
  const dir = await runsDir()
  const outside = await runsDir()
  const decoy = await startLog(outside, "decoy")
  await decoy.append({ kind: "end", state: "done", costUsd: 0 })
  await decoy.close()

  // The id is never percent-decoded, so `..%2F` is a filename and not a path.
  // The log it would have reached if it were decoded exists, and the request
  // still finds nothing.
  const l = serve({ runsDir: dir })
  const escape = `..%2F${outside.split("/").pop() ?? ""}%2Fdecoy`
  const res = await call(l, { path: `/api/runs/${escape}/stream` })
  expect(res.status).toBe(404)
  expect(res.body).not.toContain("decoy")
})

test("an id runLogPath refuses becomes a 400, not an unhandled rejection", async () => {
  // Nothing in a URL reaches this today: the parser resolves `..` and `.`
  // before dispatch, converts a backslash to a slash, and an empty segment
  // does not match the pattern - so every spelling above is a 404 before
  // runLogPath is called. The mapping is asserted through the exported route
  // anyway, because the alternative to a 400 is a rejected promise inside a
  // route handler, which is a 500 with nothing useful in it.
  const dir = await runsDir()
  const ctx: RouteContext = {
    token: "unused",
    port: 3100,
    dev: false,
    devPort: 5173,
    hosts: new Set(),
    origins: new Set(),
    runsDir: dir,
    /* No build and no profile scan involved: these two contexts exercise the
     * run-id refusal. Both point at the scratch directory rather than being
     * omitted, so neither can reach the developer's own files. */
    distDir: dir,
    homeDir: dir,
    streamPollMs: 2,
    streamKeepAliveMs: 1000,
    runner: null,
    projectsFile: null,
    liveRunIds: null,
    /* Refuses rather than answers: a route that reaches a model in a test
       nobody pointed at one is a billed call, and that is a failure to see
       rather than to tolerate. */
    ask: async () => {
      throw new Error("this context has no model; inject `ask` to exercise a drafting route")
    },
  }

  // Both `:id` reads, not only the stream: the plan route refuses an id the
  // same way, and for the same reason - the alternative is handing `runLogPath`
  // an id that makes it throw inside a route.
  for (const key of [STREAM_ROUTE, PLAN_ROUTE]) {
    const handler = ROUTES[key]
    if (handler === undefined) throw new Error(`${key} is not registered`)
    for (const id of ["..", ".", "", "a/b", "a\\b", "a\0b"]) {
      const res = await handler(new Request("http://127.0.0.1:3100/api/runs/x/stream"), ctx, { id })
      expect(res.status, `${key} with id ${JSON.stringify(id)}`).toBe(400)
      expect(res.headers.get("content-type")).toStartWith("application/json")
      await res.body?.cancel()
    }
  }
  expect(await readdir(dir)).toEqual([])
})

// ---------------------------------------------------------------------------
// 10. Actions: start, approve, feedback, stop
// ---------------------------------------------------------------------------

// Design §4.4: SSE carries the run stream, plain POST carries the actions.
// Every one of them is a POST and none is a GET, because `SameSite=Strict` ignores
// **ports**: a page on any other localhost port is same-site, so its no-cors
// GETs - an `img`, a `script`, a navigation - carry the auth cookie and send no
// `Origin`. A convenience GET that started a run would be reachable from every
// other local page on this machine.
//
// The phase machine (`src/run.ts`, Task 13) is not written yet, so the server
// takes it as a dependency and these tests inject a double. That is the seam,
// not a convenience: a guessed import would couple this file to a shape that is
// still moving, and the double is what lets the status mapping be tested at all
// - a real machine cannot be made to refuse on demand.

const START = "POST /api/runs"
const APPROVE = "POST /api/runs/:id/approve"
const FEEDBACK = "POST /api/runs/:id/feedback"
/** The reply to a run that asked a question. Not `feedback`: `feedbackPrompt`
 * opens with "a human read that plan at the gate and did not approve it", which
 * is false for an agent waiting on an answer, and the two replies go into
 * different prompts and continue different conversations. */
const ANSWER = "POST /api/runs/:id/answer"
/** The new ceiling for a run parked at a human. The only action whose argument
 * is a number, so it owns a 400 no other action has. */
const RAISE = "POST /api/runs/:id/raise"
const STOP = "POST /api/runs/:id/stop"
/**
 * Picking a killed run back up, which nothing could reach: `resumeRun` has been
 * exported from `src/run.ts` since the phase machine landed and was called by
 * nobody, so a run the server died in the middle of was a row in the tree with
 * no action behind it. `Tree.tsx` already decides when to offer it (`canResume`,
 * which is `interrupted` and nothing else).
 */
const RESUME = "POST /api/runs/:id/resume"
const ACTION_ROUTES = [START, APPROVE, FEEDBACK, ANSWER, RAISE, RESUME, STOP]

/** One call the server made on the machine, in arrival order. */
interface RunnerCall {
  name: "start" | "approve" | "feedback" | "answer" | "raise" | "resume" | "stop"
  /** Present on `start`, as the server built it from the body. */
  request?: StartRequest
  /** Present on the four `:id` actions, exactly as the URL spelled it. */
  runId?: string
  /** Present on `feedback` and `answer`. Compared byte for byte: this is the
   * human's own text. */
  text?: string
  /** Present on `raise`, as the number the body carried. The only action
   * argument that is not a string. */
  budgetUsd?: number
}

interface Fake {
  runner: Runner
  calls: RunnerCall[]
}

/**
 * A recording machine double. Every method answers `ok` unless `over` replaces
 * it, so a test states only the answer it is about.
 */
function fakeRunner(over: Partial<Runner> = {}): Fake {
  const calls: RunnerCall[] = []
  const runner: Runner = {
    async start(request) {
      calls.push({ name: "start", request })
      return over.start === undefined ? { ok: true, runId: "run-1" } : await over.start(request)
    },
    async approve(runId) {
      calls.push({ name: "approve", runId })
      return over.approve === undefined ? { ok: true } : await over.approve(runId)
    },
    async feedback(runId, text) {
      calls.push({ name: "feedback", runId, text })
      return over.feedback === undefined ? { ok: true } : await over.feedback(runId, text)
    },
    async answer(runId, text) {
      calls.push({ name: "answer", runId, text })
      return over.answer === undefined ? { ok: true } : await over.answer(runId, text)
    },
    async raise(runId, budgetUsd) {
      calls.push({ name: "raise", runId, budgetUsd })
      return over.raise === undefined ? { ok: true } : await over.raise(runId, budgetUsd)
    },
    async resume(runId) {
      calls.push({ name: "resume", runId })
      return over.resume === undefined ? { ok: true } : await over.resume(runId)
    },
    async stop(runId) {
      calls.push({ name: "stop", runId })
      return over.stop === undefined ? { ok: true } : await over.stop(runId)
    },
  }
  return { runner, calls }
}

const TASK: StartRequest = { projectPath: "/repo", featureFile: "docs/features/x.md", taskRef: "T7" }

/**
 * A store path in a directory of its own, with **no file at it yet**: an absent
 * store reads as "no projects", which is what a fresh install is.
 *
 * Never the developer's own `~/.kantan/projects.json`. `ServerOptions` has no
 * default for it for exactly this reason - a test that forgot to inject one
 * would register projects in the store the developer runs kantan against.
 */
async function storeFile(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "orch-store-")))
  scratchDirs.push(dir)
  return join(dir, "projects.json")
}

/** A started-run launch with its double, on a runs directory and a store of its
 * own so the "wrote no record" and "wrote no project" assertions have something
 * to read. */
async function withRunner(
  over: Partial<Runner> = {},
): Promise<{ l: Launch; fake: Fake; dir: string; store: string }> {
  const dir = await runsDir()
  const store = await storeFile()
  const fake = fakeRunner(over)
  return { l: serve({ runsDir: dir, runner: fake.runner, projectsFile: store }), fake, dir, store }
}

function post(l: Launch, path: string, body?: string): Promise<{ status: number; headers: Headers; body: string }> {
  return call(l, body === undefined ? { path, method: "POST" } : { path, method: "POST", body })
}

// --- The route surface ------------------------------------------------------

/** The path an action route is reached at, with a run id in place of `:id`.
 * Derived from the table rather than listed again, so an action added to
 * `ACTION_ROUTES` cannot fall out of the loops below - the slip those loops
 * exist to prevent. */
function actionPath(key: string, runId = "run-1"): string {
  const [, pattern = ""] = key.split(" ")
  return pattern.replace(":id", runId)
}

test("every action is a POST registered in ROUTES, and none is token-exempt", () => {
  for (const key of ACTION_ROUTES) {
    expect(Object.keys(ROUTES)).toContain(key)
    expect(key).toStartWith("POST ")
    expect(TOKEN_EXEMPT.has(key)).toBe(false)
  }
  // Section 7's loop then covers all three guards for each of them, and
  // widening the exempt set stays a deliberate edit that fails a test first.
  expect([...TOKEN_EXEMPT].sort()).toEqual(["GET /", "GET /api/session"])
})

test("nothing that acts is reachable by GET or HEAD, so no local page can drive kantan with an img tag", async () => {
  // Structural, not a sample: the paths come from every route in the table
  // that is not a GET - registering, removing and editing a project included,
  // since a no-cors GET must not be able to write projects.json either - and
  // each is tried with every method a no-cors cross-site request can use. The
  // double proves nothing ran, and the absent store file proves nothing was
  // written. Keyed on "not a GET" rather than on "POST", so a DELETE or a
  // PATCH cannot be added outside this claim.
  const { l, fake, store } = await withRunner()
  const acts = Object.keys(ROUTES).filter((key) => !key.startsWith("GET "))
  expect(acts.length).toBeGreaterThanOrEqual(ACTION_ROUTES.length)

  for (const key of acts) {
    const path = actionPath(key)
    for (const method of ["GET", "HEAD"]) {
      // No Origin either, which is what those requests send.
      const res = await call(l, { path, method, origin: null })
      // A 404, unless that exact `METHOD /path` is a route in its own right:
      // the project tree is served by `GET /api/projects`, which is the path
      // registration POSTs to. The claim is not "this path has no GET" - it is
      // that a GET never reaches a **POST** handler, and the double plus the
      // store that was never created below are what prove it.
      const own = Object.keys(ROUTES).includes(`${method} ${path}`)
      if (own) expect(res.status, `${method} ${path}`).not.toBe(404)
      else expect(res.status, `${method} ${path}`).toBe(404)
    }
  }
  expect(fake.calls).toEqual([])
  // The directory, not `loadProjects`: an absent store also loads as `[]`, so
  // the assertion that distinguishes "wrote nothing" is that no file is there.
  expect(await readdir(dirname(store))).toEqual([])
})

// --- Start ------------------------------------------------------------------

test("start passes the task through and answers 201 with the run id", async () => {
  const { l, fake } = await withRunner()
  const res = await post(l, "/api/runs", JSON.stringify(TASK))

  expect(res.status).toBe(201)
  expect(JSON.parse(res.body)).toEqual({ ok: true, runId: "run-1" })
  expect(fake.calls).toEqual([{ name: "start", request: TASK }])
  expect(res.body).not.toContain(l.token)
})

test("start forwards allowDirty, and refuses anything that is not a boolean", async () => {
  // The only non-string key on this route, so it owns a 400 no other start key
  // has. It waives the guard that stops an agent committing over work nobody
  // asked it to touch, so a truthiness check is the one thing it must not be:
  // `"false"` is what a form serialises readily, and under `Boolean(...)` it
  // would waive the guard while reading like it did not.
  const { l, fake } = await withRunner()

  expect((await post(l, "/api/runs", JSON.stringify({ ...TASK, allowDirty: true }))).status).toBe(201)
  expect(fake.calls).toEqual([{ name: "start", request: { ...TASK, allowDirty: true } }])

  // `false` is accepted and means an ordinary start - the key is simply not
  // forwarded, so the port cannot tell it from absent.
  const { l: l2, fake: f2 } = await withRunner()
  expect((await post(l2, "/api/runs", JSON.stringify({ ...TASK, allowDirty: false }))).status).toBe(201)
  expect(f2.calls).toEqual([{ name: "start", request: TASK }])

  for (const value of ["true", "false", 1, 0, "yes", null, {}]) {
    const { l: l3, fake: f3 } = await withRunner()
    const res = await post(l3, "/api/runs", JSON.stringify({ ...TASK, allowDirty: value }))
    expect(res.status, JSON.stringify(value)).toBe(400)
    expect(res.body, JSON.stringify(value)).toContain("allowDirty")
    // Refused before the machine was touched.
    expect(f3.calls, JSON.stringify(value)).toEqual([])
  }
})

test("start refuses on a dirty repo, and git's own listing of the files reaches the client", async () => {
  // The double calls the real guards, so this proves the message src/git.ts
  // writes survives the whole way into the HTTP body. A bare "repo is dirty"
  // is a bad experience when the fix is one `git stash`.
  const repo = await dirtyRepo()
  const { l } = await withRunner({
    async start(request) {
      try {
        await requireCleanTreeForNewRun(await requireUsableRepo(request.projectPath))
      } catch (e) {
        return { ok: false, refusal: "dirty", message: (e as Error).message }
      }
      return { ok: true, runId: "run-1" }
    },
  })

  const res = await post(l, "/api/runs", JSON.stringify({ ...TASK, projectPath: repo }))

  expect(res.status).toBe(409)
  const body = JSON.parse(res.body) as { error: string; refusal: string }
  expect(body.refusal).toBe("dirty")
  expect(body.error).toContain("app.txt")
  expect(body.error).toContain("git stash")
})

test("start refuses when the project already has an active run, which is the collision guard", async () => {
  const { l } = await withRunner({
    async start() {
      return { ok: false, refusal: "busy", message: "/repo already has an active run: run-1" }
    },
  })
  const res = await post(l, "/api/runs", JSON.stringify(TASK))
  expect(res.status).toBe(409)
  expect(JSON.parse(res.body)).toEqual({
    error: "/repo already has an active run: run-1",
    refusal: "busy",
  })
})

test("start on a project, feature or task the machine does not know is a 404", async () => {
  for (const refusal of ["unknown-project", "unknown-feature", "unknown-task"] as const) {
    const { l } = await withRunner({
      async start() {
        return { ok: false, refusal, message: `no such thing: ${refusal}` }
      },
    })
    const res = await post(l, "/api/runs", JSON.stringify(TASK))
    expect(res.status, refusal).toBe(404)
    expect(JSON.parse(res.body).refusal).toBe(refusal)
  }
})

// --- Approve, feedback, stop ------------------------------------------------

test("approve names the run it approved and answers 200", async () => {
  const { l, fake } = await withRunner()
  const res = await post(l, "/api/runs/abc/approve")
  expect(res.status).toBe(200)
  expect(JSON.parse(res.body)).toEqual({ ok: true })
  expect(fake.calls).toEqual([{ name: "approve", runId: "abc" }])
})

test("approve on a run that is not at the gate is a 409, not a 500", async () => {
  const { l } = await withRunner({
    async approve() {
      return { ok: false, refusal: "wrong-state", message: "run abc is running, so there is nothing to approve" }
    },
  })
  const res = await post(l, "/api/runs/abc/approve")
  expect(res.status).toBe(409)
  expect(JSON.parse(res.body).refusal).toBe("wrong-state")
})

test("feedback carries the human's text through byte for byte, including whitespace it is padded with", async () => {
  // The text goes into `feedbackPrompt`, so trimming or collapsing it here
  // would change what the human said to the agent. Emptiness is judged on a
  // trimmed copy; nothing trimmed is ever forwarded.
  const { l, fake } = await withRunner()
  const text = ' Use the "existing" parser.\n\n\tSee src/a\\b.ts - café ✓ 🙂 '
  const res = await post(l, "/api/runs/abc/feedback", JSON.stringify({ text }))

  expect(res.status).toBe(200)
  expect(fake.calls).toEqual([{ name: "feedback", runId: "abc", text }])
})

test("an answer reaches the machine's answer, not its feedback, and carries the reply byte for byte", async () => {
  // The whole reason this route exists. `feedbackPrompt` opens with "a human
  // read that plan at the gate and did not approve it", which is false for an
  // agent that asked a question and is waiting - and it is the wrong
  // instruction for a question raised mid-implement, where the gate's feedback
  // revises a plan while an answer continues work. One route that guessed which
  // conversation it was talking to would have to encode that rule here, where
  // the machine already owns it.
  const { l, fake } = await withRunner()
  const text = " Persist it with sqflite.\n\n\tThe migration is fine - café ✓ 🙂 "
  const res = await post(l, "/api/runs/abc/answer", JSON.stringify({ text }))

  expect(res.status).toBe(200)
  expect(JSON.parse(res.body)).toEqual({ ok: true })
  expect(fake.calls).toEqual([{ name: "answer", runId: "abc", text }])
  // And the other direction: feedback is still feedback.
  const other = await withRunner()
  await post(other.l, "/api/runs/abc/feedback", JSON.stringify({ text: "narrow it" }))
  expect(other.fake.calls.map((c) => c.name)).toEqual(["feedback"])
})

test("an answer to a run that is not waiting on one is a 409 whose message is worth showing a person", async () => {
  // The state rule stays in the machine: the server asks and renders the
  // answer. The gate shows a refusal in a role="alert", so the message - and
  // not only the code - is what a human is left with.
  const { l } = await withRunner({
    async answer() {
      return {
        ok: false,
        refusal: "wrong-state",
        message: "run abc is implementing, so it is not waiting for an answer",
      }
    },
  })
  const res = await post(l, "/api/runs/abc/answer", JSON.stringify({ text: "in memory is fine" }))
  expect(res.status).toBe(409)
  const body = JSON.parse(res.body) as { error: string; refusal: string }
  expect(body.refusal).toBe("wrong-state")
  expect(body.error).toContain("not waiting for an answer")
})

test("resume reaches the machine's resume, and nothing else does", async () => {
  // The run actions are one route each precisely so a state transition cannot
  // be reached by a route that means something different: approve re-parks an
  // interrupted run, stop only ends it, and neither picks it up from the last
  // phase record in its log.
  const { l, fake } = await withRunner()
  const res = await post(l, "/api/runs/abc/resume")
  expect(res.status).toBe(200)
  expect(JSON.parse(res.body)).toEqual({ ok: true })
  expect(fake.calls).toEqual([{ name: "resume", runId: "abc" }])
})

test("a resume refused because the checkout moved is a 409 carrying git's own words", async () => {
  // The double calls the real guard, so this proves the sentence `src/git.ts`
  // writes survives into the HTTP body - and that sentence is the whole
  // guidance a person gets at the moment they need it. `resumeTaskBranch`
  // exempts a run's own half-written files **only while the checkout is still
  // on its branch**; here HEAD has moved, so the dirty files are somebody
  // else's and switching would carry them onto the task branch for the agent
  // to commit. The message has to say which of those two situations it is.
  const repo = await dirtyRepo()
  const branch = taskBranchName({ feature: "docs/features/x.md", ref: "T7" })
  await gitIn(repo, "branch", branch)
  const { l } = await withRunner({
    async resume() {
      try {
        await resumeTaskBranch(await requireUsableRepo(repo), branch)
      } catch (e) {
        return { ok: false, refusal: "dirty", message: (e as Error).message }
      }
      return { ok: true }
    },
  })

  const res = await post(l, "/api/runs/abc/resume")
  expect(res.status).toBe(409)
  const body = JSON.parse(res.body) as { error: string; refusal: string }
  expect(body.refusal).toBe("dirty")
  // Which situation the user is in: not on the branch, these files, and the
  // two ways out.
  expect(body.error).toContain("not on")
  expect(body.error).toContain(branch)
  expect(body.error).toContain("app.txt")
  expect(body.error).toContain("git stash")
  expect(body.error).toContain(`git switch ${branch}`)
})

test("a resume of a run that has already finished is a 409, not a second run", async () => {
  // `rehydrate` refuses a run with an `end` record: the fold stops there, the
  // stream stops there, and starting the task again is a different action with
  // a different branch guard behind it.
  const { l } = await withRunner({
    async resume() {
      return {
        ok: false,
        refusal: "wrong-state",
        message: "run abc already finished (done), so there is nothing left to drive. Start the task again.",
      }
    },
  })
  const res = await post(l, "/api/runs/abc/resume")
  expect(res.status).toBe(409)
  const body = JSON.parse(res.body) as { error: string; refusal: string }
  expect(body.refusal).toBe("wrong-state")
  expect(body.error).toContain("Start the task again")
})

test("stop answers 200 on a live run and 409 on one that is already over", async () => {
  const { l, fake } = await withRunner()
  expect((await post(l, "/api/runs/abc/stop")).status).toBe(200)
  expect(fake.calls).toEqual([{ name: "stop", runId: "abc" }])

  const over = await withRunner({
    async stop() {
      return { ok: false, refusal: "wrong-state", message: "run abc has already finished" }
    },
  })
  const res = await post(over.l, "/api/runs/abc/stop")
  expect(res.status).toBe(409)
  expect(JSON.parse(res.body).refusal).toBe("wrong-state")
})

/** The body an action needs to get past validation, keyed by its route. The
 * two text actions need one, a raise needs its figure; the rest must have none. */
function actionBody(key: string): string | undefined {
  if (key === FEEDBACK || key === ANSWER) return JSON.stringify({ text: "again please" })
  if (key === RAISE) return JSON.stringify({ budgetUsd: 75 })
  return undefined
}

test("an unknown run id is a 404 on every action, not a 500", async () => {
  const unknown = { ok: false as const, refusal: "unknown-run" as const, message: "no such run" }
  for (const key of ACTION_ROUTES) {
    if (key === START) continue
    const { l } = await withRunner({
      async approve() {
        return unknown
      },
      async feedback() {
        return unknown
      },
      async answer() {
        return unknown
      },
      async raise() {
        return unknown
      },
      async resume() {
        return unknown
      },
      async stop() {
        return unknown
      },
    })
    const path = actionPath(key, "11111111-1111-4111-8111-111111111111")
    const res = await post(l, path, actionBody(key))
    expect(res.status, key).toBe(404)
    expect(JSON.parse(res.body).refusal).toBe("unknown-run")
  }
})

test("the actions write nothing to the runs directory: the machine is the only writer of a run log", async () => {
  const { l, dir } = await withRunner()
  await post(l, "/api/runs", JSON.stringify(TASK))
  for (const key of ACTION_ROUTES) {
    if (key === START) continue
    await post(l, actionPath(key, "abc"), actionBody(key))
  }
  expect(await readdir(dir)).toEqual([])
})

// --- Run ids the actions must refuse ----------------------------------------

test("a percent-encoded traversal in an action's run id reaches the machine whole, and is unknown", async () => {
  // Nothing decodes the segment, so `..%2F` is part of a filename rather than a
  // path. It is therefore an ordinary unknown id, which is a 404 - the same
  // answer Task 17's stream gives it.
  const { l, fake } = await withRunner({
    async stop() {
      return { ok: false, refusal: "unknown-run", message: "no such run" }
    },
  })
  const res = await post(l, "/api/runs/..%2F..%2F.ssh%2Fauthorized_keys/stop")
  expect(res.status).toBe(404)
  expect(fake.calls[0]?.runId).toBe("..%2F..%2F.ssh%2Fauthorized_keys")
})

test("an id runLogPath refuses is a 4xx and never reaches the machine", async () => {
  // Nothing in a URL reaches this today - the parser resolves `..` and `.`, a
  // backslash becomes a slash, and an empty segment does not match the pattern
  // - so it is asserted through the exported handlers. The alternative to a 400
  // is the machine being handed an id it would pass to `runLogPath` itself,
  // where the throw becomes a rejected promise inside a route: a 500 saying
  // nothing.
  const dir = await runsDir()
  const fake = fakeRunner()
  const ctx: RouteContext = {
    token: "unused",
    port: 3100,
    dev: false,
    devPort: 5173,
    hosts: new Set(),
    origins: new Set(),
    runsDir: dir,
    /* No build and no profile scan involved: these two contexts exercise the
     * run-id refusal. Both point at the scratch directory rather than being
     * omitted, so neither can reach the developer's own files. */
    distDir: dir,
    homeDir: dir,
    streamPollMs: 2,
    streamKeepAliveMs: 1000,
    runner: fake.runner,
    projectsFile: null,
    liveRunIds: null,
    /* Refuses rather than answers: a route that reaches a model in a test
       nobody pointed at one is a billed call, and that is a failure to see
       rather than to tolerate. */
    ask: async () => {
      throw new Error("this context has no model; inject `ask` to exercise a drafting route")
    },
  }

  for (const key of [APPROVE, FEEDBACK, ANSWER, RAISE, RESUME, STOP]) {
    const handler = ROUTES[key]
    if (handler === undefined) throw new Error(`${key} is not registered`)
    for (const id of ["..", ".", "", "a/b", "a\\b", "a\0b"]) {
      // The body each route actually accepts, so the 400 under test is the id
      // guard's: a `text` key on approve or stop is a 400 of its own, and the
      // assertion would then pass with the id guard deleted.
      const body = actionBody(key)
      const req = new Request("http://127.0.0.1:3100/api/runs/x/stop", {
        method: "POST",
        ...(body === undefined ? {} : { body }),
      })
      const res = await handler(req, ctx, { id })
      expect(res.status, `${key} with id ${JSON.stringify(id)}`).toBe(400)
      expect(res.headers.get("content-type")).toStartWith("application/json")
      await res.body?.cancel()
    }
  }
  expect(fake.calls).toEqual([])
  expect(await readdir(dir)).toEqual([])
})

// --- The request body, enumerated ------------------------------------------

// Body validation is a guard that accepts input, so CLAUDE.md's rule applies
// and the costs invert from the usual: over-accepting hands malformed state to
// a run that spends money, over-rejecting means the UI cannot drive the tool.
// The dimension is the bytes of the body, and every shape it can take is a row
// here rather than a sample.

interface BodyRow {
  path: string
  body?: string
  contentType?: string
  status: number
  why: string
}

const START_PATH = "/api/runs"
const APPROVE_PATH = "/api/runs/abc/approve"
const FEEDBACK_PATH = "/api/runs/abc/feedback"
const ANSWER_PATH = "/api/runs/abc/answer"
const RESUME_PATH = "/api/runs/abc/resume"
const STOP_PATH = "/api/runs/abc/stop"

const bodyRows: BodyRow[] = [
  // The controls.
  { path: START_PATH, body: JSON.stringify(TASK), status: 201, why: "the three keys a run needs" },
  { path: FEEDBACK_PATH, body: JSON.stringify({ text: "narrow it" }), status: 200, why: "the one key feedback needs" },
  { path: APPROVE_PATH, status: 200, why: "approve has nothing to say, so no body is the normal case" },
  { path: STOP_PATH, status: 200, why: "nor has stop" },

  // Absent and empty, which the wire cannot tell apart: probed, Bun declares
  // Content-Length: 0 for both.
  { path: START_PATH, status: 400, why: "a run cannot be started without naming one" },
  { path: START_PATH, body: "", status: 400, why: "an empty body names no project, feature or task" },
  { path: FEEDBACK_PATH, status: 400, why: "feedback with nothing said would spend a planning turn on silence" },
  { path: APPROVE_PATH, body: "", status: 200, why: "empty reads as absent, which is what approve expects" },
  { path: APPROVE_PATH, body: "{}", status: 200, why: "an empty object says nothing either" },
  { path: STOP_PATH, body: "{}", status: 200, why: "the same for stop" },

  // Not JSON at all, or JSON that is not an object.
  { path: START_PATH, body: "not json", status: 400, why: "the body must parse as JSON" },
  { path: START_PATH, body: "{", status: 400, why: "truncated JSON is the same answer" },
  { path: START_PATH, body: "null", status: 400, why: "typeof null is object, which is the trap this row pins" },
  { path: START_PATH, body: "[]", status: 400, why: "an array is an object to typeof, and is not a record" },
  { path: START_PATH, body: JSON.stringify([TASK]), status: 400, why: "nor is an array that holds the right record" },
  { path: START_PATH, body: "5", status: 400, why: "a JSON scalar is not a record" },
  { path: START_PATH, body: '"T7"', status: 400, why: "nor a bare string" },
  { path: START_PATH, body: "true", status: 400, why: "nor a bare boolean" },
  { path: APPROVE_PATH, body: "null", status: 400, why: "approve takes no keys, and null is still not a record" },
  { path: APPROVE_PATH, body: "[]", status: 400, why: "nor is an array" },

  // Keys: missing, wrong type, empty, unknown.
  { path: START_PATH, body: "{}", status: 400, why: "an object missing every required key" },
  { path: START_PATH, body: JSON.stringify({ projectPath: "/repo" }), status: 400, why: "missing featureFile and taskRef" },
  { path: START_PATH, body: JSON.stringify({ ...TASK, taskRef: undefined }), status: 400, why: "JSON drops an undefined value, so the key is absent" },
  { path: START_PATH, body: JSON.stringify({ ...TASK, taskRef: null }), status: 400, why: "present but null is not a task ref" },
  { path: START_PATH, body: JSON.stringify({ ...TASK, taskRef: 7 }), status: 400, why: "a number is not a task ref" },
  { path: START_PATH, body: JSON.stringify({ ...TASK, taskRef: ["T7"] }), status: 400, why: "nor an array of one" },
  { path: START_PATH, body: JSON.stringify({ ...TASK, taskRef: "" }), status: 400, why: "a task is addressed by ref, so an empty one addresses nothing" },
  { path: START_PATH, body: JSON.stringify({ ...TASK, projectPath: "" }), status: 400, why: "and an empty project path names no repo" },
  { path: START_PATH, body: JSON.stringify({ ...TASK, extra: 1 }), status: 400, why: "an unknown key is the caller's typo, and a dropped setting is how one hides" },
  { path: START_PATH, body: JSON.stringify({ ...TASK, taskref: "T7" }), status: 400, why: "the near-miss spelling, which is the case the strictness exists for" },
  { path: FEEDBACK_PATH, body: JSON.stringify({ text: "x", extra: 1 }), status: 400, why: "the same strictness on feedback" },
  { path: FEEDBACK_PATH, body: JSON.stringify({ text: 123 }), status: 400, why: "a number is not the human's text" },
  { path: FEEDBACK_PATH, body: JSON.stringify({ text: "" }), status: 400, why: "empty feedback would re-plan with nothing said" },
  { path: FEEDBACK_PATH, body: JSON.stringify({ text: " \t\n " }), status: 400, why: "whitespace-only is empty, judged on a trimmed copy" },
  { path: FEEDBACK_PATH, body: JSON.stringify({ text: " x " }), status: 200, why: "padding around real text is the human's, and is kept" },

  // The answer route takes the same single key, and has its own validator: the
  // rows below are what keeps deleting it from being a green change.
  { path: ANSWER_PATH, body: JSON.stringify({ text: "persist it" }), status: 200, why: "the one key an answer needs" },
  { path: ANSWER_PATH, status: 400, why: "an answer with nothing said would spend a turn on silence" },
  { path: ANSWER_PATH, body: "{}", status: 400, why: "and an object with no text in it says nothing either" },
  { path: ANSWER_PATH, body: JSON.stringify({ text: "" }), status: 400, why: "an empty answer is not an answer" },
  { path: ANSWER_PATH, body: JSON.stringify({ text: " \t\n " }), status: 400, why: "whitespace-only is empty, judged on a trimmed copy" },
  { path: ANSWER_PATH, body: JSON.stringify({ text: 123 }), status: 400, why: "a number is not the human's reply" },
  { path: ANSWER_PATH, body: JSON.stringify({ text: "x", extra: 1 }), status: 400, why: "the same strictness about keys" },
  { path: ANSWER_PATH, body: JSON.stringify({ answer: "x" }), status: 400, why: "the key is `text`, as on feedback, and a near-miss is refused rather than dropped" },
  { path: ANSWER_PATH, body: JSON.stringify({ text: " x " }), status: 200, why: "padding around a real reply is the human's, and is kept" },

  // A body on a route that takes none. Ignoring it is the dangerous direction:
  // a client that put feedback text on the approve route would silently approve
  // a plan the human wanted revised.
  { path: APPROVE_PATH, body: JSON.stringify({ text: "no, narrow it" }), status: 400, why: "approve must not silently swallow feedback" },
  { path: STOP_PATH, body: JSON.stringify({ reason: "mistake" }), status: 400, why: "stop takes no keys either" },
  { path: APPROVE_PATH, body: JSON.stringify(TASK), status: 400, why: "nor a start request" },

  // Resume takes no keys either: where it resumes from is the last complete
  // phase record in the run's own log, never anything a client could name.
  { path: RESUME_PATH, status: 200, why: "resume has nothing to say, so no body is the normal case" },
  { path: RESUME_PATH, body: "{}", status: 200, why: "an empty object says nothing either" },
  { path: RESUME_PATH, body: " \n ", status: 200, why: "and whitespace reads as absent, as it does on approve" },
  { path: RESUME_PATH, body: JSON.stringify({ text: "carry on" }), status: 400, why: "a resume is not an answer: a client that put a reply here would resume the run without it, and the question would still be unanswered" },
  { path: RESUME_PATH, body: JSON.stringify({ resumeFrom: "implement" }), status: 400, why: "the phase is the log's to decide, so naming one is a key this route does not take" },
  { path: RESUME_PATH, body: "null", status: 400, why: "typeof null is object, which is the trap" },

  // Oddities that are still well-formed.
  { path: START_PATH, body: `{"projectPath":"/repo","featureFile":"docs/features/x.md","taskRef":"T1","taskRef":"T7"}`, status: 201, why: "a duplicated key: JSON.parse keeps the last, and one parser reads the body so there is no second opinion to exploit" },
  { path: START_PATH, body: JSON.stringify(TASK), contentType: "application/json", status: 201, why: "the content type nobody is required to send" },
  { path: START_PATH, body: JSON.stringify(TASK), contentType: "text/plain;charset=UTF-8", status: 201, why: "what fetch sends for a string body; the Origin guard is what stops a cross-site form, not a type check" },
  { path: START_PATH, body: `  ${JSON.stringify(TASK)}  `, status: 201, why: "JSON.parse ignores surrounding whitespace, and so may we" },
  { path: START_PATH, body: " \n ", status: 400, why: "whitespace alone carries no keys, so it reads as an absent body and still names no task" },
  { path: APPROVE_PATH, body: " \n ", status: 200, why: "and on a route that needs no keys, reading it as absent is the same answer a client sending nothing gets" },
  { path: FEEDBACK_PATH, body: JSON.stringify({ text: "a\u0000b" }), status: 200, why: "a NUL is valid JSON and reaches the child inside a JSON string on stdin, never in argv, so there is nothing here to truncate" },
]

for (const row of bodyRows) {
  const label = row.body === undefined ? "no body" : row.body.length > 60 ? `${row.body.slice(0, 57)}...` : row.body
  test(`POST ${row.path} with ${label} -> ${row.status} (${row.why})`, async () => {
    const { l, fake } = await withRunner()
    const res = await call(l, {
      path: row.path,
      method: "POST",
      ...(row.body === undefined ? {} : { body: row.body }),
      ...(row.contentType === undefined ? {} : { contentType: row.contentType }),
    })
    expect(res.status).toBe(row.status)
    // A refused body never reaches the machine, so a malformed request cannot
    // half-start a run.
    if (row.status >= 400) expect(fake.calls).toEqual([])
    else expect(fake.calls).toHaveLength(1)
  })
}

test("a refused body names the keys the route accepts, and never echoes what the caller sent", async () => {
  // `refuse` never reflects caller-chosen text. The dirty listing is forwarded
  // because src/git.ts wrote it; a key name from a request body is the caller's
  // own string and stays out of the response.
  const { l } = await withRunner()
  const res = await post(l, "/api/runs", JSON.stringify({ ...TASK, surprise: "<script>" }))
  expect(res.status).toBe(400)
  expect(res.body).toContain("projectPath")
  expect(res.body).toContain("featureFile")
  expect(res.body).toContain("taskRef")
  expect(res.body).not.toContain("surprise")
  expect(res.body).not.toContain("<script>")
})

test("the duplicated key really is the last one, so the row above is not passing vacuously", async () => {
  const { l, fake } = await withRunner()
  await post(l, "/api/runs", `{"projectPath":"/repo","featureFile":"f.md","taskRef":"T1","taskRef":"T7"}`)
  expect(fake.calls[0]?.request?.taskRef).toBe("T7")
})

// --- How big a body may be --------------------------------------------------

/** 64 KiB. The only field that can be large is the gate feedback a human types,
 * and 64 KiB is roughly ten thousand words: an order of magnitude past anything
 * typed into a textarea, and still room for a pasted stack trace or diff, which
 * is a legitimate thing to paste at a gate. The cap exists because the body is
 * buffered before anything can be validated, so without one a single
 * authenticated request decides how much memory the server spends. */
const MAX_BODY = 64 * 1024

/** A feedback body of exactly `total` bytes. `{"text":"` is 9 and `"}` is 2. */
function feedbackOf(total: number): string {
  return `{"text":"${"a".repeat(total - 11)}"}`
}

test("a body of exactly the cap is accepted, and one byte more is 413", async () => {
  const { l, fake } = await withRunner()
  const at = feedbackOf(MAX_BODY)
  expect(at).toHaveLength(MAX_BODY)
  expect((await post(l, FEEDBACK_PATH, at)).status).toBe(200)
  expect(fake.calls[0]?.text).toHaveLength(MAX_BODY - 11)

  const over = await withRunner()
  const res = await post(over.l, FEEDBACK_PATH, feedbackOf(MAX_BODY + 1))
  expect(res.status).toBe(413)
  expect(over.fake.calls).toEqual([])
})

test("a body that is not UTF-8 is refused rather than silently mended into U+FFFD", async () => {
  // The large field here is the human's own words. A lone 0x80 would decode to
  // a replacement character and reach the agent as one, so the bytes are
  // refused instead; no browser sends anything but UTF-8, so refusing costs
  // nothing. Sent as raw bytes, because a JS string cannot hold invalid UTF-8.
  const { l, fake } = await withRunner()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"text":"caf'))
      controller.enqueue(new Uint8Array([0xe9])) // latin-1 é: not valid UTF-8
      controller.enqueue(new TextEncoder().encode('"}'))
      controller.close()
    },
  })
  const res = await call(l, { path: FEEDBACK_PATH, method: "POST", body })
  expect(res.status).toBe(400)
  expect(res.body.toLowerCase()).toContain("utf-8")
  expect(fake.calls).toEqual([])
})

test("a chunked body with no declared length is capped while it is read, not after", async () => {
  // Probed: a ReadableStream body is sent `Transfer-Encoding: chunked` with no
  // Content-Length at all, so a guard that only read the header would let this
  // through - and `req.text()` would have buffered every byte of it first.
  const { l, fake } = await withRunner()
  let enqueued = 0
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 200; i++) {
        controller.enqueue(new Uint8Array(1024).fill(97))
        enqueued += 1024
      }
      controller.close()
    },
  })
  const res = await call(l, { path: FEEDBACK_PATH, method: "POST", body })
  expect(res.status).toBe(413)
  expect(fake.calls).toEqual([])
  expect(enqueued).toBeGreaterThan(MAX_BODY)
})

// --- Faults: a 5xx that says so, rather than an unhandled rejection ---------

test("a machine that throws is a 500 that names the route on the terminal and leaks nothing to the client", async () => {
  const { l } = await withRunner({
    async start() {
      throw new Error("the phase machine fell over at /home/someone/secret")
    },
  })

  // The terminal is captured, which earns its place twice: the reason going
  // there is half of the behaviour under test and was otherwise unasserted, and
  // letting it through prints a stack trace into every shared `bun run check`
  // for a test that is passing. Done by hand rather than with `spyOn`, because
  // `spyOn(console, "error").mockImplementation(...)` silences the channel here
  // but records no calls (observed on bun 1.4.3), which would have made the
  // assertion below quietly unprovable.
  const said: unknown[][] = []
  const original = console.error
  console.error = (...args: unknown[]) => void said.push(args)
  let res: { status: number; body: string }
  try {
    res = await post(l, "/api/runs", JSON.stringify(TASK))
  } finally {
    console.error = original
  }

  expect(res.status).toBe(500)
  // The reason belongs in the server's own terminal, not in a response body.
  expect(res.body).not.toContain("/home/someone/secret")
  expect(JSON.parse(res.body).error).toBeTypeOf("string")

  // Named by route, so a terminal full of faults says which one.
  expect(said).toHaveLength(1)
  expect(String(said[0]?.[0])).toContain("POST /api/runs")
  expect(String(said[0]?.[1])).toContain("/home/someone/secret")
})

test("a server launched with no machine answers 503 on every action, and still streams and serves pages", async () => {
  // `createServer()` has to work before Task 13 exists, and "the runner is not
  // wired" is an honest answer rather than a 500 or a route that is missing.
  const l = serve({ runner: undefined })
  for (const [path, body] of [
    [START_PATH, JSON.stringify(TASK)],
    [APPROVE_PATH, undefined],
    [FEEDBACK_PATH, JSON.stringify({ text: "x" })],
    [ANSWER_PATH, JSON.stringify({ text: "x" })],
    [STOP_PATH, undefined],
  ] as const) {
    const res = await post(l, path, body)
    expect(res.status, path).toBe(503)
  }
  expect((await call(l, { path: "/api/health" })).status).toBe(200)
})

test("a server launched with no project store answers 503 on registration, and nothing else notices", async () => {
  // The same honest answer for the other capability a launch can be without.
  // `ServerOptions.projectsFile` has no default on purpose, so this is also the
  // state every test that forgets to inject one is in - which is why it cannot
  // be a path to the developer's own store.
  const l = serve({ runner: fakeRunner().runner })
  const res = await post(l, "/api/projects", JSON.stringify({ path: "/repo", testCmd: "npm test" }))
  expect(res.status).toBe(503)
  expect(res.body).toContain("project store")
  // The run actions are unaffected: the two capabilities are independent.
  expect((await post(l, APPROVE_PATH)).status).toBe(200)
})

// --- Repos, for real --------------------------------------------------------

/** The developer's own git identity and config are kept out: a `commit.gpgsign`
 * or a `core.excludesFile` in their global config would otherwise decide
 * whether these tests pass. */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "kantan test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "kantan test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
}

async function gitIn(dir: string, ...args: string[]): Promise<void> {
  const p = Bun.spawn(["git", "-C", dir, ...args], { env: GIT_ENV, stdout: "pipe", stderr: "pipe" })
  const code = await p.exited
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${await new Response(p.stderr).text()}`)
}

/** What git says, trimmed. `gitIn` deliberately answers nothing, because every
 * other caller here only needs the exit code. */
async function gitSays(dir: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", "-C", dir, ...args], { env: GIT_ENV, stdout: "pipe", stderr: "pipe" })
  const out = await new Response(p.stdout).text()
  const code = await p.exited
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${await new Response(p.stderr).text()}`)
  return out.trim()
}

/** An empty scratch directory of its own, canonicalised so a comparison against
 * git's resolved root compares like with like. `mkdtemp` is unique per call, so
 * two `bun run check` processes cannot delete each other's work - the pid rule
 * in CLAUDE.md. */
async function scratch(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  scratchDirs.push(dir)
  return dir
}

/** A repo with one commit, clean, returning its real path. */
async function cleanRepo(): Promise<string> {
  const dir = await scratch("orch-repo-")
  await gitIn(dir, "init")
  await writeFile(join(dir, "app.txt"), "one\n")
  await gitIn(dir, "add", "app.txt")
  await gitIn(dir, "commit", "-m", "first")
  return dir
}

/** A repo with one commit and one modified tracked file, returning its path.
 * The dirt is a tracked modification rather than an untracked file, because a
 * developer's global `core.excludesFile` can hide the latter and the test would
 * pass for the wrong reason. */
async function dirtyRepo(): Promise<string> {
  const dir = await cleanRepo()
  await writeFile(join(dir, "app.txt"), "two\n")
  return dir
}

// ---------------------------------------------------------------------------
// 11. The plan the gate renders
// ---------------------------------------------------------------------------

// The gate is the product's central screen and it has nothing to show without
// this route. Two things it must get right, and both are about where the path
// comes from:
//
// The path is read from the **log**, never re-derived. `planPathFor` builds
// `docs/plans/<date>-<slug>.md` from the branch name and the date the run
// started, so recomputing it here would be a second slugger plus a date that
// has since moved on - and a gate pointed at a file nothing wrote renders empty
// while the real plan sits beside it.
//
// And the path is **untrusted**, because it arrives from a file on disk that a
// person can edit. A recorded `../../.ssh/id_rsa` is a 4xx, not a file read.

const PLAN_ROUTE = "GET /api/runs/:id/plan"

/** A log for `id` whose header names `projectPath`, with a plan phase record
 * carrying `planPath` when one is given. Real records through `runlog.ts`: the
 * thing under test is how the server reads what the machine writes. */
async function planLog(dir: string, id: string, projectPath: string, planPath?: string): Promise<void> {
  const log = await createRunLog(runLogPath(id, dir), header({ runId: id, projectPath }))
  await log.append({
    kind: "phase",
    phase: "plan",
    state: "running",
    ...(planPath === undefined ? {} : { planPath }),
  })
  await log.append({ kind: "phase", phase: "plan", state: "waiting", reason: "gate" })
  // Closed, unlike `startLog`'s live run: a handle left to the garbage
  // collector is an error on bun 1.4, and it surfaces inside whichever test
  // happens to be running when the collector reaches it.
  await log.close()
}

/** The success body is `{ok, plan}` where `plan` is `PlanSource` **field for
 * field as `src/ui/Gate.tsx` declares it**, so the shell hands it straight to
 * the card. Spelled loosely here on purpose: these tests are about what goes
 * over the wire, and a typed parse would assert the type rather than the JSON. */
interface PlanBody {
  ok?: boolean
  plan?: { status?: string; path?: string; markdown?: string; why?: string }
  error?: string
}

async function getPlan(l: Launch, id: string): Promise<{ status: number; body: PlanBody; raw: string }> {
  const res = await call(l, { path: `/api/runs/${id}/plan` })
  return { status: res.status, body: JSON.parse(res.body) as PlanBody, raw: res.body }
}

test("the plan route is a GET registered in ROUTES, behind the guards, and not token-exempt", () => {
  expect(Object.keys(ROUTES)).toContain(PLAN_ROUTE)
  expect(TOKEN_EXEMPT.has(PLAN_ROUTE)).toBe(false)
  expect([...TOKEN_EXEMPT].sort()).toEqual(["GET /", "GET /api/session"])
})

test("the plan is served from the path the log recorded, not from the naming convention", async () => {
  // The sharp half of this test is the decoy: a file at the conventional path
  // holds different text, so a route that re-derived the path would pass a
  // weaker assertion and fail this one.
  const repo = await cleanRepo()
  await mkdir(join(repo, "docs", "plans"), { recursive: true })
  await writeFile(join(repo, "docs", "plans", "agent-preferred-name.md"), "# The plan\n\nStep 1. café ✓ 🙂\n")
  await writeFile(join(repo, "docs", "plans", "2026-10-11-x-t7.md"), "# A plan nobody dictated\n")

  const dir = await runsDir()
  const l = serve({ runsDir: dir })
  await planLog(dir, "plan-ok", repo, "docs/plans/agent-preferred-name.md")

  const { status, body } = await getPlan(l, "plan-ok")
  expect(status).toBe(200)
  // `toEqual` on the whole body, so an extra key cannot creep in unnoticed:
  // `plan` is `PlanSource` as `src/ui/Gate.tsx` declares it, and the shell hands
  // it straight to the card.
  expect(body).toEqual({
    ok: true,
    plan: {
      status: "loaded",
      path: "docs/plans/agent-preferred-name.md",
      markdown: "# The plan\n\nStep 1. café ✓ 🙂\n",
    },
  })
})

test("a project spelled through a symlink still resolves to its own plan", async () => {
  // `header.projectPath` is the store's spelling, which may be a symlink, while
  // the containment check needs a canonical root. The control for the escape
  // test below: if resolving were done by string comparison alone, this would
  // be refused as an escape.
  const repo = await cleanRepo()
  await mkdir(join(repo, "docs", "plans"), { recursive: true })
  await writeFile(join(repo, "docs", "plans", "p.md"), "# Through a link\n")
  const link = join(await scratch("orch-plink-"), "repo")
  await symlink(repo, link)

  const dir = await runsDir()
  const l = serve({ runsDir: dir })
  await planLog(dir, "linked-project", link, "docs/plans/p.md")

  const { status, body } = await getPlan(l, "linked-project")
  expect(status).toBe(200)
  expect(body.plan).toEqual({ status: "loaded", path: "docs/plans/p.md", markdown: "# Through a link\n" })
})

test("a plan file that is a symlink inside the repo is read; one pointing out of it is a 400", async () => {
  // The string checks cannot see this: `stat` and `readFile` follow symlinks,
  // so a `docs/plans/x.md` that links to `~/.ssh/id_rsa` - or a `docs/plans`
  // that does - passes every check on the path and still reads the key. The
  // agent that writes plans has shell access in that repo, so the link is one
  // command away.
  const secret = join(await scratch("orch-secret-"), "id_rsa")
  await writeFile(secret, "PRIVATE KEY MATERIAL\n")
  const dir = await runsDir()
  const l = serve({ runsDir: dir })

  // A link to a file inside the repo: a legitimate thing someone may do, and
  // the control that proves the refusals below are about leaving the repo.
  const ok = await cleanRepo()
  await mkdir(join(ok, "docs", "plans"), { recursive: true })
  await writeFile(join(ok, "docs", "the-real-plan.md"), "# Linked inside\n")
  await symlink(join(ok, "docs", "the-real-plan.md"), join(ok, "docs", "plans", "p.md"))
  await planLog(dir, "link-inside", ok, "docs/plans/p.md")
  const inside = await getPlan(l, "link-inside")
  expect(inside.status).toBe(200)
  expect(inside.body.plan).toEqual({ status: "loaded", path: "docs/plans/p.md", markdown: "# Linked inside\n" })

  // The plan file itself is a link out of the repo.
  const viaFile = await cleanRepo()
  await mkdir(join(viaFile, "docs", "plans"), { recursive: true })
  await symlink(secret, join(viaFile, "docs", "plans", "p.md"))
  await planLog(dir, "link-file", viaFile, "docs/plans/p.md")

  // The directory holding it is a link out of the repo.
  const viaDir = await cleanRepo()
  const elsewhere = await scratch("orch-elsewhere-")
  await writeFile(join(elsewhere, "p.md"), "PRIVATE KEY MATERIAL\n")
  await mkdir(join(viaDir, "docs"), { recursive: true })
  await symlink(elsewhere, join(viaDir, "docs", "plans"))
  await planLog(dir, "link-dir", viaDir, "docs/plans/p.md")

  for (const id of ["link-file", "link-dir"]) {
    const { status, body, raw } = await getPlan(l, id)
    expect(status, id).toBe(400)
    expect(body.error, id).toContain("repository")
    expect(raw, id).not.toContain("PRIVATE KEY")
  }
})

test("a run that never dictated a path is undictated, which is not the same as unreadable", async () => {
  // The gate models the two separately and disables Approve on both, so they
  // have to be distinguishable: one is "there is no plan to read", the other is
  // "there is a plan path and its contents cannot be had".
  const repo = await cleanRepo()
  const dir = await runsDir()
  const l = serve({ runsDir: dir })
  await planLog(dir, "no-path", repo)
  await planLog(dir, "empty-path", repo, "")

  for (const id of ["no-path", "empty-path"]) {
    const { status, body } = await getPlan(l, id)
    expect(status, id).toBe(200)
    // No path and no prose, exactly as `PlanSource` declares this shape: the
    // gate owns that sentence, and a second copy here would be a second place
    // for it to drift.
    expect(body.plan, id).toEqual({ status: "undictated" })
  }
})

test("a dictated path with nothing at it is unreadable, and says which path it looked at", async () => {
  // HANDOFF's open gap, which Task 13 left for the gate: an agent that answers
  // `ORCH: done` without writing the plan it was told to write parks the run at
  // a gate with nothing to show. This is what that looks like over HTTP.
  const repo = await cleanRepo()
  const dir = await runsDir()
  const l = serve({ runsDir: dir })
  await planLog(dir, "missing", repo, "docs/plans/never-written.md")

  const { status, body } = await getPlan(l, "missing")
  expect(status).toBe(200)
  expect(body.plan?.status).toBe("unreadable")
  expect(body.plan?.path).toBe("docs/plans/never-written.md")
  expect(body.plan?.why).toContain("docs/plans/never-written.md")
  // Nothing is offered to render: the card disables Approve on this shape.
  expect(body.plan?.markdown).toBeUndefined()
})

test("a plan path that is a directory, is not UTF-8, or is enormous is unreadable rather than a 500", async () => {
  const repo = await cleanRepo()
  await mkdir(join(repo, "docs", "plans", "a-directory.md"), { recursive: true })
  // A lone 0x80 is not valid UTF-8. The gate must not render a plan with a
  // replacement character in it and let someone approve that.
  await writeFile(join(repo, "docs", "plans", "latin1.md"), Buffer.from([0x23, 0x20, 0x63, 0x61, 0x66, 0x80]))
  await writeFile(join(repo, "docs", "plans", "huge.md"), "x".repeat(1024 * 1024 + 1))

  const dir = await runsDir()
  const l = serve({ runsDir: dir })
  const cases = [
    ["dir", "docs/plans/a-directory.md", "not a file"],
    ["latin1", "docs/plans/latin1.md", ""],
    ["huge", "docs/plans/huge.md", "bytes"],
  ] as const
  for (const [id, planPath, says] of cases) {
    await planLog(dir, id, repo, planPath)
    const { status, body } = await getPlan(l, id)
    expect(status, id).toBe(200)
    expect(body.plan?.status, id).toBe("unreadable")
    expect(body.plan?.path, id).toBe(planPath)
    expect(body.plan?.markdown, id).toBeUndefined()
    if (says !== "") expect(body.plan?.why, id).toContain(says)
    expect(body.plan?.why, id).toBeTypeOf("string")
  }
})

test("a recorded plan path that escapes the repo is a 4xx and reads nothing", async () => {
  // The path comes from a log record, which is a file a person can edit, so it
  // is caller input in the same class as a run id - and the check is
  // `runLogPath`'s: refuse by construction rather than resolve and compare.
  const repo = await cleanRepo()
  const outside = join(await scratch("orch-secret-"), "id_rsa")
  await writeFile(outside, "PRIVATE KEY MATERIAL\n")

  const dir = await runsDir()
  const l = serve({ runsDir: dir })
  const escapes = [
    "../../id_rsa",
    "docs/../../id_rsa",
    `..${sep}..${sep}id_rsa`,
    outside, // an absolute path discards the root entirely
    "/etc/passwd",
    "docs/plans/x\0.md",
    "..",
  ]

  for (const [i, planPath] of escapes.entries()) {
    const id = `escape-${i}`
    await planLog(dir, id, repo, planPath)
    const { status, body, raw } = await getPlan(l, id)
    expect(status, planPath).toBe(400)
    expect(body.error, planPath).toContain("repository")
    // Never the contents, and never the path it was asked for: that is
    // caller-chosen text in a body a page may be able to read.
    expect(raw, planPath).not.toContain("PRIVATE KEY")
    expect(raw, planPath).not.toContain("id_rsa")
  }
})

test("a project whose repo has moved is unreadable with git's own reason, not a 500", async () => {
  const gone = join(await scratch("orch-gone-"), "repo")
  const dir = await runsDir()
  const l = serve({ runsDir: dir })
  await planLog(dir, "moved", gone, "docs/plans/x.md")

  const { status, body } = await getPlan(l, "moved")
  expect(status).toBe(200)
  expect(body.plan?.status).toBe("unreadable")
  // The reason is readable and names the path, which is what this test is
  // about; it is no longer git's own sentence, because a directory that does
  // not exist now says so before git is asked. "Not a git repository" sent
  // readers looking for the wrong problem.
  expect(body.plan?.why).toContain("no directory at")
  expect(body.plan?.why).toContain(gone)
})

test("the plan route refuses an unusable run id and 404s a run with no log", async () => {
  const dir = await runsDir()
  const l = serve({ runsDir: dir })
  // The matcher refuses an empty segment before the handler sees it, and the
  // URL parser resolves `..`, so these are the ids that can actually arrive.
  expect((await getPlan(l, "..%2F..%2Fetc%2Fpasswd")).status).toBe(404)
  const unknown = await getPlan(l, "11111111-1111-4111-8111-111111111111")
  expect(unknown.status).toBe(404)
  expect(unknown.body.error).toContain("no log")
})

test("reading a plan changes nothing on disk, because a local page can make this request", async () => {
  // `SameSite=Strict` ignores ports, so any page on another localhost port can
  // trigger this GET with our cookie - it cannot read the answer, but the route
  // must not be able to *cause* anything either. No Origin, as those requests
  // send none.
  const repo = await cleanRepo()
  await mkdir(join(repo, "docs", "plans"), { recursive: true })
  await writeFile(join(repo, "docs", "plans", "p.md"), "# P\n")
  const dir = await runsDir()
  const l = serve({ runsDir: dir })
  await planLog(dir, "quiet", repo, "docs/plans/p.md")

  const before = (await readdir(dir)).sort()
  const res = await call(l, { path: "/api/runs/quiet/plan", origin: null })
  expect(res.status).toBe(200)
  expect(JSON.parse(res.body).plan.status).toBe("loaded")
  expect((await readdir(dir)).sort()).toEqual(before)
  expect((await readdir(join(repo, "docs", "plans"))).sort()).toEqual(["p.md"])
  // Still a document, not a page: nothing here renders HTML.
  expect(res.headers.get("content-type")).toStartWith("application/json")
  expect(res.headers.get("cache-control")).toBe("no-store")
})

// ---------------------------------------------------------------------------
// 12. Registering a project
// ---------------------------------------------------------------------------

// `projects.json` was read everywhere and written by nothing, so the design's
// empty state ("Add a repository") had no backend at all. The dialog asks for a
// repo path, a Claude account and a test command; the task file it also asks
// for is not a project field - it names a run, and it reaches `POST /api/runs`
// as `featureFile`.
//
// Two validators, with two different owners. `defaults()` fills the design's
// defaults and validates the record the store will accept, and it **throws**:
// that throw is a 4xx, because it is the caller's typo and not a server fault.
// `requireUsableRepo()` is what the store cannot do - `projects.json` only
// checks that the path is an absolute string, so without it a path that is not
// a repository registers happily and fails at the first run, where the message
// is about a run rather than about the registration that was wrong.

const REGISTER = "POST /api/projects"
const REGISTER_PATH = "/api/projects"

/** A launch with a store of its own and no machine: registration needs no
 * runner, and leaving it out proves it. */
async function withStore(): Promise<{ l: Launch; store: string }> {
  const store = await storeFile()
  return { l: serve({ runsDir: await runsDir(), projectsFile: store }), store }
}

function register(l: Launch, body: unknown): Promise<{ status: number; headers: Headers; body: string }> {
  return post(l, REGISTER_PATH, JSON.stringify(body))
}

test("registration is a POST registered in ROUTES, behind the guards, and not token-exempt", () => {
  expect(Object.keys(ROUTES)).toContain(REGISTER)
  expect(TOKEN_EXEMPT.has(REGISTER)).toBe(false)
  expect([...TOKEN_EXEMPT].sort()).toEqual(["GET /", "GET /api/session"])
})

test("registering a repo writes a record the store itself accepts, and answers it back", async () => {
  // Read back with `loadProjects`, not `JSON.parse`: the invariant that matters
  // is that the tool's own write is a record the store will load again. A
  // record it refuses would brick every later read.
  const repo = await cleanRepo()
  const { l, store } = await withStore()

  const res = await register(l, { path: repo, testCmd: "npm test" })
  expect(res.status).toBe(201)

  const expected: Project = {
    path: repo,
    testCmd: "npm test",
    permissionMode: "acceptEdits",
    allowedTools: null,
    budgetUsd: 50,
    planModel: "claude-opus-5-5",
    implementModel: "claude-sonnet-5-5",
    planEffort: "high",
    implementEffort: "medium",
  }
  expect(JSON.parse(res.body)).toEqual({ ok: true, project: expected })
  expect(await loadProjects(store)).toEqual([expected])
  expect(res.body).not.toContain(l.token)
})

test("the profile directory and the account are separate fields, and the account is enumerated", async () => {
  // `configDir` selects a CLI profile - a CLAUDE.md, skills and settings as
  // well as credentials. `account` is what the human *called* it, and the two
  // are deliberately not derived from each other: no rule turning
  // `/home/u/.claude-work` into "work" is anything but a guess about how a
  // stranger names directories, and design §5 lists a wrong account as a
  // defect because people bill clients from one of these.
  const repo = await cleanRepo()
  const profile = await scratch("orch-profile-")
  const { l, store } = await withStore()

  const ok = await register(l, { path: repo, testCmd: "npm test", configDir: profile, account: "work" })
  expect(ok.status).toBe(201)
  expect((await loadProjects(store))[0]?.configDir).toBe(profile)
  expect((await loadProjects(store))[0]?.account).toBe("work")

  // Absent is a real answer - "not sure" - and must not become a guess.
  const quiet = await withStore()
  expect((await register(quiet.l, { path: await cleanRepo(), testCmd: "npm test" })).status).toBe(201)
  expect((await loadProjects(quiet.store))[0]?.account).toBeUndefined()

  // Two words or nothing. A third spelling renders as neither chip colour.
  const other = await withStore()
  const bad = await register(other.l, { path: await cleanRepo(), testCmd: "npm test", account: "personal account" })
  expect(bad.status).toBe(400)
  expect(bad.body).toContain("account")
  expect(await loadProjects(other.store)).toEqual([])
})

test("a relative configDir is a 4xx with the store's own reason, not a 500", async () => {
  // HANDOFF's entry, consumed: `defaults()` throws on a field it cannot read,
  // and the throw is the caller's typo rather than a server fault. The reason
  // is forwarded because it is the only thing that fixes the mistake - the CLI
  // expands no `~`, which is not something a bare 400 would tell anyone.
  const repo = await cleanRepo()
  const { l, store } = await withStore()
  for (const configDir of ["~/.claude-work", "relative/profile", " "]) {
    const res = await register(l, { path: repo, testCmd: "npm test", configDir })
    expect(res.status, configDir).toBe(400)
    expect(res.body, configDir).toContain("configDir")
  }
  expect(await loadProjects(store)).toEqual([])
})

test("the task file the dialog asks for is not a project field, and saying so is a 400", async () => {
  const repo = await cleanRepo()
  const { l, store } = await withStore()
  for (const key of ["taskFile", "featureFile", "testcmd", "resumePlanSession", "<script>alert(1)</script>"]) {
    const res = await register(l, { path: repo, testCmd: "npm test", [key]: "docs/features/x.md" })
    expect(res.status, key).toBe(400)
    // The keys this route takes, never the key that was sent: that is
    // caller-chosen text in a body a page may be able to read.
    expect(res.body, key).toContain("path, testCmd, account, configDir")
    expect(res.body, key).not.toContain(key)
  }
  expect(await loadProjects(store)).toEqual([])
})

test("every repo state kantan cannot run in is refused, with the reason git gave", async () => {
  // The enumeration, rather than a sample of it: each row is a thing that
  // otherwise registers happily and fails at the first run.
  const empty = await scratch("orch-plain-")
  const file = join(await scratch("orch-file-"), "notadir")
  await writeFile(file, "x\n")
  const bare = await scratch("orch-bare-")
  await gitIn(bare, "init", "--bare")
  const unborn = await scratch("orch-unborn-")
  await gitIn(unborn, "init")
  const repo = await cleanRepo()
  const inside = join(repo, "docs")
  await mkdir(inside, { recursive: true })

  const rows: [string, string, string][] = [
    // These two no longer say "git repository", and should not: the problem is
    // not that the path fails to be a repo, it is that there is nothing there
    // to be one. A user who typed a home directory that did not exist was sent
    // looking for a git problem.
    ["a path with nothing at it", join(empty, "nope"), "no directory at"],
    ["a file, not a directory", file, "a file, not a directory"],
    ["a directory that is not a repo", empty, "git repository"],
    ["a subdirectory of a repo, which git answers for", inside, "not the root"],
    ["a bare repo, which has no working tree", bare, "bare"],
    ["a repo with no commits, which has no base to branch from", unborn, "no commits"],
    ["a relative path, refused by the store before git is asked", "relative/repo", "absolute"],
  ]

  for (const [why, path, says] of rows) {
    const { l, store } = await withStore()
    const res = await register(l, { path, testCmd: "npm test" })
    expect(res.status, why).toBe(400)
    expect(res.body, why).toContain(says)
    expect(await loadProjects(store), why).toEqual([])
  }
})

test("a second spelling of one repo is one project, not two histories", async () => {
  // HANDOFF's "two spellings split the records": the store normalises a path
  // lexically only, so the registered path is git's resolved root. A symlinked
  // spelling then meets the 409 below instead of forking the project's runs,
  // its logs and its task tree.
  const repo = await cleanRepo()
  const link = join(await scratch("orch-link-"), "repo-by-another-name")
  await symlink(repo, link)
  const { l, store } = await withStore()

  const first = await register(l, { path: `${repo}/`, testCmd: "npm test" })
  expect(first.status).toBe(201)
  // The trailing slash is gone and the path is the root git reports.
  expect(JSON.parse(first.body).project.path).toBe(repo)

  const second = await register(l, { path: link, testCmd: "npm test" })
  expect(second.status).toBe(409)
  expect(second.body).toContain(repo)
  expect(await loadProjects(store)).toHaveLength(1)
})

test("registering a known repo again is refused, because the store is the one state nothing can rebuild", async () => {
  // `addProject` replaces a record wholesale, so a second trip through a dialog
  // that offers three fields would reset a budget or an allowlist someone tuned
  // by hand. Refusing costs an edit in a file they already own.
  const repo = await cleanRepo()
  const { l, store } = await withStore()
  expect((await register(l, { path: repo, testCmd: "npm test" })).status).toBe(201)

  const again = await register(l, { path: repo, testCmd: "vendor/bin/pest" })
  expect(again.status).toBe(409)
  // Prose a person can act on: it names the file to edit.
  expect(again.body).toContain(store)
  const [stored] = await loadProjects(store)
  expect(stored?.testCmd).toBe("npm test")
})

test("a damaged store is a 500 that forwards its own message, which names the file", async () => {
  // The exception to "a fault's reason goes to the terminal": this message
  // names the file and what is wrong with it, the user owns that file, and an
  // editor fixes what a message points at. A generic 500 would send someone to
  // a terminal they are not looking at. The terminal still gets it too.
  const repo = await cleanRepo()
  const { l, store } = await withStore()
  await writeFile(store, "{ not json\n")

  const said: unknown[][] = []
  const original = console.error
  console.error = (...args: unknown[]) => void said.push(args)
  let res: { status: number; body: string }
  try {
    res = await register(l, { path: repo, testCmd: "npm test" })
  } finally {
    console.error = original
  }

  expect(res.status).toBe(500)
  expect(res.body).toContain(store)
  expect(said).toHaveLength(1)
  // And the damaged file is left exactly as it was, not replaced with a store
  // holding one project.
  expect(await readFile(store, "utf8")).toBe("{ not json\n")
})

test("a malformed registration body is refused before anything is written", async () => {
  // The same enumeration the actions get, because the costs are the same shape:
  // over-accepting writes a project nothing can run, over-rejecting means the
  // empty state cannot get anyone started.
  const repo = await cleanRepo()
  const rows: { body?: string; status: number; why: string }[] = [
    { status: 400, why: "no body names no repository" },
    { body: "", status: 400, why: "nor does an empty one" },
    { body: "not json", status: 400, why: "the body must parse as JSON" },
    { body: "null", status: 400, why: "typeof null is object, which is the trap" },
    { body: "[]", status: 400, why: "an array is not a record" },
    { body: "5", status: 400, why: "nor is a scalar" },
    { body: "{}", status: 400, why: "an object with neither required key" },
    { body: JSON.stringify({ path: repo }), status: 400, why: "a repo with no test command: the design branches on its exit code" },
    { body: JSON.stringify({ testCmd: "npm test" }), status: 400, why: "a test command with no repo to run it in" },
    { body: JSON.stringify({ path: repo, testCmd: "" }), status: 400, why: 'an empty testCmd runs as sh -c "", which exits 0 and passes every task' },
    { body: JSON.stringify({ path: repo, testCmd: "   " }), status: 400, why: "and whitespace is the same thing" },
    { body: JSON.stringify({ path: "", testCmd: "npm test" }), status: 400, why: "an empty path names no repo" },
    { body: JSON.stringify({ path: 7, testCmd: "npm test" }), status: 400, why: "a number is not a path" },
    { body: JSON.stringify({ path: [repo], testCmd: "npm test" }), status: 400, why: "nor an array of one" },
    { body: JSON.stringify({ path: repo, testCmd: "npm test" }), status: 201, why: "the control: the two keys a project needs" },
    { body: JSON.stringify({ path: repo, testCmd: null }), status: 201, why: "a repo with no test suite registers, and its runs are verified by the agent itself" },
  ]

  for (const row of rows) {
    const { l, store } = await withStore()
    const res = await call(l, {
      path: REGISTER_PATH,
      method: "POST",
      ...(row.body === undefined ? {} : { body: row.body }),
    })
    expect(res.status, row.why).toBe(row.status)
    expect(await loadProjects(store), row.why).toHaveLength(row.status === 201 ? 1 : 0)
  }
})

test("registering with testCmd null stores null, so the agent verifies that project's runs", async () => {
  // The matrix row above pins the status; this pins the **value**, which is the
  // part that matters. A server that stored a placeholder - `""`, or the string
  // "null" - would answer 201 and pass that row while quietly giving the repo a
  // command that `sh -c` exits 0 on: every task ticked, nothing ever run.
  const { l, store } = await withStore()
  const repo = await cleanRepo()

  const res = await register(l, { path: repo, testCmd: null })
  expect(res.status).toBe(201)
  expect(JSON.parse(res.body).project.testCmd).toBeNull()
  expect((await loadProjects(store))[0]?.testCmd).toBeNull()
})

// ---------------------------------------------------------------------------
// 12b. Removing a project
// ---------------------------------------------------------------------------

// A real user reported it: a project could be registered and never removed, so
// a repo added by mistake, or one that has since been deleted, stayed in the
// tree for good. The mechanism existed nowhere - `src/projects.ts` had
// `loadProjects` and `addProject` and nothing else - so this is the store's new
// `removeProject` plus the one question the store cannot answer, which is
// whether a run of that project is in flight right now.

const REMOVE = "DELETE /api/projects"

function remove(l: Launch, body: unknown): Promise<{ status: number; headers: Headers; body: string }> {
  return call(l, { path: REGISTER_PATH, method: "DELETE", body: JSON.stringify(body) })
}

/** A run log holding nothing but its header, under `id`, naming `projectPath`.
 * `createRunLog` writes it, not this file: attributing a live run reads the
 * first record and only accepts a header, so a hand-written line missing
 * `kind` would exercise the wrong branch of that rule. */
async function logNamingProject(dir: string, id: string, projectPath: string): Promise<void> {
  const log = await createRunLog(runLogPath(id, dir), header({ runId: id, projectPath }))
  await log.close()
}

test("removal is a DELETE registered in ROUTES, behind the guards, and not token-exempt", () => {
  expect(Object.keys(ROUTES)).toContain(REMOVE)
  expect(TOKEN_EXEMPT.has(REMOVE)).toBe(false)
  // Section 7's loop covers all three guards for every key, whatever its
  // method, so this route is Host-, Origin- and token-checked the moment it is
  // registered. `SameSite=Strict` ignores ports, which is why an exemption
  // here would be reachable from any other page on this machine.
  expect([...TOKEN_EXEMPT].sort()).toEqual(["GET /", "GET /api/session"])
})

test("removing a project drops its record and leaves the tree without it", async () => {
  const repo = await cleanRepo()
  const other = await cleanRepo()
  const { l, store } = await withStore()
  expect((await register(l, { path: repo, testCmd: "npm test" })).status).toBe(201)
  expect((await register(l, { path: other, testCmd: "npm test" })).status).toBe(201)

  const res = await remove(l, { path: repo })
  expect(res.status).toBe(200)
  expect(JSON.parse(res.body)).toEqual({ ok: true })
  expect((await loadProjects(store)).map((p) => p.path)).toEqual([other])
})

test("a trailing slash removes the record a trailing slash would have found", async () => {
  // The store's identity is lexical, and `projectIdentity` is the one rule for
  // it, so the route cannot disagree with the record it is about to remove.
  const repo = await cleanRepo()
  const { l, store } = await withStore()
  await register(l, { path: repo, testCmd: "npm test" })
  expect((await remove(l, { path: `${repo}/` })).status).toBe(200)
  expect(await loadProjects(store)).toEqual([])
})

test("removing a path that is not registered is a 404 naming the store, not a quiet 200", async () => {
  // Decided rather than assumed. A 200 would make the route idempotent, which
  // is the usual argument for DELETE, but it answers "that project is gone" to
  // a misspelled path when the project is still there - and a client that
  // wants idempotence can treat this 404 as success, while nothing can recover
  // the distinction from a 200. It is also the answer `POST /api/features`
  // already gives for the same condition, and two routes disagreeing about
  // what "that path is not a project" means is the drift worth avoiding.
  const repo = await cleanRepo()
  const { l, store } = await withStore()
  await register(l, { path: repo, testCmd: "npm test" })

  const res = await remove(l, { path: join(repo, "nope") })
  expect(res.status).toBe(404)
  expect(res.body).toContain(store)
  expect(await loadProjects(store)).toHaveLength(1)
})

test("a removal refuses a relative path rather than resolving it against the cwd", async () => {
  const { l, store } = await withStore()
  const res = await remove(l, { path: "repo" })
  expect(res.status).toBe(400)
  expect(res.body).toContain("absolute repo path")
  expect(await readdir(dirname(store))).toEqual([])
})

test("the removal route takes the path and nothing else", async () => {
  // Its own allowlist, not registration's: `PROJECT_KEYS` carries `testCmd`
  // and `account`, and a DELETE that accepted those would read as "remove this
  // much of the project" to whoever sent them.
  const repo = await cleanRepo()
  const { l, store } = await withStore()
  await register(l, { path: repo, testCmd: "npm test" })

  const res = await remove(l, { path: repo, testCmd: "npm test" })
  expect(res.status).toBe(400)
  expect(res.body).toContain("path")
  expect(res.body).not.toContain("testCmd")
  expect(await loadProjects(store)).toHaveLength(1)
})

test("a malformed removal body is refused before anything is written", async () => {
  const repo = await cleanRepo()
  const rows: { body?: string; status: number; why: string }[] = [
    { status: 400, why: "no body names no project" },
    { body: "", status: 400, why: "nor does an empty one" },
    { body: "not json", status: 400, why: "the body must parse as JSON" },
    { body: "null", status: 400, why: "typeof null is object, which is the trap" },
    { body: JSON.stringify([{ path: "/repo" }]), status: 400, why: "an array is not a record, even holding the right one" },
    { body: "{}", status: 400, why: "an object with no path in it" },
    { body: JSON.stringify({ path: "" }), status: 400, why: "an empty path names no project" },
    { body: JSON.stringify({ path: "   " }), status: 400, why: "and whitespace names none either" },
    { body: JSON.stringify({ path: 7 }), status: 400, why: "a number is not a path" },
    { body: JSON.stringify({ pathh: "/repo" }), status: 400, why: "the near-miss spelling, refused by name rather than read as absent" },
    { body: JSON.stringify({ path: "/repo" }), status: 404, why: "the control: a well-formed body for a path nobody registered" },
  ]

  for (const row of rows) {
    const { l, store } = await withStore()
    await register(l, { path: repo, testCmd: "npm test" })
    const res = await call(l, {
      path: REGISTER_PATH,
      method: "DELETE",
      ...(row.body === undefined ? {} : { body: row.body }),
    })
    expect(res.status, row.why).toBe(row.status)
    expect(await loadProjects(store), row.why).toHaveLength(1)
  }
})

test("a server launched without a project store answers 503 on a removal", async () => {
  const l = serve({ runsDir: await runsDir() })
  const res = await remove(l, { path: "/repo" })
  expect(res.status).toBe(503)
})

test("a damaged store is a 500 that forwards its own message, not an empty removal", async () => {
  // The same answer, and the same reasoning, as registration's: the store is
  // the one piece of state no repository can rebuild, the message names the
  // file and the field, and an editor fixes what it points at. Reading it as
  // "no projects" would answer 404 for a project that is still in the file.
  const store = await storeFile()
  await mkdir(dirname(store), { recursive: true })
  await writeFile(store, '[{ "path": "/repo", oops }]')
  const l = serve({ runsDir: await runsDir(), projectsFile: store })

  const res = await remove(l, { path: "/repo" })
  expect(res.status).toBe(500)
  expect(res.body).toContain(store)
})

test("a project with a run in flight is refused, because removing it makes that run unreachable", async () => {
  // Every method on the machine's port - `stop` included - resolves the run's
  // project through `projects.json` first, so a record removed mid-run turns
  // approve, answer, resume and stop into `unknown-project`. The run keeps its
  // child, keeps spending, and vanishes from the tree with no way to reach it.
  // Refusing costs one sentence: stop it first.
  const repo = await cleanRepo()
  const dir = await runsDir()
  const store = await storeFile()
  const live = "33333333-3333-4333-8333-333333333333"
  const l = serve({ runsDir: dir, projectsFile: store, liveRunIds: () => [live] })

  // The header is what attributes a live run to a record, and nothing else in
  // the log holds it. Written by `createRunLog`, never by hand: it writes
  // `kind` beside the header's own fields, and a line without that does not
  // parse as a header at all - which would make this pass as "could not be
  // attributed" rather than as the case it is about.
  await logNamingProject(dir, live, (await requireUsableRepo(repo)).root)
  await register(l, { path: repo, testCmd: "npm test" })

  const res = await remove(l, { path: repo })
  expect(res.status).toBe(409)
  expect(res.body).toContain(live)
  // The attributed refusal, not the one for a run whose log says nothing:
  // without this the case passes with the header unreadable, which is a
  // different branch and a different sentence.
  expect(res.body).toContain("is in flight for")
  expect(res.body).toContain(repo)
  expect(await loadProjects(store)).toHaveLength(1)
})

test("a live run of another project does not block a removal", async () => {
  // The lock is per repository, so two projects can be busy at once: a check
  // keyed on "anything is running" would make a removal depend on an unrelated
  // task, which is a refusal nobody could act on.
  const repo = await cleanRepo()
  const dir = await runsDir()
  const store = await storeFile()
  const live = "44444444-4444-4444-8444-444444444444"
  const l = serve({ runsDir: dir, projectsFile: store, liveRunIds: () => [live] })

  await logNamingProject(dir, live, "/some/other/repo")
  await register(l, { path: repo, testCmd: "npm test" })

  expect((await remove(l, { path: repo })).status).toBe(200)
  expect(await loadProjects(store)).toEqual([])
})

test("a live run whose log cannot be attributed to a project blocks the removal", async () => {
  // The dimension is **what one live run id's log can be read as**, and the
  // values are: a header naming this project, a header naming another, no log
  // at all, a log with no header on line one, and a read that fails. Only the
  // second is safely ignorable. The rest cannot be attributed, and the two
  // costs are not symmetric: refusing costs a restart or a stop, while
  // allowing it can orphan a run that is still spending money with no route
  // left to stop it.
  const repo = await cleanRepo()
  const dir = await runsDir()
  const store = await storeFile()
  const headless = "55555555-5555-4555-8555-555555555555"
  const absent = "66666666-6666-4666-8666-666666666666"
  const unusable = ".."

  for (const id of [headless, absent, unusable]) {
    const l = serve({ runsDir: dir, projectsFile: store, liveRunIds: () => [id] })
    if (id === headless) {
      // A log whose line one is not a header: nothing in it can say which
      // project the run belongs to.
      await writeFile(runLogPath(headless, dir), JSON.stringify({ kind: "cli", event: {} }) + "\n")
    }
    await register(l, { path: repo, testCmd: "npm test" })
    const res = await remove(l, { path: repo })
    expect(res.status, id).toBe(409)
    // The un-attributable refusal specifically, which is the branch this case
    // is about: it says kantan cannot tell, rather than naming a project.
    expect(res.body, id).toContain("cannot tell which project")
    expect(await loadProjects(store), id).toHaveLength(1)
  }
})

test("a launch that cannot say who is live removes the project rather than refusing every time", async () => {
  // `liveRunIds` is null when the launch was given no machine to ask, and such
  // a server drives no run at all - so there is nothing to orphan, and
  // refusing would make the route unusable on exactly the launches the tests
  // and the docs use.
  const repo = await cleanRepo()
  const { l, store } = await withStore()
  await register(l, { path: repo, testCmd: "npm test" })
  expect((await remove(l, { path: repo })).status).toBe(200)
  expect(await loadProjects(store)).toEqual([])
})

test("a removed project's run logs are left on disk, because nothing can rebuild one", async () => {
  // Decided rather than assumed. They are keyed by run id, not by project,
  // they are the record of work that cost real money, and `indexRuns` already
  // skips a log whose project is gone - with a warning, which is the whole
  // cost of keeping them. Re-registering the same path brings the history
  // back; deleting them answers an undoable question nobody asked.
  const repo = await cleanRepo()
  const dir = await runsDir()
  const store = await storeFile()
  const l = serve({ runsDir: dir, projectsFile: store })
  const id = "77777777-7777-4777-8777-777777777777"
  await logNamingProject(dir, id, (await requireUsableRepo(repo)).root)

  expect((await register(l, { path: repo, testCmd: "npm test" })).status).toBe(201)
  expect((await remove(l, { path: repo })).status).toBe(200)

  expect(await readdir(dir)).toContain(`${id}.jsonl`)
  // And the tree says out loud that it is skipping them, rather than dropping
  // them in silence: this is the warning the user who asked for removal has
  // already seen in practice.
  const tree = await getTree(l)
  expect(tree.body.projects).toEqual([])
  expect(tree.body.warnings?.join("\n")).toContain("no longer in projects.json")
})

// ---------------------------------------------------------------------------
// 12c. Editing a project
// ---------------------------------------------------------------------------

// The other half of the same report: a project's Claude account could not be
// changed after registering it. Registering again is refused with a 409 whose
// message is the reason this has to be a **partial** update - `addProject`
// replaces a record wholesale, so a second trip through a three-field dialog
// would reset a budget or an allowlist tuned by hand. A PATCH that rebuilt the
// record through `defaults()` would reintroduce exactly that, so the case that
// matters most here is the one that tunes a field by hand, changes another, and
// looks for the first one afterwards.

const EDIT = "PATCH /api/projects"

function edit(l: Launch, body: unknown): Promise<{ status: number; headers: Headers; body: string }> {
  return call(l, { path: REGISTER_PATH, method: "PATCH", body: JSON.stringify(body) })
}

/** A store holding one record, written as a hand edit writes it: through the
 * store's own API, with fields no dialog offers already tuned. */
async function tunedStore(path: string): Promise<{ l: Launch; store: string; record: Project }> {
  const store = await storeFile()
  const record: Project = {
    ...defaults({ path, testCmd: "npm test" }),
    allowedTools: ["Read", "Edit", "Bash(npm test)"],
    planModel: "claude-opus-5-5-thinking",
    planEffort: "max",
    implementEffort: "xhigh",
    budgetUsd: 93.5,
    reportPath: "build/junit.xml",
  }
  await addProject(store, record)
  return { l: serve({ runsDir: await runsDir(), projectsFile: store }), store, record }
}

test("an edit is a PATCH registered in ROUTES, behind the guards, and not token-exempt", () => {
  expect(Object.keys(ROUTES)).toContain(EDIT)
  expect(TOKEN_EXEMPT.has(EDIT)).toBe(false)
  expect([...TOKEN_EXEMPT].sort()).toEqual(["GET /", "GET /api/session"])
})

test("an edit changes the field it names and leaves a hand-tuned record alone", async () => {
  const repo = await cleanRepo()
  const { l, store, record } = await tunedStore(repo)

  const res = await edit(l, { path: repo, testCmd: "flutter test" })
  expect(res.status).toBe(200)
  // The stored record comes back, so the caller never has to guess what the
  // merge did - `path` included, which is the identity every start request and
  // every run log keys on.
  expect(JSON.parse(res.body)).toEqual({ ok: true, project: { ...record, testCmd: "flutter test" } })
  // Read back through the store, because the invariant that matters is that
  // the tool's own write is a record the store will load again.
  expect(await loadProjects(store)).toEqual([{ ...record, testCmd: "flutter test" }])
})

test("the account can be changed after registering, which is what nothing could do", async () => {
  // The user's own words: there was no way to change a project's Claude
  // account once it was registered. `account` is what the human *called* it
  // and `configDir` is the profile the runs actually use, so both are here and
  // neither is derived from the other.
  const repo = await cleanRepo()
  const profile = await scratch("orch-profile-")
  const { l, store } = await tunedStore(repo)

  expect((await edit(l, { path: repo, account: "work", configDir: profile })).status).toBe(200)
  const stored = (await loadProjects(store))[0]
  expect(stored?.account).toBe("work")
  expect(stored?.configDir).toBe(profile)

  // And back to the default profile, which the store spells as an absent
  // `configDir` and reads a null as.
  expect((await edit(l, { path: repo, configDir: null })).status).toBe(200)
  const after = (await loadProjects(store))[0]
  expect(after?.configDir).toBeUndefined()
  expect(after?.account).toBe("work")
})

test("changing account alone moves the label and NOT the profile that bills", async () => {
  // The trap, pinned deliberately rather than fixed, because the fix would be
  // wrong in a way that is harder to see.
  //
  // `account` is a label - what the human *called* it - and `configDir` is the
  // only thing that controls anything: `src/spawn.ts`'s `phaseEnv` sets
  // `CLAUDE_CONFIG_DIR` from it and deletes it when there is none, and
  // `src/run.ts` keys the run header's `profile` on it. Nothing in `src/`
  // outside `accountOf()` reads `account` at all. So a client that switches
  // accounts by sending `{account}` alone relabels the chip and bills exactly
  // the same credentials as before - which is the defect the chip exists to
  // prevent, now spoken in the chip's own voice.
  //
  // The route deliberately does **not** refuse that, and this test is where
  // that decision is written down. Refusing `account` without `configDir` would
  // reject a real configuration: a user whose *default* profile is their work
  // account has `account: "work"` and no `configDir`, correctly. A rule the
  // store does not have would also put the route and a hand-edited
  // `projects.json` into disagreement about what is valid.
  //
  // So it stays the caller's job, and the thing that makes that safe is that
  // PATCH answers with the **whole stored record**: a client can see that
  // `configDir` did not move. A UI offering an account switcher must send both
  // keys in one call - which the test above proves it can.
  const repo = await cleanRepo()
  const profile = await scratch("orch-profile-")
  const { l, store } = await tunedStore(repo)
  await edit(l, { path: repo, account: "work", configDir: profile })

  const relabelled = await edit(l, { path: repo, account: "personal" })
  expect(relabelled.status).toBe(200)

  const stored = (await loadProjects(store))[0]
  expect(stored?.account).toBe("personal")
  // Unchanged, and the response says so, which is the only honest signal there
  // is: the runs still bill whatever `profile` holds.
  expect(stored?.configDir).toBe(profile)
  expect(JSON.parse(relabelled.body).project.configDir).toBe(profile)
})

test("an edit naming only the path writes nothing and answers the record", async () => {
  // Not a 400: a client cannot send a change this route silently drops - an
  // unknown key is a 400 - so the only way to name no change is to make none,
  // and answering the record is more useful than refusing. It must not write,
  // because this file is hand-edited and read in diffs.
  const repo = await cleanRepo()
  const { l, store, record } = await tunedStore(repo)
  const before = await readFile(store, "utf8")

  const res = await edit(l, { path: repo })
  expect(res.status).toBe(200)
  expect(JSON.parse(res.body)).toEqual({ ok: true, project: record })
  expect(await readFile(store, "utf8")).toBe(before)
})

test("each project route takes its own keys, not a shared superset", async () => {
  // `parseBody` refuses an unknown key by naming the keys *this route* takes,
  // so one shared list would let a DELETE accept `testCmd` and a registration
  // accept a budget it does not store. Three routes, three lists, proved
  // against each other.
  const repo = await cleanRepo()
  const fresh = await cleanRepo()
  const { l } = await tunedStore(repo)

  // Registration offers the dialog's three fields and no ceiling.
  const registered = await register(l, { path: fresh, testCmd: "npm test", budgetUsd: 10 })
  expect(registered.status).toBe(400)
  expect(registered.body).toContain("testCmd")
  expect(registered.body).not.toContain("budgetUsd")

  // An edit is where a ceiling is changed, because that is the field a second
  // trip through the dialog used to reset.
  expect((await edit(l, { path: repo, budgetUsd: 10 })).status).toBe(200)

  // A removal takes the path alone.
  const removal = await remove(l, { path: repo, budgetUsd: 10 })
  expect(removal.status).toBe(400)
  expect(removal.body).toContain("path")
  expect(removal.body).not.toContain("budgetUsd")
})

test("an edit cannot move a project to another path", async () => {
  // `path` is the identity, and the route's allowlist has no second key that
  // could name a new one: changing it is a remove plus an add, and the run
  // logs reference the old spelling either way.
  const repo = await cleanRepo()
  const { l, store, record } = await tunedStore(repo)

  const res = await edit(l, { path: repo, newPath: "/elsewhere" })
  expect(res.status).toBe(400)
  expect(res.body).toContain("path")
  expect(res.body).not.toContain("elsewhere")
  expect(await loadProjects(store)).toEqual([record])
})

test("an edit to a path that is not registered is a 404 and writes nothing", async () => {
  const repo = await cleanRepo()
  const { l, store, record } = await tunedStore(repo)
  const res = await edit(l, { path: join(repo, "nope"), testCmd: "x" })
  expect(res.status).toBe(404)
  expect(res.body).toContain(store)
  expect(await loadProjects(store)).toEqual([record])
})

test("a value the store will not hold is a 4xx with the store's own reason, not a 500", async () => {
  // The same rule registration follows: `src/projects.ts`'s prose names the
  // field someone has to fix, it is about a value the human typed into their
  // own dialog, and quoting it back is the whole diagnosis.
  const repo = await cleanRepo()
  const { l, store, record } = await tunedStore(repo)
  const rows: { body: unknown; names: string; why: string }[] = [
    { body: { path: repo, testCmd: "" }, names: "testCmd", why: 'an empty command runs as sh -c "" and exits 0, so every task would pass' },
    { body: { path: repo, testCmd: "  " }, names: "testCmd", why: "whitespace is the same mistake" },
    { body: { path: repo, configDir: "~/.claude-work" }, names: "configDir", why: "the CLI expands no tilde" },
    { body: { path: repo, account: "billing" }, names: "account", why: "two words or nothing: a third renders as neither chip colour" },
    { body: { path: repo, account: null }, names: "account", why: "the store has no second spelling for an unsaid account" },
    { body: { path: repo, budgetUsd: 0 }, names: "budgetUsd", why: "a ceiling that funds nothing" },
    { body: { path: repo, budgetUsd: "120" }, names: "budgetUsd", why: "the shape a text input produces" },
  ]

  for (const row of rows) {
    const res = await edit(l, row.body)
    expect(res.status, row.why).toBe(400)
    expect(res.body, row.why).toContain(row.names)
    expect(await loadProjects(store), row.why).toEqual([record])
  }
})

test("PATCH can clear a test command, which is how a repo opts into agent self-check", async () => {
  // `testCmd: null` is the user's 2026-10-12 decision made reachable over HTTP:
  // most repos have no suite, and until now the field was unclearable, so the
  // opt-in was inexpressible from the UI. Blank stays a 400 (the row above) -
  // the two spellings a cleared text field produces must not mean the same
  // thing, because one of them is an unfinished edit and `sh -c ""` exits 0.
  const repo = await cleanRepo()
  const { l, store } = await tunedStore(repo)

  const cleared = await edit(l, { path: repo, testCmd: null })
  expect(cleared.status).toBe(200)
  expect(JSON.parse(cleared.body).project.testCmd).toBeNull()
  expect((await loadProjects(store))[0]?.testCmd).toBeNull()

  // And back, so a repo that grows a suite is not stuck self-checking.
  const restored = await edit(l, { path: repo, testCmd: "bun test" })
  expect(restored.status).toBe(200)
  expect((await loadProjects(store))[0]?.testCmd).toBe("bun test")
})

test("a malformed edit body is refused before anything is written", async () => {
  const repo = await cleanRepo()
  const { l, store, record } = await tunedStore(repo)
  const rows: { body?: string; status: number; why: string }[] = [
    { status: 400, why: "no body names no project" },
    { body: "", status: 400, why: "nor does an empty one" },
    { body: "not json", status: 400, why: "the body must parse as JSON" },
    { body: "null", status: 400, why: "typeof null is object, which is the trap" },
    { body: "[]", status: 400, why: "an array is not a record" },
    { body: "{}", status: 400, why: "an object with no path names no project to edit" },
    { body: JSON.stringify({ path: "" }), status: 400, why: "an empty path names none either" },
    { body: JSON.stringify({ path: 7 }), status: 400, why: "a number is not a path" },
    { body: JSON.stringify({ path: "repo", testCmd: "x" }), status: 400, why: "a relative path would name a different record per launch directory" },
    { body: JSON.stringify({ path: repo, testcmd: "x" }), status: 400, why: "the near-miss spelling, refused by name rather than dropped" },
    /* `reportPath` has taken `allowedTools`' place in this row. The route
       offers `allowedTools` now - the store has always validated it and only
       the key list withheld it - while `reportPath` is still refused, and
       deliberately: nothing in `src/run.ts` reads it, so a control for it would
       store a value with no effect, which is worse than no control. */
    { body: JSON.stringify({ path: repo, reportPath: "docs/report.md" }), status: 400, why: "a field the store has but this route does not offer: a 400 naming what it takes, never a silent drop" },
    { body: JSON.stringify({ path: repo, planEffort: "sideways" }), status: 400, why: "an effort outside the five the store validates" },
    { body: JSON.stringify({ path: repo, permissionMode: "yolo" }), status: 400, why: "a permission mode the store does not know" },
    { body: JSON.stringify({ path: repo, planModel: "" }), status: 400, why: "a blank model would spawn the CLI with no model at all" },
    { body: JSON.stringify({ path: repo, testCmd: "npm test" }), status: 200, why: "the control: a well-formed edit" },
  ]

  for (const row of rows) {
    const res = await call(l, {
      path: REGISTER_PATH,
      method: "PATCH",
      ...(row.body === undefined ? {} : { body: row.body }),
    })
    expect(res.status, row.why).toBe(row.status)
    if (row.status >= 400) expect(await loadProjects(store), row.why).toEqual([record])
  }
})

test("a project whose repo has moved can still be edited, because the path is not changing", async () => {
  // No git here, deliberately, and the asymmetry with registration is the
  // point: `requireUsableRepo` decides whether a *new* path is a repository
  // kantan can run in, while an edit names a record that already exists. A
  // route that re-checked the repo would make a project whose checkout has
  // gone impossible to fix and impossible to point anywhere else.
  const gone = join(await scratch("orch-gone-"), "repo")
  const { l, store } = await tunedStore(gone)
  expect((await edit(l, { path: gone, testCmd: "flutter test" })).status).toBe(200)
  expect((await loadProjects(store))[0]?.testCmd).toBe("flutter test")
})

test("an edit is allowed while a run is in flight, unlike a removal", async () => {
  // The asymmetry is deliberate. A removal breaks the lookup every action on
  // that run makes, so it is refused; an edit cannot, because `path` is not
  // editable and a live run holds the record it started with - `held()`
  // returns the registered run and never re-reads the store for it. What a
  // live run would notice is a `configDir` change, and only once it is
  // rehydrated after a restart, where `--resume` would look for its session in
  // a different profile. That is a real cost, and the recovery is one PATCH
  // back; refusing every edit while any run of the project is unfinished would
  // block the common case - fixing a typo in `testCmd` while a plan sits at
  // the gate - for a case a liveness check cannot even see.
  const repo = await cleanRepo()
  const dir = await runsDir()
  const store = await storeFile()
  const live = "88888888-8888-4888-8888-888888888888"
  const l = serve({ runsDir: dir, projectsFile: store, liveRunIds: () => [live] })
  await addProject(store, defaults({ path: (await requireUsableRepo(repo)).root, testCmd: "npm test" }))
  await logNamingProject(dir, live, (await requireUsableRepo(repo)).root)

  expect((await edit(l, { path: repo, testCmd: "flutter test" })).status).toBe(200)
  // The same project, the same instant: a removal is refused.
  expect((await remove(l, { path: repo })).status).toBe(409)
})

test("a server launched without a project store answers 503 on an edit", async () => {
  const l = serve({ runsDir: await runsDir() })
  expect((await edit(l, { path: "/repo", testCmd: "x" })).status).toBe(503)
})

test("a damaged store is a 500 on an edit, forwarding the message that names the file", async () => {
  const store = await storeFile()
  await mkdir(dirname(store), { recursive: true })
  await writeFile(store, '[{ "path": "/repo", oops }]')
  const l = serve({ runsDir: await runsDir(), projectsFile: store })

  const res = await edit(l, { path: "/repo", testCmd: "npm test" })
  expect(res.status).toBe(500)
  expect(res.body).toContain(store)
})

// ---------------------------------------------------------------------------
// 13. The project tree
// ---------------------------------------------------------------------------

// Nothing served the tree, so `src/ui/App.tsx` rendered fixtures. HANDOFF's
// "the tree cannot address a single route" is the contract: `Tree.tsx` hands
// its caller a `TaskId` - the triple - and every `:id` route is keyed by run
// id, so a selection resolved to nothing the HTTP port would accept. The fix is
// not a `runId` on `TreeTaskRun`: the component is presentational, and
// `src/runindex.ts` already owns the task-to-run mapping and already exports
// the key function for it. So the mapping travels **beside** the tree, keyed by
// `taskKey`, and the shell joins them.
//
// `taskKey` separates with `NUL`, the one byte a path cannot contain, which
// survives JSON as `\u0000`. There is deliberately no second key format.
//
// The payload is `TreeProject[]` field for field as `src/ui/Tree.tsx` declares
// it, and the type is imported from there rather than restated: a type-only
// import is erased at runtime (verified - `bun build --target=bun` of
// `src/server.ts` pulls in no `jsx-runtime` and no `ui/Tree`), so the server
// never loads React, while a field renamed in the component becomes a compile
// error here instead of a row that quietly renders as something else.

const TREE = "GET /api/projects"

/** The tree body, loosely typed where it is about the wire and exactly typed
 * where it is about the component: `projects` is `TreeProject[]`, so a field
 * this route stops producing is a compile error in these tests. */
interface TreeBody {
  ok?: boolean
  projects?: TreeProject[]
  runs?: Record<string, { runId: string; costUsd: number; attempts: number }>
  warnings?: string[]
  /** What the user recorded, and what a scan suspects. Two keys, two claims. */
  accounts?: Array<{ kind: string; label: string; configDir: string }>
  foundAccounts?: string[]
  error?: string
}

async function getTree(l: Launch): Promise<{ status: number; body: TreeBody; raw: string; headers: Headers }> {
  const res = await call(l, { path: "/api/projects" })
  return { status: res.status, body: JSON.parse(res.body) as TreeBody, raw: res.body, headers: res.headers }
}

/** A launch over `store` and a runs directory of its own, with no machine: the
 * tree needs none, and leaving it out proves it. */
async function withTree(store: string, opts: Parameters<typeof createServer>[0] = {}): Promise<Launch> {
  return serve({ runsDir: await runsDir(), projectsFile: store, ...opts })
}

/** `withTree`, with a model that answers `reply`. */
async function withTreeAsking(
  store: string,
  reply: string,
): Promise<{ l: Launch; prompts: string[] }> {
  const prompts: string[] = []
  const l = await withTree(store, {
    ask: async (prompt: string) => {
      prompts.push(prompt)
      return reply
    },
  })
  return { l, prompts }
}

/** `repo` registered in a store of its own, through the store's own writer so
 * the records are ones `loadProjects` accepts. */
async function storeOf(...repos: string[]): Promise<string> {
  const store = await storeFile()
  for (const path of repos) await addProject(store, defaults({ path, testCmd: "bun test" }))
  return store
}

const FEATURE = `# Importer

- [ ] T1 Read the CSV
- [x] T2 Write the rows
- [ ] A line with no ref
`

/** `repo`, with `docs/features/<name>` written. */
async function withFeature(repo: string, name: string, markdown: string | Uint8Array): Promise<string> {
  await mkdir(join(repo, "docs", "features"), { recursive: true })
  const path = join(repo, "docs", "features", name)
  await writeFile(path, markdown)
  return path
}

/** A finished run of `taskRef` in `featureFile`, as a real log in `dir`. */
async function taskLog(
  dir: string,
  id: string,
  over: { projectPath: string; featureFile: string; taskRef: string; startedAt?: string },
  end: { state: "done" | "failed"; costUsd: number; verifiedBy?: "test-command" | "self-check" } | null = { state: "done", costUsd: 1.25 },
): Promise<void> {
  const log = await createRunLog(runLogPath(id, dir), header({ runId: id, ...over }))
  await log.append({ kind: "phase", phase: "implement", state: "running", sessionId: "33333333-3333-4333-8333-333333333333" })
  if (end !== null) {
    await log.append({
      kind: "end",
      state: end.state,
      costUsd: end.costUsd,
      ...(end.verifiedBy === undefined ? {} : { verifiedBy: end.verifiedBy }),
    })
  }
  await log.close()
}

test("a self-checked run reaches the tree saying so, instead of looking like a pass", async () => {
  // The last layer, and the one the UI actually reads. `verifiedBy` survives
  // the fold and `indexRuns`, both covered in test/runindex.test.ts - but
  // `treeTask` builds `TreeTask.run` itself, and a reconstruction there would
  // drop the field exactly as `indexRuns` did. It passes `state` whole; this is
  // what keeps it doing so.
  //
  // Absence is covered too: a log that never said must arrive with no
  // `verifiedBy` rather than a guessed `test-command`, because the tree's
  // `passed` label reads "judged by exit code 0".
  const repo = await cleanRepo()
  await withFeature(repo, "x.md", "- [ ] T1 Only task\n")
  const store = await storeOf(repo)
  const dir = await runsDir()
  const l = serve({ runsDir: dir, projectsFile: store })

  const task = { projectPath: repo, featureFile: "docs/features/x.md", taskRef: "T1" }
  await taskLog(dir, "cccccccc-3333-4333-8333-333333333333", task, {
    state: "done",
    costUsd: 1,
    verifiedBy: "self-check",
  })

  const { body } = await getTree(l)
  expect(body.projects?.[0]?.features?.[0]?.tasks?.[0]?.run).toEqual({
    state: { kind: "done", merged: false, verifiedBy: "self-check" },
    branch: taskBranchName({ feature: "docs/features/x.md", ref: "T1" }),
  })
})

test("a run whose log never said how it was verified reaches the tree saying nothing", async () => {
  const repo = await cleanRepo()
  await withFeature(repo, "x.md", "- [ ] T1 Only task\n")
  const store = await storeOf(repo)
  const dir = await runsDir()
  const l = serve({ runsDir: dir, projectsFile: store })

  await taskLog(dir, "dddddddd-4444-4444-8444-444444444444", {
    projectPath: repo,
    featureFile: "docs/features/x.md",
    taskRef: "T1",
  })

  const { body, raw } = await getTree(l)
  // No `verifiedBy` key at all - not `"test-command"`, which would be the
  // silent escalation: every log on disk before the field existed is this case.
  expect(body.projects?.[0]?.features?.[0]?.tasks?.[0]?.run?.state).toEqual({
    kind: "done",
    merged: false,
  })
  expect(raw).not.toContain("test-command")
})

test("the tree route is a GET registered in ROUTES, behind the guards, and not token-exempt", () => {
  // A GET, and it must stay side-effect-free: `SameSite=Strict` ignores ports,
  // so a page on any other localhost port can make this request with our
  // cookie. It cannot read the answer, but it must not be able to *cause*
  // anything - which is also why the raise beside it is a POST.
  expect(Object.keys(ROUTES)).toContain(TREE)
  expect(TOKEN_EXEMPT.has(TREE)).toBe(false)
  expect([...TOKEN_EXEMPT].sort()).toEqual(["GET /", "GET /api/session"])
})

test("a fresh install is an empty tree rather than a 404, and is never cached", async () => {
  // An absent store is what a fresh install is, and `loadProjects` reads it as
  // no projects. The design's empty state offers "Add a repository" for exactly
  // this answer, so a 404 here would be the UI's own bootstrap failing.
  const l = await withTree(await storeFile())
  const { status, body, headers } = await getTree(l)

  expect(status).toBe(200)
  /* `accounts` and `foundAccounts` are both empty here, and that they are
   * *listed* is the point: the exact-shape assertion is what caught this route
   * reading the real home directory, so it keeps asserting the whole body
   * rather than the keys this test happens to care about. */
  expect(body).toEqual({ ok: true, projects: [], runs: {}, warnings: [], accounts: [], foundAccounts: [] })
  // Nothing here is cached: a run moves between page loads, and a cached tree
  // would show the previous one's state.
  expect(headers.get("cache-control")).toBe("no-store")
})

test("a server launched without a store answers 503, not an empty tree", async () => {
  // The same answer registration gives, and for the same reason: `projectsFile`
  // has no default on purpose, so "no store" is a launch that cannot answer
  // rather than an install with no projects.
  const res = await call(serve({ runsDir: await runsDir() }), { path: "/api/projects" })
  expect(res.status).toBe(503)
  expect(JSON.parse(res.body).error).toContain("project store")
})

test("a registered repo comes back as a TreeProject, field for field, with its tasks", async () => {
  const repo = await cleanRepo()
  await withFeature(repo, "importer.md", FEATURE)
  const l = await withTree(await storeOf(repo))

  const { status, body } = await getTree(l)
  expect(status).toBe(200)
  // `toEqual` over the whole payload, not a field at a time: the point is that
  // the shell can hand this straight to the component, so an extra key is a
  // defect as much as a missing one. `line` from `parseFeature` must not be
  // here - it indexes a string the client does not have.
  expect(body.projects).toEqual([
    {
      path: repo,
      // `unknown` because this project states no `account`, and that is never
      // guessed: a silent default of "personal" is the exact failure the chip
      // exists to prevent (HANDOFF). The **label** is still a fact we hold -
      // which profile the runs use - and saying "default profile" beats
      // "account unknown" on every row of every project, which read like a bug.
      account: { kind: "unknown", label: "default profile" },
      testCmd: "bun test",
      // The stored ceiling, and `defaults()` fills it with 50. It is on the
      // wire because the panel hides its whole ceiling section without a
      // figure, which read from use as "nowhere to set a budget" - the field
      // had existed in the store since `projects.ts` was written, and only the
      // wire never carried it. `configDir` is absent here because this project
      // states none, and the key is omitted rather than sent as `null`.
      budgetUsd: 50,
      // The six that shape a run, hand-edit-only until the wire carried them.
      // One object, so a panel takes them or leaves them together: a half-read
      // set would draw a form with some fields blank, and "unset" is
      // indistinguishable from "this wire is older than this page" in a text
      // input while meaning the opposite.
      advanced: {
        planModel: "claude-opus-5-5",
        implementModel: "claude-sonnet-5-5",
        planEffort: "high",
        implementEffort: "medium",
        permissionMode: "acceptEdits",
        allowedTools: null,
      },
      features: [
        {
          path: "docs/features/importer.md",
          tasks: [
            { ref: "T1", text: "Read the CSV", done: false },
            { ref: "T2", text: "Write the rows", done: true },
            { ref: null, text: "A line with no ref", done: false },
          ],
        },
      ],
    },
  ])
  expect(body.runs).toEqual({})
  // The label says which profile the runs use, which is a fact; it never says
  // personal or work, which is a claim only the human can make. That boundary
  // is the whole point, so it is asserted rather than assumed.
  expect(body.projects?.[0]?.account?.label).toBe("default profile")
  expect(body.projects?.[0]?.account?.kind).toBe("unknown")
})

test("the feature path is the repo-relative string a run header records, which is what the join needs", async () => {
  // HANDOFF: `TreeFeature.path` must be the **exact** string the header carries
  // as `featureFile`, which `src/run.ts` makes relative to `project.path` **as
  // registered** rather than to git's resolved root. If the join misses, a
  // `done, unmerged` task reads as `open` and `canStart` returns true - a
  // silent re-run of finished work the tree cannot detect.
  const real = await cleanRepo()
  await withFeature(real, "x.md", "- [ ] T1 Only task\n")
  const link = join(await scratch("orch-link-"), "repo")
  await symlink(real, link)

  // Registered through the symlinked spelling, which is the case that breaks a
  // route that relative-ises against a realpath.
  const store = await storeFile()
  await addProject(store, defaults({ path: link, testCmd: "bun test" }))
  const l = await withTree(store)

  const { body } = await getTree(l)
  expect(body.projects?.[0]?.path).toBe(link)
  expect(body.projects?.[0]?.features?.[0]?.path).toBe("docs/features/x.md")
})

test("the newest run of a task joins it by taskKey, and the run ids travel beside the tree", async () => {
  const repo = await cleanRepo()
  await withFeature(repo, "x.md", "- [ ] T1 Only task\n")
  const store = await storeOf(repo)
  const dir = await runsDir()
  const l = serve({ runsDir: dir, projectsFile: store })

  const task = { projectPath: repo, featureFile: "docs/features/x.md", taskRef: "T1" }
  await taskLog(dir, "aaaaaaaa-1111-4111-8111-111111111111", { ...task, startedAt: "2026-10-10T09:00:00.000Z" }, {
    state: "failed",
    costUsd: 0.5,
  })
  await taskLog(dir, "bbbbbbbb-2222-4222-8222-222222222222", { ...task, startedAt: "2026-10-11T09:00:00.000Z" }, {
    state: "done",
    costUsd: 1.25,
  })

  const { body, raw } = await getTree(l)
  const only = body.projects?.[0]?.features?.[0]?.tasks?.[0]
  // `state` and `branch` are `TaskStatus`'s own fields, so a change there is a
  // compile error in `Tree.tsx` and a changed row here. `merged: false` is the
  // honest answer: no merge predicate is passed, for reasons in the comment on
  // the next test.
  expect(only?.run).toEqual({
    state: { kind: "done", merged: false },
    branch: taskBranchName({ feature: "docs/features/x.md", ref: "T1" }),
  })

  // The mapping, keyed by the function `runindex.ts` exports and nothing else.
  const key = taskKey(task)
  expect(body.runs?.[key]).toEqual({
    runId: "bbbbbbbb-2222-4222-8222-222222222222",
    // The newest run's cost, not the sum: a retry does not erase the attempt
    // before it, which is what `attempts` counts.
    costUsd: 1.25,
    attempts: 2,
  })
  // The NUL survives the wire as `\u0000`, which is the whole reason the key is
  // safe to put in a JSON object.
  expect(key).toContain("\u0000")
  expect(raw).toContain("\\u0000")
})

test("testAttempts and exitCode are absent keys, never zeros", async () => {
  // Both are optional on purpose. `runindex.ts` deliberately folds no `test`
  // record - an exit code does not move a run - so neither number is available
  // here, and design §"what must survive" requires exit codes printed and never
  // paraphrased, which also forbids inventing one. A zero would render as
  // "exited 0", which is a pass that was never observed.
  const repo = await cleanRepo()
  await withFeature(repo, "x.md", "- [ ] T1 Only task\n- [ ] T2 Never run\n")
  const dir = await runsDir()
  const l = serve({ runsDir: dir, projectsFile: await storeOf(repo) })
  await taskLog(dir, "cccccccc-3333-4333-8333-333333333333", {
    projectPath: repo,
    featureFile: "docs/features/x.md",
    taskRef: "T1",
  })

  const { body, raw } = await getTree(l)
  const [ran, never] = body.projects?.[0]?.features?.[0]?.tasks ?? []
  expect(ran?.run).toBeDefined()
  expect("testAttempts" in (ran?.run ?? {})).toBe(false)
  expect("exitCode" in (ran?.run ?? {})).toBe(false)
  expect(raw).not.toContain("testAttempts")
  expect(raw).not.toContain("exitCode")

  // And a task that never ran omits `run` entirely rather than carrying an
  // empty one: `taskStateOf` reads a missing `run` as open or passed, and an
  // empty object would make it read the checkbox's opposite.
  expect("run" in (never ?? {})).toBe(false)
})

test("a run the server knows is live reads as running; without that it reads as interrupted", async () => {
  // Liveness is not in the log and cannot be: a log with no `end` record is a
  // run that is going or a server that died, and only the process knows which.
  // `liveRunIds()` in `src/run.ts` is the other half of `indexRuns`, so the
  // launch passes it - otherwise every active run in the tree reads as
  // interrupted, and `running` is unreachable.
  const repo = await cleanRepo()
  await withFeature(repo, "x.md", "- [ ] T1 Only task\n")
  const store = await storeOf(repo)
  const dir = await runsDir()
  const id = "dddddddd-4444-4444-8444-444444444444"
  await taskLog(dir, id, { projectPath: repo, featureFile: "docs/features/x.md", taskRef: "T1" }, null)

  const live = serve({ runsDir: dir, projectsFile: store, liveRunIds: () => [id] })
  const dead = serve({ runsDir: dir, projectsFile: store })

  expect((await getTree(live)).body.projects?.[0]?.features?.[0]?.tasks?.[0]?.run?.state).toEqual({
    kind: "running",
    phase: "implement",
  })
  expect((await getTree(dead)).body.projects?.[0]?.features?.[0]?.tasks?.[0]?.run?.state).toEqual({
    kind: "interrupted",
    resumeFrom: "implement",
  })
})

// --- The feature files are read from disk, so this route has the plan's leak --

// The same exposure `GET /api/runs/:id/plan` has, and the same guard answers
// it: `stat` and `readFile` both follow symlinks, so a `docs/features/x.md`
// linked to `~/.ssh/id_rsa` - or a `docs/features` directory that is such a
// link - would be opened and parsed, and any line of it shaped like a task
// bullet would render in the tree. The agent kantan runs has shell access in
// that repo, so the link is one command away.
//
// `readFeature` is therefore **not** what reads these: it uses a plain
// `readFile`, with no containment check, no size cap and no `O_NOFOLLOW`. This
// route composes `parseFeature` with the same guarded read the plan uses.
//
// The dimension is the outcome of trying to read one candidate, and its values
// are enumerated below: a plain file, a link that stays inside the repo, a link
// out of it, a directory in the way, a FIFO, bytes that are not UTF-8, and a
// file past the cap. What a wrong guess costs is not symmetric. Rendering a
// file from outside the repo is a leak with no recovery, so that direction
// refuses. Dropping a file the user really has makes a real backlog invisible,
// which is the failure `listFeatureFiles` itself calls the worse one - so a
// file that cannot be read is **omitted and said out loud** in `warnings`,
// never listed with `tasks: []`, because an empty task list is exactly what a
// mid-draft feature looks like and the two must stay distinguishable.

test("a feature file linked inside the repo is read; one linked out of it is dropped and said out loud", async () => {
  const repo = await cleanRepo()
  const secret = join(await scratch("orch-secret-"), "id_rsa")
  await writeFile(secret, "-----BEGIN OPENSSH PRIVATE KEY-----\n- [ ] T9 leaked\n")

  await withFeature(repo, "plain.md", "- [ ] T1 Plain\n")
  await writeFile(join(repo, "docs", "shared.md"), "- [ ] T2 Linked inside\n")
  await symlink(join(repo, "docs", "shared.md"), join(repo, "docs", "features", "inside.md"))
  await symlink(secret, join(repo, "docs", "features", "outside.md"))

  const l = await withTree(await storeOf(repo))
  const { status, body, raw } = await getTree(l)

  expect(status).toBe(200)
  expect(body.projects?.[0]?.features?.map((f) => f.path)).toEqual([
    "docs/features/inside.md",
    "docs/features/plain.md",
  ])
  expect(body.projects?.[0]?.features?.[0]?.tasks).toEqual([{ ref: "T2", text: "Linked inside", done: false }])
  // Nothing of the secret anywhere in the body, by any route.
  expect(raw).not.toContain("PRIVATE KEY")
  expect(raw).not.toContain("leaked")
  // And the drop is visible rather than silent: a backlog that vanished with no
  // explanation is a bug report about the parser.
  expect(body.warnings?.join("\n")).toContain("docs/features/outside.md")
})

test("a docs/features directory that is itself a link out of the repo yields no features", async () => {
  // The other half of the same vector: every path under it resolves outside,
  // and the string checks on the names cannot see that.
  const repo = await cleanRepo()
  const elsewhere = await scratch("orch-elsewhere-")
  await writeFile(join(elsewhere, "notes.md"), "- [ ] T1 Private notes\n")
  await mkdir(join(repo, "docs"), { recursive: true })
  await symlink(elsewhere, join(repo, "docs", "features"))

  const { body, raw } = await getTree(await withTree(await storeOf(repo)))
  expect(body.projects?.[0]?.features).toEqual([])
  expect(raw).not.toContain("Private notes")
  expect(body.warnings?.join("\n")).toContain("docs/features/notes.md")
})

test("a feature file that is not UTF-8, is past the cap, or is a FIFO leaves the rest of the tree standing", async () => {
  // A FIFO is the row that matters most: a blocking read on one would hang
  // every page load, and this route is hit on each of them. A directory named
  // `x.md` is dropped before this route sees it, by `listFeatureFiles`.
  const repo = await cleanRepo()
  await withFeature(repo, "good.md", "- [ ] T1 Good\n")
  // A lone 0x80 is not valid UTF-8; decoding it lossily would put U+FFFD into
  // a task's text.
  await withFeature(repo, "latin1.md", Buffer.from([0x2d, 0x20, 0x5b, 0x20, 0x5d, 0x20, 0x54, 0x31, 0x20, 0x80]))
  await withFeature(repo, "huge.md", `- [ ] T1 ${"x".repeat(1024 * 1024)}\n`)
  await mkdir(join(repo, "docs", "features", "a-directory.md"), { recursive: true })
  const fifo = Bun.spawn(["mkfifo", join(repo, "docs", "features", "pipe.md")])
  expect(await fifo.exited).toBe(0)

  const { status, body } = await getTree(await withTree(await storeOf(repo)))
  expect(status).toBe(200)
  expect(body.projects?.[0]?.features).toEqual([
    { path: "docs/features/good.md", tasks: [{ ref: "T1", text: "Good", done: false }] },
  ])
  const said = body.warnings?.join("\n") ?? ""
  expect(said).toContain("docs/features/latin1.md")
  expect(said).toContain("docs/features/huge.md")
}, 15_000)

test("one unusable project does not blank the tree", async () => {
  // The store is a file people hand-edit, and `projects.json` validates only
  // that `path` is an absolute string - so a project can name a directory that
  // has been deleted, or a plain file. `listFeatureFiles` throws on anything
  // but ENOENT, and one throw would otherwise be a 500 for every project at
  // once.
  const good = await cleanRepo()
  await withFeature(good, "x.md", "- [ ] T1 Good\n")
  const gone = await scratch("orch-gone-")
  const notADir = join(await scratch("orch-file-"), "a-file")
  await writeFile(notADir, "not a repo\n")
  const store = await storeFile()
  for (const path of [gone, notADir, good]) await addProject(store, defaults({ path, testCmd: "bun test" }))
  await rm(gone, { recursive: true, force: true })

  const { status, body } = await getTree(await withTree(store))
  expect(status).toBe(200)
  expect(body.projects?.map((p) => p.path)).toEqual([gone, notADir, good])
  expect(body.projects?.[0]?.features).toEqual([])
  expect(body.projects?.[1]?.features).toEqual([])
  expect(body.projects?.[2]?.features).toEqual([
    { path: "docs/features/x.md", tasks: [{ ref: "T1", text: "Good", done: false }] },
  ])
})

test("a damaged projects.json is a 500 that forwards its reason, not an empty tree", async () => {
  // The same answer registration gives it, and the one 5xx that forwards its
  // message: the store is the only state no repository can rebuild, it names
  // the file, the record and the field, and an editor fixes what a message
  // points at. An empty tree would read as a fresh install and invite the user
  // to register everything again.
  const store = await storeFile()
  await writeFile(store, '[{"path":"/repo","testCmd":"bun test","nonsense":1}]')
  const res = await call(await withTree(store), { path: "/api/projects" })
  expect(res.status).toBe(500)
  expect(JSON.parse(res.body).error).toContain("nonsense")
})

test("a log whose header names an absolute feature path is listed without a branch, not dropped", async () => {
  // `taskBranchName` throws on an absolute feature path, and a header can carry
  // one: `TaskStatus.branch` is then `""`, meaning the task was **not** checked
  // for a merge. `indexRuns` keeps the row rather than dropping it, because a
  // dropped row looks like a task that was never run - which is how a second
  // run gets started against work already written. The route forwards it the
  // same way, and says so.
  const repo = await cleanRepo()
  await withFeature(repo, "x.md", "- [ ] T1 Only task\n")
  const dir = await runsDir()
  const l = serve({ runsDir: dir, projectsFile: await storeOf(repo) })
  await taskLog(dir, "eeeeeeee-5555-4555-8555-555555555555", {
    projectPath: repo,
    featureFile: join(repo, "docs", "features", "x.md"),
    taskRef: "T1",
  })

  const { status, body } = await getTree(l)
  expect(status).toBe(200)
  // The row is in the mapping, under the key its own header spells, and joins
  // no tree task - the tree's paths are repo-relative, as the header's should
  // have been.
  expect(
    body.runs?.[taskKey({ projectPath: repo, featureFile: join(repo, "docs", "features", "x.md"), taskRef: "T1" })],
  ).toEqual({ runId: "eeeeeeee-5555-4555-8555-555555555555", costUsd: 1.25, attempts: 1 })
  expect("run" in (body.projects?.[0]?.features?.[0]?.tasks?.[0] ?? {})).toBe(false)
  expect(body.warnings?.join("\n")).toContain("no usable branch name")
})

test("reading the tree changes nothing on disk, because a local page can make this request", async () => {
  // HANDOFF: `GET` must have no side effects. A page on any other localhost
  // port is same-site, so its no-cors GETs carry our cookie and send no
  // `Origin`; this request is one of those, and it must still be inert.
  const repo = await cleanRepo()
  const path = await withFeature(repo, "x.md", FEATURE)
  // Committed, so the tree starts clean and the check below is about this
  // request rather than about the fixture: an untracked `docs/` is itself dirt.
  await gitIn(repo, "add", "docs")
  await gitIn(repo, "commit", "-m", "backlog")
  const before = await readFile(path)
  const dir = await runsDir()
  const l = serve({ runsDir: dir, projectsFile: await storeOf(repo) })

  const res = await call(l, { path: "/api/projects", origin: null })
  expect(res.status).toBe(200)

  expect(await readFile(path)).toEqual(before)
  expect(await readdir(dir)).toEqual([])
  // No branch was created either: the tree asks git nothing, which is also why
  // no merge predicate is passed. `isMerged` costs about 5ms a row awaited one
  // at a time - 2733ms over 500 logs, measured (HANDOFF) - and there is no base
  // branch to ask about: `isMergedIntoBase` needs one, and nothing in `git.ts`
  // or `run.ts` resolves a project's base outside a run. So every finished task
  // reads `done-unmerged`, which `Tree.tsx` treats as a calm end state and
  // which keeps `canStart` false: the recoverable direction.
  await requireCleanTreeForNewRun(await requireUsableRepo(repo))
})

// ---------------------------------------------------------------------------
// 14. Raising a run's ceiling
// ---------------------------------------------------------------------------

// `createRunner` has exposed `raise(runId, budgetUsd)` since Task 14 and nothing
// served it, so an exhausted run was unreachable over HTTP: feedback and an
// answer are both refused for want of funds *before* the text is taken, approve
// re-parks, and stop only ends it. The raise is the one action that moves it.
//
// It is also the only action whose argument is a number, so it owns a 400 no
// other route has. The dimension is the value of `budgetUsd` **as JSON delivers
// it**, and the matrix below enumerates it rather than sampling: absent, null,
// a numeric string, a boolean, an array, an object, `NaN` (which is not JSON at
// all, and which `JSON.stringify` turns into `null`), both infinities (which
// arrive as `1e999`), negative zero, zero and a negative figure. The CLI
// rejects a non-positive `--max-budget-usd` (probed, 2026-10-11), so a figure
// let through here fails at the spawn, where the UI cannot attribute the
// failure to the input that caused it.
//
// What the route deliberately does **not** check is whether the figure is a
// raise. `requireRaise` in `src/run.ts` demands a finite figure above **both**
// the current ceiling and the spend, and neither is known here - the ceiling
// lives in the run's own log after a raise, not in `projects.json`. So "not
// above the ceiling" is the machine's `wrong-state`, which is a 409 carrying
// its prose, and the route's 400 is only for a figure that could never fund
// anything.

const RAISE_PATH = "/api/runs/abc/raise"

test("a raise carries the figure to the machine and answers 200", async () => {
  // The whole new ceiling, not a delta: `raiseBudget` writes
  // `{"kind":"human","action":"raise","budgetUsd":<figure>}` and `foldForResume`
  // takes the last usable one, so a delta would have to be folded against a
  // ceiling the caller cannot see.
  const { l, fake } = await withRunner()
  const res = await post(l, RAISE_PATH, JSON.stringify({ budgetUsd: 12.5 }))

  expect(res.status).toBe(200)
  expect(JSON.parse(res.body)).toEqual({ ok: true })
  expect(fake.calls).toEqual([{ name: "raise", runId: "abc", budgetUsd: 12.5 }])
})

test("a figure that is not above the ceiling and the spend is the machine's 409, not the route's 400", async () => {
  // The semantics `Runner.raise` actually has, read rather than guessed from
  // the name: a figure at or under either one is refused as `wrong-state`,
  // because it would lower the ceiling or stop the run again on arrival. The
  // message is what a human is left with, so it travels.
  const { l, fake } = await withRunner({
    async raise() {
      return {
        ok: false,
        refusal: "wrong-state",
        message:
          "$1 is not a usable ceiling for run abc: it has a $50.00 ceiling and has spent $49.9980, so a raise has to be a finite figure above both - anything else either lowers the ceiling or stops the run again on arrival.",
      }
    },
  })
  const res = await post(l, RAISE_PATH, JSON.stringify({ budgetUsd: 1 }))

  expect(res.status).toBe(409)
  const body = JSON.parse(res.body) as { error: string; refusal: string }
  expect(body.refusal).toBe("wrong-state")
  expect(body.error).toContain("above both")
  // It reached the machine: the route does not second-guess the ceiling.
  expect(fake.calls).toEqual([{ name: "raise", runId: "abc", budgetUsd: 1 }])
})

/** Every value `budgetUsd` can arrive as, with the status it earns. `body` is
 * the raw bytes on purpose: `JSON.stringify` cannot express `NaN`, `Infinity`
 * or `-0`, which are three of the rows that matter. */
interface RaiseRow {
  body?: string
  status: number
  why: string
}

const raiseRows: RaiseRow[] = [
  // The figures that fund something.
  { body: '{"budgetUsd":75}', status: 200, why: "a whole number of dollars" },
  { body: '{"budgetUsd":12.5}', status: 200, why: "and a fractional one" },
  { body: '{"budgetUsd":0.0001}', status: 200, why: "a tiny but positive figure is the machine's call, not the route's" },
  { body: '{"budgetUsd":1e308}', status: 200, why: "no upper bound: an arbitrary cap is a cap nobody asked for, and the human typed this" },

  // No figure at all. An absent body and an empty one are indistinguishable on
  // the wire (probed: Bun declares Content-Length: 0 for both).
  { status: 400, why: "a raise with no figure raises nothing" },
  { body: "", status: 400, why: "an empty body carries no figure" },
  { body: "{}", status: 400, why: "nor does an object with no keys" },
  { body: " \n ", status: 400, why: "nor whitespace, which reads as an absent body" },

  // Not JSON, or JSON that is not a record.
  { body: "not json", status: 400, why: "the body must parse as JSON" },
  { body: '{"budgetUsd":NaN}', status: 400, why: "the literal NaN is not JSON at all, so this never reaches the figure check" },
  { body: "null", status: 400, why: "typeof null is object, which is the trap this row pins" },
  { body: "[]", status: 400, why: "an array is not a record" },
  { body: "75", status: 400, why: "nor is a bare number the body" },

  // Present, and not a number.
  { body: '{"budgetUsd":null}', status: 400, why: "what JSON.stringify({budgetUsd: NaN}) actually sends" },
  { body: '{"budgetUsd":"75"}', status: 400, why: "a numeric string is the shape a text input produces, and is not a number" },
  { body: '{"budgetUsd":""}', status: 400, why: "nor is an empty string, which Number() would read as zero" },
  { body: '{"budgetUsd":true}', status: 400, why: "a boolean is not a figure" },
  { body: '{"budgetUsd":[75]}', status: 400, why: "nor an array holding one" },
  { body: '{"budgetUsd":{}}', status: 400, why: "nor an object" },

  // A number, and not one that can fund a turn.
  { body: '{"budgetUsd":1e999}', status: 400, why: "how Infinity actually arrives, since JSON has no literal for it" },
  { body: '{"budgetUsd":-1e999}', status: 400, why: "and -Infinity" },
  { body: '{"budgetUsd":0}', status: 400, why: "a zero ceiling funds nothing and the CLI refuses it" },
  { body: '{"budgetUsd":-0}', status: 400, why: "negative zero parses, and is still not above zero" },
  { body: '{"budgetUsd":-123.456}', status: 400, why: "a negative ceiling is not a ceiling" },

  // Keys, with the same strictness every other action has.
  { body: '{"budgetUsd":75,"extra":1}', status: 400, why: "an unknown key is the caller's typo, and a dropped setting is how one hides" },
  { body: '{"budgetusd":75}', status: 400, why: "the near-miss spelling, which is the case the strictness exists for" },
  { body: '{"budget":75}', status: 400, why: "nor a plausible shorter name" },
  { body: '{"text":"raise it"}', status: 400, why: "and a raise is not feedback" },
]

for (const row of raiseRows) {
  const label = row.body === undefined ? "no body" : row.body
  test(`POST ${RAISE_PATH} with ${label} -> ${row.status} (${row.why})`, async () => {
    const { l, fake, dir } = await withRunner()
    const res = await call(l, { path: RAISE_PATH, method: "POST", ...(row.body === undefined ? {} : { body: row.body }) })

    expect(res.status).toBe(row.status)
    if (row.status === 200) {
      expect(fake.calls.map((c) => c.name)).toEqual(["raise"])
    } else {
      // A refused figure must not reach the machine: the machine is what spends
      // money, and a ceiling it cannot use would stop the run on arrival.
      expect(fake.calls).toEqual([])
      expect(JSON.parse(res.body).error).toContain("budgetUsd")
    }
    // No action writes to the runs directory: the machine is the only writer of
    // a run log.
    expect(await readdir(dir)).toEqual([])
  })
}

test("the 400 names the problem without echoing the figure back", async () => {
  // `refuse` quotes nothing the caller chose. The figure is the caller's text
  // as far as this route is concerned, and the two messages have to be
  // different: "that is not a number" and "that number cannot fund a turn" are
  // different mistakes with different fixes.
  const { l } = await withRunner()
  const notANumber = await post(l, RAISE_PATH, JSON.stringify({ budgetUsd: "99999" }))
  const notPositive = await post(l, RAISE_PATH, "{\"budgetUsd\":-123.456}")

  expect(notANumber.status).toBe(400)
  expect(notPositive.status).toBe(400)
  expect(notANumber.body).not.toContain("99999")
  expect(notPositive.body).not.toContain("123.456")
  expect(JSON.parse(notANumber.body).error).not.toBe(JSON.parse(notPositive.body).error)
  // And each says which way it is wrong.
  expect(JSON.parse(notANumber.body).error).toContain("number")
  expect(JSON.parse(notPositive.body).error).toContain("above zero")
})

test("a raise on a server with no machine is a 503, not a 500", async () => {
  const noMachine = serve({ runsDir: await runsDir() })
  const res = await post(noMachine, RAISE_PATH, JSON.stringify({ budgetUsd: 75 }))
  expect(res.status).toBe(503)
})

// ---------------------------------------------------------------------------
// 15. The launch itself: `bun run src/server.ts`
// ---------------------------------------------------------------------------

// Everything above injects its dependencies, which is what makes the tests
// honest about the seam and blind to the one line nobody tests: what
// `import.meta.main` actually constructs. For three tasks that line built a
// server with **no** phase machine, so every action answered 503 and the tool
// could not start a run at all - and no test could see it, because every test
// passes its own runner in.
//
// So this section runs the real entry point in a real process, against a HOME
// of its own, and drives it over HTTP.

/** A free port, released immediately. The window between this and the server's
 * own bind is the price of `KANTAN_PORT` refusing 0 - which it should, since a
 * port nobody can predict is no use to a person opening a browser. */
async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe") })
  const port = probe.port
  probe.stop(true)
  if (port === undefined) throw new Error("the probe server bound no TCP port")
  return port
}

/**
 * The one guarantee the rename had to come with, asserted through the **real
 * entry point** rather than against `stateDirIn`.
 *
 * `test/statedir.test.ts` covers the four states of the dimension as a unit.
 * This covers the thing that unit cannot: that the entry point, the project
 * store and the phase machine all land on the same answer. They each default
 * on their own, and the failure if they disagree is a server that registers a
 * project into one directory while the machine looks in another - a 201
 * followed by `unknown-project` on every start, which is what the sibling test
 * below exists to catch for the fresh case.
 *
 * `projects.json` is the only state in this system that no repository and no
 * log can rebuild, so reading the wrong directory is the one failure here that
 * is not recoverable.
 */
test("a pre-rename install keeps its projects, read from ~/.orch by the real entry point", async () => {
  const home = await scratch("kantan-legacy-home-")
  const repo = await cleanRepo()

  /* The state of anyone who used kantan before today: a populated `.orch` and
     no `.kantan` at all. Written with the store's own writer, so this fixture
     cannot drift from the format the server reads. */
  const legacy = join(home, ".orch")
  await mkdir(legacy, { recursive: true })
  await addProject(join(legacy, "projects.json"), defaults({ path: repo, testCmd: "true" }))

  const port = await freePort()
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  env["HOME"] = home
  env["KANTAN_PORT"] = String(port)
  env["KANTAN_CLAUDE_BIN"] = join(import.meta.dir, "fake-claude.ts")
  delete env["KANTAN_DEV"]
  delete env["ORCH_DEV"]
  delete env["CLAUDE_CONFIG_DIR"]

  const server = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "src", "server.ts")], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    const reader = server.stdout.getReader()
    const decoder = new TextDecoder()
    let greeting = ""
    while (!greeting.includes(`127.0.0.1:${port}`)) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error(`the server exited before greeting: ${JSON.stringify(greeting)}`)
      greeting += decoder.decode(chunk.value, { stream: true })
    }
    void (async () => {
      for (;;) if ((await reader.read()).done) return
    })().catch(() => {})

    /* Said out loud. A fallback nobody can see is indistinguishable from a
       tool that lost their projects, so the greeting names the directory it
       chose and how to move it. */
    expect(greeting).toContain(legacy)

    const bootstrap = await fetch(`http://127.0.0.1:${port}/`, { headers: { Host: `127.0.0.1:${port}` } })
    await bootstrap.arrayBuffer()
    const token = /kantan_token=([^;]+)/.exec(bootstrap.headers.get("set-cookie") ?? "")?.[1]
    if (token === undefined) throw new Error("no token cookie")

    const tree = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      headers: { Host: `127.0.0.1:${port}`, Cookie: `kantan_token=${token}` },
    })
    const body = (await tree.json()) as { projects?: Array<{ path: string }> }

    // The project written before the rename, still there. Not an empty tree,
    // which is what pointing at a fresh `~/.kantan` would have answered - and
    // the next write would have made that permanent.
    expect(body.projects?.map((p) => p.path)).toEqual([repo])

    /* And kantan created no `.kantan` beside it: a fallback, not a migration.
     * Asserted on that one name rather than on the whole home directory,
     * because the spawned `bun` makes a `~/.bun` of its own - so a
     * whole-directory assertion would be about Bun's behaviour, not ours. */
    expect(await readdir(home)).not.toContain(".kantan")
    expect(await readdir(home)).toContain(".orch")
  } finally {
    server.kill()
    await server.exited
  }
}, 20_000)

test("the real entry point builds a server that can register a project and start a run", async () => {
  const home = await scratch("orch-home-")
  const repo = await cleanRepo()
  await mkdir(join(repo, "docs", "features"), { recursive: true })
  await writeFile(join(repo, "docs", "features", "x.md"), "# Importer\n\n- [ ] T1 Parse the manifest\n")
  await gitIn(repo, "add", "-A")
  await gitIn(repo, "commit", "-m", "feature file")

  const port = await freePort()
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  env["HOME"] = home
  env["KANTAN_PORT"] = String(port)
  // The double, so no real `claude` is spawned and no money is spent. Its
  // shebang needs `bun` on PATH, which the inherited PATH has.
  env["KANTAN_CLAUDE_BIN"] = join(import.meta.dir, "fake-claude.ts")
  // Both deleted rather than left: a developer's shell or a leaked value would
  // otherwise decide whether this test runs in dev mode or against their own
  // CLI profile, and it would pass for the wrong reason on one machine.
  delete env["KANTAN_DEV"]
  delete env["CLAUDE_CONFIG_DIR"]

  const server = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "src", "server.ts")], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  // Drained from the start, so a chatty phase cannot fill the pipe and wedge
  // the server we are talking to. Resolves when the process ends.
  const stderr = new Response(server.stderr).text()
  try {
    // Read incrementally: the greeting is one line and the process then keeps
    // serving, so a read to EOF would only resolve once the server was dead.
    const decoder = new TextDecoder()
    const reader = server.stdout.getReader()
    let greeting = ""
    const deadline = Date.now() + 15_000
    while (!greeting.includes(`http://127.0.0.1:${port}`)) {
      const left = deadline - Date.now()
      if (left <= 0) throw new Error(`the server never greeted; it said ${JSON.stringify(greeting)}`)
      // Each read is raced against what is left of the deadline, rather than
      // the deadline being checked between reads: a server that hung before
      // greeting would block in `read()` with no deadline in reach, and the
      // kill in `finally` would never run.
      let timer: ReturnType<typeof setTimeout> | undefined
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`the server never greeted; it said ${JSON.stringify(greeting)}`)), left)
        }),
      ]).finally(() => clearTimeout(timer))
      if (chunk.done) {
        throw new Error(`the server exited before greeting: ${JSON.stringify(greeting)} / ${await stderr}`)
      }
      greeting += decoder.decode(chunk.value, { stream: true })
    }
    // Kept draining afterwards, for the reason stderr is: anything the entry
    // point or a phase writes past the greeting would otherwise fill the pipe
    // and wedge the server this test is talking to.
    void (async () => {
      for (;;) if ((await reader.read()).done) return
    })().catch(() => {})

    // The cookie comes from the page load, as a browser's would.
    const bootstrap = await fetch(`http://127.0.0.1:${port}/`, { headers: { Host: `127.0.0.1:${port}` } })
    await bootstrap.arrayBuffer()
    const setCookie = bootstrap.headers.get("set-cookie") ?? ""
    const token = /kantan_token=([^;]+)/.exec(setCookie)?.[1]
    if (token === undefined) throw new Error(`no token cookie in ${JSON.stringify(setCookie)}`)

    const live = (path: string, body: unknown): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: {
          Host: `127.0.0.1:${port}`,
          Origin: `http://127.0.0.1:${port}`,
          Cookie: `kantan_token=${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      })

    // 1. Nothing is registered yet, so the machine - not a 503 - answers. This
    // is the whole of gap 1: before the wiring this was a 503 on every action.
    const unknown = await live("/api/runs", { projectPath: repo, featureFile: "docs/features/x.md", taskRef: "T1" })
    const unknownBody = (await unknown.json()) as { refusal?: string }
    expect(unknown.status).toBe(404)
    expect(unknownBody.refusal).toBe("unknown-project")

    // 2. Register it, through the route this task added.
    const added = await live("/api/projects", { path: repo, testCmd: "true" })
    expect(added.status).toBe(201)
    // Written where the entry point said, which is also where the machine looks.
    expect(await loadProjects(join(home, ".kantan", "projects.json"))).toHaveLength(1)

    // 3. And now a run starts: a 201 with a run id, and a log under the same
    // HOME. The phase itself fails behind us - the double is scriptless - which
    // is beside the point: the transition is what an action resolves at.
    const started = await live("/api/runs", { projectPath: repo, featureFile: "docs/features/x.md", taskRef: "T1" })
    const startedBody = (await started.json()) as { ok?: boolean; runId?: string }
    expect(started.status).toBe(201)
    expect(startedBody.runId).toBeTypeOf("string")
    const log = join(home, ".kantan", "runs", `${startedBody.runId}.jsonl`)
    await until(
      async () =>
        (await readdir(join(home, ".kantan", "runs")).catch((): string[] => [])).includes(`${startedBody.runId}.jsonl`),
      "the run log the machine opened under this HOME",
    )

    // Waited out rather than killed mid-phase: the double is scriptless, so it
    // exits 2 and the run fails, and the `end` record is how the machine says
    // it has let go of the lock and the repo. Killing while a `git` of its own
    // was still running would leave one writing into a directory `afterAll` is
    // about to `rm -rf`, which is the flake CLAUDE.md's history is full of.
    await until(
      async () => (await readFile(log, "utf8").catch(() => "")).includes('"kind":"end"'),
      "the run to end, which the scriptless double makes it do",
      20_000,
    )
    const records = (await readFile(log, "utf8"))
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as RunRecord)
    const end = records.find((r) => r.kind === "end")
    // Asserted rather than assumed: this is what the double actually produces,
    // and a `done` here would mean the fake had somehow satisfied a phase.
    expect(end).toMatchObject({ kind: "end", state: "failed" })
    expect(records[0]).toMatchObject({ kind: "header", projectPath: repo, taskRef: "T1" })
  } finally {
    server.kill()
    await server.exited
  }
}, 30_000)

/* ========================================================================== */
/* DELETE /api/features/task                                                  */
/* ========================================================================== */

const REMOVE_TASK = "DELETE /api/features/task"

function removeTask(
  l: Launch,
  body: unknown,
): Promise<{ status: number; headers: Headers; body: string }> {
  return call(l, { path: "/api/features/task", method: "DELETE", body: JSON.stringify(body) })
}

test("removing a task is a DELETE in ROUTES, behind the guards, and not token-exempt", () => {
  expect(Object.keys(ROUTES)).toContain(REMOVE_TASK)
  expect(TOKEN_EXEMPT.has(REMOVE_TASK)).toBe(false)
})

test("it takes the task out of the file and says what it removed", async () => {
  const repo = await cleanRepo()
  await withFeature(repo, "importer.md", FEATURE)
  const l = await withTree(await storeOf(repo))

  const res = await removeTask(l, {
    projectPath: repo,
    featureFile: "docs/features/importer.md",
    taskRef: "T1",
  })

  expect(res.status).toBe(200)
  const body = JSON.parse(res.body) as { removed: string; taskRef: string; featureFile: string }
  expect(body.removed).toBe("Read the CSV")
  expect(body.taskRef).toBe("T1")
  expect(body.featureFile).toBe("docs/features/importer.md")

  const after = await readFile(join(repo, "docs", "features", "importer.md"), "utf8")
  expect(after).not.toContain("Read the CSV")
  // Every other line, including the done task and the one with no ref.
  expect(after).toBe("# Importer\n\n- [x] T2 Write the rows\n- [ ] A line with no ref\n")
})

test("the tree stops listing it, which is the point of the route", async () => {
  const repo = await cleanRepo()
  await withFeature(repo, "importer.md", FEATURE)
  const l = await withTree(await storeOf(repo))

  await removeTask(l, { projectPath: repo, featureFile: "docs/features/importer.md", taskRef: "T1" })

  const { body } = await getTree(l)
  const tasks = body.projects?.[0]?.features[0]?.tasks ?? []
  expect(tasks.map((t) => t.ref)).toEqual(["T2", null])
})

test("it commits the change, because kantan wrote into someone's repository", async () => {
  const repo = await cleanRepo()
  await withFeature(repo, "importer.md", FEATURE)
  // Tracked first: an untracked file has no diff to commit, and the realistic
  // case is a backlog the user already has in git.
  await gitIn(repo, "add", "docs/features/importer.md")
  await gitIn(repo, "commit", "-m", "add the backlog", "--", "docs/features/importer.md")
  const l = await withTree(await storeOf(repo))

  const res = await removeTask(l, {
    projectPath: repo,
    featureFile: "docs/features/importer.md",
    taskRef: "T1",
  })
  expect(res.status).toBe(200)
  expect(JSON.parse(res.body)).not.toHaveProperty("warnings")

  expect(await gitSays(repo, "log", "-1", "--pretty=%s")).toBe("chore: remove T1 from docs/features/importer.md")
  expect(await gitSays(repo, "status", "--porcelain")).toBe("")
})

/**
 * The guard that has to run before any bytes move, and the reason it is a 409
 * where `POST /api/features` answers a warning.
 *
 * A draft that cannot be committed still exists - the caller got what they
 * asked for, untracked. A removal that cannot be committed has already changed
 * a file the user can see, on a checkout sitting on the run's own `kantan/<task>`
 * branch, and `returnToBase` would then bring the task back after the UI said
 * it was gone. The assertion that matters here is the second one: the file is
 * untouched.
 */
test("a run in flight in the repo refuses, and nothing is written", async () => {
  const repo = await cleanRepo()
  const path = await withFeature(repo, "importer.md", FEATURE)
  const before = await readFile(path, "utf8")
  const dir = await runsDir()
  const store = await storeFile()
  const live = "33333333-3333-4333-8333-333333333333"
  const l = serve({ runsDir: dir, projectsFile: store, liveRunIds: () => [live] })
  await logNamingProject(dir, live, (await requireUsableRepo(repo)).root)
  await register(l, { path: repo, testCmd: "npm test" })

  const res = await removeTask(l, {
    projectPath: repo,
    featureFile: "docs/features/importer.md",
    taskRef: "T1",
  })

  expect(res.status).toBe(409)
  expect(res.body).toContain(live)
  expect(await readFile(path, "utf8")).toBe(before)
})

test("a run in flight in a *different* repo does not refuse", async () => {
  const mine = await cleanRepo()
  const other = await cleanRepo()
  await withFeature(mine, "importer.md", FEATURE)
  const dir = await runsDir()
  const store = await storeFile()
  const live = "44444444-4444-4444-8444-444444444444"
  const l = serve({ runsDir: dir, projectsFile: store, liveRunIds: () => [live] })
  await logNamingProject(dir, live, (await requireUsableRepo(other)).root)
  await register(l, { path: mine, testCmd: "npm test" })

  const res = await removeTask(l, {
    projectPath: mine,
    featureFile: "docs/features/importer.md",
    taskRef: "T1",
  })
  expect(res.status).toBe(200)
})

/**
 * The task file is a path the *client* supplies, which makes it the one input
 * on this route a traversal could ride in on. Every spelling is refused before
 * anything is read, and the matrix is the enumeration rather than one example.
 */
test("a task file outside the project is refused, every way of spelling it", async () => {
  const repo = await cleanRepo()
  await withFeature(repo, "importer.md", FEATURE)
  const l = await withTree(await storeOf(repo))

  for (const featureFile of [
    "../outside.md",
    "docs/../../outside.md",
    "docs\\..\\..\\outside.md",
    "/etc/passwd",
    "docs/features/importer.md\u0000.png",
    "",
  ]) {
    const res = await removeTask(l, { projectPath: repo, featureFile, taskRef: "T1" })
    expect([400, 404], `for ${JSON.stringify(featureFile)}`).toContain(res.status)
    // Whatever the status, the real file is still whole.
    expect(await readFile(join(repo, "docs", "features", "importer.md"), "utf8")).toContain("Read the CSV")
  }
})

test("an unregistered project is a 404, not a write", async () => {
  const repo = await cleanRepo()
  await withFeature(repo, "importer.md", FEATURE)
  const l = await withTree(await storeFile())

  const res = await removeTask(l, {
    projectPath: repo,
    featureFile: "docs/features/importer.md",
    taskRef: "T1",
  })
  expect(res.status).toBe(404)
  expect(await readFile(join(repo, "docs", "features", "importer.md"), "utf8")).toContain("Read the CSV")
})

test("a ref the file does not have is a 409, and a file that is not there is a 404", async () => {
  const repo = await cleanRepo()
  await withFeature(repo, "importer.md", FEATURE)
  const l = await withTree(await storeOf(repo))

  const missingRef = await removeTask(l, {
    projectPath: repo,
    featureFile: "docs/features/importer.md",
    taskRef: "T9",
  })
  expect(missingRef.status).toBe(409)
  expect(missingRef.body).toContain("no task T9")

  const missingFile = await removeTask(l, {
    projectPath: repo,
    featureFile: "docs/features/nope.md",
    taskRef: "T1",
  })
  expect(missingFile.status).toBe(404)
})

test("a body missing any of the three keys is refused by the names this route takes", async () => {
  const repo = await cleanRepo()
  await withFeature(repo, "importer.md", FEATURE)
  const l = await withTree(await storeOf(repo))

  for (const body of [
    { projectPath: repo, featureFile: "docs/features/importer.md" },
    { projectPath: repo, taskRef: "T1" },
    { featureFile: "docs/features/importer.md", taskRef: "T1" },
    { projectPath: repo, featureFile: "docs/features/importer.md", taskRef: "" },
  ]) {
    const res = await removeTask(l, body)
    expect(res.status).toBe(400)
    expect(res.body).toContain("taskRef")
  }
})

test("a duplicated ref is refused rather than guessed at", async () => {
  const repo = await cleanRepo()
  await withFeature(repo, "dupe.md", "# D\n\n- [ ] T1 one\n- [ ] T1 two\n")
  const l = await withTree(await storeOf(repo))

  const res = await removeTask(l, {
    projectPath: repo,
    featureFile: "docs/features/dupe.md",
    taskRef: "T1",
  })
  expect(res.status).toBe(409)
  expect(res.body).toContain("lines 3, 4")
  expect(await readFile(join(repo, "docs", "features", "dupe.md"), "utf8")).toContain("T1 two")
})

/* ========================================================================== */
/* POST /api/features/task                                                    */
/* ========================================================================== */

const APPEND_TASK = "POST /api/features/task"

function addTasksTo(
  l: Launch,
  body: unknown,
): Promise<{ status: number; headers: Headers; body: string }> {
  return call(l, { path: "/api/features/task", method: "POST", body: JSON.stringify(body) })
}

test("adding tasks is a POST in ROUTES, behind the guards, and not token-exempt", () => {
  expect(Object.keys(ROUTES)).toContain(APPEND_TASK)
  expect(TOKEN_EXEMPT.has(APPEND_TASK)).toBe(false)
})

test("it appends after the last task, numbers from the file, and answers the refs", async () => {
  const repo = await cleanRepo()
  await withFeature(repo, "importer.md", FEATURE)
  const l = await withTree(await storeOf(repo))

  const res = await addTasksTo(l, {
    projectPath: repo,
    featureFile: "docs/features/importer.md",
    texts: ["Handle a missing column", "Report the row number"],
  })

  expect(res.status).toBe(200)
  expect((JSON.parse(res.body) as { refs: string[] }).refs).toEqual(["T3", "T4"])
  // The refless line is read two ways here, and both are right for the
  // question they answer. For **numbering** it carries nothing to clash with,
  // so `T2` is still the highest and the new refs are `T3` and `T4`. For
  // **position** it is a task like any other, so it is the last task line and
  // the new ones go after it - putting them before it instead would mean
  // "after the last *ref'd* task", which splits the list around a line the
  // human wrote in the middle of it.
  expect(await readFile(join(repo, "docs", "features", "importer.md"), "utf8")).toBe(
    `# Importer

- [ ] T1 Read the CSV
- [x] T2 Write the rows
- [ ] A line with no ref
- [ ] T3 Handle a missing column
- [ ] T4 Report the row number
`,
  )
})

test("the tree lists them straight away, which is the point", async () => {
  const repo = await cleanRepo()
  await withFeature(repo, "importer.md", FEATURE)
  const l = await withTree(await storeOf(repo))

  await addTasksTo(l, {
    projectPath: repo,
    featureFile: "docs/features/importer.md",
    texts: ["Handle a missing column"],
  })

  const { body } = await getTree(l)
  const tasks = body.projects?.[0]?.features[0]?.tasks ?? []
  expect(tasks.map((t) => t.ref)).toEqual(["T1", "T2", null, "T3"])
  expect(tasks.find((t) => t.ref === "T3")?.text).toBe("Handle a missing column")
  expect(tasks.find((t) => t.ref === "T3")?.done).toBe(false)
})

test("it commits the file it wrote into", async () => {
  const repo = await cleanRepo()
  await withFeature(repo, "importer.md", FEATURE)
  await gitIn(repo, "add", "docs/features/importer.md")
  await gitIn(repo, "commit", "-m", "add the backlog", "--", "docs/features/importer.md")
  const l = await withTree(await storeOf(repo))

  const res = await addTasksTo(l, {
    projectPath: repo,
    featureFile: "docs/features/importer.md",
    texts: ["one", "two"],
  })
  expect(res.status).toBe(200)

  expect(await gitSays(repo, "log", "-1", "--pretty=%s")).toBe("chore: add T3, T4 to docs/features/importer.md")
  expect(await gitSays(repo, "status", "--porcelain")).toBe("")
})

test("a run in flight refuses, and nothing is added", async () => {
  const repo = await cleanRepo()
  const path = await withFeature(repo, "importer.md", FEATURE)
  const before = await readFile(path, "utf8")
  const dir = await runsDir()
  const store = await storeFile()
  const live = "55555555-5555-4555-8555-555555555555"
  const l = serve({ runsDir: dir, projectsFile: store, liveRunIds: () => [live] })
  await logNamingProject(dir, live, (await requireUsableRepo(repo)).root)
  await register(l, { path: repo, testCmd: "npm test" })

  const res = await addTasksTo(l, {
    projectPath: repo,
    featureFile: "docs/features/importer.md",
    texts: ["one"],
  })

  expect(res.status).toBe(409)
  expect(res.body).toContain(live)
  expect(await readFile(path, "utf8")).toBe(before)
})

/**
 * `texts` is an array from a page, and every element becomes a line in a file
 * inside someone's repository. The matrix is the enumeration: each row is a
 * shape that would otherwise write something the caller did not mean.
 */
test("a texts array that is not a list of one-line strings is refused", async () => {
  const repo = await cleanRepo()
  const path = await withFeature(repo, "importer.md", FEATURE)
  const before = await readFile(path, "utf8")
  const l = await withTree(await storeOf(repo))

  const ROWS: ReadonlyArray<{ why: string; texts: unknown; says: string }> = [
    { why: "not an array at all", texts: "one task", says: "texts" },
    { why: "a number among the strings", texts: ["fine", 7], says: "texts[1]" },
    { why: "an object, which would stringify to [object Object]", texts: [{ text: "x" }], says: "texts[0]" },
    { why: "null", texts: [null], says: "texts[0]" },
    { why: "a nested array", texts: [["x"]], says: "texts[0]" },
    { why: "a newline, which is two lines and not one task", texts: ["a\nb"], says: "line break" },
    { why: "a carriage return", texts: ["a\rb"], says: "line break" },
    { why: "all blank, so there is nothing to add", texts: ["  ", ""], says: "blank" },
    { why: "over the per-call limit", texts: Array.from({ length: 51 }, (_, i) => `t${i}`), says: "50" },
    { why: "one task over the character limit", texts: ["x".repeat(2001)], says: "2000" },
  ]

  for (const { why, texts, says } of ROWS) {
    const res = await addTasksTo(l, {
      projectPath: repo,
      featureFile: "docs/features/importer.md",
      texts,
    })
    expect(res.status, `for ${why}`).toBe(400)
    expect(res.body, `for ${why}`).toContain(says)
    expect(await readFile(path, "utf8"), `for ${why}`).toBe(before)
  }
})

test("a task file outside the project is refused here too", async () => {
  const repo = await cleanRepo()
  await withFeature(repo, "importer.md", FEATURE)
  const l = await withTree(await storeOf(repo))

  for (const featureFile of ["../outside.md", "docs/../../outside.md", "/etc/passwd", ""]) {
    const res = await addTasksTo(l, { projectPath: repo, featureFile, texts: ["x"] })
    expect([400, 404], `for ${JSON.stringify(featureFile)}`).toContain(res.status)
  }
})

test("a file that is not there is a 404, and an unregistered project is too", async () => {
  const repo = await cleanRepo()
  await withFeature(repo, "importer.md", FEATURE)

  const registeredL = await withTree(await storeOf(repo))
  const noFile = await addTasksTo(registeredL, {
    projectPath: repo,
    featureFile: "docs/features/nope.md",
    texts: ["x"],
  })
  expect(noFile.status).toBe(404)

  const emptyL = await withTree(await storeFile())
  const noProject = await addTasksTo(emptyL, {
    projectPath: repo,
    featureFile: "docs/features/importer.md",
    texts: ["x"],
  })
  expect(noProject.status).toBe(404)
})

/** The refs are numbered against the bytes on disk, so a ref can never collide
 *  with one a human added since the texts were drafted. */
test("a file edited since the draft is numbered against what is on disk now", async () => {
  const repo = await cleanRepo()
  const path = await withFeature(repo, "importer.md", FEATURE)
  const l = await withTree(await storeOf(repo))

  // The human adds T7 by hand while the add screen is open.
  await writeFile(path, "# Importer\n\n- [ ] T1 Read the CSV\n- [ ] T7 Typed by hand\n")

  const res = await addTasksTo(l, {
    projectPath: repo,
    featureFile: "docs/features/importer.md",
    texts: ["Drafted earlier"],
  })

  expect((JSON.parse(res.body) as { refs: string[] }).refs).toEqual(["T8"])
  const after = await readFile(path, "utf8")
  expect(after).toContain("- [ ] T8 Drafted earlier")
  expect(after).toContain("- [ ] T7 Typed by hand")
})

/* ========================================================================== */
/* The account registry                                                        */
/* ========================================================================== */

/**
 * Reported from use: *"why other accounts are not detected?"* and *"if I try
 * to add a new account nothing happens?"*
 *
 * One cause. The account list was derived from projects already registered, so
 * a profile no project had run with could not appear - and the only way to add
 * one was to already have a project using it.
 */

function addAccount(l: Launch, body: unknown): Promise<{ status: number; headers: Headers; body: string }> {
  return call(l, { path: "/api/accounts", method: "POST", body: JSON.stringify(body) })
}

test("the account route is registered behind the guards and not token-exempt", () => {
  expect(Object.keys(ROUTES)).toContain("POST /api/accounts")
  expect(TOKEN_EXEMPT.has("POST /api/accounts")).toBe(false)
})

test("an added account is offered by the tree, with no project using it", async () => {
  // The circle this breaks: before the registry, an account could only be
  // offered if a registered project already billed to it.
  const store = await storeFile()
  const l = await withTree(store)

  const added = await addAccount(l, { kind: "work", label: "Acme", configDir: "/tmp/orch-acme" })
  expect(added.status).toBe(200)

  const tree = JSON.parse((await call(l, { path: "/api/projects" })).body) as {
    accounts: Array<{ kind: string; label: string; configDir: string }>
  }
  expect(tree.accounts).toEqual([{ kind: "work", label: "Acme", configDir: "/tmp/orch-acme" }])
})

test("an added account appears in the usage view before it has ever run", async () => {
  /* The other half of "not detected". `GET /api/accounts` built its profile
   * list from the store's projects, so an account with no project reported
   * nothing - and a page cannot tell "nothing to report" from "no such
   * account" unless the account is listed. */
  const store = await storeFile()
  const l = await withTree(store)
  await addAccount(l, { kind: "work", label: "Acme", configDir: "/tmp/orch-acme" })

  const body = JSON.parse((await call(l, { path: "/api/accounts" })).body) as {
    accounts: Array<{ profile: string | null; freshness: string }>
  }
  const acme = body.accounts.find((a) => a.profile === "/tmp/orch-acme")
  expect(acme).toBeDefined()
  /* "never", not absent, and that distinction is the whole reason the registry
   * feeds this route: a page can say "kantan has not seen this account run"
   * only if the account is listed. An unlisted one is indistinguishable from
   * one that does not exist. */
  expect(acme?.freshness).toBe("never")
})

test("a bad account is refused in the store's own words, and nothing is written", async () => {
  const store = await storeFile()
  const l = await withTree(store)

  for (const body of [
    {},
    { kind: "work", label: "Acme" },
    { kind: "work", label: "", configDir: "/tmp/x" },
    { kind: "nope", label: "Acme", configDir: "/tmp/x" },
    // The refusal that matters most: a relative folder cannot be resolved
    // against anything the person typing it can see.
    { kind: "work", label: "Acme", configDir: "relative/path" },
  ]) {
    const res = await addAccount(l, body)
    expect({ body, status: res.status }).toEqual({ body, status: 400 })
  }

  const tree = JSON.parse((await call(l, { path: "/api/projects" })).body) as { accounts: unknown[] }
  expect(tree.accounts).toEqual([])
})

test("a launch with no project store cannot hold accounts, and says so", async () => {
  // The registry lives beside `projects.json`, so without one there is nowhere
  // to put it. 503 like every other store-less refusal, not 500.
  const l = serve({ runsDir: await runsDir() })
  const res = await addAccount(l, { kind: "work", label: "Acme", configDir: "/tmp/x" })
  expect(res.status).toBe(503)
})

test("the tree reports the profiles found on disk separately from the ones added", async () => {
  /* Two different claims, kept apart: `accounts` is what the user told kantan,
   * `foundAccounts` is what a directory scan suggests. Merging them would make
   * a guess look like a record - and the scan is deliberately conservative,
   * because typing the path by hand is always available. */
  const store = await storeFile()
  const l = await withTree(store)
  const tree = JSON.parse((await call(l, { path: "/api/projects" })).body) as Record<string, unknown>

  expect(Array.isArray(tree["accounts"])).toBe(true)
  expect(Array.isArray(tree["foundAccounts"])).toBe(true)
})

/* ========================================================================== */
/* POST /api/test and POST /api/features/propose                              */
/* ========================================================================== */

const TEST_ROUTE = "POST /api/test"
const PROPOSE_ROUTE = "POST /api/features/propose"

function runTest(l: Launch, body: unknown): Promise<{ status: number; headers: Headers; body: string }> {
  return call(l, { path: "/api/test", method: "POST", body: JSON.stringify(body) })
}

function propose(l: Launch, body: unknown): Promise<{ status: number; headers: Headers; body: string }> {
  return call(l, { path: "/api/features/propose", method: "POST", body: JSON.stringify(body) })
}

test("both new routes are registered behind the guards and not token-exempt", () => {
  for (const route of [TEST_ROUTE, PROPOSE_ROUTE]) {
    expect(Object.keys(ROUTES)).toContain(route)
    expect(TOKEN_EXEMPT.has(route)).toBe(false)
  }
})

test("a test command runs and its exit code comes back, pass and fail alike", async () => {
  const repo = await cleanRepo()
  const l = await withTree(await storeOf(repo))

  const passed = await runTest(l, { projectPath: repo, testCmd: "echo '3 passing'; exit 0" })
  expect(passed.status).toBe(200)
  const pass = JSON.parse(passed.body) as { exitCode: number; stdout: string; timedOut: boolean }
  expect(pass.exitCode).toBe(0)
  expect(pass.stdout).toContain("3 passing")
  expect(pass.timedOut).toBe(false)

  const failed = await runTest(l, { projectPath: repo, testCmd: "echo '1 failing' >&2; exit 3" })
  const fail = JSON.parse(failed.body) as { exitCode: number; stderr: string }
  expect(fail.exitCode).toBe(3)
  expect(fail.stderr).toContain("1 failing")
})

/** It runs in the project, which is the only place a test command means anything. */
test("the command runs in the project's own directory", async () => {
  const repo = await cleanRepo()
  const l = await withTree(await storeOf(repo))

  const res = await runTest(l, { projectPath: repo, testCmd: "pwd" })
  expect((JSON.parse(res.body) as { stdout: string }).stdout.trim()).toBe(repo)
})

/**
 * The command comes from the body, not the store, because the control exists
 * to prove a command works *before* it is saved. This is the assertion that
 * says so: the stored command would have exited 0.
 */
test("it runs the command it was given, not the one on record", async () => {
  const repo = await cleanRepo()
  const store = await storeFile()
  await addProject(store, defaults({ path: repo, testCmd: "true" }))
  const l = await withTree(store)

  const res = await runTest(l, { projectPath: repo, testCmd: "exit 7" })
  expect((JSON.parse(res.body) as { exitCode: number }).exitCode).toBe(7)
  // And nothing was saved by pressing a button that says "run it".
  expect((await loadProjects(store))[0]?.testCmd).toBe("true")
})

test("a blank or whitespace-only command is refused, because `sh -c` exits 0 on it", async () => {
  const repo = await cleanRepo()
  const l = await withTree(await storeOf(repo))

  for (const testCmd of ["", "   ", "\t\n"]) {
    const res = await runTest(l, { projectPath: repo, testCmd })
    expect(res.status, `for ${JSON.stringify(testCmd)}`).toBe(400)
  }
})

test("a run in flight refuses a trial, which would share its working tree", async () => {
  const repo = await cleanRepo()
  const dir = await runsDir()
  const store = await storeFile()
  const live = "66666666-6666-4666-8666-666666666666"
  const l = serve({ runsDir: dir, projectsFile: store, liveRunIds: () => [live] })
  await logNamingProject(dir, live, (await requireUsableRepo(repo)).root)
  await register(l, { path: repo, testCmd: "npm test" })

  const res = await runTest(l, { projectPath: repo, testCmd: "exit 0" })
  expect(res.status).toBe(409)
  expect(res.body).toContain(live)
})

/**
 * An unregistered path is allowed, **if and only if it passes the same check
 * registration makes**. This is what wires `AddRepo`'s "Run it once": the
 * button exists to prove a command works before the project is saved, so by
 * construction there is no record to look it up in.
 *
 * It is a widening, so the reasoning is here rather than in a commit message:
 *
 * - It grants no new capability. Anything holding the token can register a
 *   usable repo and then run a command in it, through this same `sh -c`. The
 *   widening removes a round trip, not a boundary.
 * - What it must not do is widen *where*. `requireUsableRepo` is the only
 *   gate, and it is the same one registration uses - so the set of directories
 *   a trial can run in is exactly the set a project can be registered at, and
 *   not one path more. `/` and a home directory are both refused by it.
 * - `POST /api/detect`'s precedent is deliberately not the argument. Detect is
 *   read-only and running a command is not.
 */
test("an unregistered but usable repo can have a command tried in it", async () => {
  const repo = await cleanRepo()
  const store = await storeFile()
  const l = await withTree(store)

  const res = await runTest(l, { projectPath: repo, testCmd: "echo tried; exit 0" })
  expect(res.status).toBe(200)
  const out = JSON.parse(res.body) as { exitCode: number; stdout: string }
  expect(out.exitCode).toBe(0)
  expect(out.stdout).toContain("tried")

  // Trying is not saving. The whole point is to find out before committing to
  // it, so a trial that registered the project would defeat its own purpose.
  expect(await loadProjects(store)).toEqual([])
})

test("an unregistered trial runs in the directory it named", async () => {
  const repo = await cleanRepo()
  const l = await withTree(await storeFile())
  const res = await runTest(l, { projectPath: repo, testCmd: "pwd" })
  expect((JSON.parse(res.body) as { stdout: string }).stdout.trim()).toBe(repo)
})

/**
 * The refusal prose is the reason this goes through `requireUsableRepo` rather
 * than a `stat`. `src/git.ts` names the deepest ancestor that does exist, which
 * is the sentence that locates a typo - the production failure `AddRepo` was
 * built for was a four-character mistake in a home directory answered with a
 * sentence about git.
 */
test("an unregistered path that is not a usable repo is refused, in git's own words", async () => {
  const l = await withTree(await storeFile())
  const res = await runTest(l, { projectPath: "/nonexistent-aaa/bbb/ccc", testCmd: "exit 0" })

  expect(res.status).toBe(400)
  // Not a bare "no such project": the part a person can act on.
  expect(res.body).toContain("/nonexistent-aaa/bbb/ccc")

  // And the clause that locates the typo, which only appears when there is a
  // meaningful ancestor to name - `/` is suppressed, because naming it tells
  // nobody anything. Asserted on a path that has one.
  const typo = await runTest(l, { projectPath: "/tmp/nonexistent-aaa/bbb", testCmd: "exit 0" })
  expect(typo.status).toBe(400)
  expect(typo.body).toContain("/tmp")
  expect(typo.body).toContain("check the spelling")
})

/**
 * The value no other test here produces, and the one that caught a real
 * widening: `requireUsableRepo(".")` is **accepted**, resolving to whatever
 * directory the server was launched from. So validating with that call alone
 * would have let a trial run a command in kantan's own checkout - a directory
 * `registerProject` refuses, because it runs `defaults` first and `defaults`
 * owns the absolute-path rule.
 *
 * Both gates, in registration's order, is therefore the requirement. This test
 * is what says so.
 */
test("a relative path is refused rather than resolved against the server's cwd", async () => {
  const l = await withTree(await storeFile())
  for (const projectPath of [".", "./", "src", "some/relative/path", ".."]) {
    const res = await runTest(l, { projectPath, testCmd: "exit 0" })
    expect({ projectPath, status: res.status }).toEqual({ projectPath, status: 400 })
  }
})

test("a run in flight refuses a trial in an unregistered repo too", async () => {
  // The reason is the working tree, not the record: a live run may be
  // verifying its own work in that same checkout, and two suites writing one
  // tree produce a failure neither of them caused. Nothing about that changes
  // when the project happens not to be registered yet.
  const repo = await cleanRepo()
  const dir = await runsDir()
  const live = "77777777-7777-4777-8777-777777777777"
  const l = serve({ runsDir: dir, projectsFile: await storeFile(), liveRunIds: () => [live] })
  await logNamingProject(dir, live, (await requireUsableRepo(repo)).root)

  const res = await runTest(l, { projectPath: repo, testCmd: "exit 0" })
  expect(res.status).toBe(409)
  expect(res.body).toContain(live)
})

/**
 * Proposing writes nothing, so - unlike the three task routes - a run in
 * flight is fine. Refusing would make the screen unusable for as long as a run
 * takes, for a call whose whole output is text on a page.
 */
test("proposing answers the model's tasks, and writes nothing", async () => {
  const repo = await cleanRepo()
  const path = await withFeature(repo, "importer.md", FEATURE)
  const before = await readFile(path, "utf8")
  const store = await storeFile()
  await addProject(store, defaults({ path: repo, testCmd: "bun test" }))
  const { l, prompts } = await withTreeAsking(store, "Handle a missing column\nReport the row number\n")

  const res = await propose(l, {
    projectPath: repo,
    featureFile: "docs/features/importer.md",
    text: "make the importer sturdier",
  })

  expect(res.status).toBe(200)
  expect((JSON.parse(res.body) as { tasks: string[] }).tasks).toEqual([
    "Handle a missing column",
    "Report the row number",
  ])
  // The file's current contents reach the prompt, so the proposals fit it and
  // do not repeat it.
  expect(prompts[0]).toContain("T1 Read the CSV")
  expect(prompts[0]).toContain("make the importer sturdier")
  // And nothing was written: this route proposes.
  expect(await readFile(path, "utf8")).toBe(before)
})

/**
 * Unlike the three task routes, a run in flight does **not** refuse a propose:
 * nothing is written and nothing is committed, so none of their reasons apply,
 * and refusing would make the screen unusable for as long as a run takes.
 */
test("proposing is allowed while a run is in flight", async () => {
  const repo = await cleanRepo()
  const path = await withFeature(repo, "importer.md", FEATURE)
  const before = await readFile(path, "utf8")
  const dir = await runsDir()
  const store = await storeFile()
  const live = "77777777-7777-4777-8777-777777777777"
  const { l } = serveAsking("Handle a missing column\n", {
    runsDir: dir,
    projectsFile: store,
    liveRunIds: () => [live],
  })
  await logNamingProject(dir, live, (await requireUsableRepo(repo)).root)
  await register(l, { path: repo, testCmd: "npm test" })

  const res = await propose(l, {
    projectPath: repo,
    featureFile: "docs/features/importer.md",
    text: "make the importer sturdier",
  })

  expect(res.status).toBe(200)
  expect(await readFile(path, "utf8")).toBe(before)
})

/** A reply the drafter cannot read is the caller's to see, as a 502: the
 *  request was fine and something upstream was not. */
test("a reply with nothing task-shaped in it is a 502", async () => {
  const repo = await cleanRepo()
  await withFeature(repo, "importer.md", FEATURE)
  const store = await storeFile()
  await addProject(store, defaults({ path: repo, testCmd: "bun test" }))
  const { l } = await withTreeAsking(store, "# Just a heading\n")

  const res = await propose(l, {
    projectPath: repo,
    featureFile: "docs/features/importer.md",
    text: "x",
  })
  expect(res.status).toBe(502)
})

/**
 * `POST /api/features` had no happy-path test at all, for the reason this one
 * needed a harness: exercising it reached the real binary. It writes a whole
 * new file and commits it, which is the half `propose` deliberately does not.
 */
test("drafting a feature file writes it, parses it, and commits it", async () => {
  const repo = await cleanRepo()
  const store = await storeFile()
  await addProject(store, defaults({ path: repo, testCmd: "bun test" }))
  const { l, prompts } = await withTreeAsking(
    store,
    "# Resumable imports\n- [ ] T1 Record where the import stopped\n- [ ] T2 Pick it up from there\n",
  )

  const res = await call(l, {
    path: "/api/features",
    method: "POST",
    body: JSON.stringify({ projectPath: repo, text: "the importer should survive a crash" }),
  })

  expect(res.status).toBe(201)
  const body = JSON.parse(res.body) as { path: string }
  expect(body.path).toBe("docs/features/resumable-imports.md")
  expect(prompts[0]).toContain("the importer should survive a crash")

  const written = await readFile(join(repo, body.path), "utf8")
  expect(written).toContain("- [ ] T1 Record where the import stopped")
  // Committed, because kantan wrote into someone's repository: leaving it
  // untracked is what closed the loop this route exists to open.
  expect(await gitSays(repo, "log", "-1", "--pretty=%s")).toContain("docs/features/resumable-imports.md")
  expect(await gitSays(repo, "status", "--porcelain")).toBe("")
})

test("proposing refuses a task file outside the project, and one that is not there", async () => {
  const repo = await cleanRepo()
  await withFeature(repo, "importer.md", FEATURE)
  const l = await withTree(await storeOf(repo))

  for (const featureFile of ["../outside.md", "/etc/passwd", "docs/../../x.md"]) {
    const res = await propose(l, { projectPath: repo, featureFile, text: "x" })
    expect([400, 404], `for ${featureFile}`).toContain(res.status)
  }

  const missing = await propose(l, { projectPath: repo, featureFile: "docs/features/nope.md", text: "x" })
  expect(missing.status).toBe(404)
})

test("proposing needs all three fields", async () => {
  const repo = await cleanRepo()
  await withFeature(repo, "importer.md", FEATURE)
  const l = await withTree(await storeOf(repo))

  for (const body of [
    { projectPath: repo, featureFile: "docs/features/importer.md" },
    { projectPath: repo, text: "x" },
    { featureFile: "docs/features/importer.md", text: "x" },
    { projectPath: repo, featureFile: "docs/features/importer.md", text: "   " },
  ]) {
    expect((await propose(l, body)).status).toBe(400)
  }
})

/**
 * The six settings that were hand-edit-only.
 *
 * The store has held and validated them since it was written; only
 * `EDITABLE_KEYS` withheld them, so `~/.kantan/projects.json` was the single way
 * to change the model a phase runs on. The refusals in the table above prove
 * the validation still bites - this proves the acceptance, one field at a time,
 * because `PATCH` is a partial update and the point is that touching one does
 * not rewrite the rest.
 */
test("every advanced setting can be edited, one at a time, without disturbing the others", async () => {
  const repo = await cleanRepo()
  const store = await storeFile()
  await addProject(store, defaults({ path: repo, testCmd: "bun test" }))
  const l = await withTree(store)

  const CHANGES: ReadonlyArray<[string, unknown]> = [
    ["planModel", "claude-fable-5-1"],
    ["implementModel", "claude-haiku-5-5"],
    ["planEffort", "max"],
    ["implementEffort", "low"],
    ["permissionMode", "bypassPermissions"],
    ["allowedTools", ["Read", "Edit"]],
  ]

  for (const [key, value] of CHANGES) {
    const res = await call(l, {
      path: REGISTER_PATH,
      method: "PATCH",
      body: JSON.stringify({ path: repo, [key]: value }),
    })
    expect(res.status, key).toBe(200)
  }

  // Every one landed, and the fields nobody touched are untouched.
  const stored = (await loadProjects(store))[0]
  expect(stored).toMatchObject({
    planModel: "claude-fable-5-1",
    implementModel: "claude-haiku-5-5",
    planEffort: "max",
    implementEffort: "low",
    permissionMode: "bypassPermissions",
    allowedTools: ["Read", "Edit"],
    testCmd: "bun test",
    budgetUsd: 50,
  })

  // And they reach the page: the panel cannot offer to change what it cannot read.
  const { body } = await getTree(l)
  expect(body.projects?.[0]?.advanced).toEqual({
    planModel: "claude-fable-5-1",
    implementModel: "claude-haiku-5-5",
    planEffort: "max",
    implementEffort: "low",
    permissionMode: "bypassPermissions",
    allowedTools: ["Read", "Edit"],
  })
})

/** `null` is "every tool", which is the store's default and not an empty list. */
test("allowedTools clears back to null, which means every tool", async () => {
  const repo = await cleanRepo()
  const store = await storeFile()
  await addProject(store, defaults({ path: repo, testCmd: "bun test", allowedTools: ["Read"] }))
  const l = await withTree(store)

  const res = await call(l, {
    path: REGISTER_PATH,
    method: "PATCH",
    body: JSON.stringify({ path: repo, allowedTools: null }),
  })
  expect(res.status).toBe(200)
  expect((await loadProjects(store))[0]?.allowedTools).toBeNull()
})

/* ========================================================================== */
/* POST /api/detect                                                           */
/* ========================================================================== */

const DETECT_ROUTE = "POST /api/detect"

function check(l: Launch, body: unknown): Promise<{ status: number; headers: Headers; body: string }> {
  return call(l, { path: "/api/detect", method: "POST", body: JSON.stringify(body) })
}

test("detect is registered behind the guards and not token-exempt", () => {
  expect(Object.keys(ROUTES)).toContain(DETECT_ROUTE)
  expect(TOKEN_EXEMPT.has(DETECT_ROUTE)).toBe(false)
})

/**
 * **A 200 even for a folder that is not a repository.** "This is not a usable
 * git repository" is the *answer*, carried as a sentence someone can read, not
 * a refusal of the question. `AddRepo` draws exactly that distinction:
 * `phase: "done", usable: false` is a verdict about the folder, while
 * `phase: "unknown"` is the probe itself failing and must not block the
 * button. A 4xx here would be read as the second and would be the first.
 */
test("it answers 200 with a verdict, for a good path and a bad one alike", async () => {
  const repo = await cleanRepo()
  const l = await withTree(await storeFile())

  const good = await check(l, { path: repo })
  expect(good.status).toBe(200)
  const ok = JSON.parse(good.body) as { phase: string; usable: boolean; root: string }
  expect(ok.phase).toBe("done")
  expect(ok.usable).toBe(true)
  expect(ok.root).toBe(repo)

  const bad = await check(l, { path: "/definitely/not/here" })
  expect(bad.status).toBe(200)
  const no = JSON.parse(bad.body) as { phase: string; usable: boolean }
  expect(no.phase).toBe("done")
  expect(no.usable).toBe(false)
})

test("it reads the store, so an already-registered repo is not offered twice", async () => {
  const repo = await cleanRepo()
  const l = await withTree(await storeOf(repo))

  const res = await check(l, { path: repo })
  expect(res.status).toBe(200)
  const got = JSON.parse(res.body) as { usable: boolean; checks: { status: string; says: unknown[] }[] }
  expect(got.usable).toBe(false)
  const prose = got.checks.map((c) => c.says.map((s) => (typeof s === "string" ? s : (s as { mono: string }).mono)).join("")).join(" ")
  expect(prose).toContain("already tracks this repository")
})

/** A launch with no store cannot say whether a path is taken, and says
 *  nothing rather than claiming it is free. */
test("without a store it still checks the folder", async () => {
  const repo = await cleanRepo()
  const l = serve({ runsDir: await runsDir() })

  const res = await check(l, { path: repo })
  expect(res.status).toBe(200)
  expect((JSON.parse(res.body) as { usable: boolean }).usable).toBe(true)
})

test("it previews the task files it found", async () => {
  const repo = await cleanRepo()
  await withFeature(repo, "importer.md", FEATURE)
  const l = await withTree(await storeFile())

  const res = await check(l, { path: repo })
  const got = JSON.parse(res.body) as { taskFiles: { path: string; tasks: { ref: string | null }[] }[] }
  expect(got.taskFiles).toHaveLength(1)
  expect(got.taskFiles[0]?.path).toBe("docs/features/importer.md")
  expect(got.taskFiles[0]?.tasks.map((t) => t.ref)).toEqual(["T1", "T2", null])
})

test("a body with no path, or a path that is not a string, is refused", async () => {
  const l = await withTree(await storeFile())
  for (const body of [{}, { path: 7 }, { path: null }, { pa7h: "/x" }]) {
    expect((await check(l, body)).status, JSON.stringify(body)).toBe(400)
  }
})

/** Read-only, which is what makes an arbitrary path acceptable here: it is the
 *  one route that deliberately does not require a registered project, because
 *  nothing can be registered before it is checked. */
test("it changes nothing about the folder it looked at", async () => {
  const repo = await cleanRepo()
  await withFeature(repo, "importer.md", FEATURE)
  const before = await gitSays(repo, "status", "--porcelain")
  const head = await gitSays(repo, "rev-parse", "HEAD")
  const l = await withTree(await storeFile())

  await check(l, { path: repo })

  expect(await gitSays(repo, "status", "--porcelain")).toBe(before)
  expect(await gitSays(repo, "rev-parse", "HEAD")).toBe(head)
})
