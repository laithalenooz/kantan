import { randomBytes, timingSafeEqual } from "node:crypto"
import { constants } from "node:fs"
import { mkdir, open, realpath, stat, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"
import type { Server } from "bun"
import { parseFeature } from "./backlog"
import type { Task } from "./backlog"
import { draftFeature, type Draft } from "./draft"
import { listFeatureFiles } from "./featurefile"
import { requireUsableRepo, taskBranchName } from "./git"
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

/**
 * What `GET /api/projects` actually sends for a project: `TreeProject`, except
 * that `testCmd` can be `null`.
 *
 * Not a widening for its own sake. A project with no test command is verified
 * by the agent itself (the user's 2026-10-12 decision, docs/HANDOFF.md), and
 * `null` is the store's spelling of that. `TreeProject.testCmd` in
 * `src/ui/Tree.tsx` is still `string`, and that file belongs to the UI work in
 * flight - so this type is the honest shape of the wire, written here rather
 * than hidden behind a `?? ""` at the one line that assigns it.
 *
 * The `?? ""` is the thing to avoid specifically: the tree prints `$ {testCmd}`
 * under the repo name, so an empty string renders as a bare `$` with nothing
 * after it - a project that looks like it has a command the reader cannot see,
 * which is the opposite of what the decision requires the UI to say. Carrying
 * the `null` makes "this project has no test command" expressible, and
 * `Tree.tsx` has to widen its own field to read it.
 */
type WireProject = Omit<TreeProject, "testCmd"> & { testCmd: string | null }

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
 * The phase machine, as these routes need it. `src/run.ts` (Task 13)
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
   * The reply to a run parked at `waiting(question)` or `waiting(blocked)`,
   * sent as the next turn on **the session that asked** - plan or implement,
   * whichever the phase record names.
   *
   * **It is not `feedback`, and that is the whole reason this method exists.**
   * A question and a completion are indistinguishable in `claude -p`, so an
   * agent that asked something exits `success` and kantan catches it by the
   * missing sentinel. Routing that reply through `feedback` would send it into
   * `feedbackPrompt`, which opens with "a human read that plan at the gate and
   * did not approve it" - false for an agent waiting on an answer, and the
   * wrong instruction for a question raised mid-implement, where the gate's
   * feedback revises a plan while an answer continues work. `answerPrompt`
   * carries the reply verbatim plus the one clause that differs by phase.
   *
   * Without this route such a run is unreachable: approve and feedback both
   * refuse it `wrong-state`, and stop and resume only re-park it.
   *
   * Which states take an answer stays the machine's rule, per fact 3 above:
   * `wrong-state` for a run that is not waiting on one.
   */
  answer(runId: string, text: string): Promise<Acted>
  /**
   * The new ceiling for a run parked at a human, **in full rather than as a
   * delta**, and a run that stopped on its budget continues from it.
   *
   * In full because the figure is recorded as a `human` record on the run's own
   * log and folded back by `foldForResume`, which takes the last usable one: a
   * delta would have to be folded against a ceiling nobody over HTTP can see.
   * `projects.json` is the *next* run's default, not a live control, so a run
   * started with a per-run ceiling has none to re-derive and one edit to the
   * store would raise every unfinished run of that project at once.
   *
   * **A raise has to exceed both the ceiling and the spend**, and that rule is
   * the machine's: anything at or under either one lowers the ceiling or parks
   * the run again on arrival, and it refuses that as `wrong-state`. Neither
   * figure is known here, so the route's own 400 is only for a figure that
   * could never fund anything - absent, not a number, not finite, or not above
   * zero. The CLI rejects a non-positive `--max-budget-usd` (probed,
   * 2026-10-11), so a figure let through would fail at the spawn, where the UI
   * cannot attribute the failure to the input that caused it.
   *
   * Like `answer`, this exists because without it an exhausted run is
   * unreachable: feedback and an answer are both refused for want of funds
   * *before* the text is taken, approve re-parks, and stop only ends it.
   */
  raise(runId: string, budgetUsd: number): Promise<Acted>
  /**
   * Picks a run back up after a crash, a reload or a stop.
   *
   * **Without this the one state the tree can offer no action for is
   * `interrupted`.** `src/run.ts` has exported `resumeRun` since the phase
   * machine landed and nothing called it, `RunState` carries
   * `{kind:"interrupted", resumeFrom}`, and `Tree.tsx` already exports
   * `canResume` - so the row existed, the mechanism existed, and the port in
   * between had no method.
   *
   * Where it resumes from is **the last complete `phase` record**, which is why
   * this takes no argument but the run id: a client naming a phase would be
   * guessing at something the log already knows, and a run that was parked at a
   * human is simply reported rather than driven.
   *
   * Its refusals are the guidance a person gets at the worst moment, so they
   * are forwarded as written. The one that matters is the dirty check
   * `resumeTaskBranch` carries: a run's own half-written files are exempt
   * **only while the checkout is still on its branch**, and anywhere else they
   * are somebody's and a `git switch` would carry them onto the task branch for
   * the agent to commit. "I have uncommitted work from the run that was cut" is
   * therefore fine, and "I have unrelated work on my base branch" is not, and
   * the message says which - including the `git switch` that makes the second
   * one deliberate.
   */
  resume(runId: string): Promise<Acted>
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
  /** The phase machine the run actions drive. Absent means a server that
   * can serve pages and stream run logs but cannot drive a run, which answers
   * 503 on every action rather than 500 or a missing route. */
  runner?: Runner
  /**
   * `projects.json`, which registration writes. **Deliberately without a
   * default**, unlike `runsDir`: the store's location is a deployment fact that
   * `defaultProjectsFile()` in `src/run.ts` owns, and the entry point passes
   * the same path to the machine, so the two provably read one file. A default
   * here would also mean every test that forgot to inject one registering
   * projects in the developer's own `~/.orch/projects.json`.
   */
  projectsFile?: string
  /**
   * The run ids the machine holds a process for **right now**, asked at the
   * moment the tree is rendered.
   *
   * A function and not a list, because liveness is a fact about this instant: a
   * list captured at launch would be empty forever. `liveRunIds()` in
   * `src/run.ts` is what the entry point passes.
   *
   * Without it `indexRuns` reads every run with no `end` record as
   * `interrupted` - liveness is not in the log and cannot be - so the tree
   * would show a run that is going as one the server died in the middle of, and
   * `running` would be unreachable. Deliberately not a method on `Runner`:
   * `createRunner` does not expose one, and adding it to that port would make
   * the machine's own object no longer satisfy it.
   */
  liveRunIds?: () => Iterable<string>
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
  /** `projects.json`, or `null` when the launch named none - see
   * `ServerOptions.projectsFile`, which has no default on purpose. Nullable for
   * the same reason as `runner`. */
  projectsFile: string | null
  /** Who is running right now, or `null` when the launch can not say - in which
   * case every unfinished run reads as `interrupted`. Nullable rather than
   * optional, for the same reason as the two above. */
  liveRunIds: (() => Iterable<string>) | null
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

/**
 * What one guarded read answered: the text, or which way it would not give it.
 *
 * A code rather than prose, because the two callers say different things about
 * the same outcome - the gate owns "the agent ended its planning turn without
 * writing one", and the tree owns a warning naming a backlog it could not list.
 * `size` is present when the refusal came from the `fstat` and `null` when the
 * bounded read is what found it, which is the difference between a message that
 * can name the size and one that cannot.
 */
type FileRead =
  | { ok: true; text: string }
  /** Nothing at that path, or a path component that is a file. */
  | { ok: false; why: "missing" }
  /** It resolves outside `root`, so a link is pointing out of the repository. */
  | { ok: false; why: "outside" }
  | { ok: false; why: "not-a-file" }
  | { ok: false; why: "too-large"; size: number | null }
  /** Anything else, with the cause's own message: a permission error, an
   * `ELOOP`, or bytes that are not UTF-8. */
  | { ok: false; why: "failed"; message: string }

/**
 * `joined`'s contents as text, if and only if it really sits inside `root`.
 *
 * **The string checks a caller makes on a path are not enough, and this is the
 * function that makes a route safe.** `stat` and `readFile` follow symlinks, so
 * a `docs/plans/x.md` or a `docs/features/x.md` that links to `~/.ssh/id_rsa` -
 * or a `docs/plans` directory that does - passes every check on the path and
 * still reads the key. The agent kantan runs has shell access in that repo, so
 * the link is one command away.
 *
 * Resolved once, and then **opened** with `O_NOFOLLOW` and read through that
 * one handle: the window between resolving and reading is a window the same
 * agent can swap the final component in, and a handle-based `stat` and read
 * cannot be pointed at a second file after the size was checked. Only the final
 * component is covered, which is the realistic case; an intermediate directory
 * swapped mid-request would need `openat` on every segment, which is a
 * different piece of machinery than an HTTP route should carry.
 *
 * `root` must already be canonical - both sides of the containment check are
 * compared as resolved paths, and a `root` that is itself a symlinked spelling
 * would refuse every file under it.
 *
 * **What this does not stop is a hard link**, and that is worth saying plainly
 * rather than leaving to be discovered: `ln ~/.ssh/id_rsa docs/features/x.md`
 * is a second directory entry for the same inode, not a link to follow, so
 * `realpath` answers the path inside the repository and `O_NOFOLLOW` has
 * nothing to refuse. Probed through this route, and the contents came back.
 * Both callers inherit it. Refusing on `st_nlink > 1` would close it, and is
 * not done here because it is a judgement about the threat model rather than
 * about this function: the agent that could make the link can already read the
 * file and paste it into the repo, so the hole is about what this server
 * *renders*, not about what that agent can reach - and a hard-linked file is a
 * thing a real repository can contain.
 */
async function readInside(root: string, joined: string, maxBytes: number): Promise<FileRead> {
  let real: string
  try {
    real = await realpath(joined)
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    // `ENOTDIR` is the same answer one level up: a path component that is a
    // file. `ENOENT` is also a dangling symlink, which has nothing to read.
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, why: "missing" }
    return { ok: false, why: "failed", message: (cause as Error).message }
  }
  if (!inside(real, root)) return { ok: false, why: "outside" }

  // `O_NONBLOCK` as well, so a FIFO swapped in where the file was does not hang
  // the request on a writer that never comes.
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (cause) {
    // `ELOOP` is the final component having become a symlink since `realpath`
    // answered, which is the swap this flag exists to refuse.
    return { ok: false, why: "failed", message: (cause as Error).message }
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) return { ok: false, why: "not-a-file" }
    if (info.size > maxBytes) return { ok: false, why: "too-large", size: info.size }
    // Read through the handle the size came from, and read it **bounded**: the
    // check above is a cheap refusal that can name the size, but a file appended
    // to between the two would be read to its new end, and bounding what one
    // GET spends is the cap's only job. One byte past the cap is what makes
    // "too large" detectable here rather than silently truncated - and a short
    // read is why this loops, since dropping half of the document a human is
    // being asked to approve is the worst thing a read could do.
    const buffer = new Uint8Array(maxBytes + 1)
    let total = 0
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    if (total > maxBytes) return { ok: false, why: "too-large", size: null }
    // Not `utf8`: a decoder that substitutes U+FFFD would show a human mangled
    // prose and let them approve it, and would put a replacement character into
    // a task's text, so invalid bytes refuse instead.
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, total)) }
  } catch (cause) {
    return { ok: false, why: "failed", message: (cause as Error).message }
  } finally {
    // Closed because a handle left to the garbage collector is an error on bun
    // 1.4, and swallowing a close failure because the answer is already decided
    // by then - letting it throw would turn a served file into a 500.
    await handle.close().catch((cause: unknown) => console.error(`closing ${real} failed:`, cause))
  }
}

/** Whether `path` is `root` or sits under it. Both sides are canonical where
 * this is called, so there is nothing left for a link to hide behind. */
function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep)
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
  const projects: WireProject[] = []
  for (const project of registered) {
    const read = await featuresOf(project, index.tasks)
    warnings.push(...read.warnings)
    projects.push({
      path: project.path,
      account: accountOf(project),
      testCmd: project.testCmd,
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

/**
 * The most a request body may be, in bytes.
 *
 * The only fields that can be large are the words a human types - feedback at
 * the gate, or an answer to a question the agent asked - and 64 KiB is roughly
 * ten thousand words: an order of magnitude past what
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
const EDITABLE_KEYS = ["testCmd", "account", "configDir", "budgetUsd"] as const
/** The identity, plus what may change. Derived rather than listed again, so the
 * body's allowlist and the set of keys the handler reads cannot drift: `path`
 * is taken as the record to edit and is never one of the changes. */
const EDIT_KEYS: readonly string[] = ["path", ...EDITABLE_KEYS]
const FEATURE_KEYS = ["projectPath", "text"] as const

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
    draft = await draftFeature(text)
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

  return Response.json({ ok: true, path: draft.path, tasks: draft.feature.tasks.length }, { status: 201 })
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
