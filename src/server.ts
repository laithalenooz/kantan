import { randomBytes, timingSafeEqual } from "node:crypto"
import { constants } from "node:fs"
import { homedir } from "node:os"
import { mkdir, open, realpath, stat, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { Server } from "bun"
import { STATE_DIR, stateDir } from "./statedir"
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
  noStore,
  refuse,
  tokenCookie,
} from "./http/guards"
import { badBody, nonEmptyString, parseBody, readBody } from "./http/body"
import { inside, readInside } from "./http/readinside"
import { isPattern, matchPattern } from "./http/router"
import { NO_SUCH_RUN, UNUSABLE_RUN_ID, runLogPathFor, streamRunLog } from "./http/sse"
import { readProjects } from "./tree"
import { plannedPath, readPlan } from "./routes/plan"
import {
  answerRun,
  approveRun,
  liveRunFor,
  liveRunIdFor,
  feedbackOnRun,
  raiseRun,
  resumeRun,
  startRun,
  stopRun,
} from "./routes/runs"
import { editProject, registerProject, removeRegistration } from "./routes/projects"
import {
  appendFeatureTasks,
  draftFeatureFile,
  proposeFeatureTasks,
  removeFeatureTask,
} from "./routes/features"
import { runTestCommand } from "./routes/test"
import { detectRepoPath } from "./routes/detect"
import { addAccount, readAccounts } from "./routes/accounts"
import { builtIndex, DEFAULT_DIST, readAsset } from "./routes/assets"
export type { PlanSource } from "./routes/plan"
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

/**
 * What `GET /` answers when there is no `dist/`, which is a fresh clone and the
 * dev loop - not an error.
 *
 * It must not carry the token in its body: a page that can read a response
 * would gain exactly what HttpOnly is hiding. The cookie rides on the headers
 * either way, so this page still bootstraps a session even though it has no
 * script to use one.
 *
 * It names the commands because somebody who sees it has almost certainly just
 * started the server and is looking at a blank-ish page wondering which half is
 * missing. Until T1 landed this said "the UI arrives in a later task", which was
 * true of the code and useless to a reader.
 *
 * The dev-loop half says `server:dev` **and** `ui`, not `ui` alone: anyone
 * reading this page followed the README and ran `bun run server`, so starting
 * Vite against it would 403 every API call. Advice that only works if you were
 * already running the other command is worse than no advice, because the
 * failure it leads to looks like a different bug.
 */
const INDEX_STUB = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>kantan</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='9' fill='%23111216'/><circle cx='16' cy='16' r='6' fill='%23ff6a1a'/></svg>">
<style>body{font:15px/1.6 ui-sans-serif,system-ui,sans-serif;margin:3rem auto;max-width:34rem;padding:0 1rem;color:#1c1917}
code{background:#f5f5f4;border-radius:4px;padding:.15em .4em;font-size:.92em}</style></head>
<body><h1>kantan is running</h1>
<p>The server is up, but there is no built interface to serve. Build it once&nbsp;&mdash;</p>
<p><code>bun run build</code> &nbsp;then reload this page.</p>
<p>For the dev loop instead, stop this server and start the pair:
<code>bun run server:dev</code> here and <code>bun run ui</code> alongside it, then open the port
Vite prints. Both halves are needed: this server refuses the dev server's requests unless it was
started with <code>server:dev</code>, which is deliberate&nbsp;&mdash; Vite forwards the browser's
real <code>Host</code> rather than rewriting it, so the rebinding check can still see it.</p>
</body></html>
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
  /**
   * Page load, where the cookie comes from, and - since T1 - the built UI.
   *
   * The build is read per request rather than once at launch, because `bun
   * --watch` reloads this module in the same process and a cached `index.html`
   * would then be whichever build existed at the first load. It is one small
   * file and `no-store` already means one read per navigation.
   *
   * No 404 when there is no build: see `INDEX_STUB`.
   */
  "GET /": async (_req, ctx) => {
    const built = await builtIndex(ctx.distDir)
    return new Response(built ?? INDEX_STUB, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        /* The HTML names hashed asset files, so a cached copy of it would ask
           for the previous build's chunks after a rebuild. Hence `no-store`
           here and `immutable` on the assets - the pair is what makes the
           hashing worth anything. */
        "Cache-Control": "no-store",
        "Set-Cookie": tokenCookie(ctx),
      },
    })
  },

  /**
   * The built UI's own files, and the only route that answers with bytes off
   * disk that nobody asked kantan to read.
   *
   * **Token-guarded like everything else**, which works because `GET /` sets
   * the cookie on the navigation that pulls these in: the browser stores a
   * `Set-Cookie` when it processes the response headers, before it parses the
   * HTML that references them. Exempting them would have been the easy
   * mistake - it would put a readable file route on this port for any page on
   * any other localhost port to probe.
   */
  "GET /assets/:file": (_req, ctx, params) => readAsset(ctx, params?.file ?? ""),

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

  /** Where each Claude account's rate-limit windows stood the last time kantan
   * saw. A GET, because it reads logs and changes nothing - and the only
   * source there is: `claude` has no subcommand that reports usage, so the
   * `rate_limit_event` a run emits is all anyone has. */
  "GET /api/accounts": (_req, ctx) => readAccounts(ctx),

  /** Records an account kantan may run under - what "Add another account"
   *  needed, and had nowhere to send its answer. */
  "POST /api/accounts": (req, ctx) => addAccount(req, ctx),
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
    distDir: opts.distDir ?? DEFAULT_DIST,
    homeDir: opts.homeDir ?? homedir(),
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

/**
 * The port, from `KANTAN_PORT`.
 *
 * `named` is in the message so it says which variable was wrong: the rename
 * left two that work, and a refusal naming the wrong one sends somebody to
 * edit a setting they never set.
 */
function parsePort(raw: string | undefined, named = "KANTAN_PORT"): number {
  if (raw === undefined) return DEFAULT_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${named} must be a port number between 1 and 65535, got ${JSON.stringify(raw)}`)
  }
  return port
}

/**
 * An environment variable under its new name, falling back to the old one.
 *
 * The rename cost nothing to accept both, and refusing the old name would
 * break the shell history and any script of anyone who used kantan before it.
 * The new name is the documented one and wins when both are set, which is the
 * only stable rule - the alternative makes the answer depend on which the
 * shell happened to export last.
 */
function envVar(name: string, legacy: string): { value: string | undefined; named: string } {
  const fresh = process.env[name]
  if (fresh !== undefined) return { value: fresh, named: name }
  return { value: process.env[legacy], named: legacy }
}

if (import.meta.main) {
  const dev = envVar("KANTAN_DEV", "ORCH_DEV").value === "1"

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

  /* Said out loud, because a fallback nobody can see is indistinguishable from
     a tool that lost their projects. `src/statedir.ts` reads the state directory when it
     exists and `~/.kantan` does not; this is the only way a person finds out
     which one they are on, and what to do about it. */
  const state = stateDir()
  if (state.legacy) {
    console.log(
      `kantan is reading its state from ${state.dir}, which is where it lived before the rename. ` +
        `To move to the new name: mv ${state.dir} ${join(homedir(), STATE_DIR)}`,
    )
  }

  const launch = createServer({
    port: ((): number => {
      const { value, named } = envVar("KANTAN_PORT", "ORCH_PORT")
      return parsePort(value, named)
    })(),
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
