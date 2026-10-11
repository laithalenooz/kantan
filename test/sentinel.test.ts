import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { phaseOutcome, type Outcome, type ResultEvent } from "../src/sentinel"

const FIXTURES = new URL("./fixtures/", import.meta.url)

/**
 * The terminal `result` event of a captured stream, read straight out of the
 * fixture.
 *
 * Deliberately not routed through a stream parser: Task 6 owns that, and a unit
 * that depends on it could not fail on its own. Two lines of JSON.parse here
 * buy independence from a module another task is still writing.
 */
function resultEvent(fixture: string): ResultEvent {
  const text = readFileSync(new URL(fixture, FIXTURES), "utf8")
  const results: ResultEvent[] = []
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue
    const event = JSON.parse(line) as ResultEvent & { type: string }
    if (event.type === "result") results.push(event)
  }
  const last = results.at(-1)
  if (!last) throw new Error(`${fixture} carries no result event`)
  return last
}

/** The last non-empty line, as the detector sees it. For pinning fixture facts. */
function finalLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l !== "")
      .at(-1) ?? ""
  )
}

// ---------------------------------------------------------------------------
// The three real captures
// ---------------------------------------------------------------------------

test("plan-success ends the phase, because its final line is the done sentinel", () => {
  const event = resultEvent("plan-success.jsonl")
  // Pin the fixture fact the assertion below depends on, so a recapture that
  // loses the sentinel fails here rather than somewhere confusing.
  expect(event.subtype).toBe("success")
  expect(finalLine(event.result ?? "")).toBe("ORCH: done")

  expect(phaseOutcome(event)).toEqual({ state: "done" })
})

test("ends-with-question is a question, and carries the prose verbatim", () => {
  const event = resultEvent("ends-with-question.jsonl")
  // It exits success with no sentinel, and its last line ends in a period, not
  // a question mark. Both halves of why exit status can never mean completion.
  expect(event.subtype).toBe("success")
  expect(event.is_error).toBe(false)
  expect(finalLine(event.result ?? "")).toMatch(/retry it with the same question\.$/)

  expect(phaseOutcome(event)).toEqual({ state: "question", text: event.result ?? "" })
})

test("budget-exhausted is failed, and the absent result text does not throw", () => {
  const event = resultEvent("budget-exhausted.jsonl")
  // The capture has no `result` key at all. HANDOFF.md and the fixture README
  // both call it an empty string; it is absent. Anything reading it must cope
  // with undefined, not just "".
  expect("result" in event).toBe(false)
  expect(event.is_error).toBe(true)

  expect(phaseOutcome(event)).toEqual({ state: "failed", subtype: "error_max_budget_usd" })
})

test("an errored subtype outranks a done sentinel in the same turn", () => {
  const real = resultEvent("budget-exhausted.jsonl")
  expect(phaseOutcome({ ...real, result: "wrote the plan\n\nORCH: done" })).toEqual({
    state: "failed",
    subtype: "error_max_budget_usd",
  })
})

// ---------------------------------------------------------------------------
// The final-line enumeration. One dimension: the final non-empty line of the
// result text. Every value it can take, including ones no capture produces.
// ---------------------------------------------------------------------------

interface FinalLineCase {
  readonly name: string
  readonly text: string
  readonly want: Outcome
}

const DONE = "ORCH: done"

const FINAL_LINE_CASES: readonly FinalLineCase[] = [
  // --- accepted as done ---
  { name: "exactly the sentinel, alone", text: DONE, want: { state: "done" } },
  { name: "the sentinel after prose", text: `Wrote the plan.\n\n${DONE}`, want: { state: "done" } },
  { name: "trailing spaces", text: `${DONE}   `, want: { state: "done" } },
  { name: "a trailing tab", text: `${DONE}\t`, want: { state: "done" } },
  { name: "a CRLF ending", text: `done\r\n${DONE}\r\n`, want: { state: "done" } },
  { name: "trailing blank lines", text: `${DONE}\n\n\n`, want: { state: "done" } },
  { name: "trailing whitespace-only lines", text: `${DONE}\n   \n\t\n`, want: { state: "done" } },

  // --- accepted as blocked ---
  {
    name: "blocked with a reason",
    text: "Tried twice.\n\nORCH: blocked the test suite needs a database",
    want: { state: "blocked", reason: "the test suite needs a database" },
  },
  {
    name: "blocked with a reason padded by whitespace and a CR",
    text: "ORCH: blocked \tno network access  \r",
    want: { state: "blocked", reason: "no network access" },
  },
  { name: "blocked with no reason at all", text: "ORCH: blocked", want: { state: "blocked", reason: "" } },
  { name: "blocked with no reason, CRLF", text: "ORCH: blocked\r\n", want: { state: "blocked", reason: "" } },

  // --- rejected: the sentinel is not the whole final line ---
  { name: "the sentinel followed by prose on the same line", text: `${DONE} now`, want: { state: "question", text: `${DONE} now` } },
  {
    name: "the sentinel followed by a further line of prose",
    text: `${DONE}\nBut should I also bump the version?`,
    want: { state: "question", text: `${DONE}\nBut should I also bump the version?` },
  },
  {
    name: "the sentinel mid-paragraph",
    text: `I will finish with ${DONE} once you tell me which name to use.`,
    want: { state: "question", text: `I will finish with ${DONE} once you tell me which name to use.` },
  },
  {
    name: "the sentinel quoted back from the instructions, mid-text",
    text: `The contract says my last line must be "${DONE}".\n\nWhich of the two layouts do you want?`,
    want: {
      state: "question",
      text: `The contract says my last line must be "${DONE}".\n\nWhich of the two layouts do you want?`,
    },
  },
  {
    name: "the sentinel inside a fenced block at the end of a plan",
    text: `Plan written. The contract is:\n\n\`\`\`\n${DONE}\n\`\`\``,
    want: { state: "question", text: `Plan written. The contract is:\n\n\`\`\`\n${DONE}\n\`\`\`` },
  },

  // --- rejected: a near miss on the literal ---
  { name: "leading spaces, which markdown reads as a code block", text: `    ${DONE}`, want: { state: "question", text: `    ${DONE}` } },
  { name: "a leading tab", text: `\t${DONE}`, want: { state: "question", text: `\t${DONE}` } },
  { name: "lowercase", text: "orch: done", want: { state: "question", text: "orch: done" } },
  { name: "title case", text: "ORCH: Done", want: { state: "question", text: "ORCH: Done" } },
  { name: "shouted", text: "ORCH: DONE", want: { state: "question", text: "ORCH: DONE" } },
  { name: "no space after the colon", text: "ORCH:done", want: { state: "question", text: "ORCH:done" } },
  { name: "two spaces after the colon", text: "ORCH:  done", want: { state: "question", text: "ORCH:  done" } },
  { name: "a trailing period", text: `${DONE}.`, want: { state: "question", text: `${DONE}.` } },
  { name: "wrapped in backticks", text: `\`${DONE}\``, want: { state: "question", text: `\`${DONE}\`` } },
  { name: "bolded", text: `**${DONE}**`, want: { state: "question", text: `**${DONE}**` } },
  { name: "as a list item", text: `- ${DONE}`, want: { state: "question", text: `- ${DONE}` } },
  { name: "blocked run onto its reason with no separator", text: "ORCH: blockedfoo", want: { state: "question", text: "ORCH: blockedfoo" } },
  { name: "blocked, lowercase", text: "orch: blocked no network", want: { state: "question", text: "orch: blocked no network" } },

  // --- rejected: nothing to match ---
  { name: "an empty string", text: "", want: { state: "question", text: "" } },
  { name: "whitespace only", text: "   \n\t\n  ", want: { state: "question", text: "   \n\t\n  " } },
  { name: "newlines only", text: "\n\n", want: { state: "question", text: "\n\n" } },
  {
    name: "prose with no sentinel anywhere",
    text: "I can't reach the AskUserQuestion tool. Do you prefer tabs or spaces?",
    want: { state: "question", text: "I can't reach the AskUserQuestion tool. Do you prefer tabs or spaces?" },
  },
]

for (const { name, text, want } of FINAL_LINE_CASES) {
  test(`final line: ${name}`, () => {
    expect(phaseOutcome({ subtype: "success", is_error: false, result: text })).toEqual(want)
  })
}

test("a successful turn with no result key at all is a question, not done", () => {
  expect(phaseOutcome({ subtype: "success", is_error: false })).toEqual({ state: "question", text: "" })
})

// ---------------------------------------------------------------------------
// The terminal-status enumeration. Two dimensions: `subtype` and `is_error`.
// Only success-and-not-errored may reach the sentinel.
// ---------------------------------------------------------------------------

interface StatusCase {
  readonly subtype: string
  readonly is_error: boolean
  readonly want: Outcome
}

const STATUS_CASES: readonly StatusCase[] = [
  { subtype: "success", is_error: false, want: { state: "done" } },
  // An error flag on a success subtype: unverified but cheap to honour, and the
  // cheap direction is the one that stops and asks.
  { subtype: "success", is_error: true, want: { state: "failed", subtype: "success" } },
  { subtype: "error_max_budget_usd", is_error: true, want: { state: "failed", subtype: "error_max_budget_usd" } },
  // An error subtype without the flag. Still not a completion.
  { subtype: "error_max_budget_usd", is_error: false, want: { state: "failed", subtype: "error_max_budget_usd" } },
  // A subtype this code has never seen. Not an allowlist member, so not done.
  { subtype: "error_during_execution", is_error: true, want: { state: "failed", subtype: "error_during_execution" } },
  { subtype: "something_new_in_2.2", is_error: false, want: { state: "failed", subtype: "something_new_in_2.2" } },
]

for (const { subtype, is_error, want } of STATUS_CASES) {
  test(`terminal status: ${subtype} / is_error=${is_error}`, () => {
    expect(phaseOutcome({ subtype, is_error, result: DONE })).toEqual(want)
  })
}

test("an error subtype with no result text does not throw", () => {
  expect(phaseOutcome({ subtype: "error_max_budget_usd", is_error: true })).toEqual({
    state: "failed",
    subtype: "error_max_budget_usd",
  })
  expect(phaseOutcome({ subtype: "error_max_budget_usd", is_error: true, result: "" })).toEqual({
    state: "failed",
    subtype: "error_max_budget_usd",
  })
})
