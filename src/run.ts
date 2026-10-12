import { createHash, randomUUID } from "node:crypto"
import { unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import { readFeature, tickTaskInFile } from "./featurefile"
import type { FeatureFile } from "./featurefile"
import {
  acquireRunLock,
  BRANCH_PREFIX,
  createTaskBranch,
  recordBaseBranch,
  releaseRunLock,
  requireCleanTreeForNewRun,
  requireUsableRepo,
  resumeTaskBranch,
  returnToBase,
  taskBranchName,
} from "./git"
import type { Repo, RunLock } from "./git"
import { permissionDenials, describeDenials } from "./permissions"
import {
  answerPrompt,
  feedbackPrompt,
  implementPrompt,
  planPrompt,
  refinePrompt,
  resumePrompt,
} from "./prompts"
import type { TaskSpec } from "./prompts"
import { loadProjects } from "./projects"
import type { Effort, Project } from "./projects"
import { createRunLog, openRunLog, replay, runLogPath } from "./runlog"
import type { PhaseRecord, RunHeader, RunLog, RunPhase, WaitReason } from "./runlog"
import { phaseOutcome } from "./sentinel"
import type { Outcome, ResultEvent } from "./sentinel"
import { spawnPhase } from "./spawn"
import type { PhaseExit, PhaseProcess } from "./spawn"
import { runTests } from "./testrun"
import type { TestOutcome } from "./testrun"
import { failureSignature } from "./stall"
import { claudeVersion } from "./version"

/**
 * The phase machine: plan, a human gate, then implement and test until the
 * tests pass by exit code (design §3).
 *
 * ```
 *  plan ──▶ ◆GATE◆ ──▶ implement ──▶ test ──▶ done
 *            │                        │
 *       feedback                    fail
 *            └──▶ plan               └──▶ refine ──▶ test
 * ```
 *
 * Nine modules meet here for the first time, and the things that go wrong at
 * this seam nearly all exit `success`. Each one has a test, because there is no
 * exception to catch:
 *
 * - **Two session ids.** Gate feedback resumes `planSessionId`; effort
 *   escalation resumes `implementSessionId`. Resuming the wrong one runs the
 *   implement prompt inside the planning conversation and still exits
 *   `success`. The mapping is **carried**, never reconstructed: it is minted
 *   here and written onto the spawning `phase` record.
 * - **Completion is never inferred from exit status.** `AskUserQuestion` does
 *   not exist headless, so a question and a completion are both
 *   `result/success`. Only `phaseOutcome` decides, from the **last** result of
 *   each process.
 * - **`PhaseExit.code` is `null` exactly when a signal ended it**, which both a
 *   stopped run and a crashed one produce. So `code === 0` is not the test for
 *   "finished cleanly"; see `judge`.
 * - **The server ticks the checkbox**, only after the test command passes by
 *   exit code, and only via `tickTaskInFile`. The prompts forbid the agent from
 *   doing it from both ends; nothing here may add it back.
 * - **The run holds its parse-time `FeatureFile`**, and the header carries its
 *   hash, or the mid-run-edit warning can never fire (see `featureFileHash`).
 * - **The lock is released in a `finally`**, following `src/git.ts`'s
 *   documented call order, or a refusal mid-sequence leaves a lock holding a
 *   live pid that nothing reclaims until restart.
 *
 * ## Who holds what, and why there is an in-memory registry at all
 *
 * A run's state is the fold of its log (design §2) and `src/runindex.ts` reads
 * it that way. The registry here holds the things a *log cannot* hold: the open
 * lock, the live child, and the feature file's parse-time bytes. Every entry
 * point also rehydrates from the log when the registry has nothing, because the
 * gate exists to survive a server restart - so the registry is a cache of live
 * resources, never the source of truth.
 */

// ---------------------------------------------------------------------------
// What a caller gets back
// ---------------------------------------------------------------------------

/**
 * Where a run came to rest.
 *
 * Deliberately **not** `src/runindex.ts`'s `RunState`, which answers "what is
 * this task's state?" for the tree by folding a log that may have been written
 * by another process. This one is the return value of a call that just drove
 * the run, so it has no `running` member: every entry point here returns only
 * once the run is parked at a human, finished, or interrupted.
 */
export type RunState =
  | { kind: "waiting"; reason: WaitReason; detail: string }
  | { kind: "done" }
  | { kind: "failed"; why: string }
  /** The child was killed. No `end` record, so the run stays resumable. */
  | { kind: "interrupted"; resumeFrom: RunPhase }

export interface RunResult {
  runId: string
  state: RunState
  /** The run's spend so far: the sum of the last result of each process. */
  costUsd: number
  /** The branch the task owns. */
  branch: string
  /** The plan file the gate renders, as the prompt dictated it. */
  planPath: string
  /**
   * Things a human should see that are not the state: a denied tool, a feature
   * file edited mid-run, a checkout that could not return to base.
   */
  warnings: string[]
}

export interface StartRunOptions {
  project: Project
  /** The feature file, absolute or relative to `project.path`. */
  featureFile: string
  /**
   * The task, as the caller's own listing has it.
   *
   * `ref` is `string | null` rather than `string` so a ref-less task can be
   * **named** and refused with a message. `src/prompts.ts`'s `TaskSpec.ref` is
   * non-null, so such a task cannot reach a prompt, and a signature that could
   * not express one would make the refusal unreachable - which is the one
   * option HANDOFF rules out, because it reads as silently skipping.
   *
   * The task is re-resolved by `ref` against this run's own read of the file.
   * `line` and `text` are used only in messages: `Task.line` is valid solely
   * for the string it was parsed from.
   */
  task: { ref: string | null; text?: string; line?: number }
  /** Default `~/.orch/runs`. A test passes its own. */
  runsDir?: string
  /** Overrides `project.budgetUsd` for this run. */
  budgetUsd?: number
  /** The run id, for a caller that has already minted one. */
  runId?: string
  /** The clock, for the dictated plan path. */
  now?: Date
  /** See `ActionOptions.accepted`. */
  accepted?: () => void
}

export interface ActionOptions {
  runId: string
  project: Project
  runsDir?: string
  /**
   * Called once the transition has been accepted: the run registered, the
   * branch taken and the first child spawned - or the action refused.
   *
   * Every entry point here resolves at the run's **next rest point**, which is
   * minutes away, and an HTTP request cannot wait that long: Bun cuts an idle
   * connection at about ten seconds. A caller that has to answer sooner races
   * this callback against the returned promise, so a refusal (which rejects
   * before the callback fires) is still reported, and everything after the
   * transition reaches the UI through the run log.
   *
   * Called exactly once per call, and on every path, including the ones that
   * spawn nothing at all.
   */
  accepted?: () => void
}

/**
 * Why kantan would not do what was asked.
 *
 * A code, not a message, because the caller needs to turn a refusal into a
 * status and a different piece of UI - and because the alternative is reading
 * the prose, which breaks the first time a sentence is reworded. Each code is
 * produced **at the guard that refused**, never derived from text, and carries
 * that guard's own message: `src/git.ts` names the dirty files and the stash
 * that clears them, and forwarding that is the point.
 *
 * `no-base` and `branch-exists` are deliberately their own codes rather than
 * `dirty`. A detached HEAD, a checkout left on an `orch/` branch and a task
 * whose branch already holds unmerged work are three different conversations
 * with the user, and none of them is "you have uncommitted work".
 */
export type RefusalCode =
  | "unknown-project"
  | "unknown-feature"
  | "unknown-task"
  | "unknown-run"
  /** Another run holds this project's lock. One per project is the collision
   * guard, so this is a normal answer rather than a fault. */
  | "busy"
  | "dirty"
  /** No base branch could be recorded: a detached HEAD, or a checkout an
   * earlier run left on its `orch/` branch. */
  | "no-base"
  /** The task's branch already exists, so the task has run before. */
  | "branch-exists"
  /** The run is in a state that does not take this action. */
  | "wrong-state"

/** A refusal, with the guard's own words. */
export class RunRefusal extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = "RunRefusal"
  }
}

/** Runs a guard, tagging whatever it refuses with `code`. */
async function refusing<T>(code: RefusalCode, guard: () => Promise<T>): Promise<T> {
  try {
    return await guard()
  } catch (e) {
    if (e instanceof RunRefusal) throw e
    throw new RunRefusal(code, (e as Error).message, { cause: e })
  }
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

interface ActiveRun {
  runId: string
  project: Project
  repo: Repo
  lock: RunLock
  log: RunLog
  branch: string
  /** The base recorded at run start. Never re-derived: that is the
   * branch-stacking bug `recordBaseBranch` exists to prevent. */
  base: string | null
  planPath: string
  /** The bytes as this run parsed them. The mid-run-edit warning is
   * unreachable without them (docs/HANDOFF.md). */
  feature: FeatureFile
  featureRel: string
  taskSpec: TaskSpec
  planSessionId: string
  /** Minted at gate approval, so a run abandoned at the gate never has one. */
  implementSessionId: string | null
  /**
   * Whether a process has ever **run** in the implement conversation.
   *
   * Not the same question as `implementSessionId !== null`: approval mints the
   * id, and the budget refusal in `agentTurn` can then park the run before the
   * first process starts. `--resume` on an id the CLI has never seen meets
   * `No conversation found`, so a continuation that read the id alone would
   * turn a raisable park into a failed run (see `continueFrom`).
   *
   * Folded from the log as "some `phase` record carried the implement session
   * id", which is the same fact: a record carries one **exactly when it
   * spawned**.
   */
  implementStarted: boolean
  budgetUsd: number
  /** The sum of the last result of each **finished** process. */
  spent: number
  /** The implement phase's current level, raised one step per stall. */
  effort: Effort
  /** Consecutive identical failure signatures at the current effort. */
  signatures: string[]
  /** Test runs so far in this run, for `TestRecord.attempt`. */
  attempt: number
  /** The phase the run is in, which is what a stop reports and what a resume
   * continues from. Carried rather than re-derived, for the same reason the
   * session ids are. */
  phase: RunPhase
  /** The live child, or `null` at every wait. */
  session: PhaseSession | null
  /**
   * The drive in flight, or `null` while the run is at rest.
   *
   * Every action but `stopRun` refuses while this is pending. Without it a
   * double-clicked approve passes twice, because `rest` still says `gate`
   * until the first drive parks again - and two approvals mint two implement
   * session ids and put two loops on one log, which is the two-session failure
   * in its worst form.
   */
  driving: Promise<RunResult> | null
  /** A stop was asked for. Checked before every side effect the drive has
   * left, so a stop that lands between a passing test and the `end` record
   * cannot tick, commit and move the checkout on the way out. */
  stopped: boolean
  /** Called once when the transition is accepted. */
  accepted: (() => void) | null
  /** Where the run last came to rest, which is what decides whether an action
   * applies: approving a run that is not at the gate is a refusal, and the
   * machine owns that rule because encoding it in the server too would put the
   * answer in two files and race between the asking and the doing. */
  rest: RunState | null
  warnings: string[]
}

const active = new Map<string, ActiveRun>()

/**
 * The runs this process is driving or holding at a wait.
 *
 * `src/runindex.ts` needs it: liveness is not in a log and cannot be, so
 * `indexRuns` folds a `running` phase record to `interrupted` unless the caller
 * names the runs that are actually live. Without this the task tree would call
 * every active run interrupted and offer to resume a run that is working.
 *
 * A run is listed from the moment it is registered until it is retired, which
 * includes every wait: a run parked at the gate for hours is live, holds the
 * project's lock, and is not resumable by anyone else.
 */
export function liveRunIds(): string[] {
  return [...active.keys()]
}

// ---------------------------------------------------------------------------
// Identity: the hash, the paths, the ref
// ---------------------------------------------------------------------------

/**
 * `RunHeader.featureFileHash`: SHA-256, hex, over the file's **raw bytes**.
 *
 * The field was specified without an algorithm or an input, and both halves
 * matter. `src/featurefile.ts` keeps a BOM and whatever line endings the file
 * had, on purpose, and decoding normalises exactly the differences that prove a
 * human edited the file - so a hash over a normalised form would miss a
 * CRLF-to-LF conversion, which is one keystroke in most editors.
 *
 * It is computed from `FeatureFile.src` rather than from a second read of the
 * file, and that is the same bytes: `readFeature` decodes with
 * `{ fatal: true, ignoreBOM: true }`, so every file it accepts is valid UTF-8
 * decoded without substitution or BOM stripping, and re-encoding valid UTF-8
 * reproduces the input byte for byte. One read, and the hash provably describes
 * the bytes the run parsed rather than bytes read a moment later.
 */
export function featureFileHash(src: string): string {
  return createHash("sha256").update(new TextEncoder().encode(src)).digest("hex")
}

/**
 * The feature file as a repo-relative path.
 *
 * Repo-relative because three things key on it: `taskBranchName` (which throws
 * on an absolute path), the run log header - which `src/runindex.ts` uses to
 * key a task, together with `projectPath` and `taskRef` - and the pathspec the
 * tick is committed with.
 *
 * Relative to `project.path` **as registered**, never to git's resolved root: a
 * symlinked project resolves to a different spelling, and the header must carry
 * the registered one or every log for that project is skipped as unregistered.
 */
function repoRelative(projectPath: string, featureFile: string): string {
  const absolute = isAbsolute(featureFile) ? featureFile : resolve(projectPath, featureFile)
  const rel = relative(resolve(projectPath), absolute)
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new RunRefusal(
      "unknown-feature",
      `${featureFile} is not inside the project at ${projectPath}, so it cannot be this run's feature file: the branch name, the run log header and the tick's pathspec are all repo-relative.`,
    )
  }
  return rel.split("\\").join("/")
}

/**
 * The ref, or a refusal naming the task.
 *
 * **Ref-less tasks cannot be ticked**, because `tickTask` addresses by ref, and
 * `TaskSpec.ref` is non-null so one cannot reach a prompt either. Of the three
 * ways out, HANDOFF rules one out: silently skipping. Between the other two,
 * this refuses.
 *
 * Assigning a ref on ingestion would mean **writing to the user's backlog at
 * run start**, and the server's only write to a feature file is a tick, after
 * the test command passed (design §3.3). A run that renumbered the markdown
 * before doing any work would also renumber it while a human had it open, and
 * the refs it invented would be the identity every future branch name is keyed
 * on - from a guess made by the tool rather than by the person who wrote the
 * list. `src/draft.ts` writes refs when it drafts a file, which is the place
 * that owns authoring; this is not it.
 *
 * So the cost of refusing is one edit to a markdown line, with the line quoted
 * in the message. The cost of assigning is a silent edit to the user's backlog
 * on a path that was supposed to be read-only until verification.
 */
function requireRef(task: { ref: string | null; text?: string; line?: number }): string {
  const ref = (task.ref ?? "").trim()
  if (ref !== "") return ref
  const where = task.line === undefined ? "" : ` (line ${task.line + 1})`
  const what = task.text === undefined || task.text === "" ? "" : `: "${task.text}"`
  throw new RunRefusal(
    "unknown-task",
    `this task has no T<n> ref${where}${what}, and kantan addresses a task by its ref everywhere it matters: the checkbox it ticks, the branch it owns, and the prompt it hands the agent. Add a ref to the line - \`- [ ] T7 ${task.text ?? "..."}\` - and start the run again. kantan will not assign one itself: that would be an edit to your backlog before any work was verified.`,
  )
}

/**
 * The dictated plan path, `docs/plans/<date>-<task-slug>.md` (design §3.1).
 *
 * The slug is the branch name with its `orch/` prefix removed, so the plan file
 * and the branch carry the same identity and `src/git.ts` stays the only
 * slugger. A second one would drift and point the gate at a file nothing wrote.
 */
function planPathFor(branch: string, now: Date): string {
  const date = now.toISOString().slice(0, 10)
  return `docs/plans/${date}-${branch.slice(BRANCH_PREFIX.length)}.md`
}

// ---------------------------------------------------------------------------
// Draining a phase without deadlocking it
// ---------------------------------------------------------------------------

/** A raw wire `result` event: what `phaseOutcome` reads, and the cost figure. */
interface RawResult extends ResultEvent {
  total_cost_usd?: unknown
}

/**
 * Complete lines of `stream`, as the bytes they arrived as.
 *
 * **The caller must keep reading this to the end or the child wedges.**
 * `plan-success.jsonl` is 93 KB and a pipe buffer is 64 KB, so an unread stdout
 * stops the child mid-write and `exited` never resolves - a run that looks
 * exactly like a stalled agent.
 *
 * Raw lines rather than `src/stream.ts`'s `parseStream`, which is a deliberate
 * deviation from the seam note: the two consumers inside this file both need
 * something `Event` does not carry. `runlog.appendCli` takes the **untouched
 * bytes**, because the `cli` payloads are the replay source for a future
 * parser, and `phaseOutcome` takes the **raw wire result object**. `stream.ts`
 * remains the parser for the UI, which reads these same bytes back out of the
 * log.
 *
 * Split on `0x0A` over the bytes, and each line decoded whole: a newline cannot
 * occur inside a UTF-8 sequence, so no multi-byte character can straddle a line
 * boundary even when the reads do.
 */
async function* rawLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let pending = new Uint8Array(0)
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    const merged = new Uint8Array(pending.length + chunk.length)
    merged.set(pending)
    merged.set(chunk, pending.length)
    pending = merged
    for (;;) {
      const at = pending.indexOf(0x0a)
      if (at === -1) break
      yield decoder.decode(pending.subarray(0, at))
      pending = pending.subarray(at + 1)
    }
  }
  // A final line with no terminator: the process was killed mid-write, or the
  // writer simply did not end with one. Yielded rather than dropped, so a
  // truncated payload is reported by the log's own validation.
  if (pending.length > 0) yield decoder.decode(pending)
}

/** The raw result object a line carries, or `null` for any other line. */
function resultOf(line: string): RawResult | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null
  const event = value as Record<string, unknown>
  if (event["type"] !== "result") return null
  // The three fields the sentinel reads, plus the cost. `subtype` and
  // `is_error` are taken as they are: a missing `is_error` must not read as
  // `false`, which would let an error event reach the sentinel.
  return {
    subtype: typeof event["subtype"] === "string" ? event["subtype"] : "",
    is_error: event["is_error"] !== false,
    ...(typeof event["result"] === "string" ? { result: event["result"] } : {}),
    total_cost_usd: event["total_cost_usd"],
    // Kept whole so `permissionDenials` can read the field it looks for.
    ...event,
  } as RawResult
}

/** What a turn ended with. */
type TurnEnd =
  | { kind: "result"; raw: RawResult }
  /** The process ended without answering this turn. */
  | { kind: "ended"; exit: PhaseExit }

/**
 * One `claude -p` process, with its stdout drained concurrently.
 *
 * The drain runs from the moment the process starts, independently of what the
 * loop is awaiting, which is what stops the deadlock: a loop shaped
 * `await exited` *then* parse hangs forever on any real run.
 */
class PhaseSession {
  private readonly queue: RawResult[] = []
  private last: RawResult | null = null
  private drained = false
  private wake: Promise<void> | null = null
  private wakeNow: (() => void) | null = null
  private readonly pump: Promise<void>
  /** Payload lines the log refused, so a dropped record is reported rather
   * than silent. */
  readonly dropped: string[] = []

  private constructor(
    private readonly proc: PhaseProcess,
    log: RunLog,
    /** What `--max-budget-usd` this process was given, for a message about it
     * after its spend has already been banked. */
    readonly budgetGiven: number,
  ) {
    this.pump = this.drain(log)
  }

  static start(spec: Parameters<typeof spawnPhase>[0], log: RunLog): PhaseSession {
    return new PhaseSession(spawnPhase(spec), log, spec.remainingUsd)
  }

  get argv(): readonly string[] {
    return this.proc.argv
  }

  /** This process's spend: the **last** result's total, which is cumulative
   * within one process and starts over in the next one (design §3.4). */
  get processSpend(): number {
    const figure = this.last?.total_cost_usd
    return typeof figure === "number" && Number.isFinite(figure) ? figure : 0
  }

  private async drain(log: RunLog): Promise<void> {
    try {
      for await (const line of rawLines(this.proc.stdout)) {
        try {
          await log.appendCli(line)
        } catch (e) {
          // Never rethrow: an unreadable line must not stop the drain, or the
          // deadlock is back. A truncated final line from a killed process is
          // the ordinary case.
          this.dropped.push(`${(e as Error).message}`)
        }
        const result = resultOf(line)
        if (result !== null) {
          this.last = result
          this.queue.push(result)
          this.notify()
        }
      }
    } finally {
      this.drained = true
      this.notify()
    }
  }

  private notify(): void {
    const resolve = this.wakeNow
    this.wake = null
    this.wakeNow = null
    resolve?.()
  }

  private settled(): Promise<void> {
    if (this.wake === null) {
      this.wake = new Promise<void>((resolve) => {
        this.wakeNow = resolve
      })
    }
    return this.wake
  }

  /**
   * Sends one turn and waits for its result, or for the process to end.
   *
   * A rejected `send` is **not** rethrown. `src/spawn.ts` refuses a write after
   * stdin closed, and a child that died between turns - killed, or out of
   * budget - is exactly that case: the honest answer is how the process ended,
   * which the loop below reads from `exited` and `judge` classifies. Throwing
   * instead would turn an ordinary ending into a fault.
   */
  async turn(prompt: string): Promise<TurnEnd> {
    await this.proc.send(prompt).catch(() => {})
    for (;;) {
      const next = this.queue.shift()
      if (next !== undefined) return { kind: "result", raw: next }
      if (this.drained) return { kind: "ended", exit: await this.proc.exited }
      await this.settled()
    }
  }

  /** Closes stdin, waits for every byte, and reports how the child ended. */
  async finish(): Promise<PhaseExit> {
    await this.proc.close()
    const exit = await this.proc.exited
    await this.pump
    return exit
  }

  /** The stop button: SIGTERM, then the exit. Stopping costs nothing, because
   * the session resumes from the same id. */
  async kill(): Promise<PhaseExit> {
    const exit = await this.proc.terminate()
    await this.pump
    return exit
  }
}

/**
 * How a phase ended, which is **not** `exit.code === 0`.
 *
 * The dimension is the triple (a last result event, the exit code, the signal),
 * and the two directions cost very differently: advancing a run that did not
 * finish loses work silently, while parking one that did costs a glance.
 *
 * | last result | `code` | `signal` | verdict | why |
 * |---|---|---|---|---|
 * | yes | 0 | `null` | `phaseOutcome(result)` | the ordinary turn |
 * | yes | non-zero | `null` | `phaseOutcome(result)` | budget exhaustion is exit 1 **with** `error_max_budget_usd`, a raisable stop rather than a crash |
 * | yes | `null` | a signal | **killed** | a result arrived and then something killed the process: the phase did not finish, and `code === 0` would have read as clean |
 * | no | any | `null` | **silent** | a CLI refusal: an unknown flag, a non-UUID session, `No conversation found`. stderr is the only evidence |
 * | no | `null` | a signal | **killed** | the stop button, or a crash |
 */
type Verdict =
  | { kind: "outcome"; outcome: Outcome; raw: RawResult }
  | { kind: "killed"; exit: PhaseExit }
  | { kind: "silent"; exit: PhaseExit }

function judge(raw: RawResult | null, exit: PhaseExit): Verdict {
  if (exit.signal !== null || exit.code === null) return { kind: "killed", exit }
  if (raw === null) return { kind: "silent", exit }
  return { kind: "outcome", outcome: phaseOutcome(raw), raw }
}

// ---------------------------------------------------------------------------
// Starting a run
// ---------------------------------------------------------------------------

/**
 * Pre-flight, the plan phase, and a park at the gate.
 *
 * The git calls are in `src/git.ts`'s documented order, and the lock is
 * released in a `finally` on every path that does not leave an active run
 * behind. A refusal at steps 3 to 5 otherwise leaves a lock holding a **live**
 * pid, which nothing reclaims until the server restarts: the nonce makes the
 * reclaim check work across a reload, but only for a *dead* holder.
 *
 * `claudeVersion()` runs after the git guards, deliberately: it spawns the
 * binary, and "a dirty repo refuses before anything spawns" would otherwise be
 * false by one process.
 */
export async function startRun(options: StartRunOptions): Promise<RunResult> {
  const { project } = options
  // Before anything is acquired: a refusal here has nothing to release.
  const ref = requireRef(options.task)
  const featureRel = repoRelative(project.path, options.featureFile)
  const now = options.now ?? new Date()
  const runId = options.runId ?? randomUUID()
  const branch = taskBranchName({ feature: featureRel, ref })

  const repo = await refusing("unknown-project", () => requireUsableRepo(project.path))
  const lock = await refusing("busy", () => acquireRunLock(repo, { runId, branch }))
  let keepLock = false
  /** The branch this call created, so a later refusal can undo it. */
  let created: string | null = null
  let base: string | null = null
  try {
    // The feature file and the task are read **before** any git mutation, and
    // under the lock so the bytes are this run's own. Validating them after
    // `createTaskBranch` would leave the checkout on a new `orch/` branch for a
    // task that does not exist, and the *next* run would then refuse with "you
    // are on a kantan task branch" - a refusal about the wrong thing entirely.
    const feature = await refusing("unknown-feature", () =>
      readFeature(join(project.path, featureRel)),
    )
    const task = taskSpecFor(feature, ref, featureRel)

    const recorded = await refusing("no-base", () => recordBaseBranch(repo))
    base = recorded
    await refusing("dirty", () => requireCleanTreeForNewRun(repo))
    await refusing("branch-exists", () => createTaskBranch(repo, branch, recorded))
    created = branch

    const planPath = planPathFor(branch, now)
    const budgetUsd = options.budgetUsd ?? project.budgetUsd
    const planSessionId = randomUUID()

    const log = await createRunLog(runLogPath(runId, options.runsDir), {
      claudeVersion: await claudeVersion(),
      runId,
      planSessionId,
      profile: project.configDir ?? null,
      planModel: project.planModel,
      implementModel: project.implementModel,
      planEffort: project.planEffort,
      implementEffort: project.implementEffort,
      // The path **as registered**, not git's resolved root: the task tree
      // keys on it and skips a log whose project it cannot find.
      projectPath: project.path,
      featureFile: featureRel,
      taskRef: ref,
      featureFileHash: featureFileHash(feature.src),
      baseBranch: base,
      budgetUsd,
      startedAt: now.toISOString(),
    })

    const run: ActiveRun = {
      runId,
      project,
      repo,
      lock,
      log,
      branch,
      base: recorded,
      planPath,
      feature,
      featureRel,
      taskSpec: task,
      planSessionId,
      implementSessionId: null,
      implementStarted: false,
      budgetUsd,
      spent: 0,
      effort: project.implementEffort,
      signatures: [],
      attempt: 0,
      phase: "plan",
      session: null,
      driving: null,
      stopped: false,
      accepted: options.accepted ?? null,
      rest: null,
      warnings: [],
    }
    active.set(runId, run)
    keepLock = true
    return await drive(run, () => planTurn(run, planPrompt({ task, planPath }), false))
  } finally {
    // Every refusal from step 2 onward, and every fault before the run is
    // registered. A lock held past one of those names a live pid that nothing
    // reclaims until the server restarts - and a branch left checked out makes
    // the next run refuse for a reason that has nothing to do with it.
    if (!keepLock) {
      if (created !== null && base !== null) await rollBack(repo, created, base)
      await releaseRunLock(lock)
    }
  }
}

/**
 * Undoes the branch a start created, after something later refused.
 *
 * Best effort, and quiet: the caller is already throwing the refusal the user
 * needs to read, and a second sentence about a `git switch` that did not happen
 * would bury it. The branch holds no commits of its own at this point - nothing
 * has run yet - so deleting it is how "start the task again" stays possible
 * rather than meeting "that branch already exists".
 */
async function rollBack(repo: Repo, branch: string, base: string): Promise<void> {
  try {
    await returnToBase(repo, base)
  } catch {
    return // dirty, or base is gone: leave the checkout alone rather than guess
  }
  await gitSays(repo.root, ["branch", "-D", branch])
}

/** The task as a prompt can take it, or a refusal naming what is missing. */
function taskSpecFor(
  feature: FeatureFile,
  ref: string,
  featureRel: string,
  options: { requireOpen: boolean } = { requireOpen: true },
): TaskSpec {
  const task = feature.tasks.find((t) => t.ref === ref)
  if (task === undefined) {
    const known = feature.tasks
      .map((t) => t.ref)
      .filter((r): r is string => r !== null)
      .join(", ")
    throw new RunRefusal(
      "unknown-task",
      `${featureRel} has no task ${ref}${known === "" ? "" : `; it has ${known}`}. The run would plan against a task nobody wrote.`,
    )
  }
  // A resumed run may have ticked the task already, just before it was
  // interrupted: refusing that would make a finished run unrecoverable.
  if (task.done && options.requireOpen) {
    throw new RunRefusal(
      "unknown-task",
      `${ref} in ${featureRel} is already ticked, so there is nothing for this run to verify. Untick it to run it again.`,
    )
  }
  return { ref, text: task.text, featurePath: featureRel }
}

// ---------------------------------------------------------------------------
// The plan phase
// ---------------------------------------------------------------------------

/**
 * One plan turn, in the **plan** session, on the plan model.
 *
 * `resume` is the whole difference between a first plan and gate feedback, and
 * it is the first place the two-session trap bites: feedback resumes
 * `planSessionId`, and resuming `implementSessionId` here would run a planning
 * prompt inside the implement conversation and exit `success`.
 *
 * The gate holds no child process (design §3.1): the plan phase writes its
 * file, exits, and the gate can then sit for hours across a server restart.
 */
async function planTurn(run: ActiveRun, prompt: string, resume: boolean): Promise<RunResult> {
  // Before the record, not after: a `phase` record carries a `sessionId`
  // exactly when it spawned a process, and a budget refusal spawns nothing. A
  // record written first would claim a process that never existed, which is
  // the invariant the per-process cost windows read.
  const refusal = await refuseIfSpent(run, "plan")
  if (refusal !== null) return refusal

  run.phase = "plan"
  await run.log.append({
    kind: "phase",
    phase: "plan",
    state: "running",
    at: Date.now(),
    planPath: run.planPath,
    sessionId: run.planSessionId,
  })

  if (stopping(run)) return await interrupted(run, "plan")
  const session = PhaseSession.start(
    {
      project: run.project,
      sessionId: run.planSessionId,
      resume,
      model: run.project.planModel,
      effort: run.project.planEffort,
      remainingUsd: remaining(run),
    },
    run.log,
  )
  run.session = session
  // The transition is accepted here: the run is registered and its child is
  // running. Everything after this reaches the UI through the run log.
  accept(run)

  const turn = await session.turn(prompt)
  const exit = turn.kind === "ended" ? turn.exit : await session.finish()
  run.session = null
  run.spent += session.processSpend

  const verdict = judge(turn.kind === "result" ? turn.raw : null, exit)
  if (verdict.kind === "killed") return await interrupted(run, "plan")
  if (verdict.kind === "silent") return await fail(run, cliSaid("the plan phase", exit))

  const outcome = verdict.outcome
  warnOfDenials(run, verdict.raw)
  if (outcome.state === "done") return await park(run, "plan", "gate", run.planPath)
  if (outcome.state === "question") return await park(run, "plan", "question", outcome.text)
  if (outcome.state === "blocked") return await park(run, "plan", "blocked", outcome.reason)
  return await endedInError(run, "plan", outcome.subtype, verdict.raw, session.budgetGiven)
}

// ---------------------------------------------------------------------------
// Driving, and what happens when a drive falls over
// ---------------------------------------------------------------------------

/**
 * Runs one drive of a registered run, and is the only place a fault after
 * registration is caught.
 *
 * Two things this stops, both of which leak everything the run holds:
 *
 * - **A throw past the registration.** By the time a drive starts, the run owns
 *   the project's lock, an open log, and usually a live child. A `throw` from
 *   anywhere inside - an unreadable report path, a disk error, a bug - would
 *   otherwise leave the lock naming a **live** pid, which nothing reclaims
 *   until the server restarts, and an orphaned `claude` still writing files in
 *   the user's checkout.
 * - **A second drive.** Nothing else serialises the actions: under the HTTP
 *   layer they arrive whenever the human clicks.
 *
 * A fault is recorded as `failed` rather than left resumable, because the run
 * log is the only channel to the human: `interrupted` writes nothing at all, so
 * a fault parked that way would be invisible, and the run would sit in the tree
 * looking merely interrupted while the thing that broke it stayed broken.
 */
async function drive(run: ActiveRun, work: () => Promise<RunResult>): Promise<RunResult> {
  if (run.driving !== null) {
    throw new RunRefusal(
      "wrong-state",
      `run ${run.runId} is working right now (phase ${run.phase}), so it cannot take another action: two drives on one run would put two loops on one log. Wait for it to come to rest, or stop it.`,
    )
  }
  run.rest = null
  const job = (async () => {
    try {
      return await work()
    } catch (e) {
      // A refusal is passed through rather than recorded as a failure, and is
      // **unreachable from inside a drive today**: every `new RunRefusal` in
      // this file is in `refusing`, `repoRelative`, `requireRef`,
      // `taskSpecFor`, `requireRest`, `requireFunds`, `requireRaise`,
      // `rehydrate`, `resumeRun`, `stopRun`, `stopAbsent`, `projectForRun`,
      // `projectAt` or this guard itself, all of which run before `work()` is
      // called - the two money guards through `held`'s `check`. If a refusal ever does come from
      // inside, this branch has to retire the run first - otherwise it leaves
      // the lock and the registry entry behind with nothing driving them.
      if (e instanceof RunRefusal) throw e
      return await fail(
        run,
        `the run stopped on an unexpected fault in the ${run.phase} phase: ${(e as Error).message}`,
      )
    } finally {
      run.driving = null
      // The transition was accepted the moment the drive began; this is the
      // backstop for a path that spawned nothing.
      accept(run)
    }
  })()
  run.driving = job
  return await job
}

/** Resolves the caller's `accepted` callback, exactly once. */
function accept(run: ActiveRun): void {
  const once = run.accepted
  if (once === null) return
  run.accepted = null
  once()
}

/**
 * Whether a stop has landed, in which case the drive puts everything down.
 *
 * Checked before each remaining side effect rather than once at the top: a stop
 * can arrive while the test command is running, and `runTests` has no cancel -
 * so without these checks a stopped run would carry on to tick the checkbox,
 * commit it and move the checkout, all after the human asked it to stop.
 */
function stopping(run: ActiveRun): boolean {
  return run.stopped
}

// ---------------------------------------------------------------------------
// Resting places
// ---------------------------------------------------------------------------

/** Parks the run at a human decision, holding the lock and no process. */
async function park(
  run: ActiveRun,
  phase: RunPhase,
  reason: WaitReason,
  detail: string,
): Promise<RunResult> {
  run.phase = phase
  await run.log.append({
    kind: "phase",
    phase,
    state: "waiting",
    reason,
    // The instant the human became responsible for this run. Nothing else in
    // the log holds it, and the UI's "waiting 2m 14s" has no honest source
    // without it - see `PhaseRecord.at`.
    at: Date.now(),
    // Written because nothing else in the log holds it: a `blocked` park the
    // machine made - an exhausted budget - and a `stalled` one have no agent
    // text behind them, so a restarted server would otherwise render the
    // previous turn's prose as the reason the run stopped.
    ...(detail === "" ? {} : { detail }),
  })
  return result(run, { kind: "waiting", reason, detail })
}

/** Ends the run as failed: an `end` record, the lock released, no child. */
async function fail(run: ActiveRun, why: string): Promise<RunResult> {
  await abandonSession(run)
  await run.log.append({
    kind: "end",
    state: "failed",
    why,
    costUsd: run.spent,
    ...(run.warnings.length === 0 ? {} : { warnings: [...run.warnings] }),
  })
  const out = result(run, { kind: "failed", why })
  await retire(run)
  return out
}

/**
 * The child was killed, so the run is resumable and **no `end` record is
 * written**: `end` outranks every phase record in the fold, and the run stream
 * stops there, so a run with one can never be resumed or watched again.
 */
async function interrupted(run: ActiveRun, resumeFrom: RunPhase): Promise<RunResult> {
  await abandonSession(run)
  const out = result(run, { kind: "interrupted", resumeFrom })
  await retire(run)
  return out
}

/**
 * SIGTERMs a child the run is giving up on, banking what it spent.
 *
 * Not `finish()`, which closes stdin and waits: a phase that is being abandoned
 * may be mid-turn, and waiting for an agent that has nothing left to do here
 * would hold the run - and the server process - open for as long as the agent
 * felt like working. A leaked child is worse than a leaked lock: it keeps
 * writing files in the user's checkout, and it holds the pipes open so nothing
 * downstream ever sees EOF.
 */
async function abandonSession(run: ActiveRun): Promise<void> {
  const session = run.session
  if (session === null) return
  run.session = null
  await session.kill()
  run.spent += session.processSpend
}

/** Closes the log, releases the lock, and forgets the run. */
async function retire(run: ActiveRun): Promise<void> {
  await abandonSession(run)
  await run.log.close()
  await releaseRunLock(run.lock)
  active.delete(run.runId)
}

function result(run: ActiveRun, state: RunState): RunResult {
  run.rest = state
  accept(run)
  return {
    runId: run.runId,
    state,
    costUsd: run.spent,
    branch: run.branch,
    planPath: run.planPath,
    warnings: [...run.warnings],
  }
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** `ceiling - spent`, which is what each process is given. */
function remaining(run: ActiveRun): number {
  return run.budgetUsd - run.spent
}

/**
 * Refuses to spawn on an exhausted ceiling, rather than leaning on
 * `src/spawn.ts`'s floor.
 *
 * That floor exists so an exhausted run reaches the *designed* stop instead of
 * a commander error, and it works - but **the CLI checks the budget after the
 * turn**: `test/fixtures/budget-exhausted.jsonl` was captured at
 * `--max-budget-usd 0.0001` having spent $0.0046. So a spawn on an exhausted
 * ceiling costs about one more turn every time it happens, and the layer that
 * knows the total is the one that can decline.
 *
 * It parks rather than failing, because design §3.4's answer to exhaustion is
 * to offer a raise: an `end` record would make the run unresumable and the
 * raise meaningless.
 */
async function refuseIfSpent(run: ActiveRun, phase: RunPhase): Promise<RunResult | null> {
  if (remaining(run) > 0) return null
  return await park(run, phase, "blocked", exhausted(run))
}

/**
 * What an exhausted run says to the human, including how to act on it.
 *
 * It names **raising this run's ceiling** rather than "the budget", because the
 * obvious reading of the shorter sentence is to edit `projects.json` - and that
 * figure is the next run's default. A parked run's ceiling is folded from its
 * own log (see `Folded.budgetUsd`), so an edit to the store would leave the
 * human watching a run that does not move.
 */
function exhausted(run: ActiveRun): string {
  return (
    `this run has spent $${run.spent.toFixed(4)} of its $${run.budgetUsd.toFixed(2)} ceiling, so kantan will not start another process: the CLI checks a budget after the turn, not before, so spawning would cost another turn and stop anyway. ` +
    `Raise this run's ceiling and it continues from here - editing the project's budget changes the next run's default, not this one.`
  )
}

/**
 * Refuses an action that would spend money the run does not have, **before** it
 * takes the human's words.
 *
 * Feedback and an answer both carry text, and the run log is where that text
 * goes - but `continueFrom`, which is what a raise resumes with, re-sends the
 * phase's own prompt and has no way to re-send a sentence somebody typed an
 * hour ago. Accepting the text and parking on the budget would therefore record
 * words no agent ever reads, and the human would see their revision vanish into
 * a log. Refusing leaves it in the box they typed it in.
 *
 * Approval is deliberately **not** guarded: it carries no text, and the park it
 * produces is the designed one - "approve, be told the ceiling is short, raise
 * it, and the implement phase starts". That park is also the only way to be
 * waiting with an implement conversation that never started, which is why
 * guarding these two is what keeps `agentTurn`'s first-turn guard unreachable.
 */
function requireFunds(run: ActiveRun, what: string): void {
  if (remaining(run) > 0) return
  const rest = run.rest
  // What a raise will do next differs by park, and both sentences have to be
  // true: a `blocked` run is **driven** by the raise and never sees this text,
  // while a `gate` or `question` run stays put and will take it on the next
  // attempt. `raiseBudget` cannot tell a budget stop from an agent-decided
  // block, and neither can this - but it does not have to, because the raise
  // does the same thing to both.
  const driven = rest !== null && rest.kind === "waiting" && rest.reason === "blocked"
  const next = driven
    ? "Raising the ceiling resumes the phase on its own and does not carry this text with it; send it again if the run comes back asking."
    : "Nothing has been recorded, so nothing is lost: raise the ceiling and send it again."
  throw new RunRefusal("wrong-state", `run ${run.runId} cannot ${what}: ${exhausted(run)} ${next}`)
}

/**
 * Raises the ceiling of a run parked at a human, and continues it if money was
 * what stopped it.
 *
 * **The raise is recorded on the run's log, not read back off the project.**
 * Design §3.4 makes the ceiling configurable per project *and* per run, so a
 * run started with an override has no ceiling to re-derive; `projects.json`
 * holds the next run's default, and editing it would raise every unfinished run
 * of that project at once - one human decision expressed as a different one.
 * The header cannot be rewritten either, because the log is append-only. So the
 * new ceiling goes in as a `human` record and `foldForResume` reads it back,
 * which is what makes a raise survive the restart the park is designed to
 * outlive.
 *
 * Accepted at **every** wait, and it drives only from `blocked`:
 *
 * - `blocked` is the only park money can cause, so it is the only one with
 *   somewhere to continue to. A `blocked` park the *agent* decided continues
 *   too, because telling the two apart would mean reading the detail prose, and
 *   this codebase switches on codes rather than sentences. Continuing one costs
 *   a turn that re-states the phase, which is what a resume does anyway.
 * - `gate`, `question` and `stalled` take the raise and stay put: the decision
 *   they are waiting for is still outstanding. A gate whose ceiling was short
 *   can then be approved or revised, which is the whole reason the raise is
 *   accepted there at all - `requireFunds` refuses feedback until it is.
 */
export async function raiseBudget(
  options: ActionOptions & { budgetUsd: number },
): Promise<RunResult> {
  const raised = options.budgetUsd
  const run = await held(
    options,
    ["gate", "question", "blocked", "stalled"],
    "take a raised ceiling",
    (r) => requireRaise(r, raised),
  )
  const rest = run.rest
  return await drive(run, async () => {
    await run.log.append({ kind: "human", action: "raise", budgetUsd: raised })
    run.budgetUsd = raised
    if (rest !== null && rest.kind === "waiting" && rest.reason !== "blocked") {
      // Nothing to drive: the human's own decision is still the next step.
      return result(run, rest)
    }
    return await continueFrom(run)
  })
}

/**
 * Refuses a raise that cannot fund anything, or that is not a raise.
 *
 * The dimension is the figure, and it takes four kinds of value: above both the
 * ceiling and the spend, which is the only one that funds a process; at or
 * below the ceiling, which is a *lowering* however it was labelled; at or below
 * the spend, which parks the run again on arrival; and non-finite, which would
 * make every later remainder non-finite too - `src/spawn.ts` throws on that
 * rather than flooring it, precisely so a broken total cannot be hidden.
 *
 * Refusing costs one retyped number, visibly. Accepting costs a run that takes
 * the raise and stops anyway, or one whose next process gets `NaN`.
 */
function requireRaise(run: ActiveRun, raised: number): void {
  const floor = Math.max(run.budgetUsd, run.spent)
  if (Number.isFinite(raised) && raised > floor) return
  throw new RunRefusal(
    "wrong-state",
    `$${String(raised)} is not a usable ceiling for run ${run.runId}: it has a $${run.budgetUsd.toFixed(2)} ceiling and has spent $${run.spent.toFixed(4)}, so a raise has to be a finite figure above both - anything else either lowers the ceiling or stops the run again on arrival.`,
  )
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** A process that produced no result event: only stderr says why. */
function cliSaid(what: string, exit: PhaseExit): string {
  const said = exit.stderr.trim()
  return `${what} exited ${exit.code} without a result event${said === "" ? "" : `: ${said}`}`
}

/**
 * The subtype a process reports when it spends its `--max-budget-usd`.
 *
 * Probed: exit 1, `is_error: true`, and **no `result` key at all** on the
 * event. `src/spawn.ts` resolves rather than rejecting for exactly this
 * reason - it is a normal, raisable stop.
 */
const BUDGET_SUBTYPE = "error_max_budget_usd"

/**
 * A phase that ended in an error subtype: a failure, unless it is the budget.
 *
 * Exhaustion is the one error subtype design §3.4 answers by **offering a
 * raise**, so it parks instead of failing - and the difference is not
 * cosmetic. An `end` record outranks every phase record in the fold and the
 * run stream stops at it, so a run that got one can never be resumed or
 * watched again: writing one here would make the raise it invites impossible
 * to act on.
 *
 * Every other subtype fails, including ones this code has never seen. The set
 * belongs to the CLI, and guessing which unknown subtypes are recoverable
 * would be a guess in the expensive direction.
 */
async function endedInError(
  run: ActiveRun,
  phase: RunPhase,
  subtype: string,
  raw: RawResult,
  given: number,
): Promise<RunResult> {
  if (subtype !== BUDGET_SUBTYPE) {
    return await fail(run, agentFailed(`the ${phase} phase`, subtype, raw))
  }
  return await park(
    run,
    phase,
    "blocked",
    `the ${phase} phase stopped on its budget: the process was given $${given.toFixed(4)} of this run's $${run.budgetUsd.toFixed(2)} ceiling and the CLI ended the turn with ${subtype}. The run has spent $${run.spent.toFixed(4)}. Raise this run's ceiling and it continues from where it stopped - editing the project's budget changes the next run's default, not this one.`,
  )
}

/**
 * An agent turn that ended in an error subtype.
 *
 * `is_error` is shown next to the subtype rather than being turned into a label
 * of our own: `subtype` can literally be `"success"` with `is_error: true`, and
 * the set of error subtypes belongs to the CLI.
 */
function agentFailed(what: string, subtype: string, raw: RawResult): string {
  // The denial goes in the failure itself, not only in a warning the HTTP
  // layer may never read: a run that failed because one tool was refused looks
  // like a generic CLI error otherwise, and the fix is a line of config.
  const denied = describeDenials(permissionDenials(raw))
  return (
    `${what} ended with subtype ${subtype} (is_error: ${String(raw.is_error)})` +
    (denied === "" ? "" : `. ${denied}`)
  )
}


// ---------------------------------------------------------------------------
// The gate's two exits
// ---------------------------------------------------------------------------

/**
 * The run an action names, or a refusal.
 *
 * The registry is a cache of live resources - the lock, the child, the
 * parse-time bytes - and never the source of truth, so a run it does not hold
 * is rehydrated from its log. That is what makes the gate survive a server
 * restart, which design §3.1 requires: a plan can sit there for hours.
 */
async function held(
  options: ActionOptions,
  reasons: WaitReason[],
  what: string,
  /**
   * A second refusal, for an action whose own precondition needs the run: the
   * funds a turn would spend, or the figure a raise was given.
   *
   * It runs **inside** the same guard as `requireRest` on purpose. A refusal
   * raised after this function returns would leave a run this call had just
   * rehydrated registered and holding the project's lock with nothing driving
   * it, which is the case the `catch` below exists for.
   */
  check?: (run: ActiveRun) => void,
): Promise<ActiveRun> {
  const live = active.get(options.runId)
  if (live !== undefined) {
    requireRest(live, reasons, what)
    check?.(live)
    live.accepted = options.accepted ?? null
    return live
  }
  const run = await rehydrate(options)
  try {
    requireRest(run, reasons, what)
    check?.(run)
  } catch (e) {
    // Rehydrating took the lock and switched the branch. A run left registered
    // here would hold the project with nothing driving it, and `resumeRun`
    // would then report it as live and refuse to move it.
    await retire(run)
    throw e
  }
  return run
}



/** Refuses an action the run's rest state does not accept. */
function requireRest(run: ActiveRun, reasons: WaitReason[], what: string): void {
  if (run.driving !== null) {
    throw new RunRefusal(
      "wrong-state",
      `run ${run.runId} is working right now (phase ${run.phase}), so it cannot ${what} yet`,
    )
  }
  const rest = run.rest
  if (rest !== null && rest.kind === "waiting" && reasons.includes(rest.reason)) return
  const where =
    rest === null
      ? "working"
      : rest.kind === "waiting"
        ? `waiting for ${rest.reason}`
        : rest.kind
  throw new RunRefusal(
    "wrong-state",
    `run ${run.runId} is ${where}, so it cannot ${what}. kantan allows one action per rest point, and the run log is the record of which one it reached.`,
  )
}

/**
 * Approves the plan, which starts a **fresh** implement session.
 *
 * The new id is minted here and written onto the implement `phase` record,
 * which is its only home: the header is already on disk, the log is
 * append-only, and a permanently `null` header field would send readers to the
 * phase record anyway (design §3.1). Resuming the plan session instead would
 * run the implement prompt inside the planning conversation and exit
 * `success`, with nothing to catch.
 */
export async function approveGate(options: ActionOptions): Promise<RunResult> {
  const run = await held(options, ["gate"], "be approved")
  return await drive(run, async () => {
    await run.log.append({ kind: "human", action: "approve" })
    run.implementSessionId = randomUUID()
    run.effort = run.project.implementEffort
    run.signatures = []
    return await implementLoop(run, {
      phase: "implement",
      prompt: implementPrompt({ task: run.taskSpec, planPath: run.planPath }),
      spawn: "fresh",
    })
  })
}

/**
 * The gate's other exit: the human's words, in the **plan** session.
 *
 * Only the plan-to-implement boundary is a new conversation, so this resumes
 * `planSessionId` on the plan model, and re-dictates the plan path from the run
 * rather than deriving a fresh one - the gate is rendering that exact file.
 */
export async function sendFeedback(
  options: ActionOptions & { feedback: string },
): Promise<RunResult> {
  const run = await held(options, ["gate"], "take feedback", (r) =>
    requireFunds(r, "take feedback"),
  )
  return await drive(run, async () => {
    await run.log.append({ kind: "human", action: "feedback", text: options.feedback })
    return await planTurn(
      run,
      feedbackPrompt({ planPath: run.planPath, feedback: options.feedback }),
      true,
    )
  })
}

// ---------------------------------------------------------------------------
// Implement, test, refine
// ---------------------------------------------------------------------------

/** One agent turn in the implement conversation. */
interface ImplementTurn {
  phase: RunPhase
  prompt: string
  /**
   * - `fresh`: a new conversation, `--session-id`. Gate approval only.
   * - `reuse`: the live process, no spawn at all - which is why post-gate
   *   phases share one process until effort changes.
   * - `respawn`: end the process and `--resume` it, which is the only way to
   *   change `--effort`, a spawn-time flag.
   */
  spawn: "fresh" | "reuse" | "respawn"
}

/**
 * The loop from design §3: an agent turn, then the server's own verification,
 * then either done or another turn.
 *
 * **The server runs the tests and branches on the exit code** (§3.3). The
 * agent's `ORCH: done` only means it believes it is finished; nothing here
 * takes its word, and the checkbox is ticked only after the exit code passes.
 */
async function implementLoop(run: ActiveRun, first: ImplementTurn | null): Promise<RunResult> {
  let next: ImplementTurn | null = first
  for (;;) {
    if (stopping(run)) return await interrupted(run, run.phase)
    if (next !== null) {
      const turn = next
      next = null
      const parked = await agentTurn(run, turn)
      if (parked !== null) return parked
    }

    const verified = await verify(run)
    if (verified.kind === "unrunnable") return await fail(run, verified.why)
    if (verified.kind === "passed") return await finish(run)

    next = await afterFailure(run, verified)
    if (next === null) {
      await closeSession(run)
      return await park(
        run,
        "refine",
        "stalled",
        `the same failure signature three times at effort ${run.effort}, which is the top of the ladder, so kantan stopped rather than raising further: design §3.4 excludes \`max\` because it measures worse than \`xhigh\`. The last test output is in the run log.`,
      )
    }
  }
}

/**
 * Sends one turn to the implement conversation, and returns a rest point only
 * if the run cannot continue.
 *
 * The session mapping is carried, never reconstructed: every spawn here passes
 * `implementSessionId`, and `sessionId` is written on the `phase` record
 * **exactly when this record spawned a process**, which is what lets a resumed
 * run split the log into per-process cost windows.
 *
 * Which flag carries that id is decided by `run.implementStarted` and not by
 * `turn.spawn` alone. A run that parked on its budget at the implement boundary
 * has an id and no conversation: approval minted one and `refuseIfSpent`
 * declined the spawn, so nothing in the log carries it. `--resume` would then
 * meet `No conversation found` and a raisable park would end as a failed run.
 */
async function agentTurn(run: ActiveRun, turn: ImplementTurn): Promise<RunResult | null> {
  // Minted here only for a conversation that never started - which a run
  // rehydrated from such a park is, because the id was never written down.
  // Minting one for a *started* conversation would silently abandon its
  // context, so the `implementStarted` half is the load-bearing one.
  if (run.implementSessionId === null && !run.implementStarted) {
    run.implementSessionId = randomUUID()
  }
  const sessionId = run.implementSessionId
  if (sessionId === null) {
    throw new Error(
      `run ${run.runId} has no implement session id, so there is no conversation to send a turn to; it is minted at gate approval`,
    )
  }

  if (stopping(run)) return await interrupted(run, turn.phase)
  if (turn.spawn === "respawn") await closeSession(run)
  // Read **after** `closeSession`, which banks the spend the refusal below
  // judges: a respawn that ran the old total would see a ceiling it had
  // already spent as still fundable, and spawn the turn §3.4 exists to decline.
  const spawning = run.session === null
  if (spawning) {
    const refused = await refuseIfSpent(run, turn.phase)
    if (refused !== null) return refused
    // **A conversation that has not started cannot be sent a prompt that
    // assumes it has.** `resumePrompt` opens with "everything you did before is
    // still in context" and `answerPrompt` says "carry on from where you
    // stopped"; neither carries the task or the plan path, because the
    // implement prompt already did. Sending one into a fresh conversation would
    // have the agent work with no task and exit `success`, with nothing to
    // catch - strictly worse than the `No conversation found` this replaced.
    //
    // Both callers that could get here are built not to: `continueFrom` sends
    // `implementPrompt` as a `fresh` turn, and `answerQuestion` refuses before
    // it spends the human's words (see `requireFunds`). So this is a guard on
    // their agreement, loud on purpose.
    if (!run.implementStarted && turn.spawn !== "fresh") {
      throw new Error(
        `run ${run.runId} would send a ${turn.phase} turn into an implement conversation that has never run a process, so the prompt would assume context that does not exist; a first turn must be a "fresh" spawn carrying the implement prompt`,
      )
    }
    run.session = PhaseSession.start(
      {
        project: run.project,
        sessionId,
        // **The fact, not the intent.** `--session-id` is for a conversation
        // that does not exist yet and `--resume` for one that does, and only
        // `implementStarted` knows which this is: a `respawn` after a budget
        // park at the implement boundary has an id the CLI has never seen. A
        // `fresh` turn comes from the gate, where this is false anyway, so this
        // subsumes `turn.spawn !== "fresh"` rather than contradicting it.
        resume: run.implementStarted,
        model: run.project.implementModel,
        effort: run.effort,
        remainingUsd: remaining(run),
      },
      run.log,
    )
  }
  const session = run.session
  if (session === null) throw new Error("unreachable: the session was just started")
  if (spawning) {
    // The conversation now exists for the CLI, which is what makes `--resume`
    // legal for every later turn on it.
    run.implementStarted = true
    accept(run)
  }

  run.phase = turn.phase
  await run.log.append({
    kind: "phase",
    phase: turn.phase,
    state: "running",
    at: Date.now(),
    // **A `phase` record carries a `sessionId` exactly when it spawned**, which
    // is the invariant a resumed run splits per-process cost windows on. A
    // refine turn on the live process must not carry one, or its window would
    // close early and the spend be counted twice.
    ...(spawning ? { sessionId } : {}),
  })

  const end = await session.turn(turn.prompt)
  if (end.kind === "ended") {
    run.session = null
    run.spent += session.processSpend
    const verdict = judge(null, end.exit)
    if (verdict.kind === "killed") return await interrupted(run, turn.phase)
    return await fail(run, cliSaid(`the ${turn.phase} phase`, end.exit))
  }

  const outcome = phaseOutcome(end.raw)
  warnOfDenials(run, end.raw)
  if (outcome.state === "done") return null
  // Everything else is a rest point, and none of them keeps a child alive: a
  // human may take hours, and an idle child dies with the next server reload.
  await closeSession(run)
  if (outcome.state === "question") return await park(run, turn.phase, "question", outcome.text)
  if (outcome.state === "blocked") return await park(run, turn.phase, "blocked", outcome.reason)
  return await endedInError(run, turn.phase, outcome.subtype, end.raw, session.budgetGiven)
}

/** Closes the live child, banking its spend. */
async function closeSession(run: ActiveRun): Promise<void> {
  const session = run.session
  if (session === null) return
  run.session = null
  await session.finish()
  run.spent += session.processSpend
}

// ---------------------------------------------------------------------------
// The server's own verification
// ---------------------------------------------------------------------------

type Verified =
  | { kind: "passed" }
  | { kind: "failed"; signature: string; outcome: TestOutcome }
  /** The project is misconfigured rather than failing. */
  | { kind: "unrunnable"; why: string }

/**
 * Runs the project's `testCmd` and records what it did.
 *
 * Three things here are not obvious:
 *
 * - **A stale JUnit report makes a false stall.** `failureSignature` prefers
 *   `project.reportPath` and cannot tell a fresh report from the previous
 *   attempt's, and a run killed before it flushed leaves one that parses
 *   perfectly and names the *previous* failures. Two attempts then hash equal
 *   and the detector escalates against a run that was converging. Only the code
 *   that starts the command knows when the run began, so it deletes the report
 *   first.
 * - **`reportPath` has to be joined with the repo**, or the JUnit branch is
 *   dead for every project, always, with no error: `validateProject` refuses an
 *   absolute `reportPath`, so every stored value is relative, and
 *   `failureSignature` resolves nothing.
 * - **`runTests` rejects for a misconfigured project** and resolves for a
 *   failing one - including exit 127 for a missing command. Feeding a missing
 *   directory to the agent as a test failure would spend the budget fixing
 *   tests in a directory that does not exist.
 */
async function verify(run: ActiveRun): Promise<Verified> {
  run.phase = "test"
  await run.log.append({ kind: "phase", phase: "test", state: "running", at: Date.now() })
  let report: string | null
  try {
    report = reportFileFor(run.project)
    // Inside the same guard: a report that cannot be removed is a
    // misconfigured project too, and letting it throw would make a stale XML
    // into a fault that ends the run.
    if (report !== null) await deleteStaleReport(report)
  } catch (e) {
    return { kind: "unrunnable", why: (e as Error).message }
  }

  run.attempt += 1
  let outcome: TestOutcome
  try {
    outcome = await runTests(run.project)
  } catch (e) {
    return { kind: "unrunnable", why: (e as Error).message }
  }

  if (outcome.exitCode === 0) {
    await run.log.append({ kind: "test", exitCode: 0, attempt: run.attempt })
    return { kind: "passed" }
  }
  // The joined path, passed explicitly: `stall.ts`'s `TestOutcome` carries
  // `reportPath` and `testrun.ts`'s does not, and they are assignable to each
  // other, so forgetting it leaves the JUnit branch silently dead.
  const signature = await failureSignature({
    exitCode: outcome.exitCode,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    ...(report === null ? {} : { reportPath: report }),
  })
  await run.log.append({
    kind: "test",
    exitCode: outcome.exitCode,
    attempt: run.attempt,
    signature,
  })
  return { kind: "failed", signature, outcome }
}

/**
 * `project.reportPath` joined with the repo, or `null` when there is none.
 *
 * The `..` check belongs to whoever joins (docs/HANDOFF.md), and this is the
 * only caller that joins it - which matters more here than for the signature,
 * because this path is **unlinked**. `reportPath` may legitimately contain
 * `..` in a monorepo, so the rule is not "no `..`" but "stays inside the
 * repo": a value that escapes would have kantan delete a file outside the
 * project it was given.
 */
function reportFileFor(project: Project): string | null {
  const raw = project.reportPath
  if (raw === undefined || raw === "") return null
  const root = resolve(project.path)
  const joined = resolve(root, raw)
  const rel = relative(root, joined)
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `reportPath ${JSON.stringify(raw)} resolves to ${joined}, which is outside the project at ${root}. kantan deletes that file before each test run so a stale report cannot be hashed as this attempt's failures, and it will not delete anything outside the repo.`,
    )
  }
  return joined
}

/** Removes the previous attempt's report. Absent is the normal case. */
async function deleteStaleReport(file: string): Promise<void> {
  try {
    await unlink(file)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return
    throw new Error(
      `cannot delete the previous test report at ${file}: ${(e as Error).message}. Leaving it would let the stall detector hash the last attempt's failures as this one's.`,
      { cause: e },
    )
  }
}

/**
 * The next turn after a failing suite, or `null` when the ladder is out.
 *
 * **Progress, not attempt counts** (design §3.4). A changing signature is
 * progress and runs freely - nine failures down to four down to one is never
 * interrupted. Three *consecutive identical* signatures are a loop, and the
 * answer is to raise effort and continue, not to stop.
 *
 * The streak resets at each level, so every effort gets its own three
 * attempts: the ladder in §3.4 reads `medium -> test, stall -> high -> test,
 * stall -> xhigh`, one stall per step. Carrying the streak over would escalate
 * on the first failure after a raise, before the new level had a chance to
 * work.
 */
async function afterFailure(run: ActiveRun, failed: Verified): Promise<ImplementTurn | null> {
  if (failed.kind !== "failed") throw new Error("unreachable: only a failure needs a next turn")
  const stepped = stepLadder({ effort: run.effort, signatures: run.signatures }, failed.signature)
  run.effort = stepped.state.effort
  run.signatures = stepped.state.signatures

  const prompt = refinePrompt({
    task: run.taskSpec,
    planPath: run.planPath,
    exitCode: failed.outcome.exitCode,
    output: testOutputFor(failed.outcome),
    timedOut: failed.outcome.timedOut,
  })

  if (stepped.verdict === "stalled") return null
  // A raise respawns, because `--effort` is set at spawn time. `--resume`
  // accepts a different one and keeps the conversation (probed), so the only
  // cost is a cold prompt cache.
  const spawn =
    stepped.verdict === "raised" ? "respawn" : run.session === null ? "respawn" : "reuse"
  return { phase: "refine", prompt, spawn }
}

/** Where the stall detector stands: the level, and the identical signatures
 * seen at it so far. */
interface Ladder {
  effort: Effort
  signatures: string[]
}

/**
 * The escalation rule, in one place.
 *
 * **Used twice**, and that is the reason it is a function: the live loop steps
 * it after each test run, and a resumed run folds it over the signatures in the
 * log. Nothing records the current effort - `PhaseRecord` has no field for it
 * and the header holds only the starting value - so a resumed run that
 * recomputed this differently would quietly drop back to `medium` after an
 * escalation, spend a cold cache getting there again, and report the wrong
 * level in the UI. Two implementations of a rule with no observable disagreement
 * is the shape of that bug.
 */
function stepLadder(
  state: Ladder,
  signature: string,
): { state: Ladder; verdict: "continue" | "raised" | "stalled" } {
  const previous = state.signatures.at(-1)
  // A changing signature is progress, and progress runs freely: nine failures
  // down to four down to one is never interrupted.
  const signatures =
    previous !== undefined && previous !== signature
      ? [signature]
      : [...state.signatures, signature]

  if (signatures.length < STALL_STREAK) {
    return { state: { effort: state.effort, signatures }, verdict: "continue" }
  }
  const raised = nextEffort(state.effort)
  if (raised === null) return { state: { effort: state.effort, signatures }, verdict: "stalled" }
  // The streak resets at each rung, so every level gets its own three attempts:
  // §3.4's ladder is one stall per step. Carrying the streak over would
  // escalate on the first failure after a raise, before the new level had a
  // chance to work.
  return { state: { effort: raised, signatures: [] }, verdict: "raised" }
}

/** Three identical signatures in a row are a loop rather than slow progress. */
const STALL_STREAK = 3

/**
 * The effort ladder: one step up, and **`max` is not on it**.
 *
 * Anthropic's FrontierCode figures show Sonnet 5.5 scoring lower at Max than at
 * xhigh, so the top setting is worse rather than merely dearer, and past
 * `xhigh` the human is the better next step.
 *
 * The dimension is the project's configured level, which can be any `Effort`:
 *
 * | From | To | Why |
 * |---|---|---|
 * | `low` | `medium` | a project may start below the design's default |
 * | `medium` | `high` | the design's own first step |
 * | `high` | `xhigh` | the last rung |
 * | `xhigh` | stop | the ladder ends here on purpose |
 * | `max` | stop | already above the ladder; stepping *down* to `xhigh` would read as an escalation while lowering the setting |
 */
const LADDER: readonly Effort[] = ["low", "medium", "high", "xhigh"]

function nextEffort(current: Effort): Effort | null {
  const at = LADDER.indexOf(current)
  if (at === -1) return null
  return LADDER[at + 1] ?? null
}

/**
 * What the refine turn is shown.
 *
 * Bounded, because `runTests` keeps up to 1 MiB **per stream** and the tail is
 * where every runner prints its summary. Two full megabytes per refine turn
 * would be real money on every attempt, and the agent can run the suite itself
 * if it needs more.
 */
const REFINE_OUTPUT_BYTES = 8000

function testOutputFor(outcome: TestOutcome): string {
  const both = [outcome.stdout, outcome.stderr].filter((s) => s.trim() !== "").join("\n")
  return both.length <= REFINE_OUTPUT_BYTES ? both : both.slice(-REFINE_OUTPUT_BYTES)
}

// ---------------------------------------------------------------------------
// Done: the tick, the commit, and the way back to base
// ---------------------------------------------------------------------------

/**
 * The tests passed by exit code, so the task is done.
 *
 * In this order, and the order is the point: tick, commit the tick, return the
 * checkout to base, then write the `end` record last so the warnings the
 * previous steps raised are in it.
 */
async function finish(run: ActiveRun): Promise<RunResult> {
  await closeSession(run)
  // A stop that landed while the suite was running: the tests passed, but
  // nobody asked kantan to write to the backlog and move the checkout after
  // the human pressed stop. The resumed run re-runs them and ticks then.
  if (stopping(run)) return await interrupted(run, "test")
  await tickCheckbox(run)
  await goHome(run)
  await run.log.append({
    kind: "end",
    state: "done",
    costUsd: run.spent,
    // In their own field rather than squeezed into `why`, which is documented
    // as why a run *failed*. A done run can still have things a human needs to
    // see - a feature file edited mid-run, a checkout that could not return to
    // base - and the log is the only place they survive a restart.
    ...(run.warnings.length === 0 ? {} : { warnings: [...run.warnings] }),
  })
  const out = result(run, { kind: "done" })
  await retire(run)
  return out
}

/**
 * Ticks the task, and commits that tick on the task branch.
 *
 * **The server is the only writer of task state** (design §3.3), and this is
 * the only place it writes. `tickTaskInFile` is handed the run's *parse-time*
 * `FeatureFile`, which is the only way its mid-run-edit warning can fire: it
 * compares against those bytes, so a caller that re-read the file immediately
 * before ticking could never see a change.
 *
 * `written === false` means the task was already ticked, with no disk access at
 * all. That is not a success to report: either the agent edited the backlog
 * despite both prompts forbidding it, or this is a resumed run that had already
 * ticked before it was interrupted. Both are worth a line on screen, and
 * neither is worth failing a verified run over.
 *
 * The commit is the server's, not the agent's, and it names the file as a
 * pathspec: the tree may hold work that is not ours, and `returnToBase` refuses
 * to move a dirty checkout - so an uncommitted tick would either block the
 * return or be carried onto base, which is exactly what design §3.6 wants
 * avoided.
 */
async function tickCheckbox(run: ActiveRun): Promise<void> {
  let written: boolean
  try {
    const tick = await tickTaskInFile(run.feature, run.taskSpec.ref)
    written = tick.written
    if (tick.warning !== null) run.warnings.push(tick.warning)
  } catch (e) {
    // An error on an unchanged file comes through without the file's path.
    run.warnings.push(
      `the tests passed but ${run.taskSpec.ref} could not be ticked in ${run.feature.path}: ${(e as Error).message}`,
    )
    return
  }

  if (!written) {
    run.warnings.push(
      `${run.taskSpec.ref} was already ticked in ${run.featureRel}, so kantan wrote nothing: either something else ticked it - the prompts forbid the agent from touching that file - or this run had already ticked it before it was interrupted.`,
    )
    return
  }

  const committed = await gitSays(run.repo.root, [
    "commit",
    "-m",
    `chore: tick ${run.taskSpec.ref} in ${run.featureRel}`,
    "-m",
    `kantan ran ${JSON.stringify(run.project.testCmd)} and it exited 0, so ${run.taskSpec.ref} is done. Run ${run.runId}.`,
    "--",
    run.featureRel,
  ])
  if (committed !== null) {
    run.warnings.push(
      `${run.taskSpec.ref} was ticked in ${run.featureRel}, but committing it on ${run.branch} failed: ${committed} The tick is in the working tree, uncommitted.`,
    )
  }
}

/**
 * Returns the checkout to the base recorded at run start (design §3.6).
 *
 * Never `recordBaseBranch`: the checkout is on the task's own `orch/` branch by
 * now, which that function refuses, and re-deriving a base is the stacking bug
 * it exists to prevent. A run whose log carries no base says so and stays on
 * its branch rather than guessing.
 */
async function goHome(run: ActiveRun): Promise<void> {
  if (run.base === null) {
    run.warnings.push(
      `this run's log records no base branch, so kantan left the checkout on ${run.branch} rather than guessing where to return it. \`git switch\` to your base branch when you are ready.`,
    )
    return
  }
  try {
    await returnToBase(run.repo, run.base)
  } catch (e) {
    run.warnings.push(
      `the task is done, but the checkout could not return to ${run.base}: ${(e as Error).message}`,
    )
  }
}

/** Runs git in the user's repo. `null` when it worked, else what git said. */
async function gitSays(cwd: string, args: string[]): Promise<string | null> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code === 0) return null
  const said = (err.trim() || out.trim()).split("\n").slice(0, 4).join(" ")
  return `git ${args[0] ?? ""} exited ${code}: ${said}`
}

/**
 * A denied tool call, named.
 *
 * Read from the result event whatever its subtype says, because a run can end
 * `success` with a tool refused: the agent reports what it could not do rather
 * than failing, so anything that only looked at the error fields would say the
 * run worked. `src/permissions.ts` owns the naming, so this does not re-read
 * the array.
 */
function warnOfDenials(run: ActiveRun, raw: RawResult): void {
  const described = describeDenials(permissionDenials(raw))
  if (described !== "") run.warnings.push(described)
}

// ---------------------------------------------------------------------------
// Reading a run back off its log
// ---------------------------------------------------------------------------

/**
 * What a log says about a run that is not in the registry.
 *
 * This is a **focused** fold, not `src/runindex.ts`'s. That one answers "what
 * state is this task in?" for the tree, from the two ends of the file, and
 * deliberately reports cost as a *floor* because a full parse on every render
 * would be wasteful. Resuming needs three things it does not provide: the exact
 * spend, so the next process gets the right `--max-budget-usd`; the implement
 * session id, so the respawn resumes the right conversation; and every test
 * signature, so the effort ladder can be replayed. All three need the whole
 * file, which is cheap once per resume and dear once per render.
 */
interface Folded {
  header: RunHeader
  ended: { state: string; why?: string } | null
  /** The last **complete** phase record. A truncated tail is indistinguishable
   * from a missing one, and `replay` holds an unterminated line rather than
   * parsing it - so a half-written record means resuming one step earlier than
   * the server really got, which is the safe direction: the step before is
   * either re-running the tests or re-sending a turn into a conversation that
   * already has the context. */
  lastPhase: PhaseRecord | null
  planPath: string | null
  /**
   * The implement conversation, or `null` when no process ever ran in one.
   *
   * In a log those two are the same fact, because a `phase` record carries a
   * session id **exactly when it spawned**. In memory they are not: approval
   * mints the id before anything spawns, which is why `ActiveRun` carries
   * `implementStarted` separately.
   */
  implementSessionId: string | null
  /** The sum of the last result of **each process**. Cost resets per process,
   * so the windows are split on the phase records that spawned one. */
  spent: number
  /**
   * The run's ceiling: the header's figure, plus every `human` `raise` recorded
   * after it.
   *
   * Read from the log rather than from `project.budgetUsd` because a raise is a
   * decision about **this run** - design §3.4 allows a per-run ceiling, and
   * `projects.json` holds the next run's default (see `HumanRecord`). A resumed
   * run that re-read the store would hand the next process a remainder the
   * human never granted, in either direction.
   */
  budgetUsd: number
  attempt: number
  /** Every failing attempt's signature, in order. */
  signatures: string[]
  /** The last result's text, so a rehydrated question still has its question. */
  lastText: string
}

async function foldForResume(path: string): Promise<Folded> {
  let header: RunHeader | null = null
  let ended: { state: string; why?: string } | null = null
  let lastPhase: PhaseRecord | null = null
  let planPath: string | null = null
  let implementSessionId: string | null = null
  let spent = 0
  let attempt = 0
  let lastText = ""
  /** Overwritten by every usable `raise`, so the newest one wins. */
  let budgetUsd: number | null = null
  const signatures: string[] = []
  /** The newest result figure inside the process window still open. */
  let windowCost: number | null = null

  for await (const record of replay(path)) {
    switch (record.kind) {
      case "header":
        header = record
        break
      case "phase": {
        if (record.sessionId !== undefined) {
          // A spawn closes the previous process's window. Summing every result
          // instead would double-count: within one process the figure is
          // cumulative, so each turn's total includes the ones before it.
          spent += windowCost ?? 0
          windowCost = null
          if (record.phase === "implement" || record.phase === "refine") {
            implementSessionId = record.sessionId
          }
        }
        if (record.planPath !== undefined) planPath = record.planPath
        lastPhase = record
        break
      }
      case "cli": {
        const result = resultOfEvent(record.event)
        if (result === null) break
        const figure = result.total_cost_usd
        if (typeof figure === "number" && Number.isFinite(figure)) windowCost = figure
        if (typeof result.result === "string") lastText = result.result
        break
      }
      case "test":
        attempt = typeof record.attempt === "number" ? record.attempt : attempt + 1
        if (typeof record.signature === "string") signatures.push(record.signature)
        break
      case "human": {
        // The raise. Validated rather than trusted: this is a file another
        // process wrote, and a ceiling of `NaN` would make every later
        // remainder non-finite - which `src/spawn.ts` throws on, by design,
        // because flooring it would hide a broken total for the rest of the
        // run. A figure this reader cannot use leaves the previous ceiling
        // standing, which is the restrictive direction.
        if (record.action !== "raise") break
        const figure: unknown = record.budgetUsd
        if (typeof figure === "number" && Number.isFinite(figure) && figure > 0) budgetUsd = figure
        break
      }
      case "end":
        ended = { state: record.state, ...(record.why === undefined ? {} : { why: record.why }) }
        break
      default:
        // A kind this version does not know: a newer writer's record, which
        // `replay` passes through on purpose. Not ours to interpret.
        break
    }
  }
  spent += windowCost ?? 0

  if (header === null) {
    throw new Error(
      `${path} has no header on line one, so nothing in it can be interpreted; kantan cannot resume this run`,
    )
  }
  return {
    header,
    ended,
    lastPhase,
    planPath,
    implementSessionId,
    spent,
    attempt,
    signatures,
    lastText,
    budgetUsd: budgetUsd ?? header.budgetUsd,
  }
}

/** The raw result object a logged `cli` payload carries, if it is one. */
function resultOfEvent(event: unknown): RawResult | null {
  if (event === null || typeof event !== "object" || Array.isArray(event)) return null
  const record = event as Record<string, unknown>
  if (record["type"] !== "result") return null
  return record as unknown as RawResult
}

/**
 * Rebuilds a run from its log, taking the lock and the branch again.
 *
 * Steps 1 and 2 of `src/git.ts`'s order, then `resumeTaskBranch` - and
 * **never** `recordBaseBranch`: the branch and the base come from the header,
 * and re-deriving them is both refused (HEAD is on the task's own `orch/`
 * branch) and the branch-stacking bug the base discipline exists to prevent.
 * The dirty check `resumeTaskBranch` carries is the resume-shaped one: a run's
 * own half-written files are exempt only while the checkout is still on its
 * branch.
 */
async function rehydrate(options: ActionOptions): Promise<ActiveRun> {
  const { project, runId } = options
  const path = runLogPath(runId, options.runsDir)
  let folded: Folded
  try {
    folded = await foldForResume(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new RunRefusal(
        "unknown-run",
        `kantan has no run ${runId}: there is no log at ${path}`,
        { cause: e },
      )
    }
    throw e
  }
  const { header } = folded
  if (folded.ended !== null) {
    throw new RunRefusal(
      "wrong-state",
      `run ${runId} already finished (${folded.ended.state}${folded.ended.why === undefined ? "" : `: ${folded.ended.why}`}), so there is nothing left to drive. Start the task again.`,
    )
  }
  if (header.projectPath !== project.path) {
    throw new RunRefusal(
      "unknown-project",
      `run ${runId} belongs to the project at ${header.projectPath}, not to ${project.path}. The run log's path is the project record's identity, so these are two different projects even if they are two spellings of one directory.`,
    )
  }
  // Refused by name rather than carried: a ceiling that is not a positive
  // finite number makes every remainder non-finite, which `src/spawn.ts` throws
  // on by design - and that throw would arrive from inside a drive, where it
  // reads as the run having faulted rather than as a log kantan cannot
  // interpret. The log is a file another process wrote, so this is input.
  if (!Number.isFinite(folded.budgetUsd) || folded.budgetUsd <= 0) {
    throw new RunRefusal(
      "wrong-state",
      `run ${runId}'s log gives its budget ceiling as ${JSON.stringify(folded.budgetUsd)}, which is not a positive number of dollars, so kantan cannot work out what \`--max-budget-usd\` to give the next process. Start the task again.`,
    )
  }
  const ref = (header.taskRef ?? "").trim()
  const featureRel = header.featureFile
  if (ref === "" || featureRel === undefined || featureRel === "") {
    throw new RunRefusal(
      "unknown-task",
      `run ${runId}'s header names no task (featureFile ${JSON.stringify(featureRel)}, taskRef ${JSON.stringify(header.taskRef)}), so kantan cannot tell which branch or checkbox it owns`,
    )
  }

  const repo = await refusing("unknown-project", () => requireUsableRepo(project.path))
  const branch = taskBranchName({ feature: featureRel, ref })
  const lock = await refusing("busy", () => acquireRunLock(repo, { runId, branch }))
  let keepLock = false
  try {
    // Steps 1 and 2, then this - and **never** `recordBaseBranch`.
    await refusing("dirty", () => resumeTaskBranch(repo, branch))

    const warnings: string[] = []
    const feature = await readFeature(join(project.path, featureRel))
    // The mid-run-edit warning, raised here rather than by `tickTaskInFile`:
    // that function compares against the `FeatureFile` it is handed, and a
    // resumed run has only just read the file, so it holds nothing older to
    // compare against. The hash on line one is what survives the restart.
    if (header.featureFileHash !== undefined && featureFileHash(feature.src) !== header.featureFileHash) {
      warnings.push(
        `${featureRel} has changed on disk since this run parsed it. kantan re-resolves ${ref} by its ref rather than by line, so the tick will still land on the right task, but the text the agent was given came from the older bytes.`,
      )
    }
    const ladder = replayLadder(header.implementEffort, folded.signatures)
    const log = await openRunLog(path)
    const run: ActiveRun = {
      runId,
      project,
      repo,
      lock,
      log,
      branch,
      base: header.baseBranch ?? null,
      planPath: folded.planPath ?? "",
      feature,
      featureRel,
      taskSpec: taskSpecFor(feature, ref, featureRel, { requireOpen: false }),
      planSessionId: header.planSessionId,
      implementSessionId: folded.implementSessionId,
      // In a log the id is present exactly when a process ran in that
      // conversation, so this is that fact rather than a second source of it.
      implementStarted: folded.implementSessionId !== null,
      // The folded ceiling, never `header.budgetUsd`: a run whose ceiling the
      // human raised must come back with the raise, or the resumed run hands
      // the next process a remainder nobody granted and parks again on the
      // figure that had already been overruled.
      budgetUsd: folded.budgetUsd,
      spent: folded.spent,
      effort: ladder.effort,
      signatures: ladder.signatures,
      attempt: folded.attempt,
      phase: folded.lastPhase?.phase ?? "plan",
      session: null,
      driving: null,
      stopped: false,
      accepted: options.accepted ?? null,
      rest: restFrom(folded),
      warnings,
    }
    active.set(runId, run)
    keepLock = true
    return run
  } finally {
    if (!keepLock) await releaseRunLock(lock)
  }
}

/** The effort and streak a run had reached, folded from its logged signatures
 * with the same rule the live loop steps. */
function replayLadder(start: Effort, signatures: readonly string[]): Ladder {
  let state: Ladder = { effort: start, signatures: [] }
  for (const signature of signatures) state = stepLadder(state, signature).state
  return state
}

/** The rest point the log records, or `null` for a run that was working. */
function restFrom(folded: Folded): RunState | null {
  const last = folded.lastPhase
  if (last === null || last.state !== "waiting" || last.reason === undefined) return null
  // The recorded detail first, then the gate's plan path, and the last result's
  // text only as a fallback for a log written before `detail` existed.
  const detail =
    last.detail ??
    (last.reason === "gate" ? (folded.planPath ?? "") : folded.lastText)
  return { kind: "waiting", reason: last.reason, detail }
}

// ---------------------------------------------------------------------------
// The remaining actions
// ---------------------------------------------------------------------------

/**
 * Answers a question the agent asked, in **the session that asked it**.
 *
 * The gate has approve and feedback; a question is a different shape, and this
 * is the third of Task 13's decisions. A question parks the run with no live
 * child, exactly like the gate - a human may take hours, and an idle child dies
 * with the next server reload - and the reply is sent as the next turn on the
 * conversation that asked, which `run.phase` names. Reconstructing that from
 * the phase name would be the two-id trap again: answering a plan question in
 * the implement session runs it in the wrong conversation and exits `success`.
 *
 * `blocked` is answered the same way, because `ORCH: blocked <reason>` is the
 * form the prompts tell an agent to use *instead* of asking: refusing to answer
 * it would leave the run with no way forward but a restart.
 */
export async function answerQuestion(
  options: ActionOptions & { answer: string },
): Promise<RunResult> {
  const run = await held(options, ["question", "blocked"], "take an answer", (r) =>
    requireFunds(r, "take an answer"),
  )
  const phase = run.phase
  return await drive(run, async () => {
    if (phase === "plan") {
      return await planTurn(run, answerPrompt({ answer: options.answer, phase: "plan" }), true)
    }
    return await implementLoop(run, {
      phase,
      prompt: answerPrompt({ answer: options.answer, phase: "implement" }),
      spawn: "respawn",
    })
  })
}

/**
 * The stop button (design §3.4). SIGTERM the child and leave the run
 * **resumable**: the session resumes from the same id, so stopping costs
 * nothing, and no `end` record is written.
 *
 * At the gate there is no child at all, and stopping still has to mean
 * something: the lock goes, so the project stops being busy and another task
 * can run. That is the whole of what is released - the branch, the log and the
 * plan file stay where they are, and `resumeRun` picks the run up again.
 */
export async function stopRun(options: ActionOptions): Promise<RunResult> {
  const run = active.get(options.runId)
  if (run === undefined) return await stopAbsent(options)
  const rest = run.rest
  if (rest !== null && (rest.kind === "done" || rest.kind === "failed")) {
    throw new RunRefusal(
      "wrong-state",
      `run ${options.runId} has already finished (${rest.kind}), so it cannot be stopped`,
    )
  }

  // Set before the kill, because the drive reads it at every remaining side
  // effect: a stop that lands while the test command is running must not go on
  // to tick the checkbox and move the checkout.
  run.stopped = true
  await abandonSession(run)
  const job = run.driving
  if (job !== null) {
    // The drive owns the retirement; it sees the kill as a signal exit, judges
    // it `killed`, and parks the run as interrupted.
    const out = await job.catch(() => result(run, { kind: "interrupted", resumeFrom: run.phase }))
    accept(run)
    return out
  }
  return await interrupted(run, run.phase)
}

/**
 * Stopping a run this process is not driving, which the log has to answer.
 *
 * A finished run is `wrong-state` rather than `unknown-run`: the task tree
 * still shows it, so a 404 would tell the human that a row they are looking at
 * does not exist. A run whose *server* died is already stopped - there is no
 * child and no drive - so that reports the state the log folds to and touches
 * nothing. Its lock names a dead process, which `acquireRunLock` reclaims on
 * the next start, so the project is not left busy either.
 */
async function stopAbsent(options: ActionOptions): Promise<RunResult> {
  const path = runLogPath(options.runId, options.runsDir)
  let folded: Folded
  try {
    folded = await foldForResume(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new RunRefusal("unknown-run", `kantan has no run ${options.runId}: there is no log at ${path}`, {
        cause: e,
      })
    }
    throw e
  }
  if (folded.ended !== null) {
    throw new RunRefusal(
      "wrong-state",
      `run ${options.runId} has already finished (${folded.ended.state}), so there is nothing to stop.`,
    )
  }
  const phase = folded.lastPhase?.phase ?? "plan"
  return {
    runId: options.runId,
    state: { kind: "interrupted", resumeFrom: phase },
    costUsd: folded.spent,
    branch: branchOf(folded.header),
    planPath: folded.planPath ?? "",
    warnings: [
      `run ${options.runId} was not being driven by this server, so there was nothing to stop: it is already interrupted at the ${phase} phase, and resuming it picks it up from there.`,
    ],
  }
}

/** The branch a header's task owns, or `""` when the header cannot name one. */
function branchOf(header: RunHeader): string {
  try {
    return taskBranchName({ feature: header.featureFile, ref: header.taskRef })
  } catch {
    // A header that cannot name a branch is `src/runindex.ts`'s `branch: ""`
    // case, and a stop is no place to start refusing over it.
    return ""
  }
}

/**
 * Picks a run back up after a crash, a reload, or a stop.
 *
 * Where it resumes from is **the last complete `phase` record**, never a guess
 * about what the server was doing: a `test running` record means re-run the
 * tests, and an `implement` or `refine` one means resume that conversation and
 * continue. A run that was already parked at a human is simply reported - there
 * is nothing to drive until someone answers.
 */
export async function resumeRun(options: ActionOptions): Promise<RunResult> {
  const live = active.get(options.runId)
  if (live !== undefined) {
    if (live.driving !== null) {
      throw new RunRefusal(
        "wrong-state",
        `run ${options.runId} is working right now (phase ${live.phase}), so there is nothing to resume`,
      )
    }
    // Parked in this process, holding its lock: nothing to pick up, and a
    // second drive would put two loops on one log.
    live.accepted = options.accepted ?? null
    return result(live, live.rest ?? { kind: "interrupted", resumeFrom: live.phase })
  }

  const run = await rehydrate(options)
  const rest = run.rest
  if (rest !== null) return result(run, rest)
  return await drive(run, () => continueFrom(run))
}

/** The turn a resumed run owes, decided by the phase it was last in. */
async function continueFrom(run: ActiveRun): Promise<RunResult> {
  switch (run.phase) {
    case "plan":
      // The plan prompt again, on `--resume`: it re-dictates the same path and
      // re-states the plan-only rules, and a planning turn that repeats itself
      // rewrites one file. The implement prompt could not be re-sent this way -
      // it re-invokes the execution skill and would redo committed work - which
      // is what `resumePrompt` exists for.
      return await planTurn(
        run,
        planPrompt({ task: run.taskSpec, planPath: run.planPath }),
        true,
      )
    case "gate":
      return await park(run, "gate", "gate", run.planPath)
    case "test":
      // The tests were running when it died, and nothing recorded their
      // outcome, so they run again. No agent turn: the conversation is
      // untouched and re-sending one would cost a turn to say nothing.
      return await implementLoop(run, null)
    case "implement":
    case "refine":
      // **A conversation that never started gets the implement prompt**, not a
      // resume of nothing. This is the budget park at the implement boundary:
      // approval minted the session id and `refuseIfSpent` declined the spawn,
      // so the CLI has never seen it and nothing in the log carries it.
      // `resumePrompt` opens with "everything you did before is still in
      // context" and names neither the task nor the plan, so sending it into a
      // fresh conversation would have the agent work from nothing and exit
      // `success` - and `--resume` would meet `No conversation found` first.
      if (!run.implementStarted) {
        return await implementLoop(run, {
          phase: "implement",
          prompt: implementPrompt({ task: run.taskSpec, planPath: run.planPath }),
          spawn: "fresh",
        })
      }
      return await implementLoop(run, {
        phase: run.phase,
        prompt: resumePrompt({ task: run.taskSpec, planPath: run.planPath }),
        spawn: "respawn",
      })
  }
}

// ---------------------------------------------------------------------------
// The port the HTTP layer drives
// ---------------------------------------------------------------------------

/**
 * `~/.orch/projects.json`, the location the README and design §2 give.
 *
 * Here rather than in `src/projects.ts`, which deliberately takes a path: the
 * store's location is a deployment fact, and this is the only code that has to
 * resolve a project from a request that names one by path.
 */
export function defaultProjectsFile(): string {
  return join(homedir(), ".orch", "projects.json")
}

/** The three parts of a start request, as the HTTP layer receives them. */
export interface StartRequest {
  /** The repo, spelled as `projects.json` spells it. */
  projectPath: string
  /** The feature markdown, relative to the repo root. */
  featureFile: string
  /** The `T<n>` label inside that file. */
  taskRef: string
}

/**
 * The refusal codes the HTTP layer knows, which are **fewer** than
 * `RefusalCode`.
 *
 * `no-base` and `branch-exists` both arrive as `wrong-state`: they are 409s
 * whose message is the whole explanation, and the alternatives are worse.
 * `dirty` would be a lie - a detached HEAD and an existing task branch are not
 * uncommitted work, and the UI hangs `git stash` advice off that code.
 *
 * **The vocabulary is missing a "the repo is not in a state a run can start
 * from" code**, and this mapping is where that shows. Recorded rather than
 * papered over.
 */
export type ActionRefusal =
  | "unknown-project"
  | "unknown-feature"
  | "unknown-task"
  | "unknown-run"
  | "busy"
  | "dirty"
  | "wrong-state"

export interface Refused {
  ok: false
  refusal: ActionRefusal
  /** The machine's own sentence, meant to be rendered as written. */
  message: string
}

export type Started = { ok: true; runId: string } | Refused
export type Acted = { ok: true } | Refused

/**
 * The phase machine as four actions over run ids, which is what the server's
 * routes need.
 *
 * Three things are different here from the functions above, and each is the
 * HTTP layer's requirement rather than a preference:
 *
 * 1. **A call resolves once the transition is accepted**, not when the work
 *    finishes: the run registered, its branch taken and its child spawned. A
 *    phase runs for minutes and Bun cuts an idle connection at about ten
 *    seconds, so a route that awaited the phase would fail while the run
 *    carried on. Everything after the transition reaches the UI through the run
 *    log, which is the only channel that survives a reload anyway.
 * 2. **An expected refusal is a tagged result, not a throw.** A rejection from
 *    one of these means a fault, and deserves a 500.
 * 3. **The machine owns the lookups.** A request names a project by the path
 *    `projects.json` stores, and an action names only a run - so finding the
 *    project record, the feature file and the task is this layer's job, which
 *    is also where the path checks belong, because this is the code that later
 *    writes to that file.
 *
 * It keeps `answer` as well, which the server's port now has too: a run that
 * asked a question is otherwise unreachable, since stopping and resuming only
 * re-park it. `POST /api/runs/:id/answer` is the route.
 */
export interface Runner {
  start(request: StartRequest): Promise<Started>
  approve(runId: string): Promise<Acted>
  feedback(runId: string, text: string): Promise<Acted>
  /** The reply to a `waiting(question)` or `waiting(blocked)` run. */
  answer(runId: string, text: string): Promise<Acted>
  /**
   * The new ceiling for a run parked at a human, in full rather than as a
   * delta, and a run that stopped **on** its budget continues from it.
   *
   * Like `answer`, this is kept here while the server's own port has no
   * counterpart: without it an exhausted run is unreachable, because every
   * other action either refuses for want of funds or re-parks it.
   */
  raise(runId: string, budgetUsd: number): Promise<Acted>
  stop(runId: string): Promise<Acted>
}

export interface RunnerOptions {
  /** Default `~/.orch/projects.json`. */
  projectsFile?: string
  /** Default `~/.orch/runs`. */
  runsDir?: string
  /** Called when a transition is accepted, for a caller that wants to know;
   * the accepted callback is what each action races internally. */
  onAccepted?: () => void
}

/** How a `RefusalCode` reaches the HTTP layer. See `ActionRefusal`. */
const ACTION_REFUSAL: Record<RefusalCode, ActionRefusal> = {
  "unknown-project": "unknown-project",
  "unknown-feature": "unknown-feature",
  "unknown-task": "unknown-task",
  "unknown-run": "unknown-run",
  busy: "busy",
  dirty: "dirty",
  "no-base": "wrong-state",
  "branch-exists": "wrong-state",
  "wrong-state": "wrong-state",
}

export function createRunner(options: RunnerOptions = {}): Runner {
  const projectsFile = options.projectsFile ?? defaultProjectsFile()
  const runsDir = options.runsDir

  /**
   * Runs one action, resolving at the transition rather than at the rest point.
   *
   * The race is the whole mechanism: `accepted` fires once the run is
   * registered and spawned, and a refusal rejects before it ever does. The
   * drive is left running, and its `catch` is not a swallow - `drive` records a
   * fault in the run log as a failed run, so the only thing discarded here is a
   * rejection nobody is left to receive.
   */
  async function act<T>(
    work: (accepted: () => void) => Promise<RunResult>,
    answer: () => T,
  ): Promise<T | Refused> {
    let accept: () => void = () => {}
    const accepted = new Promise<void>((resolve) => {
      accept = () => {
        options.onAccepted?.()
        resolve()
      }
    })
    const driving = work(accept)
    // Attached before the race, so a refusal cannot become an unhandled
    // rejection while the race is still being set up.
    const settled = driving.then(
      () => undefined,
      (e: unknown) => e,
    )
    const failure = await Promise.race([accepted.then(() => undefined), settled])
    if (failure === undefined) return answer()
    if (failure instanceof RunRefusal) {
      return { ok: false, refusal: ACTION_REFUSAL[failure.code], message: failure.message }
    }
    throw failure
  }

  /** The project record a run belongs to, from its log header and the store. */
  async function projectForRun(runId: string): Promise<Project> {
    // A run id reaches here from a URL, and `runLogPath` refuses one that could
    // name anything but a file in the runs directory. That is not a fault: it
    // is a request naming a run that cannot exist.
    let path: string
    try {
      path = runLogPath(runId, runsDir)
    } catch (e) {
      throw new RunRefusal("unknown-run", (e as Error).message, { cause: e })
    }
    let header: RunHeader | null = null
    try {
      for await (const record of replay(path)) {
        if (record.kind === "header") header = record
        break
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        throw new RunRefusal("unknown-run", `kantan has no run ${runId}: there is no log at ${path}`)
      }
      throw e
    }
    if (header === null) {
      throw new RunRefusal(
        "unknown-run",
        `${path} has no header on line one, so kantan cannot tell which project run ${runId} belongs to`,
      )
    }
    return await projectAt(header.projectPath)
  }

  /** The record for `path`, which is the store's own spelling of it. */
  async function projectAt(path: string): Promise<Project> {
    // A damaged store throws rather than refusing: it is the one piece of state
    // no repository can rebuild, and "no projects" would be the wrong answer.
    const project = (await loadProjects(projectsFile)).find((p) => p.path === path)
    if (project === undefined) {
      throw new RunRefusal(
        "unknown-project",
        `${path} is not a project in ${projectsFile}. Register it first; kantan runs only in repos it was told about.`,
      )
    }
    return project
  }

  return {
    async start(request) {
      let runId = ""
      return await act(
        async (accepted) => {
          const project = await projectAt(request.projectPath)
          runId = randomUUID()
          return await startRun({
            project,
            featureFile: request.featureFile,
            task: { ref: request.taskRef },
            runId,
            accepted,
            ...(runsDir === undefined ? {} : { runsDir }),
          })
        },
        () => ({ ok: true as const, runId }),
      )
    },

    async approve(runId) {
      return await act(
        async (accepted) =>
          await approveGate({
            runId,
            project: await projectForRun(runId),
            accepted,
            ...(runsDir === undefined ? {} : { runsDir }),
          }),
        () => ({ ok: true as const }),
      )
    },

    async feedback(runId, text) {
      return await act(
        async (accepted) =>
          await sendFeedback({
            runId,
            project: await projectForRun(runId),
            feedback: text,
            accepted,
            ...(runsDir === undefined ? {} : { runsDir }),
          }),
        () => ({ ok: true as const }),
      )
    },

    async answer(runId, text) {
      return await act(
        async (accepted) =>
          await answerQuestion({
            runId,
            project: await projectForRun(runId),
            answer: text,
            accepted,
            ...(runsDir === undefined ? {} : { runsDir }),
          }),
        () => ({ ok: true as const }),
      )
    },

    async raise(runId, budgetUsd) {
      return await act(
        async (accepted) =>
          await raiseBudget({
            runId,
            project: await projectForRun(runId),
            budgetUsd,
            accepted,
            ...(runsDir === undefined ? {} : { runsDir }),
          }),
        () => ({ ok: true as const }),
      )
    },

    async stop(runId) {
      // Nothing to race: the signal is the whole transition.
      return await act(
        async (accepted) => {
          const project = await projectForRun(runId)
          const out = await stopRun({
            runId,
            project,
            ...(runsDir === undefined ? {} : { runsDir }),
          })
          accepted()
          return out
        },
        () => ({ ok: true as const }),
      )
    },
  }
}
