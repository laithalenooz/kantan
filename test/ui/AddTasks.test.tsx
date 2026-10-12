/**
 * Adding tasks to a task file: `docs/design/AddTasks.dc.html`.
 *
 * ## What is actually at risk in this component
 *
 * **Every rule in it decides what to skip, number or normalise**, which is the
 * exact class `CLAUDE.md` says produced fourteen defects in `src/backlog.ts`.
 * There are four of them and each is pinned as a matrix below rather than on
 * the one value the artboard happens to draw:
 *
 *  - `nextRefNumber` — the artboard hardcodes `n = 4` after `T3`. The real rule
 *    is *highest numeric ref plus one*, and both tempting alternatives collide:
 *    count-plus-one repeats `T4` on `[T1, T3, T4]`, and a string maximum
 *    answers `T9` for `[T9, T10]`. A duplicate ref makes `tickTask` **throw**,
 *    so the file stops working; a gap is valid markdown the parser reads fine.
 *    Every uncertain case therefore numbers **higher**.
 *  - `manualLines` — the "Write them" box is free text, so the dimension is the
 *    bytes someone typed or pasted: blank lines, CRLF, tabs, U+3000, a pasted
 *    `- [ ] T5 foo`, U+2028, non-English text.
 *  - `fileName` — one path, drawn three times, and an empty heading is the
 *    failure.
 *  - a checked draft someone has emptied — `src/draft.ts` refuses a task line
 *    with no text, so writing one is writing a line the drafter would reject.
 *
 * **The refs on screen are a preview and the server's are the truth.** The
 * human may edit the file between the draft and the write, so `onAdd` sends
 * texts only and the confirmation prints the refs the *server* reports. A
 * confirmation naming the preview's refs would be invented text, which is the
 * one thing this screen may never do.
 *
 * **The artboard can write the same lines twice.** Its `onManual` sets
 * `added: false`, so typing one character after a successful add brings the
 * button back with the already-written lines still counted. The tests below pin
 * the correction: a successful add consumes exactly what it wrote.
 *
 * **Reduced motion.** `CLAUDE.md` records Motion's `useReducedMotion()` as a
 * module-level singleton that has answered `false` with the media feature set,
 * so the component ORs it with a live `matchMedia` read. Motion's half is
 * quarantined to `false` here on purpose, which means these tests exercise the
 * live half — the half that has to work. Deleting either side of that `||` must
 * turn this file red.
 *
 * `docs/HANDOFF.md`: judge by the whole `bun run check`, never by this file
 * alone. Whichever UI suite runs first seeds Motion's singleton.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"

/* Type-only, so nothing here is evaluated before the window exists. */
import type { AddTasksProps, ExistingTask, Proposal } from "../../src/ui/AddTasks.tsx"

/*
 * The window is taken only if the slot is free, and **never given back**.
 *
 * `docs/HANDOFF.md`: an `unregister()` in an `afterAll` closed the window
 * before a later UI suite was even loaded, and froze another agent's cost
 * ticker. So the window outlives this file.
 */
let ownsDocument = false

interface Api {
  act: typeof import("react").act
  StrictMode: typeof import("react").StrictMode
  createRoot: typeof import("react-dom/client").createRoot
  AddTasks: typeof import("../../src/ui/AddTasks.tsx").AddTasks
  fileName: typeof import("../../src/ui/AddTasks.tsx").fileName
  nextRefNumber: typeof import("../../src/ui/AddTasks.tsx").nextRefNumber
  manualLines: typeof import("../../src/ui/AddTasks.tsx").manualLines
  MAX_DIFF_LINES: typeof import("../../src/ui/Row.tsx").MAX_DIFF_LINES
}

/**
 * Two query objects, and the split is not cosmetic.
 *
 * `bun test` runs every file in one process and Motion keeps its reduced-motion
 * answer in a module-level singleton seeded at the **first call anywhere in
 * that process**. A stub that matched the feature loosely would hand Motion the
 * same object this file toggles, and every `setPrefersReduce(true)` here would
 * reach into Motion's process-wide state and stay there. The pattern is
 * `test/ui/Empty.test.tsx`'s.
 */
const REDUCE_QUERY = "(prefers-reduced-motion: reduce)"

let prefersReduce = false
const reduceListeners = new Set<(event: { matches: boolean }) => void>()

const reduceQuery = {
  media: REDUCE_QUERY,
  get matches() {
    return prefersReduce
  },
  onchange: null,
  addEventListener: (_type: string, cb: (event: { matches: boolean }) => void) => void reduceListeners.add(cb),
  removeEventListener: (_type: string, cb: (event: { matches: boolean }) => void) => void reduceListeners.delete(cb),
  addListener: (cb: (event: { matches: boolean }) => void) => void reduceListeners.add(cb),
  removeListener: (cb: (event: { matches: boolean }) => void) => void reduceListeners.delete(cb),
  dispatchEvent: () => false,
}

/** Motion's own query. Always calm, and never notified. */
const quarantinedQuery = {
  media: "(prefers-reduced-motion)",
  matches: false,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
}

let realMatchMedia: typeof window.matchMedia | undefined

function setPrefersReduce(value: boolean): void {
  prefersReduce = value
  for (const cb of reduceListeners) cb({ matches: value })
}

let api: Api

beforeAll(async () => {
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register()
    ownsDocument = true
  }
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

  /* The stub goes in before `AddTasks.tsx` is pulled in: `motion-dom` decides
   * `isBrowser` and seeds its reduced-motion singleton at module evaluation,
   * and this module reaches it twice — directly, and through `Row.tsx`. */
  realMatchMedia = window.matchMedia.bind(window)
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => {
      if (query === REDUCE_QUERY) return reduceQuery
      if (query.includes("prefers-reduced-motion")) return quarantinedQuery
      return realMatchMedia?.(query)
    },
  })

  const react = await import("react")
  const client = await import("react-dom/client")
  const mod = await import("../../src/ui/AddTasks.tsx")
  const row = await import("../../src/ui/Row.tsx")
  api = {
    act: react.act,
    StrictMode: react.StrictMode,
    createRoot: client.createRoot,
    AddTasks: mod.AddTasks,
    fileName: mod.fileName,
    nextRefNumber: mod.nextRefNumber,
    manualLines: mod.manualLines,
    MAX_DIFF_LINES: row.MAX_DIFF_LINES,
  }
})

afterAll(() => {
  if (realMatchMedia !== undefined) {
    Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: realMatchMedia })
  }
  /* Deliberately **not** `GlobalRegistrator.unregister()`. See `ownsDocument`. */
  void ownsDocument
  reduceListeners.clear()
})

// --- Rendering --------------------------------------------------------------

let host: HTMLElement
let root: ReturnType<typeof api.createRoot>

beforeEach(() => {
  host = document.createElement("div")
  document.body.append(host)
  root = api.createRoot(host)
})

afterEach(async () => {
  try {
    await api.act(async () => {
      root.unmount()
    })
  } finally {
    host.remove()
    setPrefersReduce(false)
  }
})

async function render(ui: React.ReactNode): Promise<void> {
  await api.act(async () => {
    root.render(ui)
  })
}

function one<E extends Element>(selector: string): E {
  const found = host.querySelector<E>(selector)
  if (found === null) throw new Error(`nothing matched ${selector} in ${host.innerHTML}`)
  return found
}

function all<E extends Element>(selector: string): E[] {
  return [...host.querySelectorAll<E>(selector)]
}

function maybe<E extends Element>(selector: string): E | null {
  return host.querySelector<E>(selector)
}

function text(selector: string): string {
  return (one(selector).textContent ?? "").replaceAll(/\s+/g, " ").trim()
}

function classesOf(selector: string): string[] {
  return (one(selector).getAttribute("class") ?? "").split(/\s+/).filter((c) => c !== "")
}

/** Every button, by its visible text, so a label change names itself. */
function buttonLabels(): string[] {
  return all<HTMLButtonElement>("button").map((b) => (b.textContent ?? "").replaceAll(/\s+/g, " ").trim())
}

function button(label: string): HTMLButtonElement {
  const found = all<HTMLButtonElement>("button").find(
    (b) => (b.textContent ?? "").replaceAll(/\s+/g, " ").trim() === label,
  )
  if (!found) throw new Error(`no button labelled ${JSON.stringify(label)}; have ${JSON.stringify(buttonLabels())}`)
  return found
}

async function click(el: Element): Promise<void> {
  await api.act(async () => {
    ;(el as HTMLElement).click()
  })
}

/**
 * Types into a controlled input or textarea.
 *
 * Through the prototype's own setter, not `el.value =`: React installs a value
 * tracker on the node, and assigning past it leaves React's idea of the value
 * and the DOM's disagreeing — which crashes its change plugin rather than
 * failing an assertion. `test/ui/Gate.test.tsx` records the same trap. The
 * descriptor is read lazily, because the window does not exist at module load.
 */
async function type(el: Element, value: string): Promise<void> {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const set = Object.getOwnPropertyDescriptor(proto, "value")?.set
  if (!set) throw new Error("no native value setter to type through")
  await api.act(async () => {
    set.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

/** React's change plugin reads a checkbox from its `click`, so this clicks. */
async function toggle(el: Element): Promise<void> {
  await api.act(async () => {
    ;(el as HTMLInputElement).click()
  })
}

// --- Fixtures ---------------------------------------------------------------

/** The artboard's own file: three tasks, the first two finished. */
const TASKS: readonly ExistingTask[] = [
  { ref: "T1", text: "Parse the manifest", done: true },
  { ref: "T2", text: "Map records to rows", done: true },
  { ref: "T3", text: "Runtime shim (v1.2)", done: false },
]

/** The artboard's three drafts, verbatim. */
const DRAFTS: readonly string[] = [
  "Record a checkpoint after each committed batch so an interrupted import resumes from the last row",
  "Add --dry-run: map every record and print the summary without writing",
  "List skipped rows with their manifest line numbers in the summary",
]

function props(over: Partial<AddTasksProps> = {}): AddTasksProps {
  return {
    project: "your-app",
    featureFile: "docs/features/importer.md",
    tasks: TASKS,
    onAdd: () => ["T4"],
    ...over,
  }
}

/** A promise whose settling this test controls. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Renders, drafts, and resolves with the artboard's three proposals. */
async function drafted(over: Partial<AddTasksProps> = {}): Promise<{ asked: string[] }> {
  const asked: string[] = []
  await render(
    <api.AddTasks
      {...props({
        onDraft: (prompt) => {
          asked.push(prompt)
          return { tasks: DRAFTS, costUsd: 0.03 }
        },
        ...over,
      })}
    />,
  )
  await type(one('[role="tabpanel"] textarea'), "Imports should resume after a crash")
  await click(button("Draft tasks"))
  return { asked }
}

/** The diff's rendered lines, gutter included. */
function diffLines(): string[] {
  return all("pre span").map((s) => s.textContent ?? "")
}

// --- The file it is adding to ----------------------------------------------

describe("the file it is adding to", () => {
  test("the heading, the breadcrumb and the lede all name it", async () => {
    await render(<api.AddTasks {...props()} />)

    expect(text("h1")).toBe("Add tasks to importer.md")
    /* Two spans with a chevron between them. The gap is `gap-2`, not a text
     * node, so `textContent` runs them together. */
    expect(all('nav[aria-label="Breadcrumb"] span').map((s) => s.textContent)).toEqual(["your-app", "importer.md"])
    expect(text("h1 + p")).toBe(
      "New tasks go at the end of docs/features/importer.md in your working tree, numbered after T3. " +
        "Commit the file whenever you like.",
    )
  })

  test("a file with no refs yet numbers from T1, and says so", async () => {
    await render(<api.AddTasks {...props({ tasks: [] })} />)
    expect(text("h1 + p")).toContain("numbered from T1")
  })

  test("a file whose only line has no ref also numbers from T1", async () => {
    await render(<api.AddTasks {...props({ tasks: [{ ref: null, text: "no ref here", done: false }] })} />)
    expect(text("h1 + p")).toContain("numbered from T1")
  })

  /**
   * One path, drawn three times, and the cost of a wrong guess is not
   * symmetric: a heading reading "Add tasks to " tells the user nothing, while
   * printing the whole path is merely long. So the fallback is the input.
   */
  test("fileName, over every shape a path can take", () => {
    const cases: readonly [string, string][] = [
      ["docs/features/importer.md", "importer.md"],
      ["importer.md", "importer.md"],
      ["./docs/features/importer.md", "importer.md"],
      ["docs/features/", "features"],
      ["docs//features//importer.md", "importer.md"],
      ["/absolute/importer.md", "importer.md"],
      ["", ""],
      ["/", "/"],
      ["日本語.md", "日本語.md"],
    ]
    for (const [path, want] of cases) {
      expect(api.fileName(path)).toBe(want)
    }
  })
})

// --- Numbering --------------------------------------------------------------

describe("numbering the new tasks", () => {
  /**
   * The matrix the artboard could not have: it hardcodes `n = 4`.
   *
   * Count-plus-one and a string maximum both **collide**, and a duplicate ref
   * makes `tickTask` throw rather than tick. A gap is valid markdown, so every
   * uncertain case numbers higher.
   */
  test("the next ref is the highest numeric ref plus one", () => {
    const t = (ref: string | null): ExistingTask => ({ ref, text: "x", done: false })
    const cases: readonly [string, readonly ExistingTask[], number][] = [
      ["the artboard's file", [t("T1"), t("T2"), t("T3")], 4],
      ["no tasks at all", [], 1],
      ["one task", [t("T1")], 2],
      ["a gap, where count+1 would repeat T4", [t("T1"), t("T3"), t("T4")], 5],
      ["out of order", [t("T2"), t("T1")], 3],
      ["two digits, where a string max would answer T9", [t("T9"), t("T10")], 11],
      ["three digits", [t("T99"), t("T100")], 101],
      ["only a ref-less line", [t(null)], 1],
      ["ref-less lines mixed in", [t("T1"), t(null), t("T2")], 3],
      ["a duplicate in the file already", [t("T2"), t("T2")], 3],
      ["T0, which is legal to write by hand", [t("T0")], 1],
      ["a done task still consumes its number", [{ ref: "T7", text: "x", done: true }], 8],
    ]
    for (const [why, tasks, want] of cases) {
      expect(api.nextRefNumber(tasks), why).toBe(want)
    }
  })

  test("the drafted rows carry the refs they would be written as", async () => {
    await drafted()
    expect(all("li span.m").map((s) => s.textContent)).toEqual(["T4", "T5", "T6"])
  })
})

// --- The two tabs -----------------------------------------------------------

describe("the two tabs", () => {
  test("both are offered when drafting is wired, and Ask Claude is the first", async () => {
    await render(<api.AddTasks {...props({ onDraft: () => ({ tasks: DRAFTS }) })} />)

    const tabs = all<HTMLButtonElement>('[role="tab"]')
    expect(tabs.map((t) => (t.textContent ?? "").trim())).toEqual(["Ask Claude", "Write them"])
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false"])
    expect(one('[role="tablist"]').getAttribute("aria-label")).toBe("How to add tasks")
  })

  /**
   * A tab whose action is not wired is a dead control, and the person who finds
   * that out is the user. The cheap direction is to offer one way in rather
   * than two when only one works — and "Write them" needs nothing but `onAdd`.
   */
  test("no tablist at all when drafting is not wired", async () => {
    await render(<api.AddTasks {...props()} />)

    expect(maybe('[role="tablist"]')).toBeNull()
    expect(maybe('[role="tab"]')).toBeNull()
    expect(buttonLabels()).not.toContain("Draft tasks")
    expect(text("label")).toBe("One task per line")
  })

  test("the panels are wired to their tabs, and only the selected one renders", async () => {
    await render(<api.AddTasks {...props({ onDraft: () => ({ tasks: DRAFTS }) })} />)

    const tabs = all<HTMLButtonElement>('[role="tab"]')
    const [ask, write] = tabs
    if (!ask || !write) throw new Error("expected two tabs")

    const panels = all('[role="tabpanel"]')
    expect(panels).toHaveLength(1)
    const panel = panels[0]
    if (!panel) throw new Error("expected a panel")
    expect(panel.getAttribute("aria-labelledby")).toBe(ask.id)
    expect(ask.getAttribute("aria-controls")).toBe(panel.id)

    await click(write)
    expect(all<HTMLButtonElement>('[role="tab"]').map((t) => t.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
    ])
    expect(one('[role="tabpanel"]').getAttribute("aria-labelledby")).toBe(write.id)
  })

  /**
   * The tabs pattern makes a panel focusable only when it holds nothing
   * focusable. Both panels open with a text box, so a `tabIndex` here would be
   * a stop in the tab order with nothing to do — and the artboard resets the
   * outline, so nothing to see either.
   */
  test("the panel is not a tab stop of its own", async () => {
    await render(<api.AddTasks {...props({ onDraft: () => ({ tasks: DRAFTS }) })} />)
    expect(one('[role="tabpanel"]').hasAttribute("tabindex")).toBe(false)
  })

  /** The canvas note names shadcn Tabs, which is the WAI-ARIA tabs pattern:
   * one stop in the tab order, and the arrows move between tabs. */
  test("roving tabindex and arrow keys, as the tabs pattern requires", async () => {
    await render(<api.AddTasks {...props({ onDraft: () => ({ tasks: DRAFTS }) })} />)

    expect(all<HTMLButtonElement>('[role="tab"]').map((t) => t.tabIndex)).toEqual([0, -1])

    const press = async (key: string): Promise<void> => {
      const current = all<HTMLButtonElement>('[role="tab"]').find((t) => t.tabIndex === 0)
      if (!current) throw new Error("no tab in the tab order")
      await api.act(async () => {
        current.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }))
      })
    }

    await press("ArrowRight")
    expect(all<HTMLButtonElement>('[role="tab"]').map((t) => t.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
    ])
    await press("ArrowRight")
    expect(all<HTMLButtonElement>('[role="tab"]').map((t) => t.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
    ])
    await press("End")
    expect(all<HTMLButtonElement>('[role="tab"]').map((t) => t.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
    ])
    await press("Home")
    expect(all<HTMLButtonElement>('[role="tab"]').map((t) => t.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
    ])
  })
})

// --- Asking Claude ----------------------------------------------------------

describe("asking Claude for drafts", () => {
  test("the button sends the prompt verbatim", async () => {
    const { asked } = await drafted()
    expect(asked).toEqual(["Imports should resume after a crash"])
  })

  test("nothing is asked for an empty prompt", async () => {
    const asked: string[] = []
    await render(<api.AddTasks {...props({ onDraft: (p) => { asked.push(p); return { tasks: [] } } })} />)
    await click(button("Draft tasks"))
    expect(asked).toEqual([])
  })

  /** The only wait in the product with nothing to show. `.skel` is its own. */
  test("the skeleton stands in while the model is thinking", async () => {
    const gate = deferred<Proposal>()
    await render(<api.AddTasks {...props({ onDraft: () => gate.promise })} />)
    await type(one('[role="tabpanel"] textarea'), "something")
    await click(button("Draft tasks"))

    const status = one('[role="status"]')
    expect(status.getAttribute("aria-label")).toBe("Drafting tasks")
    expect(all(".skel")).toHaveLength(3)
    /* A live region with no text announces nothing, which is the artboard's
     * one a11y gap on this screen. */
    expect(status.textContent).toContain("Drafting tasks")
    expect(buttonLabels()).toContain("Drafting…")

    await api.act(async () => {
      gate.resolve({ tasks: DRAFTS })
      await gate.promise
    })
    expect(all(".skel")).toHaveLength(0)
    expect(all("li")).toHaveLength(3)
  })

  test("the drafts arrive checked, with the model's words untouched", async () => {
    await drafted()

    expect(text("h2")).toBe("Claude drafted 3 tasks")
    expect(all<HTMLInputElement>('input[type="checkbox"]').map((c) => c.checked)).toEqual([true, true, true])
    expect(all<HTMLInputElement>('input[type="text"]').map((i) => i.value)).toEqual([...DRAFTS])
  })

  test("one draft says one task, not 1 tasks", async () => {
    await render(<api.AddTasks {...props({ onDraft: () => ({ tasks: ["Just the one"] }) })} />)
    await type(one('[role="tabpanel"] textarea'), "x")
    await click(button("Draft tasks"))
    expect(text("h2")).toBe("Claude drafted 1 task")
  })

  test("the cost is printed only when the server reports it", async () => {
    await drafted({ account: { kind: "personal" } })
    expect(text("h2 ~ span.m")).toBe("$0.03 · personal")

    await render(<api.AddTasks {...props({ onDraft: () => ({ tasks: DRAFTS }), account: { kind: "personal" } })} />)
    await type(one('[role="tabpanel"] textarea'), "x")
    await click(button("Draft tasks"))
    expect(text("h2 ~ span.m")).toBe("personal")
  })

  /** `src/draft.ts` refuses a dozen reply shapes, so a refusal is the normal
   * path. The prompt is kept, because it is the user's words. */
  test("a refusal is shown and the prompt survives it", async () => {
    const gate = deferred<Proposal>()
    await render(<api.AddTasks {...props({ onDraft: () => gate.promise })} />)
    await type(one('[role="tabpanel"] textarea'), "resume after a crash")
    await click(button("Draft tasks"))

    await api.act(async () => {
      gate.reject(new Error('the reply has no "# " title line'))
      await gate.promise.catch(() => {})
    })

    expect(text('[role="alert"]')).toContain('the reply has no "# " title line')
    expect(all(".skel")).toHaveLength(0)
    expect(one<HTMLTextAreaElement>('[role="tabpanel"] textarea').value).toBe("resume after a crash")
    expect(buttonLabels()).toContain("Draft tasks")
  })

  test("a synchronous throw is reported the same way", async () => {
    await render(
      <api.AddTasks
        {...props({
          onDraft: () => {
            throw new Error("no server on /api")
          },
        })}
      />,
    )
    await type(one('[role="tabpanel"] textarea'), "x")
    await click(button("Draft tasks"))
    expect(text('[role="alert"]')).toContain("no server on /api")
  })

  /**
   * Re-drafting while a call is still out is allowed, and the **newest** one
   * wins. The two directions are not symmetric: a second draft costs a
   * fraction of a cent and writes nothing, while blocking it leaves a hung
   * call with no way out but a reload. The add button is guarded the other way
   * round, because a second write changes the file.
   *
   * Without the generation token the stale proposals replace the fresh ones,
   * which puts drafts on screen that the user's last question did not ask for.
   */
  test("a stale draft that lands last is ignored", async () => {
    const first = deferred<Proposal>()
    const second = deferred<Proposal>()
    let calls = 0
    await render(
      <api.AddTasks
        {...props({
          onDraft: () => {
            calls += 1
            return calls === 1 ? first.promise : second.promise
          },
        })}
      />,
    )
    await type(one('[role="tabpanel"] textarea'), "x")
    await click(button("Draft tasks"))
    await click(button("Drafting…"))
    expect(calls).toBe(2)

    await api.act(async () => {
      second.resolve({ tasks: ["the fresh one"] })
      await second.promise
    })
    expect(all<HTMLInputElement>('input[type="text"]').map((i) => i.value)).toEqual(["the fresh one"])

    await api.act(async () => {
      first.resolve({ tasks: ["the stale one"] })
      await first.promise
    })
    expect(all<HTMLInputElement>('input[type="text"]').map((i) => i.value)).toEqual(["the fresh one"])
  })

  /** The same token, the other way round: a refusal from a superseded call
   * must not raise an alert about a question that has been answered. */
  test("a stale refusal that lands last is ignored", async () => {
    const first = deferred<Proposal>()
    const second = deferred<Proposal>()
    let calls = 0
    await render(
      <api.AddTasks
        {...props({
          onDraft: () => {
            calls += 1
            return calls === 1 ? first.promise : second.promise
          },
        })}
      />,
    )
    await type(one('[role="tabpanel"] textarea'), "x")
    await click(button("Draft tasks"))
    await click(button("Drafting…"))

    await api.act(async () => {
      second.resolve({ tasks: ["the fresh one"] })
      await second.promise
    })
    await api.act(async () => {
      first.reject(new Error("the stale refusal"))
      await first.promise.catch(() => {})
    })

    expect(maybe('[role="alert"]')).toBeNull()
  })

  test("Draft again asks once more", async () => {
    const { asked } = await drafted()
    await click(button("Draft again"))
    expect(asked).toHaveLength(2)
  })
})

// --- Choosing and editing ---------------------------------------------------

describe("choosing and editing the drafts", () => {
  test("unticking takes the row out of the count, the refs and the diff", async () => {
    await drafted()
    const boxes = all<HTMLInputElement>('input[type="checkbox"]')
    const second = boxes[1]
    if (!second) throw new Error("expected three checkboxes")

    await toggle(second)

    expect(all("li span.m").map((s) => s.textContent)).toEqual(["T4", "—", "T5"])
    expect(buttonLabels()).toContain("Add 2 tasks to importer.md")
    expect(diffLines().filter((l) => l.startsWith("+"))).toHaveLength(2)
  })

  test("an untouched draft is written exactly as the model wrote it", async () => {
    const sent: readonly string[][] = []
    const added: string[][] = []
    await drafted({ onAdd: (texts) => { added.push([...texts]); return ["T4", "T5", "T6"] } })
    await click(button("Add 3 tasks to importer.md"))
    expect(added).toEqual([[...DRAFTS]])
    void sent
  })

  test("an edit reaches the diff and the write", async () => {
    const added: string[][] = []
    await drafted({ onAdd: (texts) => { added.push([...texts]); return ["T4", "T5", "T6"] } })

    const first = all<HTMLInputElement>('input[type="text"]')[0]
    if (!first) throw new Error("expected a text input")
    await type(first, "Checkpoint after every committed batch")

    expect(diffLines()).toContain("+ - [ ] T4 Checkpoint after every committed batch")
    await click(button("Add 3 tasks to importer.md"))
    expect(added[0]?.[0]).toBe("Checkpoint after every committed batch")
  })

  /**
   * The shell re-renders on every tree refresh, so a new `tasks` array arrives
   * constantly. Wiping typed text on one would lose the user's words with no
   * trace, which is why the proposals are the component's own state and not a
   * prop it has to guess about.
   */
  test("an edit survives a re-render with a new tasks array", async () => {
    const onDraft = (): Proposal => ({ tasks: DRAFTS })
    await render(<api.AddTasks {...props({ onDraft })} />)
    await type(one('[role="tabpanel"] textarea'), "x")
    await click(button("Draft tasks"))

    const first = all<HTMLInputElement>('input[type="text"]')[0]
    if (!first) throw new Error("expected a text input")
    await type(first, "my own words")

    await render(<api.AddTasks {...props({ onDraft, tasks: [...TASKS] })} />)
    expect(all<HTMLInputElement>('input[type="text"]')[0]?.value).toBe("my own words")
  })

  /**
   * `src/draft.ts` refuses a task line with no text, so writing one writes a
   * line its own drafter would reject — and `parseFeature` reads it as a task
   * with an empty body, which renders as a blank row in the tree.
   *
   * The row is kept on screen and marked instead of being dropped silently:
   * the count visibly falls, and the row says why.
   */
  test("a checked draft with no text is not written, and says so", async () => {
    const added: string[][] = []
    await drafted({ onAdd: (texts) => { added.push([...texts]); return ["T4", "T5"] } })

    const first = all<HTMLInputElement>('input[type="text"]')[0]
    if (!first) throw new Error("expected a text input")
    await type(first, "   ")

    expect(all("li")).toHaveLength(3)
    expect(all("li span.m").map((s) => s.textContent)).toEqual(["—", "T4", "T5"])
    expect(text("li")).toContain("needs text")
    expect(buttonLabels()).toContain("Add 2 tasks to importer.md")

    await click(button("Add 2 tasks to importer.md"))
    expect(added[0]).toEqual([DRAFTS[1] ?? "", DRAFTS[2] ?? ""])
  })

  test("surrounding whitespace is trimmed, because the parser trims on the way back", async () => {
    const added: string[][] = []
    await drafted({ onAdd: (texts) => { added.push([...texts]); return ["T4", "T5", "T6"] } })
    const first = all<HTMLInputElement>('input[type="text"]')[0]
    if (!first) throw new Error("expected a text input")
    await type(first, "  padded  ")
    await click(button("Add 3 tasks to importer.md"))
    expect(added[0]?.[0]).toBe("padded")
  })
})

// --- Writing them by hand ---------------------------------------------------

describe("writing them by hand", () => {
  async function manual(value: string, over: Partial<AddTasksProps> = {}): Promise<void> {
    await render(<api.AddTasks {...props(over)} />)
    await type(one("textarea"), value)
  }

  /**
   * Free text, so the dimension is the bytes someone typed or pasted. Blank
   * lines must go — pressing Enter twice is how people write lists — and
   * nothing else may, because dropping a line someone typed loses work
   * invisibly while keeping one shows up in the diff before anything is
   * written.
   */
  test("manualLines, over every shape typed text can take", () => {
    const cases: readonly [string, string, readonly string[]][] = [
      ["nothing", "", []],
      ["one line", "Make imports resumable", ["Make imports resumable"]],
      ["two lines", "first\nsecond", ["first", "second"]],
      ["a blank line between them", "first\n\nsecond", ["first", "second"]],
      ["a trailing newline", "first\n", ["first"]],
      ["leading newlines", "\n\nfirst", ["first"]],
      ["a CRLF paste", "first\r\nsecond", ["first", "second"]],
      ["spaces only", "   ", []],
      ["a tab-indented line", "\tfirst", ["first"]],
      ["an ideographic space", "　", []],
      ["surrounding whitespace", "  first  \n  second  ", ["first", "second"]],
      ["non-English text", "マニフェストを解析する", ["マニフェストを解析する"]],
      ["a right-to-left line", "تحليل البيان", ["تحليل البيان"]],
      /* U+2028 is a line separator to a regex with `s` and nothing to
       * `split("\n")`. `backlog.ts`'s TASK_RE carries the `s` flag for exactly
       * this, so the character round-trips and the line stays one task. */
      ["a U+2028 inside a line", "before after", ["before after"]],
      /* Pasted markdown is kept verbatim. Stripping the prefix would be
       * guessing at what someone meant; the diff shows what will be written. */
      ["a pasted task line", "- [ ] T5 foo", ["- [ ] T5 foo"]],
      ["a pasted heading", "# Importer", ["# Importer"]],
      ["one blank among many", "a\n\n\n\nb", ["a", "b"]],
    ]
    for (const [why, value, want] of cases) {
      expect(api.manualLines(value), why).toEqual([...want])
    }
  })

  test("the box is the artboard's, and nothing invents refs for it", async () => {
    await manual("Make imports resumable after a crash\nAdd a --dry-run flag")
    expect(text("label")).toBe("One task per line")
    expect(text("label ~ p")).toBe("Refs are assigned for you. Non-English text is fine.")
    expect(diffLines().filter((l) => l.startsWith("+"))).toEqual([
      "+ - [ ] T4 Make imports resumable after a crash",
      "+ - [ ] T5 Add a --dry-run flag",
    ])
  })

  test("the typed lines are what gets written, in order", async () => {
    const added: string[][] = []
    await manual("first\n\nsecond\n", { onAdd: (texts) => { added.push([...texts]); return ["T4", "T5"] } })
    await click(button("Add 2 tasks to importer.md"))
    expect(added).toEqual([["first", "second"]])
  })
})

// --- The diff ---------------------------------------------------------------

describe("the change to the file", () => {
  test("the header names the file and counts the additions", async () => {
    await render(<api.AddTasks {...props()} />)
    await type(one("textarea"), "first\nsecond")
    expect(text("pre")).not.toBe("")
    const header = all(".m").map((n) => (n.textContent ?? "").replaceAll(/\s+/g, " ").trim())
    expect(header.some((h) => h.includes("docs/features/importer.md") && h.includes("+2"))).toBe(true)
  })

  /**
   * The artboard draws its two context lines as `- [ ]` for tasks its own
   * sidebar shows as **Passed**, which the file cannot be: the server ticks a
   * task only after the test command exits 0. The file is the truth here.
   */
  test("the context lines are the last two tasks, ticked as the file has them", async () => {
    await render(<api.AddTasks {...props()} />)
    await type(one("textarea"), "first")
    expect(diffLines()).toEqual(["  - [x] T2 Map records to rows", "  - [ ] T3 Runtime shim (v1.2)", "+ - [ ] T4 first"])
  })

  test("a file with one task shows one context line, and an empty file none", async () => {
    await render(<api.AddTasks {...props({ tasks: [{ ref: "T1", text: "only", done: false }] })} />)
    await type(one("textarea"), "first")
    expect(diffLines()).toEqual(["  - [ ] T1 only", "+ - [ ] T2 first"])

    await render(<api.AddTasks {...props({ tasks: [] })} />)
    await type(one("textarea"), "first")
    expect(diffLines()).toEqual(["+ - [ ] T1 first"])
  })

  test("nothing chosen means no added lines", async () => {
    await render(<api.AddTasks {...props()} />)
    expect(diffLines().filter((l) => l.startsWith("+"))).toHaveLength(0)
  })

  /** The same bound `Row.tsx` puts on its own diff, and the same sentence. */
  test("a very long paste is bounded, and says how much it dropped", async () => {
    await render(<api.AddTasks {...props()} />)
    const lines = Array.from({ length: 200 }, (_, i) => `task number ${i + 1}`)
    await type(one("textarea"), lines.join("\n"))

    const rendered = diffLines()
    expect(rendered.length).toBe(api.MAX_DIFF_LINES + 1)
    expect(rendered.at(-1)).toBe(`${200 - (api.MAX_DIFF_LINES - 2)} more lines, not shown here.`)
    /* The count is the truth, not the rendering. */
    expect(buttonLabels()).toContain("Add 200 tasks to importer.md")
  })
})

// --- Adding -----------------------------------------------------------------

describe("the add button", () => {
  test("it counts the checked drafts", async () => {
    await drafted()
    expect(buttonLabels()).toContain("Add 3 tasks to importer.md")

    const boxes = all<HTMLInputElement>('input[type="checkbox"]')
    for (const box of boxes.slice(1)) await toggle(box)
    expect(buttonLabels()).toContain("Add 1 task to importer.md")
  })

  test("with nothing chosen it says so and is disabled", async () => {
    await render(<api.AddTasks {...props()} />)
    const add = button("Nothing to add yet")
    expect(add.disabled).toBe(true)
  })

  test("it cannot write twice from one selection", async () => {
    const gate = deferred<readonly string[]>()
    let calls = 0
    await render(<api.AddTasks {...props({ onAdd: () => { calls += 1; return gate.promise } })} />)
    await type(one("textarea"), "first")

    const add = button("Add 1 task to importer.md")
    await click(add)
    expect(calls).toBe(1)
    expect(buttonLabels()).toContain("Adding…")
    expect(button("Adding…").disabled).toBe(true)
    await click(button("Adding…"))
    expect(calls).toBe(1)

    await api.act(async () => {
      gate.resolve(["T4"])
      await gate.promise
    })
    expect(calls).toBe(1)
  })

  /**
   * The `disabled` attribute cannot carry this on its own, and a mutation run
   * proved it: deleting the latch left the suite green, because a second click
   * on an already-disabled button never reaches a handler. Two clicks in **one
   * tick** are the case it misses — React has not re-rendered, so the DOM node
   * is still enabled when the second one lands.
   */
  test("two clicks in one tick still write once", async () => {
    let calls = 0
    const gate = deferred<readonly string[]>()
    await render(
      <api.AddTasks
        {...props({
          onAdd: () => {
            calls += 1
            return gate.promise
          },
        })}
      />,
    )
    await type(one("textarea"), "first")

    const add = button("Add 1 task to importer.md")
    await api.act(async () => {
      add.click()
      add.click()
    })
    expect(calls).toBe(1)
  })

  /**
   * The defect this screen's state machine was built wrong for once: "in
   * flight" and "last outcome" shared one field, and every edit cleared it. So
   * a keystroke during the write re-armed the button with the same lines still
   * counted, and the second click appended them again.
   *
   * It also pins the other half: a line typed while the write is out is
   * **kept**, not cleared. Losing what someone typed is invisible; leaving it
   * offers the written line a second time, in the diff, where it can be seen.
   */
  test("typing while the write is in flight neither re-arms the button nor loses the typing", async () => {
    let calls = 0
    const gate = deferred<readonly string[]>()
    await render(
      <api.AddTasks
        {...props({
          onAdd: () => {
            calls += 1
            return gate.promise
          },
        })}
      />,
    )
    await type(one("textarea"), "first")
    await click(button("Add 1 task to importer.md"))
    await type(one("textarea"), "first\nsecond")

    expect(button("Adding…").disabled).toBe(true)
    expect(calls).toBe(1)

    await api.act(async () => {
      gate.resolve(["T4"])
      await gate.promise
    })
    expect(one<HTMLTextAreaElement>("textarea").value).toBe("first\nsecond")
    expect(text('[role="status"]')).toContain("Added T4 to importer.md")
  })

  /** The same, for a draft edited while its own write is out. */
  test("a draft edited while the write is in flight is kept", async () => {
    const gate = deferred<readonly string[]>()
    await drafted({ onAdd: () => gate.promise })
    const boxes = all<HTMLInputElement>('input[type="checkbox"]')
    for (const box of boxes.slice(1)) await toggle(box)

    await click(button("Add 1 task to importer.md"))
    const first = all<HTMLInputElement>('input[type="text"]')[0]
    if (!first) throw new Error("expected a text input")
    await type(first, "edited mid-write")

    await api.act(async () => {
      gate.resolve(["T4"])
      await gate.promise
    })
    expect(all<HTMLInputElement>('input[type="text"]').map((i) => i.value)).toContain("edited mid-write")
  })

  /** The human may have edited the file since the draft, so the refs the
   * server reports are the only ones that are true. */
  test("the confirmation prints the server's refs, not the preview's", async () => {
    await render(<api.AddTasks {...props({ onAdd: () => ["T9", "T10", "T11"] })} />)
    await type(one("textarea"), "a\nb\nc")
    await click(button("Add 3 tasks to importer.md"))

    expect(text('[role="status"]')).toContain("Added T9–T11 to importer.md")
    expect(buttonLabels()).not.toContain("Add 3 tasks to importer.md")
  })

  test("one task names it alone", async () => {
    await render(<api.AddTasks {...props({ onAdd: () => ["T4"] })} />)
    await type(one("textarea"), "a")
    await click(button("Add 1 task to importer.md"))
    expect(text('[role="status"]')).toContain("Added T4 to importer.md")
  })

  /** A server too old to answer with refs still wrote the file. The count is
   * all that can be said truthfully, so it is all that is said. */
  test("a server that reports no refs gets a count, not an invented range", async () => {
    await render(<api.AddTasks {...props({ onAdd: () => undefined })} />)
    await type(one("textarea"), "a\nb")
    await click(button("Add 2 tasks to importer.md"))

    const status = text('[role="status"]')
    expect(status).toContain("Added 2 tasks to importer.md")
    expect(status).not.toContain("T4")
    expect(buttonLabels()).not.toContain("Open T4")
  })

  test("Open names the first ref the server wrote, and only when it is wired", async () => {
    const opened: string[] = []
    await render(<api.AddTasks {...props({ onAdd: () => ["T4", "T5"], onOpen: (r) => void opened.push(r) })} />)
    await type(one("textarea"), "a\nb")
    await click(button("Add 2 tasks to importer.md"))
    await click(button("Open T4"))
    expect(opened).toEqual(["T4"])

    await render(<api.AddTasks {...props({ onAdd: () => ["T4"] })} />)
    await type(one("textarea"), "a")
    await click(button("Add 1 task to importer.md"))
    expect(buttonLabels()).not.toContain("Open T4")
  })

  /**
   * The artboard's own state machine can write the same lines twice: typing
   * one character after a successful add clears `added` and leaves the written
   * lines still counted. A successful add consumes exactly what it wrote.
   */
  test("a successful add consumes what it wrote and nothing else", async () => {
    await render(<api.AddTasks {...props({ onAdd: () => ["T4"] })} />)
    await type(one("textarea"), "first")
    await click(button("Add 1 task to importer.md"))

    expect(one<HTMLTextAreaElement>("textarea").value).toBe("")
    expect(diffLines().filter((l) => l.startsWith("+"))).toHaveLength(0)

    await type(one("textarea"), "second")
    expect(buttonLabels()).toContain("Add 1 task to importer.md")
    expect(maybe('[role="status"]')).toBeNull()
  })

  test("an unchosen draft survives the add that passed it over", async () => {
    await drafted({ onAdd: () => ["T4", "T5"] })
    const boxes = all<HTMLInputElement>('input[type="checkbox"]')
    const last = boxes[2]
    if (!last) throw new Error("expected three checkboxes")
    await toggle(last)

    await click(button("Add 2 tasks to importer.md"))

    expect(all<HTMLInputElement>('input[type="text"]').map((i) => i.value)).toEqual([DRAFTS[2] ?? ""])
    expect(text('[role="status"]')).toContain("Added T4–T5 to importer.md")
  })

  test("a refused write keeps the selection and puts the button back", async () => {
    const gate = deferred<readonly string[]>()
    await render(<api.AddTasks {...props({ onAdd: () => gate.promise })} />)
    await type(one("textarea"), "first")
    await click(button("Add 1 task to importer.md"))

    await api.act(async () => {
      gate.reject(new Error("importer.md changed under us"))
      await gate.promise.catch(() => {})
    })

    expect(text('[role="alert"]')).toContain("importer.md changed under us")
    expect(one<HTMLTextAreaElement>("textarea").value).toBe("first")
    expect(buttonLabels()).toContain("Add 1 task to importer.md")
  })

  test("Cancel is offered only when it is wired", async () => {
    const cancelled: number[] = []
    await render(<api.AddTasks {...props({ onCancel: () => void cancelled.push(1) })} />)
    await click(button("Cancel"))
    expect(cancelled).toHaveLength(1)

    await render(<api.AddTasks {...props()} />)
    expect(buttonLabels()).not.toContain("Cancel")
  })
})

// --- Reduced motion ---------------------------------------------------------

describe("reduced motion", () => {
  test("the entrance and the row pop are dropped when the preference is set", async () => {
    setPrefersReduce(true)
    await drafted()

    expect(classesOf("section")).not.toContain("bf")
    expect(all("li").every((li) => !(li.getAttribute("class") ?? "").includes("pop"))).toBe(true)
  })

  test("they are there when it is not", async () => {
    await drafted()
    expect(classesOf("section")).toContain("bf")
    expect(all("li").every((li) => (li.getAttribute("class") ?? "").includes("pop"))).toBe(true)
  })

  /** The live read is a subscription, not a one-off. */
  test("flipping the preference while mounted takes the animation away", async () => {
    await drafted()
    expect(classesOf("section")).toContain("bf")
    await api.act(async () => {
      setPrefersReduce(true)
    })
    expect(classesOf("section")).not.toContain("bf")
  })

  /** `artboard.css`'s CSS kill-switch is scoped to `.kr`, and does nothing
   * until a root carries it. In the app that is `App.tsx`'s root; standalone it
   * has to be this one. */
  test("the root carries the reduced-motion scope", async () => {
    await render(<api.AddTasks {...props()} />)
    expect(classesOf("div.kr")).toContain("kr")
  })
})

// --- The artboard's geometry ------------------------------------------------

describe("the artboard's own values", () => {
  test("the card, the tab pill and the draft rows are drawn as the artboard draws them", async () => {
    await drafted()

    expect(classesOf("section")).toContain("rounded-[24px]")
    expect(classesOf('[role="tablist"]')).toContain("rounded-full")
    /* 24px checkbox, 34px ref, then the text input. `minmax(0,1fr)` is
     * load-bearing: a default `1fr` floors at `min-content`, so a long draft
     * would widen the row instead of scrolling inside it. */
    expect(classesOf("li")).toContain("grid-cols-[24px_34px_minmax(0,1fr)]")
    expect(classesOf("pre")).toContain("leading-[1.75]")
  })

  test("the skeleton is the artboard's three bars, at its three widths", async () => {
    const gate = deferred<Proposal>()
    await render(<api.AddTasks {...props({ onDraft: () => gate.promise })} />)
    await type(one('[role="tabpanel"] textarea'), "x")
    await click(button("Draft tasks"))

    const bars = all(".skel")
    expect(bars).toHaveLength(3)
    for (const bar of bars) {
      const classes = (bar.getAttribute("class") ?? "").split(/\s+/)
      expect(classes).toContain("h-12")
      expect(classes).toContain("rounded-[12px]")
    }
    expect(bars.map((b) => (b.getAttribute("class") ?? "").split(/\s+/).find((c) => c.startsWith("w-")))).toEqual([
      "w-full",
      "w-[86%]",
      "w-[72%]",
    ])
  })

  test("the untouched read-only promise the artboard makes about drafting", async () => {
    await render(<api.AddTasks {...props({ onDraft: () => ({ tasks: DRAFTS }) })} />)
    expect(text('[role="tabpanel"]')).toContain("Reads importer.md and the repo, read-only")
  })

  /**
   * Measured in a browser against the artboard: Cancel came out 48px against
   * its 50, and "Draft again" 36 against its 38. The artboard declares
   * `box-sizing: border-box` on `<main>` and `<aside>` **only**, so a control
   * with an explicit height *and* a border is drawn height-plus-border; the
   * preflight Tailwind adds would eat it. The rule is "an explicit height plus
   * a border", and these two are the only controls here that have both —
   * every other pill sets `border:0`.
   */
  test("a bordered pill is content-box, as the artboard draws it", async () => {
    await drafted({ onCancel: () => {} })
    expect((button("Draft again").getAttribute("class") ?? "").split(/\s+/)).toContain("box-content")
    expect((button("Cancel").getAttribute("class") ?? "").split(/\s+/)).toContain("box-content")
    /* The borderless pills must not have it, or the padding grows instead. */
    expect((button("Draft tasks").getAttribute("class") ?? "").split(/\s+/)).not.toContain("box-content")
    expect((button("Add 3 tasks to importer.md").getAttribute("class") ?? "").split(/\s+/)).not.toContain("box-content")
  })

  test("an unticked row is struck through and its ref greys out", async () => {
    await drafted()
    const boxes = all<HTMLInputElement>('input[type="checkbox"]')
    const first = boxes[0]
    if (!first) throw new Error("expected a checkbox")
    await toggle(first)

    const row = all<HTMLElement>("li")[0]
    const input = row?.querySelector<HTMLElement>('input[type="text"]')
    expect((input?.getAttribute("class") ?? "").split(/\s+/)).toContain("line-through")
  })
})
