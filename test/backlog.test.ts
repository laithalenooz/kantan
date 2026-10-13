import { describe, expect, test } from "bun:test"
import { appendTasks, parseFeature, removeTask, tickTask } from "../src/backlog"

const SAMPLE = `---
status: active
---
# Widget export

- [x] T1 Parse the manifest
      run: 2026-10-11T09:14 · passed
- [ ] T2 Map records to rows
- [ ] T3 Runtime shim (v1.2)

## Notes
Fixtures live in test-fixtures/.
`

test("extracts the feature title", () => {
  expect(parseFeature(SAMPLE).title).toBe("Widget export")
})

test("extracts tasks with ref, text and done state", () => {
  const { tasks } = parseFeature(SAMPLE)
  expect(tasks).toHaveLength(3)
  expect(tasks[0]).toMatchObject({ ref: "T1", done: true })
  expect(tasks[1]).toMatchObject({ ref: "T2", text: "Map records to rows", done: false })
})

test("records each task's line number for a targeted edit", () => {
  const { tasks } = parseFeature(SAMPLE)
  expect(SAMPLE.split("\n")[tasks[1]!.line]).toContain("T2")
})

test("ignores checkboxes outside the task list", () => {
  const withNote = SAMPLE + "\n- [ ] not a task, it is under Notes\n"
  // Tasks stop at the first heading after the list.
  expect(parseFeature(withNote).tasks).toHaveLength(3)
})

test("ticking a task changes only that checkbox", () => {
  const out = tickTask(SAMPLE, "T2")
  expect(out.split("\n").length).toBe(SAMPLE.split("\n").length)
  expect(out).toContain("- [x] T2 Map records to rows")
  expect(out).toContain("- [ ] T3")
  expect(out).toContain("Fixtures live in test-fixtures/.")
  // Every other line is untouched.
  const a = SAMPLE.split("\n"), b = out.split("\n")
  const changed = a.map((l, i) => (l === b[i] ? null : i)).filter((i) => i !== null)
  expect(changed).toHaveLength(1)
})

test("ticking an unknown ref throws rather than corrupting the file", () => {
  expect(() => tickTask(SAMPLE, "T9")).toThrow(/T9/)
})

test("a task with no ref still parses", () => {
  const { tasks } = parseFeature("# F\n\n- [ ] just text\n")
  expect(tasks[0]).toMatchObject({ ref: null, text: "just text", done: false })
})

// --- Round-trip hazards -----------------------------------------------------
// These files live in the user's own repositories, under their own git history.
// A parse that loses a line or a tick that moves a byte it was not asked to
// move corrupts work kantan does not own, so every case below either
// round-trips exactly or throws.

/** Every index at which the two strings differ; empty when byte-identical. */
function charDiff(a: string, b: string): number[] {
  const diff: number[] = []
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) diff.push(i)
  }
  return diff
}

/** Asserts `out` is `src` with a single " " -> "x" flip and no other change. */
function expectSingleTick(src: string, out: string): void {
  const diff = charDiff(src, out)
  expect(diff).toHaveLength(1)
  const at = diff[0]!
  expect(src[at]).toBe(" ")
  expect(out[at]).toBe("x")
}

test("parses CRLF files and keeps the carriage returns when ticking", () => {
  const crlf = SAMPLE.replace(/\n/g, "\r\n")
  const { title, tasks } = parseFeature(crlf)
  expect(title).toBe("Widget export")
  expect(tasks).toHaveLength(3)
  // "\r" is a line ending, never part of the task text.
  expect(tasks[1]).toMatchObject({ ref: "T2", text: "Map records to rows", done: false })
  const out = tickTask(crlf, "T2")
  expect(out).toContain("- [x] T2 Map records to rows\r\n")
  expectSingleTick(crlf, out)
})

test("does not add a trailing newline to a file that lacks one", () => {
  const src = "# F\n\n- [ ] T1 one\n- [ ] T2 two"
  const out = tickTask(src, "T2")
  expect(out.endsWith("two")).toBe(true)
  expectSingleTick(src, out)
})

test("ticking an already-ticked task returns the file untouched", () => {
  // Idempotent on purpose: a retried run must not disturb a finished file.
  expect(tickTask(SAMPLE, "T1")).toBe(SAMPLE)
})

test("reads an upper-case - [X] as done and never rewrites it", () => {
  const src = "# F\n\n- [X] T1 shouted done\n- [ ] T2 open\n"
  const { tasks } = parseFeature(src)
  expect(tasks).toHaveLength(2)
  expect(tasks[0]).toMatchObject({ ref: "T1", text: "shouted done", done: true })
  expect(tickTask(src, "T1")).toBe(src)
})

test("keeps trailing whitespace on the line it ticks", () => {
  const src = "# F\n\n- [ ] T1 padded   \n"
  expect(parseFeature(src).tasks[0]).toMatchObject({ text: "padded" })
  const out = tickTask(src, "T1")
  expect(out).toBe("# F\n\n- [x] T1 padded   \n")
  expectSingleTick(src, out)
})

test("ticks the right line when two tasks share the same text", () => {
  const src = "# F\n\n- [ ] T1 Run the suite\n- [ ] T2 Run the suite\n"
  const out = tickTask(src, "T2")
  expect(out).toBe("# F\n\n- [ ] T1 Run the suite\n- [x] T2 Run the suite\n")
  expectSingleTick(src, out)
})

test("does not confuse T1 with T10", () => {
  const src = "# F\n\n- [ ] T10 ten\n- [ ] T1 one\n"
  expect(parseFeature(src).tasks.map((t) => t.ref)).toEqual(["T10", "T1"])
  const out = tickTask(src, "T1")
  expect(out).toBe("# F\n\n- [ ] T10 ten\n- [x] T1 one\n")
  expectSingleTick(src, out)
})

test("refuses to tick when the same ref appears on two lines", () => {
  const src = "# F\n\n- [ ] T2 first copy\n- [ ] T2 second copy\n"
  expect(() => tickTask(src, "T2")).toThrow(/T2 appears on lines 3, 4/)
})

test("refuses to tick a duplicated ref even when one copy is already done", () => {
  // The silent shape: a plain find() hits the done copy, the function reports
  // success, and the open task is never ticked.
  const src = "# F\n\n- [x] T2 first copy\n- [ ] T2 second copy\n"
  expect(() => tickTask(src, "T2")).toThrow(/T2 appears on lines 3, 4/)
})

test("ignores a checkbox indented under a parent bullet", () => {
  const src = "# F\n\n- [ ] T1 parent\n  - [ ] T2 nested detail\n- [ ] T3 sibling\n"
  expect(parseFeature(src).tasks.map((t) => t.ref)).toEqual(["T1", "T3"])
  // Loud, not silent: a nested ref is not a backlog task.
  expect(() => tickTask(src, "T2")).toThrow(/T2/)
})

test("parses a file with no heading at all", () => {
  const { title, tasks } = parseFeature("- [ ] T1 headless\n")
  expect(title).toBe("")
  expect(tasks).toHaveLength(1)
})

test("a heading after the list ends it instead of becoming the title", () => {
  const { title, tasks } = parseFeature("- [ ] T1 real task\n\n# Notes\n- [ ] T2 prose\n")
  expect(title).toBe("")
  expect(tasks.map((t) => t.ref)).toEqual(["T1"])
})

test("ignores a YAML comment in the frontmatter when looking for the title", () => {
  const src =
    "---\n# status is managed by the planner\nstatus: active\n---\n# Real Title\n\n- [ ] T1 a\n"
  const { title, tasks } = parseFeature(src)
  expect(title).toBe("Real Title")
  expect(tasks).toHaveLength(1)
  expect(tasks[0]).toMatchObject({ line: 6 })
})

test("treats unterminated frontmatter as ordinary content", () => {
  const { title, tasks } = parseFeature("---\n# Title\n\n- [ ] T1 a\n")
  expect(title).toBe("Title")
  expect(tasks).toHaveLength(1)
})

test("a hashtag is not a heading and does not hide the tasks after it", () => {
  const { tasks } = parseFeature("# F\n\n- [ ] T1 a\n#notaheading\n- [ ] T2 b\n")
  expect(tasks.map((t) => t.ref)).toEqual(["T1", "T2"])
})

test("a task with a ref and no text keeps the ref", () => {
  expect(parseFeature("# F\n\n- [ ] T5\n").tasks[0]).toMatchObject({ ref: "T5", text: "" })
})

test("an empty file parses to an empty feature", () => {
  expect(parseFeature("")).toEqual({ title: "", tasks: [] })
})

test("never rewrites a checkbox that is part of a task's own text", () => {
  // The line is already done, so the only "- [ ]" left on it is prose. An
  // unanchored replace would corrupt it while reporting success.
  const src = "# F\n\n- [x] T1 see - [ ] below\n- [ ] T2 open\n"
  expect(tickTask(src, "T1")).toBe(src)
})

test("a checkbox inside a candidate frontmatter block means it is not frontmatter", () => {
  // The rule that forecloses total loss, and what it costs here. A real YAML
  // block has no reason to hold "- [ ] ", so a checkbox is evidence that these
  // fences are a thematic break, and skipping to the second one would discard
  // every task in the file. The price for this one shape is not just an extra
  // line: the frontmatter checkbox becomes the only task, the "# T" below it
  // then closes the region, and both the real T1 and the real title are lost.
  // A deliberate trade against a file YAML has no reason to produce, asserted
  // here rather than described, so the cost cannot drift unnoticed.
  const src = "---\n- [ ] not a task, it is yaml\n---\n# T\n\n- [ ] T1 a\n"
  const { title, tasks } = parseFeature(src)
  expect(tasks.map((t) => t.line)).toEqual([1])
  expect(title).toBe("")
})

test("ticking the only task in a file when it is already ticked is a no-op", () => {
  const src = "# F\n\n- [x] T1 done\n"
  expect(tickTask(src, "T1")).toBe(src)
})

test("parses a task line containing a unicode line separator", () => {
  // U+2028 is excluded from "." for the same reason "\r" is, so without the
  // dot-all flag the whole line fails to match and the task vanishes.
  const src = "# F\n\n- [ ] T1 before after\n- [ ] T2 b\n"
  expect(parseFeature(src).tasks.map((t) => t.ref)).toEqual(["T1", "T2"])
  expectSingleTick(src, tickTask(src, "T1"))
})

test("a leading --- thematic break does not swallow the document as frontmatter", () => {
  // The catastrophic shape: a file that opens with a rule and has any later
  // rule. Treating the second one as the closing fence skips every task and
  // reports an empty backlog for a file that is full of work.
  const src = "---\n# Widget export\n\n- [ ] T1 Parse the manifest\n- [ ] T2 Map records\n\n---\n\nFooter note.\n"
  const { title, tasks } = parseFeature(src)
  expect(title).toBe("Widget export")
  expect(tasks.map((t) => t.ref)).toEqual(["T1", "T2"])
  expectSingleTick(src, tickTask(src, "T2"))
})

test("looks past a UTF-8 BOM when finding the title", () => {
  expect(parseFeature("\uFEFF# Widget export\n\n- [ ] T1 a\n").title).toBe("Widget export")
})

test("looks past a UTF-8 BOM when finding frontmatter", () => {
  // The YAML comment is what makes this fail when the BOM hides the opening
  // fence: the comment itself gets read as the feature title.
  const src =
    "\uFEFF---\n# status is managed by the planner\nstatus: active\n---\n# Real Title\n\n- [ ] T1 a\n"
  expect(parseFeature(src).title).toBe("Real Title")
})

test("parses and ticks a task on the first line of a BOM-prefixed file", () => {
  // Silently unticked is the danger here: the parse drops the line, so the
  // runner is told the ref does not exist, or worse ticks nothing and reports
  // success. The BOM is stripped for matching only and never rewritten.
  const src = "\uFEFF- [ ] T1 a\n- [ ] T2 b\n"
  expect(parseFeature(src).tasks.map((t) => t.ref)).toEqual(["T1", "T2"])
  const out = tickTask(src, "T1")
  expect(out.startsWith("\uFEFF- [x] T1 a")).toBe(true)
  expectSingleTick(src, out)
})

test("a setext heading ends the task list just as a # heading does", () => {
  const { tasks } = parseFeature("# F\n\n- [ ] T1 a\n\nNotes\n-----\n- [ ] T2 prose\n")
  expect(tasks.map((t) => t.ref)).toEqual(["T1"])
})

test("a setext heading underlined with = also ends the task list", () => {
  const { tasks } = parseFeature("# F\n\n- [ ] T1 a\n\nNotes\n=====\n- [ ] T2 prose\n")
  expect(tasks.map((t) => t.ref)).toEqual(["T1"])
})

test("a --- divider directly under a task is a rule, not a setext heading", () => {
  // Over-breaking is the same silent loss in reverse: a dash line that ends
  // the region early hides every task after it. A setext underline only
  // counts when the line above it is paragraph text.
  const { tasks } = parseFeature("# F\n\n- [ ] T1 a\n---\n- [ ] T2 b\n")
  expect(tasks.map((t) => t.ref)).toEqual(["T1", "T2"])
})

test("a --- divider after a blank line is a rule, not a setext heading", () => {
  const { tasks } = parseFeature("# F\n\n- [ ] T1 a\n\n---\n\n- [ ] T2 b\n")
  expect(tasks.map((t) => t.ref)).toEqual(["T1", "T2"])
})

// A setext underline cannot be a lazy continuation of a list item or a
// blockquote, so in every shape below the dash or equals run is a thematic
// break. Reading it as a heading closes the task region early and loses every
// task beneath it - and for a done first task, reports the feature finished.

test("a rule under a task's own run stamp is not a setext heading", () => {
  // The stamp is a continuation of the list item above, so the list block has
  // not closed and the dashes underline nothing. This is the shape SAMPLE
  // writes under every done task.
  const src =
    "# Widget export\n\n- [x] T1 Parse the manifest\n      run: 2026-10-11T09:14 passed\n---\n- [ ] T2 Map records\n- [ ] T3 Shim\n"
  expect(parseFeature(src).tasks.map((t) => t.ref)).toEqual(["T1", "T2", "T3"])
  expectSingleTick(src, tickTask(src, "T2"))
})

test("a rule under a nested checkbox is not a setext heading", () => {
  const src = "# F\n\n- [ ] T1 parent\n  - [ ] sub item\n---\n- [ ] T2 b\n"
  expect(parseFeature(src).tasks.map((t) => t.ref)).toEqual(["T1", "T2"])
})

test("an equals run under a run stamp is not a setext heading", () => {
  const src = "# F\n\n- [ ] T1 a\n      run: 2026-10-11T09:14 passed\n===\n- [ ] T2 b\n"
  expect(parseFeature(src).tasks.map((t) => t.ref)).toEqual(["T1", "T2"])
})

test("a rule under a blockquote note is not a setext heading", () => {
  const src = "# F\n\n- [ ] T1 a\n> note\n---\n- [ ] T2 b\n"
  expect(parseFeature(src).tasks.map((t) => t.ref)).toEqual(["T1", "T2"])
})

test("a bare dash under a run stamp is not a setext heading", () => {
  const src = "# F\n\n- [ ] T1 a\n      run: 2026-10-11T09:14 passed\n-\n- [ ] T2 b\n"
  expect(parseFeature(src).tasks.map((t) => t.ref)).toEqual(["T1", "T2"])
})

// A thematic break is not paragraph text either, so a run directly below
// another run underlines nothing. Two adjacent rules inside the task region is
// an unlikely file, but this is the one boundary case where closing it costs
// nothing: the only thing given up is a setext heading whose title is made
// purely of rule characters.

test("a rule below another rule is not a setext heading", () => {
  const src = "# F\n\n- [ ] T1 a\n\n---\n---\n- [ ] T2 b\n"
  expect(parseFeature(src).tasks.map((t) => t.ref)).toEqual(["T1", "T2"])
})

test("a rule below an asterisk rule is not a setext heading", () => {
  const src = "# F\n\n- [ ] T1 a\n\n***\n---\n- [ ] T2 b\n"
  expect(parseFeature(src).tasks.map((t) => t.ref)).toEqual(["T1", "T2"])
})

test("a rule below an underscore rule is not a setext heading", () => {
  const src = "# F\n\n- [ ] T1 a\n\n___\n---\n- [ ] T2 b\n"
  expect(parseFeature(src).tasks.map((t) => t.ref)).toEqual(["T1", "T2"])
})

test("a rule below a two-dash line is not a setext heading", () => {
  const src = "# F\n\n- [ ] T1 a\n\n--\n---\n- [ ] T2 b\n"
  expect(parseFeature(src).tasks.map((t) => t.ref)).toEqual(["T1", "T2"])
})

test("an equals run below a rule is not a setext heading", () => {
  const src = "# F\n\n- [ ] T1 a\n\n---\n===\n- [ ] T2 b\n"
  expect(parseFeature(src).tasks.map((t) => t.ref)).toEqual(["T1", "T2"])
})

// The title is searched body first, so a leading `---` that turns out to be a
// thematic break keeps the real title below it. The search never has to decide
// what the fences were, which is why it cannot lose a title that exists.

test("a document opening with a thematic break keeps its real title", () => {
  const src = "---\n# Widget export\n\nIntro.\n\n---\n\n- [ ] T1 a\n"
  const { title, tasks } = parseFeature(src)
  expect(title).toBe("Widget export")
  expect(tasks.map((t) => t.ref)).toEqual(["T1"])
})

test("reads a skipped frontmatter block for a title only when the body has none", () => {
  // A consolation, not a win: with no heading anywhere in the body there is no
  // real title to lose, so a `#` line in the skipped block is a better answer
  // than nothing. A body heading always outranks it - the test above this one
  // and the YAML-comment test both pin that order.
  const src = "---\n# status is managed by the planner\nstatus: active\n---\n\n- [ ] T1 a\n"
  expect(parseFeature(src).title).toBe("status is managed by the planner")
})

test("a rule under an unindented continuation line is not a setext heading", () => {
  // The last shape in this class, found by review rather than by the suite. An
  // unindented line directly under a task is a lazy continuation of that
  // item's paragraph, so the list block is still open and the run below it
  // underlines nothing. Only a blank line closes the block - which is exactly
  // what separates this from the `Notes` guard two tests down.
  const src = "# F\n\n- [ ] T1 a\nnote\n---\n- [ ] T2 b\n"
  expect(parseFeature(src).tasks.map((t) => t.ref)).toEqual(["T1", "T2"])
})

/* ========================================================================== */
/* Removing a task                                                            */
/* ========================================================================== */

/**
 * The dimension: **what surrounds the line being removed.** Values: the only
 * task; the first of several; the middle; the last with a trailing newline;
 * the last without one; a line using CRLF; and the ref occurring in *prose*
 * rather than as a task.
 *
 * The costs are not symmetric and the matrix is written for the expensive one.
 * Removing too much destroys the user's file - a neighbouring task, a heading,
 * a note under the task - inside their own repository, and nothing on the
 * surface would say what went missing. Removing too little leaves a blank
 * line, which is cosmetic and which they would have edited anyway. So this
 * removes exactly one element of `src.split("\n")` and joins, and the matrix
 * pins every byte that is not that line.
 *
 * It resolves the ref through `parseFeature` rather than a regex of its own,
 * for the reason the duplicate test below gives: two resolvers would
 * eventually disagree about which line `T1` is, and then ticking and removing
 * would act on different lines of the same file.
 */
describe("removeTask", () => {
  const ROWS: ReadonlyArray<{ why: string; src: string; ref: string; out: string }> = [
    {
      why: "the middle of a list",
      src: "# F\n\n- [ ] T1 a\n- [ ] T2 b\n- [ ] T3 c\n",
      ref: "T2",
      out: "# F\n\n- [ ] T1 a\n- [ ] T3 c\n",
    },
    {
      why: "the first task",
      src: "# F\n\n- [ ] T1 a\n- [ ] T2 b\n",
      ref: "T1",
      out: "# F\n\n- [ ] T2 b\n",
    },
    {
      why: "the last task, file ending in a newline",
      src: "# F\n\n- [ ] T1 a\n- [ ] T2 b\n",
      ref: "T2",
      out: "# F\n\n- [ ] T1 a\n",
    },
    {
      why: "the last task, file ending without one",
      src: "# F\n\n- [ ] T1 a\n- [ ] T2 b",
      ref: "T2",
      out: "# F\n\n- [ ] T1 a",
    },
    {
      why: "a done task",
      src: "# F\n\n- [x] T1 a\n- [ ] T2 b\n",
      ref: "T1",
      out: "# F\n\n- [ ] T2 b\n",
    },
    {
      why: "CRLF line endings, which must survive on every other line",
      src: "# F\r\n\r\n- [ ] T1 a\r\n- [ ] T2 b\r\n",
      ref: "T1",
      out: "# F\r\n\r\n- [ ] T2 b\r\n",
    },
    {
      why: "a BOM, which belongs to the file and not to the task",
      src: "﻿# F\n\n- [ ] T1 a\n- [ ] T2 b\n",
      ref: "T2",
      out: "﻿# F\n\n- [ ] T1 a\n",
    },
    {
      why: "the only task, leaving the prose that framed it",
      src: "# F\n\nSome notes.\n\n- [ ] T1 a\n",
      ref: "T1",
      out: "# F\n\nSome notes.\n\n",
    },
    {
      why: "a note under the task, which is not the task",
      src: "# F\n\n- [ ] T1 a\n  more about T1\n- [ ] T2 b\n",
      ref: "T2",
      out: "# F\n\n- [ ] T1 a\n  more about T1\n",
    },
  ]

  for (const { why, src, ref, out } of ROWS) {
    test(`removes ${why}`, () => {
      expect(removeTask(src, ref)).toBe(out)
    })
  }

  test("leaves every other task exactly where it was", () => {
    const src = "# F\n\n- [ ] T1 a\n- [ ] T2 b\n- [ ] T3 c\n"
    const after = parseFeature(removeTask(src, "T2"))
    expect(after.tasks.map((t) => t.ref)).toEqual(["T1", "T3"])
    expect(after.title).toBe("F")
  })

  /** A ref in prose is not a task, and the parser is what says so. */
  test("does not touch a line that merely mentions the ref", () => {
    const src = "# F\n\nT1 is described in the design.\n\n- [ ] T1 a\n"
    expect(removeTask(src, "T1")).toBe("# F\n\nT1 is described in the design.\n\n")
  })

  test("refuses a ref that is not there, rather than writing the file back unchanged", () => {
    expect(() => removeTask("# F\n\n- [ ] T1 a\n", "T9")).toThrow("no task T9")
  })

  /**
   * The same refusal `tickTask` makes, and deliberately the same words: a
   * duplicate ref means the file cannot say which line is meant, and a tool
   * that guessed here would delete one of two lines a human cannot tell apart.
   */
  test("refuses a duplicated ref, naming both lines", () => {
    const src = "# F\n\n- [ ] T1 a\n- [ ] T1 b\n"
    expect(() => removeTask(src, "T1")).toThrow("lines 3, 4")
  })

  test("a task with no ref cannot be addressed at all", () => {
    const src = "# F\n\n- [ ] no ref here\n- [ ] T1 a\n"
    expect(removeTask(src, "T1")).toBe("# F\n\n- [ ] no ref here\n")
  })
})

/* ========================================================================== */
/* Appending tasks                                                            */
/* ========================================================================== */

/**
 * Two dimensions, each with an expensive direction, so each is a matrix.
 *
 * **The ref.** Reusing a number is the costly mistake: two tasks sharing a ref
 * make `only` refuse, so that ref can then be neither ticked nor removed and
 * `src/run.ts` will not run it - one bad guess wedges two tasks. A gap in the
 * numbering costs only the appearance of one. So: highest plus one, gaps never
 * filled.
 *
 * **The position.** After the last *task* line, not the end of the file. A
 * backlog ending in a `## Notes` section would otherwise get its new tasks
 * under that heading, where they read as belonging to the notes.
 */
describe("appendTasks", () => {
  const REFS: ReadonlyArray<{ why: string; src: string; expect: string[] }> = [
    { why: "an empty file starts at T1", src: "", expect: ["T1"] },
    { why: "a file with no tasks starts at T1", src: "# F\n\nSome prose.\n", expect: ["T1"] },
    { why: "T1 and T2 continue at T3", src: "- [ ] T1 a\n- [ ] T2 b\n", expect: ["T3"] },
    { why: "a gap is not filled", src: "- [ ] T1 a\n- [ ] T5 b\n", expect: ["T6"] },
    { why: "out-of-order refs read the highest", src: "- [ ] T7 a\n- [ ] T2 b\n", expect: ["T8"] },
    { why: "a done task still holds its number", src: "- [x] T9 a\n", expect: ["T10"] },
    { why: "refless lines carry no number to clash with", src: "- [ ] no ref\n", expect: ["T1"] },
    { why: "two digits are compared as numbers, not strings", src: "- [ ] T9 a\n- [ ] T10 b\n", expect: ["T11"] },
  ]

  for (const { why, src, expect: refs } of REFS) {
    test(`numbering: ${why}`, () => {
      expect(appendTasks(src, ["new work"]).refs).toEqual(refs)
    })
  }

  test("numbers several in the order they were given", () => {
    const { src, refs } = appendTasks("- [ ] T1 a\n", ["one", "two", "three"])
    expect(refs).toEqual(["T2", "T3", "T4"])
    expect(src).toBe("- [ ] T1 a\n- [ ] T2 one\n- [ ] T3 two\n- [ ] T4 three\n")
  })

  test("never reuses a ref, which is the expensive direction", () => {
    const { src } = appendTasks("- [ ] T1 a\n- [ ] T5 b\n", ["c"])
    const refs = parseFeature(src).tasks.map((t) => t.ref)
    expect(new Set(refs).size).toBe(refs.length)
  })

  const PLACES: ReadonlyArray<{ why: string; src: string; out: string }> = [
    {
      why: "directly after the last task, not at the end of the file",
      src: "# F\n\n- [ ] T1 a\n\n## Notes\n\nSomething to remember.\n",
      out: "# F\n\n- [ ] T1 a\n- [ ] T2 new work\n\n## Notes\n\nSomething to remember.\n",
    },
    {
      // Found by appending to this project's own backlog, where T3's four
      // lines of detail instantly read as T4's. The row that was here before
      // asserted exactly that and called it "keeping its continuation line
      // with it", which was the opposite of what it pinned.
      why: "after the last task's indented detail, not above it",
      src: "# F\n\n- [ ] T1 a\n- [ ] T2 b\n      run: passed\n",
      out: "# F\n\n- [ ] T1 a\n- [ ] T2 b\n      run: passed\n- [ ] T3 new work\n",
    },
    {
      why: "after a lazy unindented continuation, which belongs to the item too",
      src: "# F\n\n- [ ] T1 a\nmore about a\n",
      out: "# F\n\n- [ ] T1 a\nmore about a\n- [ ] T2 new work\n",
    },
    {
      why: "before a heading that follows the last task without a blank line",
      src: "# F\n\n- [ ] T1 a\n## Notes\n\nSomething.\n",
      out: "# F\n\n- [ ] T1 a\n- [ ] T2 new work\n## Notes\n\nSomething.\n",
    },
    {
      why: "after the detail of a multi-line last task, with CRLF",
      src: "# F\r\n\r\n- [ ] T1 a\r\n      detail\r\n",
      out: "# F\r\n\r\n- [ ] T1 a\r\n      detail\r\n- [ ] T2 new work\r\n",
    },
    {
      why: "at the end when there is no task to sit after",
      src: "# F\n\nSome prose.\n",
      out: "# F\n\nSome prose.\n- [ ] T1 new work\n",
    },
    {
      why: "adding the terminator a file without one lacks",
      src: "# F\n\nSome prose.",
      out: "# F\n\nSome prose.\n- [ ] T1 new work\n",
    },
    {
      why: "CRLF, which the new line must use too",
      src: "# F\r\n\r\n- [ ] T1 a\r\n",
      out: "# F\r\n\r\n- [ ] T1 a\r\n- [ ] T2 new work\r\n",
    },
    {
      why: "a BOM, which belongs to the file",
      src: "﻿# F\n\n- [ ] T1 a\n",
      out: "﻿# F\n\n- [ ] T1 a\n- [ ] T2 new work\n",
    },
  ]

  for (const { why, src, out } of PLACES) {
    test(`places it ${why}`, () => {
      expect(appendTasks(src, ["new work"]).src).toBe(out)
    })
  }

  /**
   * The property the matrix above is really about: whatever the file looks
   * like, each existing task keeps the detail lines it had. Asserted as a
   * property because the defect it guards was invisible in an exact-output
   * row that had been written from the wrong behaviour.
   */
  test("no existing task loses its detail to a new one", () => {
    const src = `# F

- [ ] T1 first
      detail of first
- [ ] T2 second
      detail of second
      more detail of second
`
    const after = appendTasks(src, ["third"]).src
    expect(after).toContain("- [ ] T2 second\n      detail of second\n      more detail of second\n")
    // The new task is last, and carries nothing under it.
    expect(after.endsWith("- [ ] T3 third\n")).toBe(true)
  })

  test("the result parses back to the tasks that went in, in order", () => {
    const { src, refs } = appendTasks("# F\n\n- [ ] T1 first\n", ["second", "third"])
    const after = parseFeature(src)
    expect(after.tasks.map((t) => t.ref)).toEqual(["T1", ...refs])
    expect(after.tasks.map((t) => t.text)).toEqual(["first", "second", "third"])
    expect(after.tasks.every((t) => t.done === false)).toBe(true)
    expect(after.title).toBe("F")
  })

  test("trims each text and drops the ones that are only whitespace", () => {
    const { src, refs } = appendTasks("- [ ] T1 a\n", ["  padded  ", "   ", "", "also"])
    expect(refs).toEqual(["T2", "T3"])
    expect(parseFeature(src).tasks.map((t) => t.text)).toEqual(["a", "padded", "also"])
  })

  test("adding nothing writes nothing, rather than a blank task", () => {
    const src = "- [ ] T1 a\n"
    expect(appendTasks(src, [])).toEqual({ src, refs: [] })
    expect(appendTasks(src, ["  ", ""])).toEqual({ src, refs: [] })
  })
})
