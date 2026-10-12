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

/** Everything the subtree says, with runs of whitespace flattened. */
function prose(): string {
  return (host.textContent ?? "").replace(/\s+/g, " ").trim()
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
