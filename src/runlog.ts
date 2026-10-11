import { mkdir, open, stat } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Effort } from "./projects"

/**
 * One append-only JSONL file per run, at `~/.orch/runs/<runId>.jsonl`.
 *
 * It is the live feed, the permanent history, and the only source of run state
 * (design §2). There is no database: a run's state is the fold of its log,
 * which is what makes crash recovery and the task tree the same problem.
 *
 * Two properties the rest of the tool depends on:
 *
 * - **A `cli` record nests its event byte-identically.** `appendCli` takes the
 *   raw stdout line and splices it in, rather than parsing and re-serialising
 *   it, because the payloads are the replay source for a future parser.
 *   Normalising on write - even just dropping the spaces the CLI puts after
 *   its colons - would make today's logs read differently to new code.
 *   Filtering and shaping are display concerns.
 * - **`replay()` is framing, not interpretation.** It decides which bytes form
 *   a complete record and yields whatever they parse to. It does not validate
 *   kinds, does not stop at `end`, and does not fold. A log written by a newer
 *   version therefore stays readable.
 */

// --- The record format ------------------------------------------------------

/**
 * Written once, first, and never rewritten. Everything needed to interpret the
 * rest of the file and to resume after a crash.
 *
 * There is deliberately no `implementSessionId` here. It is minted when the
 * gate is approved, which is long after this line is on disk, and the log is
 * append-only: rewriting line one would shift every byte offset a tailing
 * reader has already passed, and a field written as a permanent `null` would
 * send every reader to the `phase` record anyway. So the implement session id
 * lives on the `phase` record that starts the implement phase, and that is its
 * only home. HANDOFF's "a run has TWO session ids and using the wrong one
 * fails silently" is the reason it is recorded rather than reconstructed.
 */
export interface RunHeader {
  /** The stream-json envelope shape depends on it. */
  claudeVersion: string
  runId: string
  /** Gate feedback resumes this conversation. */
  planSessionId: string
  /** The `configDir` that paid for this run; `null` is the default profile.
   * Written explicitly, because an absent field cannot be told apart from an
   * older writer that did not record one. */
  profile: string | null
  planModel: string
  implementModel: string
  /** The starting efforts. Effort changes during a run, and the escalation
   * shows up in the stream rather than being patched in here. */
  planEffort: Effort
  implementEffort: Effort
  /**
   * The project, spelled **as `projects.json` spells it** - never git's
   * resolved `Repo.root`.
   *
   * `requireUsableRepo` resolves symlinks and `projects.json` stores what the
   * user typed. Write the resolved root and every log for a symlinked project
   * is skipped as belonging to no registered project, so the project silently
   * vanishes from the task tree.
   */
  projectPath: string
  /** Repo-relative, or `taskBranchName` throws and the task's row has no
   * branch at all. */
  featureFile: string
  /** Non-blank, for the same reason. `src/runindex.ts` keys a task on
   * **(`projectPath`, `featureFile`, `taskRef`)**, because every feature file
   * in a repo has a `T1` and keying on the ref alone merges two tasks and
   * hides the older one. */
  taskRef: string
  /**
   * A hash of the feature file's bytes as the run parsed them.
   *
   * Design §5 promises a warning when a human edits the feature file mid-run,
   * and `featurefile.ts`'s `tickTaskInFile` can only raise it by comparing
   * against the bytes the `readFeature` it was handed returned. A resumed run
   * re-reads the file immediately before writing, so it holds nothing older to
   * compare against and the warning can never fire - which is exactly the
   * server-restart case. This field is what survives the restart, and it is on
   * line one so reading it costs one line rather than the whole log.
   *
   * Required, not optional, for the same reason as `profile`: an absent field
   * cannot be told apart from a writer that did not record one, and a reader
   * that cannot tell would have to treat "no hash" as "unchanged".
   */
  featureFileHash: string
  /**
   * The branch the run recorded as its base, so `returnToBase` works after a
   * restart.
   *
   * Without it a resumed run has nothing to return to on `done`: the branch can
   * be recomputed from `featureFile` and `taskRef`, but the base cannot be
   * recomputed from anything. Re-deriving it with `recordBaseBranch` is both
   * refused - HEAD is on the task's own `orch/` branch by then - and the
   * branch-stacking bug the base discipline exists to prevent.
   *
   * Optional, unlike `profile` and `featureFileHash`, because it is younger
   * than the logs already on disk and the absence policy from
   * docs/HANDOFF.md applies: a field that did not exist when a log was written
   * cannot have been recorded, so there is nothing to lose by defaulting. The
   * default is the restrictive direction - a resumed run with no recorded base
   * finishes on its task branch and says so, rather than guessing at a base and
   * moving the user's checkout.
   */
  baseBranch?: string
  /** The ceiling this run was given. */
  budgetUsd: number
  /** Absolute, ISO 8601. */
  startedAt: string
}

export interface HeaderRecord extends RunHeader {
  kind: "header"
}

/** One untouched stream-json event. `event` is whatever the CLI wrote, so it
 * is `unknown` here: giving it a shape is Task 6's job, not the log's. */
export interface CliRecord {
  kind: "cli"
  event: unknown
}

export type RunPhase = "plan" | "gate" | "implement" | "test" | "refine"
export type WaitReason = "gate" | "question" | "blocked" | "stalled"

/** A transition, design §2: `plan -> waiting(gate)`, `implement -> running`. */
export interface PhaseRecord {
  kind: "phase"
  phase: RunPhase
  state: "running" | "waiting"
  /** Which kind of wait, when `state` is `waiting`. */
  reason?: WaitReason
  /** On the plan phase's record: the file the gate renders, so the gate shows
   * the path the prompt dictated instead of re-deriving it by convention. */
  planPath?: string
  /**
   * The session this phase runs in, present **exactly when this phase record
   * spawned a process**.
   *
   * Recorded rather than reconstructed because resuming the wrong conversation
   * is silent: the implement prompt runs inside the planning session and still
   * exits `success`. `implementSessionId` has no other home - the header is
   * written before the gate mints it.
   *
   * The "exactly when it spawned" half is load-bearing too: a refine turn on
   * the live process carries no id, and that is what lets a reader split the
   * log into per-process windows to sum cost, which resets per process.
   */
  sessionId?: string
  /**
   * Why the run is waiting, in prose, on a `waiting` record.
   *
   * Nothing else in the log holds it. A `question` has the agent's own text in
   * the `cli` records before it, but a `blocked` the orchestrator itself
   * decided - an exhausted budget - and a `stalled` one have no agent text
   * behind them at all, so a reader that fell back to the last result would
   * render the previous turn's prose as the reason the run stopped.
   */
  detail?: string
}

export interface TestRecord {
  kind: "test"
  exitCode: number
  /** Absent when the run passed. */
  signature?: string
  /** 1 for the first run of the tests in this run. */
  attempt: number
}

/**
 * A decision the human made at a rest point.
 *
 * `raise` carries the run's **new ceiling in full**, not a delta, and it is
 * recorded here rather than being read back off the project record for three
 * reasons. The ceiling is a per-run fact: design §3.4 makes it configurable per
 * project *and* per run, so a run started with an override cannot have its
 * ceiling re-derived from `projects.json` without discarding it. Editing the
 * store would also raise every unfinished run of that project at once, which is
 * a different decision from "let this one finish". And the header cannot be
 * rewritten - the log is append-only, and changing line one would shift every
 * byte offset a tailing reader has already passed, which is the same reason
 * `implementSessionId` lives on a `phase` record.
 *
 * So a reader folds the ceiling as the header's figure plus every `raise` after
 * it, and the raise survives a server restart because the log does.
 */
export type HumanRecord =
  | { kind: "human"; action: "approve" }
  | { kind: "human"; action: "feedback"; text: string }
  | { kind: "human"; action: "raise"; budgetUsd: number }

export interface EndRecord {
  kind: "end"
  state: "done" | "failed"
  /** Why it failed. */
  why?: string
  /**
   * Things a human should see that are not the state: a feature file edited
   * mid-run, a task that was already ticked, a checkout that could not return
   * to base.
   *
   * Separate from `why`, which is about a failure: a run can be `done` and
   * still have something worth saying, and the log is the only place such a
   * note survives the server that produced it.
   */
  warnings?: string[]
  /** The run's total, summed by the caller: cost resets per process, so this
   * is the sum of the last result of each process, not of every result. */
  costUsd: number
}

/** What the orchestrator writes itself. `header` is written by `createRunLog`
 * and `cli` by `appendCli`, so neither is appendable through `append`. */
export type OwnRecord = PhaseRecord | TestRecord | HumanRecord | EndRecord

export type RunRecord = HeaderRecord | CliRecord | OwnRecord

// --- Where logs live --------------------------------------------------------

/** `~/.orch/runs`. Delete `~/.orch` and you lose history, nothing else. */
export function defaultRunsDir(): string {
  return join(homedir(), ".orch", "runs")
}

/**
 * The log file for `runId`.
 *
 * The run id is refused rather than sanitised when it could name anything but
 * a file directly inside `dir`. A run id reaches this function from a URL as
 * well as from `randomUUID`, and the cost of the two directions is not close:
 * refusing a legitimate id is a visible error on a path nothing generates,
 * while accepting `../../.ssh/authorized_keys` writes an append-only JSONL
 * file wherever it points.
 */
export function runLogPath(runId: string, dir: string = defaultRunsDir()): string {
  if (runId === "" || runId === "." || runId === ".." || /[/\\\0]/.test(runId)) {
    throw new Error(
      `${JSON.stringify(runId)} is not a usable run id: it names a file inside ${dir}, so it cannot be empty, "." or "..", or contain a path separator`,
    )
  }
  return join(dir, `${runId}.jsonl`)
}

// --- Writing ----------------------------------------------------------------

export interface RunLog {
  readonly path: string
  /** Appends one of the orchestrator's own records. */
  append(record: OwnRecord): Promise<void>
  /** Appends one raw stream-json line, nested under `event` byte for byte.
   * `raw` must be the line without its terminator. */
  appendCli(raw: string): Promise<void>
  close(): Promise<void>
}

/**
 * Starts a log at `path` and writes its header as line one.
 *
 * Creates `~/.orch/runs` if this is the first run ever, and refuses a path
 * that already exists: a repeated run id would interleave two runs into one
 * file whose fold belongs to neither.
 *
 * Taking the header as an argument is what makes "the header is first, exactly
 * once" structural rather than a check. There is no other way to start a log,
 * and `append` refuses a header unconditionally.
 */
export async function createRunLog(path: string, header: RunHeader): Promise<RunLog> {
  await mkdir(dirname(path), { recursive: true })
  let fh: FileHandle
  try {
    // "ax" is O_APPEND|O_EXCL: the open fails rather than adopting a log that
    // another run already owns.
    fh = await open(path, "ax")
  } catch (e) {
    if (isErrno(e, "EEXIST")) {
      throw new Error(
        `${path} already exists; a run log is written once, and two runs sharing one file would interleave into a log that folds to neither run`,
        { cause: e },
      )
    }
    throw e
  }
  const log = new AppendOnlyRunLog(path, fh)
  await log.writeLine(JSON.stringify({ kind: "header", ...header }))
  return log
}

/**
 * Reopens an existing log to append to, which is what resuming an interrupted
 * run does.
 *
 * If the file does not end in a newline the writer before us was killed
 * mid-line, so a newline is written first. Appending straight on would splice
 * the next record into the truncated one and lose both; terminating the
 * fragment costs one orphan line that `replay()` skips.
 *
 * An empty file is refused: it carries no header, so nothing appended to it
 * could be interpreted.
 */
export async function openRunLog(path: string): Promise<RunLog> {
  // Before the open, so a missing log is reported as missing rather than
  // created empty by O_CREAT.
  await stat(path)
  const fh = await open(path, "a+")
  const log = new AppendOnlyRunLog(path, fh)
  const { size } = await fh.stat()
  if (size === 0) {
    await log.close()
    throw new Error(
      `${path} is empty, so it has no header and nothing appended to it could be interpreted; delete it to start the run over`,
    )
  }
  const last = Buffer.allocUnsafe(1)
  const { bytesRead } = await fh.read(last, 0, 1, size - 1)
  if (bytesRead === 1 && last[0] !== NEWLINE) await log.writeLine("")
  return log
}

const NEWLINE = 0x0a

class AppendOnlyRunLog implements RunLog {
  private fh: FileHandle | null
  private closed = false
  /** Appends run in the order they were made. Two unserialised writes could
   * interleave their bytes inside one line. */
  private queue: Promise<void> = Promise.resolve()

  constructor(
    readonly path: string,
    fh: FileHandle,
  ) {
    this.fh = fh
  }

  async append(record: OwnRecord): Promise<void> {
    if ((record as { kind: string }).kind === "header") {
      throw new Error(
        `${this.path}: a run log carries exactly one header, written when the log is created; a second one would change how every line after it reads`,
      )
    }
    return this.writeLine(JSON.stringify(record))
  }

  async appendCli(raw: string): Promise<void> {
    // Validated before it is written, because `replay()` skips a line it
    // cannot parse: without this, one malformed payload would disappear on
    // read instead of being reported on write.
    if (raw.includes("\n")) {
      throw new Error(
        `${this.path}: a cli payload cannot contain a newline, which would split one record across two lines; pass the stdout line without its terminator`,
      )
    }
    let event: unknown
    try {
      event = JSON.parse(raw) as unknown
    } catch (cause) {
      throw new Error(
        `${this.path}: a cli payload must be valid JSON: ${(cause as Error).message}`,
        { cause },
      )
    }
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      throw new Error(
        `${this.path}: a cli payload must be a JSON object, not ${Array.isArray(event) ? "an array" : String(event === null ? "null" : typeof event)}`,
      )
    }
    // Spliced, not re-serialised: these bytes are the replay source.
    return this.writeLine(`{"kind":"cli","event":${raw}}`)
  }

  /** Queues `line` plus its terminator as one write. */
  writeLine(line: string): Promise<void> {
    // Refused here rather than when the job runs, because `close` sets the
    // flag synchronously and then awaits the queue once. A write accepted
    // after that drain was computed would start against a handle `close` is
    // about to take away, and a short write would finish against a closed one.
    // The stdout pump appending its last lines while the phase machine closes
    // the log is exactly this.
    if (this.closed) return Promise.reject(new Error(`${this.path}: the run log is closed`))
    const bytes = new TextEncoder().encode(`${line}\n`)
    const run = this.queue.then(
      () => this.writeBytes(bytes),
      () => this.writeBytes(bytes),
    )
    this.queue = run.then(
      () => {},
      () => {},
    )
    return run
  }

  private async writeBytes(bytes: Uint8Array): Promise<void> {
    const fh = this.fh
    if (!fh) throw new Error(`${this.path}: the run log is closed`)
    // A single write can be short, and the rest of the line would then be
    // missing with nothing to show why.
    let at = 0
    while (at < bytes.length) {
      const { bytesWritten } = await fh.write(bytes, at, bytes.length - at)
      if (bytesWritten === 0) {
        throw new Error(`${this.path}: wrote 0 of ${bytes.length - at} remaining bytes`)
      }
      at += bytesWritten
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    // Queued appends finish before the handle goes, so a close cannot truncate
    // a record that was already accepted.
    await this.queue.then(
      () => {},
      () => {},
    )
    const fh = this.fh
    this.fh = null
    if (fh) await fh.close()
  }
}

// --- Reading ----------------------------------------------------------------

export interface ReplayOptions {
  /** Keep yielding records appended after the end of the file is reached.
   * Terminates on `signal`; it does not stop at the `end` record, because
   * deciding a record is terminal is interpretation, not framing. */
  follow?: boolean
  signal?: AbortSignal
  /** How often to look for appended bytes while following. */
  pollMs?: number
}

/**
 * Every record in the log from byte 0, then, with `follow`, the ones appended
 * after that. This is what makes closing the browser safe: the server owns the
 * child process, and a reconnecting client replays the whole log and then
 * follows live.
 *
 * Each call opens its own handle, so any number of readers see every line.
 *
 * **What the tail of a file can look like mid-write, and what happens to it.**
 * The dimension this reads is the bytes after the last newline, and the rule is
 * that a record is complete when its terminating newline is present - nothing
 * else. Dropping a record is silent and emitting a malformed one is loud, so
 * the guard is built to do neither:
 *
 * | Tail | What happens | Cost of the other choice |
 * |---|---|---|
 * | ends with a newline | every record is emitted | - |
 * | a complete JSON object, no newline yet | held; emitted when the newline arrives, discarded at EOF without `follow` | emitting it risks a second emission of the same record when the rest of the write lands |
 * | a partial JSON object | held, never parsed | parsing it yields nothing, or worse, something |
 * | a multi-byte character split across writes | impossible to observe: bytes are buffered raw and only whole lines are decoded, and `0x0A` cannot occur inside a UTF-8 sequence | decoding each read independently replaces the split character with U+FFFD permanently, so a path with Arabic or an emoji corrupts |
 * | a line that is not valid JSON | skipped | no record this writer produced is invalid JSON - `JSON.stringify` escapes newlines and `appendCli` validates - so such a line is a partial write that a later append has closed off, and throwing would make the rest of a readable log unreadable |
 * | a blank line | skipped; it carries no record | - |
 * | valid JSON that is not an object | skipped; no version's record is a number, string, array or null | - |
 * | an unknown `kind` | emitted unchanged | a newer writer's records would vanish |
 *
 * A log with no `end` record is normal input, not an error: that is the
 * crashed-server case, and Task 7b folds it to `interrupted`.
 */
export async function* replay(path: string, options: ReplayOptions = {}): AsyncGenerator<RunRecord> {
  const { follow = false, signal, pollMs = 50 } = options
  const fh = await open(path, "r")
  try {
    const chunk = Buffer.allocUnsafe(64 * 1024)
    // Raw bytes read but not yet terminated by a newline. Never decoded.
    let pending = Buffer.alloc(0)
    for (;;) {
      if (signal?.aborted) return
      // `null` reads from, and advances, the handle's own position, so a file
      // that grows between reads continues where the last read stopped.
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, null)
      if (bytesRead === 0) {
        if (!follow) return
        await sleep(pollMs, signal)
        continue
      }
      // Copied, because `chunk` is reused by the next read.
      const fresh = Buffer.from(chunk.subarray(0, bytesRead))
      pending = pending.length === 0 ? fresh : Buffer.concat([pending, fresh])
      let from = 0
      for (;;) {
        const at = pending.indexOf(NEWLINE, from)
        if (at === -1) break
        const record = parseLine(pending.toString("utf8", from, at))
        from = at + 1
        if (record) yield record
      }
      pending = from === 0 ? pending : pending.subarray(from)
    }
  } finally {
    await fh.close()
  }
}

/** One complete line, or `null` when those bytes are not a record. */
function parseLine(text: string): RunRecord | null {
  if (text.trim() === "") return null
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    return null
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null
  // Not validated further on purpose: the log is the replay source, so a kind
  // this version does not know has to pass through rather than be dropped.
  return value as RunRecord
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms))
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    // Both paths remove the listener: a follower that outlives many polls
    // would otherwise accumulate one per sleep.
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
  })
}

function isErrno(e: unknown, code: string): boolean {
  return e instanceof Error && (e as NodeJS.ErrnoException).code === code
}
