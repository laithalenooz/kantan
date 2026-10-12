import { randomBytes, timingSafeEqual } from "node:crypto"
import { constants } from "node:fs"
import { mkdir, open, realpath, stat, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"
import type { Server } from "bun"
import { parseFeature } from "./backlog"
import type { Task } from "./backlog"
import { draftFeature, type Draft } from "./draft"
import { appendTasksToFile, listFeatureFiles, readFeature, removeTaskFromFile } from "./featurefile"
import { runTests } from "./testrun"
import { askHaiku, proposeTasks } from "./draft"
import { detect } from "./detect"
import type { Ask } from "./draft"
import type { AppendResult, RemoveResult } from "./featurefile"
import { commitPaths, requireUsableRepo, taskBranchName } from "./git"
import type { Repo } from "./git"
import {
  addProject,
  defaults,
  loadProjects,
  projectIdentity,
  removeProject,
  updateProject,
} from "./projects"
import type { Edited } from "./projects"
import type { Project } from "./projects"
import { indexRuns, taskKey } from "./runindex"
import type { TaskStatus } from "./runindex"
import { defaultRunsDir, replay, runLogPath } from "./runlog"
import type { RunRecord } from "./runlog"
/**
 * The tree's shapes, borrowed from the component rather than restated here.
 *
 * **Type-only, and that is what keeps React out of the server.** Verified, not
 * assumed: a `bun build --target=bun` of this file bundles 15 modules with no
 * `jsx-runtime` and no `ui/Tree` in them, importing this module leaves nothing
 * matching react or motion in the module registry - importing `Tree.tsx`
 * directly puts four such entries there - and the server boots and answers.
 *
 * The **top-level** spelling, deliberately, rather than an inline
 * `import { type TreeProject }`. Probed, both ways, because the two are only
 * equivalent by Bun's choice: with `verbatimModuleSyntax` on, `tsc` emits
 * `import {} from "./m"` for the inline form - a side-effect import that loads
 * the module - and nothing at all for this one, while **Bun erases both** (a
 * module whose top level logs was not evaluated under either). So the inline
 * form would work here today and is one transpiler away from loading React
 * into the server, and this form cannot.
 *
 * Borrowed because the client feeds this payload straight into `<Tree>`: a
 * field renamed there becomes a compile error here instead of a row that
 * quietly renders as something else.
 */
import type { Account, TreeFeature, TreeProject, TreeTask } from "./ui/Tree.tsx"

/* The HTTP shapes. Re-exported below, because `src/server.ts` is still the one
   entry point to this layer: a caller that wanted `RouteContext` should not
   have to learn that it moved, and the test suite imports several of these. */
import {
  DEFAULT_DEV_PORT,
  DEFAULT_PORT,
  LOOPBACK,
  TOKEN_COOKIE,
  allowedHosts,
  allowedOrigins,
  checkRequest,
  fault,
  hasToken,
  refuse,
  tokenCookie,
} from "./http/guards"
import { badBody, nonEmptyString, parseBody, readBody } from "./http/body"
import { inside, readInside } from "./http/readinside"
import type { FileRead } from "./http/readinside"

import type {
  Acted,
  Launch,
  Refusal,
  Refused,
  RouteContext,
  RouteHandler,
  Runner,
  ServerOptions,
  StartRequest,
  Started,
} from "./http/context"

export type {
  Acted,
  Launch,
  Refusal,
  Refused,
  RouteContext,
  RouteHandler,
  Runner,
  ServerOptions,
  StartRequest,
  Started,
}


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
    Response.json(
      {
        ok: true,
        dev: ctx.dev,
        /**
         * Where kantan itself is, which the app bar prints.
         *
         * The page cannot work this out. In dev it is served by Vite on a
         * different port, so `window.location` names Vite and not this server -
         * and the chip exists precisely so a second browser tab can be pointed
         * at the right place. `ctx.port` is the port actually bound, which is
         * not the requested one when 0 was asked for.
         */
        origin: `http://${LOOPBACK}:${ctx.port}`,
      },
      { headers: { "Cache-Control": "no-store", "Set-Cookie": tokenCookie(ctx) } },
    ),

  "GET /api/health": () => Response.json({ ok: true }),

  /** The run stream. `:id` is a run id, which reaches here from a URL and is
   * handed to `runLogPath` exactly as sent. */
  "GET /api/runs/:id/stream": (req, ctx, params) => streamRunLog(req, ctx, params?.["id"] ?? ""),

  /** The plan the gate renders. A `GET`, and side-effect-free, which it must
   * stay: `SameSite=Strict` ignores ports, so a page on any other localhost
   * port can make this request with our cookie - it cannot read the answer,
   * but it must not be able to *cause* anything. */
  "GET /api/runs/:id/plan": (_req, ctx, params) => readPlan(ctx, params?.["id"] ?? ""),

  /** The task tree, and the run id of each task's newest run beside it. A
   * `GET`, side-effect-free for the same reason the plan is: see `readProjects`
   * for why the ids travel beside the tree rather than inside it. */
  "GET /api/projects": (_req, ctx) => readProjects(ctx),

  // The run actions, design §4.4. POST, never GET: see the module header.
  "POST /api/runs": (req, ctx) => startRun(req, ctx),
  "POST /api/runs/:id/approve": (req, ctx, params) => approveRun(req, ctx, params?.["id"] ?? ""),
  "POST /api/runs/:id/feedback": (req, ctx, params) => feedbackOnRun(req, ctx, params?.["id"] ?? ""),
  /** The reply to a run that asked a question, which no other route can move.
   * Not `feedback`: see `Runner.answer`. */
  "POST /api/runs/:id/answer": (req, ctx, params) => answerRun(req, ctx, params?.["id"] ?? ""),
  /** The new ceiling for a run parked at a human. The only action carrying a
   * number, so it owns a 400 no other route has - and a `POST`, like every
   * other action, because `SameSite=Strict` ignores ports. */
  "POST /api/runs/:id/raise": (req, ctx, params) => raiseRun(req, ctx, params?.["id"] ?? ""),
  /** Picking a killed run back up. No body: where it resumes from is the last
   * complete phase record in its own log, not something a client may name. */
  "POST /api/runs/:id/resume": (req, ctx, params) => resumeRun(req, ctx, params?.["id"] ?? ""),
  "POST /api/runs/:id/stop": (req, ctx, params) => stopRun(req, ctx, params?.["id"] ?? ""),

  /** Registering a repository, which is what the design's empty state offers
   * and what nothing wrote until now: `projects.json` was read everywhere and
   * written by nobody. */
  "POST /api/projects": (req, ctx) => registerProject(req, ctx),

  /** Stopping tracking a repository, which nothing could do: a project added
   * by mistake, or one whose repo has since been deleted, stayed in the tree
   * for good. A `DELETE`, and therefore Origin-guarded like every other
   * acting method - `checkRequest` keys on "not GET or HEAD", not on POST. */
  "DELETE /api/projects": (req, ctx) => removeRegistration(req, ctx),

  /** Changing a project's settings, which nothing could do either: the account
   * a project bills to was fixed at registration, because registering again is
   * refused rather than replacing a record wholesale. A **partial** update, for
   * that same reason - see `editProject`. */
  "PATCH /api/projects": (req, ctx) => editProject(req, ctx),

  /** Turning a sentence into a task file, which is otherwise hand-written. */
  "POST /api/features": (req, ctx) => draftFeatureFile(req, ctx),

  /** Deleting one task from a task file, which nothing could do: a task added
   * by mistake, or one the work made redundant, stayed in the tree for good and
   * could only be removed by editing the markdown by hand. A `DELETE`, so
   * Origin-guarded like the others. It takes the project, the file and the ref
   * in a body rather than the path, because the file is a path of the user's
   * and a path in a URL segment is the one shape this route must not invite. */
  "DELETE /api/features/task": (req, ctx) => removeFeatureTask(req, ctx),

  /** Adding tasks to a task file that already exists, which `AddTasks` has
   * needed since it was written: its `onAdd` had nothing to call, so the one
   * entry point the design gives for adding work - the "+ Add task" row under
   * each file - opened a screen whose only action threw. */
  "POST /api/features/task": (req, ctx) => appendFeatureTasks(req, ctx),

  /** Running a project's test command once, now, without starting a run.
   * `src/testrun.ts` has had `runTests` since Task 11 and nothing routed it, so
   * `ProjectPanel`'s "Run it now" and `AddRepo`'s "Run it once" - both in the
   * artboards, both already built - were never drawn. */
  "POST /api/test": (req, ctx) => runTestCommand(req, ctx),

  /** Proposing tasks for a task file that already exists, **without writing
   * them**. The other half of `AddTasks`: its "Ask Claude" tab has been built
   * since the screen was ported and had nothing to call, because
   * `POST /api/features` drafts a whole new file numbered from T1 - the wrong
   * shape for a file that already has tasks. Its header has recorded the gap
   * all along. */
  "POST /api/features/propose": (req, ctx) => proposeFeatureTasks(req, ctx),

  /** What kantan can learn about a folder before anyone registers it.
   * `src/ui/AddRepo.tsx` has drawn this check-by-check since it was ported and
   * `detectPath` in `src/ui/live.ts` has called this path all along - it just
   * was not a route, and `detectPath` swallows a failure and answers `null`, so
   * the screen sat at `idle` and someone adding a repository typed a path blind
   * and met the register route's raw 400 instead. */
  "POST /api/detect": (req, ctx) => detectRepoPath(req, ctx),
}

/**
 * The only routes that may answer without a token: a browser cannot have the
 * cookie before something hands it one. Everything else is non-exempt by
 * default, so a new route is guarded unless someone deliberately widens this.
 */
export const TOKEN_EXEMPT: ReadonlySet<string> = new Set(["GET /", "GET /api/session"])

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
 * Patterns are tried in declaration order and the first match wins. The ones
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

// --- The plan the gate renders ----------------------------------------------

/**
 * The most a plan file may be, read into memory and sent to a browser.
 *
 * The dimension is the file's size on disk, written by an agent in the user's
 * own repo, and the two directions are not symmetric. **No cap**: one `GET`
 * decides how much memory the server spends and how much the browser is asked
 * to render, and a plan is the one file in the repo an agent is told to create
 * from scratch - a loop that appended to it would be found this way.
 * **Capped**: a plan longer than this renders as `unreadable` with its size in
 * the message, which is a visible, correctable state rather than a lost one -
 * the file is still on disk and the path is in the answer.
 *
 * 1 MiB is roughly 150,000 words of markdown. Design §3.1's plan is a document
 * a human reads at a gate before approving it, so anything near this is already
 * a plan nobody will read.
 */
const MAX_PLAN_BYTES = 1024 * 1024

/**
 * What the gate needs to render, in the three shapes it already models.
 *
 * **Deliberately `PlanSource` from `src/ui/Gate.tsx`, field for field**, so the
 * shell passes this through instead of maintaining a translation table. Two
 * vocabularies for one three-state answer is how a card ends up stuck in a
 * state the server never meant - and this type is new, so there is nothing to
 * be compatible with except the component that consumes it.
 *
 * Why all three are a 200 and not a 404: a run can legitimately be parked at a
 * gate with no plan behind it. The plan prompt dictates a path, and an agent
 * that answers `ORCH: done` without writing one parks the run at a gate with
 * nothing to show (HANDOFF names the gate UI as where that surfaces). So "there
 * is no plan" is a **state of the run**, which the gate renders with Approve
 * disabled, rather than a request that failed. A 4xx here is reserved for a
 * request that cannot be answered at all: an unusable run id, a run with no
 * log, or a recorded path that does not sit inside the repo.
 *
 * `why` is prose for a human, because that is what the card renders. The
 * `undictated` shape carries none, exactly as the component declares it: the
 * gate owns that sentence, and a second copy here would be a second place for
 * it to drift.
 */
export type PlanSource =
  | { status: "loaded"; path: string; markdown: string }
  /** A path was dictated and its contents cannot be had: never written, since
   * deleted, not a file, not UTF-8, too large, outside the repo once its
   * symlinks are resolved, or a project whose repo has moved. */
  | { status: "unreadable"; path: string; why: string }
  /** No `phase` record carried a usable `planPath`, so the run never dictated
   * one - an older log, or a run that failed before its plan phase started. */
  | { status: "undictated" }

/**
 * The path a plan may be recorded at, or `null`.
 *
 * `planPath` arrives from a **log record**, which is a file on disk that a
 * person can edit and that an older or newer writer may have written
 * differently, so it is caller input in the same class as a run id - and the
 * check is `runLogPath`'s: refuse by construction rather than resolve and
 * compare. The dimension is the recorded string, enumerated:
 *
 * - **Empty.** Names nothing. The caller answers `undictated` for it before
 *   reaching here; refused again at this level so a future caller cannot join
 *   an empty path to the root and read the directory itself.
 * - **Absolute** (`/etc/passwd`, and on Windows a drive or a UNC path).
 *   Refused: the prompt dictates a path *relative to the repository root*, and
 *   `resolve(root, "/etc/passwd")` would discard the root entirely.
 * - **Containing a `..` segment** (`../../.ssh/id_rsa`, `docs/../../x`).
 *   Refused, which is cheap here: the machine dictates
 *   `docs/plans/<date>-<slug>.md`, so nothing legitimate contains one.
 *   `src/projects.ts`'s `reportPath` is the opposite case - there `..` is
 *   allowed because monorepo layouts need it - and this is why that decision
 *   belongs to each joiner rather than to a shared rule.
 * - **Containing a NUL.** Refused: it truncates a path at the syscall boundary,
 *   so what is checked and what is opened could differ.
 * - **A backslash.** Kept as an ordinary character on POSIX, where it is a
 *   legal filename byte, and rejected as a `..` segment on Windows by the
 *   normalisation `isAbsolute`/`resolve` do there. A blanket refusal would
 *   reject a legal POSIX path for a platform this tool is not running on.
 * - **Anything else.** Taken as written and joined to the repo root, with the
 *   containment check below as the second line of defence.
 */
function plannedPath(recorded: string): string | null {
  if (recorded === "" || recorded.includes("\0")) return null
  if (isAbsolute(recorded)) return null
  // Split on both separators, so a Windows-style spelling cannot hide a `..`
  // segment from a POSIX split.
  if (recorded.split(/[/\\]/).includes("..")) return null
  return recorded
}

const PLAN_OUTSIDE_REPO = "refused: this run's log records a plan path that does not sit inside its repository"

/** What the log says about a run's plan: the project it belongs to and the last
 * `planPath` any `phase` record carried. One pass over the log, which is what
 * the stream route already costs per connection. The **last** one, because that
 * is how `src/run.ts` folds it when it rehydrates a run; they agree today
 * because every record that carries one carries the same value. */
async function plannedFor(path: string): Promise<{ projectPath: string | null; planPath: string | null }> {
  let projectPath: string | null = null
  let planPath: string | null = null
  for await (const record of replay(path)) {
    if (record.kind === "header") projectPath = record.projectPath
    if (record.kind === "phase" && record.planPath !== undefined) planPath = record.planPath
  }
  return { projectPath, planPath }
}

/**
 * The contents of the plan file the run dictated.
 *
 * Read from the path the **log** records and never re-derived by convention:
 * `planPathFor` builds it from the branch name and the date, so recomputing it
 * here would mean a second slugger and a date that can have moved on since the
 * run started - and a gate pointed at a file nothing wrote renders empty while
 * the real plan sits beside it.
 */
async function readPlan(ctx: RouteContext, id: string): Promise<Response> {
  const log = runLogPathFor(id, ctx.runsDir)
  if (log === null) return refuse(400, UNUSABLE_RUN_ID)
  try {
    if (!(await stat(log)).isFile()) return refuse(404, NO_SUCH_RUN)
  } catch {
    return refuse(404, NO_SUCH_RUN)
  }

  const { projectPath, planPath } = await plannedFor(log)
  // An empty recorded path is undictated rather than refused, and it is a real
  // record rather than a hypothetical one: `src/run.ts` rehydrates a run with
  // `folded.planPath ?? ""`, so a run resumed from a log that never carried one
  // writes `planPath: ""` on its next phase record. It names no file either
  // way, and "the run never dictated a path" is what the gate shows for it.
  if (planPath === null || planPath === "") return planAnswer({ status: "undictated" })

  // Before anything touches the filesystem, so a traversal is refused rather
  // than attempted. Loud - a 400 - because a log recording a path outside its
  // own repository is either hand-edited or a bug, and neither should read as
  // "the plan is missing".
  const dictated = plannedPath(planPath)
  if (dictated === null || projectPath === null) return refuse(400, PLAN_OUTSIDE_REPO)

  // git's own answer for the root, so a project registered through a symlink
  // resolves to the directory the plan was actually written in, and so the
  // containment check below compares two canonical paths. A project whose repo
  // has moved or is no longer a repository is `unreadable` rather than a
  // refusal: the request was fine, and the gate's own state for "the plan
  // cannot be had" is exactly what that is.
  let root: string
  try {
    root = (await requireUsableRepo(projectPath)).root
  } catch (cause) {
    return planAnswer(unreadable(planPath, (cause as Error).message))
  }

  const joined = resolve(root, dictated)
  // Unreachable given `plannedPath`, and kept because the two read different
  // things: that one reads the recorded string, this one the result of joining
  // it. A future edit that loosened either alone would still meet this.
  if (!inside(joined, root)) return refuse(400, PLAN_OUTSIDE_REPO)

  const read = await readInside(root, joined, MAX_PLAN_BYTES)
  if (read.ok) return planAnswer({ status: "loaded", path: planPath, markdown: read.text })
  switch (read.why) {
    case "outside":
      // Loud, like the string check above: a log recording a path outside its
      // own repository is either hand-edited or a bug.
      return refuse(400, PLAN_OUTSIDE_REPO)
    case "missing":
      // The common case, and the one HANDOFF predicted: the agent answered
      // `ORCH: done` without writing the plan it was told to write.
      return planAnswer(
        unreadable(
          planPath,
          `${planPath} is the plan path this run dictated, and there is no file there. The agent ended its planning turn without writing one.`,
        ),
      )
    case "not-a-file":
      return planAnswer(unreadable(planPath, `${planPath} is not a file, so there is no plan to read.`))
    case "too-large":
      return planAnswer(
        unreadable(
          planPath,
          read.size === null
            ? `${planPath} is past the ${MAX_PLAN_BYTES} bytes a plan may be, so it is not rendered here.`
            : `${planPath} is ${read.size} bytes, past the ${MAX_PLAN_BYTES} a plan may be, so it is not rendered here. It is still on disk.`,
        ),
      )
    case "failed":
      return planAnswer(unreadable(planPath, read.message))
  }
}

/** The path the **log** recorded is what the gate prints, never the resolved
 * one: that is the path the prompt dictated and the one a human would look for,
 * and a resolved path would leak where a symlink inside their repo points. */
function unreadable(path: string, why: string): PlanSource {
  return { status: "unreadable", path, why }
}

/** No caching, as nothing else here is cached: a plan is rewritten when the
 * human sends feedback, and a cached one would show the previous round's. */
function planAnswer(plan: PlanSource): Response {
  return Response.json({ ok: true, plan }, { headers: { "Cache-Control": "no-store" } })
}

// --- The project tree -------------------------------------------------------

/**
 * The most a feature file may be, in bytes.
 *
 * Its own constant rather than the plan's, because this route reads **every**
 * feature file of **every** registered project on each page load, so what is
 * bounded here is the aggregate rather than one document. A megabyte is already
 * far past a human-edited backlog - `src/backlog.ts` parses a task per line -
 * and both directions were weighed: a tighter cap would drop a long real
 * backlog, and no cap at all lets one file in one repo decide how much memory a
 * page load spends.
 */
const MAX_FEATURE_BYTES = 1024 * 1024

/**
 * Every project, its feature files, their tasks, and each task's newest run.
 *
 * **The run ids travel beside the tree, not inside it.** `Tree.tsx` hands its
 * caller a `TaskId` - the project, the feature file and the ref - while every
 * `:id` route here is keyed by run id, so a selection in the tree resolved to
 * nothing this port would accept (HANDOFF). The fix is not a `runId` on
 * `TreeTaskRun`: the component is presentational and `src/runindex.ts` already
 * owns the task-to-run mapping and already exports the key function for it. So
 * `runs` is keyed by `taskKey`, which separates with `NUL` - the one byte a path
 * cannot contain, and one that survives JSON as `\u0000` - and the shell joins
 * the two. There is deliberately no second key format.
 *
 * What this composes, rather than reimplements: `src/projects.ts` for the
 * registered repos, `src/featurefile.ts` for which files are a backlog,
 * `src/backlog.ts` for the parse, and `src/runindex.ts` for the fold of the run
 * logs.
 *
 * **No merge predicate is passed to `indexRuns`, and that is not only about
 * cost.** `isMergedIntoBase` needs a base branch, and nothing in `src/git.ts`
 * or `src/run.ts` resolves a project's base outside a run that was started from
 * it - so there is no base to ask about here, and inventing one would make
 * `merged` meaningless while looking right. The cost settles it the same way:
 * measured over 500 logs, `indexRuns` reads them in 89-180ms and a 5ms-a-row
 * predicate takes the same work to 2733ms, awaited one row at a time
 * (HANDOFF). So every finished task reads `done-unmerged`, which `Tree.tsx`
 * treats as its own calm end state and which keeps `canStart` false: the
 * recoverable direction. Caching those answers is deliberately not done here -
 * only a caller who knows when a branch can have moved can invalidate one, and
 * a stale cache would feed wrong merge state to the guard whose whole job is
 * refusing a second run against finished work.
 *
 * Nothing here throws on the user's own data. A project whose repo has been
 * deleted, or whose `path` names a file, is listed with no features, because one
 * unusable record must not blank the tree. A **damaged store** is the one
 * exception and is a 500 forwarding its message, as registration does: an empty
 * list there would read as a fresh install and invite registering everything
 * again.
 */
async function readProjects(ctx: RouteContext): Promise<Response> {
  const projectsFile = ctx.projectsFile
  if (projectsFile === null) return noStore("list any projects")

  let registered: Project[]
  try {
    registered = await loadProjects(projectsFile)
  } catch (cause) {
    // The same answer, and the same reasoning, as `registerProject`'s: the
    // store is the only state no repository can rebuild, the message names the
    // file, the record and the field, and an editor fixes what it points at.
    console.error(`GET /api/projects: ${projectsFile} cannot be read:`, cause)
    return refuse(500, (cause as Error).message)
  }

  const index = await indexRuns({
    runsDir: ctx.runsDir,
    // Never a second implementation of the branch name: a plausible name
    // pointing at no branch would make `merged` meaningless while looking right.
    branchFor: taskBranchName,
    // A log naming a project that is no longer registered is skipped with a
    // warning: someone will delete a project, and its logs outlive it.
    projects: registered.map((project) => project.path),
    ...(ctx.liveRunIds === null ? {} : { liveRunIds: ctx.liveRunIds() }),
  })

  const warnings = [...index.warnings]
  const projects: TreeProject[] = []
  for (const project of registered) {
    const read = await featuresOf(project, index.tasks)
    warnings.push(...read.warnings)
    projects.push({
      path: project.path,
      account: accountOf(project),
      testCmd: project.testCmd,
      // The folder, not only the word. `account` is a label; `configDir` is
      // what `src/spawn.ts` turns into `CLAUDE_CONFIG_DIR`, so without it on
      // the wire the panel's account cards cannot tell two profiles of one
      // word apart - and `optionId` in `src/ui/ProjectPanel.tsx` exists
      // precisely to tell them apart.
      ...(project.configDir === undefined ? {} : { configDir: project.configDir }),
      // The stored ceiling. Absent from the wire meant the panel's whole
      // ceiling section was hidden, which read from use as "nowhere to set a
      // budget" - the store has had the field, and a default of $50, since
      // `projects.ts` was written.
      budgetUsd: project.budgetUsd,
      // What each phase runs as. On the wire for the same reason the ceiling
      // is: a panel cannot offer to change a setting it cannot read, and these
      // were hand-edit-only until now. Sent as one object rather than six keys
      // so the panel takes them or leaves them together - a half-read set
      // would draw a form with some fields blank and no way to tell "unset"
      // from "this wire is older than this page".
      advanced: {
        planModel: project.planModel,
        implementModel: project.implementModel,
        planEffort: project.planEffort,
        implementEffort: project.implementEffort,
        permissionMode: project.permissionMode,
        allowedTools: project.allowedTools,
      },
      features: read.features,
    })
  }

  return Response.json(
    {
      ok: true,
      projects,
      // Every task the logs know about, not only the ones a tree row joined: a
      // run whose feature file has since been renamed is still a run, and
      // filtering the mapping down to what happens to be on screen would make
      // it unaddressable the moment the tree and the logs disagree.
      runs: Object.fromEntries(
        [...index.tasks].map(([key, status]) => [
          key,
          { runId: status.runId, costUsd: status.costUsd, attempts: status.attempts },
        ]),
      ),
      // Everything that was skipped or guessed at, from the fold and from the
      // reads below. Dropping these would make a refused backlog a silent
      // absence, which reads as a parser bug; `indexRuns` collects its own for
      // the same reason and never throws them.
      warnings,
    },
    // Nothing here is cached: a run moves between page loads, and the design's
    // own rule is that the UI never owns truth.
    { headers: { "Cache-Control": "no-store" } },
  )
}

/**
 * Which Claude account a project's runs bill to.
 *
 * `Project.account` is the only source, because it is the only one the human
 * actually stated. Still never derived from `configDir`: that selects a CLI
 * profile, and no rule turning `/home/u/.claude-work` into "work" is anything
 * but a guess about how a stranger names their directories. Design §5 lists a
 * wrong account as a defect because people bill clients from one of these.
 *
 * What changed is the **unstated** case. It used to return bare `unknown`,
 * which the tree renders as "account unknown" on every row of every project -
 * true, and useless, and it reads like a bug. We cannot say personal or work
 * without being told, but we can say which profile the runs use, which is a
 * fact we hold: the default profile, or the directory `configDir` names. That
 * is strictly more informative and still claims nothing about whose money it
 * is.
 */
function accountOf(project: Project): Account {
  if (project.account !== undefined) return { kind: project.account }
  return {
    kind: "unknown",
    label: project.configDir === undefined ? "default profile" : (basename(project.configDir) || project.configDir),
  }
}

/**
 * One project's feature files, with whatever could not be read said out loud.
 *
 * `readFeature` is deliberately **not** what reads these. It uses a plain
 * `readFile`, so it follows a symlink out of the repository and has no size
 * cap, and this route hands the parsed contents to a browser - the same
 * exposure the plan route has, answered by the same guard (`readInside`).
 *
 * That guard is a skipping rule, so CLAUDE.md's rule applies. The dimension is
 * **the outcome of trying to read one candidate**, and its values are: a plain
 * file; a symlink that stays inside the repo; a symlink out of it; a dangling
 * one, or a file deleted between the listing and the read; something that is
 * not a regular file; bytes that are not UTF-8; and a file past the cap. The
 * costs are not symmetric:
 *
 * - **Rendering a file from outside the repository** leaks whatever a line of
 *   it looks like a task bullet in, and there is no recovering a leaked key.
 *   So that direction refuses, even though `listFeatureFiles` documents a
 *   symlinked shared backlog as supported - which it still is for a run, since
 *   `src/run.ts` reads the file itself. The two disagree, and this is the side
 *   to be wrong on.
 * - **Dropping a file the user really has** makes a real backlog invisible,
 *   which `listFeatureFiles` itself calls the worse failure.
 *
 * So a file that cannot be read is **omitted and named in a warning**, never
 * listed with `tasks: []`: an empty task list is exactly what a feature
 * mid-draft looks like, and `listFeatureFiles` includes those on purpose, so the
 * two have to stay distinguishable. A silent omission would read as a parser
 * blind spot and send someone looking in the wrong file.
 */
async function featuresOf(
  project: Project,
  tasks: ReadonlyMap<string, TaskStatus>,
): Promise<{ features: TreeFeature[]; warnings: string[] }> {
  const warnings: string[] = []

  // Canonical, because `readInside` compares two resolved paths: a project
  // registered through a symlink would otherwise have every file under it read
  // as pointing out of itself. Only for the containment check - the path the
  // tree prints and joins on stays the registered spelling, below.
  let root: string
  try {
    root = await realpath(project.path)
  } catch (cause) {
    warnings.push(`${project.path} cannot be resolved, so its backlog is not listed: ${(cause as Error).message}`)
    return { features: [], warnings }
  }

  // `listFeatureFiles` reads an absent `docs/features` as no features, which is
  // a repo's normal first state, and throws on anything else - a `path` that is
  // a file answers ENOTDIR. One throw must not become a 500 for every project.
  let candidates: string[]
  try {
    candidates = await listFeatureFiles(project.path)
  } catch (cause) {
    warnings.push(`${project.path} has no readable docs/features, so its backlog is not listed: ${(cause as Error).message}`)
    return { features: [], warnings }
  }

  const features: TreeFeature[] = []
  for (const path of candidates) {
    const rel = featurePath(project.path, path)
    if (rel === null) {
      warnings.push(`${path} is not inside ${project.path}, so it is not listed as one of its feature files`)
      continue
    }
    const read = await readInside(root, path, MAX_FEATURE_BYTES)
    if (!read.ok) {
      warnings.push(`${project.path}: ${rel} is in docs/features and was not read, so it is not in the tree: ${whyUnread(read)}`)
      continue
    }
    features.push({
      path: rel,
      tasks: parseFeature(read.text).tasks.map((task) => treeTask(task, project.path, rel, tasks)),
    })
  }
  return { features, warnings }
}

/**
 * Prose for a refused read.
 *
 * None of these quotes the path the file resolved **to**: where a link inside
 * the user's repo points is not this route's to publish, and the caller already
 * names the path the project lists. The one exception is `failed`, which
 * forwards an errno message, and `open`'s errno messages carry the resolved
 * path - which by then has passed the containment check, so it is a path inside
 * the repository either way.
 */
function whyUnread(read: Extract<FileRead, { ok: false }>): string {
  switch (read.why) {
    case "missing":
      return "there is nothing at that path now; it was listed a moment ago, so it has been deleted or it is a dangling link"
    case "outside":
      return "it resolves to a file outside the repository, and this route does not render one - the backlog it links to is still there to read"
    case "not-a-file":
      return "it is not a regular file"
    case "too-large":
      return `it is past the ${MAX_FEATURE_BYTES} bytes a feature file may be`
    case "failed":
      return read.message
  }
}

/**
 * The feature file as the run log's header spells it, or `null`.
 *
 * **Relative to `project.path` as registered**, never to a resolved root, and
 * with separators normalised the way `src/run.ts`'s `repoRelative` normalises
 * them. HANDOFF: `TreeFeature.path` has to be the exact repo-relative string
 * the header records as `featureFile`, because that is a third of `taskKey`. If
 * the join misses, a `done, unmerged` task reads as `open` and `canStart`
 * returns true - a silent re-run of finished work the tree cannot detect.
 *
 * The guard is unreachable while the caller is `listFeatureFiles`, which joins
 * names from one `readdir` onto the project's own path; it is here because the
 * two things are separable and a path that escaped the project must not be
 * printed as one of its files.
 */
function featurePath(projectPath: string, absolute: string): string | null {
  const rel = relative(resolve(projectPath), absolute)
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null
  return rel.split("\\").join("/")
}

/**
 * One backlog line, with its newest run when the index has one.
 *
 * `line` does not travel: it indexes a string the client does not have.
 *
 * `run` is **absent** rather than empty for a task that has never run, because
 * `taskStateOf` reads a missing `run` as open-or-passed from the checkbox and an
 * empty one would make it read the checkbox's opposite. A ref-less task is not
 * even looked up: it cannot be run, since a run is addressed by its ref.
 *
 * `testAttempts` and `exitCode` are **omitted**, not zeroed. `runindex.ts`
 * deliberately folds no `test` record - an exit code does not move a run - so
 * neither number is available here, and design §"what must survive" requires
 * exit codes printed and never paraphrased, which also forbids inventing one. A
 * zero would render as "exited 0": a pass nobody observed. A zero
 * `testAttempts` would be read by `isGrinding` as a count rather than an
 * absence.
 *
 * `branch` is forwarded as it comes, including `""` - which means `branchFor`
 * threw and the task was **not** checked for a merge. The run is never dropped
 * for it: a dropped run reads as a task that was never run, which is how a
 * second run gets started against work already written.
 */
function treeTask(task: Task, projectPath: string, featureFile: string, tasks: ReadonlyMap<string, TaskStatus>): TreeTask {
  const line: TreeTask = { ref: task.ref, text: task.text, done: task.done }
  if (task.ref === null) return line
  const status = tasks.get(taskKey({ projectPath, featureFile, taskRef: task.ref }))
  return status === undefined ? line : { ...line, run: { state: status.state, branch: status.branch } }
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

const START_KEYS = ["projectPath", "featureFile", "taskRef", "allowDirty"] as const
const FEEDBACK_KEYS = ["text"] as const
/** The same single key as feedback, and a separate constant on purpose: the two
 * routes are different actions on different conversations, and sharing the
 * literal would invite sharing the handler. */
const ANSWER_KEYS = ["text"] as const
/** The whole new ceiling, in dollars. One key, and a number rather than a
 * string: see `raiseRun`. */
const RAISE_KEYS = ["budgetUsd"] as const
const NO_KEYS: readonly string[] = []
/**
 * What registering a project takes, which is **not** every field a `Project`
 * has.
 *
 * These three are what the design's "Add a repository" dialog asks for: the
 * repo path, the test command, and the Claude account - which is spelled
 * `configDir`, an absolute path to a CLI profile, because a profile carries a
 * CLAUDE.md, skills and settings as well as credentials. Everything else
 * (`budgetUsd`, the models, the efforts, `allowedTools`, `reportPath`) takes
 * the design's default and is edited in `projects.json`, which is a file people
 * hand-edit and read in diffs.
 *
 * Deliberately not a copy of `src/projects.ts`'s `FIELDS`: adding a field to
 * `Project` is already a four-place change, and copying the list here would
 * make it five. The cost of this list being short is that a setting the store
 * supports cannot be set over HTTP, which is a 400 naming the keys this route
 * does take rather than a silently dropped value.
 *
 * The task file the dialog also asks for is **not** a project field: it names a
 * run, and it reaches `POST /api/runs` as `featureFile`.
 */
const PROJECT_KEYS = ["path", "testCmd", "account", "configDir"] as const
/**
 * What removing a project takes: the repo path, and nothing else.
 *
 * Its **own** list rather than `PROJECT_KEYS`, which also carries `testCmd`
 * and `account`. `parseBody` refuses an unknown key by naming the keys *this
 * route* takes, so sharing the longer list would accept a body that reads as
 * "remove this much of the project" and then ignore the rest of it.
 */
const REMOVE_KEYS = ["path"] as const
/**
 * The fields an edit may change.
 *
 * Longer than `PROJECT_KEYS` by `budgetUsd`, and that is not an oversight: the
 * registration dialog offers three fields and takes the design's default for
 * the ceiling, while an edit is where a ceiling is changed - it is one of the
 * fields a second trip through that dialog used to reset, which is why
 * re-registering is refused at all.
 *
 * Still far short of every field a `Project` has. The models, the efforts,
 * `allowedTools`, `permissionMode` and `reportPath` are edited in
 * `projects.json`, a file people hand-edit and read in diffs, and a key this
 * list does not carry is a 400 naming the keys it does - never a silent drop.
 */
/**
 * `account` and `configDir` are **not** coupled here, and that is a decision.
 *
 * Only `configDir` controls anything: `src/spawn.ts`'s `phaseEnv` sets
 * `CLAUDE_CONFIG_DIR` from it and deletes it when there is none, and
 * `src/run.ts` keys the run header's `profile` on it. `account` is a label -
 * what the human called it - and nothing in `src/` outside `accountOf()` below
 * reads it. So a client that switches accounts by sending `{account}` alone
 * relabels the chip and bills the same credentials as before.
 *
 * This route does not refuse that, for two reasons. A project can legitimately
 * have an account and no `configDir` - a user whose *default* CLI profile is
 * their work account - so "account requires configDir" would reject a correct
 * configuration. And a rule the store does not have would put this route and a
 * hand-edited `projects.json` into disagreement about what is valid, which is
 * the divergence docs/HANDOFF.md warns about elsewhere.
 *
 * What makes leaving it to the caller safe is that this route answers with the
 * **whole stored record**, so a client can see that `configDir` did not move. A
 * UI offering an account switcher must send both keys in one call; that it can
 * is pinned by test, as is the trap.
 */
/**
 * What `PATCH /api/projects` may change.
 *
 * It was these four, and the store has held eleven since it was written - so
 * `planModel`, `implementModel`, `planEffort`, `implementEffort`,
 * `permissionMode` and `allowedTools` could only be changed by hand-editing
 * `~/.orch/projects.json`. Nothing was wrong with the write path: `editProject`
 * copies whichever of these keys the body carried and `updateProject` validates
 * the merged record, naming the field in its own refusal. The only thing
 * missing was the key being listed here, and a surface for it.
 *
 * `reportPath` stays out. It is the one field nothing in `src/run.ts` reads
 * today, so a control for it would store a value with no effect - which is
 * worse than no control, because it looks like it did something.
 */
const EDITABLE_KEYS = [
  "testCmd",
  "account",
  "configDir",
  "budgetUsd",
  "planModel",
  "implementModel",
  "planEffort",
  "implementEffort",
  "permissionMode",
  "allowedTools",
] as const
/** The identity, plus what may change. Derived rather than listed again, so the
 * body's allowlist and the set of keys the handler reads cannot drift: `path`
 * is taken as the record to edit and is never one of the changes. */
const EDIT_KEYS: readonly string[] = ["path", ...EDITABLE_KEYS]
const FEATURE_KEYS = ["projectPath", "text"] as const

const REMOVE_TASK_KEYS = ["projectPath", "featureFile", "taskRef"] as const

const APPEND_TASK_KEYS = ["projectPath", "featureFile", "texts"] as const

const TEST_KEYS = ["projectPath", "testCmd"] as const

const PROPOSE_KEYS = ["projectPath", "featureFile", "text"] as const

const DETECT_KEYS = ["path"] as const

/** A trial run is bounded tighter than a run's own verification: somebody is
 * watching it, and a suite that takes ten minutes is not what this control is
 * for. The command keeps running to completion either way - `runTests` caps
 * what it *keeps*, not what the command does - so the bound here is only on
 * how long the request waits. */
const TRIAL_TIMEOUT_MS = 3 * 60 * 1000

/** How many tasks one call may add, and how long each may be. A bound rather
 * than a guess at intent: the body is JSON from a page, and `appendTasks`
 * writes a line per text into a file in someone's repository. */
const MAX_NEW_TASKS = 50
const MAX_TASK_CHARS = 2000

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

  // **A boolean, strictly.** The one key on this route that is not a string, so
  // it owns a 400 no other start key has. `"true"`, `1` and `"yes"` are all
  // refused rather than coerced: this waives the guard that stops an agent
  // committing over work nobody asked it to touch, and a truthiness check would
  // let `"false"` - which a form serialises readily - waive it. Absent is the
  // ordinary start, which is the only value that may be inferred.
  const rawAllowDirty = parsed.fields["allowDirty"]
  if (rawAllowDirty !== undefined && typeof rawAllowDirty !== "boolean") {
    return badBody(
      START_KEYS,
      "allowDirty is true or false, and says this one run may start even though the repo has uncommitted work; omit it for an ordinary start",
    )
  }
  const allowDirty = rawAllowDirty === true

  const started = await runner.start({
    projectPath,
    featureFile,
    taskRef,
    ...(allowDirty ? { allowDirty: true } : {}),
  })
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

/**
 * The reply to a run that asked a question, or that parked `blocked`.
 *
 * The same shape as feedback and a different action: `feedback` revises a plan
 * a human read at the gate, this continues work the agent stopped to ask about,
 * and the two go into different prompts. See `Runner.answer` for why one route
 * cannot serve both. The text is forwarded exactly as sent, for the reasons
 * spelled out on `feedbackOnRun`.
 */
async function answerRun(req: Request, ctx: RouteContext, id: string): Promise<Response> {
  const gate = await actionGate(req, ctx, id, ANSWER_KEYS)
  if ("refused" in gate) return gate.refused

  const text = nonEmptyString(gate.fields["text"])
  if (text === null) {
    return badBody(ANSWER_KEYS, "an answer is the human's own text, and must be a non-empty string")
  }
  return acted(await gate.runner.answer(id, text))
}

/**
 * The new ceiling for a run parked at a human.
 *
 * The one action whose argument is a number, so it owns a 400 no other route
 * has. Accepting input, so CLAUDE.md's rule applies: the dimension is **the
 * value of `budgetUsd` as JSON delivers it**, enumerated rather than sampled -
 *
 * - **Absent**, which includes an absent body and an empty one (probed: Bun
 *   declares `Content-Length: 0` for both, so they are indistinguishable).
 * - **`null`**, which is what `JSON.stringify({ budgetUsd: NaN })` sends, and
 *   the literal `NaN`, which is not JSON at all and is refused one layer up.
 * - **A string**, including a numeric one: that is the shape a text input
 *   produces, and `Number("")` is 0, so coercing would turn a blank field into
 *   a ceiling of zero.
 * - **A boolean, an array or an object**, for the same reason.
 * - **Both infinities**, which arrive as `1e999`: `src/spawn.ts` throws rather
 *   than flooring a non-finite remainder, precisely so a broken total cannot be
 *   hidden.
 * - **Zero, negative zero and any negative figure.** The CLI rejects a
 *   non-positive `--max-budget-usd` (probed, 2026-10-11).
 * - **A finite figure above zero.** Forwarded, however large: an upper bound
 *   here would be a cap nobody asked for, over a figure the human typed.
 *
 * What is **not** checked is whether the figure is a raise. `requireRaise`
 * demands one above both the current ceiling and the spend, and neither is
 * known here - after a raise the ceiling lives in the run's own log, not in
 * `projects.json`. So "not above the ceiling" is the machine's `wrong-state`,
 * which `acted` turns into a 409 carrying its own prose, and this 400 is only
 * for a figure that could never fund anything. Both costs were weighed:
 * over-accepting means the spawn fails later, where the UI cannot attribute the
 * failure to the input that caused it; over-rejecting means a ceiling the
 * machine would have taken is refused, which is why the bound here is only
 * "finite and above zero" and not a guess at the run's state.
 *
 * Neither message echoes the figure, as no refusal in this file echoes caller
 * text, and they are two messages rather than one: "that is not a number" and
 * "that number cannot fund a turn" are different mistakes with different fixes.
 */
async function raiseRun(req: Request, ctx: RouteContext, id: string): Promise<Response> {
  const gate = await actionGate(req, ctx, id, RAISE_KEYS)
  if ("refused" in gate) return gate.refused

  const figure = gate.fields["budgetUsd"]
  if (typeof figure !== "number") {
    return badBody(RAISE_KEYS, "a raise is the run's whole new ceiling and must be a number of dollars, never a string")
  }
  if (!Number.isFinite(figure) || figure <= 0) {
    return badBody(RAISE_KEYS, "a ceiling must be a finite figure above zero, or it funds no turn at all and the CLI refuses it")
  }
  return acted(await gate.runner.raise(id, figure))
}

/**
 * Picks a killed run back up, which until now nothing could ask for.
 *
 * No keys, like approve and stop, and for the sharper of the two reasons those
 * give: a client that put the human's reply on this route would resume the run
 * **without** it, and the question the agent asked would still be unanswered -
 * so the text would be lost rather than merely ignored. Which phase to continue
 * from is the log's answer, not a client's.
 *
 * Every refusal is the machine's: `unknown-run` for a log that is not there,
 * `wrong-state` for a run that has already finished or is working right now,
 * `busy` for one whose lock another run holds, and `dirty` for a checkout that
 * has moved away from the task's branch with uncommitted work on it. Each
 * carries the guard's own sentence, which is the only guidance available at
 * that moment.
 */
async function resumeRun(req: Request, ctx: RouteContext, id: string): Promise<Response> {
  const gate = await actionGate(req, ctx, id, NO_KEYS)
  if ("refused" in gate) return gate.refused
  return acted(await gate.runner.resume(id))
}

async function stopRun(req: Request, ctx: RouteContext, id: string): Promise<Response> {
  const gate = await actionGate(req, ctx, id, NO_KEYS)
  if ("refused" in gate) return gate.refused
  return acted(await gate.runner.stop(id))
}

// --- Registering a project --------------------------------------------------

/** `what` names the thing that cannot be done, because this answers the tree,
 * registration, removal, an edit and a draft, and "it cannot register a
 * project" was already the wrong sentence for three of them. */
function noStore(what: string): Response {
  return refuse(503, `refused: this server was launched without a project store, so it cannot ${what}`)
}

/**
 * Registers a repository: `projects.json`'s first writer.
 *
 * Three validators run, in an order their answers depend on:
 *
 * 1. **The body's shape**, as every action does it - unknown keys refused by
 *    name of the keys this route *takes*, never by echoing what was sent.
 * 2. **`defaults()`**, which fills the design's defaults around what the dialog
 *    supplied and then validates the record the store will accept. It
 *    **throws**, and that throw is a **4xx**: it is the caller's typo - a
 *    relative `configDir`, a blank `testCmd` - and not a server fault. It also
 *    has to run before git, because a relative path must never reach a `git -C`
 *    whose answer would then depend on where the server was launched from.
 * 3. **`requireUsableRepo()`**, which is what the store cannot do.
 *    `projects.json` only checks that `path` is an absolute string, so without
 *    this a path that is not a repository, is a subdirectory of one, is bare,
 *    or has no commits yet all register happily and fail at the first run -
 *    where the message is about a run rather than about the registration that
 *    was wrong.
 *
 * Both of those messages are forwarded as written, which is not a breach of
 * `refuse`'s no-echo rule: that rule is about the *guards*, where the offending
 * value is attacker-chosen and tells a legitimate caller nothing. These are
 * `src/projects.ts`'s and `src/git.ts`'s own prose about a path the human typed
 * into their own dialog, and quoting it back is the entire diagnosis - "it sits
 * inside the repository rooted at X" is the sentence that fixes the mistake.
 * The machine already answers this way: `src/run.ts`'s `unknown-project`
 * refusal quotes the `projectPath` it was given.
 */
async function registerProject(req: Request, ctx: RouteContext): Promise<Response> {
  const projectsFile = ctx.projectsFile
  if (projectsFile === null) return noStore("register a project")

  const body = await readBody(req)
  if ("refused" in body) return body.refused
  const parsed = parseBody(body.text, PROJECT_KEYS)
  if ("refused" in parsed) return parsed.refused

  const path = nonEmptyString(parsed.fields["path"])
  if (path === null) {
    return badBody(PROJECT_KEYS, "a project is named by the repo path it lives at, which must be a non-empty string")
  }
  // **Present, and not judged here.** `null` is the store's spelling of "this
  // repo has no test suite", which makes its runs verified by the agent itself
  // (the user's 2026-10-12 decision), and a blank string is an unfinished edit
  // that must never be read as either - `sh -c ""` exits 0, so it would tick
  // every task untested. Telling those three apart is `validateProject`'s one
  // job and its prose is the 400 below.
  //
  // `nonEmptyString` used to stand here and collapsed `null` into the blank
  // case, which is why this is an `in` check: the route has to distinguish a
  // key that was *omitted* - a damaged or half-built body, still a 400 - from
  // one explicitly set to `null`, and `nonEmptyString` cannot see the
  // difference. Over-judging here was the quiet failure: it would have made
  // the whole feature unreachable over HTTP while the store supported it.
  if (!("testCmd" in parsed.fields)) {
    return badBody(
      PROJECT_KEYS,
      "a project must say how it is tested: testCmd is the shell command kantan runs and branches on, or null if this repo has no test suite and the agent should verify its own work",
    )
  }
  const testCmd = parsed.fields["testCmd"]
  const configDir = parsed.fields["configDir"]
  const account = parsed.fields["account"]

  let project: Project
  try {
    project = defaults({
      path,
      // The same assertion-not-a-check as `configDir` and `account` below, and
      // for the same reason: `testCommand` in src/projects.ts owns the
      // three-way judgement - a command, `null` for a repo with no suite, or a
      // throw for a blank or a non-string - and that throw is the 400 below.
      testCmd: testCmd as string | null,
      // Whether it is absolute, blank or absent is `defaults()`'s judgement to
      // make - it owns the rule that the CLI expands no `~` - so the cast is
      // the one place the body's shape is asserted rather than checked, and the
      // throw it may produce is the 400 below. `null` reads as absent there,
      // which is the store's own spelling of "the default profile".
      ...(configDir === undefined ? {} : { configDir: configDir as string }),
      // Same reasoning as `configDir`: whether it is one of the two words is
      // `defaults()`'s judgement, and its throw is the 400 below.
      ...(account === undefined ? {} : { account: account as "personal" | "work" }),
    })
  } catch (cause) {
    return refuse(400, (cause as Error).message)
  }

  let repoRoot: string
  try {
    repoRoot = (await requireUsableRepo(project.path)).root
  } catch (cause) {
    return refuse(400, (cause as Error).message)
  }

  // The repository's real root, not the spelling that arrived. `projects.json`
  // is keyed on `path` and normalises lexically only, so two symlinked
  // spellings of one repo would otherwise be two records with two histories
  // (HANDOFF). `requireUsableRepo` has already refused anything that is not a
  // root, so this differs from what was sent only where a symlink was involved
  // - and registering the other spelling now meets the 409 below instead of
  // quietly forking the project's history.
  const record: Project = { ...project, path: repoRoot }

  let registered: Project[]
  try {
    registered = await loadProjects(projectsFile)
  } catch (cause) {
    // A damaged store is a 5xx, and the one 5xx that forwards its message: it
    // names the file, the record and the field, the user owns that file, and an
    // editor fixes what a message points at. `fault`'s generic body would send
    // them to a terminal they are not looking at. Logged there as well, because
    // this is still a server-side surprise.
    console.error(`POST /api/projects: ${projectsFile} cannot be read:`, cause)
    return refuse(500, (cause as Error).message)
  }

  // Registering a known repo again is refused rather than applied, because
  // `addProject` replaces a record **wholesale**: a second trip through a
  // dialog that offers three fields would reset a `budgetUsd` or an
  // `allowedTools` list that was tuned by hand, and the store is the one piece
  // of state no repository can rebuild. Refusing costs an edit in a file the
  // user already owns; accepting can cost settings nothing can recover.
  if (registered.some((p) => p.path === record.path)) {
    return refuse(
      409,
      `${record.path} is already registered in ${projectsFile}, so there is nothing to add. Edit that file to change its settings - registering it again would replace the whole record, including anything tuned there by hand.`,
    )
  }

  await addProject(projectsFile, record)
  // 201, and the stored record: `path` may differ from what was sent - a
  // symlinked spelling, a trailing slash - and it is the identity every start
  // request and every run log keys on, so the caller is told what it is.
  return Response.json({ ok: true, project: record }, { status: 201 })
}

/**
 * Stops tracking a repository. The repo itself is untouched, and so are its run
 * logs.
 *
 * Three questions this answers, each decided rather than assumed:
 *
 * 1. **The run logs stay.** They live in `~/.orch/runs` keyed by run id, they
 *    are the record of work that cost real money, and nothing can rebuild one.
 *    `indexRuns` already skips a log whose project is no longer registered and
 *    says so in a warning - the warning the person who asked for this route had
 *    already seen - so the whole cost of keeping them is that line of text,
 *    while deleting them answers an undoable question nobody asked.
 *    Re-registering the same path brings every run of it back into the tree.
 * 2. **A project with a run in flight is refused**, 409. Every method on the
 *    machine's port resolves the run's project through `projects.json` first -
 *    `stop` included - so a record removed mid-run turns approve, answer,
 *    resume and stop into `unknown-project`. The run would keep its child and
 *    keep spending, invisible in the tree and unreachable from the UI.
 *    Refusing costs one sentence: stop it first.
 * 3. **A path nobody registered is a 404**, not an idempotent 200. The usual
 *    argument for DELETE is idempotence, but a 200 tells someone their project
 *    is gone when a misspelling means it is still there - and a client that
 *    wants idempotence can treat this 404 as success, where nothing can recover
 *    the distinction from a 200. It is also what `POST /api/features` already
 *    answers for the same condition.
 *
 * No git, and no `realpath`: see `projectIdentity`. A project is most often
 * removed *because* its repo has been deleted or moved, so a route that
 * required a usable repository could not remove the records that most need
 * removing.
 */
async function removeRegistration(req: Request, ctx: RouteContext): Promise<Response> {
  const projectsFile = ctx.projectsFile
  if (projectsFile === null) return noStore("remove a project")

  const body = await readBody(req)
  if ("refused" in body) return body.refused
  const parsed = parseBody(body.text, REMOVE_KEYS)
  if ("refused" in parsed) return parsed.refused

  const named = nonEmptyString(parsed.fields["path"])
  if (named === null) {
    return badBody(REMOVE_KEYS, "a removal names the project by the repo path it is registered under, which must be a non-empty string")
  }
  let path: string
  try {
    // The store's own rule for which record a path names, so this route and
    // the write it is about to make cannot disagree about that. Its throw is
    // the caller's typo - a relative path - and so a 400, exactly as
    // `defaults()`'s throw is on registration.
    path = projectIdentity(named)
  } catch (cause) {
    return refuse(400, (cause as Error).message)
  }

  const busy = await liveRunFor(ctx, path)
  if (busy !== null) return refuse(409, busy)

  let removed: boolean
  try {
    removed = await removeProject(projectsFile, path)
  } catch (cause) {
    // A damaged store, answered as registration answers it: a 500 that
    // forwards its own message, because it names the file, the record and the
    // field, the user owns that file, and an editor fixes what it points at.
    console.error(`DELETE /api/projects: ${projectsFile} cannot be read:`, cause)
    return refuse(500, (cause as Error).message)
  }
  if (!removed) {
    return refuse(404, `${path} is not registered in ${projectsFile}, so there was nothing to remove. Its run logs, if it has any, were not touched either.`)
  }
  return Response.json({ ok: true })
}

/**
 * Changes some of a project's settings, leaving the rest alone.
 *
 * **Partial, and that is the whole design of this route.** `registerProject`
 * refuses a re-register with a 409 because `addProject` replaces a record
 * wholesale: a second trip through a three-field dialog would reset a
 * `budgetUsd` or an `allowedTools` list that was tuned by hand, and the store
 * is the one piece of state no repository can rebuild. So only the keys the
 * body carries are forwarded, `src/projects.ts` merges them onto the stored
 * record, and nothing here rebuilds one through `defaults()` - which would
 * reintroduce precisely the loss that 409 exists to prevent.
 *
 * **`path` is the identity and is not editable here.** It is what every start
 * request and every run log keys on, so moving it is a remove plus an add: two
 * decisions, where a human can see both halves. The allowlist has no second key
 * that could name a new one.
 *
 * **No git, unlike registration**, and the asymmetry is the point.
 * `requireUsableRepo` decides whether a *new* path is a repository kantan can
 * run in; an edit names a record that already exists, and re-checking the repo
 * would make a project whose checkout has been deleted impossible to fix and
 * impossible to repoint - which is one of the two things a user asked for.
 *
 * **It is allowed while a run is in flight**, where a removal is refused. A
 * removal breaks the lookup every action on that run makes; an edit cannot,
 * because `path` cannot change and `held()` hands back the run the machine
 * already registered rather than re-reading the store for it. The one cost
 * worth naming is `configDir`: a run that is rehydrated after a restart takes
 * the edited record, and `--resume` would then look for its session in a
 * different CLI profile and meet "No conversation found". That is reversible
 * with one PATCH back, it is invisible to any liveness check - the run it bites
 * is an interrupted one, which is by definition not live - and refusing every
 * edit while a project has unfinished runs would block the ordinary case of
 * fixing a typo in `testCmd` while a plan waits at the gate.
 */
async function editProject(req: Request, ctx: RouteContext): Promise<Response> {
  const projectsFile = ctx.projectsFile
  if (projectsFile === null) return noStore("edit a project")

  const body = await readBody(req)
  if ("refused" in body) return body.refused
  const parsed = parseBody(body.text, EDIT_KEYS)
  if ("refused" in parsed) return parsed.refused

  const named = nonEmptyString(parsed.fields["path"])
  if (named === null) {
    return badBody(EDIT_KEYS, "an edit names the project by the repo path it is registered under, which must be a non-empty string")
  }
  let path: string
  try {
    // The store's own rule for which record a path names, run here as well as
    // inside the write: it is what keeps this route's 404 quoting the spelling
    // the store uses, and what keeps it agreeing with the removal beside it.
    path = projectIdentity(named)
  } catch (cause) {
    return refuse(400, (cause as Error).message)
  }

  // The keys that were **sent**, not every key this route knows: an absent key
  // has to mean "leave it alone", and a `changes` object filled with
  // `undefined` for the rest would be a wholesale replacement wearing a
  // partial update's clothes. `in` rather than an undefined check, because the
  // question is which keys the body carried.
  const changes: Record<string, unknown> = {}
  for (const key of EDITABLE_KEYS) {
    if (key in parsed.fields) changes[key] = parsed.fields[key]
  }

  let edited: Edited
  try {
    edited = await updateProject(projectsFile, path, changes)
  } catch (cause) {
    // A damaged store, answered as registration and removal answer it.
    console.error(`PATCH /api/projects: ${projectsFile} cannot be read:`, cause)
    return refuse(500, (cause as Error).message)
  }
  if (!edited.ok) {
    // Two different mistakes with two different fixes, which is why the store
    // tags them rather than throwing one exception for both: a 404 means
    // register it first, a 400 means that value cannot be stored - and the
    // store's own prose names the field, as it does on registration.
    return edited.why === "not-registered"
      ? refuse(404, `${path} is not registered in ${projectsFile}, so there is nothing to edit. Register it first; kantan only stores settings for repos it was told about.`)
      : refuse(400, edited.message)
  }
  // The stored record, as registration answers one: the merge is what the
  // caller cannot predict, and `path` in it is the identity every later
  // request keys on.
  return Response.json({ ok: true, project: edited.project })
}

/**
 * The sentence that refuses a removal because a run of `projectPath` is in
 * flight, or `null` when none is.
 *
 * A skipping guard, so CLAUDE.md's rule applies. The dimension is **what one
 * live run id's log can be read as**, and every value it takes:
 *
 * - **A header naming this project.** Refuse, naming the run.
 * - **A header naming another project.** Ignored: the lock is per repository,
 *   so two projects can be busy at once, and a guard keyed on "anything is
 *   running" would make a removal wait on an unrelated task.
 * - **An id `runLogPath` refuses**, a log that is not there, one whose first
 *   record is not a header, or a read that fails for any other reason. The run
 *   cannot be attributed, so it is refused - see the asymmetry below.
 * - **`liveRunIds` is null**, meaning the launch was given no machine to ask.
 *   Such a server drives no run at all, so there is nothing to orphan and
 *   nothing to refuse; refusing here would make the route unusable on exactly
 *   the launches that cannot be driving anything.
 *
 * The costs are not symmetric. Refusing a removal that would have been safe
 * costs a stop or a restart, both of which the message can ask for. Allowing
 * one that is not costs a run that keeps spending with no route left to stop
 * it, which no later request can undo. So an id this cannot attribute fails
 * toward refusing.
 *
 * "First record, and it must be a header" is `createRunner`'s own rule for
 * attributing a run to a project, deliberately: this check has to refuse
 * exactly when that lookup would resolve the run to this record.
 *
 * It is a read of a file another process is writing, so there is a window
 * between this answer and the removal. It cannot be closed from here - the run
 * registry is the machine's - and it is one request wide against a human
 * clicking two things at once, where the worst case is the case this refuses.
 */
/**
 * The id of a live run in `projectPath`, or `null` when there is none.
 *
 * Split out of `liveRunFor` because two rules now read it and they answer
 * differently: a removal is refused outright, while a draft is written and left
 * uncommitted. Sharing the *lookup* and not the prose is the point - one of
 * these messages is about an unreachable run and the other about a file that
 * would vanish on a branch switch.
 */
async function liveRunIdFor(ctx: RouteContext, projectPath: string): Promise<string | null> {
  const live = ctx.liveRunIds
  if (live === null) return null
  for (const id of live()) {
    if ((await projectOfRun(id, ctx.runsDir)) === projectPath) return id
  }
  return null
}

async function liveRunFor(ctx: RouteContext, projectPath: string): Promise<string | null> {
  const live = ctx.liveRunIds
  if (live === null) return null

  for (const id of live()) {
    const owner = await projectOfRun(id, ctx.runsDir)
    if (owner === null) {
      return `kantan is driving run ${id} right now and cannot tell which project it belongs to, so it will not remove one: every action on a run - stop included - finds its project in ${ctx.projectsFile ?? "the project store"} first, and a removed record would leave that run spending with no way to reach it. Stop it, or restart kantan, then remove the project.`
    }
    if (owner === projectPath) {
      return `run ${id} is in flight for ${projectPath}, so removing it now would leave that run unreachable: every action on it - stop included - finds its project in ${ctx.projectsFile ?? "the project store"} first. Stop the run, then remove the project.`
    }
  }
  return null
}

/** The project a run log is attributed to, or `null` where it cannot be read as
 * naming one. The **first** record, and only if it is a header: a header
 * anywhere later is not a log that starts with one, and `src/runindex.ts` and
 * `createRunner` both read it that way. */
async function projectOfRun(id: string, runsDir: string): Promise<string | null> {
  const path = runLogPathFor(id, runsDir)
  if (path === null) return null
  try {
    for await (const record of replay(path)) {
      return record.kind === "header" ? record.projectPath : null
    }
  } catch {
    // Missing, unreadable, a directory: all "cannot be attributed", which is
    // the refusing direction above. Not logged: this runs on a request, and a
    // log that is gone is not a server fault.
    return null
  }
  return null
}

/**
 * Drafts `docs/features/<slug>.md` from a description, and writes it.
 *
 * This closes the only gap between registering a repository and having
 * something to run. kantan's whole input is a markdown task file, and until
 * now the UI could show you a project with no task file and offer nothing -
 * you had to leave, open an editor, and learn the format. `src/draft.ts` was
 * built for exactly this (design §3.5.1) and nothing called it.
 *
 * Three things this route owns, which the drafting module deliberately does
 * not:
 *
 * - **Where it goes.** `draftFeature` returns a repo-relative path from a
 *   regex slug of the title it generated, never from the model's own words, so
 *   the model cannot steer the write out of `docs/features/`. This resolves
 *   that against the registered project's root and refuses anything that
 *   escapes it anyway, because a defence that is only in the other file is one
 *   edit away from gone.
 * - **Not clobbering.** An existing file is a 409, not an overwrite. The whole
 *   point of the file is that a human curates it; a draft that silently
 *   replaced one would destroy the backlog it was asked to add to.
 * - **Spending money.** This calls the CLI on Haiku. It is one short
 *   single-turn call, and it is additive - design §3.5.1 says to delete the
 *   call rather than debug it under pressure - but it is still a spend the
 *   caller should know about, which is why the failure says which model it was.
 */
/**
 * Removes one task from one task file.
 *
 * The order of the guards is the whole design, because the last of them has to
 * run **before** any bytes move:
 *
 * 1. The body's keys, by the names this route takes.
 * 2. The project, by its stored spelling - a path not in the store is not a
 *    project this server writes into.
 * 3. The file, read through `plannedPath`'s rules: relative, no `..`, no NUL,
 *    and then checked for containment after joining. A task file is a path the
 *    *client* supplies, so this is the one input here that a traversal could
 *    ride in on.
 * 4. **No run in flight in this repository**, and this one is a 409 rather
 *    than the warning `draftFeatureFile` answers with. The two differ because
 *    what is at stake differs. A draft that cannot be committed still exists -
 *    the caller got the thing they asked for, untracked. A removal that cannot
 *    be committed has already changed a file the user can see, on a checkout
 *    that is on the run's own `orch/<task>` branch, and `returnToBase` at the
 *    end of that run would then restore the task as if nothing happened -
 *    after the UI had said it was gone. Worse, the run may be *working through
 *    that very file*: `tickCheckbox` commits a tick into it, and a removal
 *    landing between a tick and its commit is a conflict in the user's repo
 *    with no surface to explain it. So nothing is written at all.
 *
 * The write itself re-reads and re-resolves by ref - see `removeTaskFromFile` -
 * so a human editing the markdown in the same second loses nothing.
 */
async function removeFeatureTask(req: Request, ctx: RouteContext): Promise<Response> {
  const projectsFile = ctx.projectsFile
  if (projectsFile === null) return noStore("remove a task")

  const body = await readBody(req)
  if ("refused" in body) return body.refused
  const parsed = parseBody(body.text, REMOVE_TASK_KEYS)
  if ("refused" in parsed) return parsed.refused

  const projectPath = nonEmptyString(parsed.fields["projectPath"])
  const featureFile = nonEmptyString(parsed.fields["featureFile"])
  const taskRef = nonEmptyString(parsed.fields["taskRef"])
  if (projectPath === null || featureFile === null || taskRef === null) {
    return badBody(
      REMOVE_TASK_KEYS,
      "removing a task needs the project, the task file it is in and the task's ref, each a non-empty string",
    )
  }

  const registered = await loadProjects(projectsFile)
  const project = registered.find((p) => p.path === projectPath)
  if (project === undefined) return refuse(404, "refused: that project is not registered")

  const relative = plannedPath(featureFile)
  if (relative === null) return refuse(400, TASK_FILE_OUTSIDE_REPO)
  const target = resolve(project.path, relative)
  if (!inside(target, project.path)) return refuse(400, TASK_FILE_OUTSIDE_REPO)

  // Before the read, let alone the write. See the docblock.
  const live = await liveRunIdFor(ctx, project.path)
  if (live !== null) {
    return refuse(
      409,
      `refused: run ${live} is in flight in this repository, so nothing was removed. The checkout is on that run's own branch, and a removal committed there would come back the moment the run returns to your base branch - after kantan had told you the task was gone. The run may also be working through this very file. Stop the run, or wait for it, then remove the task.`,
    )
  }

  let result: RemoveResult
  try {
    result = await removeTaskFromFile(await readFeature(target), taskRef)
  } catch (cause) {
    const why = (cause as NodeJS.ErrnoException).code === "ENOENT"
      ? `refused: ${relative} is not a file in this project`
      : `refused: ${(cause as Error).message}`
    // 404 for a file that is not there, 409 for a ref that is not in it: the
    // first is a request about nothing, the second is a request about a real
    // file whose contents disagree with the caller - most often because the
    // tree on screen is older than the markdown on disk.
    return refuse((cause as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 409, why)
  }

  // Committed for the same reason the draft is: kantan changed a file inside
  // someone's repository, and leaving that change loose in their working tree
  // is the inconsistency. A failed commit is a warning on the 200, not a 5xx -
  // the task is already gone from the file the caller asked about, and a
  // rejecting pre-commit hook must not turn that into an error that invites a
  // retry against a file the first call already changed.
  let repo: Repo
  try {
    repo = await requireUsableRepo(project.path)
  } catch (cause) {
    return refuse(400, (cause as Error).message)
  }
  const commitWarning = await commitPaths(repo, {
    subject: `chore: remove ${taskRef} from ${relative}`,
    body: `The task read "${result.removed}". Removed through kantan at a human's request; it had not been run.`,
    paths: [relative],
  })

  const warnings = [result.warning, commitWarning].filter((w): w is string => w !== null)
  return Response.json(
    {
      ok: true,
      featureFile: relative,
      taskRef,
      removed: result.removed,
      ...(warnings.length === 0 ? {} : { warnings }),
    },
    { headers: { "Cache-Control": "no-store" } },
  )
}

/**
 * Adds tasks to a task file that already exists.
 *
 * The guards are `removeFeatureTask`'s, in the same order and for the same
 * reasons, with one difference worth naming: **this is also refused while a run
 * is in flight**, even though adding a task takes nothing away. The reason is
 * the commit, not the edit. A run holds the checkout on its own `orch/<task>`
 * branch, so the commit would land there and `returnToBase` would take the new
 * tasks out of the working tree when the run finished - the user would watch
 * tasks they just added disappear. `POST /api/features` answers a warning
 * instead of refusing because a *drafted file* survives uncommitted; tasks
 * appended into a file the run may also be rewriting do not survive as
 * cleanly, and a conflict in someone's repo has no surface here to explain it.
 *
 * `texts` carry no refs. The server numbers them against the bytes on disk,
 * because the human may have edited the file since they were drafted - see
 * `appendTasksToFile`.
 */
async function appendFeatureTasks(req: Request, ctx: RouteContext): Promise<Response> {
  const projectsFile = ctx.projectsFile
  if (projectsFile === null) return noStore("add tasks")

  const body = await readBody(req)
  if ("refused" in body) return body.refused
  const parsed = parseBody(body.text, APPEND_TASK_KEYS)
  if ("refused" in parsed) return parsed.refused

  const projectPath = nonEmptyString(parsed.fields["projectPath"])
  const featureFile = nonEmptyString(parsed.fields["featureFile"])
  const raw = parsed.fields["texts"]
  if (projectPath === null || featureFile === null || !Array.isArray(raw)) {
    return badBody(
      APPEND_TASK_KEYS,
      "adding tasks needs the project, the task file to add to, and `texts`: an array of what each task says",
    )
  }
  if (raw.length > MAX_NEW_TASKS) {
    return refuse(400, `refused: ${raw.length} tasks in one call is more than the ${MAX_NEW_TASKS} this route takes`)
  }
  // Every element, by its own type, before anything is trimmed: a number or a
  // nested object in this array is a caller bug, and silently stringifying it
  // would write `[object Object]` into someone's backlog.
  const texts: string[] = []
  for (const [at, one] of raw.entries()) {
    if (typeof one !== "string") {
      return refuse(400, `refused: texts[${at}] is ${describeValue(one)}; every task must be a string`)
    }
    if (one.length > MAX_TASK_CHARS) {
      return refuse(400, `refused: texts[${at}] is ${one.length} characters, over the ${MAX_TASK_CHARS} limit for one task`)
    }
    // A task is a line. A newline in one would split it into a task and some
    // prose, and the prose would read as a continuation of it.
    if (/[\r\n]/.test(one)) {
      return refuse(400, `refused: texts[${at}] contains a line break, and a task is one line`)
    }
    texts.push(one)
  }
  if (texts.every((t) => t.trim() === "")) {
    return refuse(400, "refused: every task was blank, so there was nothing to add")
  }

  const registered = await loadProjects(projectsFile)
  const project = registered.find((p) => p.path === projectPath)
  if (project === undefined) return refuse(404, "refused: that project is not registered")

  const relative = plannedPath(featureFile)
  if (relative === null) return refuse(400, TASK_FILE_OUTSIDE_REPO)
  const target = resolve(project.path, relative)
  if (!inside(target, project.path)) return refuse(400, TASK_FILE_OUTSIDE_REPO)

  const live = await liveRunIdFor(ctx, project.path)
  if (live !== null) {
    return refuse(
      409,
      `refused: run ${live} is in flight in this repository, so nothing was added. The checkout is on that run's own branch, and tasks committed there would come back out of your working tree when the run returns to your base branch. Stop the run, or wait for it, then add the tasks.`,
    )
  }

  let result: AppendResult
  try {
    result = await appendTasksToFile(await readFeature(target), texts)
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    return refuse(
      code === "ENOENT" ? 404 : 409,
      code === "ENOENT" ? `refused: ${relative} is not a file in this project` : `refused: ${(cause as Error).message}`,
    )
  }

  let repo: Repo
  try {
    repo = await requireUsableRepo(project.path)
  } catch (cause) {
    return refuse(400, (cause as Error).message)
  }
  const commitWarning = await commitPaths(repo, {
    subject: `chore: add ${result.refs.join(", ")} to ${relative}`,
    body: `${result.refs.length} task${result.refs.length === 1 ? "" : "s"} added through kantan at a human's request. None has been run or verified.`,
    paths: [relative],
  })

  const warnings = [result.warning, commitWarning].filter((w): w is string => w !== null)
  return Response.json(
    {
      ok: true,
      featureFile: relative,
      refs: result.refs,
      ...(warnings.length === 0 ? {} : { warnings }),
    },
    { headers: { "Cache-Control": "no-store" } },
  )
}

/** What a value is, for a refusal that names it without echoing it back. */
function describeValue(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "an array" : typeof value
}

/**
 * Runs a test command once and answers what it did. No run, no branch, no tick.
 *
 * **It takes the command from the body rather than the store**, and that is the
 * one decision here worth defending. The control it serves exists to prove a
 * command works *before* it is trusted, so it has to run the string in the
 * field - which may not be the saved one yet. Running the stored command
 * instead would answer a question nobody asked and label it with the command on
 * screen, which is the one reading that could get a bad command saved.
 *
 * It grants no privilege the caller did not already have: anything holding the
 * token can `PATCH /api/projects` with any `testCmd` and then start a run,
 * which runs it through the same `sh -c`. The guard that matters is the one on
 * every acting route - same-origin, token, `SameSite=Strict` - not a filter on
 * the string, and a filter is exactly what would give the wrong impression that
 * this is a sandbox.
 *
 * Refused while a run is in flight in the repository, like the task routes: the
 * live run may be mid-verification in that same working tree, and two suites
 * writing one tree produces a failure neither of them caused.
 */
async function runTestCommand(req: Request, ctx: RouteContext): Promise<Response> {
  const projectsFile = ctx.projectsFile
  if (projectsFile === null) return noStore("run a test command")

  const body = await readBody(req)
  if ("refused" in body) return body.refused
  const parsed = parseBody(body.text, TEST_KEYS)
  if ("refused" in parsed) return parsed.refused

  const projectPath = nonEmptyString(parsed.fields["projectPath"])
  const testCmd = nonEmptyString(parsed.fields["testCmd"])
  if (projectPath === null || testCmd === null) {
    return badBody(TEST_KEYS, "running a test needs the project and the command, each a non-empty string")
  }
  // A blank is refused above by `nonEmptyString`, and this catches the rest of
  // it: `sh -c "   "` exits 0, and a pass from nothing is the one answer no
  // reader could tell from a real one.
  if (testCmd.trim() === "") {
    return refuse(400, 'refused: that command is only whitespace, and `sh -c "  "` exits 0 - which would read as a pass')
  }

  const registered = await loadProjects(projectsFile)
  const project = registered.find((p) => p.path === projectPath)
  if (project === undefined) return refuse(404, "refused: that project is not registered")

  const live = await liveRunIdFor(ctx, project.path)
  if (live !== null) {
    return refuse(
      409,
      `refused: run ${live} is in flight in this repository, so nothing was run. It may be verifying its own work in this same working tree right now, and two suites writing one tree produce a failure neither of them caused. Wait for it, or stop it.`,
    )
  }

  let outcome
  try {
    // The command from the body, on this project's path. `runTests` reads
    // `testCmd` off what it is handed, so the trial command is passed as a
    // record of its own rather than by writing to the store first - nothing is
    // saved by pressing a button that says "run it".
    outcome = await runTests({ ...project, testCmd }, { timeoutMs: TRIAL_TIMEOUT_MS })
  } catch (cause) {
    // `runTests` rejects only when the command could not be started at all,
    // which is a misconfigured project rather than a test result.
    return refuse(400, `refused: ${(cause as Error).message}`)
  }

  return Response.json(
    {
      ok: true,
      testCmd,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      timedOut: outcome.timedOut,
      // The tail of each stream, which is where every runner puts its summary.
      // Sent so the panel can show what happened rather than only a number.
      stdout: outcome.stdout,
      stderr: outcome.stderr,
    },
    { headers: { "Cache-Control": "no-store" } },
  )
}

/**
 * Proposes tasks for a file that already exists, and writes nothing.
 *
 * The guards are the task routes', minus one: **a run in flight is fine here.**
 * Nothing is written and nothing is committed, so the reasons the other three
 * refuse - a commit landing on the run's branch, two writers in one file, a
 * suite in the same working tree - do not apply. Refusing anyway would make the
 * screen unusable for exactly as long as a run takes, for a call whose whole
 * output is text on a page the human then chooses from.
 *
 * It reads the file so the proposals fit what is there. That read is why the
 * containment check still runs: the path comes from the client.
 */
async function proposeFeatureTasks(req: Request, ctx: RouteContext): Promise<Response> {
  const projectsFile = ctx.projectsFile
  if (projectsFile === null) return noStore("propose tasks")

  const body = await readBody(req)
  if ("refused" in body) return body.refused
  const parsed = parseBody(body.text, PROPOSE_KEYS)
  if ("refused" in parsed) return parsed.refused

  const projectPath = nonEmptyString(parsed.fields["projectPath"])
  const featureFile = nonEmptyString(parsed.fields["featureFile"])
  const text = nonEmptyString(parsed.fields["text"])
  if (projectPath === null || featureFile === null || text === null) {
    return badBody(
      PROPOSE_KEYS,
      "proposing tasks needs the project, the task file they are for, and a description of the work",
    )
  }

  const registered = await loadProjects(projectsFile)
  const project = registered.find((p) => p.path === projectPath)
  if (project === undefined) return refuse(404, "refused: that project is not registered")

  const relative = plannedPath(featureFile)
  if (relative === null) return refuse(400, TASK_FILE_OUTSIDE_REPO)
  const target = resolve(project.path, relative)
  if (!inside(target, project.path)) return refuse(400, TASK_FILE_OUTSIDE_REPO)

  let existing: string
  try {
    existing = (await readFeature(target)).src
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    return refuse(code === "ENOENT" ? 404 : 400, `refused: ${(cause as Error).message}`)
  }

  let tasks: string[]
  try {
    tasks = await proposeTasks(existing, text, ctx.ask)
  } catch (cause) {
    // The model's failures are the caller's to read, as the drafter's are: an
    // empty reply, a reply with nothing task-shaped in it. 502, because the
    // request was fine and something upstream was not.
    return refuse(502, `the tasks could not be drafted: ${(cause as Error).message}`)
  }

  return Response.json(
    { ok: true, featureFile: relative, tasks },
    { headers: { "Cache-Control": "no-store" } },
  )
}

/**
 * Looks at a folder and says what it is, without touching it.
 *
 * **Read-only, and that is what makes an arbitrary path acceptable here.** It
 * is the one route that takes a path from the client which is deliberately
 * *not* required to be registered - that is the whole point, since nothing can
 * be registered before it is checked - and it answers only what `git`, a
 * manifest and `docs/features` say. The same caller can already hand any path
 * to `POST /api/projects`, which registers it; this says less and changes
 * nothing.
 *
 * A `200` even for a folder that is not a repository: "this is not a usable
 * git repository" is the **answer**, carried in `checks` as a sentence someone
 * can read, not a refusal of the question. That is the difference `AddRepo`
 * draws between `phase: "done", usable: false` and `phase: "unknown"` - the
 * second is the probe itself failing, which must not block the button. A 4xx
 * here would be read as the second and would be the first.
 */
async function detectRepoPath(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await readBody(req)
  if ("refused" in body) return body.refused
  const parsed = parseBody(body.text, DETECT_KEYS)
  if ("refused" in parsed) return parsed.refused

  const path = parsed.fields["path"]
  if (typeof path !== "string") {
    return badBody(DETECT_KEYS, "a check names the folder to look at, which must be a string")
  }

  /* The store is read so the check can say "kantan already tracks this", which
     is the one thing that makes a perfectly good repository unregisterable.
     A launch without a store simply cannot say, and says nothing rather than
     claiming the path is free. */
  let registered: string[] = []
  if (ctx.projectsFile !== null) {
    try {
      registered = (await loadProjects(ctx.projectsFile)).map((p) => p.path)
    } catch {
      // A damaged store is not this route's business, and the rest of the
      // answer is still worth having.
    }
  }

  return Response.json(await detect(path, registered), { headers: { "Cache-Control": "no-store" } })
}

const TASK_FILE_OUTSIDE_REPO = "refused: that task file does not sit inside the project"

async function draftFeatureFile(req: Request, ctx: RouteContext): Promise<Response> {
  const projectsFile = ctx.projectsFile
  if (projectsFile === null) return noStore("draft a feature file")

  const body = await readBody(req)
  if ("refused" in body) return body.refused
  const parsed = parseBody(body.text, FEATURE_KEYS)
  if ("refused" in parsed) return parsed.refused

  const projectPath = nonEmptyString(parsed.fields["projectPath"])
  const text = nonEmptyString(parsed.fields["text"])
  if (projectPath === null || text === null) {
    return badBody(FEATURE_KEYS, "a draft needs the project it belongs to and a description of the work, each a non-empty string")
  }

  const registered = await loadProjects(projectsFile)
  const project = registered.find((p) => p.path === projectPath)
  // Keyed on the stored spelling, as every other lookup is: a path that is not
  // in the store is not a project this server will write into.
  if (project === undefined) return refuse(404, "refused: that project is not registered")

  let draft: Draft
  try {
    draft = await draftFeature(text, ctx.ask)
  } catch (cause) {
    // The model's failures are the caller's to read: an empty reply, a title
    // that slugs to nothing, a draft its own parser cannot round-trip.
    return refuse(502, `the draft could not be written: ${(cause as Error).message}`)
  }

  const target = resolve(project.path, draft.path)
  if (!inside(target, project.path)) {
    return refuse(500, "refused: the drafted path escaped the project, which should be impossible")
  }

  try {
    await mkdir(dirname(target), { recursive: true })
    // `wx`: create, and fail if it is already there. Not a stat-then-write,
    // which races against anything else writing the same slug.
    await writeFile(target, draft.markdown, { flag: "wx" })
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
      return refuse(409, `${draft.path} already exists in this project, so nothing was written. Open it and add the task by hand, or describe the work differently so it drafts under another name.`)
    }
    throw cause
  }

  // **Commit what we just wrote.** Leaving it untracked closed a loop the user
  // walked straight into: drafting a task file through the UI made the repo
  // dirty with kantan's own output, and `requireCleanTreeForNewRun` then
  // refused to start that very task - so the only route to creating tasks
  // blocked running them. Writing into someone's repo and leaving it untracked
  // is the inconsistency, not committing it: `tickCheckbox` in `src/run.ts`
  // already commits into the user's repo with an explicit pathspec and a
  // message saying what it did and why.
  //
  // A failed commit is a **warning on the 201**, not a 5xx, which is
  // `tickCheckbox`'s precedent: the draft is written and parsed, the result the
  // caller asked for exists, and the only thing missing is a commit a human can
  // make themselves. Turning that into an error would discard a good draft over
  // a rejecting pre-commit hook. `commitPaths` unstages on failure, so the
  // human finds an untracked file rather than a staged one their next commit
  // would sweep up.
  let warning: string | null = null

  // **Not while a run is in flight in this repo**, and this guard exists
  // *because* of the commit above rather than beside it. A live run has the
  // checkout on its own `orch/<task>` branch, so the commit would land there -
  // and `returnToBase` at the end of that run would then take the drafted file
  // out of the working tree entirely. The user would watch a file they just
  // created disappear, recoverable only from a branch nobody told them about.
  // `git add` also takes `.git/index.lock`, which can fail the agent's own
  // concurrent commit.
  //
  // So the file is still written and still answered - the draft is never lost,
  // which is why this is not a 409 like the removal route's version - it just
  // stays untracked, exactly as it did before this change. The user commits it
  // themselves, or drafts again once the run is done.
  const live = await liveRunIdFor(ctx, project.path)
  if (live !== null) {
    warning = `${draft.path} was written but not committed: run ${live} is in flight in this repository, so the checkout is on that run's own branch and committing there would take this file out of your working tree when the run finishes. It is untracked - commit it yourself, or leave it and it will be there when the run is done.`
  } else {
    // `requireUsableRepo` is the only call here that throws; `commitPaths`
    // reports git's complaint as a value. Narrow on purpose: a broad `try`
    // around both would launder a programming error into a cosmetic warning and
    // answer 201 on every request with the file still untracked - the exact
    // loop this change closes, hidden behind a green test that checked only the
    // status and the path.
    let repo: Repo
    try {
      repo = await requireUsableRepo(project.path)
    } catch (cause) {
      return refuse(400, (cause as Error).message)
    }
    warning = await commitPaths(repo, {
      subject: `chore: draft ${draft.path}`,
      body: `kantan drafted this feature file from a description the user typed. It holds ${draft.feature.tasks.length} task${draft.feature.tasks.length === 1 ? "" : "s"}, none of which has been run or verified.`,
      paths: [draft.path],
    })
  }

  return Response.json(
    {
      ok: true,
      path: draft.path,
      tasks: draft.feature.tasks.length,
      // Only when there is something to say, so a client can treat the key's
      // presence as "tell the human" rather than comparing against "".
      ...(warning === null ? {} : { warning }),
    },
    { status: 201 },
  )
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
    projectsFile: opts.projectsFile ?? null,
    liveRunIds: opts.liveRunIds ?? null,
    ask: opts.ask ?? askHaiku,
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

  // Imported here and nowhere else in this file. The `Runner` port exists so
  // the server does not depend on the phase machine - the types either side
  // stay independent and a drift shows up as an assignability error at the one
  // line below that wires them - and a top-level import would undo half of
  // that, putting `src/run.ts` and everything it spawns from into the module
  // graph of every file that imports this one. The process entry point is the
  // one place that has to know both.
  const { createRunner, defaultProjectsFile, liveRunIds } = await import("./run")

  // One runs directory and one store, resolved once and given to both. Each
  // defaults on its own otherwise, so threading them is what makes
  // `POST /api/projects` and the machine provably read the same file: a server
  // registering projects somewhere the runner never looks would answer 201 and
  // then `unknown-project` on every start.
  const runsDir = defaultRunsDir()
  const projectsFile = defaultProjectsFile()

  const launch = createServer({
    port: parsePort(process.env.ORCH_PORT),
    dev,
    runsDir,
    projectsFile,
    runner: createRunner({ projectsFile, runsDir }),
    // The other half of `indexRuns`: liveness is not in a log and cannot be, so
    // without this every run the machine is driving right now reads as
    // `interrupted` in the tree. It is a module-level function rather than
    // anything on the `Runner` port, which is why it is threaded as an option.
    liveRunIds,
  })
  // The token is not printed: it belongs in the cookie, and a terminal is a
  // place things get pasted from.
  console.log(`kantan on http://${LOOPBACK}:${launch.port}${dev ? " (dev: Vite origin allowed)" : ""}`)
}
