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
import { afterAll, afterEach, describe, expect, test } from "bun:test"
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

  /**
   * Both halves of each motion class are asserted, because the component emits
   * both: `spin`/`pulse` are `src/ui/artboard.css`'s own names, and
   * `kantan-spin`/`kantan-pulse` are the keyframes `Tree` renders itself. They
   * declare the same animation, so the glyph moves whichever stylesheet the
   * page ends up with - and listing all four here is what keeps a later edit
   * from quietly dropping the half that is load-bearing that day.
   */
  const MOTION_CLASSES = new Set(["spin", "pulse", "kantan-spin", "kantan-pulse"])

  test("only needs-you pulses, and only running spins", () => {
    const animated = new Map<TaskState, string[]>()
    for (const state of TASK_STATES) {
      const host = render(<StateGlyph state={state} count={6} />)
      const classes = [...host.querySelectorAll("*"), only(host)]
        .flatMap((el) => (el.getAttribute("class") ?? "").split(/\s+/))
        .filter((c) => MOTION_CLASSES.has(c))
      if (classes.length > 0) animated.set(state, [...new Set(classes)].sort())
    }
    expect(Object.fromEntries(animated)).toEqual({
      running: ["kantan-spin", "spin"],
      "needs-you": ["kantan-pulse", "pulse"],
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

  /**
   * `configDir` is carried, not drawn.
   *
   * It is the field that decides which Claude account a run actually bills to:
   * `src/spawn.ts` sets `CLAUDE_CONFIG_DIR` from it and `src/run.ts` records the
   * run's profile from it, while `project.account` is read by nothing outside
   * `accountOf()` in `src/server.ts` and is only the chip's word. So a shell
   * that cannot see this field cannot switch accounts - it moves the label and
   * bills the same profile as before.
   *
   * Optional rather than required, for the reason `Project.configDir` gives:
   * **absent means the default profile**, which is a real and common
   * configuration rather than missing data.
   *
   * The assertion is that it reaches the type and stays out of the column. It
   * is a filesystem path from the user's own machine, and the design gives it
   * no cell; printing it would be a layout change nobody asked for.
   */
  test("a project carries its config directory without drawing it", () => {
    const host = render(
      <Tree
        projects={[
          {
            path: "/home/me/code/your-app",
            account: { kind: "work" },
            testCmd: "npm test",
            configDir: "/home/me/.claude-work",
            features: [{ path: "docs/features/importer.md", tasks: [{ ref: "T1", text: "Parse", done: false }] }],
          },
        ]}
      />,
    )
    expect(textOf(host)).toContain("$ npm test")
    expect(textOf(host)).not.toContain(".claude-work")
    expect(host.innerHTML).not.toContain(".claude-work")
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

  /**
   * The artboard is a *reference implementation*, not a picture:
   * `docs/design/Main.dc.html` is plain HTML whose one `<style>` block
   * hand-writes every effect, and `src/ui/artboard.css` is that block
   * extracted under the same names. So "does the column match the design" has
   * a literal answer - does it carry the design's own classes - and this is it.
   *
   * It asserts *presence beside* the Tailwind equivalent, never instead of it.
   * `main.tsx` imports `artboard.css` today, but `main.tsx` is not this
   * component's to edit, and an `.ic` with no stylesheet behind it is an
   * invisible icon. Each pair declares the same thing, so either half renders
   * the column; the pair is what makes that true in both worlds.
   */
  test("the column carries the artboard's own class names", () => {
    const host = render(<Tree projects={projects()} onAddProject={() => {}} />)
    const classesOf = (el: Element | null): string[] =>
      (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean)

    // `.m` is Geist Mono, and rides with Tailwind's `font-mono`.
    for (const mono of [...host.querySelectorAll("[data-test-cmd]")]) {
      expect(classesOf(mono)).toContain("m")
      expect(classesOf(mono)).toContain("font-mono")
    }

    // `.ic` is the 16px line-icon preset: the explicit stroke attributes stay
    // beneath it, so an un-imported artboard.css still draws the icon.
    const icons = [...host.querySelectorAll("svg.ic")]
    expect(icons.length).toBeGreaterThan(4)
    for (const icon of icons) {
      expect(icon.getAttribute("fill")).toBe("none")
      expect(icon.getAttribute("stroke")).toBe("currentColor")
    }

    // `.trow` is the artboard's tree-row hover; the selected row has neither,
    // because the artboard gives the current row no hover at all.
    const unselected = rows(host).filter((r) => r.getAttribute("aria-current") !== "true")
    expect(unselected.length).toBeGreaterThan(0)
    for (const row of unselected) expect(classesOf(row)).toContain("trow")

    // `.ghost` is the artboard's ghost button, which is what `+` is.
    expect(classesOf(host.querySelector('button[aria-label="Add a repository"]'))).toContain("ghost")

    // `.bf` + the `.d1`-`.d9` ladder: one step per project, in column order.
    expect([...host.querySelectorAll("li.bf")].map((el) => classesOf(el).find((c) => /^d\d+$/.test(c)))).toEqual([
      "d1",
      "d2",
      "d3",
    ])
  })

  /**
   * The row's one guess about input, as a matrix rather than a sample.
   *
   * The dimension is how many lines the task text wraps to, which CSS cannot
   * read. `Main.dc.html` answers it by hand - `align-items:center` on eight of
   * its nine rows, `align-items:start` on the single six-line one - so a
   * component that renders arbitrary backlog text has to pick one for all.
   * `center` is the artboard's own answer for every row whose text fits in one
   * or two lines, which is every row in this fixture but one.
   */
  test("rows centre their glyph, ref and label, as eight of the artboard's nine do", () => {
    const host = render(<Tree projects={projects()} />)
    const all = rows(host)
    expect(all.length).toBe(9)
    for (const row of all) {
      const classes = row.getAttribute("class") ?? ""
      expect(classes).toContain("items-center")
      expect(classes).not.toContain("items-start")
      // The grid itself: the `minmax(0,1fr)` text track is what lets a long
      // task wrap instead of forcing the row wider than the column.
      expect(classes).toContain("grid-cols-[18px_22px_minmax(0,1fr)_auto]")
      expect(classes).toContain("min-h-[44px]")
    }
    // No cell may re-introduce the top nudge the start-aligned variant needed.
    for (const cell of host.querySelectorAll("[data-glyph], [data-state-label]")) {
      expect(cell.getAttribute("class") ?? "").not.toContain("mt-[1px]")
    }
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

// --- Keyboard navigation ----------------------------------------------------

/*
 * `j` and `k` move through tasks, and the thing they move is **DOM focus**, not
 * the selection. So these tests need a live root rather than the static markup
 * the rest of this file renders: `useSyncExternalStore` answers with its server
 * snapshot under `renderToStaticMarkup`, and nothing can be focused in a string.
 */
const { createRoot } = await import("react-dom/client")
const { act } = await import("react")
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const live: Array<{ host: HTMLElement; root: ReturnType<typeof createRoot> }> = []

async function mount(node: ReactElement): Promise<HTMLElement> {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  live.push({ host, root })
  await act(async () => {
    root.render(node)
  })
  return host
}

afterEach(async () => {
  for (const entry of live.splice(0)) {
    await act(async () => {
      entry.root.unmount()
    })
    entry.host.remove()
  }
  for (const stray of [...document.querySelectorAll("[data-probe]")]) stray.remove()
})

/** One keystroke, dispatched at a real element, the way a browser would. */
async function press(key: string, target: EventTarget, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }))
  })
}

/**
 * The task row that has focus, read as its text so a failure is legible.
 *
 * `<nothing>` covers every way of not being on a row, including `body`, which
 * is what `document.activeElement` answers when nothing is focused at all.
 */
function focusedRow(): string {
  const active = document.activeElement
  if (!(active instanceof HTMLElement)) return "<nothing>"
  const row = active.closest("[data-task-row]")
  return row === null ? "<nothing>" : textOf(row)
}

/** Every row, as text, in the order they are drawn. */
function rowTexts(host: HTMLElement): string[] {
  return rows(host).map(textOf)
}

/** One entry of a list, named so a missing one fails as itself. */
function nth(list: readonly string[], index: number): string {
  const found = list.at(index)
  if (found === undefined) throw new Error(`no row at ${index} in ${JSON.stringify(list)}`)
  return found
}

/**
 * An element of some other kind, in the document, that a keystroke can come
 * from. `data-probe` so the teardown can find it again.
 */
function probe(kind: string): HTMLElement {
  const el =
    kind === "contenteditable-child"
      ? (() => {
          const outer = document.createElement("div")
          outer.setAttribute("contenteditable", "true")
          const inner = document.createElement("span")
          inner.textContent = "half-written words"
          outer.append(inner)
          outer.setAttribute("data-probe", kind)
          document.body.append(outer)
          return inner
        })()
      : (() => {
          const made =
            kind === "textarea"
              ? document.createElement("textarea")
              : kind === "select"
                ? document.createElement("select")
                : kind.startsWith("input:")
                  ? Object.assign(document.createElement("input"), { type: kind.slice("input:".length) })
                  : document.createElement("div")
          if (kind === "contenteditable") made.setAttribute("contenteditable", "true")
          if (kind === "role=textbox") made.setAttribute("role", "textbox")
          if (kind === "role=combobox") made.setAttribute("role", "combobox")
          made.setAttribute("data-probe", kind)
          document.body.append(made)
          return made
        })()
  el.closest("[data-probe]")?.setAttribute("data-probe", kind)
  return el
}

describe("j and k move through tasks", () => {
  test("j walks down the rows and k walks back up", async () => {
    const host = await mount(<Tree projects={projects()} />)
    const order = rowTexts(host).filter((text) => !text.includes("no ref"))
    expect(order.length).toBeGreaterThan(3)

    await press("j", document.body)
    expect(focusedRow()).toBe(nth(order, 0))

    await press("j", document.activeElement ?? document.body)
    expect(focusedRow()).toBe(nth(order, 1))

    await press("j", document.activeElement ?? document.body)
    expect(focusedRow()).toBe(nth(order, 2))

    await press("k", document.activeElement ?? document.body)
    expect(focusedRow()).toBe(nth(order, 1))
  })

  test("j crosses from one project's last task into the next project's first", async () => {
    const host = await mount(<Tree projects={projects()} />)
    const order = rowTexts(host).filter((text) => !text.includes("no ref"))
    /* The fixture's first repo ends on `export.md`'s only task, and the second
     * begins on `billing.md`'s first. Two feature files and two repos are
     * crossed in one keystroke. */
    expect(nth(order, 3)).toContain("Stream CSV export")
    expect(nth(order, 4)).toContain("Ledger reconciliation")

    await press("j", document.body)
    for (let i = 1; i <= 3; i += 1) await press("j", document.activeElement ?? document.body)
    expect(focusedRow()).toBe(nth(order, 3))
    await press("j", document.activeElement ?? document.body)
    expect(focusedRow()).toBe(nth(order, 4))
  })

  test("the ends clamp rather than wrapping", async () => {
    const host = await mount(<Tree projects={projects()} />)
    const order = rowTexts(host).filter((text) => !text.includes("no ref"))

    await press("j", document.body)
    await press("k", document.activeElement ?? document.body)
    await press("k", document.activeElement ?? document.body)
    expect(focusedRow()).toBe(nth(order, 0))

    for (let i = 0; i < order.length + 3; i += 1) await press("j", document.activeElement ?? document.body)
    expect(focusedRow()).toBe(nth(order, -1))
  })

  test("the first j enters at the task the rest of the screen is about", async () => {
    await mount(
      <Tree
        projects={projects()}
        selected={{
          projectPath: "/home/me/code/your-app",
          featureFile: "docs/features/importer.md",
          taskRef: "T2",
        }}
      />,
    )
    await press("j", document.body)
    expect(focusedRow()).toContain("Map records to rows")
  })

  test("moving is not opening: j and k never select", async () => {
    const picked: TaskId[] = []
    await mount(<Tree projects={projects()} onSelect={(id) => picked.push(id)} />)

    await press("j", document.body)
    await press("j", document.activeElement ?? document.body)
    await press("k", document.activeElement ?? document.body)

    expect(picked).toEqual([])
    expect(focusedRow()).not.toBe("<nothing>")
  })

  test("a line with no ref is never focused, because nothing can be run on it", async () => {
    const host = await mount(
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
                  { ref: null, text: "a line with no ref", done: false },
                  { ref: "T1", text: "a line with one", done: false },
                ],
              },
            ],
          },
        ]}
      />,
    )
    expect(rows(host).length).toBe(2)

    await press("j", document.body)
    expect(focusedRow()).toContain("a line with one")
    await press("k", document.activeElement ?? document.body)
    expect(focusedRow()).toContain("a line with one")
  })

  test("the task the screen is about is the tree's one tab stop", async () => {
    const host = await mount(
      <Tree
        projects={projects()}
        selected={{
          projectPath: "/home/me/code/your-app",
          featureFile: "docs/features/importer.md",
          taskRef: "T2",
        }}
      />,
    )
    const tabbable = rows(host).filter((row) => row.getAttribute("tabindex") === "0")
    expect(tabbable.length).toBe(1)
    expect(textOf(tabbable[0] as Element)).toContain("Map records to rows")
    /* Every other row is reachable by j and k, and by nothing else. */
    const reachable = rows(host).filter((row) => row.tagName.toLowerCase() === "button")
    expect(reachable.filter((row) => row.getAttribute("tabindex") === "-1").length).toBe(
      reachable.length - 1,
    )
  })

  test("with nothing selected the first task is the tab stop", async () => {
    const host = await mount(<Tree projects={projects()} />)
    const tabbable = rows(host).filter((row) => row.getAttribute("tabindex") === "0")
    expect(tabbable.length).toBe(1)
    expect(textOf(tabbable[0] as Element)).toContain("Parse the manifest")
  })
})

describe("the arrow keys the hierarchy promises", () => {
  test("ArrowDown and ArrowUp are aliases of j and k, from a focused row", async () => {
    const host = await mount(<Tree projects={projects()} />)
    const order = rowTexts(host).filter((text) => !text.includes("no ref"))

    await press("j", document.body)
    await press("ArrowDown", document.activeElement ?? document.body)
    expect(focusedRow()).toBe(nth(order, 1))
    await press("ArrowUp", document.activeElement ?? document.body)
    expect(focusedRow()).toBe(nth(order, 0))
  })

  test("Home and End go to the first and last task", async () => {
    const host = await mount(<Tree projects={projects()} />)
    const order = rowTexts(host).filter((text) => !text.includes("no ref"))

    await press("j", document.body)
    await press("End", document.activeElement ?? document.body)
    expect(focusedRow()).toBe(nth(order, -1))
    await press("Home", document.activeElement ?? document.body)
    expect(focusedRow()).toBe(nth(order, 0))
  })

  test("an arrow key that did not start in the tree is left alone", async () => {
    await mount(<Tree projects={projects()} />)
    const box = probe("textarea")
    box.focus()
    await press("ArrowDown", box)
    expect(document.activeElement).toBe(box)
  })
})

describe("what j and k refuse to act on", () => {
  /*
   * The dimension these read is the keystroke itself: its target, and the
   * modifiers held with it. Both are enumerated rather than sampled, because a
   * guard that guesses wrong in the permissive direction swallows a keystroke
   * the browser or the operating system owns - `Ctrl+A` selects all, `⌘J` opens
   * the browser's downloads - and a guard that guesses wrong the other way
   * costs one click on a row that is right there.
   */
  const EDITABLE = [
    "textarea",
    "input:text",
    "input:search",
    "input:email",
    "input:number",
    "input:checkbox",
    "select",
    "contenteditable",
    "contenteditable-child",
    "role=textbox",
    "role=combobox",
  ] as const

  for (const kind of EDITABLE) {
    test(`a bare j typed into ${kind} moves nothing`, async () => {
      await mount(<Tree projects={projects()} />)
      const target = probe(kind)
      target.focus()
      await press("j", target)
      expect(focusedRow()).toBe("<nothing>")

      /* The control: the same keystroke from somewhere that is not a text
       * surface does move. Without it this test passes before the feature
       * exists. */
      await press("j", document.body)
      expect(focusedRow()).not.toBe("<nothing>")
    })
  }

  const MODIFIED: Array<[string, KeyboardEventInit]> = [
    ["meta", { metaKey: true }],
    ["ctrl", { ctrlKey: true }],
    ["alt", { altKey: true }],
    ["shift", { shiftKey: true }],
    ["ctrl and shift", { ctrlKey: true, shiftKey: true }],
  ]

  for (const [name, init] of MODIFIED) {
    test(`j held with ${name} belongs to someone else`, async () => {
      await mount(<Tree projects={projects()} />)
      await press("j", document.body, init)
      expect(focusedRow()).toBe("<nothing>")

      await press("j", document.body)
      expect(focusedRow()).not.toBe("<nothing>")
    })
  }

  test("a capital J is not the shortcut", async () => {
    await mount(<Tree projects={projects()} />)
    await press("J", document.body, { shiftKey: true })
    expect(focusedRow()).toBe("<nothing>")

    await press("j", document.body)
    expect(focusedRow()).not.toBe("<nothing>")
  })

  test("a keystroke something nearer already handled is not handled twice", async () => {
    await mount(<Tree projects={projects()} />)
    await act(async () => {
      const event = new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true })
      event.preventDefault()
      document.body.dispatchEvent(event)
    })
    expect(focusedRow()).toBe("<nothing>")

    await press("j", document.body)
    expect(focusedRow()).not.toBe("<nothing>")
  })

  test("a keystroke mid-composition is the IME's, not ours", async () => {
    await mount(<Tree projects={projects()} />)
    await press("j", document.body, { isComposing: true })
    expect(focusedRow()).toBe("<nothing>")

    await press("j", document.body)
    expect(focusedRow()).not.toBe("<nothing>")
  })

  test("the listener is gone once the tree unmounts", async () => {
    const host = await mount(<Tree projects={projects()} />)
    expect(rows(host).length).toBeGreaterThan(0)
    await press("j", document.body)
    expect(focusedRow()).not.toBe("<nothing>")
    for (const entry of live.splice(0)) {
      await act(async () => {
        entry.root.unmount()
      })
      entry.host.remove()
    }
    await press("j", document.body)
    expect(focusedRow()).toBe("<nothing>")
  })
})

describe("opening the focused task", () => {
  /*
   * `Enter` is deliberately **not** intercepted anywhere: every focusable row
   * is a `<button>`, and a browser turns `Enter` and `Space` on a focused
   * button into a click. happy-dom does not (probed: a dispatched `Enter`
   * keydown on a focused button fires no click), so what this suite can prove
   * is the half that is ours - the row j landed on is the row that activates,
   * and nothing swallows the keystroke on the way. The browser's half is
   * checked in a real Chromium, not here.
   */
  test("the row j landed on is the row that opens", async () => {
    const picked: TaskId[] = []
    await mount(<Tree projects={projects()} onSelect={(id) => picked.push(id)} />)

    await press("j", document.body)
    await press("j", document.activeElement ?? document.body)
    const landed = document.activeElement
    expect(landed).toBeInstanceOf(HTMLElement)
    expect((landed as HTMLElement).tagName.toLowerCase()).toBe("button")

    await act(async () => {
      ;(landed as HTMLElement).click()
    })
    expect(picked).toEqual([
      {
        projectPath: "/home/me/code/your-app",
        featureFile: "docs/features/importer.md",
        taskRef: "T2",
      },
    ])
  })

  test("Enter on a row is left for the browser to turn into a click", async () => {
    await mount(<Tree projects={projects()} />)
    await press("j", document.body)
    const before = document.activeElement
    expect(focusedRow()).not.toBe("<nothing>")

    let prevented = false
    await act(async () => {
      const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
      ;(before as HTMLElement).dispatchEvent(event)
      prevented = event.defaultPrevented
    })
    /* Not consumed, and focus has not moved: the button is still the one that
     * will be clicked. */
    expect(prevented).toBe(false)
    expect(document.activeElement).toBe(before)
  })
})

describe("the hierarchy a screen reader hears", () => {
  test("projects, feature files and tasks are nested lists, not flat divs", async () => {
    const host = await mount(<Tree projects={projects()} />)

    const projectList = host.querySelector("ul")
    expect(projectList).not.toBeNull()

    /* Three levels: projects, their feature files, and the tasks in each. */
    const depthOf = (el: Element): number => {
      let depth = 0
      let node: Element | null = el
      while (node !== null) {
        if (node.tagName.toLowerCase() === "ul") depth += 1
        node = node.parentElement
      }
      return depth
    }
    const taskItems = rows(host).map((row) => row.closest("li"))
    expect(taskItems.every((li) => li !== null)).toBe(true)
    expect(new Set(taskItems.map((li) => depthOf(li as Element)))).toEqual(new Set([3]))
  })

  test("every feature file names the list of tasks under it", async () => {
    const host = await mount(<Tree projects={projects()} />)
    const taskLists = [...host.querySelectorAll("ul")].filter((list) =>
      list.querySelector("[data-task-row]") !== null && list.querySelector("ul") === null,
    )
    /* One per feature file in the fixture: two in the first repo, one each in
     * the other two. */
    expect(taskLists.length).toBe(4)
    for (const list of taskLists) {
      const labelledBy = list.getAttribute("aria-labelledby")
      expect(labelledBy).not.toBeNull()
      const label = host.ownerDocument.getElementById(labelledBy as string)
      expect(label).not.toBeNull()
      expect(textOf(label as Element)).toMatch(/\.md$/)
    }
  })
})

describe("the column from the keyboard", () => {
  test("every control says where the keyboard is", async () => {
    /* A completeness check: Tailwind does not run under `bun test`, so what is
     * provable here is that no focusable element is *missing* a focus style,
     * which is the defect that ships. Visibility is a question for a browser. */
    const host = await mount(<Tree projects={projects()} onAddProject={() => {}} />)
    const focusable = [
      ...host.querySelectorAll<HTMLElement>("a[href], button, textarea, input, select, [tabindex]"),
    ]
    expect(focusable.length).toBeGreaterThan(2)
    const unringed = focusable.filter((el) => !/\bfocus-visible:/.test(el.className))
    expect(unringed.map((el) => `${el.tagName.toLowerCase()}: ${el.className}`)).toEqual([])
  })
})

describe("reduced motion holds the glyphs still", () => {
  const REDUCE = "(prefers-reduced-motion: reduce)"

  function setReducedMotion(on: boolean): void {
    const settings = (globalThis as unknown as {
      happyDOM?: { settings: { device: { prefersReducedMotion: string } } }
    }).happyDOM?.settings
    if (settings === undefined) throw new Error("happy-dom is not registered")
    settings.device.prefersReducedMotion = on ? "reduce" : "no-preference"
  }

  afterEach(() => setReducedMotion(false))

  /*
   * The media feature is set, not a prop. happy-dom's `getComputedStyle` does
   * **not** evaluate `@media (prefers-reduced-motion)` (probed), so the keyframe
   * guard in the stylesheet cannot be the only fallback: it would be untestable
   * here and invisible to any assertion. The glyph reads the feature itself and
   * says what it did.
   */
  test("needs-you stops pulsing and running stops spinning", async () => {
    setReducedMotion(true)
    const host = await mount(<Tree projects={projects()} />)
    const moving = [...host.querySelectorAll("[data-motion]")]
    expect(moving.length).toBeGreaterThan(0)
    expect(moving.map((el) => el.getAttribute("data-motion"))).toEqual(moving.map(() => "static"))
    expect(host.querySelectorAll(".pulse, .spin, .kantan-pulse, .kantan-spin").length).toBe(0)
    /* The entrance fade is motion too, and `artboard.css` guards it only under
     * a `.kr` root this component does not own. So `Tree` drops `.bf` itself. */
    expect(host.querySelectorAll(".bf").length).toBe(0)
  })

  test("and without the preference they really do move", async () => {
    setReducedMotion(false)
    const host = await mount(<Tree projects={projects()} />)
    const moving = [...host.querySelectorAll("[data-motion]")]
    expect(moving.length).toBeGreaterThan(0)
    expect(moving.map((el) => el.getAttribute("data-motion"))).toEqual(moving.map(() => "animated"))
    expect(host.querySelectorAll(".pulse.kantan-pulse").length).toBe(1)
    expect(host.querySelectorAll(".spin.kantan-spin").length).toBe(1)
    expect(host.querySelectorAll(".bf").length).toBe(3)
  })

  /*
   * Turning the preference on *while the page is open* is the case the cached
   * answer gets wrong, and it cannot be driven through happy-dom's own media
   * feature: `matchMedia` hands back a **new** `MediaQueryList` on every call
   * and never fires `change` when the setting moves (probed 2026-10-11), so the
   * object the component subscribed to is unreachable and silent.
   *
   * So this one test - and only this one - stands a single shared query object
   * in for `matchMedia`, restored immediately after. It proves the glyph is
   * *subscribed*; the two tests above prove the fallback exists, and those read
   * the real feature.
   */
  test("turning the preference on while the page is open stops them", async () => {
    const real = window.matchMedia.bind(window)
    const listeners = new Set<() => void>()
    let matches = false
    const fake = {
      media: REDUCE,
      get matches() {
        return matches
      },
      onchange: null,
      addEventListener: (_type: string, cb: () => void) => void listeners.add(cb),
      removeEventListener: (_type: string, cb: () => void) => void listeners.delete(cb),
      addListener: (cb: () => void) => void listeners.add(cb),
      removeListener: (cb: () => void) => void listeners.delete(cb),
      dispatchEvent: () => true,
    }
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => (query.includes("prefers-reduced-motion") ? fake : real(query)),
    })

    try {
      const host = await mount(<Tree projects={projects()} />)
      expect(host.querySelectorAll(".spin.kantan-spin").length).toBe(1)
      expect(listeners.size).toBeGreaterThan(0)

      await act(async () => {
        matches = true
        for (const cb of [...listeners]) cb()
      })
      expect(host.querySelectorAll(".spin, .kantan-spin").length).toBe(0)
      expect(host.querySelectorAll(".pulse, .kantan-pulse").length).toBe(0)
      expect(host.querySelectorAll(".bf").length).toBe(0)
    } finally {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: real,
      })
    }
  })
})

/* ========================================================================== */
/* Removing a task                                                            */
/* ========================================================================== */

/**
 * `Tree` only *asks*. The confirmation and the request are the shell's, which
 * is why these assert markup rather than behaviour - and why the control is a
 * sibling of the row rather than a child of it.
 */
describe("the remove-task control", () => {
  test("is not drawn at all when nothing can remove a task", () => {
    const host = render(<Tree projects={projects()} />)
    expect(host.querySelectorAll("[data-remove-task]")).toHaveLength(0)
  })

  test("is drawn for every task that has a ref, and named by it", () => {
    const host = render(<Tree projects={projects()} onRemoveTask={() => {}} />)
    const refs = [...host.querySelectorAll("[data-remove-task]")].map((b) =>
      b.getAttribute("data-remove-task"),
    )
    const withRefs = projects()
      .flatMap((p) => p.features)
      .flatMap((f) => f.tasks)
      .filter((t) => t.ref !== null)
      .map((t) => t.ref)
    expect(refs).toEqual(withRefs)
    for (const button of host.querySelectorAll("[data-remove-task]")) {
      const ref = button.getAttribute("data-remove-task")
      expect(button.getAttribute("aria-label")).toBe(`Remove ${ref}`)
    }
  })

  /**
   * A line with no ref cannot be addressed: `DELETE /api/features/task` takes
   * a ref, and there is nothing to send. Its own fixture, because `projects()`
   * is the artboard's and has no such line - a row this file had to add is
   * still a row `src/backlog.ts` parses, and `parseFeature` yields
   * `ref: null` for any `- [ ]` line without a `T<n>`.
   */
  test("is not drawn for a line with no ref", () => {
    const mixed: TreeProject[] = [
      {
        path: "/home/me/code/app",
        account: { kind: "personal" },
        testCmd: "npm test",
        features: [
          {
            path: "docs/features/x.md",
            tasks: [
              { ref: "T1", text: "Addressable", done: false },
              { ref: null, text: "A line with no ref", done: false },
            ],
          },
        ],
      },
    ]
    const host = render(<Tree projects={mixed} onRemoveTask={() => {}} />)

    const controls = [...host.querySelectorAll("[data-remove-task]")]
    expect(controls.map((b) => b.getAttribute("data-remove-task"))).toEqual(["T1"])

    // The refless row is a `div`, not a button, and carries no control.
    const rows = [...host.querySelectorAll("[data-task-row]")]
    const refless = rows.filter((r) => r.tagName === "DIV")
    expect(refless).toHaveLength(1)
    expect(refless[0]?.parentElement?.querySelector("[data-remove-task]")).toBeNull()
  })

  /**
   * A button inside a button is invalid HTML and swallows its own clicks. The
   * project row's account chip was nested like that once, and this pins the
   * lesson rather than trusting it: the control is a *sibling* of the row.
   */
  test("is never nested inside the row button", () => {
    const host = render(<Tree projects={projects()} onRemoveTask={() => {}} />)
    for (const button of host.querySelectorAll("[data-remove-task]")) {
      expect(button.closest("[data-task-row]")).toBeNull()
      expect(button.parentElement?.tagName).toBe("LI")
    }
  })

  /** Reachable by keyboard as well as by hover; a pointer-only control is not
   *  reachable. The row is the tree's one Tab stop, so `focus-within` on the
   *  item is what brings this into view for the arrow-key navigation. */
  test("appears on focus as well as on hover", () => {
    const host = render(<Tree projects={projects()} onRemoveTask={() => {}} />)
    const first = host.querySelector("[data-remove-task]")
    const classes = first?.getAttribute("class") ?? ""
    expect(classes).toContain("group-hover/task:opacity-100")
    expect(classes).toContain("group-focus-within/task:opacity-100")
    expect(classes).toContain("focus-visible:opacity-100")
  })
})
