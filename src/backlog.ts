export interface Task {
  /** The `T<n>` label the runner addresses the task by, when the line has one. */
  ref: string | null
  text: string
  done: boolean
  /** 0-based index into `src.split("\n")`, so a tick can target one line. */
  line: number
}

export interface Feature {
  title: string
  tasks: Task[]
}

/**
 * A backlog line: `- [ ] T3 Do the thing`. Only a column-zero `- ` bullet
 * counts; an indented checkbox is a detail of its parent, not a task of its
 * own. `[X]` reads as done because editors and GitHub both write it that way.
 *
 * The `s` flag matters: without it `.` rejects the line separators U+2028 and
 * U+2029, so a task whose text contains one would drop out of the backlog
 * silently. It is safe here because a line never holds a "\n" and the bytes
 * that frame it are stripped before matching.
 */
const TASK_RE = /^- \[([ xX])\] (?:(T\d+)(?:\s+|$))?(.*)$/s

/** An ATX heading needs whitespace (or the line end) after its hashes, so a
 * bare `#tag` in the list region is prose and does not end the list. */
const HEADING_RE = /^#{1,6}(?:\s|$)/

/** The underline of a setext heading: `Notes` over `-----` or `=====`. */
const SETEXT_RE = /^(?:=+|-+)[ \t]*$/

/** Any list marker, bulleted or ordered. Wider than a task line on purpose:
 * what matters above a dash run is whether a list block is still open, not
 * whether the item happens to carry a checkbox. */
const BULLET_RE = /^(?:[-*+]|\d+[.)])(?:[ \t]|$)/

/** A line made only of rule characters. Three or more of them is a thematic
 * break; one or two is a degenerate line nobody writes as heading text. Either
 * way it is not something a run below it could underline. */
const RULE_LINE_RE = /^[-*_][-*_ \t]*$/

/** An unticked checkbox at the start of a line, BOM and all. */
const OPEN_BOX_RE = /^(\uFEFF?)- \[ \]/

/**
 * The content of a line, without the bytes that frame it rather than belong to
 * it: a UTF-8 BOM, which only has meaning on the first line of the file, and
 * the "\r" of a CRLF ending. Stripping is for matching only - the raw line is
 * what gets written back, so neither byte is ever lost.
 */
function content(raw: string, index: number): string {
  const body = index === 0 && raw.startsWith("\uFEFF") ? raw.slice(1) : raw
  return body.endsWith("\r") ? body.slice(0, -1) : body
}

/**
 * Whether `line` is top-level paragraph text, meaning any list or quote block
 * it could belong to has already closed: non-blank, at column zero, and not
 * itself a list marker, a blockquote, a thematic break or a heading.
 *
 * An indented line is a continuation of the item above it or a nested item, so
 * it is inside a list block, not paragraph text in its own right.
 */
function isParagraphText(line: string): boolean {
  if (line.trim() === "") return false
  if (/^[ \t]/.test(line)) return false
  if (line.startsWith(">")) return false
  if (BULLET_RE.test(line)) return false
  if (RULE_LINE_RE.test(line)) return false
  return !HEADING_RE.test(line)
}

/**
 * Whether `line` closes the task region. For a run of dashes or equals signs
 * that is decided by the two lines above it, because a setext underline cannot
 * be a lazy continuation of a list item or a blockquote. The run underlines
 * something only when `prev` is paragraph text *and* `prev2` is blank, which
 * is what proves the list block closed before that paragraph began - `Notes`
 * over `-----` after a blank line.
 *
 * Everywhere else the run is a thematic break and must not end the region. Get
 * that wrong and every task below it disappears: under a task's own `run:`
 * stamp, under a nested checkbox, under a `>` note, under another rule, under
 * a blank line, or under an unindented continuation line, the list block is
 * still open and the file keeps its tasks.
 *
 * Erring here is one-sided on purpose. Requiring the blank line also declines
 * to underline the last line of a multi-line top-level paragraph, which is a
 * genuine setext heading, but failing to close the region only ever keeps
 * tasks, while closing it early loses them.
 */
function isHeading(line: string, prev: string, prev2: string): boolean {
  if (HEADING_RE.test(line)) return true
  return SETEXT_RE.test(line) && isParagraphText(prev) && prev2.trim() === ""
}

/**
 * Index of the first body line, skipping a leading YAML frontmatter block so
 * that a `#` comment in the YAML does not outrank a real heading in the body.
 * `parseFeature` still reads the skipped block as a last resort, when the body
 * has no `# ` title ahead of its task list.
 *
 * A leading `---` is ambiguous: it either opens frontmatter or is a thematic
 * break in a document that has another one further down. Guessing wrong in
 * that direction skips the whole file and reports an empty backlog for a file
 * full of work, so the block only counts as frontmatter when no line inside it
 * is a checkbox. YAML has no reason to contain `- [ ] `, and a checkbox is
 * proof that skipping would lose tasks. An unterminated block skips nothing,
 * for the same reason.
 */
function bodyStart(lines: readonly string[]): number {
  const first = lines[0]
  if (first === undefined || content(first, 0) !== "---") return 0
  const close = lines.findIndex((l, i) => i > 0 && content(l, i) === "---")
  if (close === -1) return 0
  if (lines.slice(1, close).some((l, i) => TASK_RE.test(content(l, i + 1)))) return 0
  return close + 1
}

/**
 * Tasks are the checkbox lines of the region that opens at the first checkbox
 * and closes at the next heading, ATX or setext. Blank lines, thematic breaks
 * and continuation lines such as a `run:` stamp stay inside the region; only a
 * heading ends it, so checkboxes under a later heading (Notes, etc.) are prose
 * rather than backlog.
 *
 * The title is the first `# ` heading before that region. A heading that
 * follows the list closes the region instead of becoming the title, so a file
 * whose only heading sits below its tasks reports an empty title. A `# ` line
 * inside a block skipped as frontmatter is the last resort described below,
 * used only when the body offers no title at all.
 */
export function parseFeature(src: string): Feature {
  const lines = src.split("\n")
  const start = bodyStart(lines)
  let title = ""
  let prev = ""
  let prev2 = ""
  const tasks: Task[] = []

  for (const [i, raw] of lines.entries()) {
    if (i < start) continue
    const line = content(raw, i)
    const above = prev
    const above2 = prev2
    prev2 = prev
    prev = line
    if (isHeading(line, above, above2)) {
      if (tasks.length > 0) break
      if (!title && line.startsWith("# ")) title = line.slice(2).trim()
      continue
    }
    const m = line.match(TASK_RE)
    if (!m) continue
    // Groups 1 and 3 always participate when TASK_RE matches; the defaults are
    // here only to satisfy noUncheckedIndexedAccess.
    const [, box = " ", ref, text = ""] = m
    tasks.push({ ref: ref ?? null, text: text.trim(), done: box !== " ", line: i })
  }

  // Body first, skipped block second. A `# ` heading in the document always
  // outranks one inside a block that was skipped as frontmatter, so a leading
  // `---` that turns out to be a thematic break keeps the real title below it.
  // Only a body with no title at all makes the skipped block worth reading,
  // where a `#` line is as likely to be a YAML comment as a heading. Ordering
  // the search this way never has to decide what the fences were, so it cannot
  // lose a title that exists.
  if (!title) {
    for (const [i, raw] of lines.slice(0, start).entries()) {
      const line = content(raw, i)
      if (line.startsWith("# ")) {
        title = line.slice(2).trim()
        break
      }
    }
  }
  return { title, tasks }
}

/**
 * Returns `src` with `ref`'s checkbox ticked. Exactly one character changes;
 * line endings, a BOM, indentation and trailing whitespace are preserved, and
 * a file without a trailing newline does not gain one.
 *
 * Ticking an already-ticked task returns `src` unchanged, so a retried run
 * cannot disturb a finished file. Anything ambiguous throws instead of
 * guessing: an unknown ref, or a ref that appears on more than one line.
 */
export function tickTask(src: string, ref: string): string {
  const task = only(src, ref, "tick")
  if (task.done) return src

  const lines = src.split("\n")
  return lines.map((l, i) => (i === task.line ? l.replace(OPEN_BOX_RE, "$1- [x]") : l)).join("\n")
}

/**
 * The one task `ref` names, or a refusal saying why there isn't one.
 *
 * Shared by `tickTask` and `removeTask` rather than written twice, and that is
 * not tidiness: two resolvers would eventually disagree about which line `T1`
 * is, and then ticking and removing the same ref would act on different lines
 * of the same file. `verb` only shapes the duplicate message.
 */
function only(src: string, ref: string, verb: string): Task {
  const matches = parseFeature(src).tasks.filter((t) => t.ref === ref)
  if (matches.length > 1) {
    const where = matches.map((t) => t.line + 1).join(", ")
    throw new Error(`task ${ref} appears on lines ${where}; refusing to guess which to ${verb}`)
  }
  const task = matches[0]
  if (!task) throw new Error(`no task ${ref} in this feature file`)
  return task
}

/**
 * `src` without the line `ref` is on, and with every other byte untouched.
 *
 * Exactly one element of `src.split("\n")` goes, which is what keeps the
 * blast radius to the line the human pointed at. The costs here are not
 * symmetric: removing too much takes a neighbouring task, a heading or a note
 * with it, inside the user's own repository and with nothing on any surface to
 * say what went missing, while removing too little leaves a blank line that
 * they would have tidied anyway. So nothing adjacent is swept up - not the
 * blank line after a task, not an indented continuation under it, which
 * belongs to the item rather than being it.
 *
 * The split/join round-trip is byte-exact, including CRLF (the `\r` stays at
 * the end of its line) and a BOM (it belongs to line zero). It also gets the
 * trailing newline right without a special case: a file ending in one splits
 * to a final `""` element, which survives the removal and joins back to the
 * same terminator, and a file ending without one has no such element to add.
 */
export function removeTask(src: string, ref: string): string {
  const task = only(src, ref, "remove")
  const lines = src.split("\n")
  return [...lines.slice(0, task.line), ...lines.slice(task.line + 1)].join("\n")
}
