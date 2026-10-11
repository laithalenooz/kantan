import { afterAll, expect, test } from "bun:test"
import { connect } from "node:net"
import { networkInterfaces } from "node:os"
import { ROUTES, TOKEN_EXEMPT, createServer, type Launch } from "../src/server"

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
