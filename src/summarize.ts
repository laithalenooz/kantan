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

// --- Summarizing one test run -----------------------------------------------

const RUN_PROMPT = `A test command exited {code}. Say in one plain sentence what its output
reports: how many tests ran, passed or failed, and the first real failure if
there is one. No preamble, no advice, no verdict of your own - the exit code is
the verdict and the reader can already see it. One line.

`

/**
 * A line of prose, and **who wrote it**.
 *
 * The provenance travels with the text for the same reason
 * `EndRecord.verifiedBy` exists: a surface that cannot tell who wrote a
 * sentence cannot mark it, and unmarked model prose sitting beside measured
 * figures is exactly what this project refuses to ship. The run record already
 * marks the agent's words with `AGENT` on their own rows; this is what lets
 * everything else do the same.
 *
 * Two values, and deliberately no third that blurs them.
 */
export interface Said {
  /** One line, whitespace collapsed and capped. `""` when there is nothing. */
  text: string
  /** `"agent"` - a model wrote it. `"tail"` - a mechanical extract, no prose. */
  by: "agent" | "tail"
}

/**
 * The last non-empty line of output, which is **not** a summary of it.
 *
 * Kept, because it is the honest fallback: a mechanical extract that claims to
 * be nothing more. `stdout` first and `stderr` only if it has nothing - many
 * runners print the failure summary to stderr, but a suite that passed often
 * writes a trailing newline there and nothing else.
 *
 * It used to be the only option, and it was actively misleading: a real `npm
 * test` that **passed** ended with
 * `npm error A complete log of this run can be found in: …`, so the summary
 * beside exit 0 said "error". npm, cargo, pytest and gradle each put something
 * different last.
 */
export function tailLine(out: { stdout: string; stderr: string }): string {
  const last = (text: string): string | undefined =>
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .at(-1)
  return cap(last(out.stdout) ?? last(out.stderr) ?? "", SUMMARY_CHARS)
}

/**
 * One sentence about what a test run reported, written by a model.
 *
 * **The dividing line, and the reason this is safe:** the agent may write text
 * that appears *inside* a surface; it may never decide what surface appears or
 * what a status says. So:
 *
 * - The exit code is in the prompt **only** so the sentence cannot contradict
 *   what the reader can already see. The chip, the colour and every pass/fail
 *   branch still come from the number.
 * - The prompt forbids a verdict in those words. A model adding "so the build
 *   is broken" would be deciding what a status says.
 * - Nothing in the run's decision path reads this. Deleting the call costs a
 *   convenience line and nothing else.
 * - The answer carries `by`, so whatever renders it can mark it as the agent's
 *   words rather than passing model prose off as a measurement.
 *
 * **It degrades instead of throwing**, which is where it differs from
 * `summarizeStall`. That one is called on a path that can handle a throw; this
 * one answers a button somebody pressed, and an exit code with no sentence
 * beside it is still the answer they asked for. A model that is down, rate
 * limited or returns nothing falls back to `tailLine`, marked `"tail"`.
 *
 * It does not ask at all when both streams are blank: a silent failure gives
 * the model nothing to read, so any sentence would be invention.
 */
export async function summarizeRun(
  out: { exitCode: number; stdout: string; stderr: string },
  ask: Ask = askHaiku,
): Promise<Said> {
  const tail = tailLine(out)
  if (out.stdout.trim() === "" && out.stderr.trim() === "") return { text: tail, by: "tail" }

  const streams = [
    out.stdout.trim() === "" ? "" : `stdout:\n${excerpt(out.stdout, PROMPT_CHARS)}`,
    out.stderr.trim() === "" ? "" : `stderr:\n${excerpt(out.stderr, PROMPT_CHARS)}`,
  ]
    .filter((s) => s !== "")
    .join("\n\n")

  try {
    const reply = await ask(`${RUN_PROMPT.replace("{code}", String(out.exitCode))}${streams}\n`)
    const text = cap(reply.replaceAll(/\s+/g, " ").trim(), SUMMARY_CHARS)
    // An empty reply is not a summary. Blanking the row would be worse than
    // the extract, which at least says something that is in the output.
    if (text === "") return { text: tail, by: "tail" }
    return { text, by: "agent" }
  } catch {
    /* Swallowed on purpose, and the only place in this module that swallows:
       the caller pressed a button and is owed the exit code. The cause is not
       logged here because `ask`'s own failure path already reports it, and a
       second line per trial run would be noise. */
    return { text: tail, by: "tail" }
  }
}
