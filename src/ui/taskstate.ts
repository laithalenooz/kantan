/**
 * What state a task is in, and what a project of them amounts to.
 *
 * The **one** reading of a task, which is why it is out here rather than
 * inside the component that draws it. `taskStateOf` maps a markdown checkbox
 * and a `RunState` to the nine words every surface uses, and `canStart` and
 * `canResume` answer which of those nine allow an action - so a caller cannot
 * offer a start on a state the machine would refuse.
 *
 * `projectSummary` counts what `taskStateOf` says rather than re-deciding, so
 * the figures in the panel cannot drift from the rows in the tree. Its spend is
 * a **floor** and says so: its parts are floors, and it is the one number a
 * human might budget against.
 *
 * No React here. The mapping is a guess about input in `CLAUDE.md`'s sense, so
 * its enumeration is tested directly rather than through a rendered row.
 */

import { verificationOf } from "../runstate.ts"
import type { RunState } from "../runstate.ts"
import type { TreeFeature, TreeProject, TreeTask } from "./Tree.tsx"

/**
 * Past roughly five attempts, a run is flagged as grinding (design §3.4).
 *
 * The flag reads one dimension, `testAttempts`, whose values are: absent, a
 * count, zero, a negative, a non-integer, and a non-finite number. Only an
 * integer above this threshold flags, so every other value reads as plain
 * running. That is the cheap direction: a notice shown too eagerly - or a chip
 * reading `×6.5` - teaches the reader to ignore it, which is the failure the
 * design's own rate-limit-banner note warns about, while a notice withheld
 * costs nothing, since grinding blocks nothing and the cost is on screen in
 * the right rail.
 */
export const GRINDING_AFTER = 5

/** The nine readings, in the artboard's order. */
export const TASK_STATES = [
  "open",
  "running",
  "needs-you",
  "passed",
  "failed",
  "stalled",
  "done-unmerged",
  "interrupted",
  "grinding",
] as const

export type TaskState = (typeof TASK_STATES)[number]

export function isGrinding(testAttempts: number | undefined): boolean {
  return testAttempts !== undefined && Number.isInteger(testAttempts) && testAttempts > GRINDING_AFTER
}

/**
 * Which of the nine a task reads as.
 *
 * The run log outranks the checkbox, because on `done` the checkout returns to
 * base and the tick lives on the task branch (design §3.6) - so a ticked box
 * with no run is a task that passed and was merged, while a ticked box with a
 * newer run is the run's business.
 *
 * Two readings are judgments rather than lookups:
 *
 * - **`waiting(blocked)` is `needs you`, not `failed`.** `src/run.ts` parks a
 *   blocked run (`park(run, phase, "blocked", reason)`) and `answer()` accepts
 *   `question` and `blocked` alike, so the run is alive and waiting on a
 *   human. Reading it as failed would hide a run that only a reply can move.
 *   Any wait reason this build does not know folds the same way, since
 *   something is parked on a human whatever it is called.
 * - **`done` with `merged: false` is its own calm end state**, not an error. It
 *   is permanent for anyone who squash-merges, because the check reports
 *   ancestry (HANDOFF, Task 13).
 */
export function taskStateOf(task: TreeTask): TaskState {
  const run = task.run
  if (!run) return task.done ? "passed" : "open"
  const state = run.state
  switch (state.kind) {
    case "running":
      return isGrinding(run.testAttempts) ? "grinding" : "running"
    case "waiting":
      return state.reason === "stalled" ? "stalled" : "needs-you"
    case "done":
      return state.merged ? "passed" : "done-unmerged"
    case "failed":
      return "failed"
    case "interrupted":
      return "interrupted"
  }
}

/**
 * Whether a fresh run can be started on this task.
 *
 * Only an `open` task with a ref. Everything else is a run that has already
 * happened or is happening: `done-unmerged` and `passed` are finished,
 * `failed` and `interrupted` own a branch that `createTaskBranch` refuses to
 * create twice, and `running`, `needs-you`, `stalled` and `grinding` are a
 * live run whose next move is a human's reply, not a second run.
 *
 * Fails toward refusing, deliberately: a start that should not have been
 * offered puts a second run against work that is written and not integrated,
 * where a start withheld costs one explicit `git branch -D` the refusal
 * message already names.
 *
 * This mirrors `startRun`, which refuses `branch-exists` when
 * `createTaskBranch` finds the task's branch, rather than replacing it. The
 * server stays the authority: whether a branch still exists is not in
 * `TaskStatus`, so a task whose branch a human has since deleted reads as
 * `failed` here and would in fact start. A caller wanting to offer that retry
 * has to ask git, not this function.
 */
export function canStart(task: TreeTask): boolean {
  return taskStateOf(task) === "open" && task.ref !== null
}

/** Whether the run can be picked up where it stopped. `interrupted` only: the
 * server died, the session is intact, and resuming carries on from the last
 * event. Not a failure, and not a fresh start. */
export function canResume(task: TreeTask): boolean {
  return taskStateOf(task) === "interrupted"
}

/**
 * The first task a keystroke can land on, or `null` when none can.
 *
 * A line with no ref is skipped, because `src/run.ts` refuses it rather than
 * inventing a ref, so it is text rather than a control - and the tab stop has
 * to be something that can be activated.
 */
/**
 * What a project amounts to, counted from the tree the page already has.
 *
 * Derived rather than fetched, deliberately: every figure here is already on
 * the wire, so a summary endpoint would be a second reading of the same bytes
 * and a second thing to keep in step with `taskStateOf`.
 *
 * `spentUsd` is a **floor and says so**, because its parts are. `RunSummary`
 * in `src/runindex.ts` uses the largest `total_cost_usd` it actually read for
 * a run with no `end` record, and cost resets per process - so one unfinished
 * run already under-reports, and a sum of them under-reports further.
 * Presenting that as a total would be the one number in this panel a human
 * might budget against.
 *
 * `verified` exists because of the project's spine rule: nothing may claim a
 * verification it did not observe. A summary saying "6 done" where two were
 * self-checked and one came from a log older than the field would be exactly
 * the over-claim `verificationOf` was written to prevent, so the three are
 * counted apart and `unknown` is never folded into either.
 */
export interface ProjectSummary {
  taskFiles: number
  tasks: number
  /** Ticked in the markdown, whatever any run says. */
  done: number
  byState: Readonly<Record<TaskState, number>>
  /** Tasks with a run of any kind in the index. */
  everRun: number
  /** A floor, never a total. See above. */
  spentUsd: number
  verified: { testCommand: number; selfCheck: number; unknown: number }
}

/**
 * The costs a tree carries, keyed as `src/runindex.ts` keys them.
 *
 * A structural type rather than `RunRef` from `src/ui/live.ts`: this module is
 * imported by that one, and the figure is the only field a summary reads.
 */
export type RunCosts = Readonly<Record<string, { costUsd: number }>>

export function projectSummary(project: TreeProject, runs: RunCosts = {}): ProjectSummary {
  const byState: Record<TaskState, number> = {
    open: 0,
    running: 0,
    "needs-you": 0,
    passed: 0,
    failed: 0,
    stalled: 0,
    "done-unmerged": 0,
    interrupted: 0,
    grinding: 0,
  }
  const verified = { testCommand: 0, selfCheck: 0, unknown: 0 }
  let tasks = 0
  let done = 0
  let everRun = 0
  let spentUsd = 0

  for (const feature of project.features) {
    for (const task of feature.tasks) {
      tasks += 1
      if (task.done) done += 1
      byState[taskStateOf(task)] += 1
      if (task.run === undefined) continue
      everRun += 1
      /* Only a run that *ended done* has a verification to report, which is
         what `verificationOf` enforces - so the three counts here add up to
         the tasks that finished, not to `everRun`. */
      if (task.run.state.kind === "done") {
        const reading = verificationOf(task.run.state)
        if (reading === "test-command") verified.testCommand += 1
        else if (reading === "self-check") verified.selfCheck += 1
        else verified.unknown += 1
      }
      if (task.ref === null) continue
      /* The same NUL join `taskKeyOf` in `src/ui/live.ts` and `taskKey` in
         `src/runindex.ts` use. Spelled here rather than imported because
         `runindex` is a **value** import that reaches `node:fs/promises` and
         poisons the browser bundle - the trap `src/runstate.ts` exists for. */
      const cost = runs[`${project.path}\u0000${feature.path}\u0000${task.ref}`]?.costUsd
      if (typeof cost === "number" && Number.isFinite(cost)) spentUsd += cost
    }
  }

  return { taskFiles: project.features.length, tasks, done, byState, everRun, spentUsd, verified }
}

/**
 * What identifies a task file in the collapsed set: the project **and** the
 * path.
 *
 * A path alone is not an identity. `TreeFeature.path` is repo-relative, so two
 * projects both holding `docs/features/kantan.md` share it - and collapsing
 * one would have collapsed the other, which is the same class of mistake as
 * keying the account cards on `kind`. NUL for the same reason `taskKey` uses
 * it: no path contains one.
 */
export function fileKey(projectPath: string, featureFile: string): string {
  return `${projectPath}\u0000${featureFile}`
}
