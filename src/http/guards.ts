/**
 * The chain that runs ahead of every route, and the two ways to say no.
 *
 * Lifted out of `src/server.ts` unchanged. It is the part of that module with
 * the least to do with any particular resource and the most to do with every
 * one of them, which is also why it is first in the file's own section
 * comments - the seams were already marked, and this follows them.
 *
 * The reasoning for each check stays with the check. It is the most
 * security-relevant code here and the sentences explaining *why* a loosening is
 * unsafe are the point of it; a reader who finds this module without them would
 * be one refactor away from making a reverse proxy work by widening a set.
 */

import { timingSafeEqual } from "node:crypto"

import type { RouteContext } from "./context"

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
 *
 * The one streaming route lives here too. Design §4.4: SSE carries the run
 * stream, and on connect the server replays the run's JSONL from byte 0 before
 * following it live. That is what makes closing the browser safe - the server
 * owns the child process, so a reconnecting client replays everything and then
 * tails, with no cursor and no reconnect state machine.
 *
 * Every action - start, approve, feedback, answer, raise, resume, stop, and
 * registering, editing or removing a project - uses a method a browser sends an
 * `Origin` with, and that is not a stylistic choice. `SameSite=Strict`
 * ignores **ports**, so a page on any other localhost port is same-site: its
 * no-cors GETs (an `img`, a `script`, a navigation) carry the auth cookie and
 * send no `Origin`. A convenience GET that started a run would be reachable
 * from every other local page on this machine.
 *
 * None of the seven run actions does any orchestration here. They validate a
 * request and hand it to the `Runner` the server was constructed with - the
 * phase machine - so the states a run can be in are decided in one place
 * rather than encoded a second time in a status code.
 *
 * Registration is the exception, and deliberately so: there is no run and no
 * machine involved, only `src/projects.ts`'s store plus the one check the store
 * cannot make, which is whether the path is a git repository kantan could run
 * in at all.
 */

export const LOOPBACK = "127.0.0.1"

export const DEFAULT_PORT = 3100

/** Vite's default. Only ever consulted in dev mode. */
export const DEFAULT_DEV_PORT = 5173

/**
 * The session cookie's name.
 *
 * Renamed with everything else, and **without a fallback**, unlike the state
 * directory and the environment variables. It needs none: the token is minted
 * per launch, so a cookie from before this change already names a token that
 * no longer exists and is already refused. There is nothing to be compatible
 * with.
 */
export const TOKEN_COOKIE = "kantan_token"

/** Session-lifetime on purpose: the token dies with the launch, so a cookie
 * that outlived it would only produce a confusing 401 after a restart.
 * No `Secure`, which a browser would honour by dropping the cookie over http. */
export function tokenCookie(ctx: RouteContext): string {
  return `${TOKEN_COOKIE}=${ctx.token}; Path=/; HttpOnly; SameSite=Strict`
}

export function allowedHosts(port: number, dev: boolean, devPort: number): Set<string> {
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

export function allowedOrigins(port: number, dev: boolean, devPort: number): Set<string> {
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
export function refuse(status: number, message: string): Response {
  return Response.json({ error: message }, { status })
}

/**
 * Accepts if **any** `kantan_token` value matches. Cookies ignore ports, so any
 * page on another localhost port can set one for this host; it cannot know the
 * real value, so the browser sends both and taking the first would turn a
 * decoy into a denial of service. Accepting any match cannot be a bypass,
 * since a bypass still needs the real token.
 *
 * No normalisation: values are compared as sent. Nothing strips quotes or
 * trims, because every such step is a place for the next trap to hide.
 */
export function hasToken(req: Request, token: string): boolean {
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
export function checkRequest(req: Request, ctx: RouteContext): Response | null {
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

/** The reason goes to the terminal, which on a local server is where a surprise
 * belongs, and never into the body: a fault's message can carry a local path or
 * whatever else the failing code was holding. */
export function fault(key: string, cause: unknown): Response {
  console.error(`${key} failed:`, cause)
  return refuse(500, "the server failed to handle that request; its terminal has the reason")
}

// --- Registering a project --------------------------------------------------

/** `what` names the thing that cannot be done, because this answers the tree,
 * registration, removal, an edit and a draft, and "it cannot register a
 * project" was already the wrong sentence for three of them. */
export function noStore(what: string): Response {
  return refuse(503, `refused: this server was launched without a project store, so it cannot ${what}`)
}
