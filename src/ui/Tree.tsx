/**
 * The task tree: projects, their feature files, and every task's state.
 *
 * The design is authoritative and lives in `docs/design/`. This column is the
 * left aside of `Main.dc.html` and `Return.dc.html`, its empty state is
 * `Empty.dc.html`, and the nine states are `States.dc.html`. Read the artboard
 * before changing anything here; it is far more specific than this file.
 *
 * Two rules from the design that are decisions rather than taste:
 *
 * - **The glyph's shape carries the meaning; colour only backs it up.** The
 *   nine marks differ in shape - ring, arc, disc, disc-and-check,
 *   disc-and-cross, dashed-ring-and-pause, branch, unplugged, chip - so they
 *   stay distinguishable in greyscale. `test/ui/Tree.test.tsx` proves it by
 *   reducing each glyph to a colour-blind signature.
 * - **Only `needs you` pulses. Only `running` spins.** Nothing else moves.
 */

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, createElement } from "react"
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode } from "react"

/* Type-only, and deliberately so: `src/runindex.ts` opens files at module
 * scope, so a value import would drag `node:fs/promises` into the browser
 * bundle. The type is borrowed rather than restated, so a change to a run's
 * state becomes a compile error here instead of a row that quietly renders as
 * something else. */
import { commandOf } from "./testcmd.ts"
import { verificationOf } from "../runstate.ts"
import type { VerificationReading } from "../runstate.ts"
import type { TaskStatus } from "../runindex.ts"

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

/**
 * Which Claude account a project's runs bill to.
 *
 * Required on every project, because design §5 lists a wrong account as a
 * defect: people bill clients from one of these. **Nothing in `Project` says
 * "personal" or "work"** - it carries a `configDir`, which selects a profile -
 * so the reading is the caller's to make, and `unknown` exists for the case
 * where it cannot be made. A silent default of "personal" would be the one
 * failure this chip is here to prevent.
 */
export interface Account {
  kind: "personal" | "work" | "unknown"
  /** What the chip prints. Defaults to the kind, and to "account unknown". */
  label?: string
}

/**
 * The newest run of one task, as much of `TaskStatus` as a row needs.
 *
 * `state` and `branch` are that type's own fields, so a change there is a
 * compile error here. The rest of `TaskStatus` is identity the tree already
 * knows from where the row sits (`taskRef`, `projectPath`, `featureFile`) or
 * belongs to another column (`runId`, `costUsd`, `attempts`).
 */
export interface TreeTaskRun extends Pick<TaskStatus, "state" | "branch"> {
  /**
   * Test attempts **inside this run**, which is what the design's `×6` chip
   * counts.
   *
   * Not `TaskStatus.attempts`: that counts runs per task, and `runindex.ts`
   * deliberately folds no `test` record, so this number is not in that type at
   * all. The caller reads it from the run's `test` records or from the phase
   * machine.
   */
  testAttempts?: number
  /**
   * The test command's exit code, printed verbatim beside Passed or Failed.
   *
   * Absent on purpose when unknown: `TaskStatus` carries no exit code, and
   * design §"what must survive" requires exit codes printed, never paraphrased
   * - which also forbids inventing one.
   */
  exitCode?: number
}

/** One task line of a feature file. */
export interface TreeTask {
  /** `T1`. `null` for a backlog line with no ref, which cannot be run: a run
   * is addressed by its ref, and `src/run.ts` refuses rather than inventing
   * one. */
  ref: string | null
  text: string
  /** The markdown checkbox. The server ticks it only after the test command
   * exited 0. */
  done: boolean
  /** The newest run. Absent means the task has never run. */
  run?: TreeTaskRun
}

/** The five-value scale `src/projects.ts` validates against. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max"

/** What the agent may do without being asked, as `src/spawn.ts` passes it on. */
export type PermissionMode = "acceptEdits" | "bypassPermissions"

/**
 * The settings a run is shaped by, which were hand-edit-only until the wire
 * carried them.
 *
 * Spelled here rather than imported from `src/projects.ts`: that module reads
 * files, and a **value** import of it poisons the browser bundle - the trap
 * `src/runstate.ts` exists to work around. A type import would erase, but then
 * two files would disagree silently the moment one changed, and this way a
 * mismatch is a typecheck error in `src/server.ts` where the two meet.
 */
export interface AdvancedSettings {
  /** The model the planning conversation runs on, e.g. `claude-opus-5-5`. */
  planModel: string
  /** The model the implement and refine conversations run on. */
  implementModel: string
  planEffort: Effort
  implementEffort: Effort
  permissionMode: PermissionMode
  /** `null` means every tool. A list narrows it to those names. */
  allowedTools: string[] | null
}

export interface TreeFeature {
  /** The path as the project lists it, shown verbatim and never shortened. */
  path: string
  tasks: TreeTask[]
}

export interface TreeProject {
  /** Repo root, absolute. The project's identity. */
  path: string
  account: Account
  /**
   * e.g. `npm test`. Printed under the repo name as the design shows it.
   *
   * `null` when the project has no suite and the agent verifies its own work
   * (the user's 2026-10-12 decision; see `CLAUDE.md`). **Never `?? ""`** - that
   * renders a bare `$`, which reads as a command that failed to load rather
   * than a project that has none. Read it through `commandOf` and nothing
   * else: a stored `""` or `"   "` is that same bare `$`, and `src/ui/testcmd.ts`
   * carries the enumeration and what a wrong guess costs each way.
   */
  testCmd: string | null
  /**
   * The default cost ceiling for a run on this project, in dollars.
   *
   * Optional only because a log or a fixture written before it existed has
   * none; `src/projects.ts` has always stored one and defaults it to 50. A
   * surface with no figure must not print a guessed one - `$0.00 ceiling`
   * would read as a project that can spend nothing.
   */
  budgetUsd?: number
  /**
   * What each phase of a run uses, as the store holds it.
   *
   * One object rather than six fields, and optional as a whole: a tree from a
   * server older than this page has none, and a panel that cannot read the set
   * must not draw a form with half its fields blank - "unset" and "this wire
   * does not carry it" look identical in a text input and mean opposite things.
   */
  advanced?: AdvancedSettings
  /**
   * The Claude profile directory a run bills to, or absent for the default one.
   *
   * Carried but never drawn. It is the field that actually decides which
   * account pays: `src/spawn.ts` sets `CLAUDE_CONFIG_DIR` from it and
   * `src/run.ts` records the run's `profile` from it, while `account` above is
   * read by nothing outside `accountOf()` in `src/server.ts` and is only the
   * chip's word. A shell that cannot see this field cannot offer an account
   * switch - it would move the label and bill the same profile as before.
   *
   * Optional rather than required, for the reason `Project.configDir` gives:
   * **absent means the default profile**, a real and common configuration
   * rather than missing data. That also keeps every existing construction
   * site compiling.
   */
  configDir?: string
  features: TreeFeature[]
}

/** A task's identity, which is the triple and never the ref alone: every
 * feature file in a repo has a `T1`. */
export interface TaskId {
  projectPath: string
  featureFile: string
  taskRef: string | null
}

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
const GRINDING_AFTER = 5

function isGrinding(testAttempts: number | undefined): boolean {
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
 * The design's own words for each state, from `States.dc.html`.
 *
 * Carried as a `title` so the row says what the mark means - which is where
 * "interrupted is resumable" and "done-unmerged cannot be started again" are
 * legible to someone who has not read the artboard.
 */
/** What "Self-checked" means, said in full rather than implied by a colour. */
const SELF_CHECKED =
  "This project has no test command, so kantan ran nothing. The agent was asked to verify its own work and said it was finished; nothing outside the agent checked it."

const DESCRIPTIONS: Record<TaskState, string> = {
  open: "Not started. Most tasks sit here, so this is the quietest mark on the screen.",
  running: "An agent is working right now. One task at a time, so at most one of these anywhere.",
  "needs-you": "Waiting at the gate, or the agent asked a question.",
  passed: "Tests passed, judged by exit code 0. What the agent says about its own work never counts.",
  failed:
    "Tests failed with a non-zero exit, or the agent couldn't continue. The exit code is always printed next to it.",
  stalled:
    "The same failure three times at top effort. Stuck, not broken: no cross, no red, because nothing got worse.",
  "done-unmerged":
    "Finished, but the branch isn't merged. Normal and permanent if you squash-merge. It can't be started again.",
  interrupted:
    "The server stopped mid-run. Normal in development, not a failure. Resume carries on from the last event.",
  grinding: "Many attempts on a task that is still running. It is a notice, never a block.",
}

/* -------------------------------------------------------------------------- */
/* Motion preference                                                          */
/* -------------------------------------------------------------------------- */

const REDUCE_QUERY = "(prefers-reduced-motion: reduce)"

function reduceQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null
  return window.matchMedia(REDUCE_QUERY)
}

function subscribeToReduce(onChange: () => void): () => void {
  const query = reduceQuery()
  if (query === null || typeof query.addEventListener !== "function") return () => {}
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

function readReduce(): boolean {
  return reduceQuery()?.matches ?? false
}

/**
 * Does this person want less movement?
 *
 * Read straight from the media feature, subscribed to, so turning the setting
 * on while the page is open stops the glyphs. Motion's own `useReducedMotion()`
 * is deliberately not consulted: it answers from a module-level singleton
 * initialised at the first call anywhere in the process, which means it answers
 * whatever the first component to call it saw - including `false` with the
 * feature actually set. A live read cannot be stale, so there is nothing for
 * the cached answer to add here.
 *
 * `MOTION_CSS` also guards the keyframes, and that guard stays: the two are
 * belt and braces, and only this one is testable, because happy-dom's
 * `getComputedStyle` does not evaluate `@media (prefers-reduced-motion)`
 * (probed 2026-10-11) - so a CSS-only fallback could not be asserted at all.
 */
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeToReduce, readReduce, () => false)
}

/**
 * The artboard's own class vocabulary, from `src/ui/artboard.css`.
 *
 * `Main.dc.html` is a reference implementation rather than a picture: its one
 * `<style>` block hand-writes every effect it describes, and that block is now
 * `artboard.css` under these names. Writing the names here is what makes this
 * column share one stylesheet with the rest of the app instead of re-deriving
 * the same keyframes per region.
 *
 * **Every artboard name is emitted beside the equivalent it replaces, never
 * alone.** `main.tsx` imports `artboard.css` today, but `main.tsx` is not this
 * file's to edit and this component is rendered by tests and specimens that do
 * not load it at all - so `m` rides with `font-mono`, `ic` with the explicit
 * stroke attributes, `trow`/`ghost` with their Tailwind `hover:` twin, and
 * `spin`/`pulse` with `kantan-spin`/`kantan-pulse` and the keyframes below.
 * Each pair declares the same thing, so the result is identical whichever half
 * the cascade picks, and the column renders either way. An unstyled `.ic`
 * would be an invisible icon, which is the expensive direction to be wrong in.
 *
 * `artboard.css` puts its rules in `@layer components`, and Tailwind declares
 * `@layer theme, base, components, utilities`, so a Tailwind utility beats an
 * artboard class **regardless of specificity**. That is how `size-3` keeps a
 * 12px icon 12px against `.ic`'s 16px default, and presentation attributes on
 * the element lose to both, as they should.
 *
 * It also means **the Tailwind hover twin is the half that works, and is not
 * redundant**. Verified against the stylesheet Vite compiles: `.trow:hover`
 * sets `background:#EFEFF2` in `components`, and a row's own `bg-transparent`
 * - `bg-white` on the selected one - sits in `utilities` and wins, so `.trow`
 * alone would never show a hover. `hover:bg-[#EFEFF2]` is what paints it, and
 * `.ghost`/`hover:bg-[#F6F6F8]` on the `+` button are the same story. Delete
 * either `hover:` utility and the hover silently stops; the artboard class
 * carries the design's vocabulary, not the effect.
 */
const SPIN = "spin kantan-spin"
const PULSE = "pulse kantan-pulse"

/** The entrance fade, with the artboard's stagger. `.d1`-`.d9` only hold on an
 * element that already carries `.bf`, because the `animation` shorthand resets
 * `animation-delay` and `artboard.css` declares `.bf` first for that reason. */
function blurFade(index: number): string {
  return `bf d${Math.min(index + 1, 9)}`
}

/**
 * The two keyframes the design names, which `tokens.css` does not carry.
 *
 * Rendered once by `Tree`, so a `StateGlyph` used outside a tree needs these
 * two keyframes in scope to animate. The reduced-motion guard is repeated here
 * rather than left to `tokens.css`, so the component is correct on its own.
 *
 * It animates the `kantan-` half of each pair above. The artboard half is
 * guarded instead by `artboard.css`'s own `.kr` rule and by `tokens.css`'s
 * blanket one - but neither is what this column relies on: `StateGlyph` reads
 * the preference in JS and emits *neither* class, which is the only guard
 * `bun test` can see, since happy-dom does not evaluate the media feature.
 */
const MOTION_CSS = `
@keyframes kantan-spin{to{transform:rotate(360deg)}}
@keyframes kantan-pulse{
  0%{box-shadow:0 0 0 0 rgba(255,106,26,.55)}
  70%{box-shadow:0 0 0 9px rgba(255,106,26,0)}
  100%{box-shadow:0 0 0 0 rgba(255,106,26,0)}
}
.kantan-spin{animation:kantan-spin .9s linear infinite;transform-origin:50% 50%}
.kantan-pulse{animation:kantan-pulse 1.8s ease-out infinite}
@media (prefers-reduced-motion:reduce){
  .kantan-spin,.kantan-pulse{animation:none}
}
`

/** The row glyph is 16px, and the two bare discs are 14px, as in the artboard. */
const ICON = "size-[16px] shrink-0"

/**
 * One state, as a shape.
 *
 * `grinding` is the one mark that is not a bullet: it is the amber attempt chip,
 * because grinding rides on `running` and the row keeps the spinning arc in the
 * glyph column (see `Return.dc.html`). `count` is the number of test attempts
 * inside the run, printed as `×6`; with no count the chip prints the loop alone
 * rather than inventing a number.
 */
export function StateGlyph({
  state,
  count,
}: {
  state: TaskState
  count?: number
}): ReactElement {
  /* The two marks that move read the preference themselves rather than taking
   * it as a prop, because this component is used outside a tree too and a glyph
   * that keeps spinning for someone who asked it not to is the whole failure. */
  const reduce = usePrefersReducedMotion()
  switch (state) {
    case "open":
      return (
        <span
          aria-hidden
          className="box-border size-[14px] shrink-0 rounded-full border-[1.5px] border-muted-300"
        />
      )
    case "running":
      return (
        <svg
          aria-hidden
          data-motion={reduce ? "static" : "animated"}
          viewBox="0 0 24 24"
          className={`${reduce ? "" : `${SPIN} `}${ICON}`}
        >
          <circle cx="12" cy="12" r="9" fill="none" stroke="#DCDCF6" strokeWidth="3" />
          <path
            d="M21 12a9 9 0 0 0-9-9"
            fill="none"
            stroke="#5B5BD6"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </svg>
      )
    case "needs-you":
      return (
        <span
          aria-hidden
          data-motion={reduce ? "static" : "animated"}
          className={`${reduce ? "" : `${PULSE} `}size-[14px] shrink-0 rounded-full bg-attention`}
        />
      )
    case "passed":
      return (
        <span aria-hidden className={`grid place-items-center rounded-full bg-pass ${ICON}`}>
          <svg
            viewBox="0 0 24 24"
            className="size-[10px]"
            fill="none"
            stroke="#ffffff"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </span>
      )
    case "failed":
      return (
        <span aria-hidden className={`grid place-items-center rounded-full bg-fail ${ICON}`}>
          <svg
            viewBox="0 0 24 24"
            className="size-[9px]"
            fill="none"
            stroke="#ffffff"
            strokeWidth="4"
            strokeLinecap="round"
          >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </span>
      )
    case "stalled":
      return (
        <span
          aria-hidden
          className={`box-border grid place-items-center rounded-full border-[1.5px] border-dashed border-[#A23B87] ${ICON}`}
        >
          <svg viewBox="0 0 24 24" className="size-[8px]" fill="#A23B87">
            <rect x="5" y="3" width="5" height="18" rx="1.5" />
            <rect x="14" y="3" width="5" height="18" rx="1.5" />
          </svg>
        </span>
      )
    case "done-unmerged":
      return (
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          className={`ic text-[#0E7C86] ${ICON}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="6" x2="6" y1="3" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
      )
    case "interrupted":
      return (
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          className={`ic text-[#64748B] ${ICON}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m19 5 3-3" />
          <path d="m2 22 3-3" />
          <path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z" />
          <path d="M7.5 13.5 10 11" />
          <path d="M10.5 16.5 13 14" />
          <path d="m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z" />
        </svg>
      )
    case "grinding":
      return (
        <span
          className="inline-flex items-center gap-[3px] rounded-full bg-[#FEF3C7] px-[7px] py-[2px] text-[11.5px] font-[620] text-[#8A4B0A]"
          title={DESCRIPTIONS.grinding}
          aria-label={count === undefined ? "grinding" : `grinding, ${count} attempts so far`}
        >
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            className="ic size-[11px] shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            /* Inline, because `.ic` sets `stroke-width:2` and any CSS beats a
               presentation attribute. The artboard writes this one inline for
               the same reason: the loop is the only 2.5 in the set. */
            style={{ strokeWidth: 2.5 }}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m17 2 4 4-4 4" />
            <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
            <path d="m7 22-4-4 4-4" />
            <path d="M21 13v1a4 4 0 0 1-4 4H3" />
          </svg>
          {count === undefined ? "" : `×${count}`}
        </span>
      )
  }
}

/** The trailing text of a row, which the design sets at 11.5px. */
const LABEL = "text-[11.5px] font-[560]"

/**
 * One state, as a word.
 *
 * `open` prints nothing in the design, so its word is carried for a screen
 * reader only: an empty cell beside a hollow ring says nothing out loud.
 * `grinding` is the amber chip rather than a word, because the row keeps the
 * spinning arc in the glyph column.
 */
export function StateLabel({
  state,
  exitCode,
  count,
  verification,
}: {
  state: TaskState
  /** Printed as ` · exit <n>` beside Passed and Failed. Never invented. */
  exitCode?: number
  /**
   * How the run was verified, from `verificationOf` in `src/runindex.ts`.
   *
   * `"self-check"` changes what this may say: there was no command, so there is
   * no exit code and nothing "passed" in the sense the word carries everywhere
   * else on this screen. `"unknown"` - a log written before the field existed -
   * is read as unknown, never as tested.
   */
  verification?: VerificationReading
  /** Test attempts inside the run, for the grinding chip. */
  count?: number
}): ReactElement {
  const exit: ReactNode =
    exitCode === undefined ? null : (
      <>
        {" · "}
        <span className="m font-mono">exit {exitCode}</span>
      </>
    )
  switch (state) {
    case "open":
      return <span className="sr-only">Open</span>
    case "running":
      return (
        <span className={`${LABEL} text-indigo-deep`} title={DESCRIPTIONS.running}>
          Running
        </span>
      )
    case "needs-you":
      return (
        <span
          className="rounded-full bg-attention px-2 py-[3px] text-[11.5px] font-[650] text-[#1A0B02]"
          title={DESCRIPTIONS["needs-you"]}
        >
          Needs you
        </span>
      )
    case "passed":
      // No exit code is printed here even if one were somehow supplied: a
      // self-checked run has none, and inventing or borrowing one is the exact
      // failure `CLAUDE.md` forbids.
      return verification === "self-check" ? (
        <span className={`${LABEL} text-muted-500`} title={SELF_CHECKED}>
          Self-checked
        </span>
      ) : (
        <span className={`${LABEL} text-pass-deep`} title={DESCRIPTIONS.passed}>
          Passed
          {exit}
        </span>
      )
    case "failed":
      return (
        <span className={`${LABEL} text-[#C4232F]`} title={DESCRIPTIONS.failed}>
          Failed
          {exit}
        </span>
      )
    case "stalled":
      return (
        <span className={`${LABEL} text-[#93307A]`} title={DESCRIPTIONS.stalled}>
          Stalled
        </span>
      )
    case "done-unmerged":
      return (
        <span className={`${LABEL} text-[#0B6C75]`} title={DESCRIPTIONS["done-unmerged"]}>
          Done · unmerged
        </span>
      )
    case "interrupted":
      return (
        <span className={`${LABEL} text-[#556274]`} title={DESCRIPTIONS.interrupted}>
          Interrupted
        </span>
      )
    case "grinding":
      return <StateGlyph state="grinding" count={count} />
  }
}

// --- Single-letter shortcuts ------------------------------------------------

/**
 * The one guard every bare-letter shortcut in this app goes through.
 *
 * It lives here, and the gate imports it, because two copies of a rule about
 * when *not* to act would drift and the cheap direction would stop being the
 * one both of them fail toward.
 *
 * Returns the character the keystroke means, or `null` when the keystroke is
 * not ours. The dimensions it reads, enumerated, because a guard that decides
 * to ignore a keystroke is a guess and its risk is its worst case:
 *
 * | Dimension | Values | Wrong in the permissive direction | Wrong the other way |
 * |---|---|---|---|
 * | `key` length | one character, or a name like `Enter`/`ArrowDown` | a named key fires a letter shortcut | nothing: no shortcut here is a named key |
 * | modifiers | none, meta, ctrl, alt, shift, combinations | `Ctrl+A` stops selecting all, `⌘J` stops opening downloads | one click on a control that is on screen |
 * | target | textarea, input of any type, select, contenteditable and its children, an ARIA textbox or combobox, anything else | a letter typed into a reply box runs the plan it objects to | one click |
 * | `defaultPrevented` | set, unset | two handlers act on one keystroke | nothing: whoever set it already acted |
 * | `isComposing` | set, unset | an IME's keystroke is stolen mid-word | nothing |
 *
 * `event.key` rather than `event.code`, deliberately: `code` is the physical
 * key, so on AZERTY the key printed `A` reports `KeyQ` and the key printed `Q`
 * would approve. Reading `key` means a layout that cannot produce `a`, `j` or
 * `k` without a modifier simply has no shortcuts, which is the cheap failure.
 *
 * `repeat` is **not** read here, because its cost differs per caller: a held
 * `j` scrolling the tree is useful, a held `a` approving is not. Each caller
 * decides.
 */
export function bareKeystroke(event: KeyboardEvent): string | null {
  if (event.defaultPrevented) return null
  if (event.isComposing) return null
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null
  if (event.key.length !== 1) return null
  if (isTypingSurface(event.target)) return null
  return event.key
}

/** The roles that take typed characters, so a letter in one of them is text. */
const TEXT_ROLES = '[role="textbox"],[role="searchbox"],[role="combobox"],[role="spinbutton"]'

/**
 * Is this keystroke going into something that accepts typed characters?
 *
 * `isContentEditable` is used rather than the attribute because it is inherited
 * (verified under happy-dom): the target of a keystroke inside an editable
 * region is usually a child element, not the element carrying the attribute.
 * The ARIA roles need `closest` for the same reason, since they are not
 * reflected onto descendants.
 *
 * Every `input` counts, including a checkbox, where a letter does nothing. That
 * is the cheap direction: the cost of being wrong here is one click.
 */
export function isTypingSurface(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT" || tag === "OPTION") return true
  return target.closest(TEXT_ROLES) !== null
}

/**
 * Is this keystroke raised on a task row?
 *
 * The hazard it exists for: `j` moves focus without selecting, so focus can sit
 * on T3 while the gate still shows T2's plan. A bare `a` then would approve T2,
 * a plan the human has stopped looking at.
 *
 * It asks about **any** row rather than only one that is not `aria-current`,
 * and the stricter question is the point. `aria-current` says which row the
 * tree believes is selected. It says nothing about whether the gate beside it
 * has caught up — press Enter on T3 and T3 is current at once, while the card
 * holds T2's plan until a fetch resolves. The narrower rule would approve T2
 * from a row marked T3, and would be right only for as long as the shell
 * happened to re-render in time. **A guard that depends on another file's
 * timing is not a guard**, so this one does not.
 *
 * The costs are not symmetric. Refusing here costs one Tab, or one click on a
 * button that is on screen with its key printed on it. Approving here costs an
 * implementation run on a plan nobody agreed to, plus the branch and the review
 * it drags behind it.
 *
 * This is the one DOM-level contract between the tree and the gate, and it is
 * now a single attribute: a task row is `[data-task-row]`. Nothing else in the
 * column carries a task identity, so nothing else is ambiguous.
 */
export function pointsAtATask(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.closest("[data-task-row]") !== null
}

// --- The column -------------------------------------------------------------

/** The artboard's 16px line icons: `fill:none; stroke:currentColor`. */
const LINE = {
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
}

/**
 * Text that comes from a repository - a path, a task line, a repo directory, a
 * test command - and is therefore arbitrary: over 150 characters, possibly
 * non-Latin, possibly one unbroken token.
 *
 * `min-w-0` lets the grid or flex cell shrink below its content, which is what
 * makes wrapping possible at all, and `overflow-wrap:anywhere` breaks a token
 * with no spaces in it. Nothing here may clip, truncate or set `nowrap`:
 * design §"what must survive" lists silent truncation as a defect, and a path
 * is the thing a reader checks character by character.
 */
const ARBITRARY = "min-w-0 [overflow-wrap:anywhere]"

/**
 * The artboard's baseline leading, which is the browser's `normal`.
 *
 * Tailwind's preflight sets `html{line-height:1.5}`, and the artboard sets
 * nothing - so every line in this column was 1.5 where the design wanted
 * `normal` (about 1.3). Measured against `Main.dc.html`: the PROJECTS eyebrow
 * stood 17.3px tall against the artboard's 15.0, and the repo name 20px
 * against 18.
 *
 * Declared once on the column, so the few places that *do* name a leading -
 * the task row's 1.35 and the empty state's 1.55, both from the artboard -
 * still win on specificity order inside it.
 */
const LEADING = "leading-[normal]"

export interface TreeProps {
  projects: TreeProject[]
  /** The task the rest of the screen is about. Compared on the whole triple. */
  selected?: TaskId | null
  onSelect?: (task: TaskId) => void
  /**
   * Point kantan at a repository. The header control is rendered only when
   * this is given: the artboard shows the button, but one that does nothing is
   * worse than none at all.
   */
  onAddProject?: () => void
  /**
   * Open a project itself, rather than one of its tasks.
   *
   * The artboard draws the repo row as a label, because every artboard shows a
   * project that already has work in it. A real one often does not, and then
   * there is nothing in the column to click and no way to add a task file -
   * which is exactly how this read as a broken app. Given a handler, the row
   * becomes a button; its appearance does not change.
   */
  onSelectProject?: (path: string) => void
  /** The project the rest of the screen is about, when it is a project. */
  selectedProject?: string | null
  /**
   * Replaces the account chip, so a caller can make it interactive.
   *
   * The design hangs the account switch off the chip - click it, choose, be
   * asked to confirm. The chip stays a plain `AccountChip` when this is absent,
   * which is what every artboard draws.
   */
  accountSlot?: (project: TreeProject) => ReactNode
  /**
   * Add work to one task file. The design puts this at the end of each file in
   * the tree rather than behind a panel, which is also the only place it can
   * name the file it will append to.
   */
  onAddTask?: (projectPath: string, featureFile: string) => void
  /**
   * Asks to remove one task. Absent draws no remove control at all.
   *
   * It only *asks*: this component is presentational and the confirmation is
   * the shell's, which is why no state lives here. A destructive action on a
   * file in the user's own repository gets confirmed, and `App.tsx` owns that
   * dialog the way `ProjectPanel` owns the one for removing a project.
   *
   * A task with no ref is not offered: `DELETE /api/features/task` addresses a
   * task by ref, and there is nothing to send for a line that has none.
   */
  onRemoveTask?: (projectPath: string, featureFile: string, taskRef: string) => void
  /**
   * Asks to start a **new** task file in this project. Absent draws no row.
   *
   * Separate from `onAddTask`, which is per-file and therefore per-scope: the
   * "+ Add task" row under `importer.md` can only add work that belongs to the
   * importer. Reported from use as "why does it say *Add tasks to
   * add-health-check-endpoint.md* when I wanted a task for a different
   * scope?" - the answer was that there was no other way in, which is a gap
   * rather than an answer.
   */
  onNewTaskFile?: (projectPath: string) => void
}

/** Does this triple address this task? Compared whole; a bare ref is ambiguous. */
function isSameTask(a: TaskId | null | undefined, b: TaskId): boolean {
  return (
    a != null &&
    a.projectPath === b.projectPath &&
    a.featureFile === b.featureFile &&
    a.taskRef === b.taskRef
  )
}

/**
 * The first task a keystroke can land on, or `null` when none can.
 *
 * A line with no ref is skipped, because `src/run.ts` refuses it rather than
 * inventing a ref, so it is text rather than a control - and the tab stop has
 * to be something that can be activated.
 */
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
function fileKey(projectPath: string, featureFile: string): string {
  return `${projectPath}\u0000${featureFile}`
}

/**
 * The first task a Tab could land on, skipping collapsed files.
 *
 * `collapsed` is read here rather than filtered afterwards because a tab stop
 * inside a collapsed file is not a tab stop at all: `hidden` makes the node
 * unfocusable, so `tabIndex={0}` on it leaves the whole column with no way in
 * from the keyboard. Defaulting to an empty set keeps every existing caller -
 * and every test that renders `Tree` without one - reading exactly as before.
 */
function firstNavigable(
  projects: readonly TreeProject[],
  collapsed: ReadonlySet<string> = new Set(),
): TaskId | null {
  for (const project of projects) {
    for (const feature of project.features) {
      if (collapsed.has(fileKey(project.path, feature.path))) continue
      for (const task of feature.tasks) {
        if (task.ref !== null) {
          return { projectPath: project.path, featureFile: feature.path, taskRef: task.ref }
        }
      }
    }
  }
  return null
}

/**
 * Projects, their feature files, and every task's state.
 *
 * There is no start control here, and that is deliberate: the tree picks the
 * task, and the centre column acts on it. A caller offering a start must ask
 * `canStart` first - `done-unmerged`, `passed`, `failed` and `interrupted` all
 * own a branch already, and `interrupted` wants `canResume` instead.
 *
 * **The hierarchy is nested lists, not `role="tree"`.** Both are real patterns;
 * this one is the one this column can keep. A `tree` is a contract - every node
 * reports `aria-expanded`, and arrow keys open and close them - and nothing
 * here expands or collapses: a project and a feature file are always shown
 * whole, by design. Claiming the role without the behaviour tells a screen
 * reader user to press ArrowRight on a node that will never open, which is
 * worse than the three nested lists they can already count their way through.
 * What the task asked for - `j`, `k` and a visible focus ring - is provided
 * either way, and the arrow keys are aliases so the habit transfers.
 *
 * **`j` and `k` move focus; they never select.** Moving is not opening. A
 * selection is a fetch once this is wired to the server, so a keystroke that
 * selected would mean one request per row scrolled past, and `Enter` would have
 * nothing left to do.
 */
export function Tree({
  projects,
  selected,
  onSelect,
  onAddProject,
  onSelectProject,
  selectedProject,
  accountSlot,
  onAddTask,
  onRemoveTask,
  onNewTaskFile,
}: TreeProps): ReactElement {
  const eyebrow = "text-[11.5px] font-semibold uppercase tracking-[.07em] text-muted-400"
  const ids = useId()

  /**
   * Task files the human has collapsed, by path.
   *
   * A **deny** set rather than an allow set, so the default is open and a file
   * that arrives from a refetch is visible rather than hidden. Collapsing is
   * the exception the human asks for; appearing already collapsed is a file
   * they would have to find.
   *
   * Here rather than in `ProjectBlock` because this component survives a tree
   * refetch and the blocks are re-created by it - state below this point would
   * reset every time a run changed state, which is often.
   */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const toggleFile = useCallback((path: string) => {
    setCollapsed((was) => {
      const next = new Set(was)
      if (!next.delete(path)) next.add(path)
      return next
    })
  }, [])
  const column = useRef<HTMLElement | null>(null)
  const reduce = usePrefersReducedMotion()

  /**
   * The tree's single tab stop: the task the rest of the screen is about, or
   * the first one when nothing is selected.
   *
   * One stop rather than one per row, because Tab is how a keyboard user leaves
   * a region and a backlog of fifty tasks would otherwise be fifty presses.
   * It is derived rather than held in state, so it cannot disagree with the
   * selection — and since `Enter` selects whatever `j` focused, the stop
   * follows the human one keystroke later.
   */
  const stop = (() => {
    const first = firstNavigable(projects, collapsed)
    if (first === null) return null
    const hasSelection = projects.some((project) =>
      project.features.some((feature) =>
        feature.tasks.some(
          (task) =>
            task.ref !== null &&
            isSameTask(selected, {
              projectPath: project.path,
              featureFile: feature.path,
              taskRef: task.ref,
            }),
        ),
      ),
    )
    /* And it has to be *reachable*: a selection inside a collapsed file is
       still the subject of the centre column, but it cannot be the column's
       way in from the keyboard. */
    const reachable =
      hasSelection && selected != null && !collapsed.has(fileKey(selected.projectPath, selected.featureFile))
    return reachable && selected != null ? selected : first
  })()

  /**
   * Every row a keystroke can land on, read from the DOM in drawn order.
   *
   * From the DOM rather than from the props, because what moves is focus: the
   * element is the thing to be focused, and deriving an index from the props
   * and then looking the element up again is the same walk with one more place
   * to disagree.
   */
  const navigableRows = (): HTMLElement[] => {
    const root = column.current
    if (root === null) return []
    return [...root.querySelectorAll<HTMLElement>("button[data-task-row]")].filter(
      /* A row inside a collapsed file is not navigable, and `offsetParent` is
         the cheap read that says so: it is `null` for anything whose subtree
         has `display: none`, which is what `[hidden]` gives the task list. The
         alternative - deriving it from the collapsed set - would be a second
         source of truth about what is on screen, and `.focus()` on a
         `display: none` element silently does nothing, so the two disagreeing
         would strand the arrow keys with no error anywhere. */
      (row) => row.offsetParent !== null,
    )
  }

  /**
   * Move focus by one row, or to an end.
   *
   * With nothing in the tree focused, the first keystroke *enters* at the task
   * the screen is about rather than at the top: landing on what you are already
   * reading costs one extra `j`, and landing eight rows away from it costs
   * finding your place again.
   */
  const moveFocus = (to: "next" | "previous" | "first" | "last", from: EventTarget | null): boolean => {
    const rows = navigableRows()
    if (rows.length === 0) return false
    const land = (row: HTMLElement | undefined): boolean => {
      if (row === undefined) return false
      row.focus()
      return true
    }
    if (to === "first") return land(rows[0])
    if (to === "last") return land(rows[rows.length - 1])
    const here = from instanceof HTMLElement ? from.closest("button[data-task-row]") : null
    const at = here === null ? -1 : rows.indexOf(here as HTMLElement)
    if (at === -1) {
      const entry = rows.findIndex((row) => row.getAttribute("aria-current") === "true")
      return land(rows[entry === -1 ? 0 : entry])
    }
    return land(rows[Math.min(rows.length - 1, Math.max(0, at + (to === "next" ? 1 : -1)))])
  }

  /*
   * `j` and `k`, from anywhere on the page.
   *
   * Document-level because the point of a letter shortcut is reaching the tree
   * without first tabbing to it, and `bareKeystroke` is what makes that safe:
   * a `j` typed into the gate's reply box is text, not navigation.
   *
   * `event.repeat` is deliberately *not* filtered: a held `j` walking a long
   * backlog is the behaviour someone pressing it twice is asking for, and the
   * worst a repeat can do here is move focus one row too far, which `k` undoes.
   *
   * `Enter` is absent on purpose. Every navigable row is a `<button>`, so the
   * browser already turns `Enter` and `Space` on a focused row into a click,
   * and a document-level `Enter` listener is exactly how a textarea loses its
   * newline.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = bareKeystroke(event)
      if (key !== "j" && key !== "k") return
      /* Consumed only if it actually moved. An empty tree has no business
       * swallowing a letter the page might mean something else by. */
      if (moveFocus(key === "j" ? "next" : "previous", event.target)) event.preventDefault()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
    // `moveFocus` reads the DOM through a ref, so it needs no deps of its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /*
   * The arrow keys, and only from a row.
   *
   * Scoped to the column rather than the document because ArrowDown in a
   * textarea moves the caret and in a scroller scrolls it, and both of those
   * belong to whoever is focused. A row is the one place the meaning is ours.
   */
  const onColumnKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
    const target = event.target
    if (!(target instanceof HTMLElement) || target.closest("button[data-task-row]") === null) return
    const to =
      event.key === "ArrowDown"
        ? "next"
        : event.key === "ArrowUp"
          ? "previous"
          : event.key === "Home"
            ? "first"
            : event.key === "End"
              ? "last"
              : null
    if (to === null) return
    event.preventDefault()
    moveFocus(to, target)
  }

  if (projects.length === 0) {
    return (
      <aside
        aria-label="Projects and tasks"
        className={`box-border basis-72 grow border-r border-edge bg-panel px-[18px] pt-4 pb-7 ${LEADING}`}
      >
        <span className={`block ${eyebrow}`}>Projects</span>
        <p className="mt-[14px] rounded-[14px] border-[1.5px] border-dashed border-[#D9DAE0] px-4 py-[18px] text-[13.5px] leading-[1.55] text-muted-500">
          No repositories yet. Your projects, their task files and every task&rsquo;s state will
          live here.
        </p>
      </aside>
    )
  }

  return (
    <aside
      ref={column}
      onKeyDown={onColumnKeyDown}
      aria-label="Projects and tasks"
      className={`box-border basis-72 grow border-r border-edge bg-panel px-[10px] pt-4 pb-7 ${LEADING}`}
    >
      {/* The two keyframes the design names and `tokens.css` does not carry.
          Rendered here, once, because this file may not edit the token layer. */}
      <style>{MOTION_CSS}</style>

      <div className="flex items-center justify-between px-2 pb-[6px]">
        <span className={eyebrow} id={`${ids}-projects`}>
          Projects
        </span>
        {onAddProject === undefined ? null : (
          <button
            type="button"
            aria-label="Add a repository"
            onClick={onAddProject}
            className="ghost grid size-[30px] place-items-center rounded-[9px] border border-edge-soft bg-white text-muted-900 hover:bg-[#F6F6F8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo"
          >
            <svg aria-hidden viewBox="0 0 24 24" className="ic size-[15px]" {...LINE}>
              <path d="M5 12h14" />
              <path d="M12 5v14" />
            </svg>
          </button>
        )}
      </div>

      {/* Three nested lists: repositories, their task files, and the tasks in
          each. The nesting is what carries the hierarchy and the position in it
          ("3 of 7") without a single hand-written label. */}
      <ul aria-labelledby={`${ids}-projects`} className="m-0 list-none p-0">
        {projects.map((project, index) => (
          <ProjectBlock
            key={project.path}
            {...(onSelectProject === undefined ? {} : { onSelectProject })}
            {...(selectedProject === undefined ? {} : { selectedProject })}
            {...(accountSlot === undefined ? {} : { accountSlot })}
            {...(onAddTask === undefined ? {} : { onAddTask })}
            {...(onRemoveTask === undefined ? {} : { onRemoveTask })}
            {...(onNewTaskFile === undefined ? {} : { onNewTaskFile })}
            project={project}
            first={index === 0}
            order={index}
            collapsed={collapsed}
            toggleFile={toggleFile}
            /* The entrance fade is the one motion in this column that is not a
               glyph, so it is read here once and handed down rather than
               subscribed to per block. */
            reduce={reduce}
            idPrefix={`${ids}-p${index}`}
            selected={selected}
            stop={stop}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </aside>
  )
}

function ProjectBlock({
  project,
  first,
  order,
  reduce,
  idPrefix,
  selected,
  stop,
  onSelect,
  onSelectProject,
  selectedProject,
  accountSlot,
  onAddTask,
  onRemoveTask,
  onNewTaskFile,
  collapsed,
  toggleFile,
}: {
  onSelectProject?: (path: string) => void
  selectedProject?: string | null
  accountSlot?: (project: TreeProject) => ReactNode
  onAddTask?: (projectPath: string, featureFile: string) => void
  /**
   * Asks to remove one task. Absent draws no remove control at all.
   *
   * It only *asks*: this component is presentational and the confirmation is
   * the shell's, which is why no state lives here. A destructive action on a
   * file in the user's own repository gets confirmed, and `App.tsx` owns that
   * dialog the way `ProjectPanel` owns the one for removing a project.
   *
   * A task with no ref is not offered: `DELETE /api/features/task` addresses a
   * task by ref, and there is nothing to send for a line that has none.
   */
  onRemoveTask?: (projectPath: string, featureFile: string, taskRef: string) => void
  /**
   * Asks to start a **new** task file in this project. Absent draws no row.
   *
   * Separate from `onAddTask`, which is per-file and therefore per-scope: the
   * "+ Add task" row under `importer.md` can only add work that belongs to the
   * importer. Reported from use as "why does it say *Add tasks to
   * add-health-check-endpoint.md* when I wanted a task for a different
   * scope?" - the answer was that there was no other way in, which is a gap
   * rather than an answer.
   */
  onNewTaskFile?: (projectPath: string) => void
  project: TreeProject
  first: boolean
  /** Position in the column, which is the artboard's `.d1`-`.d9` stagger step. */
  order: number
  /** Does this person want less movement? Read once by `Tree`. */
  reduce: boolean
  idPrefix: string
  selected?: TaskId | null
  stop: TaskId | null
  onSelect?: (task: TaskId) => void
  /** Paths the human collapsed. A deny set; see `Tree`. */
  collapsed: ReadonlySet<string>
  toggleFile: (path: string) => void
}): ReactElement {
  const repoId = `${idPrefix}-repo`
  const testCmd = commandOf(project.testCmd)

  /**
   * Whether a file's tasks are drawn: whatever the human last said.
   *
   * It forced a file open when it held the selected task or the tree's tab
   * stop, and that was wrong in a way only the browser showed: the tab stop is
   * the first task when nothing is selected, so the first file could never be
   * collapsed at all - the click toggled the set and the row reappeared
   * immediately.
   *
   * The focus concern behind that rule is real and is handled where it belongs.
   * `hidden` makes a node unfocusable, so `.focus()` on a row in a collapsed
   * file silently does nothing; `navigableRows` therefore skips rows whose
   * `offsetParent` is `null`, and `stopFor` picks the tab stop from the rows
   * that are actually on screen. A collapsed file keeps its `aria-current` on
   * a hidden row, which costs nothing - the centre column is still about it.
   */
  const isOpen = (feature: TreeFeature): boolean => !collapsed.has(fileKey(project.path, feature.path))
  return (
    <li
      className={`${reduce ? "" : `${blurFade(order)} `}${first ? "" : "mt-[6px] border-t border-[#ECECEF]"}`.trim()}
    >
      {/* A button only when something can act on it, and otherwise the plain
          row the artboard draws. Same box either way: the classes below are
          shared, and `button` is reset to `text-left` and full width so the
          layout is identical to the `div`. */}
      {/* The chip is a SIBLING of the row control, never a child of it.
          `ProjectPanel` mounts an account switch on the chip, and a button
          inside a button is invalid, un-clickable in the inner case, and sends
          every chip click bubbling to `onSelectProject`. So the row is a flex
          container, and only the name half is the button. */}
      <div className="flex items-center gap-2 px-[10px] pt-[14px] pb-[2px]">
        {createElement(
          onSelectProject === undefined ? "span" : "button",
          onSelectProject === undefined
            ? { className: "flex min-w-0 items-center gap-2" }
            : {
                type: "button",
                "data-project-row": true,
                "aria-current": selectedProject === project.path ? "true" : undefined,
                onClick: () => onSelectProject(project.path),
                className: `trow -mx-1 flex min-w-0 items-center gap-2 rounded-[8px] px-1 py-0.5 text-left hover:bg-[#EFEFF2] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo ${
                  selectedProject === project.path ? "bg-[#EFEFF2]" : ""
                }`,
              },
          <svg key="i" aria-hidden viewBox="0 0 24 24" className="ic size-4 shrink-0 text-muted-400" {...LINE}>
            <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
          </svg>,
          /* The repo's own directory name. `title` carries the whole path, which
             is longer than this column and is not what the design shows.
             `text-[14px]` rather than `text-sm`, because the Tailwind step
             carries a 20px leading where the artboard's 14px line box is 18. */
          <span key="n" id={repoId} data-repo title={project.path} className={`${ARBITRARY} text-[14px] font-[620]`}>
            {repoName(project.path)}
          </span>,
        )}
        {accountSlot === undefined ? <AccountChip account={project.account} /> : accountSlot(project)}
      </div>

      <div
        data-test-cmd
        className={`${ARBITRARY} m pr-[10px] pb-[6px] pl-[34px] font-mono text-xs text-muted-400`}
      >
        {testCmd === null ? "no test suite · the agent checks its own work" : `$ ${testCmd}`}
      </div>

      <ul aria-labelledby={repoId} className="m-0 list-none p-0">
        {project.features.map((feature, index) => {
          const pathId = `${idPrefix}-f${index}`
          const listId = `${pathId}-tasks`
          const open = isOpen(feature)
          return (
            <li key={feature.path}>
              {/* The artboard already draws a chevron here and it did nothing.
                  With a backlog of any size the column becomes one long scroll,
                  so the chevron is now the control it looks like.

                  A `<button>` rather than a `<summary>`: `<details>` would own
                  the open state, and this component has to be able to open a
                  file itself - see `openFiles` - which `<details>` only allows
                  by writing to the DOM node. */}
              <button
                type="button"
                data-feature-toggle={feature.path}
                aria-expanded={open}
                aria-controls={listId}
                onClick={() => toggleFile(fileKey(project.path, feature.path))}
                className={`m flex w-full items-center gap-[6px] ${index === 0 ? "pt-[6px]" : "pt-[10px]"} pr-[10px] pb-[4px] pl-[14px] text-left font-mono text-xs text-muted-500 hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo`}
              >
                <svg
                  aria-hidden
                  viewBox="0 0 24 24"
                  className={`ic size-[13px] shrink-0 transition-transform ${open ? "" : "-rotate-90"}`}
                  {...LINE}
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
                <span id={pathId} data-feature-path className={ARBITRARY}>
                  {feature.path}
                </span>
                {/* What is behind a collapsed file, so closing one does not
                    hide that it has work needing attention. */}
                {!open && (
                  <span data-feature-count className="ml-auto shrink-0 pl-2 text-[11px] text-muted-400">
                    {feature.tasks.length} task{feature.tasks.length === 1 ? "" : "s"}
                  </span>
                )}
              </button>

              {/* Named by the path above it, so a screen reader reaching the
                  tasks says which file they come from. */}
              <ul id={listId} aria-labelledby={pathId} hidden={!open} className="m-0 list-none p-0">
                {feature.tasks.map((task, position) => {
                  const id: TaskId = {
                    projectPath: project.path,
                    featureFile: feature.path,
                    taskRef: task.ref,
                  }
                  /* Captured here so the guard below narrows it. Reading
                     `task.ref` inside the handler would not: the closure
                     outlives the check, which is why a `!` would have been
                     needed - and `src/` holds none. */
                  const ref = task.ref
                  return (
                    <li
                      key={`${feature.path}\u0000${task.ref ?? `#${position}`}`}
                      /* `group/task` so the remove control can appear on hover
                         of the row, and `focus-within` so it appears for a
                         keyboard user too - a control reachable only by a
                         pointer is not reachable.

                         No `relative`, and the control is in normal flow
                         rather than absolutely positioned over the row. It was
                         `absolute right-[6px]` first, and that covered the
                         state chip and the end of any title long enough to
                         reach it - reported from use. Reserving the space
                         costs every row ~30px of title width whether the
                         control is visible or not, which is the cheap
                         direction: a narrower title wraps, while a covered
                         "Needs you" chip hides the one thing the row exists to
                         say. */
                      className="group/task flex items-center"
                    >
                      <TaskRow
                        task={task}
                        id={id}
                        selected={selected}
                        isStop={task.ref !== null && isSameTask(stop, id)}
                        onSelect={onSelect}
                      />
                      {/* A **sibling** of the row, not a child: the row is a
                          `<button>`, and a button inside a button is invalid
                          and swallows its own clicks. The account chip on the
                          project row was nested like that once; this is the
                          same lesson. */}
                      {onRemoveTask !== undefined && ref !== null && (
                        <button
                          type="button"
                          aria-label={`Remove ${ref}`}
                          title={`Remove ${ref} from ${feature.path}`}
                          data-remove-task={ref}
                          onClick={() => onRemoveTask(project.path, feature.path, ref)}
                          className="mr-[4px] grid size-[26px] shrink-0 place-items-center rounded-[8px] border border-transparent bg-white/0 text-muted-400 opacity-0 transition-opacity hover:border-[#F0B8BE] hover:bg-white hover:text-[#A61B27] focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-indigo group-hover/task:opacity-100 group-focus-within/task:opacity-100"
                        >
                          <svg aria-hidden viewBox="0 0 24 24" className="ic size-[14px]" {...LINE}>
                            <path d="M3 6h18" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                            <path d="M10 11v6" />
                            <path d="M14 11v6" />
                            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      )}
                    </li>
                  )
                })}

                {/* The design's own entry point for adding work: a row at the
                    end of each task file, not a button in a panel. Rendered
                    only when a handler exists, like the "+" in the header —
                    `Tree`'s rule is that a control which does nothing is worse
                    than none at all. */}
                {onAddTask !== undefined && (
                  <li>
                    <button
                      type="button"
                      onClick={() => onAddTask(project.path, feature.path)}
                      className="trow -mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded-[10px] px-[10px] py-[7px] text-left text-[13px] font-[560] text-muted-500 hover:bg-[#EFEFF2] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo"
                    >
                      <span
                        aria-hidden
                        className="grid size-[22px] shrink-0 place-items-center rounded-[7px] border border-dashed border-[#D2D3DA] text-ink"
                      >
                        <svg viewBox="0 0 24 24" className="ic size-[14px]" {...LINE}>
                          <path d="M5 12h14" />
                          <path d="M12 5v14" />
                        </svg>
                      </span>
                      Add task
                    </button>
                  </li>
                )}
              </ul>
            </li>
          )
        })}

        {/* After the files, not inside one: this is the only way to add work
            that does not belong to a scope the project already has. The per-file
            "+ Add task" row above can only ever add to the file it sits under,
            which is what made "a task for a different scope" unreachable. */}
        {onNewTaskFile !== undefined && (
          <li>
            <button
              type="button"
              onClick={() => onNewTaskFile(project.path)}
              /* `text-indigo-deep`, which is what the artboard gives this
                 control: `Project.dc.html`'s "Create a new task file" is
                 `#4B4BC8`, as are its other text buttons ("Add another
                 account", "Start a new task file instead"). It was `muted-500`
                 here, which reads as another file row rather than as an
                 action. */
              className="trow -mx-1 mt-[6px] flex w-[calc(100%+0.5rem)] items-center gap-2 rounded-[10px] px-[10px] py-[7px] text-left text-[13px] font-[560] text-indigo-deep hover:bg-[#EFEFF2] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo"
            >
              <span
                aria-hidden
                className="grid size-[22px] shrink-0 place-items-center rounded-[7px] border border-dashed border-[#D2D3DA] text-ink"
              >
                <svg viewBox="0 0 24 24" className="ic size-[14px]" {...LINE}>
                  <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
                  <path d="M14 2v4a2 2 0 0 0 2 2h4" />
                  <path d="M12 11v6" />
                  <path d="M9 14h6" />
                </svg>
              </span>
              New task file
            </button>
          </li>
        )}
      </ul>
    </li>
  )
}

function AccountChip({ account }: { account: Account }): ReactElement {
  const label = account.label ?? (account.kind === "unknown" ? "account unknown" : account.kind)
  const look =
    account.kind === "personal"
      ? "bg-account-tint text-account-ink"
      : account.kind === "work"
        ? "bg-ink-soft text-ground"
        : "border border-edge-soft bg-panel-3 text-muted-700"
  return (
    <span
      data-account
      className={`ml-auto inline-flex shrink-0 items-center gap-1 rounded-[6px] py-[2px] pr-[7px] pl-[5px] text-[11.5px] font-[550] ${look}`}
      title={
        account.kind === "unknown"
          ? "kantan cannot tell which Claude account this project runs under"
          : `runs as ${label}`
      }
      aria-label={
        account.kind === "unknown"
          ? "the Claude account for this project is not known"
          : `runs as ${label}`
      }
    >
      <svg aria-hidden viewBox="0 0 24 24" className="ic size-3 shrink-0" {...LINE}>
        {account.kind === "personal" ? (
          <>
            <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </>
        ) : account.kind === "work" ? (
          <>
            <path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
            <rect width="20" height="14" x="2" y="6" rx="2" />
          </>
        ) : (
          <>
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
            <path d="M12 17h.01" />
          </>
        )}
      </svg>
      {label}
    </span>
  )
}

function TaskRow({
  task,
  id,
  selected,
  isStop,
  onSelect,
}: {
  task: TreeTask
  id: TaskId
  selected?: TaskId | null
  /** Is this the tree's one Tab stop? See `Tree`'s `stop`. */
  isStop: boolean
  onSelect?: (task: TaskId) => void
}): ReactElement {
  const state = taskStateOf(task)
  const isSelected = task.ref !== null && isSameTask(selected, id)

  /* The glyph column keeps the spinning arc while a run grinds: the chip is the
     notice, and it rides in the label column (Return.dc.html). */
  const mark = state === "grinding" ? "running" : state
  const ring =
    state === "needs-you"
      ? "shadow-[0_0_0_1px_#FFCFB0,0_4px_14px_-6px_rgba(255,106,26,.45)]"
      : state === "running" || state === "grinding"
        ? "shadow-[0_0_0_1px_#CFD0F7,0_4px_14px_-6px_rgba(91,91,214,.4)]"
        : "shadow-[0_0_0_1px_#E2E2E7,0_4px_14px_-6px_rgba(17,18,22,.18)]"

  /**
   * `items-center`, which is a guess about input and so is enumerated.
   *
   * The dimension is **how many lines the task text wraps to**, which CSS
   * cannot read and the artboard answers by hand: `Main.dc.html` sets
   * `align-items:center` on eight of its nine rows and `align-items:start`
   * (with 10px padding and a `margin-top:1px` on each cell) only on the one
   * row whose text runs to six lines.
   *
   * | Lines | Artboard | `center` | `start` |
   * |---|---|---|---|
   * | 1 (six of nine rows) | centre | exact | glyph, ref and label sit ~5px high in a 44px row |
   * | 2 (two rows) | centre | exact | ~9px high |
   * | 6+ (one row) | start | glyph floats to the middle of the block | exact |
   *
   * So `center` is wrong on the rare row and right on the common one, and the
   * cost is a glyph beside the middle of a paragraph rather than its first
   * line - legible either way. `start` is wrong on nearly every row, and its
   * cost is the whole column reading as top-heavy, which is what it did
   * before this change.
   */
  /* `min-w-0 flex-1` because the row is a flex item beside the remove control.
     Without `min-w-0` a grid child's automatic minimum is its content, so a
     long task title would push the row wider than the column instead of
     wrapping, and the control off the edge. */
  const shape =
    "grid min-w-0 flex-1 min-h-[44px] grid-cols-[18px_22px_minmax(0,1fr)_auto] items-center gap-2 rounded-[10px] py-2 pr-[10px] pl-[14px] text-left text-[13.5px] leading-[1.35]"
  const look = isSelected
    ? `bg-white font-[560] text-ink ${ring}`
    : "trow bg-transparent text-ink-deep hover:bg-[#EFEFF2]"

  const body = (
    <>
      <span data-glyph className="flex h-[18px] items-center justify-center">
        <StateGlyph state={mark} />
      </span>
      <span
        className={`m font-mono text-[11.5px] ${isSelected ? "font-normal" : ""} text-muted-400`}
      >
        {task.ref}
      </span>
      <span className="min-w-0">
        <span data-task-text dir="auto" className={`block ${ARBITRARY}`}>
          {task.text}
        </span>
        {task.run !== undefined && task.run.branch === "" ? (
          /* `TaskStatus.branch` is "" when `branchFor` threw, which means this
             task has no name to own a branch by - so it was never asked about
             a merge. Saying "unmerged" alone would claim a check that did not
             happen. */
          <span data-branch-note className="mt-[2px] block text-[11.5px] text-muted-500">
            No branch name could be derived, so this task was not checked for a merge.
          </span>
        ) : null}
      </span>
      <span data-state-label className="shrink-0 justify-self-end">
        <StateLabel
          state={state}
          exitCode={task.run?.exitCode}
          count={task.run?.testAttempts}
          verification={verificationOf(task.run?.state)}
        />
        {task.ref === null ? (
          <span className="text-[11.5px] text-muted-400" title="A run is addressed by its ref. Add one, like T4, to run this line.">
            no ref
          </span>
        ) : null}
      </span>
    </>
  )

  /* A line with no ref cannot be selected or run - `src/run.ts` refuses it
     rather than inventing a ref - so it is text, not a control. */
  if (task.ref === null) {
    return (
      <div data-task-row className={`${shape} text-ink-deep`}>
        {body}
      </div>
    )
  }

  return (
    <button
      type="button"
      data-task-row
      aria-current={isSelected ? true : undefined}
      /* The tree's one Tab stop. `-1` keeps every other row reachable by `j`,
         `k` and the arrows - `.focus()` works on it - while Tab leaves the
         column rather than walking the whole backlog. */
      tabIndex={isStop ? 0 : -1}
      onClick={onSelect === undefined ? undefined : () => onSelect(id)}
      className={`${shape} ${look} border-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo`}
    >
      {body}
    </button>
  )
}

/** The repo's own directory name, which is what the design shows. */
function repoName(path: string): string {
  const segments = path.split("/").filter((segment) => segment !== "")
  return segments.at(-1) ?? path
}
