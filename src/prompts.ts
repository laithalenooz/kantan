import { BLOCKED, DONE } from "./sentinel"

/**
 * The phase prompts: kantan's actual interface with the agent. Everything else
 * in this project is plumbing around these strings.
 *
 * Three things about them are not style choices.
 *
 * **The sentinel.** `AskUserQuestion` does not exist in `claude -p`, so a
 * question and a completion both exit `result/success` and are indistinguishable
 * by message type (design 3.2). Completion is therefore never inferred from exit
 * status: each prompt requires the agent's **final message** to end with
 * `ORCH: done` or `ORCH: blocked <reason>`. The wording says "final message"
 * rather than "your answer" because a plan-writing agent given looser phrasing
 * has been observed writing the sentinel into the plan file instead of its reply.
 *
 * The two literals come from `src/sentinel.ts`, which parses them, rather than
 * being typed again here. They are the one place the emitting side and the
 * parsing side have to agree exactly, and a one-character drift would make every
 * finished phase read as a question: no exception, no error, every run parked at
 * a gate that should have passed.
 *
 * **The suppressions.** `writing-plans` ends by offering execution choices and
 * asking which. `executing-plans` stops after the first three tasks to report and
 * wait, raises concerns with its human partner, and finishes by running
 * `finishing-a-development-branch`. Every one of those is a human checkpoint, and
 * a checkpoint in headless mode is a silent stall, so each is suppressed by name.
 * The question-and-answer skill is not named anywhere here, not even negatively:
 * naming it is one of the ways it gets loaded, and it would stall every run.
 *
 * **No normalization.** Paths and task text are interpolated exactly as handed in.
 * A plan path is dictated by the server and recorded in the run log's `phase`
 * record, which is what the gate renders, so a prompt that trimmed, slugified or
 * re-encoded it would point the agent at a file nothing else looks for.
 *
 * Prompt text sits at column zero inside the template literals on purpose: what
 * the source shows is what the agent receives, with no dedent pass in between.
 * Phrases the tests pin are kept on one source line for the same reason.
 */

/**
 * What a prompt needs to know about the task. Narrower than `backlog.Task` by
 * design: `ref` is non-optional here, so a ref-less task cannot reach a prompt
 * without someone deciding what its ref is first, and `line` is left out because
 * it is valid only for the string it was parsed from.
 */
export interface TaskSpec {
  /** The `T<n>` label the task is addressed by. */
  ref: string
  text: string
  /** The feature file the task came from, relative to the repo root. */
  featurePath: string
}

/**
 * The contract every phase prompt ends with. Shared so the three cannot drift,
 * and spelled out to the letter because the parser matches the line exactly: it
 * reads `ORCH: Done`, a backticked sentinel, a list item and an indented line all
 * as a question, which parks the run at a human.
 *
 * The blocked form asks for a reason even though the parser accepts the bare
 * prefix with an empty one. A blocked run with no reason stops a human in front
 * of a screen that does not say why.
 */
const HEADLESS_CONTRACT = `## Nobody can answer you

This conversation runs headless. There is no interactive question tool here, and from
outside, a question that waits looks exactly like a finished turn, so a question hangs
the run rather than reaching anyone. Wherever a skill tells you to raise a concern with
your human partner, ask for clarification, check in, or report and wait for feedback:
do not pause and do not ask. Decide it yourself and say what you decided, or end the
turn blocked.

## How to end your turn

When the work above is finished, the last line of your final message must be exactly:

${DONE}

When you cannot finish it, the last line of your final message must instead be:

${BLOCKED} <one line saying what is in the way>

Use that second form instead of asking a question; a human reads it and replies.

The line is matched literally, so:

- It is the very last line of your final message, with nothing after it at all: no
  sign-off, no further prose, no closing code fence. It is the last thing you write.
- It begins at column zero, with no indentation, no list marker, no backticks, no bold
  and no trailing period.
- Lowercase after the colon, and exactly one space after the colon.
- When you are blocked, always say why on that same line. It is accepted with no reason
  at all, and then the human reading it has nothing to go on.
- Do not quote this contract back to me anywhere in your final message. Just write the
  line.
- Never write that line into a file: not into the plan, not into the code, not into a
  commit message. It belongs in your message to me and nowhere else.`

/**
 * The plan phase. One task in, one plan file out, at the path the server
 * dictated. Nothing is implemented and no test is run: the human at the gate
 * reads the plan before any code exists.
 *
 * Invoked as a slash command on the first line. That is the form `docs/probes/
 * probeAB.mjs` probed, where the skill loaded and the turn ran headless without
 * stalling, and it is consistent with the 2026-10-11 capture, which announced the
 * skill with no `Skill` tool_use of its own. Two differences from the probe are
 * untested: the arguments here run over many lines rather than one, and the
 * capture's own prompt text was not kept, so this wording is new.
 */
export function planPrompt({ task, planPath }: { task: TaskSpec; planPath: string }): string {
  return `/superpowers:writing-plans Write an implementation plan for one backlog task, exactly as instructed below.

## The task

- Ref: ${task.ref}
- Feature file: ${task.featurePath}
- Task: ${task.text}

Read the feature file for the surrounding context, and read whatever code the task
touches.

## Where the plan goes

Write the plan to exactly this path, relative to the repository root:

${planPath}

That path is dictated, and it overrides the skill's own naming convention. A human
reviews that exact file next and nothing else is read in its place, so a plan saved
under a name you preferred is invisible and the run stalls. Do not rename it, do not
move it, do not add a date, prefix or suffix of your own, and do not create a second
plan file alongside it.

## This turn plans, and does nothing else

- Do not implement any part of the task: no production code, no test code, no fixtures,
  no scaffolding.
- Do not run the test suite, a single test, a linter or a build.
- Do not offer me a choice of execution modes, and do not ask which execution mode,
  session or approach to use. That is already decided: a separate conversation will
  execute this plan inline, and asking would stall this run.
- Work in the checkout as you find it. Do not create a worktree, do not create or
  switch branches, and do not run \`superpowers:finishing-a-development-branch\`.
- Do not include a step that ticks the task's checkbox, or that edits
  ${task.featurePath} in any other way. The orchestrator records the task as done
  itself, and only after it has run the project's test command and seen it pass by exit
  code. A plan step that ticks the box would mark the task done on a failing build.
- Write for an engineer who has no context for this codebase and cannot see this
  conversation: the plan file is the whole handoff, so a decision you make here and
  leave unwritten is lost. Where the task leaves a choice open, make the most
  reasonable one and record it in the plan.

## Commit

Commit the plan file on the branch that is already checked out, so the gate does not
sit on a dirty tree. Commit nothing else: name the plan file as a pathspec rather than
staging everything, because the tree may hold work that is not yours.

${HEADLESS_CONTRACT}
`
}

/**
 * The implement phase. A separate conversation from the plan (design 3.1), which
 * is what lets the two phases run different models, and which means this prompt
 * inherits no context: the plan file is the entire brief.
 *
 * It does not mention the checkbox at all. The server owns the tick, after the
 * test command passes by exit code (design 3.3), and an agent that ticks does so
 * before verification. The rule is carried instead as "leave the feature file
 * alone", which also neutralises the tick step that `writing-plans` tends to put
 * into the plan the agent is reading.
 */
export function implementPrompt({ task, planPath }: { task: TaskSpec; planPath: string }): string {
  return `/superpowers:executing-plans Implement one backlog task from the approved plan named below, exactly as instructed.

## The plan

A human has already reviewed and approved this plan:

${planPath}

Read it first. You have not seen the conversation that wrote it and cannot ask it
anything, so that file plus the code are your whole brief. It is the plan for ${task.ref},
which came from ${task.featurePath}, and reads: ${task.text}

Use \`superpowers:test-driven-development\` for every change: the failing test first,
watch it fail, then the smallest code that makes it pass.

## Execute it inline, in this conversation, to the end

- Work through every task in the plan, not just the first batch. Do not pause between batches
  to report and wait for feedback, and do not stop to have the plan reviewed. Nobody is
  waiting to answer, and a pause here stalls the run.
- Execute the plan yourself, here, inline. Do not ask which execution mode to use, do
  not offer me execution options, and do not hand the work to a subagent or to another
  session.
- If a step is wrong, or does not fit what you find in the code, do the smallest thing
  that makes it work and say what you changed in your final message. Do not come back
  to ask first.

## The branch, the commits, and what to leave alone

- Commit your work on the branch that is already checked out. Do not create a branch, do
  not switch branches, do not create a worktree, do not merge, do not rebase, do not push,
  do not open a pull request, and do not run \`superpowers:finishing-a-development-branch\`.
- Commit as you go, naming the files you changed as a pathspec rather than staging
  everything, because the tree may hold work that is not yours.
- Leave ${task.featurePath} exactly as it is, and skip any step in the plan that would edit
  it or change ${task.ref}'s line in it. The orchestrator runs the project's test command
  itself and records the outcome from the exit code; it never takes an agent's word for a
  passing build. Editing that file can only put the backlog out of step with what was
  actually verified.

${HEADLESS_CONTRACT}
`
}

/**
 * Gate rejection. This resumes the **plan** session (design 3.1), so the task,
 * the feature file and the first turn's instructions are all still in context.
 * It is written as a continuation for that reason: restating the task would
 * invite a fresh plan instead of a revision of the one the human just read, and
 * re-invoking the skill would restart planning outright.
 */
export function feedbackPrompt({
  planPath,
  feedback,
}: {
  planPath: string
  feedback: string
}): string {
  return `A human read that plan at the gate and did not approve it. Their feedback, verbatim:

${feedback}

Revise the plan to answer it. Keep working in the same file, at the same path:

${planPath}

Rewrite the parts the feedback touches, rather than appending a change log or a
revision history, and leave the rest of the plan as it stands. Then commit that file on
the branch already checked out, and nothing else.

Everything from the first turn still applies: plan only, do not implement anything, run
no tests, leave the backlog file alone, do not offer or ask which execution mode to use,
and do not run \`superpowers:finishing-a-development-branch\`.

${HEADLESS_CONTRACT}
`
}
