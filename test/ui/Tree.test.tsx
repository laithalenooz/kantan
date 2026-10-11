/**
 * The task tree, and the nine-state system it renders.
 *
 * The design (docs/design/States.dc.html) makes one promise the tests have to
 * keep honest: **the glyph's shape carries the meaning, and colour only backs
 * it up**. The artboard proves it with a greyscale row. A test cannot grayscale
 * a bitmap here, so it does the equivalent on the DOM: it reduces each glyph to
 * a *shape signature* that is colour-blind by construction, and asserts the
 * nine signatures are distinct. Two controls keep that honest - recolouring a
 * real glyph must not move its signature, and a pair that differs only by
 * colour must collide.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import type { ReactElement } from "react"

/* Type-only, so neither import survives compilation: `src/runindex.ts` opens
 * files at module scope and has no business in a browser bundle, and the tree's
 * own types cost nothing to name. */
import type { RunState } from "../../src/runindex.ts"
import type { Account, TaskId, TreeFeature, TreeProject, TreeTask, TreeTaskRun } from "../../src/ui/Tree.tsx"

/*
 * Registered here rather than in bunfig.toml, which is shared with three
 * concurrent agents. Static imports hoist above this call, so react-dom and the
 * component under test are pulled in dynamically below: react-dom reads
 * `typeof document` while deciding on useLayoutEffect.
 *
 * `bun test` runs every file in one process and `register()` **throws** on a
 * second call, so a second UI test file is not a hypothetical: three exist.
 * Registering only when the slot is free, and tearing down only what this file
 * set up, makes the outcome the same in either order - and keeps this file from
 * pulling the document out from under another one that is still using it.
 */
let ownsDocument = false
try {
  GlobalRegistrator.register()
  ownsDocument = true
} catch {
  // Another UI test file in this process registered first. Its document is a
  // document, which is all this file needs, and its teardown stays its own.
}

const { renderToStaticMarkup } = await import("react-dom/server")
const {
  StateGlyph,
  StateLabel,
  Tree,
  taskStateOf,
  canStart,
  canResume,
  TASK_STATES,
} = await import("../../src/ui/Tree.tsx")
type TaskState = (typeof TASK_STATES)[number]

afterAll(async () => {
  if (ownsDocument) await GlobalRegistrator.unregister()
})

// --- The DOM harness --------------------------------------------------------

/** The markup of one element tree, parsed, so attributes can be read. */
function render(node: ReactElement): HTMLElement {
  const host = document.createElement("div")
  host.innerHTML = renderToStaticMarkup(node)
  return host
}

/** The one element a component rendered. */
function only(host: HTMLElement): Element {
  const first = host.firstElementChild
  if (!first) throw new Error("the component rendered no element")
  return first
}

// --- The colour-blind shape signature ---------------------------------------

/**
 * SVG attributes that describe geometry. Everything in this list survives a
 * greyscale filter unchanged, which is exactly why the signature may read it.
 */
const GEOMETRY_ATTRS = new Set([
  "cx",
  "cy",
  "d",
  "height",
  "points",
  "r",
  "rx",
  "ry",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-width",
  "viewBox",
  "width",
  "x",
  "x1",
  "x2",
  "y",
  "y1",
  "y2",
])

/**
 * Attributes that carry a colour. Reduced to "painted" or "not painted":
 * `fill="none"` against any fill at all is the difference between a ring and a
 * disc, which greyscale keeps as lightness - while *which* colour it is, which
 * greyscale destroys, never reaches the signature.
 */
const PAINT_ATTRS = new Set(["color", "fill", "stroke"])

/**
 * Utility classes with no colour in them. A whitelist, not a blacklist: a class
 * this does not recognise is dropped, so no colour can reach the signature by
 * being spelled in a way the test did not anticipate. Dropping too much makes
 * two glyphs collide and fails the test, which is the safe direction.
 */
const COLOURLESS_CLASSES = new Set([
  "absolute",
  "block",
  "border",
  "border-dashed",
  "border-solid",
  "box-border",
  "flex",
  "grid",
  "inline-flex",
  "items-center",
  "justify-center",
  "place-items-center",
  "relative",
  "rounded-full",
  "shrink-0",
])

/** `[11.5px]`, `[1.5px]`, `[620]` - a length or a number, not a colour. */
const ARBITRARY_LENGTH = /^\[-?[\d.]+(px|rem|em|%)?\]$/

/**
 * Utility prefixes that can carry a colour, whether as `bg-[#FF6A1A]` or as a
 * theme name like `border-muted-300`. Both reduce to `prefix:set`.
 *
 * Reducing them to the *same* marker is what the first mutation check bought:
 * while an arbitrary hex became `border:set` and a theme name was dropped
 * entirely, the signature could tell two identical rings apart on the strength
 * of how their colour was spelled, and a colour-only difference passed as a
 * shape difference.
 */
const PAINT_PREFIXES = [
  "accent",
  "bg",
  "border",
  "caret",
  "decoration",
  "divide",
  "fill",
  "from",
  "outline",
  "ring",
  "shadow",
  "stroke",
  "text",
  "to",
  "via",
]

function classSignature(value: string): string {
  const kept: string[] = []
  for (const token of value.split(/\s+/).filter(Boolean)) {
    if (COLOURLESS_CLASSES.has(token)) {
      kept.push(token)
      continue
    }
    const arbitrary = token.match(/^([a-z-]+?)-(\[[^\]]+\])$/)
    if (arbitrary) {
      const [, prefix = "", inner = ""] = arbitrary
      // A length is geometry and is kept verbatim. Anything else in an
      // arbitrary value - every colour this codebase writes is one - is
      // reduced to the fact that the property was set at all.
      kept.push(ARBITRARY_LENGTH.test(inner) ? `${prefix}${inner}` : `${prefix}:set`)
      continue
    }
    const prefix = PAINT_PREFIXES.find((p) => token.startsWith(`${p}-`))
    if (prefix) {
      kept.push(`${prefix}:set`)
      continue
    }
    // Unrecognised: dropped, because it cannot be proved colourless.
  }
  return [...new Set(kept)].sort().join(" ")
}

/** The text this element owns, not its descendants'. */
function ownText(node: Element): string {
  let text = ""
  for (const child of node.childNodes) {
    if (child.nodeType === 3) text += child.textContent ?? ""
  }
  return text.trim()
}

/**
 * One glyph reduced to shape, structure and text - never to colour.
 *
 * What goes in: tag names and nesting depth, SVG geometry, whether a paint
 * attribute is set at all, the colourless half of `class`, and visible text.
 * What cannot go in: any hue, anywhere.
 */
function shapeSignature(root: Element): string {
  const lines: string[] = []
  const walk = (node: Element, depth: number): void => {
    const bits = [`${depth}:${node.tagName.toLowerCase()}`]
    for (const name of [...node.getAttributeNames()].sort()) {
      const value = node.getAttribute(name) ?? ""
      if (name === "class") {
        const geometry = classSignature(value)
        if (geometry) bits.push(`class=${geometry}`)
      } else if (PAINT_ATTRS.has(name)) {
        bits.push(`${name}=${value === "none" ? "none" : "painted"}`)
      } else if (GEOMETRY_ATTRS.has(name)) {
        bits.push(`${name}=${value}`)
      }
    }
    const text = ownText(node)
    if (text) bits.push(`text=${text}`)
    lines.push(bits.join(" "))
    for (const child of node.children) walk(child, depth + 1)
  }
  walk(root, 0)
  return lines.join("|")
}

/** Every colour in a subtree replaced by a different one. Shape untouched. */
function recolour(root: Element): Element {
  const clone = root.cloneNode(true) as Element
  const paint = (node: Element): void => {
    for (const name of PAINT_ATTRS) {
      const value = node.getAttribute(name)
      // `none` is not a colour but the absence of one, and greyscale keeps that
      // difference, so the control must not erase it either.
      if (value !== null && value !== "none") node.setAttribute(name, "#4d7cff")
    }
    const classes = node.getAttribute("class")
    if (classes !== null) {
      node.setAttribute(
        "class",
        classes.replace(/\[#[0-9A-Fa-f]{3,8}\]/g, "[#4d7cff]"),
      )
    }
    for (const child of node.children) paint(child)
  }
  paint(clone)
  return clone
}

// --- The nine states --------------------------------------------------------

describe("the nine state glyphs", () => {
  test("every state has a glyph", () => {
    expect(TASK_STATES).toEqual([
      "open",
      "running",
      "needs-you",
      "passed",
      "failed",
      "stalled",
      "done-unmerged",
      "interrupted",
      "grinding",
    ])
  })

  test("all nine are distinguishable with colour removed", () => {
    const seen = new Map<string, TaskState>()
    for (const state of TASK_STATES) {
      const signature = shapeSignature(only(render(<StateGlyph state={state} />)))
      expect(signature).not.toBe("")
      const clash = seen.get(signature)
      if (clash) {
        throw new Error(
          `"${state}" and "${clash}" are the same shape and differ only by colour: ${signature}`,
        )
      }
      seen.set(signature, state)
    }
    expect(seen.size).toBe(TASK_STATES.length)
  })

  test("recolouring a glyph leaves its shape signature untouched", () => {
    for (const state of TASK_STATES) {
      const glyph = only(render(<StateGlyph state={state} />))
      expect(shapeSignature(recolour(glyph))).toBe(shapeSignature(glyph))
    }
  })

  test("only needs-you pulses, and only running spins", () => {
    const animated = new Map<TaskState, string[]>()
    for (const state of TASK_STATES) {
      const host = render(<StateGlyph state={state} count={6} />)
      const classes = [...host.querySelectorAll("*"), only(host)]
        .flatMap((el) => (el.getAttribute("class") ?? "").split(/\s+/))
        .filter((c) => c === "kantan-pulse" || c === "kantan-spin")
      if (classes.length > 0) animated.set(state, [...new Set(classes)])
    }
    expect(Object.fromEntries(animated)).toEqual({
      running: ["kantan-spin"],
      "needs-you": ["kantan-pulse"],
    })
  })

  test("the signature collides for two marks that differ only in colour", () => {
    const a = only(
      render(
        <span className="size-[14px] rounded-full border border-[#A3A7B1]">
          <svg viewBox="0 0 24 24">
            <path d="M20 6 9 17l-5-5" fill="none" stroke="#ffffff" />
          </svg>
        </span>,
      ),
    )
    const b = only(
      render(
        <span className="size-[14px] rounded-full border border-[#0F8A5F]">
          <svg viewBox="0 0 24 24">
            <path d="M20 6 9 17l-5-5" fill="none" stroke="#111216" />
          </svg>
        </span>,
      ),
    )
    expect(shapeSignature(a)).toBe(shapeSignature(b))
  })
})

// --- What the run log says, as one of the nine --------------------------------

/**
 * The mapping is a guess about input, which is what CLAUDE.md's skipping-guard
 * rule is about, so the dimensions are enumerated rather than sampled:
 * `RunState.kind` (five, two of them carrying a nested reason or flag), the
 * markdown checkbox, and the attempt count.
 */
describe("taskStateOf", () => {
  const task = (over: Partial<TreeTask> = {}): TreeTask => ({
    ref: "T1",
    text: "Parse the manifest",
    done: false,
    ...over,
  })
  const ran = (state: RunState, over: Partial<TreeTaskRun> = {}): TreeTaskRun => ({
    state,
    branch: "orch/importer-t1-ab12cd34",
    ...over,
  })

  test("a task with no run is open", () => {
    expect(taskStateOf(task())).toBe("open")
  })

  test("a ticked task with no run has passed, because only a passing run ticks it", () => {
    expect(taskStateOf(task({ done: true }))).toBe("passed")
  })

  test("every phase of a live run is running", () => {
    for (const phase of ["plan", "gate", "implement", "test", "refine"] as const) {
      expect(taskStateOf(task({ run: ran({ kind: "running", phase }) }))).toBe("running")
    }
  })

  test("a wait on a human is needs-you, whichever of the three reasons it is", () => {
    for (const reason of ["gate", "question", "blocked"] as const) {
      expect(taskStateOf(task({ run: ran({ kind: "waiting", reason }) }))).toBe("needs-you")
    }
  })

  test("a wait on a stall is stalled, not needs-you and not failed", () => {
    expect(taskStateOf(task({ run: ran({ kind: "waiting", reason: "stalled" }) }))).toBe("stalled")
  })

  test("done and merged has passed; done and unmerged is its own state", () => {
    expect(taskStateOf(task({ run: ran({ kind: "done", merged: true }) }))).toBe("passed")
    expect(taskStateOf(task({ run: ran({ kind: "done", merged: false }) }))).toBe("done-unmerged")
  })

  test("a ticked checkbox does not override the newest run", () => {
    expect(taskStateOf(task({ done: true, run: ran({ kind: "failed", why: "exit 1" }) }))).toBe(
      "failed",
    )
    expect(taskStateOf(task({ done: true, run: ran({ kind: "done", merged: false }) }))).toBe(
      "done-unmerged",
    )
  })

  test("a failed run is failed", () => {
    expect(taskStateOf(task({ run: ran({ kind: "failed", why: "the tests never passed" }) }))).toBe(
      "failed",
    )
  })

  test("an interrupted run is interrupted, wherever it would resume", () => {
    for (const resumeFrom of ["plan", "gate", "implement", "test", "refine"] as const) {
      expect(taskStateOf(task({ run: ran({ kind: "interrupted", resumeFrom }) }))).toBe(
        "interrupted",
      )
    }
  })

  test("grinding rides on running, past five attempts", () => {
    const attempts = (testAttempts: number | undefined): TaskState =>
      taskStateOf(
        task({ run: ran({ kind: "running", phase: "test" }, { testAttempts }) }),
      )
    expect(attempts(undefined)).toBe("running")
    for (const n of [0, 1, 2, 3, 4, 5]) expect(attempts(n)).toBe("running")
    for (const n of [6, 7, 40]) expect(attempts(n)).toBe("grinding")
  })

  /* The cheap direction to be wrong in. A count flagged too eagerly - or a
   * chip reading "×6.5" - trains the reader to ignore the notice, which is the
   * failure the design's own rate-limit note warns about; a notice withheld
   * costs nothing, because grinding blocks nothing and the cost is on screen
   * elsewhere. */
  test("an attempt count that is not a count never flags grinding", () => {
    for (const testAttempts of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY, 6.5]) {
      expect(
        taskStateOf(task({ run: ran({ kind: "running", phase: "test" }, { testAttempts }) })),
      ).toBe("running")
    }
  })

  test("nothing but running ever grinds", () => {
    const states: RunState[] = [
      { kind: "waiting", reason: "gate" },
      { kind: "waiting", reason: "stalled" },
      { kind: "done", merged: true },
      { kind: "done", merged: false },
      { kind: "failed", why: "exit 1" },
      { kind: "interrupted", resumeFrom: "test" },
    ]
    for (const state of states) {
      expect(taskStateOf(task({ run: ran(state, { testAttempts: 9 }) }))).not.toBe("grinding")
    }
  })
})

describe("what can be started, and what cannot", () => {
  const forState = (state: TaskState): TreeTask => {
    const ref = "T1"
    const text = "Parse the manifest"
    const branch = "orch/importer-t1-ab12cd34"
    switch (state) {
      case "open":
        return { ref, text, done: false }
      case "running":
        return { ref, text, done: false, run: { state: { kind: "running", phase: "test" }, branch } }
      case "grinding":
        return {
          ref,
          text,
          done: false,
          run: { state: { kind: "running", phase: "test" }, branch, testAttempts: 6 },
        }
      case "needs-you":
        return {
          ref,
          text,
          done: false,
          run: { state: { kind: "waiting", reason: "gate" }, branch },
        }
      case "stalled":
        return {
          ref,
          text,
          done: false,
          run: { state: { kind: "waiting", reason: "stalled" }, branch },
        }
      case "passed":
        return { ref, text, done: false, run: { state: { kind: "done", merged: true }, branch } }
      case "done-unmerged":
        return { ref, text, done: false, run: { state: { kind: "done", merged: false }, branch } }
      case "failed":
        return { ref, text, done: false, run: { state: { kind: "failed", why: "exit 1" }, branch } }
      case "interrupted":
        return {
          ref,
          text,
          done: false,
          run: { state: { kind: "interrupted", resumeFrom: "test" }, branch },
        }
    }
  }

  test("a done-unmerged task cannot be started again", () => {
    const task = forState("done-unmerged")
    expect(taskStateOf(task)).toBe("done-unmerged")
    expect(canStart(task)).toBe(false)
  })

  test("only an open task with a ref can be started", () => {
    const startable = TASK_STATES.filter((state) => canStart(forState(state)))
    expect(startable).toEqual(["open"])
  })

  test("a task with no ref cannot be started, because a run is addressed by its ref", () => {
    expect(canStart({ ref: null, text: "no ref on this line", done: false })).toBe(false)
  })

  test("interrupted is the one state that can be resumed", () => {
    const resumable = TASK_STATES.filter((state) => canResume(forState(state)))
    expect(resumable).toEqual(["interrupted"])
  })

  test("interrupted is not failed: it reads as resumable", () => {
    const interrupted = render(<StateLabel state="interrupted" />)
    const label = only(interrupted)
    expect(label.textContent).toBe("Interrupted")
    expect(label.textContent).not.toContain("Failed")
    expect(label.getAttribute("title")).toContain("Resume")
    expect(label.getAttribute("title")).toContain("not a failure")

    const failed = only(render(<StateLabel state="failed" />))
    expect(failed.textContent).toBe("Failed")
    expect(failed.getAttribute("title")).not.toContain("Resume")
  })
})

describe("StateLabel", () => {
  test("prints the design's word for each state", () => {
    const printed = TASK_STATES.map((state) => only(render(<StateLabel state={state} count={6} />)).textContent)
    expect(printed).toEqual([
      "Open",
      "Running",
      "Needs you",
      "Passed",
      "Failed",
      "Stalled",
      "Done · unmerged",
      "Interrupted",
      "×6",
    ])
  })

  test("an exit code is printed, never paraphrased", () => {
    expect(only(render(<StateLabel state="passed" exitCode={0} />)).textContent).toBe(
      "Passed · exit 0",
    )
    expect(only(render(<StateLabel state="failed" exitCode={137} />)).textContent).toBe(
      "Failed · exit 137",
    )
  })

  test("no exit code is invented when the run did not report one", () => {
    expect(only(render(<StateLabel state="failed" />)).textContent).toBe("Failed")
  })

  test("the open state is announced to a screen reader, since it prints nothing", () => {
    const label = only(render(<StateLabel state="open" />))
    expect(label.getAttribute("class")).toContain("sr-only")
    expect(label.textContent).toBe("Open")
  })
})

// --- The tree ----------------------------------------------------------------

/** The artboard's own fixture: three repos, two accounts, nine states between
 * them, and one task written in Arabic. */
function projects(): TreeProject[] {
  return [
    {
      path: "/home/me/code/your-app",
      account: { kind: "personal" },
      testCmd: "npm test",
      features: [
        {
          path: "docs/features/importer.md",
          tasks: [
            {
              ref: "T1",
              text: "Parse the manifest",
              done: true,
              run: { state: { kind: "done", merged: true }, branch: "orch/importer-t1-aa11bb22" },
            },
            {
              ref: "T2",
              text: "Map records to rows",
              done: false,
              run: {
                state: { kind: "waiting", reason: "gate" },
                branch: "orch/importer-t2-aa11bb23",
              },
            },
            { ref: "T3", text: "Runtime shim (v1.2)", done: false },
          ],
        },
        {
          path: "docs/features/export.md",
          tasks: [
            {
              ref: "T1",
              text: "Stream CSV export",
              done: false,
              run: {
                state: { kind: "interrupted", resumeFrom: "implement" },
                branch: "orch/export-t1-cc33dd44",
              },
            },
          ],
        },
      ],
    },
    {
      path: "/home/me/work/other-repo",
      account: { kind: "work" },
      testCmd: "vendor/bin/pest",
      features: [
        {
          path: "docs/features/billing.md",
          tasks: [
            {
              ref: "T1",
              text: "Ledger reconciliation",
              done: false,
              run: { state: { kind: "done", merged: false }, branch: "orch/billing-t1-ee55ff66" },
            },
            {
              ref: "T2",
              text: "Refund path",
              done: false,
              run: {
                state: { kind: "failed", why: "the tests never passed" },
                branch: "orch/billing-t2-ee55ff67",
                exitCode: 1,
              },
            },
            {
              ref: "T3",
              text: "Retry webhook deliveries with exponential backoff, and stop once the provider returns 410 Gone",
              done: false,
              run: {
                state: { kind: "waiting", reason: "stalled" },
                branch: "orch/billing-t3-ee55ff68",
              },
            },
          ],
        },
      ],
    },
    {
      path: "/home/me/code/phone-app",
      account: { kind: "personal" },
      testCmd: "flutter test",
      features: [
        {
          path: "docs/features/offline.md",
          tasks: [
            {
              ref: "T1",
              text: "Queue writes while offline",
              done: false,
              run: {
                state: { kind: "running", phase: "test" },
                branch: "orch/offline-t1-99aabbcc",
                testAttempts: 6,
              },
            },
            { ref: "T2", text: "مزامنة البيانات عند عودة الاتصال", done: false },
          ],
        },
      ],
    },
  ]
}

/** Every task row: the artboard builds one per task. */
function rows(host: HTMLElement): Element[] {
  return [...host.querySelectorAll('[data-task-row]')]
}

/**
 * The words an element shows, in order, one space between them.
 *
 * Not `textContent`: JSX strips the whitespace between sibling elements, so
 * `textContent` reads "T1Parse the manifest" and an assertion written against
 * it would be about this file's own formatting rather than about the row.
 */
function textOf(el: Element): string {
  const parts: string[] = []
  const walk = (node: Node): void => {
    if (node.nodeName === "STYLE" || node.nodeName === "SCRIPT") return
    if (node.nodeType === 3) {
      const text = (node.textContent ?? "").trim()
      if (text) parts.push(text)
      return
    }
    for (const child of node.childNodes) walk(child)
  }
  walk(el)
  return parts.join(" ").replace(/\s+/g, " ").trim()
}

describe("the tree", () => {
  test("one row per task, in the order the feature files list them", () => {
    const host = render(<Tree projects={projects()} />)
    expect(rows(host).map((r) => textOf(r).slice(0, 24))).toEqual([
      "T1 Parse the manifest Pa",
      "T2 Map records to rows N",
      "T3 Runtime shim (v1.2) O",
      "T1 Stream CSV export Int",
      "T1 Ledger reconciliation",
      "T2 Refund path Failed · ",
      "T3 Retry webhook deliver",
      "T1 Queue writes while of",
      "T2 مزامنة البيانات عند ع",
    ])
  })

  test("every project carries its account chip, its repo and its test command", () => {
    const host = render(<Tree projects={projects()} />)
    const chips = [...host.querySelectorAll("[data-account]")]
    expect(chips.map((c) => textOf(c))).toEqual(["personal", "work", "personal"])
    expect(chips.length).toBe(projects().length)
    expect(textOf(host)).toContain("your-app")
    expect(textOf(host)).toContain("$ npm test")
    expect(textOf(host)).toContain("$ vendor/bin/pest")
  })

  test("a work project never reads as personal", () => {
    const host = render(
      <Tree
        projects={[
          {
            path: "/srv/client-billing",
            account: { kind: "work" },
            testCmd: "vendor/bin/pest",
            features: [],
          },
        ]}
      />,
    )
    const chip = host.querySelector("[data-account]")
    expect(chip).not.toBeNull()
    expect(textOf(chip as Element)).toBe("work")
    expect(textOf(host)).not.toContain("personal")
  })

  test("an account that cannot be read says so rather than guessing", () => {
    const host = render(
      <Tree
        projects={[
          { path: "/srv/unknown", account: { kind: "unknown" }, testCmd: "make test", features: [] },
        ]}
      />,
    )
    const chip = textOf(host.querySelector("[data-account]") as Element)
    expect(chip).not.toContain("personal")
    expect(chip).not.toContain("work")
    expect(chip).toContain("unknown")
  })

  test("a caller's own account wording is printed", () => {
    const host = render(
      <Tree
        projects={[
          {
            path: "/srv/x",
            account: { kind: "work", label: "acme-client" },
            testCmd: "make test",
            features: [],
          },
        ]}
      />,
    )
    expect(textOf(host.querySelector("[data-account]") as Element)).toBe("acme-client")
  })

  test("the feature file path is shown for every feature", () => {
    const host = render(<Tree projects={projects()} />)
    expect([...host.querySelectorAll("[data-feature-path]")].map(textOf)).toEqual([
      "docs/features/importer.md",
      "docs/features/export.md",
      "docs/features/billing.md",
      "docs/features/offline.md",
    ])
  })
})

describe("paths and task text are arbitrary", () => {
  const LONG_PATH =
    "docs/features/platform/ingest/2026/q4/a-very-long-feature-file-name-that-nobody-would-type-twice-but-which-exists-anyway.md"
  const LONG_TASK =
    "Rewrite the importer so a feature file over one hundred and fifty characters long wraps instead of overflowing, and keep the byte-preserving tick"

  const longFixture = (): TreeProject[] => [
    {
      path: "/home/me/code/a-repository-with-an-extremely-long-directory-name-that-also-has-to-wrap-somewhere",
      account: { kind: "personal" },
      testCmd: "npm run test:everything -- --reporter=junit --outputFile=reports/junit.xml",
      features: [
        { path: LONG_PATH, tasks: [{ ref: "T1", text: LONG_TASK, done: false }] },
      ],
    },
  ]

  test("a path over 150 characters is present in full, never shortened", () => {
    expect(LONG_PATH.length).toBeGreaterThan(100)
    const host = render(<Tree projects={longFixture()} />)
    const shown = textOf(host.querySelector("[data-feature-path]") as Element)
    expect(shown).toBe(LONG_PATH)
    expect(shown).not.toContain("…")
  })

  test("a task over 150 characters is present in full", () => {
    expect(LONG_TASK.length).toBeGreaterThan(140)
    const host = render(<Tree projects={longFixture()} />)
    expect(textOf(host.querySelector("[data-task-text]") as Element)).toBe(LONG_TASK)
  })

  /* happy-dom has no layout engine and Tailwind is not compiled here, so this
   * asserts the contract that makes wrapping happen rather than a measured
   * line box: the cell may shrink below its content, breaks anywhere a long
   * token demands, and nothing clips or truncates it. */
  test("every cell holding arbitrary text can wrap and none of them truncates", () => {
    const host = render(<Tree projects={longFixture()} />)
    const cells = [
      ...host.querySelectorAll("[data-feature-path], [data-task-text], [data-repo], [data-test-cmd]"),
    ]
    expect(cells.length).toBe(4)
    for (const cell of cells) {
      const classes = cell.getAttribute("class") ?? ""
      expect(classes).toContain("min-w-0")
      expect(classes).toContain("[overflow-wrap:anywhere]")
      for (const forbidden of ["truncate", "text-nowrap", "whitespace-nowrap", "break-all", "text-ellipsis", "overflow-hidden"]) {
        expect(classes).not.toContain(forbidden)
      }
    }
  })

  test("task text carries dir=auto, since it may not be left to right", () => {
    const host = render(<Tree projects={projects()} />)
    const arabic = [...host.querySelectorAll("[data-task-text]")].find((c) =>
      textOf(c).startsWith("مزامنة"),
    )
    expect(arabic).toBeDefined()
    expect((arabic as Element).getAttribute("dir")).toBe("auto")
  })
})

describe("the states, in a row", () => {
  test("grinding keeps the spinning arc and moves the count into the label", () => {
    const host = render(<Tree projects={projects()} />)
    const row = rows(host).find((r) => textOf(r).includes("Queue writes while offline"))
    expect(row).toBeDefined()
    const glyph = (row as Element).querySelector("[data-glyph]")
    expect(glyph?.innerHTML ?? "").toContain("kantan-spin")
    expect(textOf((row as Element).querySelector("[data-state-label]") as Element)).toBe("×6")
  })

  test("across a whole tree, only needs-you pulses and only running spins", () => {
    const host = render(<Tree projects={projects()} />)
    const pulsing = rows(host).filter((r) => (r.innerHTML ?? "").includes("kantan-pulse"))
    const spinning = rows(host).filter((r) => (r.innerHTML ?? "").includes("kantan-spin"))
    expect(pulsing.map((r) => textOf(r).slice(0, 2))).toEqual(["T2"])
    expect(pulsing[0] && textOf(pulsing[0])).toContain("Needs you")
    expect(spinning.map((r) => textOf(r).slice(0, 2))).toEqual(["T1"])
    expect(spinning[0] && textOf(spinning[0])).toContain("×6")
  })

  test("a task whose branch name could not be derived says so", () => {
    const host = render(
      <Tree
        projects={[
          {
            path: "/home/me/code/your-app",
            account: { kind: "personal" },
            testCmd: "npm test",
            features: [
              {
                path: "docs/features/importer.md",
                tasks: [
                  {
                    ref: "T1",
                    text: "Parse the manifest",
                    done: false,
                    run: { state: { kind: "done", merged: false }, branch: "" },
                  },
                ],
              },
            ],
          },
        ]}
      />,
    )
    const row = rows(host)[0]
    expect(row).toBeDefined()
    const note = textOf((row as Element).querySelector("[data-branch-note]") as Element)
    expect(note).toContain("No branch name")
    expect(note).toContain("not checked for a merge")
  })

  test("a run with a branch name adds no note", () => {
    const host = render(<Tree projects={projects()} />)
    expect(host.querySelectorAll("[data-branch-note]").length).toBe(0)
  })

  test("a done-unmerged row is still selectable, and offers no start", () => {
    const host = render(<Tree projects={projects()} />)
    const row = rows(host).find((r) => textOf(r).includes("Ledger reconciliation"))
    expect(row).toBeDefined()
    expect((row as Element).tagName.toLowerCase()).toBe("button")
    expect(textOf(row as Element)).toContain("Done · unmerged")
    expect(textOf(host).toLowerCase()).not.toContain("start")
  })

  test("a task line with no ref is not a control, because nothing can be run on it", () => {
    const host = render(
      <Tree
        projects={[
          {
            path: "/home/me/code/your-app",
            account: { kind: "personal" },
            testCmd: "npm test",
            features: [
              {
                path: "docs/features/importer.md",
                tasks: [{ ref: null, text: "a line with no ref", done: false }],
              },
            ],
          },
        ]}
      />,
    )
    const row = rows(host)[0]
    expect(row).toBeDefined()
    expect((row as Element).tagName.toLowerCase()).not.toBe("button")
    expect(textOf(row as Element)).toContain("no ref")
  })
})

describe("selection", () => {
  const selected: TaskId = {
    projectPath: "/home/me/code/your-app",
    featureFile: "docs/features/importer.md",
    taskRef: "T2",
  }

  test("the selected row is the current one, keyed on the whole triple", () => {
    const host = render(<Tree projects={projects()} selected={selected} />)
    const current = rows(host).filter((r) => r.getAttribute("aria-current") === "true")
    expect(current.length).toBe(1)
    expect(textOf(current[0] as Element)).toContain("Map records to rows")
  })

  test("the same ref in another feature file is not selected", () => {
    const host = render(
      <Tree
        projects={projects()}
        selected={{ ...selected, featureFile: "docs/features/export.md", taskRef: "T1" }}
      />,
    )
    const current = rows(host).filter((r) => r.getAttribute("aria-current") === "true")
    expect(current.length).toBe(1)
    expect(textOf(current[0] as Element)).toContain("Stream CSV export")
  })

  test("the empty tree invites the first repository", () => {
    const host = render(<Tree projects={[]} />)
    expect(textOf(host)).toContain("No repositories yet")
    expect(rows(host).length).toBe(0)
  })
})

describe("selecting a task", () => {
  test("a click reports the whole triple, never the ref alone", async () => {
    const { createRoot } = await import("react-dom/client")
    const { act } = await import("react")
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

    const picked: TaskId[] = []
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    act(() => {
      root.render(<Tree projects={projects()} onSelect={(id) => picked.push(id)} />)
    })

    const row = rows(host).find((r) => textOf(r).includes("Refund path"))
    expect(row).toBeDefined()
    act(() => {
      ;(row as Element).dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })

    expect(picked).toEqual([
      {
        projectPath: "/home/me/work/other-repo",
        featureFile: "docs/features/billing.md",
        taskRef: "T2",
      },
    ])

    act(() => {
      root.unmount()
    })
    host.remove()
  })
})
