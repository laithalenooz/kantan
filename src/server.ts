import { randomBytes, timingSafeEqual } from "node:crypto"
import type { Server } from "bun"

/**
 * The local HTTP server, and the guard chain that runs ahead of every route.
 *
 * These endpoints hand arbitrary text to an agent with file-write and shell
 * access, so "it only listens on localhost" is not sufficient protection:
 *
 * - Any page the owner visits can POST to a localhost port. The browser sends
 *   it willingly; the same-origin policy only stops the page reading the
 *   response, which is no comfort for an endpoint that *starts work*.
 * - DNS rebinding defeats the naive assumption: the attacker's domain resolves
 *   to their server, then re-resolves to 127.0.0.1, and their page is now
 *   same-origin with us. The `Host` header is what catches that, which is why
 *   an absent `Host` is refused rather than read as local.
 *
 * Both guards *accept* input, so the usual costs invert: over-accepting is a
 * vulnerability and over-rejecting is a tool that will not start. Hence exact
 * matching against an allowlist, with no normalisation step anywhere - a
 * suffix match on `localhost` would accept `localhost.evil.com`, and a prefix
 * match on `127.0.0.1` would accept `127.0.0.1.evil.com`.
 */

const LOOPBACK = "127.0.0.1"
const DEFAULT_PORT = 3100
/** Vite's default. Only ever consulted in dev mode. */
const DEFAULT_DEV_PORT = 5173
const TOKEN_COOKIE = "orch_token"

export interface ServerOptions {
  /** 0 asks the OS for a free port. There is deliberately no `hostname`: a
   * wide bind should take a code edit, not a configuration mistake. */
  port?: number
  /** Allows the Vite dev server's origin. Off unless asked, so the exception
   * can be turned off - one that cannot is not an exception. */
  dev?: boolean
  devPort?: number
}

export interface Launch {
  /** `Server<undefined>` is what `Bun.serve` returns without a websocket
   * handler, which this server has no use for: SSE carries the run stream. */
  server: Server<undefined>
  /** Per launch, in memory only, never written to disk. */
  token: string
  /** The port actually bound, which differs from the request when it was 0. */
  port: number
  stop(): void
}

/** What a route handler is given besides the request. */
export interface RouteContext {
  token: string
  port: number
  dev: boolean
  devPort: number
  /** Exact-match allowlists, built from the port we actually bound. */
  hosts: ReadonlySet<string>
  origins: ReadonlySet<string>
}

export type RouteHandler = (req: Request, ctx: RouteContext) => Response | Promise<Response>

/** Replaced by the built `dist/` in Task 20. Its job today is to carry the
 * cookie, so it must not carry the token in its body: a page that can read a
 * response would gain exactly what HttpOnly is hiding. */
const INDEX_STUB = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>kantan</title></head>
<body><p>kantan is running. The UI arrives in a later task.</p></body></html>
`

/**
 * The route table. Tasks 17 and 18 add their entries **here**, not to
 * `Bun.serve`, because `Bun.serve({ routes })` matches before the `fetch`
 * handler runs and a route registered there would never meet the guards.
 */
export const ROUTES: Record<string, RouteHandler> = {
  /** Page load, and where the cookie comes from. */
  "GET /": (_req, ctx) =>
    new Response(INDEX_STUB, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Set-Cookie": tokenCookie(ctx),
      },
    }),

  /** The same bootstrap, reachable through Vite's `/api` proxy. In dev, Vite
   * serves index.html, so the browser never loads our "/" and the cookie has
   * to arrive this way. */
  "GET /api/session": (_req, ctx) =>
    Response.json({ ok: true, dev: ctx.dev }, { headers: { "Cache-Control": "no-store", "Set-Cookie": tokenCookie(ctx) } }),

  "GET /api/health": () => Response.json({ ok: true }),
}

/**
 * The only routes that may answer without a token: a browser cannot have the
 * cookie before something hands it one. Everything else is non-exempt by
 * default, so a new route is guarded unless someone deliberately widens this.
 */
export const TOKEN_EXEMPT: ReadonlySet<string> = new Set(["GET /", "GET /api/session"])

/** Session-lifetime on purpose: the token dies with the launch, so a cookie
 * that outlived it would only produce a confusing 401 after a restart.
 * No `Secure`, which a browser would honour by dropping the cookie over http. */
function tokenCookie(ctx: RouteContext): string {
  return `${TOKEN_COOKIE}=${ctx.token}; Path=/; HttpOnly; SameSite=Strict`
}

function allowedHosts(port: number, dev: boolean, devPort: number): Set<string> {
  const hosts = new Set([`${LOOPBACK}:${port}`, `localhost:${port}`])
  if (dev) {
    // http-proxy forwards the browser's Host unchanged unless `changeOrigin`
    // is set, so in dev the Vite authority can arrive here. Still loopback
    // names, so the rebinding guard holds; and only when dev mode is on.
    hosts.add(`${LOOPBACK}:${devPort}`)
    hosts.add(`localhost:${devPort}`)
  }
  return hosts
}

function allowedOrigins(port: number, dev: boolean, devPort: number): Set<string> {
  const origins = new Set([`http://${LOOPBACK}:${port}`, `http://localhost:${port}`])
  if (dev) {
    origins.add(`http://${LOOPBACK}:${devPort}`)
    origins.add(`http://localhost:${devPort}`)
  }
  return origins
}

/** Names the guard that refused, because a reverse proxy in front of this is
 * the likeliest cause and the README tells people not to loosen the checks to
 * make one work. It never echoes the offending value: that is attacker-chosen
 * text, and it never carries the token. */
function refuse(status: number, message: string): Response {
  return Response.json({ error: message }, { status })
}

/**
 * Accepts if **any** `orch_token` value matches. Cookies ignore ports, so any
 * page on another localhost port can set one for this host; it cannot know the
 * real value, so the browser sends both and taking the first would turn a
 * decoy into a denial of service. Accepting any match cannot be a bypass,
 * since a bypass still needs the real token.
 *
 * No normalisation: values are compared as sent. Nothing strips quotes or
 * trims, because every such step is a place for the next trap to hide.
 */
function hasToken(req: Request, token: string): boolean {
  const header = req.headers.get("cookie")
  if (header === null) return false
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=")
    if (eq === -1) continue
    if (pair.slice(0, eq).trim() !== TOKEN_COOKIE) continue
    if (sameSecret(pair.slice(eq + 1), token)) return true
  }
  return false
}

function sameSecret(given: string, token: string): boolean {
  const a = Buffer.from(given, "utf8")
  const b = Buffer.from(token, "utf8")
  // timingSafeEqual throws on a length mismatch, and the token's length is
  // fixed, so the early return leaks nothing.
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * `Host` first, then `Origin`, from the **raw headers**.
 *
 * Never from `new URL(req.url)`: Bun builds `req.url` from the `Host` header
 * and the URL parser canonicalises, so `Host: 2130706433:3100` arrives as
 * `http://127.0.0.1:3100/...` and would pass a URL-based check (probed). A
 * `Host` that is not a valid authority makes `req.url` relative, so parsing it
 * throws - which is the other reason this runs before any URL parsing.
 */
function checkRequest(req: Request, ctx: RouteContext): Response | null {
  const host = req.headers.get("host")
  if (host === null || !ctx.hosts.has(host)) {
    return refuse(403, `refused: the Host header must be exactly ${[...ctx.hosts].join(" or ")}`)
  }

  const origin = req.headers.get("origin")
  if (origin === null) {
    // A top-level navigation sends no Origin, so refusing an absent one would
    // refuse page loads. Browsers do send it on every method other than GET
    // and HEAD, including cross-site form posts, so absent there means the
    // request did not come from a browser. Keyed on the method rather than on
    // POST alone, or a later DELETE would slip through.
    if (req.method !== "GET" && req.method !== "HEAD") {
      return refuse(403, "refused: this method requires an Origin header from this server's own origin")
    }
  } else if (!ctx.origins.has(origin)) {
    // Includes the literal "null" that a sandboxed iframe or a file: page
    // sends, and the empty string, neither of which is an allowlist member.
    return refuse(403, `refused: the Origin header must be exactly ${[...ctx.origins].join(" or ")}`)
  }

  return null
}

function handle(req: Request, ctx: RouteContext): Response | Promise<Response> {
  const refused = checkRequest(req, ctx)
  if (refused !== null) return refused

  // Safe here: the Host passed the allowlist, so the authority is valid. The
  // base is belt and braces for the relative shape described above.
  const path = new URL(req.url, `http://${LOOPBACK}:${ctx.port}`).pathname
  const key = `${req.method} ${path}`

  if (!TOKEN_EXEMPT.has(key) && !hasToken(req, ctx.token)) {
    return refuse(401, `refused: no valid ${TOKEN_COOKIE} cookie; load http://${LOOPBACK}:${ctx.port}/ to be given one`)
  }

  const route = ROUTES[key]
  if (route === undefined) return refuse(404, "no such route")
  return route(req, ctx)
}

export function createServer(opts: ServerOptions = {}): Launch {
  const dev = opts.dev ?? false
  const devPort = opts.devPort ?? DEFAULT_DEV_PORT
  const requested = opts.port ?? DEFAULT_PORT

  // Filled in below once the real port is known, which matters when the
  // request was 0. No request can arrive before Bun.serve() returns.
  const ctx: RouteContext = {
    token: randomBytes(32).toString("base64url"),
    port: requested,
    dev,
    devPort,
    hosts: new Set(),
    origins: new Set(),
  }

  const server = Bun.serve({
    hostname: LOOPBACK,
    port: requested,
    fetch: (req) => handle(req, ctx),
  })

  // `port` is optional because a unix-socket server has none, and we never ask
  // for one. Worth naming rather than asserting: every allowlist is built from
  // this number, so a silent fallback would build the wrong one.
  const port = server.port
  if (port === undefined) {
    server.stop(true)
    throw new Error("Bun.serve bound no TCP port, so the Host allowlist cannot be built")
  }

  ctx.port = port
  ctx.hosts = allowedHosts(port, dev, devPort)
  ctx.origins = allowedOrigins(port, dev, devPort)

  return { server, token: ctx.token, port, stop: () => server.stop(true) }
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`ORCH_PORT must be a port number between 1 and 65535, got ${JSON.stringify(raw)}`)
  }
  return port
}

if (import.meta.main) {
  const dev = process.env.ORCH_DEV === "1"
  const launch = createServer({ port: parsePort(process.env.ORCH_PORT), dev })
  // The token is not printed: it belongs in the cookie, and a terminal is a
  // place things get pasted from.
  console.log(`kantan on http://${LOOPBACK}:${launch.port}${dev ? " (dev: Vite origin allowed)" : ""}`)
}
