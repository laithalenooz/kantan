/**
 * The shapes every HTTP module here takes or answers.
 *
 * Types and one port, no behaviour, which is why this module imports nothing
 * but types itself: `src/http/*`, `src/routes/*` and `src/server.ts` all need
 * `RouteContext`, so anything with a body in here would be imported by all of
 * them and would make the module graph a ring rather than a tree.
 *
 * `Runner` is the exception and has earned it. `CLAUDE.md` rejects interfaces
 * with one implementation, and this is one - but it exists to keep the phase
 * machine out of the server's module graph, which is a stated reason and a real
 * seam. `src/server.ts` must be importable without `src/run.ts`, or a test of
 * the guard chain would stand up the thing that spawns agents.
 */

import type { Server } from "bun"
import type { Ask } from "../draft"

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
  /**
   * Start even though the repo has uncommitted work, so the agent continues
   * from where the human left off.
   *
   * **Optional, and omitted rather than sent as `false`.** The port is a
   * structural match against `createRunner` rather than an import, so this
   * declaration and the machine's have to agree by hand; keeping it optional on
   * both sides means an ordinary start is expressible without mentioning the
   * flag at all, which is what a caller that has never heard of it sends.
   *
   * It does not waive an in-progress merge or an unresolved conflict - the
   * machine refuses those whatever this says.
   */
  allowDirty?: boolean
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
  /**
   * Where the built UI is. Defaults to `<repo>/dist`, which is Vite's
   * `outDir`; injectable so a test can point at a fixture, or at a directory
   * that does not exist, without building the real thing first.
   *
   * It has a default, unlike `projectsFile`, because unlike a project store a
   * missing build is not a mistake: a fresh clone has none, and `GET /` says
   * so rather than failing.
   */
  distDir?: string
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
   * How the two drafting routes reach a model. Defaults to `askHaiku`.
   *
   * Injectable for the reason `runsDir` is, only sharper: without it those
   * routes have **no testable happy path at all**, because exercising one
   * spawns the real `claude` binary and bills a real account. `POST
   * /api/features` consequently had none, and the first test to try - for
   * `POST /api/features/propose` - made a billed call from `bun test` and took
   * five seconds doing it. A suite that can spend money is a suite nobody can
   * run freely.
   */
  ask?: Ask
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
  /** Where a built UI would be. Resolved, like `runsDir`: present whether or
   * not anything is there, and `hasBuiltUI` is what answers that. */
  distDir: string
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
  /** How the drafting routes reach a model. Never `null`: there is a real
   * default, and a route with no way to ask is a route that cannot work. */
  ask: Ask
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
