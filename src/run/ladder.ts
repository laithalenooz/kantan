/**
 * How a failing run escalates, and when it gives up.
 *
 * Extracted from `src/run.ts` because it is one of only two parts of that file
 * that does not touch the run. Measured rather than assumed: of seven candidate
 * groupings, five reach back into the state machine for six to twenty-one
 * symbols apiece - `park`, `result`, `fail`, `ActiveRun` - and splitting those
 * would buy a smaller file at the cost of a ring of imports. This one and
 * `src/run/session.ts` reach back for nothing.
 *
 * Pure functions over a `Ladder`, so the escalation policy can be reasoned
 * about and tested without spawning anything: the stall streak, the effort
 * rungs, and how much of a test's output a refine turn is given.
 */

import type { Effort } from "../projects"
import type { TestOutcome } from "../testrun"

/** Where the stall detector stands: the level, and the identical signatures
 * seen at it so far. */
export interface Ladder {
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
export function stepLadder(
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
export const STALL_STREAK = 3

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
export const LADDER: readonly Effort[] = ["low", "medium", "high", "xhigh"]

export function nextEffort(current: Effort): Effort | null {
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
export const REFINE_OUTPUT_BYTES = 8000

export function testOutputFor(outcome: TestOutcome): string {
  const both = [outcome.stdout, outcome.stderr].filter((s) => s.trim() !== "").join("\n")
  return both.length <= REFINE_OUTPUT_BYTES ? both : both.slice(-REFINE_OUTPUT_BYTES)
}
