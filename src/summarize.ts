import { askHaiku, HAIKU_MODEL, type Ask } from "./draft"

/**
 * Haiku's second job (design §3.5.1): collapse the three identical failure
 * outputs of a stall into one readable line for the UI. Bounded input, no
 * judgment required, called at most twice per run.
 *
 * **This is additive. The system works without it.** A caller disables it by
 * deleting the call and rendering `outputs` alone - the UI loses a convenience
 * line and nothing else. Nothing branches on the summary: whether a stall is
 * real is the signature hash's answer, and putting a model in that decision
 * would make it non-deterministic.
 *
 * Two properties this module exists to hold:
 *
 * **It is called only on a stall, so three outputs are an assertion.** Fewer
 * than three means the caller's stall detection is wrong, and summarizing two
 * failures would hide that behind a plausible sentence.
 *
 * **The summary is a convenience, never the evidence.** The raw outputs stay
 * on screen beside it, which is why `summarizeStall` returns them alongside
 * the line: a caller cannot end up holding the summary alone and showing that
 * as the failure. The summary is also the only part that gets truncated -
 * there is no point competing with the evidence next to it.
 *
 * Failures throw, loudly, rather than returning an empty line that renders as
 * a blank row. A caller on the run path should treat a throw here as "no
 * summary available" and still show the outputs; it must never fail a run.
 */

/** A stall is three runs of the same failure. */
export const STALL_RUNS = 3

/** Per output, in the prompt only. The record the caller gets is never cut. */
const PROMPT_CHARS = 2_000

/** One line for a UI row. Long enough to say what broke, short enough to read. */
const SUMMARY_CHARS = 200

const STALL_PROMPT = `Three runs of one task failed. Say in one plain sentence what failed and why,
as a developer would read it at a glance. No preamble, no advice, one line.

`

export interface StallSummary {
  /** One line, whitespace collapsed and capped. */
  summary: string
  /** The outputs as given, byte for byte. The evidence, kept beside the line. */
  outputs: readonly string[]
}

/**
 * Summarizes a stall. Throws unless there are `STALL_RUNS` outputs, and throws
 * rather than return an empty summary.
 *
 * The outputs are not required to be byte-identical: the stall signature
 * decides what counts as the same failure, and re-deciding it here with a
 * second rule would just be a second opinion to keep in sync.
 */
export async function summarizeStall(
  outputs: readonly string[],
  ask: Ask = askHaiku,
): Promise<StallSummary> {
  if (outputs.length < STALL_RUNS) {
    throw new Error(
      `summarizeStall is called on a stall, which is three failed runs; ` +
        `got ${outputs.length}. Fix the caller rather than summarizing fewer.`,
    )
  }

  if (outputs.every((out) => out.trim() === "")) {
    // A silent failure - an exit code and nothing on either stream - gives the
    // model nothing to read, so any sentence it returns would be invention.
    throw new Error("every output is blank, so there is nothing to summarize")
  }

  const shown = outputs.map((out, i) => `Run ${i + 1}:\n${excerpt(out, PROMPT_CHARS)}`).join("\n\n")
  const reply = await ask(`${STALL_PROMPT}${shown}\n`)

  const summary = cap(reply.replaceAll(/\s+/g, " ").trim(), SUMMARY_CHARS)
  if (summary === "") throw new Error(`${HAIKU_MODEL} returned an empty summary`)

  // A copy, so a caller that keeps appending to its own array cannot change
  // what this summary was made from.
  return { summary, outputs: Object.freeze([...outputs]) }
}

/** `text`, no longer than `limit` characters, marked when something was cut. */
function cap(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit - 3).trimEnd()}...`
}

/**
 * About `limit` characters of `text`, taken from **both ends** and marked in
 * the middle. A test runner prints the command first and the failure summary
 * last, so a head-only window would show the model passing-test noise and
 * nothing of what broke.
 */
function excerpt(text: string, limit: number): string {
  if (text.length <= limit) return text
  const head = Math.floor(limit / 4)
  const tail = limit - head
  return `${text.slice(0, head)}\n... ${text.length - limit} characters cut ...\n${text.slice(-tail)}`
}
