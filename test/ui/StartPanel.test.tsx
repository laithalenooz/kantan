/**
 * Starting and resuming a task: `docs/design/Start.dc.html`.
 *
 * ## What is actually at risk here
 *
 * **The card spends money.** Every other panel in this app reports; this one is
 * the control that commits a budget and launches a paid run. So the two things
 * under test are the branching (which of the artboard's three variants is on
 * screen) and the ceiling field (what reaches `onStart`).
 *
 * **The artboard's `busy` variant is the open card, not a third card.** Its
 * logic reads `showOpen = !isInt`, so a blocked task still shows the whole
 * offer with an alert over the footer and the button greyed. Getting that wrong
 * either hides the task's own details behind a notice or lets a second run
 * start. It is pinned as a matrix over all three variants rather than tested on
 * the one the artboard defaults to.
 *
 * **The ceiling is a skipping guard in `CLAUDE.md`'s sense.** The dimension is
 * the string in the input; the enumeration below is `src/server.ts`'s own list
 * for the raise route - absent, non-numeric, a numeric string, `NaN`, both
 * infinities, zero, negative zero, negative - plus the traps the parsing
 * primitives add (`parseFloat("50abc")` is `50`, `Number("0x32")` is `50`, a
 * 400-digit figure is `Infinity`). The costs are not symmetric: a bad figure
 * let through either funds nothing and fails at the spawn, where the UI cannot
 * attribute the failure to the input, or - for `Infinity` - funds a run with no
 * ceiling at all. A good figure refused costs one retype. So every uncertain
 * case must fail toward refusing, and that is asserted value by value.
 *
 * **Reduced motion.** `CLAUDE.md` records that Motion's `useReducedMotion()` is
 * a module-level singleton that has answered `false` with the media feature
 * actually set, so the component ORs it with a live `matchMedia` read. Motion's
 * half is quarantined to `false` here (see "Two query objects"), so these tests
 * exercise the **live** half - the half that has to work. happy-dom never
 * evaluates `@media (prefers-reduced-motion)`, so the CSS guard in
 * `artboard.css` is invisible to every assertion below: what is asserted is the
 * classes being withheld in JS.
 *
 * `docs/HANDOFF.md` adds the measured reason to judge a reduced-motion
 * fallback by `bun run check` rather than by this file alone, and the
 * correction to it: a stub that fires `change` repairs Motion's singleton as a
 * side effect and so quietly fixes the bug it was written to catch. The
 * reduced-motion tests here therefore set the preference **without** firing
 * `change` as well as with it.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"

/* Type-only, so nothing here is evaluated before the window exists. */
import type { Blocker, StartPanelProps } from "../../src/ui/StartPanel.tsx"
import type { Account, TreeTask } from "../../src/ui/Tree.tsx"
import type { RunState } from "../../src/runindex.ts"

/*
 * The window is taken only if the slot is free, and **never given back**.
 *
 * `docs/HANDOFF.md`: `bun test` loads and runs one file at a time, so an
 * `unregister()` in this file's `afterAll` would close the window before a
 * later UI suite is even loaded - and `motion`, already imported and already
 * seeded, holds the first window's media query and timing primitives in
 * module-level state nothing can re-seed. That is how another agent's cost
 * ticker silently froze. So the window outlives this file.
 */
let ownsDocument = false

interface Api {
  act: typeof import("react").act
  StrictMode: typeof import("react").StrictMode
  createRoot: typeof import("react-dom/client").createRoot
  StartPanel: typeof import("../../src/ui/StartPanel.tsx").StartPanel
}

// --- The reduced-motion media feature ---------------------------------------

/**
 * Two query objects, and the split is not cosmetic.
 *
 * `bun test` runs every file in one process and Motion keeps its reduced-motion
 * answer in a module-level singleton seeded at the **first call anywhere in
 * that process**, then updated from that query's own `change` events. A stub
 * that matched the feature loosely would hand Motion the same object this file
 * toggles, and every `setPrefersReduce(true)` here would reach into Motion's
 * process-wide state and stay there - breaking suites this file never names.
 *
 * So the two are kept apart by their exact strings: the component asks
 * `(prefers-reduced-motion: reduce)` and gets `reduceQuery`; Motion asks
 * `(prefers-reduced-motion)` and gets a quarantined one that is always `false`
 * and whose listeners are never fired. The pattern is `test/ui/Empty.test.tsx`'s.
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

/** Sets the preference and notifies, which is what a real change does. */
function setPrefersReduce(value: boolean): void {
  prefersReduce = value
  for (const cb of reduceListeners) cb({ matches: value })
}

/**
 * Sets the preference and tells **nobody**.
 *
 * This is the state the documented trap actually occurs in: a listener-less
 * change leaves Motion's cached answer stale, so only a live read can see it.
 * HANDOFF's correction is that a stub which fires `change` repairs that cache
 * as a side effect and so passes even without the live read.
 */
function setPrefersReduceSilently(value: boolean): void {
  prefersReduce = value
}

let api: Api

beforeAll(async () => {
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register()
    ownsDocument = true
  }
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

  /* The stub goes in before `StartPanel.tsx` is pulled in: `motion-dom` decides
   * `isBrowser` and seeds its reduced-motion singleton at module evaluation. */
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
  const mod = await import("../../src/ui/StartPanel.tsx")
  api = { act: react.act, StrictMode: react.StrictMode, createRoot: client.createRoot, StartPanel: mod.StartPanel }
})

afterAll(() => {
  if (realMatchMedia !== undefined) {
    Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: realMatchMedia })
  }
  /* Deliberately **not** `GlobalRegistrator.unregister()`, even though this
   * file may be the one that registered. See the note on `ownsDocument`. */
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
  /* The unmount is the statement most likely to throw, and the document and the
   * preference are shared with every other file in this process, so the restore
   * is in a `finally`. */
  try {
    await api.act(async () => {
      root.unmount()
    })
  } finally {
    host.remove()
    prefersReduce = false
  }
})

async function render(ui: React.ReactNode): Promise<void> {
  await api.act(async () => {
    root.render(ui)
  })
}

/** Rendered under `StrictMode`, which double-invokes and so catches a latch
 *  kept in state rather than in a ref. */
async function renderStrict(props: StartPanelProps): Promise<void> {
  await render(<api.StrictMode>{panel(props)}</api.StrictMode>)
}

function panel(props: StartPanelProps): React.ReactElement {
  const Panel = api.StartPanel
  return <Panel {...props} />
}

function maybe<E extends Element>(selector: string): E | null {
  return host.querySelector<E>(selector)
}

function one<E extends Element>(selector: string): E {
  const found = maybe<E>(selector)
  if (found === null) throw new Error(`nothing matched ${selector} in ${host.innerHTML}`)
  return found
}

function all<E extends Element>(selector: string): E[] {
  return [...host.querySelectorAll<E>(selector)]
}

/** The class attribute, split, so a missing rung is named rather than hidden
 *  inside a string comparison. */
function classesOf(selector: string): string[] {
  return (one(selector).getAttribute("class") ?? "").split(/\s+/).filter((c) => c !== "")
}

/**
 * Everything the subtree **says**, with runs of whitespace flattened.
 *
 * The card renders a `<style>` element for the two rules `artboard.css` does
 * not carry, and `textContent` includes a stylesheet's text. Without stripping
 * it every assertion here reads `linear-gradient` and `background-position` as
 * prose - which is how the first draft of the "no line number" test passed for
 * the wrong reason, on the `line` inside `linear-gradient`.
 */
function prose(): string {
  const copy = host.cloneNode(true) as HTMLElement
  for (const sheet of [...copy.querySelectorAll("style")]) sheet.remove()
  return (copy.textContent ?? "").replace(/\s+/g, " ").trim()
}

/**
 * One cell of the interrupted card's summary list, by the term it defines.
 *
 * `textContent` concatenates without separators, so a `<dt>`/`<dd>` pair reads
 * as `Spent so far$1.12` in the flattened prose. Reading the definition on its
 * own says what the card shows a human instead of what the DOM spells.
 */
function definitionOf(term: string): string | null {
  const cell = all("dl > div").find((div) => (div.querySelector("dt")?.textContent ?? "").trim() === term)
  if (cell === undefined) return null
  return (cell.querySelector("dd")?.textContent ?? "").replace(/\s+/g, " ").trim()
}

/** A tail row's four columns: icon, kind, subject, clock. */
function columnsOf(row: Element): string[] {
  return [...row.children].map((cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim())
}

/** The first element matching `selector` whose flattened text contains `text`. */
function byText<E extends Element>(selector: string, text: string): E | null {
  return all<E>(selector).find((el) => (el.textContent ?? "").replace(/\s+/g, " ").includes(text)) ?? null
}

function button(text: string): HTMLButtonElement {
  const hit = byText<HTMLButtonElement>("button", text)
  if (hit === null) throw new Error(`no button whose text contains ${JSON.stringify(text)} in ${prose()}`)
  return hit
}

async function click(el: Element): Promise<void> {
  await api.act(async () => {
    ;(el as HTMLElement).click()
  })
}

/*
 * React tracks an input's value on the node, so the native setter is what a
 * controlled field can be typed into.
 *
 * Resolved **lazily**, not at module scope: `HTMLInputElement` is a global
 * `GlobalRegistrator.register()` installs, and module bodies run before
 * `beforeAll`. At module scope this file throws `HTMLInputElement is not
 * defined` when it is the first UI suite in the process and passes when it is
 * not - a failure that moves with file order. (Measured: it threw on the first
 * run of this file alone.)
 */
function nativeInputValueSetter(): (this: HTMLInputElement, value: string) => void {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  if (set === undefined) throw new Error("no native input value setter to type through")
  return set
}

async function type(el: HTMLInputElement, value: string): Promise<void> {
  const set = nativeInputValueSetter()
  await api.act(async () => {
    set.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

function ceiling(): HTMLInputElement {
  return one<HTMLInputElement>('input[data-testid="ceiling"]')
}

// --- Fixtures ---------------------------------------------------------------

const PERSONAL: Account = { kind: "personal" }

/** A task that has never run, which is what `canStart` requires. */
const OPEN_TASK: TreeTask = { ref: "T3", text: "Runtime shim (v1.2)", done: false }

/** The artboard's interrupted task: a run that stopped during implement. */
const INTERRUPTED_TASK: TreeTask = {
  ref: "T1",
  text: "Stream CSV export",
  done: false,
  run: { state: { kind: "interrupted", resumeFrom: "implement" }, branch: "orch/export-t1" },
}

const RUNNING: RunState = { kind: "running", phase: "implement" }

function blocker(over: Partial<Blocker> = {}): Blocker {
  return { label: "other-repo · T2 Refund path", state: RUNNING, ...over }
}

function startProps(over: Partial<Extract<StartPanelProps, { kind: "start" }>> = {}): StartPanelProps {
  return {
    kind: "start",
    task: OPEN_TASK,
    featureFile: "docs/features/importer.md",
    account: PERSONAL,
    testCmd: "npm test",
    onStart: () => {},
    ...over,
  }
}

function resumeProps(over: Partial<Extract<StartPanelProps, { kind: "resume" }>> = {}): StartPanelProps {
  return {
    kind: "resume",
    task: INTERRUPTED_TASK,
    featureFile: "docs/features/export.md",
    account: PERSONAL,
    testCmd: "npm test",
    onResume: () => {},
    ...over,
  }
}

/** The three variants the artboard's `data-props` declares, by the props that
 *  produce each one. */
const VARIANTS = {
  open: () => startProps(),
  busy: () => startProps({ blockedBy: blocker() }),
  interrupted: () => resumeProps(),
} as const

type Variant = keyof typeof VARIANTS

const ALL_VARIANTS = Object.keys(VARIANTS) as Variant[]

/**
 * The artboard's own bytes, copied out of `docs/design/Start.dc.html` rather
 * than retyped from a summary of it.
 */
const ARTBOARD = {
  openEyebrow: "Open · not started",
  stepsHeading: "What happens when you start",
  planStep: "An agent reads the repo and writes a plan to docs/plans/. Then it stops.",
  decideStep: "Approve the plan, or send it back with a note. Nothing else moves until you do.",
  buildStep: "A fresh agent implements it. kantan runs npm test until it exits 0.",
  start: "Start planning",
  startAside: "No code changes until you approve the plan.",
  blockedAside: "Available when the current run ends.",
  oneAtATime: "kantan runs one task at a time, so this one can start once that run finishes or you stop it.",
  planning: "Planning. The agent is reading your repo.",
  planningAside: "You can leave. kantan calls you back when the plan is ready.",
  ceilingLabel: "Cost ceiling for this run",
  resume: "Resume run",
  startOver: "Start over from planning",
  startOverAside: "Starting over keeps this run in the history.",
  kept: "Server stopped · last event kept",
  goToRun: "Go to that run",
} as const

// --- The three variants -----------------------------------------------------

describe("the artboard's three variants", () => {
  /**
   * `showOpen` is `!isInt`, **not** `!isInt && !busy`. A blocked task keeps the
   * whole offer on screen and gains a notice; it does not become a third card.
   */
  test.each([
    ["open", true],
    ["busy", true],
    ["interrupted", false],
  ] as const)("%s shows the open card: %p", async (variant, shown) => {
    await render(panel(VARIANTS[variant]()))
    expect(maybe('[data-testid="open-card"]') !== null).toBe(shown)
    expect(maybe('[data-testid="interrupted-card"]') !== null).toBe(!shown)
  })

  test.each([
    ["open", { start: true, blocked: false, resume: false }],
    ["busy", { start: false, blocked: true, resume: false }],
    ["interrupted", { start: false, blocked: false, resume: true }],
  ] as const)("%s offers exactly one action: %o", async (variant, want) => {
    await render(panel(VARIANTS[variant]()))

    const start = byText<HTMLButtonElement>("button", ARTBOARD.start)
    expect(start !== null).toBe(want.start || want.blocked)
    if (start !== null) expect(start.disabled).toBe(want.blocked)
    expect(byText("button", ARTBOARD.resume) !== null).toBe(want.resume)
  })

  test("only the blocked variant carries the one-at-a-time alert", async () => {
    for (const variant of ALL_VARIANTS) {
      await render(panel(VARIANTS[variant]()))
      const alert = maybe('[data-testid="one-at-a-time"]')
      expect(alert === null).toBe(variant !== "busy")
      if (alert !== null) expect(alert.getAttribute("role")).toBe("status")
    }
  })

  test("the blocked button is disabled to assistive tech as well as to the mouse", async () => {
    await render(panel(VARIANTS.busy()))
    const start = button(ARTBOARD.start)
    expect(start.disabled).toBe(true)
    expect(start.getAttribute("aria-disabled")).toBe("true")
  })

  test("a blocked card never calls onStart, however it is clicked", async () => {
    const calls: unknown[] = []
    await render(panel(startProps({ blockedBy: blocker(), onStart: (c) => calls.push(c) })))
    await click(button(ARTBOARD.start))
    expect(calls).toEqual([])
  })

  test("the open card names the task and the file the line came from", async () => {
    await render(panel(VARIANTS.open()))
    expect(prose()).toContain("Runtime shim (v1.2)")
    expect(prose()).toContain("docs/features/importer.md")
  })

  /* The artboard's interrupted card carries no feature path: the breadcrumb
   * `App.tsx` draws above it is already showing one, and a second copy was not
   * in the approved drawing. */
  test("the interrupted card names the task, and does not repeat the breadcrumb's path", async () => {
    await render(panel(VARIANTS.interrupted()))
    expect(prose()).toContain("Stream CSV export")
    expect(prose()).not.toContain("docs/features/export.md")
  })

  test("the heading is the task text, and it is the card's accessible name", async () => {
    await render(panel(VARIANTS.open()))
    const heading = one("h1")
    expect(heading.textContent).toBe("Runtime shim (v1.2)")
    const section = one('[data-testid="open-card"]')
    expect(section.getAttribute("aria-labelledby")).toBe(heading.getAttribute("id"))
  })
})

// --- The artboard's copy ----------------------------------------------------

describe("the copy, as the artboard writes it", () => {
  test("the open card explains the three phases, with the project's own test command", async () => {
    await render(panel(VARIANTS.open()))
    const said = prose()
    expect(said).toContain(ARTBOARD.openEyebrow)
    expect(said).toContain(ARTBOARD.stepsHeading)
    expect(said).toContain(ARTBOARD.planStep)
    expect(said).toContain(ARTBOARD.decideStep)
    expect(said).toContain(ARTBOARD.buildStep)
    expect(said).toContain(ARTBOARD.startAside)
  })

  test("the test command is the project's, never a literal npm test", async () => {
    await render(panel(startProps({ testCmd: "bun run check" })))
    const said = prose()
    expect(said).toContain("kantan runs bun run check until it exits 0.")
    expect(said).not.toContain("npm test")
  })

  /**
   * The dimension `testCmd` gained a value on 2026-10-12, so by this repo's own
   * rule it is enumerated rather than patched for the case that motivated it.
   *
   * `Project.testCmd` is `string | null`: the user decided a project may have
   * no suite and the agent verifies instead. `docs/HANDOFF.md` makes the
   * constraint on this card explicit - *"Every surface that today prints an
   * exit code must distinguish the two … 'Self-checked by the agent - no test
   * command' is true; a green tick is not."*
   *
   * The blank strings are in the table because the store refuses them
   * (`""`, `"   "`, `"\t\n"` all refuse in `test/projects.test.ts`), so they
   * cannot arrive from a valid record - but this card reads a tree over HTTP,
   * not the store, and "kantan runs    until it exits 0" is the one reading no
   * value of this field justifies. Under-claiming a verification is the cheap
   * direction; over-claiming one gets work merged that nothing checked.
   */
  const COMMANDS: readonly (readonly [string, string | null, boolean])[] = [
    ["a command", "npm test", true],
    ["another command", "bun run check", true],
    ["a command with surrounding space", "  npm test  ", true],
    ["no command at all", null, false],
    ["an empty command", "", false],
    ["a whitespace command", "   ", false],
    ["a tab and a newline", "\t\n", false],
  ]

  test.each(COMMANDS)("%s claims an exit code: %p -> %p", async (_name, testCmd: string | null, claims: boolean) => {
    await render(panel(startProps({ testCmd })))
    const said = prose()
    expect(said.includes("until it exits 0")).toBe(claims)
    expect(said.includes("verifies its own work")).toBe(!claims)
  })

  test("a project with no suite says so in the Tests field itself, not merely somewhere", async () => {
    await render(panel(startProps({ testCmd: null })))
    expect(one('[data-testid="test-cmd"]').textContent).toBe("Self-checked by the agent — no test command")
    expect(prose()).not.toContain("exits 0")
  })

  /**
   * Read off the element's own `textContent`, not `prose()`: that helper
   * collapses runs of whitespace, so a component that trimmed or reflowed the
   * command would pass an assertion made through it. A shell string's spacing
   * is the user's, and `src/run.ts` hands it to `sh -c` verbatim.
   */
  test("a command keeps its own spacing, because it is a shell string", async () => {
    await render(panel(startProps({ testCmd: "npm test  --  --runInBand" })))
    expect(one('[data-testid="test-cmd"]').textContent).toBe("npm test  --  --runInBand")
    expect(one('[data-testid="step-cmd"]').textContent).toBe("npm test  --  --runInBand")
  })

  test("the steps are a numbered sequence, because the phases are one", async () => {
    await render(panel(VARIANTS.open()))
    const steps = all('[data-testid="step"]')
    expect(steps.length).toBe(3)
    expect(steps.map((s) => (s.textContent ?? "").slice(0, 1))).toEqual(["1", "2", "3"])
    /* An `<ol>`, so the order is in the markup and not only in the drawing. */
    expect(steps[0]?.parentElement?.tagName).toBe("OL")
  })

  test("the blocked footer says when the button comes back, not that it is broken", async () => {
    await render(panel(VARIANTS.busy()))
    const said = prose()
    expect(said).toContain(ARTBOARD.blockedAside)
    expect(said).toContain(ARTBOARD.oneAtATime)
    expect(said).not.toContain(ARTBOARD.startAside)
  })

  test("the interrupted card says nothing was lost, and what resuming does", async () => {
    await render(panel(VARIANTS.interrupted()))
    const said = prose()
    expect(said).toContain("Interrupted")
    expect(said).toContain("That is normal in development and nothing was lost.")
    expect(said).toContain("Resuming continues the same run from its last recorded event.")
    expect(said).toContain(ARTBOARD.kept)
  })
})

// --- The ceiling ------------------------------------------------------------

/**
 * The enumeration, as a table, with the figure each string may fund.
 *
 * `null` means the card must refuse to start. The first group is
 * `src/server.ts`'s own list for the raise route, mapped onto the strings a
 * text field can hold; the second is what the parsing primitives get wrong if
 * reached directly; the third is what must be accepted, because a guard that
 * refuses everything is not a guard.
 */
const CEILING_CASES: readonly (readonly [string, number | null])[] = [
  /* The route's list: absent, non-numeric, NaN, both infinities, zero,
     negative zero, negative. */
  ["", null],
  ["   ", null],
  ["abc", null],
  ["NaN", null],
  ["Infinity", null],
  ["-Infinity", null],
  ["0", null],
  ["0.00", null],
  ["-0", null],
  ["-5", null],
  /* The primitives' traps. `parseFloat("50abc")` is 50 and `Number("0x32")` is
     50, so either one reached directly funds a run off a string that was
     never a dollar figure. A 400-digit run of digits is valid *syntax* and
     overflows to Infinity, which is why the finite check runs after the
     pattern rather than instead of it. */
  ["50abc", null],
  ["0x32", null],
  ["1e2", null],
  ["1,000", null],
  ["$50", null],
  [".5", null],
  ["5.", null],
  /* Fullwidth digits: `\d` is ASCII-only, and the figure a human means by
     these is not one this field should guess at. */
  ["５０", null],
  ["9".repeat(400), null],
  /* Funded. */
  ["50", 50],
  ["50.00", 50],
  ["12.50", 12.5],
  ["0.01", 0.01],
  /* The one normalisation this field performs, asserted rather than assumed. */
  [" 50 ", 50],
]

describe("the ceiling, which is money", () => {
  test.each(CEILING_CASES)("%p funds %p", async (typed: string, funded: number | null) => {
    const calls: unknown[] = []
    await render(panel(startProps({ defaultCeilingUsd: 50, onStart: (c) => calls.push(c) })))
    await type(ceiling(), typed)

    const start = button(ARTBOARD.start)
    expect(start.disabled).toBe(funded === null)

    await click(start)
    expect(calls).toEqual(funded === null ? [] : [funded])
  })

  test("what reaches onStart is a number, never the string that was typed", async () => {
    const calls: unknown[] = []
    await render(panel(startProps({ defaultCeilingUsd: 50, onStart: (c) => calls.push(c) })))
    await type(ceiling(), "12.50")
    await click(button(ARTBOARD.start))
    expect(calls.map((c) => typeof c)).toEqual(["number"])
    expect(calls).toEqual([12.5])
  })

  test("the field is seeded with the project's own default, in dollars and cents", async () => {
    await render(panel(startProps({ defaultCeilingUsd: 50 })))
    expect(ceiling().value).toBe("50.00")
    expect(prose()).toContain(ARTBOARD.ceilingLabel)
  })

  test("a refused figure is announced on the field, and names what is wanted", async () => {
    await render(panel(startProps({ defaultCeilingUsd: 50 })))
    await type(ceiling(), "-5")

    const field = ceiling()
    expect(field.getAttribute("aria-invalid")).toBe("true")
    const note = one('[data-testid="ceiling-note"]')
    expect(field.getAttribute("aria-describedby")).toBe(note.getAttribute("id"))
    expect(note.textContent).toContain("above zero")
  })

  test("a figure that funds a run is not flagged", async () => {
    await render(panel(startProps({ defaultCeilingUsd: 50 })))
    await type(ceiling(), "20")
    expect(ceiling().getAttribute("aria-invalid")).toBe("false")
    expect(maybe('[data-testid="ceiling-note"]')).toBeNull()
  })

  test("the label is tied to the field, so clicking it focuses the field", async () => {
    await render(panel(startProps({ defaultCeilingUsd: 50 })))
    const label = byText<HTMLLabelElement>("label", ARTBOARD.ceilingLabel)
    expect(label).not.toBeNull()
    expect(label?.getAttribute("for")).toBe(ceiling().getAttribute("id"))
  })

  /**
   * `START_KEYS` in `src/server.ts` is `["projectPath", "featureFile",
   * "taskRef"]` and `parseBody` refuses unknown keys, so a per-run ceiling is a
   * 400 today; `TreeProject` has no `budgetUsd` for the shell to seed the field
   * with either. Until both land the control is not drawn, because a field that
   * cannot change what it claims to change is worse than an absent one.
   */
  test("no ceiling control at all when the shell has no figure to offer", async () => {
    const calls: unknown[] = []
    await render(panel(startProps({ onStart: (c) => calls.push(c) })))
    expect(maybe('input[data-testid="ceiling"]')).toBeNull()
    expect(prose()).not.toContain(ARTBOARD.ceilingLabel)

    await click(button(ARTBOARD.start))
    expect(calls).toEqual([undefined])
  })

  test("a ceiling typed for one task does not follow the card to the next", async () => {
    const calls: unknown[] = []
    const onStart = (c?: number): void => void calls.push(c)
    await render(panel(startProps({ defaultCeilingUsd: 50, onStart })))
    await type(ceiling(), "7")

    const next: TreeTask = { ref: "T4", text: "Something else", done: false }
    await render(panel(startProps({ task: next, defaultCeilingUsd: 50, onStart })))
    expect(ceiling().value).toBe("50.00")

    await click(button(ARTBOARD.start))
    expect(calls).toEqual([50])
  })
})

// --- Firing an action -------------------------------------------------------

describe("committing to a run", () => {
  test("one click is one run, and so are two clicks", async () => {
    let calls = 0
    await render(panel(startProps({ onStart: () => void calls++ })))
    const start = button(ARTBOARD.start)
    await click(start)
    await click(start)
    expect(calls).toBe(1)
  })

  /**
   * **Two clicks in one tick**, which is the case a latch in state does not
   * survive and the case that costs money.
   *
   * Measured: with the latch replaced by `if (acting) return`, the test above
   * still passes - `click()` is wrapped in `act()`, so React has re-rendered
   * and `acting` is already `true` by the second click. Both handlers here run
   * inside one batch instead, so both closures read the state as it was, and
   * only a ref stops the second one paying for a second run.
   */
  test("two clicks in one tick are still one run", async () => {
    let calls = 0
    await render(panel(startProps({ onStart: () => void calls++ })))
    const start = button(ARTBOARD.start)
    await api.act(async () => {
      start.click()
      start.click()
    })
    expect(calls).toBe(1)
  })

  test("two resume clicks in one tick are still one resume", async () => {
    let calls = 0
    await render(panel(resumeProps({ onResume: () => void calls++ })))
    const resume = button(ARTBOARD.resume)
    await api.act(async () => {
      resume.click()
      resume.click()
    })
    expect(calls).toBe(1)
  })

  /* Under StrictMode too, which double-invokes render: a latch kept in state
   * rather than in a ref reads stale and pays twice. */
  test("the latch survives StrictMode's double render", async () => {
    let calls = 0
    await renderStrict(startProps({ onStart: () => void calls++ }))
    const start = button(ARTBOARD.start)
    await click(start)
    await click(start)
    expect(calls).toBe(1)
  })

  test("resuming twice resumes once", async () => {
    let calls = 0
    await render(panel(resumeProps({ onResume: () => void calls++ })))
    const resume = button(ARTBOARD.resume)
    await click(resume)
    await click(resume)
    expect(calls).toBe(1)
  })

  test("starting shows the artboard's planning line in place of the button", async () => {
    await render(panel(startProps({ onStart: () => new Promise(() => {}) })))
    await click(button(ARTBOARD.start))

    const status = one('[data-testid="starting"]')
    expect(status.getAttribute("role")).toBe("status")
    expect(prose()).toContain(ARTBOARD.planning)
    expect(prose()).toContain(ARTBOARD.planningAside)
    expect(byText("button", ARTBOARD.start)).toBeNull()
  })

  /**
   * `Gate.onApprove`'s contract, reused: the server answers an action with a
   * tagged refusal carrying a message written for a human, and a card that kept
   * saying "Planning." after one would be lying.
   */
  test("a rejected start hands the button back, with the server's own words", async () => {
    const why = "refused: busy — another run holds this project's lock"
    await render(panel(startProps({ onStart: () => Promise.reject(new Error(why)) })))
    await click(button(ARTBOARD.start))

    expect(maybe('[data-testid="starting"]')).toBeNull()
    const alert = one('[data-testid="refusal"]')
    expect(alert.getAttribute("role")).toBe("alert")
    expect(alert.textContent).toBe(why)
    expect(button(ARTBOARD.start).disabled).toBe(false)
  })

  test("a refused start can be retried, because the latch was released too", async () => {
    let calls = 0
    await render(
      panel(
        startProps({
          onStart: () => {
            calls += 1
            return calls === 1 ? Promise.reject(new Error("nope")) : undefined
          },
        }),
      ),
    )
    await click(button(ARTBOARD.start))
    await click(button(ARTBOARD.start))
    expect(calls).toBe(2)
  })

  test("a synchronous throw is reported, not swallowed", async () => {
    await render(
      panel(
        startProps({
          onStart: () => {
            throw new Error("no runner is wired")
          },
        }),
      ),
    )
    await click(button(ARTBOARD.start))
    expect(one('[data-testid="refusal"]').textContent).toBe("no runner is wired")
  })

  /**
   * A promise from the previous task must not undo this one's state. The shell
   * is not obliged to remount the card, so without the generation check a
   * refusal about a task nobody is looking at would surface on the next.
   */
  test("a refusal that lands after the card moved on is dropped", async () => {
    let reject: (cause: Error) => void = () => {}
    const slow = (): Promise<never> =>
      new Promise((_resolve, no) => {
        reject = no
      })

    await render(panel(startProps({ onStart: slow })))
    await click(button(ARTBOARD.start))

    const next: TreeTask = { ref: "T4", text: "Another task", done: false }
    await render(panel(startProps({ task: next, onStart: () => {} })))

    await api.act(async () => {
      reject(new Error("about the previous task"))
      await Promise.resolve()
    })

    expect(maybe('[data-testid="refusal"]')).toBeNull()
    expect(button(ARTBOARD.start).disabled).toBe(false)
  })

  test("the planning state does not follow the card to the next task", async () => {
    await render(panel(startProps({ onStart: () => new Promise(() => {}) })))
    await click(button(ARTBOARD.start))
    expect(maybe('[data-testid="starting"]')).not.toBeNull()

    const next: TreeTask = { ref: "T4", text: "Another task", done: false }
    await render(panel(startProps({ task: next, onStart: () => {} })))
    expect(maybe('[data-testid="starting"]')).toBeNull()
    expect(button(ARTBOARD.start).disabled).toBe(false)
  })

  /* Two files in one repo both have a `T1`, so the ref alone is not the task. */
  test("the same ref in another feature file is another task", async () => {
    await render(panel(startProps({ onStart: () => new Promise(() => {}) })))
    await click(button(ARTBOARD.start))

    await render(panel(startProps({ featureFile: "docs/features/export.md", onStart: () => {} })))
    expect(maybe('[data-testid="starting"]')).toBeNull()
  })

  test("while resuming, neither footer button can fire again", async () => {
    let resumes = 0
    let overs = 0
    await render(
      panel(
        resumeProps({
          onResume: () => {
            resumes += 1
            return new Promise(() => {})
          },
          onStartOver: () => void overs++,
        }),
      ),
    )
    await click(button(ARTBOARD.resume))
    await click(button(ARTBOARD.resume))
    await click(button(ARTBOARD.startOver))
    expect([resumes, overs]).toEqual([1, 0])
  })
})

// --- The one-at-a-time guard ------------------------------------------------

/**
 * What the alert may claim, by what the blocker is doing.
 *
 * The dimension is `RunState["kind"]`, and every value it can take is here
 * including the ones no fixture elsewhere produces. The reason it is read at
 * all: the lock is per project (`acquireRunLock(repo, …)`) and a run parked at
 * the gate holds no process, so "is running" is a claim the card cannot make
 * from the fact of being blocked. Being wrong in that direction sends someone
 * looking for an agent that is not there; being vague costs a few words.
 */
const BLOCKER_STATES: readonly (readonly [string, RunState, string])[] = [
  ["running", { kind: "running", phase: "implement" }, "is running."],
  ["waiting at the gate", { kind: "waiting", reason: "gate" }, "is waiting for you."],
  ["waiting on a question", { kind: "waiting", reason: "question" }, "is waiting for you."],
  ["interrupted", { kind: "interrupted", resumeFrom: "test" }, "was interrupted and still holds the run lock."],
  ["done", { kind: "done", merged: false }, "still holds the run lock."],
  ["failed", { kind: "failed", why: "exit 1" }, "still holds the run lock."],
]

describe("the one-at-a-time guard", () => {
  test.each(BLOCKER_STATES)("a blocker that is %s: %p", async (_name: string, state: RunState, clause: string) => {
    await render(panel(startProps({ blockedBy: blocker({ state }) })))
    const said = (one('[data-testid="one-at-a-time"]').textContent ?? "").replace(/\s+/g, " ")
    expect(said).toContain(`other-repo · T2 Refund path ${clause}`)
    expect(said).toContain(ARTBOARD.oneAtATime)
  })

  test("the blocker is named, because one of these is not like the others", async () => {
    await render(panel(startProps({ blockedBy: blocker({ label: "your-app · T9 Something else" }) })))
    expect(prose()).toContain("your-app · T9 Something else")
  })

  test("the link to that run appears only when there is somewhere to go", async () => {
    await render(panel(startProps({ blockedBy: blocker() })))
    expect(byText("button", ARTBOARD.goToRun)).toBeNull()

    let went = 0
    await render(panel(startProps({ blockedBy: blocker({ onGoToRun: () => void went++ }) })))
    await click(button(ARTBOARD.goToRun))
    expect(went).toBe(1)
  })
})

// --- Reduced motion ---------------------------------------------------------

/**
 * Motion's half of the OR is quarantined to `false` in this file, so these
 * exercise the **live** half - the half that has to work. Deleting `|| live`
 * from the component must turn this section red.
 *
 * The preference is set **without** firing `change` in the first test, which is
 * the stale state HANDOFF's correction says the trap actually occurs in: a stub
 * that fires `change` repairs Motion's singleton as a side effect and so passes
 * even with a broken fallback.
 */
describe("reduced motion", () => {
  const ANIMATED = ["bf", "d1", "d2", "d3", "spin", "ks-shine"]

  test.each(ALL_VARIANTS)("%s animates nothing when the preference was set silently", async (variant: Variant) => {
    setPrefersReduceSilently(true)
    await render(panel(VARIANTS[variant]()))

    const card = one("section")
    expect(card.getAttribute("data-motion")).toBe("static")
    const classes = [...all("[class]")].flatMap((el) => (el.getAttribute("class") ?? "").split(/\s+/))
    for (const name of ANIMATED) expect(classes).not.toContain(name)
  })

  test.each(ALL_VARIANTS)("%s animates when nobody asked it not to", async (variant: Variant) => {
    await render(panel(VARIANTS[variant]()))
    const card = one("section")
    expect(card.getAttribute("data-motion")).toBe("animated")
    expect(classesOf("section")).toContain("bf")
  })

  test("the planning line's shine is withheld, not just its colour changed", async () => {
    setPrefersReduceSilently(true)
    await render(panel(startProps({ onStart: () => new Promise(() => {}) })))
    await click(button(ARTBOARD.start))
    const classes = [...all("[class]")].flatMap((el) => (el.getAttribute("class") ?? "").split(/\s+/))
    expect(classes).not.toContain("ks-shine")
    expect(classes).not.toContain("spin")
    expect(prose()).toContain(ARTBOARD.planning)
  })

  test("a preference that changes mid-session is noticed", async () => {
    await render(panel(VARIANTS.open()))
    expect(one("section").getAttribute("data-motion")).toBe("animated")

    await api.act(async () => {
      setPrefersReduce(true)
    })
    expect(one("section").getAttribute("data-motion")).toBe("static")
  })

  test("the steps keep their stagger when motion is allowed", async () => {
    await render(panel(VARIANTS.open()))
    const rungs = all('[data-testid="step"]').map((s) => s.getAttribute("class"))
    expect(rungs).toEqual(["bf d1", "bf d2", "bf d3"])
  })
})

// --- What the shell does not know -------------------------------------------

/**
 * Every one of these is a figure or a string the UI cannot derive today, and
 * the rule for all of them is the same: omit it rather than print a guess.
 * `TreeTask` has no line number, no raw markdown line and no attempt count;
 * `Account` has no usage figure; `TreeProject` has no `budgetUsd`.
 */
describe("absent data is omitted, never invented", () => {
  test("no line number means no line clause", async () => {
    await render(panel(startProps()))
    expect(prose()).toContain("docs/features/importer.md")
    expect(prose()).not.toContain("· line")

    await render(panel(startProps({ line: 7 })))
    expect(prose()).toContain("docs/features/importer.md · line 7")
  })

  test("the backlog chip prints the file's own bytes, and nothing when it has none", async () => {
    await render(panel(startProps()))
    expect(maybe('[data-testid="backlog-line"]')).toBeNull()

    await render(panel(startProps({ backlogLine: "- [ ] T3 Runtime shim (v1.2)" })))
    expect(one('[data-testid="backlog-line"]').textContent).toBe("- [ ] T3 Runtime shim (v1.2)")
  })

  test("no usage figure means no percentage", async () => {
    await render(panel(startProps()))
    expect(prose()).not.toContain("% used")

    await render(panel(startProps({ usagePct: 41 })))
    expect(prose()).toContain("41% used")
  })

  test("Change is offered only when something can change the account", async () => {
    await render(panel(startProps()))
    expect(prose()).not.toContain("Change")

    let changes = 0
    await render(panel(startProps({ onChangeAccount: () => void changes++ })))
    await click(button("Change"))
    expect(changes).toBe(1)
  })

  test("the phase comes from the run's own state, and is dropped when it says nothing", async () => {
    await render(panel(resumeProps()))
    expect(prose()).toContain("stopped during implement")
    expect(prose()).toContain("Stopped in")

    /* A task with no run at all: nothing recorded a phase, so no phase is
       named and the summary cell goes rather than printing a blank. */
    await render(panel(resumeProps({ task: { ref: "T1", text: "Stream CSV export", done: false } })))
    expect(prose()).toContain("stopped mid-run")
    expect(prose()).not.toContain("Stopped in")
  })

  test("no attempt count means no attempt clause", async () => {
    await render(panel(resumeProps()))
    expect(prose()).not.toContain("attempt")

    await render(panel(resumeProps({ attempt: 2 })))
    expect(prose()).toContain("stopped during implement, attempt 2")
    expect(prose()).toContain("Implement · attempt 2")
  })

  test("spend is printed with its ceiling, and omitted entirely when unknown", async () => {
    await render(panel(resumeProps()))
    expect(prose()).not.toContain("Spent so far")

    await render(panel(resumeProps({ spentUsd: 1.12 })))
    expect(definitionOf("Spent so far")).toBe("$1.12")

    await render(panel(resumeProps({ spentUsd: 1.12, ceilingUsd: 50 })))
    expect(definitionOf("Spent so far")).toBe("$1.12 of $50.00")
  })

  test("the tail prints the records it was given, and the rule either way", async () => {
    await render(panel(resumeProps()))
    expect(all('[data-testid="tail-row"]').length).toBe(0)
    expect(prose()).toContain(ARTBOARD.kept)

    await render(
      panel(
        resumeProps({
          lastEvents: [
            { kind: "edit", text: "src/export/stream.ts", added: 34, removed: 5, at: "14:01:48" },
            { kind: "shell", text: "npm test", at: "14:01:55" },
          ],
        }),
      ),
    )
    const rows = all('[data-testid="tail-row"]')
    expect(rows.length).toBe(2)
    /* Icon, kind, subject, clock - read per column, because `textContent` runs
       the four together. The minus is the artboard's U+2212, not a hyphen. */
    expect(rows[0] === undefined ? null : columnsOf(rows[0])).toEqual([
      "",
      "edit",
      "src/export/stream.ts +34 −5",
      "14:01:48",
    ])
    expect(rows[1] === undefined ? null : columnsOf(rows[1])).toEqual(["", "shell", "npm test", "14:01:55"])
  })

  test("Start over appears only when a caller has something behind it", async () => {
    await render(panel(resumeProps()))
    expect(byText("button", ARTBOARD.startOver)).toBeNull()
    expect(prose()).not.toContain(ARTBOARD.startOverAside)

    let overs = 0
    await render(panel(resumeProps({ onStartOver: () => void overs++ })))
    await click(button(ARTBOARD.startOver))
    expect(overs).toBe(1)
    expect(prose()).toContain(ARTBOARD.startOverAside)
  })

  test("no stop time means the eyebrow says only that it was interrupted", async () => {
    await render(panel(resumeProps()))
    expect(prose()).toContain("Interrupted")
    expect(prose()).not.toContain("Interrupted ·")

    await render(panel(resumeProps({ stoppedAt: "today at 14:02" })))
    expect(prose()).toContain("Interrupted · today at 14:02")
  })

  test("the account chip has a variant per kind, and says so when it does not know", async () => {
    await render(panel(startProps({ account: { kind: "work" } })))
    expect(prose()).toContain("work")

    await render(panel(startProps({ account: { kind: "unknown" } })))
    expect(prose()).toContain("account unknown")

    await render(panel(startProps({ account: { kind: "personal", label: "laith@home" } })))
    expect(prose()).toContain("laith@home")
  })
})

// --- Odds and ends ----------------------------------------------------------

describe("the panel in its column", () => {
  test("it renders a section and not a main, because App.tsx owns the column", async () => {
    await render(panel(VARIANTS.open()))
    expect(all("main").length).toBe(0)
    expect(all("section").length).toBe(1)
    /* The breadcrumb and the dotted ground are App's too. */
    expect(all(".dots").length).toBe(0)
    expect(all("nav").length).toBe(0)
  })

  test("preflight's line-height is undone, as it is on every other ported card", async () => {
    await render(panel(VARIANTS.open()))
    expect(classesOf("section")).toContain("leading-[normal]")
    expect(classesOf("section")).toContain("kr")
  })

  test("a caller's className rides along with the card's own", async () => {
    await render(panel(startProps({ className: "max-w-[860px]" })))
    const classes = classesOf("section")
    expect(classes).toContain("max-w-[860px]")
    expect(classes).toContain("kr")
  })

  test("a task with no ref still renders, because the shell decides what can run", async () => {
    await render(panel(startProps({ task: { ref: null, text: "A line with no ref", done: false } })))
    expect(prose()).toContain("A line with no ref")
  })
})
