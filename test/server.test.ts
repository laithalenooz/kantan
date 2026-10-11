import { afterAll, expect, test } from "bun:test"
import { mkdtemp, open as openFile, readdir, readlink, realpath, rm } from "node:fs/promises"
import { connect } from "node:net"
import { networkInterfaces, tmpdir } from "node:os"
import { join } from "node:path"
import { createRunLog, runLogPath } from "../src/runlog"
import type { RunHeader, RunLog, RunRecord } from "../src/runlog"
import { ROUTES, TOKEN_EXEMPT, createServer, type Launch, type RouteContext } from "../src/server"

// These endpoints hand arbitrary text to an agent with file-write and shell
// access, so the guards below are the project's only security boundary.
// "it only listens on localhost" is not one of them: any page the owner visits
// can POST to a localhost port, and DNS rebinding can make the attacker's
// domain resolve to 127.0.0.1 so their page becomes same-origin with us. The
// Host header is what catches that, which is why an absent Host is refused
// rather than read as local.

const launched: Launch[] = []

/** A loopback launch on an OS-assigned port, stopped when the suite ends. */
function serve(opts: Parameters<typeof createServer>[0] = {}): Launch {
  const l = createServer({ port: 0, ...opts })
  launched.push(l)
  return l
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
}

async function call(l: Launch, c: Call = {}): Promise<{ status: number; headers: Headers; body: string }> {
  const headers = new Headers({ Host: c.host ?? `127.0.0.1:${l.port}` })
  const origin = c.origin === undefined ? `http://127.0.0.1:${l.port}` : c.origin
  if (origin !== null) headers.set("Origin", origin)
  const cookie = c.cookie === undefined ? `orch_token=${l.token}` : c.cookie
  if (cookie !== null) headers.set("Cookie", cookie)

  const res = await fetch(`http://127.0.0.1:${l.port}${c.path ?? "/api/health"}`, {
    method: c.method ?? "GET",
    headers,
    redirect: "manual",
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
  expect((await call(app, { cookie: "orch_token=" })).status).toBe(401)
  expect((await call(app, { cookie: `orch_token=${app.token}x` })).status).toBe(401)
  expect((await call(app, { cookie: `orch_token=${app.token.slice(0, -1)}` })).status).toBe(401)
  expect((await call(app, { cookie: "nottheone=1" })).status).toBe(401)
  // Another launch's token is somebody else's.
  expect((await call(app, { cookie: `orch_token=${serve().token}` })).status).toBe(401)
})

test("a cookie-authenticated request succeeds where an unauthenticated one fails", async () => {
  expect((await call(app, { cookie: null })).status).toBe(401)
  expect((await call(app, { cookie: `orch_token=${app.token}` })).status).toBe(200)
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
  // orch_token for this host. It cannot know the real value, so the browser
  // sends both and we accept if any value matches: a decoy is then noise
  // rather than a denial of service, and still never a bypass.
  expect((await call(app, { cookie: `theme=dark; orch_token=${app.token}; tz=UTC` })).status).toBe(200)
  expect((await call(app, { cookie: `orch_token=decoy; orch_token=${app.token}` })).status).toBe(200)
  expect((await call(app, { cookie: `orch_token=${app.token}; orch_token=decoy` })).status).toBe(200)
  // A name that merely contains ours is a different cookie.
  expect((await call(app, { cookie: `xorch_token=${app.token}` })).status).toBe(401)
  expect((await call(app, { cookie: `orch_token_x=${app.token}` })).status).toBe(401)
})

// ---------------------------------------------------------------------------
// 3. Page load sets the cookie, and is the only thing exempt from the token
// ---------------------------------------------------------------------------

test("page load sets the token as a SameSite=Strict cookie", async () => {
  const l = serve()
  const res = await call(l, { path: "/", cookie: null, origin: null })
  expect(res.status).toBe(200)

  const setCookie = res.headers.get("set-cookie") ?? ""
  expect(setCookie).toContain(`orch_token=${l.token}`)
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
  expect((await call(l, { cookie: `orch_token=${l.token}` })).status).toBe(200)
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
    `GET /api/health HTTP/1.0\r\nCookie: orch_token=${app.token}\r\nConnection: close\r\n\r\n`,
  )
  expect(ten).toStartWith("HTTP/1.1 403")
})

test("Host empty, or sent twice, -> 403", async () => {
  const empty = await raw(PORT, `GET /api/health HTTP/1.1\r\nHost:\r\nCookie: orch_token=${app.token}\r\nConnection: close\r\n\r\n`)
  expect(empty).toStartWith("HTTP/1.1 403")

  // Two Host headers arrive joined as "a, b", which matches no allowlist
  // entry. Smuggling one good value past us needs the pair to be accepted.
  const twice = await raw(
    PORT,
    `GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nHost: evil.example.com\r\nCookie: orch_token=${app.token}\r\nConnection: close\r\n\r\n`,
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
    `GET /api/health HTTP/1.1\r\nHost: \t127.0.0.1:${PORT} \t\r\nCookie: orch_token=${app.token}\r\nConnection: close\r\n\r\n`,
  )
  expect(padded).toStartWith("HTTP/1.1 200")
})

test("0.0.0.0 really reaches a loopback-bound server, and is refused there", async () => {
  // Not a hypothetical row: Linux routes a connect to 0.0.0.0 to loopback, so
  // this is a live request with a Host we do not allowlist.
  const res = await fetch(`http://0.0.0.0:${PORT}/api/health`, {
    headers: { Cookie: `orch_token=${app.token}` },
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
  expect(boot.headers.get("set-cookie") ?? "").toContain(`orch_token=${l.token}`)

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
  const cookie = c.cookie === undefined ? `orch_token=${l.token}` : c.cookie
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
  expect(records[2]).toEqual({ kind: "cli", event: { type: "assistant", seq: 1 } })
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
  expect(records[1]).toEqual({ kind: "cli", event })
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
    headers: { Host: `127.0.0.1:${l.port}`, Accept: "text/event-stream", Cookie: `orch_token=${l.token}` },
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
    headers: { Host: `127.0.0.1:${l.port}`, Cookie: `orch_token=${l.token}` },
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
  expect((await call(l, { path: "/api/runs/abc/stream", cookie: `orch_token=${l.token}x` })).status).toBe(401)
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
  const handler = ROUTES[STREAM_ROUTE]
  if (handler === undefined) throw new Error(`${STREAM_ROUTE} is not registered`)
  const ctx: RouteContext = {
    token: "unused",
    port: 3100,
    dev: false,
    devPort: 5173,
    hosts: new Set(),
    origins: new Set(),
    runsDir: dir,
    streamPollMs: 2,
    streamKeepAliveMs: 1000,
  }

  for (const id of ["..", ".", "", "a/b", "a\\b", "a\0b"]) {
    const res = await handler(new Request("http://127.0.0.1:3100/api/runs/x/stream"), ctx, { id })
    expect(res.status, `id ${JSON.stringify(id)}`).toBe(400)
    expect(res.headers.get("content-type")).toStartWith("application/json")
    await res.body?.cancel()
  }
  expect(await readdir(dir)).toEqual([])
})
