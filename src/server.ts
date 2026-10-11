import { randomBytes, timingSafeEqual } from "node:crypto"
import { stat } from "node:fs/promises"
import type { Server } from "bun"
import { defaultRunsDir, replay, runLogPath } from "./runlog"
import type { RunRecord } from "./runlog"

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
 * The four actions - start, approve, feedback, stop - are all `POST`, and that
 * is not a stylistic choice. `SameSite=Strict` ignores **ports**, so a page on
 * any other localhost port is same-site: its no-cors GETs (an `img`, a
 * `script`, a navigation) carry the auth cookie and send no `Origin`. A
 * convenience GET that started a run would be reachable from every other local
 * page on this machine.
 *
 * None of them does any orchestration here. They validate a request and hand
 * it to the `Runner` the server was constructed with - the phase machine - so
 * the states a run can be in are decided in one place rather than encoded a
 * second time in a status code.
 */

const LOOPBACK = "127.0.0.1"
const DEFAULT_PORT = 3100
/** Vite's default. Only ever consulted in dev mode. */
const DEFAULT_DEV_PORT = 5173
const TOKEN_COOKIE = "orch_token"
/** `replay`'s own default, not a second opinion about it. */
const DEFAULT_STREAM_POLL_MS = 50
/**
 * Comfortably inside **Bun's own** idle timeout, which is the binding one.
 *
 * Probed, and this settles HANDOFF's open question: `Bun.serve` defaults to
 * `idleTimeout: 10` and cuts the connection at about twelve seconds, warning
 * "Bun.serve() timed out a request after 10 seconds". An **outgoing** write
 * does reset that timer - a stream writing every 8s survived 26s, while one
 * writing every 15s died at 12s with ECONNRESET. So a keep-alive works, but
 * only under the window: 15s, which this was, never fires.
 *
 * No test pins the number, because the shortest honest one waits out the window
 * and would cost the suite twelve seconds for a constant. The tests set their
 * own interval in milliseconds, so they prove the mechanism and are blind to
 * this value - which is how the 15s got here. A run waiting at the gate is idle
 * for as long as the human takes, which is the case that breaks.
 */
const DEFAULT_STREAM_KEEP_ALIVE_MS = 5_000

// --- The seam to the phase machine -----------------------------------------

/**
 * The task a start request names, in the three parts that identify one.
 *
 * Nothing here is resolved: `projectPath` is a key into `projects.json` and not
 * a repo the server has looked at, and `featureFile` is a path **from a request
 * body**, in the same escape class as a run id. The machine owns both lookups,
 * because it is the one that already holds the project record, the parse-time
 * bytes of the feature file and the git guards - and because `featureFile` is a
 * path `tickTask` later *writes* to, so whoever refuses an absolute path or a
 * `..` in it must be the code that joins it, not a layer above.
 */
export interface StartRequest {
  /** The repo, spelled as `projects.json` spells it: the record's identity. */
  projectPath: string
  /** The feature markdown, relative to the repo root. */
  featureFile: string
  /** The `T<n>` label inside that file. */
  taskRef: string
}

/**
 * Why the machine would not do what was asked.
 *
 * A code rather than a message alone, because two refusals that share a status
 * need different UI: `dirty` carries `git stash` advice to show, `busy` points
 * at a run already going. The status mapping is `ACTION_STATUS` below.
 */
export type Refusal =
  | "unknown-project"
  | "unknown-feature"
  | "unknown-task"
  | "unknown-run"
  /** The project already has an active run. One per project is the collision
   * guard (design §7), so this is a normal answer and not an error. */
  | "busy"
  /** The repo has uncommitted work, so a new run there could commit over it. */
  | "dirty"
  /** The run exists and is in a state that does not take this action: approving
   * a run that is not at the gate, stopping one that has already finished. */
  | "wrong-state"

export interface Refused {
  ok: false
  refusal: Refusal
  /**
   * Shown to the human as written, so it is **the machine's** prose and never
   * the caller's. `src/git.ts` names the dirty files and the stash that clears
   * them; forwarding that is the whole point, and a bare "repo is dirty" would
   * be a bad experience when the fix is one command. Nothing from a request
   * body may be quoted back into it.
   */
  message: string
}

export type Started = { ok: true; runId: string } | Refused
export type Acted = { ok: true } | Refused

/**
 * The phase machine, as these four routes need it. `src/run.ts` (Task 13)
 * satisfies it; the server is constructed with one so a test can inject a
 * double, and so this file imports nothing from the machine.
 *
 * Four facts this interface is making a promise about:
 *
 * 1. **An expected refusal comes back as a tagged result, not a throw.** Every
 *    state question - busy, dirty, not at the gate, no such run - is a `Refused`
 *    with a code. A rejection means a fault, and the server answers 500 and
 *    logs it. Sniffing an `Error` message for "dirty" would be the alternative,
 *    and it would break on a reworded sentence.
 * 2. **Each call resolves once the transition is accepted**, not when the work
 *    finishes: the run registered and the child spawned, or the signal sent. A
 *    phase runs for minutes and an HTTP request cannot wait for one - Bun cuts
 *    an idle connection at about ten seconds (HANDOFF), and everything after
 *    the transition reaches the client through the run stream anyway.
 * 3. **The machine decides the state rule, and the server never reads the run
 *    log or the index to second-guess it.** Encoding "which states accept
 *    feedback" in both places would put the answer in two files and race
 *    between the asking and the doing - the same race a separate `isBusy` query
 *    would open on start.
 * 4. **The machine is the only writer of a run log.** The server appends no
 *    `human` record for an approval or a feedback: one writer per log, and the
 *    machine is holding it open.
 */
export interface Runner {
  /** Resolves once the run is registered and its plan phase is spawned. */
  start(request: StartRequest): Promise<Started>
  /** Approves the plan at the gate, which starts a **fresh** implement session
   * (design §3.1). `wrong-state` for a run that is not waiting at the gate. */
  approve(runId: string): Promise<Acted>
  /**
   * Replaces approval with the human's words, resuming the **plan** session.
   *
   * `text` is passed through byte for byte, exactly as the human typed it:
   * `src/spawn.ts` puts a prompt into a stream-json user message on the child's
   * **stdin**, so `JSON.stringify` escapes every byte of it and there is no
   * shell and no argv length to respect. The server judges emptiness on a
   * trimmed copy and forwards the original.
   */
  feedback(runId: string, text: string): Promise<Acted>
  /**
   * Stops the run and leaves it **resumable**: SIGTERM the child, per
   * `src/spawn.ts`'s `terminate`, which deliberately does not close stdin or
   * clean up, because the session resumes from the same id and stopping
   * therefore costs nothing.
   *
   * A run waiting at the gate holds no process at all (design §3.1), so what
   * `stop` means there is a question only the machine can answer - at minimum
   * the project must stop being `busy`, or nothing else could ever start. A run
   * that has already reached `done` or `failed` is `wrong-state`.
   */
  stop(runId: string): Promise<Acted>
}

export interface ServerOptions {
  /** 0 asks the OS for a free port. There is deliberately no `hostname`: a
   * wide bind should take a code edit, not a configuration mistake. */
  port?: number
  /** Allows the Vite dev server's origin. Off unless asked, so the exception
   * can be turned off - one that cannot is not an exception. */
  dev?: boolean
  devPort?: number
  /** Where the run logs are. Defaults to `~/.orch/runs`; injectable so a test
   * never reads or writes the developer's own history. */
  runsDir?: string
  /** How often a followed run log is checked for appended bytes. */
  streamPollMs?: number
  /** How often an idle run stream sends a keep-alive comment. */
  streamKeepAliveMs?: number
  /** The phase machine the four actions drive. Absent means a server that can
   * serve pages and stream run logs but cannot drive a run, which answers 503
   * on every action rather than 500 or a missing route. */
  runner?: Runner
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
  /** Resolved from `ServerOptions`, so a handler never consults a default. */
  runsDir: string
  streamPollMs: number
  streamKeepAliveMs: number
  /** `null` when the server was launched without one. Nullable rather than
   * optional so a handler cannot forget the case. */
  runner: Runner | null
}

/**
 * `params` holds the `:name` segments of the key the route was registered
 * under, **as sent**: dispatch percent-decodes nothing, and this is no place
 * to start. It is optional so a static route can keep taking two arguments.
 */
export type RouteHandler = (
  req: Request,
  ctx: RouteContext,
  params?: Readonly<Record<string, string>>,
) => Response | Promise<Response>

/** Replaced by the built `dist/` in Task 20. Its job today is to carry the
 * cookie, so it must not carry the token in its body: a page that can read a
 * response would gain exactly what HttpOnly is hiding. */
const INDEX_STUB = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>kantan</title></head>
<body><p>kantan is running. The UI arrives in a later task.</p></body></html>
`

/**
 * The route table. Every entry goes **here**, not into `Bun.serve`, because
 * `Bun.serve({ routes })` matches before the `fetch` handler runs and a route
 * registered there would never meet the guards.
 *
 * A key is `METHOD /path`, matched exactly, except that a `:name` segment
 * matches one non-empty path segment and arrives in the handler's `params`.
 * Patterns are resolved by `matchRoute`, **after** the guard chain.
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

  /** The run stream. `:id` is a run id, which reaches here from a URL and is
   * handed to `runLogPath` exactly as sent. */
  "GET /api/runs/:id/stream": (req, ctx, params) => streamRunLog(req, ctx, params?.["id"] ?? ""),

  // The four actions, design §4.4. POST, never GET: see the module header.
  "POST /api/runs": (req, ctx) => startRun(req, ctx),
  "POST /api/runs/:id/approve": (req, ctx, params) => approveRun(req, ctx, params?.["id"] ?? ""),
  "POST /api/runs/:id/feedback": (req, ctx, params) => feedbackOnRun(req, ctx, params?.["id"] ?? ""),
  "POST /api/runs/:id/stop": (req, ctx, params) => stopRun(req, ctx, params?.["id"] ?? ""),
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

  const matched = matchRoute(key)
  if (matched === null) return refuse(404, "no such route")

  // A handler that throws, or whose promise rejects, would otherwise be Bun's
  // own 500 - which on a rejection inside a route says nothing useful. The
  // actions make this reachable: the phase machine answers every state
  // question with a tagged refusal, so anything thrown from one is a fault.
  // The synchronous path stays synchronous, so the stream route is untouched.
  try {
    const answer = matched.route(req, ctx, matched.params)
    return answer instanceof Promise ? answer.catch((cause: unknown) => fault(key, cause)) : answer
  } catch (cause) {
    return fault(key, cause)
  }
}

/** The reason goes to the terminal, which on a local server is where a surprise
 * belongs, and never into the body: a fault's message can carry a local path or
 * whatever else the failing code was holding. */
function fault(key: string, cause: unknown): Response {
  console.error(`${key} failed:`, cause)
  return refuse(500, "the server failed to handle that request; its terminal has the reason")
}

/**
 * `ROUTES[key]` first, then the patterns among its keys.
 *
 * This runs **after** the guard chain, and a pattern can never make a route
 * token-exempt: the check above keys on the request's own literal
 * `METHOD /path`, which is never a pattern string. Widening `TOKEN_EXEMPT` has
 * to be a deliberate edit, and a pattern is not one.
 *
 * Exactness is unchanged for everything else. No percent-decoding, no
 * trailing-slash normalisation, no case folding: a `:name` segment matches one
 * whole path segment and is handed over as sent.
 *
 * Patterns are tried in declaration order and the first match wins. The four
 * that exist cannot overlap: the method is segment 0 of the key and the verb is
 * the last segment, so `POST /api/runs/x/stop` meets exactly one of them. Two
 * patterns able to match a single path would be a mistake in the table rather
 * than a precedence question to settle here.
 */
function matchRoute(key: string): { route: RouteHandler; params: Record<string, string> } | null {
  // A pattern's own key is also a requestable path - `/api/runs/:id/stream`
  // arrives with its colon intact, since nothing decodes or rewrites it. Taking
  // the exact branch for that one spelling would match a route and hand it no
  // `:id` at all, so it alone would behave unlike every neighbouring path. It
  // goes to the matcher instead, where `:id` is an ordinary segment.
  const exact = isPattern(key) ? undefined : ROUTES[key]
  if (exact !== undefined) return { route: exact, params: {} }
  for (const [pattern, route] of Object.entries(ROUTES)) {
    if (!isPattern(pattern)) continue
    const params = matchPattern(pattern, key)
    if (params !== null) return { route, params }
  }
  return null
}

/** A key with a `:name` segment in it. `/:` and not `:`, so an id that merely
 * contains a colon is not mistaken for a pattern. */
function isPattern(key: string): boolean {
  return key.includes("/:")
}

/**
 * The `:name` values if `key` matches `pattern`, otherwise `null`.
 *
 * A matcher is a guard that decides whether to skip a route, so what a `:name`
 * segment may hold is enumerated rather than sampled. The dimension is one
 * path segment of an already-parsed pathname, and the two directions cost
 * differently: over-accepting hands a string to `runLogPath`, over-rejecting
 * costs a 404 on a path nothing generates. Hence: exactly one segment, never
 * empty, never decoded.
 *
 * - `/a/b` cannot be one segment, so a two-segment id does not match.
 * - `..` and `.` never arrive: the URL parser resolves dot segments, and turns
 *   a backslash into a slash, before dispatch sees the pathname.
 * - `..%2F..%2Fetc%2Fpasswd` arrives whole and stays whole, because nothing
 *   decodes it. That is why `%2F` cannot put back the separator the parser
 *   just resolved away, and why `runLogPath` sees a filename rather than a
 *   path. Decoding here is the single edit that would turn this into a
 *   traversal.
 * - An empty segment (`//`) survives URL parsing and is refused, which spends
 *   a 404 rather than asking `runLogPath` to reject the empty id.
 */
function matchPattern(pattern: string, key: string): Record<string, string> | null {
  // Splitting the whole key means segment 0 carries the method, so a method
  // mismatch fails as an ordinary segment mismatch.
  const want = pattern.split("/")
  const got = key.split("/")
  if (want.length !== got.length) return null

  const params: Record<string, string> = {}
  for (const [i, segment] of want.entries()) {
    const seen = got[i]
    if (seen === undefined) return null
    if (!segment.startsWith(":")) {
      if (segment !== seen) return null
      continue
    }
    if (seen === "") return null
    params[segment.slice(1)] = seen
  }
  return params
}

// --- The run stream ---------------------------------------------------------

/**
 * `text/event-stream`, plus everything needed to stop something between us and
 * the browser from holding on to it. A reverse proxy is not part of this
 * design, but someone will put one there, and a buffered SSE stream looks like
 * a hung run rather than a misconfiguration - so `X-Accel-Buffering` is cheap
 * insurance against a bug report nobody can reproduce.
 */
const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  // A cached run stream would replay a finished run as though it were live.
  "Cache-Control": "no-store",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
}

/**
 * An SSE comment: a line every client must ignore, so it can never arrive as a
 * record. Sent on a timer because a run waiting at the gate is idle for as long
 * as the human takes, and an idle connection is what a proxy or a browser
 * reclaims.
 */
const SSE_KEEP_ALIVE = ": keep-alive\n\n"

/** One message for every way an existing-looking id turns out to name no log,
 * so a missing file and a file that is not one read the same. */
const NO_SUCH_RUN = "no such run: there is no log for that run id"

/**
 * **One SSE event per log record**, named `record`, carrying the record itself.
 *
 * Not one event name per `kind`. The log's own rule is that a record whose kind
 * this version does not know passes through rather than being dropped, and an
 * `addEventListener` per kind has no listener at all for a kind a newer writer
 * invented - the record would arrive and vanish. So the name is constant and
 * the client switches on `data.kind`, where an unknown kind is visible.
 *
 * **Not batched**, though a run can emit thousands of records. Batching would
 * put a second framing layer on top of the one `runlog.ts` already does, with
 * its own boundary to lose or duplicate a record at - and that boundary is the
 * one place a stream like this actually breaks, which is why `replay` was left
 * owning partial lines alone. What batching buys is fewer client-side event
 * dispatches during the initial replay; what it costs is the invariant that one
 * record on disk is one event on the wire. The UI virtualises the list, so its
 * render cost is already independent of the record count, and coalescing state
 * updates is something it can do on its own side without the transport having
 * to guess a batch size.
 *
 * There is deliberately **no `id:` field**. An id invites `Last-Event-ID`,
 * which is the reconnect state machine design §4.4 rejects: replay is from byte
 * 0 every time, so there is no cursor to get wrong.
 */
function sseFrame(event: string, data: unknown): string {
  // One `data:` line is always enough: JSON.stringify escapes U+000A and
  // U+000D, so a serialised record can hold neither the newline that would end
  // the line nor the blank line that would end the event.
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/**
 * Whether the stream should stop after this record.
 *
 * `replay` deliberately does not stop at `end` - deciding a record is terminal
 * is interpretation, and `runlog.ts` is framing - so this is where the
 * interpretation belongs. The dimension is `kind === "end"`, whose values are
 * the six kinds this version writes plus any a newer writer invents, and the
 * two directions are nowhere near symmetric:
 *
 * - **Stop when a record still follows on disk.** That record never reaches a
 *   client, and never will, since a reconnect replays from byte 0 and stops at
 *   `end` again. Nothing in this orchestrator writes past `end`: the run is
 *   over and the log is closed. The cost is bounded and visible.
 * - **Never stop.** A poller and an open file descriptor per connection, for
 *   the life of the process, including on *finished* runs - which is the common
 *   case, because browsing history opens them. It accumulates silently in
 *   ordinary use, which is the worst shape a leak can have.
 *
 * So this fails toward stopping. Waiting a grace period after `end` to drain a
 * late append was rejected: it swaps a rule for a timing guess, against a case
 * that does not exist.
 */
function isTerminal(record: RunRecord): boolean {
  return record.kind === "end"
}

/**
 * `runLogPath`'s answer for `id`, or `null` where it refuses the id.
 *
 * `runLogPath` throws for an id that could name anything but a file directly
 * inside the runs directory. Every `:id` route runs it, including the three
 * actions that never open the file themselves: the id reaches them from a URL,
 * so it is caller input, and the alternative to deciding here is handing the
 * machine an id it would pass to `runLogPath` itself - where the throw becomes
 * a rejected promise inside a route, which is a 500 saying nothing.
 */
function runLogPathFor(id: string, runsDir: string): string | null {
  try {
    return runLogPath(id, runsDir)
  } catch {
    return null
  }
}

/** `runLogPath`'s own message is not forwarded: it quotes the id back and names
 * the runs directory, and `refuse` echoes neither caller-chosen text nor a
 * local path into a body a page may be able to read. */
const UNUSABLE_RUN_ID = "refused: that is not a usable run id"

/**
 * The run stream: the whole log from byte 0, then the records appended after
 * that, as SSE.
 */
async function streamRunLog(req: Request, ctx: RouteContext, id: string): Promise<Response> {
  const path = runLogPathFor(id, ctx.runsDir)
  if (path === null) return refuse(400, UNUSABLE_RUN_ID)

  // Before the stream opens, not inside it. Once a 200 and the SSE content
  // type are on the wire the status cannot be taken back, so a missing log
  // would become a stream that opened and immediately died - and a run id
  // arriving from a URL makes "no such run" a common case, not a rare one.
  // The gap between this and `replay`'s own open can only be closed by a
  // delete, which then shows up as the stream ending.
  // `isFile` and not merely "exists": a directory opens for reading on Linux
  // and only fails at the first read, which would be a 200 that dies. A run
  // log is always a regular file, so refusing anything else costs nothing.
  try {
    if (!(await stat(path)).isFile()) return refuse(404, NO_SUCH_RUN)
  } catch {
    // Never echoes the id: that is caller-chosen text.
    return refuse(404, NO_SUCH_RUN)
  }

  return new Response(runLogBody(path, req, ctx), { headers: SSE_HEADERS })
}

/**
 * **The abort is the load-bearing part of this function.**
 *
 * `replay({ follow: true })` ends only on its signal - never at the `end`
 * record - so without an abort every closed tab leaves a poller and an open
 * file descriptor behind, on runs that have already finished as well as live
 * ones. Nothing in `replay`'s type signature hints at it.
 *
 * Probed: Bun aborts `req.signal` *and* calls the stream's `cancel` when the
 * client goes, so both are wired to the same abort. One would do; neither is a
 * place to be clever, because the failure is invisible until descriptors run
 * out.
 */
function runLogBody(path: string, req: Request, ctx: RouteContext): ReadableStream<Uint8Array> {
  const abort = new AbortController()
  const stop = () => abort.abort()
  req.signal.addEventListener("abort", stop, { once: true })

  const bytes = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // Probed: Bun flushes the headers and every enqueued chunk while start()
      // is still pending, so the replay can live here rather than in `pull`.
      const keepAlive = setInterval(() => send(controller, bytes.encode(SSE_KEEP_ALIVE)), ctx.streamKeepAliveMs)
      try {
        for await (const record of replay(path, { follow: true, signal: abort.signal, pollMs: ctx.streamPollMs })) {
          send(controller, bytes.encode(sseFrame("record", record)))
          if (!isTerminal(record)) continue
          // The record itself went first, so nothing is withheld from the fold
          // of the log. This frame is how "the run is over, stop reconnecting"
          // is said out loud: a stream that merely drops is indistinguishable
          // from a dropped connection, which EventSource is right to retry.
          send(controller, bytes.encode(sseFrame("eof", { reason: "end" })))
          break
        }
      } catch (e) {
        // A read that fails mid-stream - the log deleted under us, most
        // likely. The client cannot act on the reason and gets no `eof`, so it
        // reconnects and meets either a working stream or a 404 that says so
        // plainly. Logged rather than swallowed, because this is a local
        // server and its terminal is where a surprise belongs.
        console.error(`run stream ${path} stopped early:`, e)
      } finally {
        // Leaving the loop any other way than by the signal still aborts it,
        // or `replay` would be left polling a file nobody reads.
        //
        // No test pins this line: `break` happens while the generator is
        // suspended at its `yield`, so the implicit `return()` runs replay's
        // own `finally` and closes the descriptor either way - removing this
        // leaves the suite green (proven). It stays because that argument
        // depends on where the generator happens to be suspended, and the
        // failure it would cause is a descriptor that nothing ever closes.
        stop()
        clearInterval(keepAlive)
        try {
          controller.close()
        } catch {
          // Already closed, because the client went away first.
        }
      }
    },
    cancel: stop,
  })
}

/** Enqueues unless the client has already gone, in which case there is nothing
 * to do and nothing to report: the disconnect arrives through `cancel` and
 * `req.signal` regardless. */
function send(controller: ReadableStreamDefaultController<Uint8Array>, chunk: Uint8Array): void {
  try {
    controller.enqueue(chunk)
  } catch {
    // The stream is closed or errored.
  }
}

// --- The actions ------------------------------------------------------------

/**
 * How a refusal from the machine becomes a status.
 *
 * `unknown-*` is "no such thing", which is a 404. The rest are "the thing
 * exists and its state says no", which is a 409 and not a 500: a dirty repo, a
 * busy project and an approval on a run that is not at the gate are all normal
 * answers that the request itself was well-formed enough to reach. The code
 * travels in the body beside the message, because the three 409s need
 * different UI.
 */
const ACTION_STATUS: Record<Refusal, number> = {
  "unknown-project": 404,
  "unknown-feature": 404,
  "unknown-task": 404,
  "unknown-run": 404,
  busy: 409,
  dirty: 409,
  "wrong-state": 409,
}

function refuseRun(result: Refused): Response {
  return Response.json({ error: result.message, refusal: result.refusal }, { status: ACTION_STATUS[result.refusal] })
}

function acted(result: Acted): Response {
  return result.ok ? Response.json({ ok: true }) : refuseRun(result)
}

function noRunner(): Response {
  return refuse(503, "refused: this server was launched without a phase machine, so it cannot drive a run")
}

/**
 * The most a request body may be, in bytes.
 *
 * The only field that can be large is the feedback a human types at the gate,
 * and 64 KiB is roughly ten thousand words: an order of magnitude past what
 * anyone types into a textarea, with room left for a pasted diff or stack
 * trace, which is a legitimate thing to paste at a gate. Both directions were
 * weighed: a tighter cap refuses that paste, and no cap at all lets one request
 * decide how much memory the server spends, because the body is buffered before
 * a single field of it can be validated.
 */
const MAX_BODY_BYTES = 64 * 1024

type BodyText = { text: string } | { refused: Response }

/**
 * The body as text, refused if it is too large or not UTF-8.
 *
 * Read through the stream with a running total rather than through
 * `req.text()`, which buffers whatever arrives before anyone can object.
 * Probed: a chunked request declares **no** `Content-Length` at all, so a guard
 * that only read the header would be skipped by exactly the client that needed
 * capping. The header is still checked first, because refusing a declared 10 MB
 * without reading it is cheaper than reading 64 KiB of it.
 */
async function readBody(req: Request): Promise<BodyText> {
  const declared = Number(req.headers.get("content-length"))
  // `null` becomes 0 and a malformed value becomes NaN; neither is over the
  // cap, and the running total below is what catches them.
  if (declared > MAX_BODY_BYTES) return { refused: tooLarge() }

  const body = req.body
  if (body === null) return { text: "" }

  const chunks: Uint8Array[] = []
  let total = 0
  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BODY_BYTES) return { refused: tooLarge() }
      chunks.push(value)
    }
  } finally {
    // Returning early leaves the rest of the upload unread, and an unread
    // request body is a socket nothing drains.
    await reader.cancel().catch(() => {})
  }

  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  try {
    // `fatal`, so invalid UTF-8 is refused rather than silently becoming
    // U+FFFD. The large field here is the human's own words, and replacing a
    // byte of them is the expensive direction; a browser never sends anything
    // but UTF-8, so the refusal costs nothing. Decoded once over the joined
    // bytes, so a character split across two chunks survives.
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }
  } catch {
    return { refused: refuse(400, "refused: the body must be UTF-8") }
  }
}

function tooLarge(): Response {
  return refuse(413, `refused: a request body may be at most ${MAX_BODY_BYTES} bytes`)
}

/**
 * The body's fields, or the response that refuses it.
 *
 * Accepting input, so CLAUDE.md's rule applies and the dimension - the bytes of
 * the body - is enumerated rather than sampled. Over-accepting hands malformed
 * state to a run that spends money; over-rejecting means the UI cannot drive
 * the tool. The enumeration, and what each value answers:
 *
 * - **Absent, or empty.** Indistinguishable on the wire (probed: Bun declares
 *   `Content-Length: 0` for both), so they read the same: no fields. A route
 *   with required keys then refuses for a missing key, and one with none
 *   proceeds, which is the normal case for approve and stop.
 * - **Not JSON.** 400. There is no second format to try.
 * - **`null`.** 400. `typeof null === "object"`, which is the trap this check
 *   exists for.
 * - **An array**, even one holding the right record. 400, for the other half of
 *   the same trap.
 * - **A scalar.** 400: a number, a string or a boolean carries no fields.
 * - **An unknown key.** 400, for the reason `src/projects.ts` refuses one: a
 *   near-miss spelling is a setting the caller typed and would otherwise be
 *   dropped in silence. The message names **the keys the route takes** and
 *   never the key that was sent - that is caller-chosen text, and `refuse`
 *   does not echo it.
 * - **A duplicated key.** Accepted; `JSON.parse` keeps the last. One parser
 *   reads this body and nothing downstream reads it again, so there is no
 *   second opinion for a smuggled value to hide behind, and the key set the
 *   allowlist sees is unchanged either way.
 * - **A correct object.** Its fields, for the route to read.
 *
 * `Object.keys` and not a `for...in`: own enumerable keys only, which is also
 * what makes a literal `__proto__` key - which `JSON.parse` does create as an
 * own property - an ordinary unknown key rather than something clever.
 */
type ParsedBody = { fields: Record<string, unknown> } | { refused: Response }

function parseBody(text: string, allowed: readonly string[]): ParsedBody {
  if (text.trim() === "") return { fields: {} }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { refused: badBody(allowed, "the body must be JSON") }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { refused: badBody(allowed, "the body must be a JSON object") }
  }
  const fields = value as Record<string, unknown>
  for (const key of Object.keys(fields)) {
    if (!allowed.includes(key)) return { refused: badBody(allowed, "the body has a key this route does not take") }
  }
  return { fields }
}

function badBody(allowed: readonly string[], what: string): Response {
  const keys = allowed.length === 0 ? "this route takes no keys at all" : `the keys it takes are: ${allowed.join(", ")}`
  return refuse(400, `refused: ${what}; ${keys}`)
}

/**
 * `value` when it is a string with something in it, otherwise `null`.
 *
 * Emptiness is judged on a trimmed copy and the **original** is returned.
 * Nothing trimmed is ever forwarded: the one field this guards that a human
 * writes is gate feedback, and collapsing its whitespace would change what they
 * said to the agent. An all-whitespace value is still empty, because feedback
 * with nothing in it spends a planning turn on silence and a path or a task ref
 * made of spaces names nothing.
 */
function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null
}

const START_KEYS = ["projectPath", "featureFile", "taskRef"] as const
const FEEDBACK_KEYS = ["text"] as const
const NO_KEYS: readonly string[] = []

async function startRun(req: Request, ctx: RouteContext): Promise<Response> {
  const runner = ctx.runner
  if (runner === null) return noRunner()

  const body = await readBody(req)
  if ("refused" in body) return body.refused
  const parsed = parseBody(body.text, START_KEYS)
  if ("refused" in parsed) return parsed.refused

  const projectPath = nonEmptyString(parsed.fields["projectPath"])
  const featureFile = nonEmptyString(parsed.fields["featureFile"])
  const taskRef = nonEmptyString(parsed.fields["taskRef"])
  if (projectPath === null || featureFile === null || taskRef === null) {
    return badBody(START_KEYS, "a run is named by a project, a feature file and a task ref, each a non-empty string")
  }

  const started = await runner.start({ projectPath, featureFile, taskRef })
  if (!started.ok) return refuseRun(started)
  // 201: the run now exists and `runId` is how everything else addresses it,
  // the stream above included.
  return Response.json({ ok: true, runId: started.runId }, { status: 201 })
}

/**
 * The three checks every `:id` action makes before it can act, in the order
 * their answers do not depend on each other: whether this server can drive a
 * run at all, whether the id could name a log, then the body.
 */
type Gate = { runner: Runner; fields: Record<string, unknown> } | { refused: Response }

async function actionGate(req: Request, ctx: RouteContext, id: string, allowed: readonly string[]): Promise<Gate> {
  const runner = ctx.runner
  if (runner === null) return { refused: noRunner() }
  if (runLogPathFor(id, ctx.runsDir) === null) return { refused: refuse(400, UNUSABLE_RUN_ID) }

  const body = await readBody(req)
  if ("refused" in body) return { refused: body.refused }
  const parsed = parseBody(body.text, allowed)
  if ("refused" in parsed) return { refused: parsed.refused }
  return { runner, fields: parsed.fields }
}

async function approveRun(req: Request, ctx: RouteContext, id: string): Promise<Response> {
  // No keys: a body on this route is refused rather than ignored. Ignoring is
  // the expensive direction - a client that put the human's feedback text on
  // the approve route would silently approve a plan they wanted revised.
  const gate = await actionGate(req, ctx, id, NO_KEYS)
  if ("refused" in gate) return gate.refused
  return acted(await gate.runner.approve(id))
}

async function feedbackOnRun(req: Request, ctx: RouteContext, id: string): Promise<Response> {
  const gate = await actionGate(req, ctx, id, FEEDBACK_KEYS)
  if ("refused" in gate) return gate.refused

  const text = nonEmptyString(gate.fields["text"])
  if (text === null) return badBody(FEEDBACK_KEYS, "feedback is the human's own text, and must be a non-empty string")

  // Forwarded exactly as sent. It is the user's own words, on their own
  // machine, so this is not an injection boundary in the usual sense; what
  // matters is that nothing interpolates it unsafely, and nothing does.
  // `src/prompts.ts` puts it in a template and `src/spawn.ts` sends that in a
  // stream-json user message on the child's stdin, where `JSON.stringify`
  // escapes every byte - so a newline cannot end the line that frames it, and
  // no shell and no argv is involved anywhere.
  return acted(await gate.runner.feedback(id, text))
}

async function stopRun(req: Request, ctx: RouteContext, id: string): Promise<Response> {
  const gate = await actionGate(req, ctx, id, NO_KEYS)
  if ("refused" in gate) return gate.refused
  return acted(await gate.runner.stop(id))
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
    runsDir: opts.runsDir ?? defaultRunsDir(),
    streamPollMs: opts.streamPollMs ?? DEFAULT_STREAM_POLL_MS,
    streamKeepAliveMs: opts.streamKeepAliveMs ?? DEFAULT_STREAM_KEEP_ALIVE_MS,
    // `null` rather than left undefined, so the 503 branch in every action is
    // reachable by a check and not by a TypeError.
    runner: opts.runner ?? null,
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
