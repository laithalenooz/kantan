/**
 * The client's read of a run: one append-only log in, the four regions' props
 * out.
 *
 * Everything here is a pure function of the records. That is deliberate and it
 * is the whole design: `GET /api/runs/:id/stream` replays the log **from byte 0
 * on every connect** and carries no replay-versus-live marker, by design
 * (§4.4 rejects `Last-Event-ID` because a cursor is a reconnect state machine
 * to get wrong). So the client cannot accumulate view state across connections
 * — it has to be able to throw everything away, re-read the log and arrive at
 * the same answer, including the same row identities. A fold is the only shape
 * that gets that for free.
 */

import { classify, type Event } from "../stream.ts"
import type { RunHeader, RunPhase, RunRecord, WaitReason } from "../runlog.ts"
import type { DigestEntry } from "./Digest.tsx"
import type { PlanSource } from "./Gate.tsx"
import type { StreamRow } from "./Row.tsx"
import type { TreeProject } from "./Tree.tsx"
import type { CostProcess, PhaseStep } from "./Sidebar.tsx"

type ResultEvent = Extract<Event, { kind: "result" }>

/** Why a run is parked, and the prose only the log holds. */
export interface Waiting {
  reason: WaitReason
  /**
   * The `waiting` record's own `detail`.
   *
   * `null` when the record carried none. Not backfilled from the last result:
   * a `blocked` run the orchestrator itself parked and a `stalled` one have no
   * agent text behind them, so falling back would render the previous turn's
   * prose as the reason the run stopped.
   */
  detail: string | null
}

export interface Ended {
  state: "done" | "failed"
  why?: string
  /** Things worth saying that are not the state. A `done` run can have them. */
  warnings: string[]
  /** The writer's own total. */
  costUsd: number
}

export interface RunView {
  /** Line one. `null` for a log that has not got there yet. */
  header: RunHeader | null
  rows: StreamRow[]
  /** Only the phases this log actually shows; `phaseLadder` fills the rest. */
  phases: PhaseStep[]
  /**
   * The "while you were away" timeline, oldest first.
   *
   * Derived here rather than in the component because every entry mirrors a
   * record, and the ids have to be as stable as the stream's for the same
   * reason: the entrance is keyed on them and the SSE replays from byte 0.
   *
   * Sparse on purpose. `added`/`removed` line counts and the effort-escalation
   * entry are **not** emitted, because the log does not hold them - a diff is
   * not recorded and effort changes show up as prose in the stream rather than
   * as a record. Each is optional in `DigestEntry` precisely so a caller that
   * does not have them says nothing instead of inventing a number.
   */
  digest: DigestEntry[]
  /** One per spawned process, in order. Feed straight to `sumProcessCost`. */
  processes: CostProcess[]
  /** The newest usable raise, else the header's figure. `null` with no header. */
  ceilingUsd: number | null
  /** The file the gate renders, as the plan phase recorded it. */
  planPath: string | null
  /**
   * `runId#recordIndex` of the newest unresolved `waiting` record, or `null`.
   *
   * The record's index, not the row's: an action has to name the park it is
   * answering, and content alone cannot tell a re-asked question from a poll of
   * the same one.
   */
  waitId: string | null
  waiting: Waiting | null
  ended: Ended | null
  /** The newest rate-limit reading in this log, for this run's account. */
  limit: { status: string; utilization: number | undefined } | null
  /** Anything this reader could not fully account for. Never thrown. */
  warnings: string[]
  /** Record kinds this version does not know, in first-seen order. */
  unknownKinds: string[]
}

/**
 * Tools whose use means a file changed.
 *
 * Enumerated rather than pattern-matched: the digest prints "3 files", and a
 * rule like "any tool whose input has a file_path" would count a `Read` and
 * report work that never happened. Over-counting is the expensive direction
 * here, because the number is a claim about what the agent did while the user
 * was away.
 */
const WRITING_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])

/** A tool input's `file_path`, when it has a usable one. */
function pathOf(input: unknown): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null
  const path = (input as Record<string, unknown>)["file_path"]
  return typeof path === "string" && path !== "" ? path : null
}

/** The six kinds this version writes. Anything else is a newer writer's. */
const KNOWN_KINDS = new Set(["header", "cli", "phase", "test", "human", "end"])

/**
 * A row's id: the **record** index and the event's index within that record.
 *
 * Both halves are needed. `classify` turns one `cli` record into zero, one or
 * several events — an assistant message carrying text and two tool calls is
 * three rows — so the record index alone collides. And the record index cannot
 * be replaced by a running row counter: a filtered hook subtype yields no row,
 * so a counter would renumber every row after the first one of those and
 * re-animate the log on reconnect, collapsing every expanded row and throwing
 * away the virtualizer's measurement cache.
 */
const rowId = (runId: string, recordIndex: number, eventIndex: number): string =>
  `${runId}#${recordIndex}:${eventIndex}`

/** `runId#recordIndex`, which is what an action names. */
const waitIdFor = (runId: string, recordIndex: number): string => `${runId}#${recordIndex}`

export function foldRun(runId: string, records: readonly RunRecord[]): RunView {
  let header: RunHeader | null = null
  const rows: StreamRow[] = []
  /** Mutable while folding; handed out as `CostProcess[]` at the end. */
  const buckets: ResultEvent[][] = []
  const phases = new Map<RunPhase, PhaseStep>()
  const digest: DigestEntry[] = []
  /** Distinct paths the implement phase wrote, for the `implemented` entry. */
  const touched = new Set<string>()
  const warnings: string[] = []
  const unknownKinds: string[] = []

  let raised: number | null = null
  let planPath: string | null = null
  let waitId: string | null = null
  let waiting: Waiting | null = null
  let ended: Ended | null = null
  let limit: RunView["limit"] = null
  /** The phase whose record last said `running`, so a later record can close it. */
  let openPhase: RunPhase | null = null
  /**
   * The phase currently drawn as `waiting`, so the run moving on can resolve it.
   *
   * The human's decision cannot be the signal. A `human` record names no phase,
   * and an answer to a question is not a `human` record at all - `HumanRecord`
   * is only approve, feedback and raise - so a reader keying on the decision
   * would resolve nothing for a question and would have to guess which phase
   * approve referred to. The run reaching a different phase, or ending, says it
   * unambiguously.
   */
  let waitingPhase: RunPhase | null = null

  /** Appends to the process this record belongs to, opening one if none is. */
  const costOf = (event: ResultEvent): void => {
    // A result arriving before any phase record claimed a process still spent
    // money. Opening an implicit process keeps it in the total; dropping it
    // would under-report the one figure that gates spending, and a ceiling
    // compared against a number that is too small overspends silently.
    let current = buckets.at(-1)
    if (current === undefined) {
      current = []
      buckets.push(current)
      warnings.push("a result arrived before any phase record claimed a process; counted in an implicit one")
    }
    current.push(event)
  }

  records.forEach((record, i) => {
    if (!KNOWN_KINDS.has(record.kind)) {
      // Visible, not dropped. The SSE names every record `record` for exactly
      // this reason, so a kind a newer writer invented must reach the log the
      // reader is looking at rather than being swallowed here.
      if (!unknownKinds.includes(record.kind)) unknownKinds.push(record.kind)
      rows.push({ id: rowId(runId, i, 0), event: { kind: "unknown", raw: record } })
      return
    }

    switch (record.kind) {
      case "header": {
        if (header !== null) {
          // Two headers means two writers appended to one path, and the second
          // one's figures are not this run's. Keep the first and say so.
          warnings.push("a second header record appeared; the first one is being used")
          return
        }
        const { kind: _kind, ...rest } = record
        header = rest
        return
      }

      case "cli": {
        const events = classify(record.event)
        events.forEach((event, j) => {
          if (event.kind === "result") {
            costOf(event)
            // `errors` is not on `Event`: stream.ts deliberately does not
            // surface it, and on `error_max_budget_usd` the event carries no
            // `result` key at all, so this array is the failure's only prose.
            const errors = errorsOf(record.event)
            rows.push(errors === undefined ? { id: rowId(runId, i, j), event } : { id: rowId(runId, i, j), event, errors })
            return
          }
          if (event.kind === "rate_limit") limit = { status: event.status, utilization: event.utilization }
          if (event.kind === "tool_use" && WRITING_TOOLS.has(event.name)) {
            const path = pathOf(event.input)
            if (path !== null) touched.add(path)
          }
          rows.push({ id: rowId(runId, i, j), event })
        })
        return
      }

      case "phase": {
        // A phase record that spawned a process carries the session it spawned
        // into, and carries it *exactly* then. That is what makes it the
        // boundary to split per-process cost on: a refine turn runs on the live
        // process and records no id, so it must not open a new bucket.
        if (record.sessionId !== undefined) buckets.push([])
        if (record.planPath !== undefined) planPath = record.planPath

        if (openPhase === "implement" && record.phase !== "implement") {
          digest.push({
            id: `${runId}#${i}i`,
            kind: "implemented",
            ...(touched.size === 0 ? {} : { files: touched.size }),
          })
        }
        if (openPhase !== null && openPhase !== record.phase) close(phases, openPhase)
        // The run reached a different phase, so whatever it was parked at is
        // settled - the gate was approved, the question answered, the ceiling
        // raised. Without this the rail reads `gate:waiting` on a finished run,
        // which is what a real log showed.
        if (waitingPhase !== null && waitingPhase !== record.phase) close(phases, waitingPhase)

        if (record.state === "waiting") {
          const reason: WaitReason = record.reason ?? "gate"
          waitId = waitIdFor(runId, i)
          waiting = { reason, detail: record.detail ?? null }

          // `park` is called with the phase that **ran**, not the phase that
          // waits, and design §2 writes the gate as `plan -> waiting(gate)`:
          // `src/run.ts:864` appends `{phase:"plan", state:"waiting",
          // reason:"gate"}`. So the phase on the record is finished and the
          // gate is what the human owes an answer to - which is also what the
          // artboard draws.
          //
          // The dimension is `WaitReason`, whose four values are enumerated
          // against their call sites: `gate` (run.ts:864 from plan, run.ts:2407
          // from the resume path's own `gate`), `question` (864, 1545),
          // `blocked` (866, 1069, 1234) and `stalled` (1425). Only `gate` names
          // a phase in the ladder, so only `gate` moves the park off the
          // record's phase. Reading the other three the same way would mark a
          // phase finished while it is still the one outstanding, and park a
          // `gate` the run never reached.
          const parked: RunPhase = reason === "gate" ? "gate" : record.phase
          if (parked !== record.phase) close(phases, record.phase)
          phases.set(parked, { phase: parked, state: "waiting", note: reason })
          openPhase = null
          waitingPhase = parked
        } else {
          waitId = null
          waiting = null
          phases.set(record.phase, { phase: record.phase, state: "running" })
          openPhase = record.phase
          waitingPhase = null
        }
        return
      }

      case "test": {
        // `summary` and `output` stay absent: the log holds neither, and
        // `signature` is a hash for comparing failures, not a line to print.
        // Both are optional on `TestsSeen` precisely so a caller that does not
        // have them says nothing instead of inventing something.
        rows.push({ id: rowId(runId, i, 0), tests: { exitCode: record.exitCode, attempt: record.attempt } })
        digest.push({
          id: `${runId}#${i}`,
          kind: "tests",
          attempt: record.attempt,
          exitCode: record.exitCode,
          ...(record.signature === undefined ? {} : { signature: record.signature }),
        })
        return
      }

      case "human": {
        if (record.action === "raise") {
          // Finite and above zero, per `foldForResume`. This is a file another
          // process wrote, and a ceiling of NaN makes every later comparison
          // false and unbounds the run silently, so an unusable figure leaves
          // the previous ceiling standing.
          const figure: unknown = record.budgetUsd
          if (typeof figure === "number" && Number.isFinite(figure) && figure > 0) raised = figure
          else warnings.push("a raise record carried a figure this reader cannot use; the previous ceiling stands")
        }
        if (record.action === "approve") digest.push({ id: `${runId}#${i}`, kind: "approved" })
        if (record.action === "approve" || record.action === "feedback") {
          // The park this answered is over, whatever the next phase record says.
          waitId = null
          waiting = null
        }
        return
      }

      case "end": {
        ended = { state: record.state, warnings: record.warnings ?? [], costUsd: record.costUsd, ...(record.why === undefined ? {} : { why: record.why }) }
        if (openPhase === "implement" && touched.size > 0) {
          digest.push({ id: `${runId}#${i}i`, kind: "implemented", files: touched.size })
        }
        digest.push({
          id: `${runId}#${i}`,
          kind: "ended",
          state: record.state,
          ...(record.why === undefined ? {} : { why: record.why }),
          ...(record.warnings === undefined ? {} : { warnings: record.warnings }),
        })
        waitId = null
        waiting = null
        // A run that ended is waiting for nobody, so no phase may still say it
        // is. A park is otherwise terminal until a human acts, so this only
        // fires on a log that ended from one.
        if (waitingPhase !== null) {
          close(phases, waitingPhase)
          waitingPhase = null
        }
        if (openPhase !== null) {
          phases.set(openPhase, { phase: openPhase, state: record.state === "done" ? "done" : "flagged" })
          openPhase = null
        }
        return
      }
    }
  })

  return {
    header,
    rows,
    phases: [...phases.values()],
    digest,
    processes: buckets.map((results) => ({ results })),
    ceilingUsd: raised ?? (header as RunHeader | null)?.budgetUsd ?? null,
    planPath,
    waitId,
    waiting,
    ended,
    limit,
    warnings,
    unknownKinds,
  }
}

/**
 * Marks a phase a later record moved past as finished.
 *
 * Set, not patched-if-present. Both callers have positive evidence the phase
 * completed - a later phase started, or a gate park named it as the phase that
 * ran - and that evidence does not depend on this reader having seen its
 * `running` record. Skipping an absent phase would leave it `pending` in the
 * ladder, which reads as "never happened" for a phase the log just told us
 * finished.
 */
function close(phases: Map<RunPhase, PhaseStep>, phase: RunPhase): void {
  phases.set(phase, { ...phases.get(phase), phase, state: "done" })
}

/**
 * The raw event's `errors`, when it has one.
 *
 * Read off the record rather than the classified event because `Event` has no
 * such field, and `Row.tsx` requires whoever builds the row to pass it through:
 * without it a budget failure reaches the UI with nothing to say.
 */
function errorsOf(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
  const errors = (raw as Record<string, unknown>)["errors"]
  return errors === undefined ? undefined : errors
}

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

/**
 * What `GET /api/projects` answers: the tree, and the mapping from a task to
 * the run that can be addressed over HTTP.
 *
 * The two travel together because `Tree.tsx` hands its caller a `TaskId` -
 * project, feature file, ref - while every route is keyed by **run id**. Adding
 * the run id to `TreeTaskRun` would have been the obvious fix and it is the
 * wrong one: the tree is presentational, and `runindex.ts` already owns this
 * mapping and exports the key function for it.
 */
export interface TreePayload {
  /** Mutable because `TreeProps.projects` is, and this is handed straight to it. */
  projects: TreeProject[]
  /** Keyed by `taskKey` from `src/runindex.ts`: the three parts joined by NUL. */
  runs: Readonly<Record<string, RunRef>>
}

export interface RunRef {
  runId: string
  costUsd: number
  attempts: number
}

/** `taskKey`'s format, for looking a selection up in `TreePayload.runs`. */
export function taskKeyOf(id: { projectPath: string; featureFile: string; taskRef: string | null }): string | null {
  // A backlog line with no ref cannot be run and cannot be keyed: `runindex.ts`
  // keys on the ref, and `src/run.ts` refuses a task without one rather than
  // inventing it. So this says "no key" instead of making one up.
  if (id.taskRef === null) return null
  return `${id.projectPath}\u0000${id.featureFile}\u0000${id.taskRef}`
}

/**
 * Where requests go.
 *
 * Relative, so the browser sends them to the page's own origin and Vite's
 * `/api` proxy forwards them in dev. An absolute URL would also have to be
 * right about the port, and the dev port is not the server's.
 */
const API = "/api"

/**
 * Gets the session cookie.
 *
 * Needed once before anything else, and only really in dev: the cookie rides on
 * `GET /`, but Vite serves its own `index.html`, so the browser never loads the
 * server's `/` and would have no token for any other route. Harmless in
 * production, where it just re-issues the cookie it already has.
 */
export async function openSession(fetcher: typeof fetch = fetch): Promise<void> {
  const res = await fetcher(`${API}/session`, { cache: "no-store" })
  if (!res.ok) throw new Error(`the session could not be opened: ${res.status} ${await text(res)}`)
}

export async function fetchTree(fetcher: typeof fetch = fetch): Promise<TreePayload> {
  const res = await fetcher(`${API}/projects`, { cache: "no-store" })
  if (!res.ok) throw new Error(`the project tree could not be read: ${res.status} ${await text(res)}`)
  return (await res.json()) as TreePayload
}

/**
 * The plan the gate renders.
 *
 * The route answers `PlanSource` for every outcome it has, including the two
 * failures - an unreadable file and a run that dictated no plan - because the
 * gate draws those rather than throwing them. So a 200 is the only status with
 * a body worth reading, and anything else is this function's problem to report.
 */
export async function fetchPlan(runId: string, fetcher: typeof fetch = fetch): Promise<PlanSource> {
  const res = await fetcher(`${API}/runs/${encodeURIComponent(runId)}/plan`, { cache: "no-store" })
  if (!res.ok) return { status: "unreadable", path: "", why: `the server refused: ${res.status} ${await text(res)}` }
  return (await res.json()) as PlanSource
}

/**
 * Starts a run on a task and answers the id everything else addresses it by.
 *
 * The tree deliberately has no start control - it picks the task and the centre
 * column acts on it - so this is the centre's call. A task with no ref cannot
 * be started at all: `run.ts` refuses rather than inventing one, and
 * `canStart` in `Tree.tsx` is the check to make before offering it.
 */
export async function startRun(
  task: { projectPath: string; featureFile: string; taskRef: string },
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const res = await fetcher(`${API}/runs`, {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify({ projectPath: task.projectPath, featureFile: task.featureFile, taskRef: task.taskRef }),
  })
  if (!res.ok) throw new Error(`the run could not be started: ${res.status} ${await text(res)}`)
  const answer = (await res.json()) as { runId?: unknown }
  // The id is what the stream, the plan and every action are keyed by, so a
  // response without a usable one is a failure even at 201 - continuing would
  // subscribe to `undefined` and show an empty log for a run that is spending.
  if (typeof answer.runId !== "string" || answer.runId === "") {
    throw new Error("the run was started but the server did not say what its id is")
  }
  return answer.runId
}

/** The actions, design §4.4. POST, never GET: see the header of `src/server.ts`. */
export type Action =
  | { kind: "approve" }
  | { kind: "feedback"; text: string }
  | { kind: "answer"; text: string }
  | { kind: "stop" }
  | { kind: "raise"; budgetUsd: number }

export async function act(runId: string, action: Action, fetcher: typeof fetch = fetch): Promise<void> {
  // The route checks the body's keys against a fixed list and refuses an
  // unknown one, so the payload carries exactly the action's own field and
  // never `kind`.
  const body =
    action.kind === "feedback" || action.kind === "answer"
      ? JSON.stringify({ text: action.text })
      : action.kind === "raise"
        ? JSON.stringify({ budgetUsd: action.budgetUsd })
        : ""

  const res = await fetcher(`${API}/runs/${encodeURIComponent(runId)}/${action.kind}`, {
    method: "POST",
    cache: "no-store",
    ...(body === "" ? {} : { body }),
  })
  if (!res.ok) throw new Error(`${action.kind} was refused: ${res.status} ${await text(res)}`)
}

async function text(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 400)
  } catch {
    return ""
  }
}

/** What an `EventSource` has to provide. Narrowed so a test can supply one. */
export interface RecordSource {
  addEventListener(type: "open" | "error", listener: () => void): void
  addEventListener(type: "message" | "record", listener: (event: { data: string }) => void): void
  close(): void
}

export interface Subscription {
  close(): void
}

/**
 * Follows one run, calling `onView` with the folded view on every change.
 *
 * **The buffer is emptied on every `open`.** `EventSource` reconnects on its
 * own, the server replays the whole log from byte 0 every time it does, and
 * there is no marker to tell a replayed record from a live one - design §4.4
 * chose that over a `Last-Event-ID` cursor. Appending across a reconnect would
 * therefore double every row and double the cost total, which is the silent
 * direction: the figures stay plausible and the ceiling is compared against a
 * number twice the truth. Re-folding from an empty buffer is cheap and gives
 * back byte-identical row ids, so React reconciles instead of re-animating.
 */
export function subscribeRun(
  runId: string,
  onView: (view: RunView) => void,
  open: (url: string) => RecordSource = (url) => new EventSource(url) as unknown as RecordSource,
): Subscription {
  const source = open(`${API}/runs/${encodeURIComponent(runId)}/stream`)
  let records: RunRecord[] = []

  source.addEventListener("open", () => {
    records = []
  })

  source.addEventListener("record", (event: { data: string }) => {
    let record: unknown
    try {
      record = JSON.parse(event.data)
    } catch {
      // The server serialises each record with `JSON.stringify`, so this is not
      // a malformed log - it is a frame that did not arrive intact. Dropping it
      // would leave a hole in a log the UI claims is complete, so it becomes a
      // visible row like any record this version cannot read.
      records.push({ kind: "parse_error", data: event.data } as unknown as RunRecord)
      onView(foldRun(runId, records))
      return
    }
    records.push(record as RunRecord)
    onView(foldRun(runId, records))
  })

  return { close: () => source.close() }
}
