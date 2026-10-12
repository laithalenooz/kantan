/**
 * The right rail: phases, cost, the 5-hour window **per account**, and Stop.
 *
 * `docs/design/Main.dc.html` (the gate) and `docs/design/Return.dc.html` (still
 * running, with the grinding notice) are the specification for this region.
 * Read them before changing anything here; they are far more specific than this
 * comment.
 *
 * ## The props contract, for whoever wires this into `App.tsx`
 *
 * ```tsx
 * <Sidebar
 *   phases={[{ phase: "plan", state: "done", elapsedMs: 8_000 }, …]}
 *   processes={costWindows}            // one entry per spawned process; see CostProcess
 *   ceilingUsd={project.budgetUsd}
 *   windows={[{ profile: null, label: "personal", status: "allowed",
 *               utilization: 0.41, resetsAtSec: 1800000000, current: true }, …]}
 *   grinding={{ runId, attempts: 6 }}  // or null
 *   onStop={() => void stop(runId)}
 * />
 * ```
 *
 * Four hazards this file exists to get right, each of which has already cost
 * this project time:
 *
 * **1. Two accounts means two windows.** Rate limits are per Claude account and
 * a project runs under whichever profile it names, so `windows` is a list keyed
 * on `profile` — the `configDir` that paid, `null` for the default profile,
 * exactly as `RunHeader.profile` records it. One global meter would read the
 * wrong window for every project that is not on the default profile.
 *
 * **2. The limit notice keys on `status`, never on `overageStatus`.** Probed:
 * every normal event carries `overageStatus: "rejected"` with
 * `org_level_disabled`, which only means overage cannot be *bought* on this
 * plan. A notice keyed on it fires on every run and teaches the user to ignore
 * the one that matters. `AccountWindow` cannot even hold the field, and
 * `src/stream.ts` drops it before it gets here. `utilization` is a **0–1
 * fraction**, not a percentage.
 *
 * **3. Cost resets per process.** Within one `claude -p` process the
 * `total_cost_usd` figure is cumulative, so summing every `result` event
 * double-counts. `sumProcessCost` takes the **last** result of each process,
 * which is the rule `src/run.ts` applies when it resumes a run ("a spawn closes
 * the previous process's window"). The rail is handed the windows rather than
 * inferring them from the stream, because the stream does not carry the
 * boundary — see `CostProcess`, which is where that is written down.
 *
 * **4. The grinding notice never blocks.** It is a `role="status"` region that
 * slides in beside the run, never a dialog, never `role="alert"`, never the
 * primary button, and it never pulses. "Let it run" dismisses it for the run.
 *
 * One more, verified rather than assumed: Motion's `reducedMotion="user"` only
 * switches off *transform* animations, so a counting number, an opacity fade
 * and a `stroke-dashoffset` reveal all keep moving under it. Worse,
 * `useReducedMotion()` caches the media query globally on its first call and
 * never updates — probed here under happy-dom, where it answered `false` with
 * the media feature set to `reduce`. `usePrefersReducedMotion` below therefore
 * reads the media feature live, and everything that moves is gated on it.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { animate, motion, useReducedMotion } from "motion/react"

import type { Event } from "../stream.ts"
import type { RunPhase } from "../runlog.ts"

type ResultEvent = Extract<Event, { kind: "result" }>
type RateLimitEvent = Extract<Event, { kind: "rate_limit" }>

// ---------------------------------------------------------------------------
// The props
// ---------------------------------------------------------------------------

/**
 * How a phase row reads.
 *
 * Five values, because the design gives each one its own shape and only two of
 * them move: `waiting` pulses (it is the "needs you" colour) and `running`
 * spins. `flagged` is the amber retry glyph the Return artboard puts on a
 * refine round that keeps going.
 */
export type PhaseState = "done" | "waiting" | "running" | "flagged" | "pending"

export interface PhaseStep {
  phase: RunPhase
  state: PhaseState
  /** How long it took, for a phase that is no longer the current one. */
  elapsedMs?: number
  /**
   * Epoch ms this phase started, for the current one. The rail ticks its own
   * clock from this, because a run parked at the gate emits no events for
   * minutes and a frozen timer there is the one place a stale number shows.
   */
  startedAtMs?: number
  /** The qualifier beside the name: "waiting", "approved", "attempt 6". */
  note?: string
}

/**
 * One account's 5-hour window.
 *
 * `status` and `utilization` are the two fields `src/stream.ts` surfaces from a
 * `rate_limit_event`, spelled by `Pick` so a change there is a compile error
 * here rather than a rail that reads a field the parser stopped sending.
 *
 * Deliberately **not** on this type: `overageStatus`. See hazard 2 above.
 */
export interface AccountWindow extends Pick<RateLimitEvent, "status" | "utilization"> {
  /**
   * The account's identity: the `configDir` that pays for it, `null` for the
   * default profile — `RunHeader.profile`, verbatim.
   *
   * **Used exactly as given.** No trimming, no `realpath`, no `~` expansion.
   * The dimension is a filesystem path, which can arrive as `~/.claude-work`,
   * `/home/u/.claude-work`, `/home/u/.claude-work/` or a symlink to any of
   * them. Normalising would merge two keys, and merging two accounts shows a
   * run the wrong window — a wrong rate limit, silently. Failing the other way
   * splits one account into two rings, which is visible and harmless. So the
   * cheap direction is to split, and the rule is "no cleverness".
   */
  profile: string | null
  /**
   * What to call it: "personal", "work".
   *
   * A prop rather than something derived from `profile`, because every rule for
   * turning `/home/u/.claude-personal` into "personal" is a guess about how a
   * stranger names their profile directories.
   */
  label: string
  /**
   * When the window resets, in **epoch seconds** — the unit the CLI sends
   * (`rate_limit_info.resetsAt`). Absent when nothing has reported one yet, and
   * absent is rendered as `—` rather than guessed at.
   */
  resetsAtSec?: number
  /** The account this run is spending against. Gets the "this run" pill. */
  current?: boolean
}

export interface GrindingFlag {
  /**
   * The run this flag belongs to. Dismissal is keyed on it: "Let it run" means
   * "stop telling me about *this* run", so a later attempt in the same run does
   * not nag again, and the next run gets a fresh notice.
   */
  runId: string
  /** How many attempts in. The design flags a run at roughly five. */
  attempts: number
  /** Where "See the failure" goes. The run record's failing-test row. */
  failureHref?: string
}

export interface SidebarProps {
  /**
   * The five phases. Missing ones render as `pending`, so the ladder is always
   * `plan · gate · implement · test · refine` whatever the caller sends; a
   * repeated phase keeps the last entry, because the design has one row per
   * phase and aggregating a phase that ran twice is the caller's job.
   */
  phases: readonly PhaseStep[]
  /**
   * One entry per spawned `claude -p` process, each holding that process's
   * `result` events in stream order. Read `CostProcess` before building this:
   * the grouping is the part that decides whether the figure is right.
   */
  processes: readonly CostProcess[]
  /** `project.budgetUsd`: the ceiling this run was given. */
  ceilingUsd: number
  /** One entry per account. Two accounts, two rings. */
  windows: readonly AccountWindow[]
  grinding?: GrindingFlag | null
  onStop?: () => void
  /** Stop is offered while a run can still be stopped, which is most of the time. */
  stopDisabled?: boolean
}

// ---------------------------------------------------------------------------
// Cost: the last result of each process
// ---------------------------------------------------------------------------

/**
 * One spawned `claude -p` process and the `result` events it emitted, in stream
 * order.
 *
 * **Grouped by the caller, and that is the whole point.** Within a process the
 * `total_cost_usd` figure is cumulative, so where one process ends and the next
 * begins decides the total — and the event stream does not carry that boundary.
 * The orchestrator records it instead: a `phase` record "carries a `sessionId`
 * exactly when this record spawned a process, which is what lets a resumed run
 * split the log into per-process cost windows" (`src/run.ts`), and
 * `foldForResume` is the fold that reads it. So the rail is handed windows and
 * never infers them.
 *
 * Three rules that look like they would work from the stream alone, and do not:
 *
 * - **The session id.** `--resume` spawns a second process on the *same*
 *   session, so grouping by it merges two windows and under-counts.
 * - **The `system/init` event.** Tempting, since every invocation opens with
 *   one. But a phase sends several turns down one live process's stdin
 *   (`PhaseSession.turn`), and `test/fake-claude.ts` — this project's
 *   faithfulness reference for CLI behaviour, and what Tasks 8 to 14 are tested
 *   against — replays a whole fixture, init line included, for **every** turn,
 *   rewriting the figure to the running total as it goes. A turn can therefore
 *   open an `init` that is not a new process, and summing those windows inflates
 *   the bill. Over-counting is the one direction a cost panel must never fail
 *   in, and the real CLI's behaviour here was never probed.
 * - **One result per process.** `result_index` and `queued_turn_count` say a
 *   process can emit several, which is why this is a list and not a figure.
 */
export interface CostProcess {
  results: readonly ResultEvent[]
}

/**
 * The run's spend: the last result of each process, summed.
 *
 * The *last*, not the largest. `src/run.ts` banks the newest figure of a window
 * and this matches it; `src/runindex.ts` takes the largest instead, but only
 * because it reads a window it knows is incomplete. A non-finite figure counts
 * as zero, the same guard `processSpend` uses.
 */
export function sumProcessCost(processes: readonly CostProcess[]): number {
  let total = 0
  for (const process of processes) {
    const last = process.results.at(-1)
    if (last === undefined) continue
    if (Number.isFinite(last.costUsd)) total += last.costUsd
  }
  return total
}

// ---------------------------------------------------------------------------
// Accounts and the limit notice
// ---------------------------------------------------------------------------

/**
 * A window's React key. `null` — the default profile — is a real account, so it
 * needs a key that no path can collide with; everything else is the profile
 * string untouched. See `AccountWindow.profile` for why nothing is normalised.
 */
export function accountKey(profile: string | null): string {
  return profile === null ? "profile:default" : `profile:${profile}`
}

/**
 * One window per account, newest wins.
 *
 * Two projects can name the same profile, and rate-limit events arrive per run.
 * Collapsing by key cannot hide anything — identical keys *are* the same
 * account and the same window — while rendering both would show one account
 * twice and collide React keys. `current` is sticky: if any entry for the
 * account says this run spends against it, the collapsed one says so too.
 */
export function dedupeWindows(windows: readonly AccountWindow[]): AccountWindow[] {
  const byKey = new Map<string, AccountWindow>()
  for (const window of windows) {
    const key = accountKey(window.profile)
    const previous = byKey.get(key)
    byKey.set(key, previous?.current === true ? { ...window, current: true } : window)
  }
  return [...byKey.values()]
}

/**
 * Utilization at which a window is called "near its end". 0.9 of five hours
 * leaves roughly half an hour.
 *
 * A **fraction**, like every utilization in this file. Reading 0.95 as "0.95%"
 * is the mistake this threshold is written to make impossible to miss.
 */
export const NEAR_LIMIT = 0.9

export interface LimitNotice {
  /** `constrained`: the account is not being served. `near`: it is close. */
  tone: "constrained" | "near"
  window: AccountWindow
}

/**
 * The one notice the windows card may show, or `null`.
 *
 * The dimension is `status`, and it is enumerated rather than guessed:
 *
 * | value | fires | why |
 * |---|---|---|
 * | `"allowed"` | no | the ordinary event, on every normal run |
 * | `"allowed_warning"` | yes | not allowed outright; the window is biting |
 * | `"rejected"` | yes | the account is not being served |
 * | anything else | yes | a status this build does not know is still a status |
 * | `""` | yes | `src/stream.ts` yields `""` for an absent or non-string status, and a window whose status cannot be read is not one that can be called allowed. The repo's rule is that unrecognised input stays visible. |
 *
 * `overageStatus` is **not** read, and `AccountWindow` cannot carry it.
 *
 * Utilization is the second, quieter trigger: `>= NEAR_LIMIT` of the window
 * used. `undefined` fires nothing, because "we were not told" is not "you are
 * fine" and a notice on it would fire on every run that starts before the first
 * `rate_limit_event` arrives.
 *
 * Constrained wins over near, and the first such window in the caller's order
 * wins, so the notice never flickers between two accounts.
 */
export function limitNotice(windows: readonly AccountWindow[]): LimitNotice | null {
  for (const window of windows) {
    if (window.status !== "allowed") return { tone: "constrained", window }
  }
  for (const window of windows) {
    const used = window.utilization
    if (used !== undefined && Number.isFinite(used) && used >= NEAR_LIMIT) {
      return { tone: "near", window }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Formatting. Every machine value renders in mono, per DESIGN.md.
// ---------------------------------------------------------------------------

/** The artboard's own circumference, for r=25: 2π·25 = 157.0796. */
export const RING_CIRCUMFERENCE = 157.08

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/**
 * How much of the ring to leave undrawn. Geometry only, so it clamps; the label
 * does not, because an account over its window should read "104%", not "100%".
 */
export function ringOffset(utilization: number | undefined): number {
  if (utilization === undefined || !Number.isFinite(utilization)) return RING_CIRCUMFERENCE
  return RING_CIRCUMFERENCE * (1 - clamp01(utilization))
}

/** A 0–1 fraction as a percentage. `undefined` is `—`, never `0%`. */
export function percentLabel(utilization: number | undefined): string {
  if (utilization === undefined || !Number.isFinite(utilization)) return "—"
  return `${Math.round(utilization * 100)}%`
}

export function formatUsd(usd: number): string {
  return `$${(Number.isFinite(usd) ? usd : 0).toFixed(2)}`
}

/**
 * A finished duration, as the design prints it: `8s`, `2m 14s`, `19m`, `1h 4m`.
 * Seconds stop being interesting at ten minutes.
 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "—"
  const total = Math.floor(ms / 1000)
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (total < 600) return `${minutes}m ${total % 60}s`
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** The running phase's clock: `0:42`, `12:07`, `1:02:33`. */
export function formatClock(ms: number | undefined): string {
  const total = ms === undefined || !Number.isFinite(ms) || ms < 0 ? 0 : Math.floor(ms / 1000)
  const seconds = String(total % 60).padStart(2, "0")
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
  return `${minutes}:${seconds}`
}

/**
 * `resetsAt` as a wall clock, from **epoch seconds**.
 *
 * Returns `undefined` for anything that cannot be a reset time — absent, zero,
 * negative, non-finite — because `18:40` and `01:00 on 1 Jan 1970` are equally
 * confident and only one of them is true.
 */
export function formatResetTime(resetsAtSec: number | undefined): string | undefined {
  if (resetsAtSec === undefined || !Number.isFinite(resetsAtSec) || resetsAtSec <= 0) return undefined
  return new Date(resetsAtSec * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
}

const PHASE_ORDER: readonly RunPhase[] = ["plan", "gate", "implement", "test", "refine"]

const PHASE_LABEL: Record<RunPhase, string> = {
  plan: "Plan",
  gate: "Gate",
  implement: "Implement",
  test: "Test",
  refine: "Refine",
}

/** The five rows, in order, with the caller's steps dropped in where they fit. */
export function phaseLadder(steps: readonly PhaseStep[]): PhaseStep[] {
  const byPhase = new Map<RunPhase, PhaseStep>()
  for (const step of steps) byPhase.set(step.phase, step)
  return PHASE_ORDER.map((phase) => byPhase.get(phase) ?? { phase, state: "pending" })
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

const REDUCE_QUERY = "(prefers-reduced-motion: reduce)"

/**
 * Whether to hold everything still.
 *
 * Motion's own hook is asked first, because it is the project's sanctioned
 * answer and it covers an environment with no `matchMedia` at all. It is not
 * trusted alone: it caches the query result in a module global on its first
 * call anywhere in the app and captures that in `useState`, so it answers
 * whatever the first component to call it saw, forever. Probed under happy-dom
 * with the media feature set to `reduce`: it returned `false`.
 *
 * So the media feature is also read live, through `useSyncExternalStore`, which
 * re-reads on mount and subscribes to changes. Either saying "reduce" is enough.
 */
export function usePrefersReducedMotion(): boolean {
  const cached = useReducedMotion()
  const live = useSyncExternalStore(subscribeToReduceQuery, readReduceQuery, readReduceQueryOnServer)
  return cached === true || live
}

function subscribeToReduceQuery(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {}
  const query = window.matchMedia(REDUCE_QUERY)
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

function readReduceQuery(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false
  return window.matchMedia(REDUCE_QUERY).matches
}

function readReduceQueryOnServer(): boolean {
  return false
}

/**
 * The Number Ticker, hand-built on Motion's `animate`.
 *
 * It starts at the real figure rather than counting up from zero on mount: a
 * resumed run that already spent $3.18 must never flash `$0.00`, because the
 * one thing the cost panel has to be is not surprising. Changes animate.
 *
 * Under reduced motion the figure is assigned, not animated. `reducedMotion`
 * would not have stopped this on its own — a counting number is not a transform.
 */
function useTicker(value: number, reduce: boolean): number {
  const [shown, setShown] = useState(value)
  const current = useRef(value)

  useEffect(() => {
    if (reduce) {
      current.current = value
      setShown(value)
      return
    }
    if (current.current === value) return
    const controls = animate(current.current, value, {
      duration: 0.6,
      ease: [0.2, 0.7, 0.2, 1],
      onUpdate: (next) => {
        current.current = next
        setShown(next)
      },
      onComplete: () => {
        current.current = value
        setShown(value)
      },
    })
    return () => {
      controls.stop()
    }
  }, [value, reduce])

  return shown
}

/**
 * Elapsed ms for the step that is current, ticking once a second.
 *
 * **Not** gated on reduced motion. A clock is information, and a preference
 * about animation is not a request to be told the wrong time. The interval only
 * exists while something is actually running.
 */
function useLiveElapsed(startedAtMs: number | undefined): number | undefined {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (startedAtMs === undefined) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [startedAtMs])

  if (startedAtMs === undefined) return undefined
  return Math.max(0, now - startedAtMs)
}

/**
 * Whether the grinding notice shows, and how to put it away.
 *
 * Keyed on the run id: dismissal silences this run, not the next one. The
 * dimension is "which run was dismissed" — the same run (stay quiet, however
 * many more attempts it makes), a different run (speak up), or none.
 */
function useGrindingNotice(grinding: GrindingFlag | null | undefined): {
  show: boolean
  dismiss: () => void
} {
  const [dismissedRunId, setDismissedRunId] = useState<string | null>(null)
  const runId = grinding?.runId
  return {
    show: grinding != null && dismissedRunId !== grinding.runId,
    dismiss: () => setDismissedRunId(runId ?? null),
  }
}

// ---------------------------------------------------------------------------
// The rail
// ---------------------------------------------------------------------------

const CARD = "rounded-2xl border border-edge bg-white shadow-[0_1px_2px_rgba(17,18,22,.04)]"
const CARD_HEADING = "m-0 text-[11.5px] font-semibold uppercase tracking-[0.07em] text-muted-400"
const MONO = "font-mono tabular-nums"

export function Sidebar({
  phases,
  processes,
  ceilingUsd,
  windows,
  grinding = null,
  onStop,
  stopDisabled = false,
}: SidebarProps) {
  const reduce = usePrefersReducedMotion()

  const ladder = useMemo(() => phaseLadder(phases), [phases])
  const spent = useMemo(() => sumProcessCost(processes), [processes])
  const accounts = useMemo(() => dedupeWindows(windows), [windows])
  const notice = useMemo(() => limitNotice(accounts), [accounts])
  const { show: showGrinding, dismiss } = useGrindingNotice(grinding)

  return (
    <aside
      aria-label="Run details"
      className="flex min-w-0 shrink-0 grow basis-[260px] flex-col gap-3.5 border-l border-edge bg-panel px-4 pt-5 pb-7"
    >
      <Phases steps={ladder} reduce={reduce} />
      <Cost spent={spent} ceilingUsd={ceilingUsd} steps={ladder} reduce={reduce} />
      <Windows accounts={accounts} notice={notice} reduce={reduce} />
      {showGrinding && grinding != null && (
        <Grinding flag={grinding} spent={spent} reduce={reduce} onDismiss={dismiss} />
      )}
      <Stop onStop={onStop} disabled={stopDisabled} />
    </aside>
  )
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

/**
 * A word for each state, because every glyph in this rail is `aria-hidden` and
 * the tint that separates a waiting phase from a pending one is colour.
 *
 * Without these, a screen reader hears "plan 8s, gate, implement, test" - the
 * sequence with its state stripped out, which is the only thing the rail is
 * for. They are read, never seen: the glyph and the tint say the same thing to
 * anyone who can see them, and a second copy on screen would be noise.
 */
const PHASE_STATE_WORD: Record<PhaseState, string> = {
  done: "done",
  waiting: "waiting for you",
  running: "running now",
  flagged: "flagged",
  pending: "pending",
}

/**
 * Which phase the run is actually at.
 *
 * The first one that is waiting or running, which is the only kind of step a
 * sequence can be *on*: `done` is behind it, `pending` ahead, and `flagged` is
 * a note about a phase that already finished. A ladder with none of them -
 * every phase done - correctly marks nothing, rather than leaving the pointer
 * on the last thing that moved.
 */
function currentStep(steps: readonly PhaseStep[]): PhaseStep | undefined {
  return steps.find((step) => step.state === "running" || step.state === "waiting")
}

function Phases({ steps, reduce }: { steps: readonly PhaseStep[]; reduce: boolean }) {
  const current = currentStep(steps)
  return (
    <section className={`${CARD} p-3`}>
      <h2 className={`${CARD_HEADING} mx-1.5 mt-0.5 mb-2`}>Phases</h2>
      <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
        {steps.map((step) => (
          <PhaseRow key={step.phase} step={step} reduce={reduce} isCurrent={step === current} />
        ))}
      </ol>
    </section>
  )
}

/** The tint, the type and the figure's colour, one entry per `PhaseState`. */
const PHASE_TONE: Record<PhaseState, { row: string; name: string; figure: string }> = {
  done: { row: "", name: "", figure: "text-muted-500" },
  waiting: {
    row: "rounded-[10px] bg-attention-tint shadow-[inset_0_0_0_1px_#FFD3B8]",
    name: "font-[650]",
    figure: "font-semibold text-attention-ink",
  },
  running: {
    row: "rounded-[10px] bg-[#F3F3FE] shadow-[inset_0_0_0_1px_#D6D7FA]",
    name: "font-[650]",
    figure: "font-semibold text-indigo-deeper",
  },
  flagged: { row: "", name: "", figure: "text-muted-500" },
  pending: { row: "text-muted-500", name: "", figure: "" },
}

const PHASE_NOTE_TONE: Record<PhaseState, string> = {
  done: "text-muted-500",
  waiting: "text-attention-ink",
  running: "text-indigo-deeper",
  flagged: "text-muted-500",
  pending: "text-muted-500",
}

function PhaseRow({
  step,
  reduce,
  isCurrent,
}: {
  step: PhaseStep
  reduce: boolean
  isCurrent: boolean
}) {
  const live = useLiveElapsed(step.startedAtMs)
  const tone = PHASE_TONE[step.state]
  const running = step.state === "running" || step.state === "waiting"
  /* A phase that is current reads as a clock (`2:14`); one that is over reads as
   * a duration (`2m 14s`). The design prints both, and they mean different
   * things: one is still counting. */
  const figure = running ? formatClock(live ?? step.elapsedMs) : formatDuration(step.elapsedMs ?? live)

  return (
    <li
      data-phase={step.phase}
      data-state={step.state}
      aria-current={isCurrent ? "step" : undefined}
      className={`grid grid-cols-[18px_1fr_auto] items-center gap-2.5 px-2 py-[9px] text-sm ${tone.row}`}
    >
      <PhaseGlyph state={step.state} reduce={reduce} />
      <span className={`min-w-0 ${tone.name}`}>
        {PHASE_LABEL[step.phase]}
        <span className="sr-only">, {PHASE_STATE_WORD[step.state]}</span>
        {step.note !== undefined && step.note !== "" && (
          <span className={`font-medium ${PHASE_NOTE_TONE[step.state]}`}> · {step.note}</span>
        )}
      </span>
      <span data-figure={step.phase} className={`${MONO} text-[12.5px] ${tone.figure}`}>
        {figure}
      </span>
    </li>
  )
}

/**
 * The shape carries the meaning; colour only backs it up. Only `waiting`
 * pulses, only `running` spins, and both stop dead under reduced motion.
 */
function PhaseGlyph({ state, reduce }: { state: PhaseState; reduce: boolean }) {
  switch (state) {
    case "done":
      return (
        <span aria-hidden data-glyph="done" className="grid size-4 place-items-center rounded-full bg-pass">
          <svg viewBox="0 0 24 24" className="size-2.5 fill-none stroke-white stroke-[4] [stroke-linecap:round] [stroke-linejoin:round]">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </span>
      )
    case "waiting":
      /* The pulse is a box-shadow, not a transform, so `reducedMotion="user"`
       * would have let it keep going. Hence the explicit gate. */
      return (
        <motion.span
          aria-hidden
          data-glyph="waiting"
          data-motion={reduce ? "static" : "animated"}
          className="size-3.5 justify-self-center rounded-full bg-attention"
          animate={
            reduce
              ? undefined
              : {
                  boxShadow: [
                    "0 0 0 0 rgba(255,106,26,.55)",
                    "0 0 0 9px rgba(255,106,26,0)",
                    "0 0 0 0 rgba(255,106,26,0)",
                  ],
                }
          }
          transition={reduce ? undefined : { duration: 1.8, repeat: Infinity, ease: "easeOut" }}
        />
      )
    case "running":
      return (
        <motion.svg
          aria-hidden
          data-glyph="running"
          data-motion={reduce ? "static" : "animated"}
          viewBox="0 0 24 24"
          className="size-4 origin-center"
          animate={reduce ? undefined : { rotate: 360 }}
          transition={reduce ? undefined : { duration: 0.9, repeat: Infinity, ease: "linear" }}
        >
          <circle cx="12" cy="12" r="9" fill="none" stroke="#DCDCF6" strokeWidth="3" />
          <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="#5B5BD6" strokeWidth="3" strokeLinecap="round" />
        </motion.svg>
      )
    case "flagged":
      return (
        <svg
          aria-hidden
          data-glyph="flagged"
          viewBox="0 0 24 24"
          className="size-4 justify-self-center fill-none stroke-[#8A4B0A] stroke-2 [stroke-linecap:round] [stroke-linejoin:round]"
        >
          <path d="m17 2 4 4-4 4" />
          <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
          <path d="m7 22-4-4 4-4" />
          <path d="M21 13v1a4 4 0 0 1-4 4H3" />
        </svg>
      )
    case "pending":
      return (
        <span
          aria-hidden
          data-glyph="pending"
          className="box-border size-3.5 justify-self-center rounded-full border-[1.5px] border-[#C4C7CE]"
        />
      )
  }
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

/**
 * The run's spend against its ceiling.
 *
 * The chip beside the heading says whether the figure is still moving, and it
 * is derived from the phases rather than passed in, so there is one truth about
 * what the run is doing. The indigo dot does **not** pulse: DESIGN.md gives the
 * pulse to "needs you" alone, and the Return artboard's pulsing dot loses to
 * that rule.
 */
function Cost({
  spent,
  ceilingUsd,
  steps,
  reduce,
}: {
  spent: number
  ceilingUsd: number
  steps: readonly PhaseStep[]
  reduce: boolean
}) {
  const shown = useTicker(spent, reduce)
  const running = steps.some((step) => step.state === "running")
  const waiting = steps.find((step) => step.state === "waiting")
  const ceiling = Number.isFinite(ceilingUsd) && ceilingUsd > 0 ? ceilingUsd : 0
  const usedPct = ceiling === 0 ? 0 : clamp01(spent / ceiling) * 100

  return (
    <section className={`${CARD} p-4`}>
      <div className="flex items-center justify-between">
        <h2 className={CARD_HEADING}>Cost</h2>
        {running ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-deeper">
            <span aria-hidden className="size-[7px] rounded-full bg-indigo" />
            live
          </span>
        ) : waiting !== undefined ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-500">
            <span aria-hidden className="size-1.5 rounded-full bg-muted-300" />
            paused at {waiting.phase}
          </span>
        ) : null}
      </div>

      {/* `aria-live="off"`: a figure that changes every few seconds must not be
          announced. The ceiling line below it is the part worth reading. */}
      <div
        aria-live="off"
        data-testid="cost-figure"
        data-ticker={reduce ? "static" : "animated"}
        className={`mt-2 text-[38px] leading-none font-[650] tracking-[-0.035em] ${MONO}`}
      >
        {formatUsd(shown)}
      </div>
      <div className="mt-1.5 text-[13px] text-muted-500">
        of <span className={`font-semibold text-ink ${MONO}`}>{formatUsd(ceiling)}</span> ceiling for this run
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#EFEFF2]">
        <div
          data-testid="cost-bar"
          /* The width is the truth and the transition is the movement, so the
             DOM always carries the real figure. tokens.css zeroes transitions
             under reduced motion; this says so too rather than relying on it. */
          style={{
            width: `${usedPct.toFixed(2)}%`,
            minWidth: "6px",
            transition: reduce ? "none" : "width .6s var(--ease-out-soft)",
          }}
          className="h-full rounded-full bg-ink"
        />
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// The 5-hour windows, one ring per account
// ---------------------------------------------------------------------------

function Windows({
  accounts,
  notice,
  reduce,
}: {
  accounts: readonly AccountWindow[]
  notice: LimitNotice | null
  reduce: boolean
}) {
  return (
    <section className={`${CARD} p-4`} aria-labelledby="rail-windows">
      <h2 id="rail-windows" className={`${CARD_HEADING} mb-3`}>
        5-hour windows
      </h2>
      {accounts.length === 0 ? (
        <p className="m-0 text-[13px] text-muted-500">No window reported yet.</p>
      ) : (
        <div className="flex flex-col gap-3.5">
          {accounts.map((account) => (
            <WindowRing key={accountKey(account.profile)} account={account} reduce={reduce} />
          ))}
        </div>
      )}
      {notice !== null && <LimitBanner notice={notice} />}
    </section>
  )
}

function WindowRing({ account, reduce }: { account: AccountWindow; reduce: boolean }) {
  /* The ring is revealed by transitioning from empty to its real value. It
   * starts revealed under reduced motion, and the `stroke-dashoffset`
   * *attribute* always carries the true figure — a presentation attribute the
   * transition animates, never a value the animation invents. */
  const [revealed, setRevealed] = useState(reduce)
  useEffect(() => setRevealed(true), [])

  const offset = revealed ? ringOffset(account.utilization) : RING_CIRCUMFERENCE
  const resets = formatResetTime(account.resetsAtSec)
  const current = account.current === true

  return (
    <div data-testid="window" data-account={accountKey(account.profile)} className="grid grid-cols-[52px_1fr] items-center gap-3">
      <div className="relative size-[52px]">
        <svg viewBox="0 0 60 60" aria-hidden className="size-[52px] -rotate-90">
          <circle cx="30" cy="30" r="25" fill="none" stroke={current ? "#E6F3FB" : "#EEEEF1"} strokeWidth="6" />
          <circle
            data-testid="window-ring"
            cx="30"
            cy="30"
            r="25"
            fill="none"
            stroke={current ? "#0284C7" : "#26272D"}
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE.toFixed(2)}
            strokeDashoffset={offset.toFixed(2)}
            style={{ transition: reduce ? "none" : "stroke-dashoffset 1.4s var(--ease-out-soft)" }}
          />
        </svg>
        <span
          data-testid="window-percent"
          className={`absolute inset-0 grid place-items-center text-[12.5px] font-[650] ${MONO}`}
        >
          {percentLabel(account.utilization)}
        </span>
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span
          className={`flex flex-wrap items-center gap-1.5 text-sm font-semibold ${current ? "text-account-ink" : "text-ink-soft"}`}
        >
          <span className="[overflow-wrap:anywhere]">{account.label}</span>
          {current && (
            <span className="rounded-full bg-ink px-1.5 py-px text-[10.5px] font-semibold text-white">this run</span>
          )}
        </span>
        <span className={`${MONO} text-xs text-muted-500`}>{resets === undefined ? "resets —" : `resets ${resets}`}</span>
      </div>
    </div>
  )
}

/**
 * Why a window is worth mentioning. `role="status"` — polite, never an alert,
 * and it never takes a button.
 *
 * `constrained` borrows the amber the design gives a run that is impeded;
 * `near` stays in the account palette, because "you have half an hour left" is
 * information and must look quieter than "you are not being served".
 */
function LimitBanner({ notice }: { notice: LimitNotice }) {
  const { tone, window: account } = notice
  const used = percentLabel(account.utilization)
  const resets = formatResetTime(account.resetsAtSec)

  return (
    <div
      role="status"
      data-testid="limit-notice"
      data-tone={tone}
      className={`mt-3.5 rounded-xl border px-3 py-2.5 text-[12.5px] leading-[1.5] ${
        tone === "constrained"
          ? "border-[#F7D98B] bg-[#FFFBEB] text-[#5C3305]"
          : "border-[#BAE0F7] bg-account-tint text-account-ink"
      }`}
    >
      <span className="font-semibold [overflow-wrap:anywhere]">{account.label}</span>
      {tone === "constrained" ? (
        <>
          {" is not being served: status "}
          <span className="font-mono font-semibold">{account.status === "" ? "unreported" : account.status}</span>.
        </>
      ) : (
        " is near the end of its 5-hour window."
      )}{" "}
      <span className={MONO}>{used}</span> used
      {resets !== undefined && (
        <>
          , resets <span className={MONO}>{resets}</span>
        </>
      )}
      .
    </div>
  )
}

// ---------------------------------------------------------------------------
// Grinding
// ---------------------------------------------------------------------------

/**
 * A run that keeps failing is flagged with its cost and **keeps going**.
 *
 * A notice, never a modal: `role="status"`, no `aria-modal`, no focus trap,
 * nothing disabled behind it, and Stop stays exactly where it was. It does not
 * pulse — amber is for a run that is grinding, and the pulse belongs to "needs
 * you" alone. "Let it run" puts it away for this run.
 *
 * It slides in with Motion, and the slide is gated: an opacity and `x` entrance
 * is half transform, so `reducedMotion="user"` would have faded it in anyway.
 * There is deliberately no exit animation — a dismissal the user asked for
 * should leave at once, not linger for 600ms.
 */
function Grinding({
  flag,
  spent,
  reduce,
  onDismiss,
}: {
  flag: GrindingFlag
  spent: number
  reduce: boolean
  onDismiss: () => void
}) {
  return (
    <motion.section
      role="status"
      aria-labelledby="rail-grinding"
      data-testid="grinding-notice"
      initial={reduce ? false : { opacity: 0, x: 16 }}
      animate={reduce ? undefined : { opacity: 1, x: 0 }}
      transition={reduce ? undefined : { duration: 0.6, delay: 0.3, ease: [0.2, 0.7, 0.2, 1] }}
      className="rounded-2xl border border-[#F7D98B] bg-[#FFFBEB] p-4 shadow-[0_8px_24px_-16px_rgba(180,83,9,.5)]"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden className="grid size-7 place-items-center rounded-[9px] bg-[#FEF3C7] text-[#8A4B0A]">
          <svg
            viewBox="0 0 24 24"
            className="size-[15px] fill-none stroke-current stroke-[2.2] [stroke-linecap:round] [stroke-linejoin:round]"
          >
            <path d="m17 2 4 4-4 4" />
            <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
            <path d="m7 22-4-4 4-4" />
            <path d="M21 13v1a4 4 0 0 1-4 4H3" />
          </svg>
        </span>
        <h2 id="rail-grinding" className="m-0 text-[15px] font-[650] text-[#5C3305]">
          Grinding
        </h2>
      </div>
      <p className="mt-2.5 mb-3.5 text-[13.5px] leading-[1.55] text-[#5C3305]">
        <span className={MONO}>{flag.attempts}</span> attempts, <span className={`font-[650] ${MONO}`}>{formatUsd(spent)}</span>{" "}
        so far. It is still running and nothing is blocked. Whether to step in is up to you.
      </p>
      <div className="flex flex-wrap gap-2">
        {flag.failureHref !== undefined && (
          <a
            href={flag.failureHref}
            /* The notice's own ink, not the app's indigo: an indigo ring on an
               amber plate is the pair this project has already got wrong once. */
            className="inline-flex h-9 items-center rounded-full bg-[#5C3305] px-3.5 text-[13px] font-semibold text-[#FFFBEB] no-underline focus-visible:ring-2 focus-visible:ring-[#5C3305] focus-visible:ring-offset-2 focus-visible:ring-offset-[#FFFBEB]"
          >
            See the failure
          </a>
        )}
        <button
          type="button"
          onClick={onDismiss}
          className="h-9 rounded-full border border-[#E9C46A] bg-transparent px-3.5 text-[13px] font-semibold text-[#5C3305] focus-visible:ring-2 focus-visible:ring-[#5C3305] focus-visible:ring-offset-2 focus-visible:ring-offset-[#FFFBEB]"
        >
          Let it run
        </button>
      </div>
    </motion.section>
  )
}

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

/**
 * Stop, and the one sentence that makes it safe to press.
 *
 * The explanation is permanent copy wired as the button's accessible
 * description, not a hover tooltip: stopping is free *because the run is
 * resumable*, and a fact that changes whether you press a button should not
 * require hovering to discover.
 *
 * It is an outline button, never the primary one, and it is the only control in
 * the rail — which is what keeps the grinding notice above it from competing.
 */
function Stop({ onStop, disabled }: { onStop?: (() => void) | undefined; disabled: boolean }) {
  return (
    <div className="mt-auto flex flex-col gap-2">
      <button
        type="button"
        onClick={onStop}
        disabled={disabled}
        aria-describedby="rail-stop-note"
        className="flex h-11 w-full items-center justify-center gap-2 rounded-full border border-edge-strong bg-white text-sm font-medium text-ink-deep transition-colors hover:bg-[#F6F6F8] focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:text-muted-300"
      >
        <svg aria-hidden viewBox="0 0 24 24" className="size-3 fill-current">
          <rect width="18" height="18" x="3" y="3" rx="3" />
        </svg>
        Stop run
      </button>
      <p id="rail-stop-note" className="m-0 text-center text-[12.5px] text-muted-500">
        Resumable. Stopping costs nothing.
      </p>
    </div>
  )
}
