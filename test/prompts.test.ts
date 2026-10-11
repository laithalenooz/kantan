import { expect, test } from "bun:test"
import { feedbackPrompt, implementPrompt, planPrompt, type TaskSpec } from "../src/prompts"
import { BLOCKED, DONE, phaseOutcome } from "../src/sentinel"

const task: TaskSpec = {
  ref: "T1",
  text: "make slug() strip punctuation and collapse spaces to dashes",
  featurePath: "docs/features/slugger.md",
}

/** The path the server dictates. The date and the slug come from the caller, so
 * nothing here derives either. */
const planPath = "docs/plans/2026-10-11-t1-slugger.md"

const plan = planPrompt({ task, planPath })
const implement = implementPrompt({ task, planPath })
const feedback = feedbackPrompt({
  planPath,
  feedback: "Step 3 reads the file twice. Collapse it, and say what happens on a CRLF file.",
})

/** Every prompt that reaches the CLI, so a contract that must hold for all of
 * them is asserted once over the set rather than three times by hand. */
const ALL = [
  ["plan", plan],
  ["implement", implement],
  ["feedback", feedback],
] as const

/**
 * The prompt with its line wrapping flattened. The prompts are hard-wrapped, so
 * a phrase assertion against the raw string would also pin where the line breaks
 * happen to fall, and a harmless reflow would fail a test about wording.
 * Assertions that care about position - the sentinel lines, the leading slash
 * command - use the raw string instead.
 */
const flat = (prompt: string) => prompt.replace(/\s+/g, " ")

/**
 * The sentinel lines a prompt dictates: the ones it shows at column zero, which
 * is the only place the parser accepts them. Found by the imported literals
 * rather than by a hand-typed string, so a drift on either side empties this
 * list instead of being matched by a stale copy of the old value.
 */
const dictatedSentinelLines = (prompt: string) =>
  prompt.split("\n").filter((line) => line.startsWith(DONE) || line.startsWith(BLOCKED))

// --- the plan path the gate renders ---------------------------------------

test("the plan prompt names the dictated plan path", () => {
  expect(plan).toContain(planPath)
})

test("the plan prompt says the dictated path overrides the skill's own convention", () => {
  // `writing-plans` says "Save plans to: docs/plans/YYYY-MM-DD-<feature-name>.md".
  // The gate renders the path from the run log's `phase` record, so a plan
  // written to a name the agent liked better is invisible.
  expect(flat(plan)).toMatch(/exactly this path/i)
})

test("a plan path with a space in the slug survives intact", () => {
  const spaced = "docs/plans/2026-10-11-t2 two words.md"
  expect(planPrompt({ task, planPath: spaced })).toContain(spaced)
})

test("a plan path with unicode in the slug survives intact", () => {
  const unicode = "docs/plans/2026-10-11-café-résumé-日本語.md"
  expect(planPrompt({ task, planPath: unicode })).toContain(unicode)
})

test("the plan prompt states the task ref, its text and the feature file", () => {
  expect(plan).toContain(task.ref)
  expect(plan).toContain(task.text)
  expect(plan).toContain(task.featurePath)
})

// --- the sentinel contract, design 3.2 ------------------------------------

for (const [name, prompt] of ALL) {
  test(`the ${name} prompt dictates exactly the two lines the parser accepts`, () => {
    // The one place the emitting side and the parsing side must agree to the
    // character. A drift either way leaves every finished phase reading as a
    // question, so every run stops at a gate that should have passed, and
    // nothing throws. Both lines therefore go back through the real parser.
    const dictated = dictatedSentinelLines(prompt)
    expect(dictated).toHaveLength(2)
    const [doneLine = "", blockedLine = ""] = dictated

    expect(doneLine).toBe(DONE)
    expect(phaseOutcome({ subtype: "success", is_error: false, result: `Wrote it.\n\n${doneLine}` })).toEqual({
      state: "done",
    })

    expect(blockedLine.startsWith(`${BLOCKED} `)).toBe(true)
    const blocked = `${BLOCKED} the test suite needs a database`
    expect(phaseOutcome({ subtype: "success", is_error: false, result: `Tried twice.\n\n${blocked}` })).toEqual({
      state: "blocked",
      reason: "the test suite needs a database",
    })
  })

  test(`the ${name} prompt shows the sentinel at column zero, on a line of its own`, () => {
    // Leading whitespace is rejected by the parser, so the example in the prompt
    // must not be indented either.
    expect(prompt).toContain(`\n${DONE}\n`)
    expect(prompt).toContain(`\n${BLOCKED} `)
  })

  test(`the ${name} prompt puts the sentinel on the last line of the final message`, () => {
    // Both halves matter. "final message" is what keeps a plan-writing agent
    // from putting the sentinel into the artefact instead of its reply, and
    // "last line" is what the parser matches.
    expect(flat(prompt)).toMatch(/last line of your final message/i)
  })

  test(`the ${name} prompt says the sentinel is the last thing written`, () => {
    // A sentinel followed by one more line of prose is parsed as a question.
    expect(flat(prompt)).toMatch(/nothing after it/i)
    expect(flat(prompt)).toMatch(/last thing you write/i)
  })

  test(`the ${name} prompt forbids writing the sentinel into a file`, () => {
    expect(flat(prompt)).toMatch(/never write that line into a file/i)
  })

  test(`the ${name} prompt rules out the near misses the parser rejects`, () => {
    // `ORCH: Done`, `` `ORCH: done` ``, `- ORCH: done`, `ORCH: done.` and an
    // indented line are all read as a question.
    expect(flat(prompt)).toMatch(/no backticks/i)
    expect(flat(prompt)).toMatch(/no list marker/i)
    expect(flat(prompt)).toMatch(/no trailing period/i)
    expect(flat(prompt)).toMatch(/lowercase after the colon/i)
    expect(flat(prompt)).toMatch(/one space after the colon/i)
  })

  test(`the ${name} prompt offers the sentinel in place of a question`, () => {
    expect(flat(prompt)).toMatch(/instead of asking/i)
  })

  test(`the ${name} prompt asks for a reason when blocked`, () => {
    // The parser accepts a bare `ORCH: blocked` with an empty reason, so nothing
    // downstream can require one. Only the prompt can.
    expect(flat(prompt)).toMatch(/always say why/i)
  })

  // A question-and-answer skill would stall every run, so the name is absent
  // rather than negated: naming it at all is one of the ways it gets loaded.
  test(`the ${name} prompt does not mention the question-and-answer skill`, () => {
    expect(prompt.toLowerCase()).not.toContain("brainstorm")
  })

  test(`the ${name} prompt refuses to pause for a human`, () => {
    expect(flat(prompt)).toMatch(/do not pause/i)
  })

  test(`the ${name} prompt forbids finishing-a-development-branch`, () => {
    expect(prompt).toContain("superpowers:finishing-a-development-branch")
    expect(flat(prompt)).toMatch(/do not run `?superpowers:finishing-a-development-branch/i)
  })

  test(`the ${name} prompt forbids asking which execution mode to use`, () => {
    expect(flat(prompt)).toMatch(/execution mode/i)
  })
}

// --- the plan phase plans, and only plans ---------------------------------

test("the plan prompt invokes writing-plans", () => {
  expect(plan.startsWith("/superpowers:writing-plans")).toBe(true)
})

test("the plan prompt forbids implementing", () => {
  expect(flat(plan)).toMatch(/do not implement any part of the task/i)
})

test("the plan prompt forbids running the tests", () => {
  expect(flat(plan)).toMatch(/do not run the test suite/i)
})

test("the plan prompt forbids offering execution options", () => {
  // `writing-plans` ends by offering two execution modes and asking which. In
  // headless mode that question exits `success` with no error.
  expect(flat(plan)).toMatch(/do not offer me a choice of execution modes/i)
})

test("the plan prompt keeps the plan itself from editing the backlog", () => {
  expect(plan).toContain(task.featurePath)
  expect(flat(plan)).toMatch(/do not include a step/i)
})

// --- the implement phase --------------------------------------------------

test("the implement prompt invokes executing-plans", () => {
  expect(implement.startsWith("/superpowers:executing-plans")).toBe(true)
})

test("the implement prompt invokes test-driven-development", () => {
  expect(implement).toContain("superpowers:test-driven-development")
})

test("the implement prompt carries the plan file path", () => {
  // Design 3.1: implement is a separate conversation. It inherits no context and
  // cannot see the planning discussion, so the path is all it has.
  expect(implement).toContain(planPath)
})

test("the implement prompt says it has not seen the planning conversation", () => {
  expect(flat(implement)).toMatch(/have not seen the conversation that wrote it/i)
})

test("the implement prompt forbids pausing between batches", () => {
  expect(flat(implement)).toMatch(/do not pause between batches/i)
})

test("the implement prompt requires every task, not just the first batch", () => {
  // `executing-plans` does the first three tasks and then waits for feedback.
  expect(flat(implement)).toMatch(/every task in the plan, not just the first batch/i)
})

test("the implement prompt says to execute inline", () => {
  expect(flat(implement)).toMatch(/execute the plan yourself, here, inline/i)
})

test("the implement prompt tells the agent to commit on the current branch", () => {
  expect(flat(implement)).toMatch(/commit your work on the branch that is already checked out/i)
  expect(flat(implement)).toMatch(/do not create a branch/i)
})

test("the implement prompt contains no instruction to tick a checkbox", () => {
  // The server owns the tick, and only after the test command passes by exit
  // code (design 3.3). An agent that ticks does so before verification and would
  // mark a task done on a failing build. The prohibition is worded without this
  // vocabulary on purpose, so this assertion can stay blunt. `\b` on `tick`
  // because the sentinel rules say "no backticks".
  expect(implement).not.toMatch(/\btick|checkbox|check(ed|ing)?\s+(it\s+)?off|\[x\]/i)
  expect(implement).not.toMatch(/mark\w*\b[^.\n]*\b(done|complete)/i)
})

test("the implement prompt forbids editing the feature file at all", () => {
  // Which is how the no-tick rule is carried: the real capture's plan contained
  // a "tick T1 in docs/features/slugger.md" step, so the plan this agent reads
  // will often ask for one.
  expect(implement).toContain(task.featurePath)
  expect(flat(implement)).toMatch(/leave docs\/features\/slugger\.md exactly as it is/i)
  expect(flat(implement)).toMatch(/skip any step in the plan that would edit it/i)
})

// --- gate feedback resumes the plan conversation --------------------------

test("the feedback prompt carries the feedback verbatim", () => {
  const text = 'Two spaces  and a trailing tab\tand a "quote" - keep it byte for byte.'
  expect(feedbackPrompt({ planPath, feedback: text })).toContain(text)
})

test("the feedback prompt names the same plan path", () => {
  expect(feedback).toContain(planPath)
})

test("the feedback prompt reads as a continuation, not a restatement", () => {
  // It resumes the plan session, which still holds the task, the feature file
  // and the first turn's instructions.
  expect(feedback).not.toContain(task.text)
  expect(feedback).not.toContain(task.featurePath)
  expect(flat(feedback)).toMatch(/everything from the first turn still applies/i)
})

test("the feedback prompt does not re-invoke writing-plans", () => {
  // Re-invoking the skill in a resumed conversation restarts planning from
  // scratch instead of revising the plan the human just read.
  expect(feedback).not.toContain("/superpowers:writing-plans")
})

test("the feedback prompt keeps the plan-only suppressions", () => {
  expect(flat(feedback)).toMatch(/do not implement anything/i)
  expect(flat(feedback)).toMatch(/run no tests/i)
})

// --- snapshots ------------------------------------------------------------
//
// These strings are the project's interface with the agent; everything else is
// plumbing around them. The snapshots exist so that editing one is a reviewed
// act rather than an incidental one. They are inline rather than in
// `test/__snapshots__/`, because an uncommitted `.snap` file is regenerated on a
// fresh checkout and then pins nothing at all.
//
// If one of these fails, read the diff before updating it. This wording was
// validated against the real CLI on 2026-10-11: the agent emitted `ORCH: done`
// as its final line, wrote the plan to the dictated path, implemented nothing,
// and did not stall.

test("the plan prompt is unchanged", () => {
  expect(plan).toMatchInlineSnapshot(`
    "/superpowers:writing-plans Write an implementation plan for one backlog task, exactly as instructed below.

    ## The task

    - Ref: T1
    - Feature file: docs/features/slugger.md
    - Task: make slug() strip punctuation and collapse spaces to dashes

    Read the feature file for the surrounding context, and read whatever code the task
    touches.

    ## Where the plan goes

    Write the plan to exactly this path, relative to the repository root:

    docs/plans/2026-10-11-t1-slugger.md

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
      docs/features/slugger.md in any other way. The orchestrator records the task as done
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

    ## Nobody can answer you

    This conversation runs headless. There is no interactive question tool here, and from
    outside, a question that waits looks exactly like a finished turn, so a question hangs
    the run rather than reaching anyone. Wherever a skill tells you to raise a concern with
    your human partner, ask for clarification, check in, or report and wait for feedback:
    do not pause and do not ask. Decide it yourself and say what you decided, or end the
    turn blocked.

    ## How to end your turn

    When the work above is finished, the last line of your final message must be exactly:

    ORCH: done

    When you cannot finish it, the last line of your final message must instead be:

    ORCH: blocked <one line saying what is in the way>

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
      commit message. It belongs in your message to me and nowhere else.
    "
  `)
})

test("the implement prompt is unchanged", () => {
  expect(implement).toMatchInlineSnapshot(`
    "/superpowers:executing-plans Implement one backlog task from the approved plan named below, exactly as instructed.

    ## The plan

    A human has already reviewed and approved this plan:

    docs/plans/2026-10-11-t1-slugger.md

    Read it first. You have not seen the conversation that wrote it and cannot ask it
    anything, so that file plus the code are your whole brief. It is the plan for T1,
    which came from docs/features/slugger.md, and reads: make slug() strip punctuation and collapse spaces to dashes

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
    - Leave docs/features/slugger.md exactly as it is, and skip any step in the plan that would edit
      it or change T1's line in it. The orchestrator runs the project's test command
      itself and records the outcome from the exit code; it never takes an agent's word for a
      passing build. Editing that file can only put the backlog out of step with what was
      actually verified.

    ## Nobody can answer you

    This conversation runs headless. There is no interactive question tool here, and from
    outside, a question that waits looks exactly like a finished turn, so a question hangs
    the run rather than reaching anyone. Wherever a skill tells you to raise a concern with
    your human partner, ask for clarification, check in, or report and wait for feedback:
    do not pause and do not ask. Decide it yourself and say what you decided, or end the
    turn blocked.

    ## How to end your turn

    When the work above is finished, the last line of your final message must be exactly:

    ORCH: done

    When you cannot finish it, the last line of your final message must instead be:

    ORCH: blocked <one line saying what is in the way>

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
      commit message. It belongs in your message to me and nowhere else.
    "
  `)
})

test("the feedback prompt is unchanged", () => {
  expect(feedback).toMatchInlineSnapshot(`
    "A human read that plan at the gate and did not approve it. Their feedback, verbatim:

    Step 3 reads the file twice. Collapse it, and say what happens on a CRLF file.

    Revise the plan to answer it. Keep working in the same file, at the same path:

    docs/plans/2026-10-11-t1-slugger.md

    Rewrite the parts the feedback touches, rather than appending a change log or a
    revision history, and leave the rest of the plan as it stands. Then commit that file on
    the branch already checked out, and nothing else.

    Everything from the first turn still applies: plan only, do not implement anything, run
    no tests, leave the backlog file alone, do not offer or ask which execution mode to use,
    and do not run \`superpowers:finishing-a-development-branch\`.

    ## Nobody can answer you

    This conversation runs headless. There is no interactive question tool here, and from
    outside, a question that waits looks exactly like a finished turn, so a question hangs
    the run rather than reaching anyone. Wherever a skill tells you to raise a concern with
    your human partner, ask for clarification, check in, or report and wait for feedback:
    do not pause and do not ask. Decide it yourself and say what you decided, or end the
    turn blocked.

    ## How to end your turn

    When the work above is finished, the last line of your final message must be exactly:

    ORCH: done

    When you cannot finish it, the last line of your final message must instead be:

    ORCH: blocked <one line saying what is in the way>

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
      commit message. It belongs in your message to me and nowhere else.
    "
  `)
})
