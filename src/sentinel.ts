/**
 * What the agent's terminal `result` event says about the phase.
 *
 * `failed` carries the CLI's own `subtype` verbatim rather than a classification
 * of it: the set of error subtypes belongs to the CLI, and inventing names for
 * them here would go stale on a version bump.
 */
export type Outcome =
  | { state: "done" }
  | { state: "blocked"; reason: string }
  | { state: "question"; text: string }
  | { state: "failed"; subtype: string }

/**
 * The three fields of a `result` event this detector reads. Narrower than the
 * event on purpose: a result carries ~25 keys, and Task 6, which owns stream
 * parsing, should be free to model the rest however it likes.
 *
 * `result` is optional because it genuinely can be absent. The
 * `error_max_budget_usd` capture has **no `result` key at all** - not an empty
 * string - so anything reading it must cope with `undefined`.
 */
export interface ResultEvent {
  subtype: string
  is_error: boolean
  result?: string
}

/** The literal the phase prompts instruct the agent to end with. Not configurable. */
const DONE = "ORCH: done"

/**
 * `ORCH: blocked`, with an optional reason separated from it by whitespace.
 *
 * The `[ \t]+` is load-bearing: `(.*)` alone would read `ORCH: blockedfoo` as
 * blocked with reason "foo".
 *
 * The `s` flag lets a reason containing U+2028 or U+2029 survive, which `.`
 * otherwise rejects. Safe here because the input is a single line, already
 * split on "\n". Without it such a reason would fall through to `question`,
 * which stops the run just the same but reports the wrong thing about why.
 */
const BLOCKED_RE = /^ORCH: blocked(?:[ \t]+(.*))?$/s

/**
 * The last line of `text` that holds something, with trailing whitespace gone.
 *
 * Trailing blank lines and a `\r` from CRLF are both routine in real output, so
 * neither may hide the sentinel. Leading whitespace is **kept**: an indented
 * line is markdown for a code block, meaning the sentinel is being quoted
 * rather than emitted.
 */
function finalLine(text: string): string {
  const lines = text.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").trimEnd()
    if (line !== "") return line
  }
  return ""
}

/**
 * Read the phase outcome out of a terminal `result` event.
 *
 * `AskUserQuestion` does not exist in `claude -p` (probed), so an agent with a
 * question asks it in prose and exits `result/success` exactly like an agent
 * that finished. A question and a completion are indistinguishable by message
 * type, and the captured question does not even end in a question mark. So
 * completion is never inferred from exit status: it is claimed by the agent, on
 * the final line, in a literal this codebase both emits and parses.
 *
 * Two guards, both deliberately biased toward stopping and asking the human.
 * Advancing a run past an unanswered question loses work and is hard to notice;
 * halting a finished phase wastes a glance.
 *
 * 1. **The terminal status gates the sentinel.** Only `success` with
 *    `is_error: false` is allowed to reach it; everything else is `failed`.
 *    An allowlist, so an error subtype this code has never seen cannot be
 *    mistaken for a completion.
 * 2. **Only the final line counts.** The prompt tells the agent to emit the
 *    sentinel, so the string appears in the conversation: in quoted
 *    instructions, in a plan file, in a fenced example. Matching it anywhere
 *    would end the phase the moment the agent echoed its own contract.
 *
 * Everything the final line can be and is not one of the two sentinels -
 * empty, whitespace, indented, recapitalised, backticked, trailed by a period,
 * or plain prose - is `question`, carrying the text unmodified for the human.
 */
export function phaseOutcome(event: ResultEvent): Outcome {
  if (event.subtype !== "success" || event.is_error) {
    return { state: "failed", subtype: event.subtype }
  }

  const text = event.result ?? ""
  const line = finalLine(text)

  if (line === DONE) return { state: "done" }

  const blocked = line.match(BLOCKED_RE)
  if (blocked) return { state: "blocked", reason: (blocked[1] ?? "").trim() }

  return { state: "question", text }
}
