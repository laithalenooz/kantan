import { open, readdir } from "node:fs/promises"
import { join } from "node:path"
import { defaultRunsDir } from "./runlog"
import type { RunHeader, RunPhase, RunRecord, Verification, WaitReason } from "./runlog"
/* Re-exported, not redefined: the browser imports these from `./runstate`
 * because this module opens files at module scope. See that file's header. */
export { verificationOf } from "./runstate"
export type { RunState, VerificationReading } from "./runstate"
import type { RunState } from "./runstate"

/**
 * What state is this task in?
 *
 * Design §3.6 requires the task tree to answer that from the **run logs**, not
 * only from the working tree: on `done` the checkout returns to base, so the
 * task's tick lives on `orch/<task-slug>` until it is merged and the
 * checked-out markdown reads the task as open. Task 12's "a task
 * done-but-unmerged cannot be started again" has nothing else to consult.
 *
 * **A run's state is the fold of its log** (design §2). Nothing else is state:
 * there is no database, and the log is the only record of what the
 * orchestrator decided.
 *
 * ## What each record kind contributes, including the ones this skips
 *
 * | `kind` | Contributes | Skipped because |
 * |---|---|---|
 * | `header` | the run's identity: `runId`, `taskRef`, `projectPath`, `featureFile`, `startedAt`. Line one, so it is read without touching the rest | - |
 * | `phase` | **the live state.** `running` gives the phase, `waiting` gives the reason, and the last one is where an interrupted run resumes | - |
 * | `end` | the terminal state and the run's total cost, authoritative because the writer summed it | - |
 * | `cli` | nothing but `total_cost_usd`, read as a floor for a run with no `end` record | Interpreting these payloads is `src/stream.ts`'s job; the log keeps them byte-identical precisely so a *future* parser can read them, so an unrecognised payload here is a newer CLI event, never corruption |
 * | `test` | nothing | An exit code does not move the run: the writer follows it with a `phase` record or an `end`. Its `attempt` field counts **test** attempts inside one run and is not this module's `attempts`, which counts runs per task |
 * | `human` | nothing | `approve` is followed by the implement `phase` record and `feedback` by a plan one, so folding it would duplicate a transition the writer already records. The consequence is deliberate: an `approve` that a crash caught leaves the run **still at the gate**, so the human approves again - one idempotent click, instead of a state claiming a phase began that has no session id anywhere |
 * | anything else | nothing, silently | A newer writer's record reaches this fold unchanged (`replay()` does not drop unknown kinds). "Not mine to interpret" is not "corrupt" |
 *
 * ## What a wrong guess costs, in each direction
 *
 * - **A finished run read as running** parks the user in front of a spinner
 *   for a run that will never move again. So an `end` record outranks every
 *   `phase` record, and liveness never overrides it.
 * - **A running run read as finished or interrupted** invites a second run
 *   against a live one. Task 12's lock catches it, but only by refusing with a
 *   message about a lock rather than about a running task, so the caller may
 *   pass `liveRunIds` and have the active run read as `running`.
 * - **A `done` run read as merged** lets a second run start against work that
 *   is not integrated. So `merged` is `false` until the predicate says
 *   otherwise, including when the predicate is absent or throws: "done,
 *   unmerged" is a visible, recoverable refusal.
 */


export interface TaskStatus {
  /** The `T<n>` label the task is addressed by. */
  taskRef: string
  /** Part of the task's identity, not decoration: **every feature file in a
   * repo has a `T1`**, and two projects can hold the same feature path. */
  projectPath: string
  featureFile: string
  /** The newest run's state. */
  state: RunState
  /** The newest run. */
  runId: string
  /**
   * From `branchFor`, never derived here.
   *
   * `""` means `branchFor` threw - `taskBranchName` does, for a whitespace-only
   * ref or an absolute feature path - so this task has no usable branch name
   * and was **not** checked for a merge. A caller passing this on to
   * `createTaskBranch` or `isMergedIntoBase` has to guard against it; the task
   * needs a ref it can own a branch by before either will work.
   */
  branch: string
  /** The newest run's cost. `end.costUsd` for a run that ended; for one that
   * did not, a floor (see `RunSummary.costUsd`). */
  costUsd: number
  /** How many runs this task has had, this one included. A retry does not
   * erase the attempt before it. */
  attempts: number
}

/** The fold of one log. */
export interface RunSummary {
  /**
   * Line one, as the writer wrote it.
   *
   * Only the fields this module keys on are validated - `runId`, `taskRef`,
   * `projectPath`, `featureFile`, `startedAt`. The rest is passed through, so
   * a log from a newer writer that renamed a field hands you an `undefined`
   * instead of vanishing from the tree. A reader that resumes a run should
   * treat these the way it treats any input it did not produce.
   */
  header: RunHeader
  state: RunState
  /**
   * `end.costUsd` when the run ended, which is the writer's own total.
   *
   * For a run with no `end` record this is a **floor**: the largest
   * `total_cost_usd` among the `cli` result events this fold actually read.
   * Cost resets per process (HANDOFF: sum the last result of each process), so
   * one figure is never more than the run really spent, and under-reporting is
   * the direction a budget ceiling survives - Task 14 reconstructs the exact
   * total when it resumes a run, which is a full parse this index refuses to
   * do on every render. `state.kind` says which of the two you have: `done`
   * and `failed` carry the total, everything else carries the floor.
   */
  costUsd: number
  /** The log this was folded from. */
  path: string
}

export interface FoldResult {
  /** `null` when the file carries no usable header, which is the only reason a
   * log is skipped. Never a throw: one unreadable log must not blank the tree. */
  run: RunSummary | null
  /** Why something was skipped or guessed at. Empty on a log this version
   * fully understands. */
  warnings: string[]
}

export interface FoldOptions {
  /**
   * How many bytes to read from each end before giving up on finding a
   * lifecycle record and reading more. Tunable for tests; it changes what is
   * read, never what is folded.
   */
  windowBytes?: number
  /** Run ids the caller knows are live right now. A `running` phase record
   * belonging to one of these folds to `running` rather than `interrupted`,
   * because liveness is not in the log and cannot be. */
  liveRunIds?: Iterable<string>
}

export interface IndexOptions extends FoldOptions {
  /** Default `~/.orch/runs`. Absent or empty is the first-ever state, not an
   * error. */
  runsDir?: string
  /**
   * The branch a task owns. Required, and deliberately not derived here:
   * `src/git.ts`'s `taskBranchName` is `orch/<stem>-<ref>-<sha256:8>`, and a
   * second implementation of that would produce a plausible name pointing at
   * no branch - which would make `merged` meaningless while looking right.
   */
  branchFor: (task: { feature: string; ref: string }) => string
  /**
   * Whether a finished run's branch is already in the base branch. A predicate
   * rather than an import, because the git question is Task 12's and
   * `src/git.ts` owns it (`isMergedIntoBase`, which needs a `Repo` and a base
   * this module has no business knowing).
   *
   * Asked only about runs that reached `done`, and never about a task with no
   * usable branch name - but that is a smaller saving than it sounds, and the
   * measurement says so. Over 500 finished logs, reading them costs 89 ms;
   * adding a predicate that takes 5 ms a row, about what
   * `git merge-base --is-ancestor` costs on a warm repo, costs 2733 ms,
   * because they are awaited one at a time. In steady state most rows are
   * finished runs, so **this call, not the reading, is what a re-render
   * costs.**
   *
   * Caching those answers, or running them concurrently, is deliberately the
   * caller's decision and not this module's: only the caller knows when a
   * branch can have moved - a merge, a push, a branch deleted - and a cache
   * invented here would serve stale merge state to the one guard that exists
   * to refuse a second run.
   *
   * Absent, slow-and-resolving, or throwing all end up as `merged: false`.
   */
  isMerged?: (query: {
    projectPath: string
    featureFile: string
    taskRef: string
    runId: string
    branch: string
  }) => boolean | Promise<boolean>
  /**
   * The project paths still registered in `projects.json`. A log naming
   * anything else is skipped with a warning: someone will delete a project,
   * and its logs outlive it. Omit it and nothing is filtered.
   */
  projects?: Iterable<string>
}

export interface RunIndex {
  /** One entry per task, keyed by `taskKey`, in a stable order. */
  tasks: Map<string, TaskStatus>
  /** Every log that was skipped or guessed at, in filename order. Never
   * thrown: the tree renders what it could read. */
  warnings: string[]
}

/** A task's identity: the project, the feature file **and** the ref. `NUL`
 * separates, because it is the one byte a path cannot contain. */
export function taskKey(task: {
  projectPath: string
  featureFile: string
  taskRef: string
}): string {
  return `${task.projectPath}\u0000${task.featureFile}\u0000${task.taskRef}`
}

const DEFAULT_WINDOW = 64 * 1024
/** Enough for line one of any header this writes, and grown if it is not. The
 * front of a big log is worth one page, not a windowful: the only thing there
 * is the header. */
const HEAD_PROBE = 4 * 1024
/** A ceiling on one read, so walking back through a huge log asks for many
 * reasonable allocations rather than one vast one. */
const MAX_CHUNK = 1024 * 1024
const EMPTY: Buffer = Buffer.alloc(0)
const NEWLINE = 0x0a
const PHASES: readonly RunPhase[] = ["plan", "gate", "implement", "test", "refine"]
const WAIT_REASONS: readonly WaitReason[] = ["gate", "question", "blocked", "stalled"]
/** The header is written before the plan phase starts, so a run with no phase
 * record has nowhere else to resume from. */
const FIRST_PHASE: RunPhase = "plan"

// --- Folding one log --------------------------------------------------------

/**
 * One log's state, read from **both ends rather than all of it**.
 *
 * The tree re-renders often and a run log is raw stream-json, so parsing every
 * byte of every log per render is the wrong shape (design: the log is the live
 * feed *and* the permanent history, so it is the biggest file kantan writes).
 * Everything this fold needs sits at the two ends: the `header` is line one,
 * and `end` and the last `phase` record are at the tail.
 *
 * So it reads a window from each end and escalates **only when the tail window
 * holds no lifecycle record this version can act on** - the one case where
 * reading less would fold wrongly rather than slowly, because a run can emit
 * megabytes of `cli` output after its last `phase` record. A log that fits in
 * one window is read once, whole.
 *
 * Windowing forces this to frame lines itself, and it uses exactly the rule
 * `replay()` documents: **a record is complete when its terminating newline is
 * present.** So the leading fragment of a window that starts mid-file is
 * dropped (its line began before the window), and so is a trailing fragment
 * with no newline (the writer was killed mid-write). Cutting only at newlines
 * is also what makes decoding safe: `0x0A` cannot occur inside a UTF-8
 * sequence, so no window boundary can split a character.
 */
export async function foldRunLog(path: string, options: FoldOptions = {}): Promise<FoldResult> {
  const window = Math.max(1, Math.floor(options.windowBytes ?? DEFAULT_WINDOW))
  const live = new Set(options.liveRunIds ?? [])
  const warnings: string[] = []

  let fh
  try {
    fh = await open(path, "r")
  } catch (e) {
    return { run: null, warnings: [`${path} could not be read: ${describe(e)}`] }
  }
  try {
    const { size } = await fh.stat()
    if (size === 0) {
      return {
        run: null,
        warnings: [`${path} is empty, so it carries no header and nothing in it can be read`],
      }
    }

    // A log smaller than one window is read once, whole. A real one is
    // bigger - a single captured phase stream is ~90 KiB against a 64 KiB
    // window - and from the front of those all that is wanted is line one, so
    // they get a probe instead of a windowful.
    const head = await readHead(fh, size, size <= window ? size : Math.min(size, HEAD_PROBE))
    // Line one itself, not the first line that happens to parse: a header on
    // line two is not a log that starts with a header, and reading it as one
    // would attribute a run to a task on the strength of a line something else
    // wrote.
    const first = head.lineOne === null ? null : parseRecord(head.lineOne)
    if (!first || first.kind !== "header") {
      return {
        run: null,
        warnings: [
          `${path} does not start with a header record${head.lineOne === null ? " (its first line has no terminator)" : ""}, so nothing in it can be interpreted; skipping it`,
        ],
      }
    }
    const identity = identify(first)
    if ("missing" in identity) {
      return {
        run: null,
        warnings: [
          `${path}'s header is missing ${identity.missing.join(", ")}, so the run cannot be attributed to a task; skipping it`,
        ],
      }
    }
    if (Number.isNaN(Date.parse(identity.header.startedAt))) {
      warnings.push(
        `${path}'s header has an unreadable startedAt (${JSON.stringify(identity.header.startedAt)}); it sorts oldest, so a newer run wins over it`,
      )
    }

    // The whole file already, which is the common case: most logs are small.
    const folded =
      head.bytesRead >= size
        ? fold(head.records, live.has(identity.header.runId))
        : await foldTail(fh, size, window, live.has(identity.header.runId))

    warnings.push(...folded.warnings.map((w) => `${path}: ${w}`))
    return {
      run: { header: identity.header, state: folded.state, costUsd: folded.costUsd, path },
      warnings,
    }
  } catch (e) {
    return { run: null, warnings: [`${path} could not be read: ${describe(e)}`] }
  } finally {
    // A failing close after a successful read must not turn a row of the tree
    // into an exception; the bytes are already in hand.
    await fh.close().catch(() => {})
  }
}

/**
 * Line one, and whatever else the first read happened to cover.
 *
 * `lineOne` is returned as text rather than as a record, and the read grows
 * only while **no newline has been seen at all**: those two together are what
 * make "the header is line one" checkable. Growing until something *parses*
 * would let a blank or unparseable first line slide, and then a header on line
 * two would pass for a log that starts with one.
 */
async function readHead(
  fh: Awaited<ReturnType<typeof open>>,
  size: number,
  probe: number,
): Promise<{ lineOne: string | null; records: RunRecord[]; bytesRead: number }> {
  let want = Math.min(size, probe)
  for (;;) {
    const bytes = await readAt(fh, 0, want)
    const nl = bytes.indexOf(NEWLINE)
    if (nl !== -1) {
      return {
        lineOne: bytes.toString("utf8", 0, nl),
        records: frame(bytes, true).records,
        bytesRead: want,
      }
    }
    // No terminator yet, so line one is not a record yet. Capped, so a log
    // that is one enormous unterminated line is reported rather than slurped.
    if (want >= size || want >= MAX_CHUNK) return { lineOne: null, records: [], bytesRead: want }
    want = Math.min(size, Math.min(MAX_CHUNK, want * 2))
  }
}

/**
 * The tail, walked **backwards in chunks until a lifecycle record turns up**,
 * each byte read exactly once.
 *
 * Re-reading a bigger window from the tail each time was the obvious shape and
 * it was measurably the wrong one: on 500 logs of 1.4 MiB with no `end`
 * record, doubling 64 KiB up to the file size read 235% of the bytes on disk
 * and took 3.9 s, against 2.6 s for simply parsing everything. Walking back
 * reads 100% at worst - and stops early whenever the last `phase` record is
 * nearer the tail than the start.
 *
 * The chunk that spans a boundary is the thing to get right: the fragment
 * before a chunk's first newline belongs to a line that starts earlier, so it
 * is carried over and prepended to the next read, newline included. Dropping
 * it at both ends - which is what framing each chunk independently does - would
 * lose exactly one record per boundary, and the `phase` record this is looking
 * for is as likely to be that one as any other.
 */
async function foldTail(
  fh: Awaited<ReturnType<typeof open>>,
  size: number,
  window: number,
  isLive: boolean,
): Promise<Folded> {
  let at = size
  let want = window
  let carry = EMPTY
  let acc = EMPTY_SCAN
  for (;;) {
    const from = Math.max(0, at - want)
    const chunk = await readAt(fh, from, at - from)
    const bytes = carry.length === 0 ? chunk : Buffer.concat([chunk, carry])
    const framed = frame(bytes, from === 0)
    carry = framed.carry
    // `acc` holds the records after this chunk, so the chunk goes in front of
    // it: this is the file's order, and both "the last phase record" and "the
    // first end record" depend on it.
    acc = combine(scan(framed.records), acc)
    if (acc.sawLifecycle || from === 0) return finish(acc, isLive)
    at = from
    // Doubling, so a log whose last phase record is a long way back costs a
    // handful of reads rather than one per window; capped so one enormous log
    // cannot ask for an enormous single allocation.
    want = Math.min(want * 2, MAX_CHUNK)
  }
}

async function readAt(
  fh: Awaited<ReturnType<typeof open>>,
  at: number,
  length: number,
): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(length)
  const { bytesRead } = await fh.read(buf, 0, length, at)
  return buf.subarray(0, bytesRead)
}

/**
 * The complete records in one chunk, and the fragment that is not one yet.
 *
 * The rule is `replay()`'s: **a record is complete when its terminating
 * newline is present**, and nothing else makes one. What a chunk's edges mean
 * depends on where the chunk sits, which is the whole of `atStartOfFile`:
 *
 * | Chunk edge | What it is | What happens |
 * |---|---|---|
 * | bytes before the first newline, `atStartOfFile` | line one | a record |
 * | bytes before the first newline, mid-file | the tail of a line that began earlier | returned as `carry`, for the read that reaches its start |
 * | bytes after the last newline, at EOF | a write the writer did not finish | dropped; parsing it yields nothing, or worse, something |
 * | bytes after the last newline, mid-file | nothing: `carry` ends on a newline | - |
 *
 * `carry` keeps its newline so the next chunk frames it without a special
 * case. Cutting only at newlines is also what makes decoding safe: `0x0A`
 * cannot occur inside a UTF-8 sequence, so no chunk boundary can split a
 * character.
 */
function frame(bytes: Buffer, atStartOfFile: boolean): { records: RunRecord[]; carry: Buffer } {
  const last = bytes.lastIndexOf(NEWLINE)
  if (atStartOfFile) {
    return { records: last === -1 ? [] : linesIn(bytes, 0, last), carry: EMPTY }
  }
  const nl = bytes.indexOf(NEWLINE)
  // The chunk landed inside one line; all of it belongs to the next read.
  if (nl === -1) return { records: [], carry: bytes }
  return {
    records: last > nl ? linesIn(bytes, nl + 1, last) : [],
    carry: bytes.subarray(0, nl + 1),
  }
}

/** The records in `bytes` between `from` and the final newline at `to`. */
function linesIn(bytes: Buffer, from: number, to: number): RunRecord[] {
  const records: RunRecord[] = []
  for (const line of bytes.toString("utf8", from, to).split("\n")) {
    const record = parseRecord(line)
    if (record) records.push(record)
  }
  return records
}

/** One complete line, or `null` when those bytes are not a record: a blank
 * line, a fragment a later append closed off, or JSON that is not an object.
 * The kind is deliberately not checked - that is the fold's business. */
function parseRecord(line: string): RunRecord | null {
  if (line.trim() === "") return null
  let value: unknown
  try {
    value = JSON.parse(line) as unknown
  } catch {
    return null
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null
  return value as RunRecord
}

interface Folded {
  state: RunState
  costUsd: number
  warnings: readonly string[]
  /** Whether an `end` record was seen, or a `phase` record this version
   * accepted. False means these records say nothing about where the run is
   * that this build can act on, and reading more is the only fix. `foldTail`
   * branches on it, so it is a contract rather than a note. */
  sawLifecycle: boolean
}

/** Where a run was, as one `phase` record says it. */
interface Phase {
  phase: RunPhase
  /** `null` when the record said `running`. */
  waiting: WaitReason | null
}

/**
 * What a run of records says, in a form two runs of records can be joined in.
 * The tail is read in chunks, so the fold has to compose rather than run once
 * over everything.
 */
interface Scan {
  /** The **last** `phase` record this version accepted. */
  phase: Phase | null
  /** The **first** `end` record, with whatever cost it carried. */
  end: { state: RunState; costUsd: number | null } | null
  /**
   * A human stopped the run, and no `phase` record has been written since.
   *
   * Cleared by a later accepted `phase` record, which is how a stop followed by
   * a resume reads as running again rather than as permanently stopped.
   *
   * Deliberately **not** a lifecycle record for `sawLifecycle`'s purposes: the
   * tail reader stops walking at the first chunk carrying one, and a stop
   * arrives *after* the phase record that says where a resume would pick up.
   * Counting it would stop the walk one chunk short, with `phase: null`, and
   * `finish` would then answer `resumeFrom: "plan"` - restarting a run from
   * the beginning because the log mentioned that someone stopped it.
   */
  stopped: boolean
  /** The largest `total_cost_usd` any `cli` record here showed. */
  costFloor: number
  warnings: readonly string[]
  sawLifecycle: boolean
}

const EMPTY_SCAN: Scan = {
  phase: null,
  end: null,
  stopped: false,
  costFloor: 0,
  warnings: [],
  sawLifecycle: false,
}

/** One run of records, in file order. */
function scan(records: readonly RunRecord[]): Scan {
  const warnings: string[] = []
  let phase: Phase | null = null
  let end: Scan["end"] = null
  let stopped = false
  let costFloor = 0
  let sawLifecycle = false

  for (const record of records) {
    switch (record.kind) {
      case "phase": {
        const read = readPhase(record, warnings)
        // Only a record this version can act on counts as a lifecycle record.
        // A rejected one must leave the tail reader walking, or a chunk ending
        // on `phase: "review"` would fold differently from a whole-file read
        // of the same log.
        if (read) {
          phase = read
          sawLifecycle = true
          // A phase record after a stop is a resume: the run is moving again,
          // so the stop is history rather than the current state.
          stopped = false
        }
        break
      }
      case "end": {
        sawLifecycle = true
        // The first `end` wins: the run ended there, and `replay()` does not
        // stop at it, so anything after it is a writer bug rather than news.
        if (end) break
        const cost = (record as { costUsd?: unknown }).costUsd
        const known = typeof cost === "number" && Number.isFinite(cost)
        if (!known) {
          warnings.push(
            `the end record's costUsd is ${JSON.stringify(cost)}, not a number; falling back to what the result events show`,
          )
        }
        end = { state: readEnd(record, warnings), costUsd: known ? (cost as number) : null }
        break
      }
      case "cli": {
        const cost = resultCost(record.event)
        if (cost !== null && cost > costFloor) costFloor = cost
        break
      }
      case "human": {
        // Only the stop. `approve`, `feedback` and `raise` are all followed by
        // a phase record saying what happened next, so the phase is the state
        // and reading the action would add nothing. A stop is followed by
        // nothing at all, which is precisely why it has to be read here.
        if (record.action === "stop") stopped = true
        break
      }
      // `header` carries identity, read from line one. `test` moves nothing.
      // An unknown kind belongs to a newer writer.
      default:
        break
    }
  }
  return { phase, end, stopped, costFloor, warnings, sawLifecycle }
}

/**
 * Two scans joined, `earlier` being the one nearer the start of the file.
 *
 * The asymmetry is the point: the **last** phase record in the file is the
 * run's position, so a later chunk's phase wins; the **first** `end` record is
 * where the run ended, so an earlier chunk's end wins. Reading the tail
 * backwards means they arrive in the opposite order to both.
 *
 * Both halves are defence in depth today, because `foldTail` stops at the
 * first chunk carrying a lifecycle record, so only one side of any join is
 * ever non-null. Mutating the phase precedence alone leaves the suite green;
 * mutating it with the early stop removed turns it red, which is what says the
 * rule is right rather than merely unused.
 *
 * The one limit worth stating: the `end` precedence cannot be observed at all,
 * because reaching it needs a log with **two** `end` records. The phase
 * machine writes one and closes the file, so for every log this project
 * produces a windowed read and a whole-file read fold identically. A log
 * carrying two - which `append` permits and nothing writes - can fold to the
 * later one under a small window and the earlier one when read whole.
 */
function combine(earlier: Scan, later: Scan): Scan {
  return {
    phase: later.phase ?? earlier.phase,
    end: earlier.end ?? later.end,
    /* The later chunk is nearer the end of the file. If it holds a phase
       record, that record is the run's position and only a stop *after* it
       counts - which within one chunk the scan has already resolved. If it
       holds none, a stop in either chunk is still the latest word. */
    stopped: later.phase !== null ? later.stopped : later.stopped || earlier.stopped,
    costFloor: Math.max(earlier.costFloor, later.costFloor),
    warnings:
      earlier.warnings.length === 0
        ? later.warnings
        : later.warnings.length === 0
          ? earlier.warnings
          : [...earlier.warnings, ...later.warnings],
    sawLifecycle: earlier.sawLifecycle || later.sawLifecycle,
  }
}

/** A scan as the state it means. */
function finish(found: Scan, isLive: boolean): Folded {
  const { warnings, sawLifecycle } = found
  const costUsd = found.end?.costUsd ?? found.costFloor
  if (found.end) return { state: found.end.state, costUsd, warnings, sawLifecycle }
  /* Before the park check, and that order is a decision. A run can be stopped
     while parked at a gate, and then the log says both "waiting for a human"
     and "a human stopped it". The stop is the later fact and the actionable
     one: nothing is driving the run, so offering the gate would ask someone to
     approve a plan that no process is waiting to receive. Resuming re-parks
     it, and the gate comes back. */
  if (found.stopped && found.phase) {
    return { state: { kind: "interrupted", resumeFrom: found.phase.phase }, costUsd, warnings, sawLifecycle }
  }
  if (!found.phase) {
    return {
      state: { kind: "interrupted", resumeFrom: FIRST_PHASE },
      costUsd,
      warnings,
      sawLifecycle,
    }
  }
  if (found.phase.waiting) {
    // A wait is durable: the server wrote "parked on a human" and then has
    // nothing more to write until one acts, so a dead server and a live one
    // leave the same bytes and the state is the same either way.
    return {
      state: { kind: "waiting", reason: found.phase.waiting },
      costUsd,
      warnings,
      sawLifecycle,
    }
  }
  return {
    state: isLive
      ? { kind: "running", phase: found.phase.phase }
      : { kind: "interrupted", resumeFrom: found.phase.phase },
    costUsd,
    warnings,
    sawLifecycle,
  }
}

/** The fold of a complete run of records: a log small enough to read whole. */
function fold(records: readonly RunRecord[], isLive: boolean): Folded {
  return finish(scan(records), isLive)
}

/**
 * A `phase` record, or `null` when this version cannot act on it.
 *
 * The dimensions are `phase` and `state`, and both are open: a newer writer
 * can name a phase or a state this build has no code for. Such a record is
 * ignored rather than passed through, so the fold falls back to the last phase
 * it does know - stale but actionable, where `resumeFrom: "review"` would send
 * Task 13 to spawn a phase that does not exist here.
 *
 * `waiting` with no reason, or one this version does not know, is the third
 * case. It still folds to `waiting`, with `question` as the reason: something
 * is parked on a human either way, and `question` only says "it needs you",
 * where guessing `gate` would render an Approve button and feed gate feedback
 * into a conversation that is not at a gate.
 */
function readPhase(
  record: RunRecord & { kind: "phase" },
  warnings: string[],
): { phase: RunPhase; waiting: WaitReason | null } | null {
  const named = record.phase as unknown
  if (typeof named !== "string" || !PHASES.includes(named as RunPhase)) {
    warnings.push(
      `a phase record names ${JSON.stringify(named)}, which this version has no phase for; ignoring it and keeping the last phase it knows`,
    )
    return null
  }
  const phase = named as RunPhase
  const state = record.state as unknown
  if (state === "running") return { phase, waiting: null }
  if (state !== "waiting") {
    warnings.push(
      `a phase record is in state ${JSON.stringify(state)}, which is neither running nor waiting; ignoring it`,
    )
    return null
  }
  const reason = record.reason as unknown
  if (typeof reason === "string" && WAIT_REASONS.includes(reason as WaitReason)) {
    return { phase, waiting: reason as WaitReason }
  }
  warnings.push(
    `a waiting phase record gives the reason as ${JSON.stringify(reason)}; reading it as "question", since a wait needs a human whatever it is called`,
  )
  return { phase, waiting: "question" }
}

/**
 * An `end` record's terminal state.
 *
 * A state this version does not know still **ended** the run, so it folds to
 * `failed` naming it, never to `interrupted`: offering a resume would claim the
 * server died when the writer said the run finished.
 */
/**
 * The `verifiedBy` label on a `done` record, or `undefined` for "the log did
 * not say" - which includes a label this version has no word for.
 *
 * An open dimension, like `phase` and `state` above, and read the same way: a
 * newer writer can invent a kind of verification, and the two wrong answers are
 * not symmetric. Passing an unrecognised label through would have the UI draw
 * nothing for it, which is indistinguishable from a run that passed its tests;
 * reading it as `test-command` would be that same lie stated outright. So it is
 * stripped and said out loud in the warnings.
 */
function readVerification(value: unknown, warnings: string[]): Verification | undefined {
  if (value === undefined) return undefined
  if (value === "test-command" || value === "self-check") return value
  warnings.push(
    `an end record says it was verified by ${JSON.stringify(value)}, which this version has no reading for; treating how it was verified as unknown rather than guessing, since a run that cannot say how it was checked must not read as one that passed its tests`,
  )
  return undefined
}

function readEnd(record: RunRecord & { kind: "end" }, warnings: string[]): RunState {
  const state = record.state as unknown
  if (state === "done") {
    // Spread rather than always present: the state mirrors what the log said,
    // so a log that recorded nothing yields a state with nothing, and
    // `verificationOf` is the single place that turns that into `unknown`.
    const verifiedBy = readVerification(record.verifiedBy, warnings)
    return { kind: "done", merged: false, ...(verifiedBy === undefined ? {} : { verifiedBy }) }
  }
  const why = record.why
  if (state === "failed") {
    return {
      kind: "failed",
      why:
        typeof why === "string" && why.trim() !== ""
          ? why
          : "the run failed and its log records no reason",
    }
  }
  warnings.push(
    `the end record's state is ${JSON.stringify(state)}, which this version does not know; reading it as failed, since the writer says the run ended`,
  )
  return {
    kind: "failed",
    why: `the run ended with state ${JSON.stringify(state)}, which this version does not know`,
  }
}

/** A result event's cumulative cost, if this payload carries one. Nothing else
 * in it is read: `modelUsage[*].costUSD` is per model and HANDOFF says not to
 * do cost arithmetic on it. */
function resultCost(event: unknown): number | null {
  if (event === null || typeof event !== "object") return null
  const value = (event as { total_cost_usd?: unknown }).total_cost_usd
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}

/** The header fields a task is addressed by, or which of them are missing. */
function identify(
  record: RunRecord & { kind: "header" },
): { header: RunHeader } | { missing: string[] } {
  const missing = (["runId", "taskRef", "projectPath", "featureFile", "startedAt"] as const).filter(
    (field) => {
      const value = (record as unknown as Record<string, unknown>)[field]
      return typeof value !== "string" || value === ""
    },
  )
  return missing.length > 0 ? { missing } : { header: record }
}

// --- The index over a runs directory ----------------------------------------

/**
 * Every task the run logs know about, newest run per task.
 *
 * Nothing here throws on bad input, including a `branchFor` that throws: a
 * missing directory is the first-ever state, an unreadable log is one row of
 * the tree rather than all of it, and a task whose branch name cannot be
 * computed is a row without a branch. All three arrive as warnings.
 *
 * Keeping the row is the point rather than tidiness. A task dropped from the
 * index looks like a task that was never run, and Task 12's guard consults
 * exactly this index before starting one - so dropping a `done`
 * but unmerged task is how a second run gets started against work that is
 * already written and not yet integrated.
 */
export async function indexRuns(options: IndexOptions): Promise<RunIndex> {
  const dir = options.runsDir ?? defaultRunsDir()
  const registered = options.projects ? new Set(options.projects) : null
  // Materialised once, because `Iterable` admits a one-shot iterator: a server
  // passing `liveRuns.keys()` would otherwise spend it on the first log and
  // leave every later live run reading as interrupted.
  const perLog: FoldOptions = {
    ...options,
    liveRunIds: options.liveRunIds ? new Set(options.liveRunIds) : undefined,
  }
  const warnings: string[] = []

  let names: string[]
  try {
    // A log is a `.jsonl` file. The dirent type is checked as well as the name,
    // because a directory called `x.jsonl` opens for reading and only fails on
    // the read, which would show up as a warning about a log that does not
    // exist; and because a fifo with that name would block the whole tree on a
    // read that never returns. A symlink is followed: it resolves to a log or
    // the open fails, and refusing it would hide a log someone moved.
    names = (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.name.endsWith(".jsonl") && (d.isFile() || d.isSymbolicLink()))
      .map((d) => d.name)
      .sort()
  } catch (e) {
    if (isErrno(e, "ENOENT")) return { tasks: new Map(), warnings }
    throw e
  }

  // Newest-first per task, so the first usable run for a key is the winner.
  const runs: RunSummary[] = []
  for (const name of names) {
    const { run, warnings: said } = await foldRunLog(join(dir, name), perLog)
    warnings.push(...said)
    if (!run) continue
    if (registered && !registered.has(run.header.projectPath)) {
      warnings.push(
        `${join(dir, name)} belongs to ${run.header.projectPath}, which is no longer in projects.json; skipping it`,
      )
      continue
    }
    runs.push(run)
  }

  const byTask = new Map<string, RunSummary[]>()
  for (const run of runs) {
    const key = taskKey(run.header)
    const seen = byTask.get(key)
    if (seen) seen.push(run)
    else byTask.set(key, [run])
  }

  const tasks = new Map<string, TaskStatus>()
  for (const key of [...byTask.keys()].sort()) {
    const attempts = byTask.get(key) ?? []
    // Newest wins; the ones before it still happened and still count. The
    // runId breaks a tie, so two runs started in the same millisecond do not
    // leave the tree depending on directory order.
    const newest = attempts.reduce((a, b) => (startedAfter(b, a) ? b : a))
    // `taskBranchName` throws on a whitespace-only ref and on an absolute
    // feature path, and a header can carry either. The row survives it: losing
    // it would make a done-but-unmerged task look never-run, and Task 12 would
    // let a second run start against it.
    let branch = ""
    try {
      branch = options.branchFor({
        feature: newest.header.featureFile,
        ref: newest.header.taskRef,
      })
    } catch (e) {
      warnings.push(
        `${newest.header.taskRef} in ${newest.header.featureFile} has no usable branch name, so it is listed without one and cannot be checked for a merge: ${describe(e)}`,
      )
    }
    let state = newest.state
    // No branch means nothing to ask git about.
    if (branch !== "" && state.kind === "done" && options.isMerged) {
      try {
        state = {
          // Spread, **not** a rebuild from `{kind, merged}`. This is the layer
          // the tree actually consumes, so a literal here would drop
          // `verifiedBy` after the fold had carefully read it - and a
          // self-checked run would arrive at the UI indistinguishable from one
          // whose suite passed, which is the single thing this field exists to
          // prevent. It is also the direction that fails silently: the state is
          // still well-formed and still says `done`.
          ...state,
          merged: await options.isMerged({
            projectPath: newest.header.projectPath,
            featureFile: newest.header.featureFile,
            taskRef: newest.header.taskRef,
            runId: newest.header.runId,
            branch,
          }),
        }
      } catch (e) {
        // A branch deleted after a done run makes git.ts's check throw. Leaving
        // it unmerged keeps Task 12 refusing, which is the recoverable
        // direction.
        warnings.push(
          `could not tell whether ${branch} is merged, so ${newest.header.taskRef} stays unmerged: ${describe(e)}`,
        )
      }
    }
    tasks.set(key, {
      taskRef: newest.header.taskRef,
      projectPath: newest.header.projectPath,
      featureFile: newest.header.featureFile,
      state,
      runId: newest.header.runId,
      branch,
      costUsd: newest.costUsd,
      attempts: attempts.length,
    })
  }

  return { tasks, warnings }
}

/** Later than `b`, with the run id as the tiebreak. An unreadable `startedAt`
 * is `NaN`, which loses every comparison, so it sorts oldest. */
function startedAfter(a: RunSummary, b: RunSummary): boolean {
  const at = Date.parse(a.header.startedAt)
  const bt = Date.parse(b.header.startedAt)
  if (Number.isNaN(at)) return false
  if (Number.isNaN(bt)) return true
  if (at !== bt) return at > bt
  return a.header.runId > b.header.runId
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function isErrno(e: unknown, code: string): boolean {
  return e instanceof Error && (e as NodeJS.ErrnoException).code === code
}
