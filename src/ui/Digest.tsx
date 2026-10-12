/**
 * Coming back: the band that answers "does anything need me", and the digest
 * that answers "what happened while I was away".
 *
 * `docs/design/Return.dc.html` is the specification — the calm indigo band at
 * line 49, the digest card and its timeline at 146-216. Read it before
 * changing anything here; it is far more precise than this comment, and every
 * colour, radius and keyframe below is lifted from it.
 *
 * ## Two exports, because they sit in two places
 *
 * `<ReturnBand>` is **full width, between the header and the three columns**,
 * the same slot the orange "needs you" band uses. `<Digest>` is a card in the
 * centre column, above the run record. They are not nested, so they are not
 * one component; both take the same `DigestSubject` so they cannot disagree
 * about what the run is doing.
 *
 * ## "Nothing needs you" is a claim, and the claim is not this file's to make
 *
 * The band's calm reading is a statement about **the whole tree**, and this
 * component can see one run. Another project's task can be parked at a gate
 * while this one runs happily, so `needsYou` is a **count the caller supplies**
 * and `undefined` means nobody counted.
 *
 * The guard, stated the way `CLAUDE.md` asks for:
 *
 * - **The dimension** is the number of tasks waiting on the human, plus this
 *   run's own state.
 * - **Its values** are 0, one or more, not counted, and — from a caller that
 *   got its arithmetic wrong — negative or not a number.
 * - **The costs are not symmetric.** A false "nothing needs you" is the
 *   expensive direction: the user closes the tab and a parked run waits until
 *   they next remember it. A withheld claim costs a glance at the tree. So the
 *   claim is made only from a non-negative integer, it is dropped entirely when
 *   the count is absent or unusable, and **a run that is itself parked on a
 *   human suppresses it even at zero** — whatever the tree says, the run in
 *   front of you needs you.
 * - The matrix is in `test/ui/Digest.test.tsx` under `"nothing needs you"`.
 *
 * ## Exit codes are printed or declared missing. There is no third option
 *
 * DESIGN.md's sixth promise: exit codes printed, never paraphrased. That
 * forbids "looks good", and it equally forbids **inventing** one. An attempt
 * whose outcome nobody read is real — a run the server died inside has a `test`
 * phase record with no `test` record after it, and the attempt now running has
 * no code yet — so `exitCode` is optional on a `tests` entry and its chip says
 * `no exit code recorded`, in the neutral colour, with no tick. `exitReading`
 * is the only place those three cases are decided.
 *
 * A code that is not a finite number is read as "no code". `src/testrun.ts`
 * only ever reports integers (124 for its timeout, 128 + signal for a death by
 * signal, the shell's 127), so a `NaN` can only come from a caller that lost
 * the figure — and `exit NaN` would claim a reading that never happened.
 *
 * ## What this file deliberately does not do
 *
 * - **It does not decide when a run is grinding.** `grinding` is a flag on the
 *   entry. The threshold lives in `src/ui/Tree.tsx` (`isGrinding`) and the
 *   amber notice itself is the right rail's (`src/ui/Sidebar.tsx`'s
 *   `GrindingFlag`, dismissed with "Let it run"). A second notice here would
 *   mean two independent dismissals for one run, so the digest carries only the
 *   inline chip the artboard draws on the attempt row (line 202).
 * - **It does not replay the effort ladder.** `stepLadder` in `src/run.ts` is
 *   the only rule (docs/HANDOFF.md), so the effort an escalation reached
 *   arrives as a string and is printed verbatim — including a value this build
 *   has never heard of.
 * - **It does not compare failures itself beyond equality.** `src/stall.ts`
 *   computes the signature; "same failure" is only said when two consecutive
 *   attempts both carry one and they match. A missing signature is not evidence
 *   of sameness, so it says nothing.
 * - **It owns no clock.** `elapsed` arrives preformatted and `nowMs` is passed
 *   in, as `Gate`'s `askedAt` is. A component that read the clock itself would
 *   show a frozen number for as long as nothing else re-rendered it.
 *
 * ## Motion
 *
 * The list is the designer's Magic UI `Animated List`, staggered on the
 * artboard's `.d1`-`.d9` steps, and the card and band are its `kfade` and
 * `kband`. All three are gated on `prefers-reduced-motion` in JS: when it is
 * set, `initial` and `animate` are not passed at all, which is stronger than
 * overriding a duration. `MotionConfig reducedMotion="user"` in `main.tsx` is
 * necessary and not sufficient — it switches off transforms and leaves opacity
 * and filter running, which is most of a blur fade.
 *
 * An entry animates **once, keyed on its id**. The run stream replays from byte
 * 0 on every connect with no replay-versus-live marker (docs/HANDOFF.md), so
 * the same entries arrive again on every reconnect; a list that staggered on
 * array identity would replay its whole entrance each time. Ids must therefore
 * be deterministic per log record — `${runId}#${recordIndex}` — exactly as
 * `Stream`'s rows are.
 */

import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import { useReducedMotion } from "motion/react"

/* Type-only, and deliberately so: `src/runindex.ts` opens files at module
 * scope, so a value import would drag `node:fs/promises` into the browser
 * bundle. Borrowed rather than restated, so a change to what a run's state can
 * be becomes a compile error here instead of a card that quietly renders as
 * something else. */
import type { RunState } from "../runindex.ts"

/* -------------------------------------------------------------------------- */
/* Props                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The run both the band and the card are talking about.
 *
 * As much of `RunSummary` as either needs, plus the two things a run log does
 * not hold: the project's display name and the task's own sentence, which live
 * in `projects.json` and the feature file.
 */
export interface DigestSubject {
  /** `RunSummary.state` / `TaskStatus.state`, verbatim. */
  state: RunState
  /** `RunHeader.taskRef`, verbatim: the `T<n>` the task is addressed by. */
  taskRef: string
  /** The task's sentence, from the feature file. Absent leaves the ref alone. */
  title?: string
  /** What to call the project: the tree's label, or the basename of
   * `RunHeader.projectPath`. Not the path — the band is one line. */
  project?: string
  /**
   * Which **test** attempt is current.
   *
   * `TestRecord.attempt`, which counts test runs inside this run — **never
   * `TaskStatus.attempts`**, which counts how many runs the task has had.
   * `src/runindex.ts` is explicit that the two are different numbers, and the
   * artboard's "attempt 6" is the first of them.
   */
  attempt?: number
}

/**
 * One row of the timeline. Each variant mirrors a record the run log holds.
 *
 * `id` must be stable and unique for the life of the run: the entrance is keyed
 * on it, and a reused id makes a row that has already appeared animate again.
 * `at` is epoch milliseconds; absent leaves the clock column empty, which is
 * the common case — docs/HANDOFF.md records that `CliRecord` carries no
 * timestamp at all.
 */
export type DigestEntry =
  /** `{"kind":"human","action":"approve"}`. */
  | { id: string; at?: number; kind: "approved" }
  /**
   * The implement phase landed. The counts come from the caller's reading of
   * the edit events; each is omitted rather than guessed.
   */
  | { id: string; at?: number; kind: "implemented"; files?: number; added?: number; removed?: number }
  /**
   * One test run, as `src/testrun.ts` reported it.
   *
   * `exitCode` is optional **because it is sometimes genuinely unknown**: the
   * attempt now running has no code yet, and an interrupted run can hold a
   * test phase whose outcome was never written. `signature` is `src/stall.ts`'s
   * digest, absent when the run passed. `summary` is the runner's own words.
   * `grinding` is the caller's flag, not a threshold this file re-decides.
   */
  | {
      id: string
      at?: number
      kind: "tests"
      attempt?: number
      exitCode?: number
      summary?: string
      signature?: string
      grinding?: boolean
    }
  /** The stall rule raised the effort. `effort` is printed verbatim. */
  | { id: string; at?: number; kind: "escalation"; effort: string; identicalFailures?: number }
  /** What is happening right now. `elapsed` is preformatted; the shell ticks. */
  | { id: string; at?: number; kind: "running"; command?: string; attempt?: number; elapsed?: string }
  /** `EndRecord`: how the run ended, and anything it wants a human to see. */
  | { id: string; at?: number; kind: "ended"; state: "done" | "failed"; why?: string; warnings?: readonly string[] }

export interface ReturnBandProps {
  subject: DigestSubject
  /**
   * How many tasks are waiting on a human, **counted by the caller across the
   * whole tree**. `undefined` means nobody counted, and the claim is withheld
   * rather than guessed. See the file comment for why that direction.
   */
  needsYou?: number
  className?: string
}

export interface DigestProps {
  subject: DigestSubject
  /** Oldest first, as the log reads. */
  entries: readonly DigestEntry[]
  /** See `ReturnBandProps.needsYou`. */
  needsYou?: number
  /** `Date.parse(RunHeader.startedAt)`. The away window starts here when no
   * approval is in `entries`. */
  startedAtMs?: number
  /** The shell's clock, for the away strip. Absent prints neither the
   * duration nor the "now HH:MM" beside it. */
  nowMs?: number
  /** The project's test command, printed verbatim in the footnote: it is what
   * the exit codes above it are the codes of. */
  testCommand?: string
  className?: string
}

/* -------------------------------------------------------------------------- */
/* Motion preference                                                          */
/* -------------------------------------------------------------------------- */

/** The query. Motion asks `(prefers-reduced-motion)`, which means the same. */
const REDUCE_QUERY = "(prefers-reduced-motion: reduce)"

function canAsk(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
}

function subscribeReduce(onChange: () => void): () => void {
  if (!canAsk()) return () => {}
  const query = window.matchMedia(REDUCE_QUERY)
  if (typeof query.addEventListener !== "function") return () => {}
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

function readReduce(): boolean {
  return canAsk() ? window.matchMedia(REDUCE_QUERY).matches : false
}

/**
 * Does this person want less movement? Two sources, OR'd.
 *
 * Motion's `useReducedMotion()` answers from a module-level singleton
 * initialised at the **first call anywhere in the process**, returns `null`
 * until then, and does not update afterwards — probed three times in this repo,
 * once answering `false` with the media feature actually set to `reduce`. So it
 * can hold a stale no, including for someone who turns the setting on while the
 * page is open, which is exactly when a page full of staggered rows is worst.
 *
 * The second source is the media query itself, subscribed to, so the answer is
 * live. A spurious yes costs one entrance nobody asked to stop; a missed yes
 * costs the thing the preference exists to prevent. The OR fails toward the
 * cheap one.
 */
function usePrefersReducedMotion(): boolean {
  const motionsAnswer = useReducedMotion() === true
  const live = useSyncExternalStore(subscribeReduce, readReduce, () => false)
  return motionsAnswer || live
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

/** 24-hour, zero-padded, local. `undefined` for a time that cannot be read. */
export function clockLabel(at: number | undefined): string | undefined {
  if (at === undefined || !Number.isFinite(at)) return undefined
  const when = new Date(at)
  const hours = String(when.getHours()).padStart(2, "0")
  const minutes = String(when.getMinutes()).padStart(2, "0")
  return `${hours}:${minutes}`
}

/**
 * How long you were away, in the artboard's own register ("33 min").
 *
 * `undefined` rather than a negative duration: a clock that went backwards —
 * an NTP step, a caller subtracting the wrong pair — must not print "-5 min" at
 * a human, and saying nothing is the honest reading of a figure this cannot
 * trust.
 */
export function awayLabel(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`
}

/** "once", "twice", then words to five and digits after. */
function times(n: number): string {
  const words = ["no times", "once", "twice", "three times", "four times", "five times"]
  return words[n] ?? `${n} times`
}

/**
 * Small numbers as words, which is the artboard's register for counted things
 * ("Three identical failures", "the third identical failure"). Digits take
 * over where the words stop being easier to read than the number.
 */
const CARDINALS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]
const ORDINALS = ["zeroth", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth"]

function cardinal(n: number): string {
  return CARDINALS[n] ?? `${n}`
}

function ordinal(n: number): string {
  return ORDINALS[n] ?? `${n}th`
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

function fileCount(n: number): string {
  return n === 1 ? "1 file" : `${n} files`
}

/* -------------------------------------------------------------------------- */
/* Exit codes                                                                 */
/* -------------------------------------------------------------------------- */

export interface ExitReading {
  outcome: "pass" | "fail" | "unknown"
  /** What the chip prints. The number, verbatim, or that there is none. */
  text: string
}

/**
 * The three cases, decided once.
 *
 * Zero passed, any other number failed, and **no number at all is its own
 * reading** — not a pass, not a failure, and never dressed as either.
 */
export function exitReading(code: number | undefined): ExitReading {
  if (code === undefined || !Number.isFinite(code)) return { outcome: "unknown", text: "no exit code recorded" }
  return { outcome: code === 0 ? "pass" : "fail", text: `exit ${code}` }
}

/* -------------------------------------------------------------------------- */
/* The nine readings                                                          */
/* -------------------------------------------------------------------------- */

type Glyph = "running" | "attention" | "stalled" | "pass" | "unmerged" | "fail" | "interrupted"

export interface StateReading {
  /** The band's own word for this state, in the tree's vocabulary. */
  label: string
  /** The digest's heading. Only one of the nine is "still going". */
  heading: string
  /** The state's own colour, from the artboards. */
  core: string
  /** The plate the label sits on. */
  tint: string
  /** Readable text on `tint`. */
  ink: string
  /** The band's hairline. `Return.dc.html` gives `#D6D7FA` for the one band it
   * draws; the rest take the state's own colour at a quarter, so no value is
   * invented for a plate the design never showed. */
  border: string
  glyph: Glyph
  /** `state.why`, or where an interrupted run resumes. Printed verbatim. */
  detail?: string
  /**
   * Is a human what this run is waiting for?
   *
   * `waiting(stalled)` counts, even though it is not drawn in the "needs you"
   * colour: it is parked and nothing but a person will move it, so the calm
   * claim must not be made over it. Any wait reason this build does not know
   * folds the same way, because something is parked on a human whatever it is
   * called — the same reading `src/ui/Tree.tsx` takes.
   */
  parked: boolean
}

/** Shared by the states that are neither running nor waiting on a person. */
const CALM_PLATE = { tint: "#F1F1F4", ink: "#3A3D45", border: "#E7E7EB" }
const ATTENTION_PLATE = { tint: "#FFF1E8", ink: "#9A3B06", border: "#FFD2B5" }

export function stateReading(state: RunState): StateReading {
  switch (state.kind) {
    case "running":
      return {
        label: "Running",
        heading: "Still going.",
        core: "#5B5BD6",
        tint: "#E8E9FD",
        ink: "#20205E",
        border: "#D6D7FA",
        glyph: "running",
        parked: false,
      }

    case "waiting": {
      if (state.reason === "stalled") {
        return {
          label: "Stalled",
          heading: "It is stuck on the same failure.",
          core: "#A23B87",
          ...CALM_PLATE,
          ink: "#93307A",
          glyph: "stalled",
          parked: true,
        }
      }
      const waits: Record<"gate" | "question" | "blocked", { label: string; heading: string }> = {
        gate: { label: "Waiting at the gate", heading: "It stopped for your approval." },
        question: { label: "Asked you a question", heading: "It asked you something." },
        blocked: { label: "Blocked", heading: "It stopped and cannot go on without you." },
      }
      /* A reason a newer writer invented folds to the gate's reading rather
       * than to a blank one: something is parked on a human either way, and
       * that is the half that must not be lost. */
      const wait = state.reason === "question" || state.reason === "blocked" ? waits[state.reason] : waits.gate
      return {
        label: wait.label,
        heading: wait.heading,
        core: "#FF6A1A",
        ...ATTENTION_PLATE,
        glyph: "attention",
        parked: true,
      }
    }

    case "done":
      return state.merged
        ? {
            label: "Done",
            heading: "It finished while you were away.",
            core: "#0F8A5F",
            ...CALM_PLATE,
            ink: "#0F7A54",
            glyph: "pass",
            parked: false,
          }
        : {
            label: "Done · unmerged",
            heading: "It finished while you were away. The branch is not merged.",
            core: "#0E7C86",
            ...CALM_PLATE,
            ink: "#0B6C75",
            glyph: "unmerged",
            parked: false,
          }

    case "failed":
      return {
        label: "Failed",
        heading: "It failed while you were away.",
        core: "#D92D3A",
        ...CALM_PLATE,
        ink: "#C4232F",
        glyph: "fail",
        detail: state.why,
        parked: false,
      }

    case "interrupted":
      return {
        label: "Interrupted",
        heading: "The server stopped mid-run.",
        core: "#556274",
        ...CALM_PLATE,
        ink: "#556274",
        glyph: "interrupted",
        detail: `resumes from ${state.resumeFrom}`,
        parked: false,
      }
  }
}

/**
 * The claim, or nothing.
 *
 * See the file comment for the guard this implements. Note what it refuses: a
 * fractional or negative count, which is a caller that lost its arithmetic, and
 * zero over a run that is parked on a human.
 */
function needsYouClaim(needsYou: number | undefined, parked: boolean): string | undefined {
  if (needsYou === undefined || !Number.isInteger(needsYou) || needsYou < 0) return undefined
  if (needsYou === 0) return parked ? undefined : "Nothing needs you"
  return needsYou === 1 ? "1 task needs you" : `${needsYou} tasks need you`
}

/* -------------------------------------------------------------------------- */
/* The paragraph                                                              */
/* -------------------------------------------------------------------------- */

/**
 * What happened, from counts rather than from a judgment.
 *
 * Every sentence here is arithmetic over the entries plus the run's own state.
 * Nothing in it can claim a pass that no exit code backs, and attempts whose
 * code was never read are **named as a third group** instead of being counted
 * as either — they are the one case where silence would read as success.
 */
export function digestProse(entries: readonly DigestEntry[], state: RunState): string {
  if (entries.length === 0) return "Nothing is recorded for this run yet."

  let passed = 0
  let failed = 0
  let unread = 0
  let escalation: Extract<DigestEntry, { kind: "escalation" }> | undefined

  for (const entry of entries) {
    if (entry.kind === "escalation") escalation = entry
    if (entry.kind !== "tests") continue
    const outcome = exitReading(entry.exitCode).outcome
    if (outcome === "pass") passed += 1
    else if (outcome === "fail") failed += 1
    else unread += 1
  }

  const sentences: string[] = []
  if (failed > 0) sentences.push(`Tests failed ${times(failed)}.`)
  if (passed > 0) sentences.push(`Tests passed ${times(passed)}.`)
  if (unread > 0) {
    sentences.push(
      unread === 1
        ? "One attempt has no exit code recorded, so it counts as neither."
        : `${unread} attempts have no exit code recorded, so they count as neither.`,
    )
  }
  if (failed === 0 && passed === 0 && unread === 0) sentences.push("The tests have not run yet.")

  if (escalation !== undefined) {
    const after =
      escalation.identicalFailures === undefined
        ? ""
        : `After the ${ordinal(escalation.identicalFailures)} identical failure, `
    sentences.push(`${after}kantan raised the effort level to ${escalation.effort}.`)
  }

  const reading = stateReading(state)
  switch (state.kind) {
    case "running":
      sentences.push(
        failed > 0
          ? "It is still running. You can let it run, or look at the failure below."
          : "It is still running, and nothing is blocked.",
      )
      break
    case "waiting":
      sentences.push(`${reading.heading} Nothing moves until you answer.`)
      break
    case "done":
      sentences.push(reading.heading)
      break
    case "failed":
      /* Quoted, not run on. The reason is the writer's own prose and starts
       * however it starts — a screenshot of this caught "It failed while you
       * were away. the agent answered ORCH: blocked no writable branch", which
       * reads as a broken sentence. Quoting keeps it verbatim and says whose
       * words they are. */
      sentences.push(state.why === undefined ? reading.heading : `${reading.heading} The log records: “${state.why}”`)
      break
    case "interrupted":
      sentences.push(`${reading.heading} It ${reading.detail ?? "can be resumed"}.`)
      break
  }

  return sentences.join(" ")
}

/**
 * Which attempts repeated the one before them.
 *
 * Keyed by entry id. Only present where **both** consecutive attempts carry a
 * signature: `src/stall.ts` is what computes one, it is absent on a pass, and
 * a missing signature is not evidence of sameness. "Same failure" is the phrase
 * that tells a human to stop reading, so it is the one that has to be earned.
 */
function failureComparisons(entries: readonly DigestEntry[]): Map<string, "same" | "different"> {
  const out = new Map<string, "same" | "different">()
  let previous: string | undefined
  for (const entry of entries) {
    if (entry.kind !== "tests") continue
    const signature = entry.signature
    if (previous !== undefined && signature !== undefined) {
      out.set(entry.id, signature === previous ? "same" : "different")
    }
    previous = signature
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* Icons. Lucide shapes, as the artboards draw them.                          */
/* -------------------------------------------------------------------------- */

const STROKE = "fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:2]"

function Clock({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={`${STROKE} ${className ?? "size-[15px] shrink-0"}`}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  )
}

function Check({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={`${STROKE} ${className ?? "size-[15px] shrink-0"}`}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

function Cross({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={`${STROKE} ${className ?? "size-[15px] shrink-0"}`}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

function Pencil({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={`${STROKE} ${className ?? "size-[15px] shrink-0"}`}>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <path d="m15 5 4 4" />
    </svg>
  )
}

function ArrowUp({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={`${STROKE} ${className ?? "size-[15px] shrink-0"}`}>
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </svg>
  )
}

/** The retry arrows the artboard uses for grinding, and for a refine round. */
function Repeat({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={`${STROKE} ${className ?? "size-[15px] shrink-0"}`}>
      <path d="m17 2 4 4-4 4" />
      <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
      <path d="m7 22-4-4 4-4" />
      <path d="M21 13v1a4 4 0 0 1-4 4H3" />
    </svg>
  )
}

function Shield({ checked, className }: { checked: boolean; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      data-glyph={checked ? "shield-check" : "shield"}
      viewBox="0 0 24 24"
      className={`${STROKE} ${className ?? "size-3 shrink-0"}`}
    >
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      {checked ? <path d="m9 12 2 2 4-4" /> : null}
    </svg>
  )
}

/**
 * The three keyframes this region needs, which `tokens.css` does not carry.
 *
 * CSS rather than Motion components, and that is a measured decision rather
 * than a style one. Motion animates opacity, transform and filter through the
 * Web Animations API; **cancelling such an animation rejects its `finished`
 * promise**, nothing in `motion-dom` catches that rejection, and happy-dom
 * creates the promise eagerly — so every animation still in flight when a tree
 * unmounts or re-renders became an unhandled `AbortError`. One run of
 * `test/ui/Digest.test.tsx` produced 195 of them, reported as errors between
 * tests, and they took unrelated tests down with them. A log that appends while
 * the opening stagger is still playing is the same case in a browser.
 *
 * Declarative animations have nothing to cancel and nothing to reject, and
 * these are exactly the keyframes `Return.dc.html` itself uses (`kfade`,
 * `kband`, `kspin`). `src/ui/Gate.tsx` already carries a scoped stylesheet and
 * `src/ui/Tree.tsx` carries its two glyph keyframes the same way, so this is
 * the house's second pattern rather than a new one.
 *
 * Rendered by both roots below, so a spinner in either is covered. The
 * reduced-motion guard is repeated here rather than left to `tokens.css`, so
 * the component is correct on its own — and it is only the second line of
 * defence: `usePrefersReducedMotion` withholds the class in the first place.
 */
const DIGEST_CSS = `
@keyframes kantan-digest-fade{from{opacity:0;transform:translateY(10px);filter:blur(6px)}to{opacity:1;transform:none;filter:blur(0)}}
@keyframes kantan-digest-band{from{opacity:0;transform:translateY(-100%)}to{opacity:1;transform:none}}
@keyframes kantan-digest-spin{to{transform:rotate(360deg)}}
.kantan-digest-fade{animation:kantan-digest-fade .7s cubic-bezier(.2,.7,.2,1) both}
.kantan-digest-band{animation:kantan-digest-band .5s cubic-bezier(.2,.7,.2,1) both}
.kantan-digest-spin{animation:kantan-digest-spin .9s linear infinite;transform-origin:50% 50%}
@media (prefers-reduced-motion:reduce){
  .kantan-digest-fade,.kantan-digest-band,.kantan-digest-spin{animation:none}
}
`

/** The class that plays `kfade`, or nothing at all. */
const FADE_CLASS = "kantan-digest-fade"

/**
 * The run's spinning arc, which is the only thing on this screen that spins.
 *
 * The animating class is dropped entirely under a reduced-motion preference —
 * the shape still says "running", which is the design's rule that the glyph
 * carries the meaning and colour and motion only back it up.
 */
function Spinner({ reduced, className }: { reduced: boolean; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      data-glyph="running"
      data-motion={reduced ? "static" : "animated"}
      viewBox="0 0 24 24"
      className={`${className ?? "size-4 shrink-0"} ${reduced ? "" : "kantan-digest-spin"}`}
    >
      <circle cx="12" cy="12" r="9" fill="none" stroke="#DCDCF6" strokeWidth={3} />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="#5B5BD6" strokeWidth={3} strokeLinecap="round" />
    </svg>
  )
}

const MONO = "font-mono"

/* -------------------------------------------------------------------------- */
/* Chips                                                                      */
/* -------------------------------------------------------------------------- */

const EXIT_CHIP: Record<ExitReading["outcome"], string> = {
  pass: "bg-[#E3F5EC] text-[#0B5A3E]",
  fail: "bg-[#FDECEE] text-[#A61B27]",
  /* Neutral on purpose: no green, no red, nothing that reads as an outcome. */
  unknown: "bg-[#F1F1F4] text-[#5F6370]",
}

/**
 * The number, in mono, always — or the fact that there is none.
 *
 * The shield says who read it; the digits say what it was. A chip with no
 * digits carries no tick, because a tick with no number is the paraphrase the
 * design forbids.
 */
function ExitChip({ code }: { code: number | undefined }) {
  const reading = exitReading(code)
  return (
    <span
      data-testid="exit-chip"
      data-exit={reading.outcome}
      className={`inline-flex items-center gap-[5px] rounded-full px-2 py-[3px] ${MONO} text-xs font-semibold ${EXIT_CHIP[reading.outcome]}`}
    >
      <Shield checked={reading.outcome === "pass"} />
      {reading.text}
    </span>
  )
}

/** Amber, inline, and a chip rather than a notice: the rail owns the notice. */
function GrindingChip() {
  return (
    <span
      data-testid="grinding-chip"
      className="inline-flex items-center gap-1 rounded-full bg-[#FEF3C7] px-2 py-[2px] text-xs font-[620] text-[#8A4B0A]"
    >
      <Repeat className="size-[11px] shrink-0 [stroke-width:2.5]" />
      grinding
    </span>
  )
}

/* -------------------------------------------------------------------------- */
/* The band                                                                   */
/* -------------------------------------------------------------------------- */

/** `kband`: it slides down from above, once. */
const BAND_CLASS = "kantan-digest-band"

/** The subject line, as one string's worth of parts the band can wrap. */
function subjectParts(subject: DigestSubject): string[] {
  const parts: string[] = []
  if (subject.project !== undefined && subject.project !== "") parts.push(subject.project)
  parts.push(subject.title === undefined || subject.title === "" ? subject.taskRef : `${subject.taskRef} ${subject.title}`)
  if (subject.attempt !== undefined && Number.isFinite(subject.attempt)) parts.push(`attempt ${subject.attempt}`)
  return parts
}

function BandGlyph({ reading, reduced }: { reading: StateReading; reduced: boolean }) {
  if (reading.glyph === "running") return <Spinner reduced={reduced} className="size-[22px] shrink-0" />
  if (reading.glyph === "pass" || reading.glyph === "unmerged") {
    return (
      <span
        aria-hidden="true"
        className="grid size-[22px] shrink-0 place-items-center rounded-full text-white"
        style={{ background: reading.core }}
      >
        <Check className="size-3 [stroke-width:4]" />
      </span>
    )
  }
  if (reading.glyph === "fail") {
    return (
      <span
        aria-hidden="true"
        className="grid size-[22px] shrink-0 place-items-center rounded-full text-white"
        style={{ background: reading.core }}
      >
        <Cross className="size-[11px] [stroke-width:4]" />
      </span>
    )
  }
  if (reading.glyph === "stalled") {
    /* The paused bars inside a dashed ring, from States.dc.html. Stuck, not
     * broken: no cross and no red. */
    return (
      <span
        aria-hidden="true"
        className="box-border grid size-[22px] shrink-0 place-items-center rounded-full border-[1.5px] border-dashed"
        style={{ borderColor: reading.core }}
      >
        <svg viewBox="0 0 24 24" className="size-[10px]" fill={reading.core}>
          <rect x="5" y="3" width="5" height="18" rx="1.5" />
          <rect x="14" y="3" width="5" height="18" rx="1.5" />
        </svg>
      </span>
    )
  }
  if (reading.glyph === "attention") {
    /* A solid disc, and deliberately not the pulsing one: the pulse belongs to
     * the orange "needs you" band, which is its own component. */
    return <span aria-hidden="true" className="size-[18px] shrink-0 rounded-full" style={{ background: reading.core }} />
  }
  return (
    <span
      aria-hidden="true"
      className="box-border size-[18px] shrink-0 rounded-full border-[2px]"
      style={{ borderColor: reading.core }}
    />
  )
}

/**
 * The top band, in the slot the orange "needs you" band uses.
 *
 * `role="status"`, never a dialog: nothing is trapped, nothing is disabled
 * behind it, and it carries no action.
 *
 * It deliberately does **not** set `document.title` or the favicon. DESIGN.md
 * hangs both off the *attention* band, and both are properties of the page
 * rather than of this strip — a second writer would fight whoever owns them.
 */
export function ReturnBand({ subject, needsYou, className }: ReturnBandProps) {
  const reduced = usePrefersReducedMotion()
  const reading = stateReading(subject.state)
  const claim = needsYouClaim(needsYou, reading.parked)

  return (
    <div
      role="status"
      data-testid="return-band"
      data-state={subject.state.kind}
      data-motion={reduced ? "static" : "animated"}
      className={[
        "flex flex-wrap items-center gap-x-5 gap-y-2.5 border-b px-6 py-[18px]",
        reduced ? "" : BAND_CLASS,
        className ?? "",
      ].join(" ")}
      style={{ background: reading.tint, color: reading.ink, borderBottomColor: reading.border }}
    >
      <style>{DIGEST_CSS}</style>
      <BandGlyph reading={reading} reduced={reduced} />

      <span className="text-[28px] leading-none font-bold tracking-[-.025em]">{reading.label}</span>

      <span data-testid="band-subject" className="min-w-0 text-base font-medium [overflow-wrap:anywhere]">
        {subjectParts(subject).join(" · ")}
      </span>

      {reading.detail === undefined ? null : (
        <span className={`min-w-0 text-[13.5px] ${MONO} [overflow-wrap:anywhere] opacity-80`}>{reading.detail}</span>
      )}

      {claim === undefined ? null : (
        <span data-testid="band-claim" className="ml-auto inline-flex items-center gap-2 text-base font-semibold">
          {needsYou === 0 ? (
            <Check className="size-[18px] shrink-0 [stroke-width:2.5]" />
          ) : (
            <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full bg-[#FF6A1A]" />
          )}
          {claim}
        </span>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* The timeline                                                               */
/* -------------------------------------------------------------------------- */


/** The longest stagger. `Return.dc.html` stops at `.d10`. */
const MAX_STAGGER = 9

/** Seconds between two entries, matching the artboard's `.d*` steps. */
const STAGGER_STEP = 0.05


function EntryGlyph({ entry, reduced, live }: { entry: DigestEntry; reduced: boolean; live: boolean }) {
  switch (entry.kind) {
    case "approved":
      return (
        <span aria-hidden="true" className="grid size-[18px] place-items-center rounded-full bg-ink text-white">
          <Check className="size-2.5 [stroke-width:4]" />
        </span>
      )
    case "implemented":
      return (
        <span aria-hidden="true" className="grid size-[18px] place-items-center rounded-full bg-[#EEEEFD] text-indigo-deep">
          <Pencil className="size-2.5 [stroke-width:2.5]" />
        </span>
      )
    case "escalation":
      return (
        <span aria-hidden="true" className="grid size-[18px] place-items-center rounded-md bg-indigo text-white">
          <ArrowUp className="size-[11px] [stroke-width:3]" />
        </span>
      )
    case "running":
      /* It only spins while it really is running. A row left behind by a run
       * that has since failed or been interrupted keeps the shape — the design
       * asks the shape to carry the meaning — but a spinning arc on a dead run
       * is the one reading that would be a lie. */
      return <Spinner reduced={reduced || !live} />
    case "tests":
    case "ended": {
      const outcome =
        entry.kind === "ended"
          ? entry.state === "done"
            ? "pass"
            : "fail"
          : exitReading(entry.exitCode).outcome
      if (outcome === "pass") {
        return (
          <span aria-hidden="true" className="grid size-4 place-items-center justify-self-center rounded-full bg-pass text-white">
            <Check className="size-2.5 [stroke-width:4]" />
          </span>
        )
      }
      if (outcome === "fail") {
        return (
          <span aria-hidden="true" className="grid size-4 place-items-center justify-self-center rounded-full bg-fail text-white">
            <Cross className="size-[9px] [stroke-width:4]" />
          </span>
        )
      }
      /* No code was read, so the mark says "not known" in greyscale: a dashed
       * hollow ring, which is neither the tick nor the cross. */
      return (
        <span
          aria-hidden="true"
          data-glyph="unknown"
          className="box-border size-4 justify-self-center rounded-full border-[1.5px] border-dashed border-muted-300"
        />
      )
    }
  }
}

function EntryBody({ entry, comparison }: { entry: DigestEntry; comparison: "same" | "different" | undefined }) {
  switch (entry.kind) {
    case "approved":
      return <span className="text-[14.5px]">You approved the plan</span>

    case "implemented":
      return (
        <span className="text-[14.5px]">
          Implemented the plan
          {entry.files === undefined ? null : <> · {fileCount(entry.files)}</>}
        </span>
      )

    case "escalation":
      return (
        <span className="text-[14.5px] font-[560] text-[#20205E]">
          {entry.identicalFailures === undefined
            ? `Effort was raised to ${entry.effort}`
            : entry.identicalFailures === 1
              ? `One identical failure, so effort was raised to ${entry.effort}`
              : `${capitalise(cardinal(entry.identicalFailures))} identical failures, so effort was raised to ${entry.effort}`}
        </span>
      )

    case "running":
      return (
        <span className="text-[14.5px] font-[560]">
          {entry.attempt === undefined ? "Running" : `Attempt ${entry.attempt} · running`}
          {entry.command === undefined ? null : <span className={`${MONO} text-[13px] font-medium`}> {entry.command}</span>}
        </span>
      )

    case "ended":
      return (
        <span className="flex min-w-0 flex-col gap-1 text-[14.5px]">
          <span>{entry.state === "done" ? "The run finished" : "The run failed"}</span>
          {entry.why === undefined ? null : (
            <span className="text-[13.5px] text-muted-700 [overflow-wrap:anywhere]">{entry.why}</span>
          )}
          {entry.warnings === undefined || entry.warnings.length === 0
            ? null
            : entry.warnings.map((warning) => (
                <span key={warning} className="text-[13.5px] text-[#8A4B0A] [overflow-wrap:anywhere]">
                  {warning}
                </span>
              ))}
        </span>
      )

    case "tests": {
      /* One span for the sentence, so the separators are the only spacing in
       * it — a flex gap between the parts reads as a double space, which the
       * artboard does not have. The chip is the only sibling, and the gap is
       * for it. */
      const said = entry.attempt === undefined ? false : true
      return (
        <span className="flex min-w-0 flex-wrap items-center gap-2 text-[14.5px]">
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {said ? `Attempt ${entry.attempt}` : null}
            {entry.summary === undefined ? null : `${said ? " · " : ""}${entry.summary}`}
            {comparison === undefined ? null : (
              <span className="text-muted-500">
                {said || entry.summary !== undefined ? " · " : ""}
                {comparison === "same" ? "same failure" : "a different failure"}
              </span>
            )}
          </span>
          {entry.grinding === true ? <GrindingChip /> : null}
        </span>
      )
    }
  }
}

function EntryTrailing({ entry }: { entry: DigestEntry }) {
  switch (entry.kind) {
    case "implemented":
      if (entry.added === undefined && entry.removed === undefined) return null
      return (
        <span className={`${MONO} text-xs`}>
          {entry.added === undefined ? null : <span className="font-semibold text-pass-deep">+{entry.added}</span>}
          {entry.added !== undefined && entry.removed !== undefined ? " " : null}
          {entry.removed === undefined ? null : <span className="font-semibold text-[#C4232F]">−{entry.removed}</span>}
        </span>
      )
    case "escalation":
      return (
        <span className={`rounded-full bg-indigo px-2 py-[3px] ${MONO} text-xs font-semibold text-white`}>
          effort: {entry.effort}
        </span>
      )
    case "tests":
      return <ExitChip code={entry.exitCode} />
    case "running":
      return entry.elapsed === undefined ? null : (
        <span className={`${MONO} text-[12.5px] font-semibold text-indigo-deep [font-variant-numeric:tabular-nums]`}>
          {entry.elapsed}
        </span>
      )
    case "approved":
    case "ended":
      return null
  }
}

/* -------------------------------------------------------------------------- */
/* The digest                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * What happened while you were away.
 *
 * The card arrives as one blur fade and the timeline staggers behind it, which
 * is what the artboard draws (`bf` on the section, `bf d1`-`d9` on the items).
 * Unlike `Stream`, this list is a dozen rows rather than thousands, and it is
 * the first thing read on returning to the tab — so the stagger is the opening
 * movement rather than a per-row arrival, and it plays once per id.
 */
export function Digest({
  subject,
  entries,
  needsYou,
  startedAtMs,
  nowMs,
  testCommand,
  className,
}: DigestProps) {
  const headingId = useId()
  const reduced = usePrefersReducedMotion()
  const reading = stateReading(subject.state)

  /* Empty at mount, because the opening list is meant to stagger in. Absorbed
   * after the commit that drew it, so a replay of the same ids is quiet.
   * Writing it during render would make StrictMode's second pass disagree with
   * its first and decide a row was old before it had ever appeared. */
  const [seen] = useState<Set<string>>(() => new Set<string>())
  const absorbed = useRef<readonly DigestEntry[] | null>(null)
  useEffect(() => {
    if (absorbed.current === entries) return
    absorbed.current = entries
    for (const entry of entries) seen.add(entry.id)
  })

  const comparisons = failureComparisons(entries)

  const approvedAt = entries.find((entry) => entry.kind === "approved")?.at
  const from = clockLabel(approvedAt) === undefined ? startedAtMs : approvedAt
  const away = nowMs === undefined || from === undefined ? undefined : awayLabel(nowMs - from)
  const approvedClock = clockLabel(approvedAt)
  const nowClock = clockLabel(nowMs)
  const strip = [
    away,
    approvedClock === undefined ? undefined : `approved ${approvedClock}`,
    nowClock === undefined ? undefined : `now ${nowClock}`,
  ].filter((part): part is string => part !== undefined)

  const claim = needsYouClaim(needsYou, reading.parked)
  const heading =
    subject.state.kind === "running" && claim === "Nothing needs you" ? `${reading.heading} ${claim}.` : reading.heading

  let staggered = 0

  return (
    <section
      aria-labelledby={headingId}
      data-testid="digest"
      data-motion={reduced ? "static" : "animated"}
      className={[
        "overflow-clip rounded-[24px] border border-edge bg-white",
        "shadow-[0_1px_2px_rgba(17,18,22,.04),0_18px_50px_-22px_rgba(17,18,22,.2)]",
        reduced ? "" : FADE_CLASS,
        className ?? "",
      ].join(" ")}
    >
      <style>{DIGEST_CSS}</style>
      <div className="bg-gradient-to-b from-[#F5F5FF] to-white/0 px-[clamp(20px,4vw,44px)] pt-[30px] pb-6">
        <div className="mb-3.5 flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-muted-700">
          <Clock className="size-[15px] shrink-0 text-indigo-deep" />
          <span className="font-[620] text-[#2E2E8A]">While you were away</span>
          {/* `Return.dc.html` draws the running card, and its eyebrow carries
            * no state chip: the heading says "Still going" and the band above
            * says the rest. The other eight states have no artboard and no
            * heading that names them as plainly, so they get the chip. */}
          {subject.state.kind === "running" ? null : (
            <span
              data-testid="digest-state"
              data-state={subject.state.kind}
              className="rounded-full px-2 py-[2px] text-[11.5px] font-[620]"
              style={{ background: reading.tint, color: reading.ink }}
            >
              {reading.label}
            </span>
          )}
          {strip.length === 0 ? null : (
            <span data-testid="digest-away" className={`${MONO} text-xs`}>
              {strip.join(" · ")}
            </span>
          )}
        </div>

        <h1
          id={headingId}
          data-testid="digest-heading"
          className="m-0 text-[clamp(30px,3.6vw,42px)] leading-[1.08] font-[650] tracking-[-.035em]"
        >
          {heading}
        </h1>

        <p
          data-testid="digest-prose"
          className="mt-3 mb-0 max-w-[62ch] text-[15.5px] leading-[1.6] text-muted-700 [overflow-wrap:anywhere]"
        >
          {digestProse(entries, subject.state)}
        </p>
      </div>

      {entries.length === 0 ? null : (
        <ol
          data-testid="digest-timeline"
          className="relative m-0 list-none px-[clamp(20px,4vw,44px)] pt-1.5 pb-2.5"
        >
          {entries.map((entry, index) => {
            const isNew = !seen.has(entry.id) && !reduced
            const delay = isNew ? Math.min(staggered++, MAX_STAGGER) * STAGGER_STEP : 0
            const highlighted = entry.kind === "escalation"
            /* Is this row happening, or is it the record of what the run was
             * doing when it stopped? Only the run's own state can say. */
            const live = entry.kind === "running" && subject.state.kind === "running"


            return (
              <li
                key={entry.id}
                data-digest-entry
                data-kind={entry.kind}
                data-motion={isNew ? "animated" : "static"}
                className={[
                  "grid grid-cols-[48px_20px_minmax(0,1fr)_auto] gap-3 py-[9px]",
                  /* The artboard centres its rows, which is right for the one
                   * line they all hold there. An `ended` row carries a reason
                   * and any number of warnings, and centring a three-line body
                   * against its clock leaves the time floating in the middle of
                   * it — visible in the screenshot, invisible to every
                   * assertion. */
                  entry.kind === "ended" ? "items-start" : "items-center",
                  highlighted ? "-mx-3 my-0.5 rounded-xl bg-[#F3F3FE] px-3 py-2.5" : "",
                  index > 0 && !highlighted ? "border-t border-[#F0F0F3]" : "",
                  /* The stagger, and the only thing that makes an entry move.
                   * An entry already seen carries neither the class nor the
                   * delay, so it cannot animate however often it re-renders. */
                  isNew ? FADE_CLASS : "",
                ].join(" ")}
                style={isNew ? { animationDelay: `${delay}s` } : undefined}
              >
                <span
                  className={[
                    MONO,
                    "text-xs",
                    live ? "font-semibold" : "",
                    live || highlighted ? "text-indigo-deep" : "text-muted-400",
                  ].join(" ")}
                >
                  {/* The artboard writes "now" against the attempt in flight.
                   * Only when the run really is running, though: a `running`
                   * row under a run that has since failed or been interrupted
                   * is a record of what it was doing when it stopped, and
                   * "now" would claim a live attempt that is not. */}
                  {live ? "now" : (clockLabel(entry.at) ?? "")}
                </span>
                <EntryGlyph entry={entry} reduced={reduced} live={live} />
                <EntryBody entry={entry} comparison={comparisons.get(entry.id)} />
                <EntryTrailing entry={entry} />
              </li>
            )
          })}
        </ol>
      )}

      <Footnote testCommand={testCommand} />
    </section>
  )
}

/**
 * The sentence the whole product rests on.
 *
 * The server runs the tests and branches on the exit code; what the agent says
 * about its own work is never used. It is printed under the timeline because
 * that is where someone decides whether to believe the row above it.
 */
function Footnote({ testCommand }: { testCommand: string | undefined }): ReactNode {
  return (
    <div
      data-testid="digest-footnote"
      className="mx-[clamp(20px,4vw,44px)] mb-6 flex items-start gap-2.5 rounded-[14px] bg-[#F6F6F8] px-3.5 py-3 text-[13.5px] leading-[1.5] text-muted-900"
    >
      <Shield checked className="mt-[1px] size-[15px] shrink-0 text-pass-deep" />
      <span>
        {testCommand === undefined || testCommand === "" ? (
          <>Each pass or fail above is an exit code, read by kantan itself.</>
        ) : (
          <>
            Each pass or fail above is the exit code of <span className={`${MONO} text-[12.5px]`}>{testCommand}</span>,
            read by kantan itself.
          </>
        )}{" "}
        What the agent says about its own work is never used.
      </span>
    </div>
  )
}
