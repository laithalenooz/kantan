import { parseFeature, type Feature } from "./backlog"
import { CLAUDE_BIN } from "./version"

/**
 * Haiku's first job (design §3.5.1): turn a rough description into a feature
 * file in the house format. Single-turn, bounded, and read by a human before
 * it matters.
 *
 * **This is additive. The system works without it.** Nothing else in kantan
 * imports `draftFeature`, so a caller disables it by deleting the call site,
 * never by debugging this file under pressure.
 *
 * `draftFeature` returns the path and the bytes; it does not write. File I/O
 * belongs to the writer that owns atomic replace and byte preservation, and a
 * drafter that cannot touch the disk cannot damage a file a human is editing.
 *
 * ## The parser is the acceptance test
 *
 * A draft the parser cannot read is a failed draft, whatever it looks like, so
 * `draftFeature` runs `parseFeature` over its own output and throws unless the
 * result is a title plus tasks numbered `T1..Tn` in order, none of them
 * ticked. The returned `feature` is that parse, so a caller never has to
 * re-derive it and can never disagree with the check.
 *
 * ## The reply is free text, so the guard is enumerated
 *
 * Reading a model's reply is a guard, and `CLAUDE.md`'s rule applies: the
 * dimension is the *shape of the reply*, and the cost is asymmetric. Refusing
 * to write a file is recoverable - the human edits the markdown anyway.
 * Writing a file the parser silently misreads is the failure this project has
 * already paid for fourteen times, and it surfaces as a feature that renders
 * empty in the UI. So every shape below either survives the round-trip or
 * throws:
 *
 * | Reply shape | What happens |
 * |---|---|
 * | clean markdown | accepted |
 * | one fenced block holding the file | fence lines dropped, inside accepted |
 * | preamble ("Here's your feature file:") then title or fence | preamble dropped |
 * | commentary after the task list | kept; the region ends at the list and every task still parses |
 * | commentary after a closing fence | dropped with the fence |
 * | CRLF endings, or a leading BOM | accepted; endings are preserved, the BOM is not re-emitted |
 * | more than one fenced block, or an unterminated fence | refused: which block is the file is a guess |
 * | a fenced block the reply did not open with | refused, same reason |
 * | a checkbox line above the title | refused rather than dropped with the preamble |
 * | a refusal, or any reply with no `# ` title | refused |
 * | empty or whitespace-only reply | refused |
 * | valid markdown with no checkboxes | refused: this is exactly the file that renders as an empty feature |
 * | checkboxes under a second heading | refused: the parser ends the task region at a heading, so those lines are unreachable |
 * | a checkbox that is indented, blockquoted, ordered (`2. [ ]`), missing the space after the dash, or truncated mid-line | refused: it reads as a task to a human and is not one to the parser |
 * | a task line with no text | refused |
 * | a ref-less task line | refused, never repaired |
 * | duplicate refs, refs with a gap, refs out of order | refused |
 * | an already-ticked task | refused |
 * | a title that slugs to nothing | refused |
 *
 * Two of those deserve their reasons stated, because the other direction is
 * tempting:
 *
 * **Ref-less lines are refused, not numbered.** `tickTask` addresses by ref,
 * so a ref-less task can never be ticked, which is why the prompt demands a
 * ref on every line and this code asserts it. Repairing the reply by
 * numbering the lines ourselves would mean renumbering a list the model may
 * already reference by number elsewhere, and a mis-numbered file is wrong in a
 * way the human cannot see. Refusing costs one regenerate.
 *
 * **Refs must run `T1..Tn` exactly.** A gap or a reordering is the signature
 * of a task the model dropped or a reply that got cut, and duplicates make
 * `tickTask` throw later. This strictness is the drafter checking its own
 * output: a hand-written feature file with gaps is perfectly valid, and
 * `parseFeature` reads it fine.
 */

/** Design §3.5: Haiku has two jobs outside the implement loop and none inside it. */
export const HAIKU_MODEL = "claude-haiku-5-5"

/**
 * One single-turn call, injected so tests substitute a stub. No test may reach
 * the real API, and this is the seam that makes that enforceable.
 */
export type Ask = (prompt: string) => Promise<string>

export interface Draft {
  /** Repo-relative path the caller should write `markdown` to. */
  path: string
  /** The file, in the house format, ending in exactly one newline. */
  markdown: string
  /** `parseFeature(markdown)`: the proof the draft is readable, not a summary of it. */
  feature: Feature
}

const DRAFT_PROMPT = `Rewrite the description below as a feature file.

Reply with nothing but the file, in exactly this shape:

# Short title
- [ ] T1 First task
- [ ] T2 Second task

One "# " title line, then one task per line. Every task line starts at column
zero with "- [ ] T<n>", numbered from 1 with no gaps and no repeats. Three to
eight tasks, none of them ticked. No code fence, no preamble, no sign-off.

Description:
`

/** A fence line, opening or closing, with or without an info string. */
const FENCE_RE = /^(?:```|~~~)/

/** An ATX `# ` title with something after it. */
const TITLE_RE = /^# \S/

/**
 * A line whose first token is a bracket, after an optional list marker:
 * bulleted or ordered, indented or not, quoted or not. Wider than a task line
 * on purpose: everything it matches reads to a human as a checkbox, so
 * anything it matches that is *not* a well-formed task line is a line the
 * parser and the human would disagree about, and that disagreement is what
 * this module exists to prevent. The marker alternation mirrors
 * `backlog.ts`'s `BULLET_RE`, because GFM renders `2. [ ]` as a checkbox too.
 */
const LOOKS_LIKE_BOX = /^[ \t>]*(?:[-*+]|\d+[.)])?[ \t]*\[/

/** A well-formed, column-zero, non-empty task line. */
const TASK_LINE = /^- \[[ xX]\] \S/

/** The content of a line without the "\r" of a CRLF ending, for matching only. */
function match(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line
}

function isBlank(line: string): boolean {
  return match(line).trim() === ""
}

/** A short, single-line quote of model output, for an error message. */
function head(text: string): string {
  const flat = text.replaceAll(/\s+/g, " ").trim()
  return flat.length > 160 ? `${flat.slice(0, 160)}...` : flat || "nothing"
}

/** Drops blank lines from both ends. */
function trimBlank(lines: readonly string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && isBlank(lines[start] ?? "")) start++
  while (end > start && isBlank(lines[end - 1] ?? "")) end--
  return lines.slice(start, end)
}

/**
 * Everything from the first line that could begin a feature file - a `# `
 * title, or the fence around one. Lines above it are the model talking to the
 * human, with one exception: a checkbox up there is a task, and dropping a
 * task is not a thing this function is allowed to do.
 */
function dropPreamble(lines: readonly string[], reply: string): string[] {
  const at = lines.findIndex((l) => TITLE_RE.test(match(l)) || FENCE_RE.test(match(l)))
  if (at <= 0) return [...lines]
  const stray = lines.slice(0, at).find((l) => LOOKS_LIKE_BOX.test(match(l)))
  if (stray !== undefined) {
    throw new Error(
      `the reply has a checkbox line before the title (${head(stray)}), so dropping the ` +
        `preamble would drop a task; refusing to draft from it: ${head(reply)}`,
    )
  }
  return lines.slice(at)
}

/**
 * The inside of the one fenced block, when the reply is fenced at all.
 *
 * Exactly one block, opening on the first line: anything else is a guess about
 * which block is the file. Content after the closing fence is commentary and
 * goes with it.
 */
function unfence(lines: readonly string[], reply: string): string[] {
  const fences = lines.filter((l) => FENCE_RE.test(match(l)))
  if (fences.length === 0) return [...lines]
  const opensOnFirst = FENCE_RE.test(match(lines[0] ?? ""))
  if (!opensOnFirst || fences.length !== 2) {
    throw new Error(
      `the reply does not hold exactly one code fence around the file, so which part is ` +
        `the file is a guess; refusing to draft from it: ${head(reply)}`,
    )
  }
  const close = lines.findIndex((l, i) => i > 0 && FENCE_RE.test(match(l)))
  return lines.slice(1, close)
}

/** Every checkbox-looking line must be a real task line, or the file lies to someone. */
function rejectMalformedBoxes(lines: readonly string[], reply: string): void {
  for (const [i, raw] of lines.entries()) {
    const line = match(raw)
    if (!LOOKS_LIKE_BOX.test(line) || TASK_LINE.test(line)) continue
    throw new Error(
      `line ${i + 1} of the drafted file reads as a checkbox but is not a column-zero ` +
        `"- [ ] T<n> text" task line (${head(raw)}); refusing to draft from it: ${head(reply)}`,
    )
  }
}

/**
 * The slug is a regex, never a model (design §3.5.1 says so for branch slugs,
 * and the same reasoning holds here). Only `[a-z0-9-]` survives, so a title
 * cannot steer the path out of `docs/features/`.
 */
function slugify(title: string): string {
  const flat = title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
  const capped = flat.length <= 60 ? flat : flat.slice(0, 60).replace(/-[^-]*$/, "")
  return capped.replaceAll(/-+$/g, "")
}

/**
 * Drafts `docs/features/<slug>.md` from `text`, and throws rather than hand
 * back markdown the UI would render as an empty feature. See the module
 * comment for the shape-by-shape enumeration.
 */
export async function draftFeature(text: string, ask: Ask = askHaiku): Promise<Draft> {
  if (text.trim() === "") throw new Error("a feature draft needs a description to work from")

  const reply = await ask(DRAFT_PROMPT + `\n${text.trim()}\n`)
  // A BOM has meaning only at the start of a file, and this reply is not one.
  const body = reply.startsWith("﻿") ? reply.slice(1) : reply
  if (body.trim() === "") throw new Error(`${HAIKU_MODEL} returned an empty reply`)

  let lines = trimBlank(body.split("\n"))
  lines = dropPreamble(lines, reply)
  lines = trimBlank(unfence(lines, reply))
  rejectMalformedBoxes(lines, reply)

  const markdown = `${lines.join("\n")}\n`
  const feature = parseFeature(markdown)

  // The parser and the file have to agree about what a task is. A well-formed
  // task line the parser does not return is a line a human reads as a task and
  // `tickTask` cannot reach: a checkbox under a later heading, outside the
  // region the parser ends there.
  const counted = new Set(feature.tasks.map((t) => t.line))
  const orphan = lines.findIndex((l, i) => TASK_LINE.test(match(l)) && !counted.has(i))
  if (orphan !== -1) {
    const boxes = lines.filter((l) => TASK_LINE.test(match(l))).length
    throw new Error(
      `the reply has ${boxes} task lines but the parser reads ${feature.tasks.length} tasks: ` +
        `line ${orphan + 1} (${head(lines[orphan] ?? "")}) sits outside the task region, so ` +
        `nothing could ever tick it; refusing to draft from it: ${head(reply)}`,
    )
  }

  if (feature.title === "") {
    throw new Error(`the reply has no "# " title line; refusing to draft from it: ${head(reply)}`)
  }
  if (feature.tasks.length === 0) {
    throw new Error(
      `the reply has no task lines, which would render as an empty feature; ` +
        `refusing to draft from it: ${head(reply)}`,
    )
  }
  for (const [i, task] of feature.tasks.entries()) {
    const where = `line ${task.line + 1}`
    if (task.ref === null) {
      throw new Error(
        `${where} has no T<n> ref, and a ref-less task can never be ticked because ` +
          `tickTask addresses by ref; refusing to draft from it: ${head(reply)}`,
      )
    }
    const want = `T${i + 1}`
    if (task.ref !== want) {
      throw new Error(
        `refs must run T1..T${feature.tasks.length} in order: expected ${want} but found ` +
          `${task.ref} on ${where}; refusing to draft from it: ${head(reply)}`,
      )
    }
    if (task.text === "") throw new Error(`${task.ref} on ${where} has no text`)
    if (task.done) {
      throw new Error(`${task.ref} on ${where} came back already ticked; a draft must be open`)
    }
  }

  const slug = slugify(feature.title)
  if (slug === "") {
    throw new Error(`the title ${JSON.stringify(feature.title)} slugs to nothing, so there is no path to write`)
  }
  return { path: `docs/features/${slug}.md`, markdown, feature }
}

/** One run of `claude -p`, as the caller of `haikuReply` observed it. */
export interface HaikuRun {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * The reply text out of one `--output-format json` run. Pure, so every guard
 * below is testable without spawning anything.
 *
 * `--output-format json` rather than `stream-json`: these jobs need one
 * answer, not a feed. Every failure throws with what the CLI actually said,
 * because a wrong `ORCH_CLAUDE_BIN` and a refused request look identical from
 * an empty string.
 */
export function haikuReply(run: HaikuRun): string {
  if (run.exitCode !== 0) {
    const said = (run.stderr || run.stdout).trim() || "no output"
    throw new Error(`${CLAUDE_BIN} -p exited ${run.exitCode}: ${said}`)
  }

  let envelope: unknown
  try {
    envelope = JSON.parse(run.stdout)
  } catch {
    throw new Error(`cannot parse the result envelope from ${CLAUDE_BIN} -p: ${head(run.stdout)}`)
  }
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    throw new Error(`the result envelope from ${CLAUDE_BIN} -p is not an object: ${head(run.stdout)}`)
  }

  const fields = envelope as Record<string, unknown>
  const subtype = typeof fields["subtype"] === "string" ? fields["subtype"] : null
  const result = fields["result"]

  // An error subtype outranks everything: error_max_budget_usd returns an
  // empty result, so emptiness alone would report the wrong problem.
  if (fields["is_error"] === true) {
    const said = typeof result === "string" && result.trim() !== "" ? head(result) : head(run.stdout)
    throw new Error(`${CLAUDE_BIN} -p reported an error${subtype ? ` (${subtype})` : ""}: ${said}`)
  }
  if (subtype !== null && subtype !== "success") {
    throw new Error(`${CLAUDE_BIN} -p ended as ${subtype}: ${head(run.stdout)}`)
  }
  const stopReason = fields["stop_reason"]
  if (typeof stopReason === "string" && stopReason !== "end_turn") {
    throw new Error(`the reply did not finish (stop_reason: ${stopReason}); refusing a partial draft`)
  }
  if (typeof result !== "string") {
    throw new Error(`the result envelope has no string result: ${head(run.stdout)}`)
  }
  return result
}

/**
 * The ceiling on one of these calls. Haiku is $0.10/$0.50 per MTok, so five
 * cents is tens of thousands of tokens: orders of magnitude above a feature
 * file or a one-line summary, which means it can only fire on a runaway. The
 * CLI answers an exhausted budget with an error subtype and an empty result,
 * and `haikuReply` refuses that by name rather than reporting "empty reply".
 */
const BUDGET_USD = "0.05"

/**
 * The flags that keep a bounded job from becoming an agent run.
 *
 * `-p` means non-interactive, **not** single-turn - design §3.1 runs the
 * whole multi-turn implement loop through `claude -p`. What makes these calls
 * one turn is having nothing to loop on: there is no `--max-turns` in the
 * installed CLI (2.1.296), so `--tools ""` is the enforcement. It also means
 * a stack trace in a stall's output cannot talk the call into reading a path.
 *
 * `--safe-mode` drops CLAUDE.md, skills, hooks, plugins, MCP servers and the
 * user's settings, with auth and model selection untouched. Without it these
 * two jobs inherit whatever the developer's own configuration asks of every
 * session - this repo's global config, for one, makes skill loading a hard
 * rule - and a transformation prompt comes back wrapped in that work.
 * `--strict-mcp-config` pins the MCP half independently, since `--safe-mode`'s
 * list is documented per version and this one is cheap to state.
 *
 * Every flag here was read out of the installed binary's own `--help`, not
 * recalled. A CLI too old to know one of them exits non-zero and `haikuReply`
 * names the flag it refused, which is a clear failure for an additive job.
 */
const BOUNDING_FLAGS = ["--tools", "", "--safe-mode", "--strict-mcp-config"] as const

/**
 * The real single-turn call: `claude -p` on Haiku, through `CLAUDE_BIN` so the
 * fake binary can stand in. Hardcoding `"claude"` would bypass the seam every
 * test depends on.
 *
 * `src/summarize.ts` imports this. Task 26b owns exactly two files in `src/`,
 * and one copy of a spawn is better than two; if this module ever goes away,
 * move `askHaiku` there rather than duplicating it.
 */
export const askHaiku: Ask = async (prompt) => {
  const argv = [
    CLAUDE_BIN,
    "-p",
    prompt,
    "--output-format",
    "json",
    "--model",
    HAIKU_MODEL,
    ...BOUNDING_FLAGS,
    "--max-budget-usd",
    BUDGET_USD,
  ]

  let p
  try {
    p = Bun.spawn(argv, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch (cause) {
    // Bun throws synchronously when the binary does not exist.
    throw new Error(`cannot run ${CLAUDE_BIN}: ${(cause as Error).message}`, { cause })
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  return haikuReply({ stdout, stderr, exitCode })
}
