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
 *
 * ## Typography: the artboard, not the summary
 *
 * `DESIGN.md` says "mono for every machine value", and then says the artboards
 * are more precise than itself. They are, and they disagree with it here. In
 * `Main.dc.html` the `.m` (Geist Mono) class is on the **phase durations** and
 * the **`resets` lines** and nowhere else in this rail: the cost figure, the
 * `$50.00` ceiling and the ring percentages are plain Geist with
 * `font-variant-numeric: tabular-nums`. A 38px mono `$0.42` sets the decimal
 * point in a full character cell and does not look like the artboard at all,
 * which is the single most visible difference a screenshot shows. So the
 * artboard wins, and `tabular-nums` does the job mono was wanted for — the
 * figure does not jitter as it ticks.
 *
 * ## Three things this rail cannot show, because nothing upstream sends them
 *
 * Each renders as a dash or is left out rather than guessed at:
 *
 * - **Per-phase elapsed times.** `foldRun` in `src/ui/live.ts` sets neither
 *   `elapsedMs` nor `startedAtMs` on any step, so every figure is `—` in a
 *   live run. A row with no timing at all must print `—`; printing
 *   `formatClock(undefined)` would invent `0:00` for a gate nobody has timed,
 *   and a current row is exactly where a fabricated figure would be believed.
 * - **The account's name.** `GET /api/projects` reports `{kind:"unknown"}`
 *   because nothing maps a `configDir` to an account, so `App.tsx` passes the
 *   label "account unknown". Rendered as given. See `AccountWindow.profile`:
 *   guessing an account's identity shows a run the wrong rate limit silently.
 * - **The reset time.** `src/stream.ts` reads `rate_limit_info` and keeps only
 *   `status` and `utilization`; `resetsAt` is dropped there, `RunView.limit`
 *   has nowhere to put it and `App.tsx` passes no `resetsAtSec`. So `resets —`
 *   is the honest reading, not a formatting bug.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
/* `animate` only, never a `motion.*` component. Motion drives a component
 * through WAAPI, and cancelling a WAAPI animation rejects an
 * `Animation.finished` promise `motion-dom` does not catch — 195 unhandled
 * `AbortError`s in one test run, measured on this repo's `Digest.tsx`. Every
 * entrance here is a CSS class from `artboard.css` instead. `animate` on two
 * numbers is the exception: it runs on `requestAnimationFrame`, has no promise
 * to reject, and no CSS rule can count a figure. */
import { animate, useReducedMotion } from "motion/react"

import type { Event } from "../stream.ts"
import type { RunPhase } from "../runlog.ts"
import {
  DASH,
  RING_CIRCUMFERENCE,
  clamp01,
  formatClock,
  formatDuration,
  formatResetTime,
  formatUsd,
  percentLabel,
  ringOffset,
} from "./format.ts"
import { usePrefersReducedMotion } from "./reducedmotion.ts"

/* Re-exported: these lived here, and `App.tsx` plus three test files still ask
   this module for them. Moving them was a refactor rather than a rename. */
export {
  RING_CIRCUMFERENCE,
  formatClock,
  formatDuration,
  formatResetTime,
  formatUsd,
  percentLabel,
  ringOffset,
  usePrefersReducedMotion,
}

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
  /**
   * Picks the run back up from where it stopped. Absent draws no resume.
   *
   * The footer offers **one** control, and which one depends on the run: a
   * greyed-out "Stop run" on a run that is already stopped is a dead end, and
   * it was the only thing there - reported from use as "I can't even fully stop
   * and resume if I wanted to". `StartPanel` has the design's own "Resume run",
   * but it is only drawn when there is no run on screen, so a stopped run with
   * a rail could not reach it.
   */
  onResume?: () => void
  /** The run is stopped, so the footer offers resume rather than stop. */
  resumable?: boolean
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

/**
 * A machine value in Geist Mono: the phase durations and the `resets` lines,
 * which is every `.m` the artboard puts in this rail and no more.
 *
 * `tabular-nums` rides along because these tick. It is redundant in a monospace
 * face and costs nothing, and it means the two constants can be read as "this
 * number must not jitter" rather than "this number is in a particular font".
 */
const MONO = "font-mono tabular-nums"

/**
 * A machine value in Geist: the cost figure, the ceiling and the ring
 * percentages. Proportional, but with the digits on a fixed advance so a
 * counting figure does not shuffle its neighbours — `font-variant-numeric:
 * tabular-nums`, which is exactly what the artboard puts on all three.
 */
const FIGURE = "tabular-nums"

export function Sidebar({
  phases,
  processes,
  ceilingUsd,
  windows,
  grinding = null,
  onStop,
  stopDisabled = false,
  onResume,
  resumable = false,
}: SidebarProps) {
  const reduce = usePrefersReducedMotion()

  const ladder = useMemo(() => phaseLadder(phases), [phases])
  const spent = useMemo(() => sumProcessCost(processes), [processes])
  const accounts = useMemo(() => dedupeWindows(windows), [windows])
  const notice = useMemo(() => limitNotice(accounts), [accounts])
  const { show: showGrinding, dismiss } = useGrindingNotice(grinding)

  /* Two rules on the root, both measured against `Main.dc.html` in Chrome.
   *
   * `min-h-full`, because Stop is pinned with `margin-top:auto` and an auto
   * margin has nothing to push against in a box that ends at its content. The
   * artboard's rail is a column of a `min-height:100vh` flex row, so Stop sits
   * at the bottom of the screen there; without this it sat directly under the
   * windows card. Caught in a screenshot, not by an assertion.
   *
   * `leading-[normal]`, because Tailwind's preflight puts `line-height: 1.5`
   * on `html` and the artboard sets no line-height at all — so every line in
   * this rail was 2 to 4px taller than the design, and the three cards came
   * out 253/141/190px against the artboard's 230/133/178. That is 43px of
   * looseness nothing points at: each row looks almost right on its own. The
   * elements that carry a line-height below do so because the artboard gives
   * them one. For the same reason this file uses `text-[14px]` and
   * `text-[12px]` rather than `text-sm` and `text-xs`, which bundle a
   * line-height of their own that would override this. */
  return (
    <aside
      aria-label="Run details"
      className="flex min-h-full min-w-0 shrink-0 grow basis-[260px] flex-col border-l border-edge bg-panel px-4 leading-[normal]"
    >
      {/* Everything the rail holds, in one box that follows the scroll.

          The artboard pins "Stop run" with `margin-top:auto` in a column exactly
          one viewport tall, so it sits at the bottom of the *screen*. The row
          here is `items-stretch` and the centre column can be 8795px tall
          (measured, on a gate with a long plan), so the same `margin-top:auto`
          put Stop 8795px down the page - reported from use as "all the way down,
          takes too long to scroll to see it", by someone trying to stop a run.

          `max-h-dvh` and not `h-dvh`: forcing the full viewport height makes the
          box start below the 56px app bar and end 56px below the fold, which put
          Stop back off-screen at 1200px tall (measured: top 1223, viewport
          1200). Capping instead lets the box be as tall as its own cards, which
          is shorter than the viewport in every real state - and a band between
          the bar and the columns then costs nothing, where a hard-coded offset
          would have been wrong the moment one appeared. */}
      <div className="sticky top-0 flex max-h-dvh flex-col gap-3.5 pt-5 pb-7">
        {/* `min-h-0` is what lets this shrink below its content and scroll:
            without it a flex child's `auto` minimum is its content height, so
            the box would grow past `max-h-dvh` and take the footer with it. */}
        <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto">
          {/* `bf d2`…`d5` on the four children below: the Blur Fade stagger, with
              the artboard's own delays, so the rail arrives one card at a time.
              The classes are `src/ui/artboard.css`'s, which `main.tsx` imports. */}
          <Phases steps={ladder} reduce={reduce} />
          <Cost spent={spent} ceilingUsd={ceilingUsd} steps={ladder} reduce={reduce} />
          <Windows accounts={accounts} notice={notice} reduce={reduce} />
          {showGrinding && grinding != null && (
            <Grinding flag={grinding} spent={spent} reduce={reduce} onDismiss={dismiss} />
          )}
        </div>
        {resumable && onResume !== undefined ? (
          <Resume onResume={onResume} />
        ) : (
          <Stop onStop={onStop} disabled={stopDisabled} />
        )}
      </div>
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
  return steps.find((step) => isCurrentState(step.state))
}

function Phases({ steps, reduce }: { steps: readonly PhaseStep[]; reduce: boolean }) {
  const current = currentStep(steps)
  return (
    <section className={`${CARD} bf d2 p-3`}>
      <h2 className={`${CARD_HEADING} mx-1.5 mt-0.5 mb-2`}>Phases</h2>
      <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
        {steps.map((step) => (
          <PhaseRow key={step.phase} step={step} reduce={reduce} isCurrent={step === current} />
        ))}
      </ol>
    </section>
  )
}

/**
 * The tint, the type and the figure's colour, one entry per `PhaseState`.
 *
 * `row` carries the padding too, because the artboard gives the highlighted
 * row `10px 8px` against every other row's `9px 8px` — the tint is a plate and
 * it sits a little prouder than the rows around it.
 */
const PHASE_TONE: Record<PhaseState, { row: string; name: string; note: string; figure: string }> = {
  done: { row: "py-[9px]", name: "", note: "text-muted-500", figure: "text-muted-500" },
  waiting: {
    row: "rounded-[10px] bg-attention-tint py-[10px] shadow-[inset_0_0_0_1px_#FFD3B8]",
    name: "font-[650]",
    note: "font-medium text-attention-ink",
    figure: "font-semibold text-attention-ink",
  },
  running: {
    row: "rounded-[10px] bg-[#F3F3FE] py-[10px] shadow-[inset_0_0_0_1px_#D6D7FA]",
    name: "font-[650]",
    note: "font-medium text-indigo-deeper",
    figure: "font-semibold text-indigo-deeper",
  },
  flagged: { row: "py-[9px]", name: "", note: "text-muted-500", figure: "text-muted-500" },
  pending: { row: "py-[9px] text-muted-500", name: "", note: "text-muted-500", figure: "" },
}

/**
 * The qualifier beside the phase name, or nothing.
 *
 * A guard that drops input, so the rule in `CLAUDE.md` applies. **The dimension
 * it reads is `note` compared against `step.phase`** — not the note on its own.
 *
 * The values that dimension takes, because the fold hands this field the
 * *park reason* (`src/ui/live.ts`) and callers hand it anything:
 *
 * | note | phase | today | wanted |
 * |---|---|---|---|
 * | `"gate"` | `gate` | the park reason for a gate | drop: "Gate · gate" |
 * | `"question"` | `plan`, `implement` | why the run is parked | **keep** |
 * | `"blocked"`, `"stalled"` | any | why the run is parked | **keep** |
 * | `"waiting"`, `"approved"`, `"attempt 6"` | any | a caller's own word | keep |
 * | `undefined`, `""` | any | nothing to say | nothing |
 *
 * The costs are not symmetric. Dropping `question` on a plan phase hides *why*
 * a run is parked, which is the one thing the row is there to say; showing a
 * duplicate is only ugly. So the match is **exact and against the phase id
 * alone** — no case folding, no matching the display label, no prefix rule.
 * `"gate"` is the only value any of those extra rules would catch that the
 * exact one does not, and each of them can also catch a real reason.
 *
 * Dropping it is not the end of it. A row that is `waiting` still says so, in
 * the artboard's own word, and that word comes from `state` rather than from
 * the caller — so it cannot be the thing that was just found redundant. Every
 * other state falls back to nothing: `done` would have to invent "approved",
 * and the rail has no way to know whether a gate was approved or answered.
 */
function phaseNote(step: PhaseStep): string | undefined {
  const note = step.note
  if (note !== undefined && note !== "" && note !== step.phase) return note
  return step.state === "waiting" ? "waiting" : undefined
}

/**
 * How long a row has been at it, or `—`.
 *
 * Two formats, because the artboards print two: a phase that is `running`
 * counts, so `Return.dc.html` clocks it (`mm:ss`, from its own script), and
 * everything else — including the gate the run is parked at — is a finished
 * span, which `Main.dc.html` prints as `2m 14s`.
 *
 * The dash is the part that matters. `formatClock(undefined)` is `0:00` by
 * contract, and a current row is precisely where a fabricated `0:00` would be
 * believed: it looks like a phase that just started. `foldRun` sets neither
 * timing field today, so without this every live run would show one.
 *
 * Which field is read is decided by `state`, not by which one happens to be
 * set, because `PhaseStep` gives the two different jobs: `startedAtMs` is "for
 * the current one" and `elapsedMs` is "for a phase that is no longer the
 * current one". A finished step can carry both — `close()` in
 * `src/ui/live.ts` builds its `done` entry by spreading the running one, so
 * the moment that fold starts stamping `startedAtMs`, every finished row
 * inherits one. A row that is over therefore reads `elapsedMs` and **nothing
 * else**: falling back to the live clock would have a phase that ended minutes
 * ago still counting. With no recorded duration it prints `—`, which is the
 * same rule as everywhere else here — say nothing rather than something made
 * up. `PhaseRow` withholds the live clock from those rows for the same reason,
 * which also stops a finished row holding a 1s interval open.
 */
function phaseFigure(step: PhaseStep, live: number | undefined): string {
  const ms = isCurrentState(step.state) ? (live ?? step.elapsedMs) : step.elapsedMs
  if (ms === undefined) return DASH
  return step.state === "running" ? formatClock(ms) : formatDuration(ms)
}

/** Whether a state is one a run can be *on*, and so one that is still timing. */
function isCurrentState(state: PhaseState): boolean {
  return state === "running" || state === "waiting"
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
  /* Withheld from a row that is over, so a finished phase cannot inherit a
   * start time and tick on — and does not hold a 1s interval open to do it.
   * The hook is still called on every render; only its argument varies. */
  const live = useLiveElapsed(isCurrentState(step.state) ? step.startedAtMs : undefined)
  const tone = PHASE_TONE[step.state]
  const note = phaseNote(step)

  return (
    <li
      data-phase={step.phase}
      data-state={step.state}
      aria-current={isCurrent ? "step" : undefined}
      className={`grid grid-cols-[18px_1fr_auto] items-center gap-2.5 px-2 text-[14px] ${tone.row}`}
    >
      <PhaseGlyph state={step.state} reduce={reduce} />
      <span className={`min-w-0 ${tone.name}`}>
        {PHASE_LABEL[step.phase]}
        <span className="sr-only">, {PHASE_STATE_WORD[step.state]}</span>
        {note !== undefined && (
          <span data-note={step.phase} className={tone.note}>
            {" · "}
            {note}
          </span>
        )}
      </span>
      <span data-figure={step.phase} className={`${MONO} text-[12.5px] ${tone.figure}`}>
        {phaseFigure(step, live)}
      </span>
    </li>
  )
}

/**
 * The shape carries the meaning; colour only backs it up. Only `waiting`
 * pulses, only `running` spins, and both stop dead under reduced motion.
 *
 * Both are the artboard's own CSS classes — `.pulse` is `kpulse`, `.spin` is
 * `kspin`, both in `src/ui/artboard.css` — rather than Motion components.
 * Motion drives these through WAAPI, and cancelling a WAAPI animation rejects
 * an `Animation.finished` promise that `motion-dom` does not catch: the agent
 * on `Digest.tsx` measured 195 unhandled `AbortError`s in one test run from
 * exactly this, and a rejection between tests is reported as a failure in a
 * suite that did nothing wrong. A CSS keyframe has no promise to reject.
 *
 * The class is applied only when motion is allowed, rather than left to the
 * `@media (prefers-reduced-motion: reduce)` guard in `artboard.css` and
 * `tokens.css`. Those are the belt; this is the braces, it is what
 * `data-motion` reports, and it is the only one of the three that still holds
 * if a root never gets the `kr` class the artboard's guard selects on.
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
      /* The pulse is a box-shadow, not a transform, so Motion's
       * `reducedMotion="user"` would have let it keep going either way. */
      return (
        <span
          aria-hidden
          data-glyph="waiting"
          data-motion={reduce ? "static" : "animated"}
          className={`size-3.5 justify-self-center rounded-full bg-attention ${reduce ? "" : "pulse"}`}
        />
      )
    case "running":
      return (
        <svg
          aria-hidden
          data-glyph="running"
          data-motion={reduce ? "static" : "animated"}
          viewBox="0 0 24 24"
          /* No `justify-self`, which is not an oversight: in the phase rail
             the artboards centre the 14px glyphs in the 18px column and leave
             the 16px ones at the start, so a spinner that is centred sits a
             pixel right of the checks above it. `Return.dc.html`'s own running
             row carries no `justify-self`; the ones that do are 14px, or the
             left rail's task rows. */
          className={`size-4 origin-center ${reduce ? "" : "spin"}`}
        >
          <circle cx="12" cy="12" r="9" fill="none" stroke="#DCDCF6" strokeWidth="3" />
          <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="#5B5BD6" strokeWidth="3" strokeLinecap="round" />
        </svg>
      )
    case "flagged":
      return (
        <svg
          aria-hidden
          data-glyph="flagged"
          viewBox="0 0 24 24"
          className="ic size-4 justify-self-center fill-none stroke-[#8A4B0A] stroke-2 [stroke-linecap:round] [stroke-linejoin:round]"
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
 * Whether the figure is still moving, in the artboard's own register.
 *
 * Derived from the phases rather than passed in, so there is one truth about
 * what the run is doing, and **total**: `Main.dc.html` and `Return.dc.html`
 * both draw this line, so a card that renders it only sometimes has a hole in
 * it where the artboard has a sentence. The third branch is the one neither
 * artboard covers, and it has to be a word that is true for everything that
 * reaches it — a finished run, a failed one, and a ladder that has not started
 * — so it says only what is certain: nothing is running.
 *
 * Deliberately not `stopDisabled`, which answers a different question ("can
 * this still be stopped") and would make the line a property of a button.
 */
function costStatus(steps: readonly PhaseStep[]): { word: string; live: boolean } {
  if (steps.some((step) => step.state === "running")) return { word: "live", live: true }
  const waiting = steps.find((step) => step.state === "waiting")
  if (waiting !== undefined) return { word: `paused at ${waiting.phase}`, live: false }
  return { word: "not running", live: false }
}

/**
 * The run's spend against its ceiling.
 *
 * The indigo dot does **not** pulse: DESIGN.md gives the pulse to "needs you"
 * alone, and the Return artboard's pulsing dot loses to that rule.
 *
 * The figure, the ceiling and the bar are Geist with `tabular-nums`, not mono
 * — see "Typography: the artboard, not the summary" at the top of this file.
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
  const status = costStatus(steps)
  const ceiling = Number.isFinite(ceilingUsd) && ceilingUsd > 0 ? ceilingUsd : 0
  const usedPct = ceiling === 0 ? 0 : clamp01(spent / ceiling) * 100

  return (
    <section className={`${CARD} bf d3 p-4`}>
      <div className="flex items-center justify-between gap-2">
        <h2 className={CARD_HEADING}>Cost</h2>
        <span
          data-testid="cost-status"
          className={`inline-flex items-center gap-1.5 text-[12px] ${
            /* 560 and 400 are the artboard's own weights: `Return.dc.html`
               sets `font-weight:560` on "live" and `Main.dc.html` sets none at
               all on "paused at gate", so the moving one reads a shade firmer
               than the parked one. */
            status.live ? "font-[560] text-indigo-deeper" : "text-muted-500"
          }`}
        >
          <span
            aria-hidden
            className={`rounded-full ${status.live ? "size-[7px] bg-indigo" : "size-1.5 bg-muted-300"}`}
          />
          {status.word}
        </span>
      </div>

      {/* `aria-live="off"`: a figure that changes every few seconds must not be
          announced. The ceiling line below it is the part worth reading. */}
      <div
        aria-live="off"
        data-testid="cost-figure"
        data-ticker={reduce ? "static" : "animated"}
        className={`mt-2 text-[38px] leading-none font-[650] tracking-[-0.035em] ${FIGURE}`}
      >
        {formatUsd(shown)}
      </div>
      <div className="mt-1.5 text-[13px] text-muted-500">
        of <span className={`font-semibold text-ink ${FIGURE}`}>{formatUsd(ceiling)}</span> ceiling for this run
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
    <section className={`${CARD} bf d4 p-4`} aria-labelledby="rail-windows">
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

/**
 * One account's ring: the artboard's Animated Circular Progress Bar.
 *
 * `.ring` is the artboard's own class — `kring` winds the `stroke-dashoffset`
 * up from `RING_CIRCUMFERENCE` to the value the attribute already carries, in
 * 1.4s. The attribute is therefore always the true figure and the animation
 * only decides how it is arrived at; nothing here can invent a reading.
 *
 * The class is applied only when motion is allowed. `artboard.css` and
 * `tokens.css` both stop CSS animations under the media query, so that is
 * belt-and-braces rather than the only guard — but it is the one that does not
 * depend on a root carrying `kr`, and it is what keeps the ring inside the
 * explicit reduced-motion gate the rest of this file is tested through.
 *
 * `.ring` collides by name with Tailwind's `ring` utility, which sets a
 * box-shadow. On an SVG `<circle>` that does nothing, which is why it is here
 * and on no wrapper.
 *
 * One consequence worth knowing: `kring` has no `to` keyframe, so it fills
 * against the live computed value. A window that moves *after* the entrance
 * has run therefore snaps to its new offset rather than sweeping to it. The
 * artboards are static and say nothing about the second reading; a rate-limit
 * event arrives minutes apart and moves the ring by a degree or two, so the
 * snap is not visible, and the entrance the design actually names is.
 */
function WindowRing({ account, reduce }: { account: AccountWindow; reduce: boolean }) {
  const resets = formatResetTime(account.resetsAtSec)
  const current = account.current === true

  return (
    <div data-testid="window" data-account={accountKey(account.profile)} className="grid grid-cols-[52px_1fr] items-center gap-3">
      <div className="relative size-[52px]">
        <svg viewBox="0 0 60 60" aria-hidden className="size-[52px] -rotate-90">
          <circle cx="30" cy="30" r="25" fill="none" stroke={current ? "#E6F3FB" : "#EEEEF1"} strokeWidth="6" />
          <circle
            data-testid="window-ring"
            data-motion={reduce ? "static" : "animated"}
            className={reduce ? undefined : "ring"}
            cx="30"
            cy="30"
            r="25"
            fill="none"
            stroke={current ? "#0284C7" : "#26272D"}
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE.toFixed(2)}
            strokeDashoffset={ringOffset(account.utilization).toFixed(2)}
          />
        </svg>
        <span
          data-testid="window-percent"
          className={`absolute inset-0 grid place-items-center text-[12.5px] font-[650] ${FIGURE}`}
        >
          {percentLabel(account.utilization)}
        </span>
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        {/* The one place this rail deliberately does not reproduce the
            artboard, because the artboard is wrong there — measured, in Chrome,
            on `Main.dc.html` itself at its own 1440px preview width with the
            repo's real Geist loaded:

              grid column        129.3px
              "personal"          68.6px
              gap                  6.0px
              "this run" pill     58.1px   (46.1 of text + 2 x 6 padding)
              -------------------------
              needed             132.7px

            2.7px over. The artboard's row is `nowrap` with both children
            shrinkable, so flexbox takes it out of the pill: it renders 54.7px
            wide and **26px tall**, with "this" and "run" on two lines inside
            the rounded shape. Opened over `file://` the artboard falls back to
            a system sans, "this run" measures 50.3px, and it fits — which is
            why nobody has seen this.

            Nothing here is resized to make it fit: every figure above is the
            design's. The pill keeps its shape (`shrink-0`, `whitespace-nowrap`)
            and the row is allowed to wrap, so the only thing that gives is
            which line the pill sits on. `[overflow-wrap:anywhere]` then only
            bites for a label with a single token wider than the whole column,
            which is the right threshold for it. */}
        <span
          className={`flex flex-wrap items-center gap-1.5 text-[14px] font-semibold ${current ? "text-account-ink" : "text-ink-soft"}`}
        >
          <span className="[overflow-wrap:anywhere]">{account.label}</span>
          {current && (
            <span className="shrink-0 rounded-full bg-ink px-1.5 py-px text-[10.5px] font-semibold whitespace-nowrap text-white">
              this run
            </span>
          )}
        </span>
        <span className={`${MONO} text-[12px] text-muted-500`}>{resets === undefined ? "resets —" : `resets ${resets}`}</span>
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
 * It slides in on `.slide`, which `Return.dc.html` puts on this very section:
 * `kslide` is opacity and `translateX(16px)` over .6s after a .3s delay, which
 * is what the Motion entrance this replaces was hand-tuned to match. The class
 * is withheld under reduced motion — an opacity-and-`x` entrance is only half
 * transform, so Motion's `reducedMotion="user"` would have faded it in anyway,
 * and the gate has to be explicit either way.
 *
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
    <section
      role="status"
      aria-labelledby="rail-grinding"
      data-testid="grinding-notice"
      data-motion={reduce ? "static" : "animated"}
      className={`rounded-2xl border border-[#F7D98B] bg-[#FFFBEB] p-4 shadow-[0_8px_24px_-16px_rgba(180,83,9,.5)] ${reduce ? "" : "slide"}`}
    >
      <div className="flex items-center gap-2">
        <span aria-hidden className="grid size-7 place-items-center rounded-[9px] bg-[#FEF3C7] text-[#8A4B0A]">
          <svg
            viewBox="0 0 24 24"
            className="ic size-[15px] fill-none stroke-current stroke-[2.2] [stroke-linecap:round] [stroke-linejoin:round]"
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
        <span className={FIGURE}>{flag.attempts}</span> attempts,{" "}
        <span className={`font-[650] ${FIGURE}`}>{formatUsd(spent)}</span>{" "}
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
    </section>
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
/**
 * The footer of a stopped run: pick it up again.
 *
 * Black, because it is the one thing to do on this screen and that is what the
 * design's black means - `Start.dc.html` gives "Resume run" exactly this
 * treatment (`background:#111216; color:#fff`). The note is the honest version
 * of the promise beside Stop: it resumes from the last complete phase, which
 * for a test means running the suite again and for an implement means the same
 * conversation, so nothing is redone that was already finished.
 */
function Resume({ onResume }: { onResume: () => void }) {
  return (
    <div className="bf d5 flex shrink-0 flex-col gap-2 pt-3.5">
      <button
        type="button"
        onClick={onResume}
        aria-describedby="rail-resume-note"
        className="cta flex h-11 w-full items-center justify-center gap-2 rounded-full border-0 bg-ink text-[14px] font-[620] text-white transition-colors hover:bg-ink-hover focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2"
      >
        <svg aria-hidden viewBox="0 0 24 24" className="size-3 fill-current">
          <polygon points="6 3 20 12 6 21 6 3" />
        </svg>
        Resume run
      </button>
      <p id="rail-resume-note" className="m-0 text-center text-[12.5px] text-muted-500">
        Picks up from the last phase it finished.
      </p>
    </div>
  )
}

function Stop({ onStop, disabled }: { onStop?: (() => void) | undefined; disabled: boolean }) {
  return (
    <div className="bf d5 flex shrink-0 flex-col gap-2 pt-3.5">
      <button
        type="button"
        onClick={onStop}
        disabled={disabled}
        aria-describedby="rail-stop-note"
        /* `ghost` is the artboard's own hover (`#F6F6F8`), and `font-[560]`
           its own weight. The Tailwind `hover:` restates the former so the
           button is still right if this is ever mounted without
           `artboard.css`; they set the same colour, so neither can surprise
           the other whichever way the cascade falls. */
        className="ghost flex h-11 w-full items-center justify-center gap-2 rounded-full border border-edge-strong bg-white text-[14px] font-[560] text-ink-deep transition-colors hover:bg-[#F6F6F8] focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:text-muted-300"
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
