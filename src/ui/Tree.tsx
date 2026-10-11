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

import type { ReactElement, ReactNode } from "react"

/* Type-only, and deliberately so: `src/runindex.ts` opens files at module
 * scope, so a value import would drag `node:fs/promises` into the browser
 * bundle. The type is borrowed rather than restated, so a change to a run's
 * state becomes a compile error here instead of a row that quietly renders as
 * something else. */
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

export interface TreeFeature {
  /** The path as the project lists it, shown verbatim and never shortened. */
  path: string
  tasks: TreeTask[]
}

export interface TreeProject {
  /** Repo root, absolute. The project's identity. */
  path: string
  account: Account
  /** e.g. `npm test`. Printed under the repo name as the design shows it. */
  testCmd: string
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

/**
 * The two keyframes the design names, which `tokens.css` does not carry.
 *
 * Rendered once by `Tree`, so a `StateGlyph` used outside a tree needs these
 * two keyframes in scope to animate. The reduced-motion guard is repeated here
 * rather than left to `tokens.css`, so the component is correct on its own.
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
        <svg aria-hidden viewBox="0 0 24 24" className={`kantan-spin ${ICON}`}>
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
          className="kantan-pulse size-[14px] shrink-0 rounded-full bg-attention"
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
          className={`text-[#0E7C86] ${ICON}`}
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
          className={`text-[#64748B] ${ICON}`}
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
            className="size-[11px] shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
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
}: {
  state: TaskState
  /** Printed as ` · exit <n>` beside Passed and Failed. Never invented. */
  exitCode?: number
  /** Test attempts inside the run, for the grinding chip. */
  count?: number
}): ReactElement {
  const exit: ReactNode =
    exitCode === undefined ? null : (
      <>
        {" · "}
        <span className="font-mono">exit {exitCode}</span>
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
      return (
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
}

/**
 * Projects, their feature files, and every task's state.
 *
 * There is no start control here, and that is deliberate: the tree picks the
 * task, and the centre column acts on it. A caller offering a start must ask
 * `canStart` first - `done-unmerged`, `passed`, `failed` and `interrupted` all
 * own a branch already, and `interrupted` wants `canResume` instead.
 */
export function Tree({
  projects,
  selected,
  onSelect,
  onAddProject,
}: TreeProps): ReactElement {
  const eyebrow = "text-[11.5px] font-semibold uppercase tracking-[.07em] text-muted-400"

  if (projects.length === 0) {
    return (
      <aside
        aria-label="Projects and tasks"
        className="box-border basis-72 grow border-r border-edge bg-panel px-[18px] pt-4 pb-7"
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
      aria-label="Projects and tasks"
      className="box-border basis-72 grow border-r border-edge bg-panel px-[10px] pt-4 pb-7"
    >
      {/* The two keyframes the design names and `tokens.css` does not carry.
          Rendered here, once, because this file may not edit the token layer. */}
      <style>{MOTION_CSS}</style>

      <div className="flex items-center justify-between px-2 pb-[6px]">
        <span className={eyebrow}>Projects</span>
        {onAddProject === undefined ? null : (
          <button
            type="button"
            aria-label="Add a repository"
            onClick={onAddProject}
            className="grid size-[30px] place-items-center rounded-[9px] border border-edge-soft bg-white text-muted-900 hover:bg-[#F6F6F8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo"
          >
            <svg aria-hidden viewBox="0 0 24 24" className="size-[15px]" {...LINE}>
              <path d="M5 12h14" />
              <path d="M12 5v14" />
            </svg>
          </button>
        )}
      </div>

      {projects.map((project, index) => (
        <ProjectBlock
          key={project.path}
          project={project}
          first={index === 0}
          selected={selected}
          onSelect={onSelect}
        />
      ))}
    </aside>
  )
}

function ProjectBlock({
  project,
  first,
  selected,
  onSelect,
}: {
  project: TreeProject
  first: boolean
  selected?: TaskId | null
  onSelect?: (task: TaskId) => void
}): ReactElement {
  return (
    <div className={first ? undefined : "mt-[6px] border-t border-[#ECECEF]"}>
      <div className="flex items-start gap-2 px-[10px] pt-[14px] pb-[2px]">
        <svg aria-hidden viewBox="0 0 24 24" className="mt-[2px] size-4 shrink-0 text-muted-400" {...LINE}>
          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
        </svg>
        {/* The repo's own directory name. `title` carries the whole path, which
            is longer than this column and is not what the design shows. */}
        <span data-repo title={project.path} className={`${ARBITRARY} text-sm font-[620]`}>
          {repoName(project.path)}
        </span>
        <AccountChip account={project.account} />
      </div>

      <div
        data-test-cmd
        className={`${ARBITRARY} pr-[10px] pb-[6px] pl-[34px] font-mono text-xs text-muted-400`}
      >
        $ {project.testCmd}
      </div>

      {project.features.map((feature, index) => (
        <div key={feature.path}>
          <div
            className={`flex items-start gap-[6px] ${index === 0 ? "pt-[6px]" : "pt-[10px]"} pr-[10px] pb-[4px] pl-[14px] font-mono text-xs text-muted-500`}
          >
            <svg aria-hidden viewBox="0 0 24 24" className="mt-[3px] size-[13px] shrink-0" {...LINE}>
              <path d="m6 9 6 6 6-6" />
            </svg>
            <span data-feature-path className={ARBITRARY}>
              {feature.path}
            </span>
          </div>

          {feature.tasks.map((task, position) => (
            <TaskRow
              key={`${feature.path}\u0000${task.ref ?? `#${position}`}`}
              task={task}
              id={{
                projectPath: project.path,
                featureFile: feature.path,
                taskRef: task.ref,
              }}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </div>
      ))}
    </div>
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
      <svg aria-hidden viewBox="0 0 24 24" className="size-3 shrink-0" {...LINE}>
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
  onSelect,
}: {
  task: TreeTask
  id: TaskId
  selected?: TaskId | null
  onSelect?: (task: TaskId) => void
}): ReactElement {
  const state = taskStateOf(task)
  const isSelected =
    task.ref !== null &&
    selected != null &&
    selected.projectPath === id.projectPath &&
    selected.featureFile === id.featureFile &&
    selected.taskRef === task.ref

  /* The glyph column keeps the spinning arc while a run grinds: the chip is the
     notice, and it rides in the label column (Return.dc.html). */
  const mark = state === "grinding" ? "running" : state
  const ring =
    state === "needs-you"
      ? "shadow-[0_0_0_1px_#FFCFB0,0_4px_14px_-6px_rgba(255,106,26,.45)]"
      : state === "running" || state === "grinding"
        ? "shadow-[0_0_0_1px_#CFD0F7,0_4px_14px_-6px_rgba(91,91,214,.4)]"
        : "shadow-[0_0_0_1px_#E2E2E7,0_4px_14px_-6px_rgba(17,18,22,.18)]"

  const shape =
    "grid w-full min-h-[44px] grid-cols-[18px_22px_minmax(0,1fr)_auto] items-start gap-2 rounded-[10px] py-2 pr-[10px] pl-[14px] text-left text-[13.5px] leading-[1.35]"
  const look = isSelected
    ? `bg-white font-[560] text-ink ${ring}`
    : "bg-transparent text-ink-deep hover:bg-[#EFEFF2]"

  const body = (
    <>
      <span data-glyph className="flex h-[18px] items-center justify-center">
        <StateGlyph state={mark} />
      </span>
      <span
        className={`mt-[1px] font-mono text-[11.5px] ${isSelected ? "font-normal" : ""} text-muted-400`}
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
      <span data-state-label className="mt-[1px] shrink-0 justify-self-end">
        <StateLabel state={state} exitCode={task.run?.exitCode} count={task.run?.testAttempts} />
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
