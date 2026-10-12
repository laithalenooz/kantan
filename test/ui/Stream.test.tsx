/**
 * The run record, under the four promises it cannot break.
 *
 * It virtualises. Paths wrap. Only new rows animate. Exit codes are printed.
 *
 * ## Two things about this harness that are not incidental
 *
 * **happy-dom has to be registered before `motion` is imported.** `motion-dom`
 * decides `const isBrowser = typeof window !== "undefined"` at module
 * evaluation, and ES imports are hoisted above every statement in the module
 * body — so a plain `import { ... } from "motion/react"` at the top of this
 * file evaluates while there is still no `window`, `initPrefersReducedMotion`
 * returns early, and `useReducedMotion()` answers `null` for the life of the
 * process whatever the media query says. The reduced-motion test would then
 * pass by never testing anything. Hence `beforeAll` plus `await import()`:
 * registration first, DOM-sensing modules second.
 *
 * **Nothing is measured here unless this file says how big it is.** happy-dom
 * runs no layout, so every rect is zero. The virtualizer reads exactly two
 * things — `offsetHeight` on the scroll element and on each row, via
 * `getRect`/`measureElement`, and `scrollTop`/`clientHeight`/`scrollHeight` for
 * the offset — so the stub below supplies those four and nothing else. Without
 * it the scroller is a 0px viewport, every row measures 0, and `calculateRange`
 * concludes that all ten thousand rows fit: the bound test would fail, or worse,
 * pass for a reason that has nothing to do with virtualization.
 *
 * What this file therefore cannot see: that the CSS which makes a long path wrap
 * is really applied, since no stylesheet is loaded. It checks the contract that
 * produces it — the wrapping utility present, no clamping utility present, the
 * grid track at `minmax(0,...)`, and the whole string in the DOM — and the
 * utility's emission is verified separately against a real Tailwind build.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { StreamParser, type Event } from "../../src/stream"
import type { StreamRow } from "../../src/ui/Row.tsx"

// --- Layout the stub supplies ----------------------------------------------

/** The scroller's height, as `Main.dc.html` sets it. */
const VIEWPORT_PX = 520
/** One unwrapped row. Two more than `ROW_ESTIMATE_PX`, so measuring shows. */
const ROW_PX = 40
/** An expanded row, so expanding visibly changes the total. */
const EXPANDED_PX = 180

const FIXTURES = join(import.meta.dir, "..", "fixtures")

// --- Deferred, DOM-sensing modules -----------------------------------------

interface Api {
  act: typeof import("react").act
  StrictMode: typeof import("react").StrictMode
  createRoot: typeof import("react-dom/client").createRoot
  MotionConfig: typeof import("motion/react").MotionConfig
  motion: typeof import("motion/react").motion
  Stream: typeof import("../../src/ui/Stream.tsx").Stream
}

let api: Api

// --- Stubs ------------------------------------------------------------------

type Saved = { name: string; descriptor: PropertyDescriptor | undefined }
const savedProps: Saved[] = []

function override(name: string, get: (this: HTMLElement) => number): void {
  savedProps.push({ name, descriptor: Object.getOwnPropertyDescriptor(HTMLElement.prototype, name) })
  Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get })
}

function installLayout(): void {
  override("offsetHeight", function offsetHeight(this: HTMLElement) {
    if (this.hasAttribute("data-stream-viewport")) return VIEWPORT_PX
    if (this.hasAttribute("data-index")) {
      return this.querySelector('[aria-expanded="true"]') ? EXPANDED_PX : ROW_PX
    }
    return 0
  })

  override("clientHeight", function clientHeight(this: HTMLElement) {
    return this.hasAttribute("data-stream-viewport") ? VIEWPORT_PX : 0
  })

  /* The scroller's content is the virtual container, whose height the component
   * sets from `getTotalSize()`. Reading it back is what lets `scrollTop =
   * scrollHeight` reach the end of a ten-thousand-row log. */
  override("scrollHeight", function scrollHeight(this: HTMLElement) {
    if (!this.hasAttribute("data-stream-viewport")) return 0
    const total = this.querySelector("[data-stream-total]")
    const height = total instanceof HTMLElement ? Number.parseFloat(total.style.height) : 0
    return Math.max(Number.isFinite(height) ? height : 0, VIEWPORT_PX)
  })

  /*
   * A browser clamps an assignment to `scrollTop` and fires `scroll`; happy-dom
   * stores the number and stays silent. The virtualizer learns its offset from
   * that event and from nothing else, so without this the component's own
   * scroll-to-the-bottom would move the element and leave the virtualizer
   * rendering the top of the log — which is how "the newest event is rendered"
   * first failed here.
   */
  const scrolled = new WeakMap<HTMLElement, number>()
  savedProps.push({ name: "scrollTop", descriptor: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop") })
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return scrolled.get(this) ?? 0
    },
    set(this: HTMLElement, value: number) {
      const max = Math.max(0, this.scrollHeight - this.clientHeight)
      const next = Math.min(Math.max(0, Number.isFinite(value) ? value : 0), max)
      if ((scrolled.get(this) ?? 0) === next) return
      scrolled.set(this, next)
      /* Asynchronously, as a browser does. Dispatching inline would land the
       * virtualizer's `flushSync` inside whatever effect moved the scroller,
       * which React refuses to flush and warns about. `act` drains microtasks,
       * so a test still sees the new range before its assertions. */
      queueMicrotask(() => this.dispatchEvent(new Event("scroll")))
    },
  })
}

/**
 * Stops a cancelled animation from becoming an unhandled rejection.
 *
 * happy-dom's `Animation.cancel()` rejects its internal `finished` promise, and
 * Motion attaches no handler to it. A virtualized row is cancelled every time
 * it scrolls out of the window, so the behaviour under test — rows coming and
 * going — otherwise buries the run in `AbortError`s that bun attributes to
 * whichever test happened to be running. Catching on the animation this file
 * hands back leaves Motion on its real WAAPI path, which is the one a browser
 * takes, rather than pushing it onto a fallback nothing ships.
 */
let savedAnimate: PropertyDescriptor | undefined

function quietenAnimationCancels(): void {
  savedAnimate = Object.getOwnPropertyDescriptor(Element.prototype, "animate")
  const real = Element.prototype.animate
  if (typeof real !== "function") return
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    writable: true,
    value: function animate(this: Element, ...args: Parameters<Element["animate"]>) {
      const animation = real.apply(this, args)
      void animation?.finished?.catch(() => {})
      return animation
    },
  })
}

function restoreAnimate(): void {
  if (savedAnimate) Object.defineProperty(Element.prototype, "animate", savedAnimate)
}

function restoreLayout(): void {
  for (const { name, descriptor } of savedProps.reverse()) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    else Reflect.deleteProperty(HTMLElement.prototype, name)
  }
  savedProps.length = 0
}

/**
 * A live `prefers-reduced-motion` query.
 *
 * `motion` reads the preference once, into a module-level singleton, and then
 * keeps it current from a `change` listener. So the stub has to be a real event
 * source: setting `matches` without firing would leave every later mount on
 * whatever the first mount happened to see.
 */
const reduceListeners = new Set<(event: { matches: boolean }) => void>()
let prefersReduce = false

const reduceQuery = {
  media: "(prefers-reduced-motion)",
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

let realMatchMedia: typeof window.matchMedia | undefined

function installMedia(): void {
  realMatchMedia = window.matchMedia.bind(window)
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) =>
      /prefers-reduced-motion/.test(query) ? reduceQuery : realMatchMedia?.(query),
  })
}

function restoreMedia(): void {
  if (realMatchMedia) {
    Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: realMatchMedia })
  }
}

function setPrefersReduce(value: boolean): void {
  prefersReduce = value
  for (const cb of reduceListeners) cb({ matches: value })
}

/**
 * Whether this file is the one that put the document there.
 *
 * `bun test` runs every file in one process, `register()` throws on a second
 * call, and three sibling UI test files exist — `Gate`, `Sidebar` and `Tree` —
 * each of which registers too. So take the slot only if it is free, and give
 * back only what was taken: another file's document is a document, which is all
 * this one needs, and unregistering it from under a file still using it would
 * be the same bug in the other direction.
 */
let ownsDocument = false

beforeAll(async () => {
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register()
    ownsDocument = true
  }
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  installLayout()
  installMedia()
  quietenAnimationCancels()

  const react = await import("react")
  const reactDom = await import("react-dom/client")
  const motionReact = await import("motion/react")
  const streamUi = await import("../../src/ui/Stream.tsx")

  api = {
    act: react.act,
    StrictMode: react.StrictMode,
    createRoot: reactDom.createRoot,
    MotionConfig: motionReact.MotionConfig,
    motion: motionReact.motion,
    Stream: streamUi.Stream,
  }
})

afterAll(async () => {
  restoreAnimate()
  restoreMedia()
  restoreLayout()
  /* Bun runs every test file in one process and happy-dom replaces `fetch`,
   * `Response`, `Request` and `Headers`, which `server.test.ts` and
   * `run.test.ts` both depend on. Leaving a document this file opened behind
   * would break them. */
  if (ownsDocument) await GlobalRegistrator.unregister()
})

// --- Mounting ---------------------------------------------------------------

interface Mounted {
  host: HTMLElement
  /** The scroll element, as the component marks it. */
  viewport: HTMLElement
  update(element: React.ReactNode): Promise<void>
  /** Puts the scroller at an offset and lets the virtualizer react. */
  scrollTo(top: number): Promise<void>
  scrollToBottom(): Promise<void>
  row(id: string): HTMLElement | null
  rows(): HTMLElement[]
  unmount(): Promise<void>
}

const live: Mounted[] = []

/** Mounted the way `main.tsx` mounts: StrictMode over `reducedMotion="user"`. */
async function mount(element: React.ReactNode): Promise<Mounted> {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const root = api.createRoot(host)

  const wrap = (node: React.ReactNode) => (
    <api.StrictMode>
      <api.MotionConfig reducedMotion="user">{node}</api.MotionConfig>
    </api.StrictMode>
  )

  await api.act(async () => {
    root.render(wrap(element))
  })

  const viewport = host.querySelector("[data-stream-viewport]")
  const mounted: Mounted = {
    host,
    viewport: viewport instanceof HTMLElement ? viewport : document.createElement("div"),
    async update(next) {
      await api.act(async () => {
        root.render(wrap(next))
      })
    },
    async scrollTo(top) {
      /* The stubbed setter fires `scroll`, as a browser does, so the
       * virtualizer re-ranges inside this `act`. */
      await api.act(async () => {
        mounted.viewport.scrollTop = top
      })
    },
    async scrollToBottom() {
      await mounted.scrollTo(mounted.viewport.scrollHeight)
    },
    row: (id) => {
      const el = host.querySelector(`[data-row-id="${id}"]`)
      return el instanceof HTMLElement ? el : null
    },
    rows: () => [...host.querySelectorAll("[data-row-id]")].filter((el): el is HTMLElement => el instanceof HTMLElement),
    async unmount() {
      await api.act(async () => {
        root.unmount()
      })
      host.remove()
    },
  }
  live.push(mounted)
  return mounted
}

afterEach(async () => {
  while (live.length > 0) {
    const mounted = live.pop()
    if (mounted) await mounted.unmount()
  }
  setPrefersReduce(false)
})

async function click(el: HTMLElement): Promise<void> {
  await api.act(async () => {
    el.click()
  })
}

// --- Row builders -----------------------------------------------------------

function eventRow(id: string, event: Event, extra: { at?: number; errors?: unknown } = {}): StreamRow {
  return { id, event, ...extra }
}

/** A path exactly 158 characters long, because the brief names that length. */
const PATH_158 = (() => {
  const stem =
    "/home/you/code/your-app/packages/importer/src/adapters/legacy/manifest-v1/__fixtures__/2024-q3-export-with-unknown-fields-and-mixed-epoch-and-iso-timestamps-x"
  const tail = ".json"
  const path = stem.padEnd(158 - tail.length, "x").slice(0, 158 - tail.length) + tail
  if (path.length !== 158) throw new Error(`the fixture path is ${path.length} characters, not 158`)
  return path
})()

/** Every `file_path` any tool in a fixture was given, longest first. */
function fixturePaths(file: string): string[] {
  const parser = new StreamParser()
  const events = [...parser.push(readFileSync(join(FIXTURES, file), "utf8")), ...parser.end()]
  const paths: string[] = []
  for (const event of events) {
    if (event.kind !== "tool_use") continue
    const input = event.input
    if (typeof input !== "object" || input === null || Array.isArray(input)) continue
    const value = (input as Record<string, unknown>).file_path
    if (typeof value === "string" && value !== "") paths.push(value)
  }
  return [...new Set(paths)].sort((a, b) => b.length - a.length)
}

/** The parsed events of a fixture, as the UI would receive them. */
function fixtureEvents(file: string): Event[] {
  const parser = new StreamParser()
  return [...parser.push(readFileSync(join(FIXTURES, file), "utf8")), ...parser.end()]
}

/** The raw JSON of a fixture's `result` line, for the fields the parser drops. */
function fixtureResultLine(file: string): Record<string, unknown> {
  for (const line of readFileSync(join(FIXTURES, file), "utf8").split("\n")) {
    if (line.trim() === "") continue
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed === "object" && parsed !== null && (parsed as { type?: unknown }).type === "result") {
      return parsed as Record<string, unknown>
    }
  }
  throw new Error(`${file} holds no result line`)
}

/**
 * A log with the shapes that actually cost height and nodes: a 158-character
 * path, prose, an unrecognised event, a half-written line, a test result.
 * A bound measured on one-word rows would not be a bound on a real run.
 */
function syntheticLog(count: number): StreamRow[] {
  const out: StreamRow[] = []
  const at = Date.UTC(2026, 9, 11, 17, 55, 0)
  for (let i = 0; i < count; i += 1) {
    const id = `e${i}`
    const when = at + i * 1000
    switch (i % 8) {
      case 0:
        out.push(eventRow(id, { kind: "tool_use", id: `t${i}`, name: "Bash", input: { command: "git log --oneline -1" } }, { at: when }))
        break
      case 1:
        out.push(eventRow(id, { kind: "tool_use", id: `t${i}`, name: "Read", input: { file_path: PATH_158 } }, { at: when }))
        break
      case 2:
        out.push(
          eventRow(
            id,
            {
              kind: "text",
              text: "RowWriter.write() throws on keys it does not recognise, so the mapping has to drop unknown fields rather than pass them through.",
            },
            { at: when },
          ),
        )
        break
      case 3:
        out.push(eventRow(id, { kind: "unknown", raw: { type: "tool_progress_v2", tool: "Read", pct: 0.62 } }, { at: when }))
        break
      case 4:
        out.push(eventRow(id, { kind: "parse_error", line: '{"type":"assistant","mess', error: "Unexpected end of JSON input" }, { at: when }))
        break
      case 5:
        out.push(eventRow(id, { kind: "rate_limit", status: "allowed", utilization: 41 }, { at: when }))
        break
      case 6:
        out.push({ id, at: when, tests: { exitCode: i % 3 === 0 ? 0 : 1, attempt: 1 + (i % 5), summary: "10 passing, 1 failing", output: "✕ map.test.ts › warns once per dropped field" } })
        break
      default:
        out.push(eventRow(id, { kind: "tool_use", id: `t${i}`, name: "Edit", input: { file_path: "src/importer/map.ts", old_string: "return { id };", new_string: "return { id, tags };" } }, { at: when }))
        break
    }
  }
  return out
}

/** Classes that would hide the end of a value with nothing to show it had. */
const CLAMPING = ["truncate", "text-ellipsis", "whitespace-nowrap", "overflow-hidden"]

// ---------------------------------------------------------------------------

describe("the run record virtualises", () => {
  test("ten thousand events render a bounded number of rows", async () => {
    const rows = syntheticLog(10_000)
    const mounted = await mount(<api.Stream rows={rows} />)

    const rendered = mounted.rows().length
    const nodes = mounted.host.querySelectorAll("*").length
    console.log(`10,000 events -> ${rendered} row elements, ${nodes} DOM nodes in the record`)

    /* A real window, not a collapsed one: if the stub failed to give the
     * scroller a height the virtualizer would draw one row and the upper bound
     * below would hold for the wrong reason. */
    expect(rendered).toBeGreaterThan(4)
    expect(rendered).toBeLessThan(80)
    expect(nodes).toBeLessThan(1_500)

    /* The log is all there as far as scrolling is concerned, just not as DOM. */
    const total = mounted.host.querySelector("[data-stream-total]")
    expect(total instanceof HTMLElement ? Number.parseFloat(total.style.height) : 0).toBeGreaterThan(300_000)
  })

  test("the bound is the viewport, not the log: a thousand rows cost the same as ten thousand", async () => {
    const small = await mount(<api.Stream rows={syntheticLog(1_000)} />)
    const smallCount = small.rows().length
    await small.unmount()
    live.length = 0

    const large = await mount(<api.Stream rows={syntheticLog(10_000)} />)
    const largeCount = large.rows().length

    console.log(`1,000 events -> ${smallCount} rows; 10,000 events -> ${largeCount} rows`)
    expect(largeCount).toBe(smallCount)
  })

  test("the newest event is rendered, at index 9,999", async () => {
    const mounted = await mount(<api.Stream rows={syntheticLog(10_000)} />)
    expect(mounted.row("e9999")).not.toBeNull()
    expect(mounted.row("e0")).toBeNull()
  })

  test("the header counts the log and the notice counts what is above the window", async () => {
    const mounted = await mount(<api.Stream rows={syntheticLog(10_000)} />)
    expect(mounted.host.textContent).toContain("10,000 events · newest at the bottom")
    expect(mounted.host.textContent).toMatch(/↑ 9,9\d\d earlier events, rendered as you scroll/)
  })

  test("measureElement reports real heights, and an expanded row remeasures", async () => {
    const mounted = await mount(<api.Stream rows={syntheticLog(200)} />)
    const total = () => {
      const el = mounted.host.querySelector("[data-stream-total]")
      return el instanceof HTMLElement ? Number.parseFloat(el.style.height) : 0
    }

    /* 200 rows at the 38px estimate is 7,600. The measured rows report 40, so a
     * wired `measureElement` puts the total above the estimate. */
    const measured = total()
    expect(measured).toBeGreaterThan(200 * 38)

    const expandable = mounted.host.querySelector('[data-row-id] button[aria-expanded="false"]')
    expect(expandable).not.toBeNull()
    if (expandable instanceof HTMLElement) await click(expandable)

    expect(total()).toBeGreaterThan(measured)
  })
})

describe("a long path wraps instead of overflowing", () => {
  test("the fixtures' own longest path is over 150 characters", () => {
    const [longest = ""] = fixturePaths("plan-success.jsonl")
    console.log(`longest fixture file_path: ${longest.length} characters`)
    expect(longest.length).toBeGreaterThan(150)
  })

  for (const [name, path] of [
    ["the 158-character path the brief names", PATH_158],
    ["the longest path in test/fixtures/plan-success.jsonl", fixturePaths("plan-success.jsonl")[0] ?? ""],
  ] as const) {
    test(`${name} wraps, in full, with nothing clamping it`, async () => {
      expect(path.length).toBeGreaterThan(150)
      const rows = [eventRow("p", { kind: "tool_use", id: "t", name: "Read", input: { file_path: path } }, { at: Date.now() })]
      const mounted = await mount(<api.Stream rows={rows} />)

      const row = mounted.row("p")
      expect(row).not.toBeNull()
      if (!row) return

      /* Whole, in the DOM. No slicing, no ellipsis in the string. */
      expect(row.textContent).toContain(path)

      const cell = [...row.querySelectorAll("span")].find((el) => el.textContent === path)
      expect(cell).toBeDefined()
      if (!cell) return

      /* The three things that make it wrap. */
      expect(cell.className).toContain("wrap-anywhere")
      expect(cell.className).toContain("min-w-0")
      const grid = row.querySelector("button, div")
      expect(grid?.className).toContain("minmax(0,1fr)")

      /* And nothing on the way that would hide the end of it. */
      for (let el: HTMLElement | null = cell; el && el !== mounted.viewport; el = el.parentElement) {
        for (const clamp of CLAMPING) {
          expect(el.classList.contains(clamp)).toBe(false)
        }
      }
    })
  }

  test("agent prose is the only thing that clamps, and only behind its expand control", async () => {
    const prose = "The fixture repeats legacyRef twice, so destructuring collapses it to one key and only two warnings fire."
    const mounted = await mount(<api.Stream rows={[eventRow("a", { kind: "text", text: prose })]} />)

    const row = mounted.row("a")
    const collapsed = row?.querySelector("span.overflow-hidden")
    expect(collapsed?.className).toContain("text-ellipsis")

    const button = row?.querySelector("button")
    expect(button?.getAttribute("aria-expanded")).toBe("false")
    if (button instanceof HTMLElement) await click(button)

    expect(mounted.row("a")?.querySelector("button")?.getAttribute("aria-expanded")).toBe("true")
    expect(mounted.row("a")?.querySelector("span.overflow-hidden")).toBeNull()
    expect(mounted.row("a")?.textContent).toContain(prose)
  })
})

describe("an unknown event is never hidden and never an alarm", () => {
  /* Every shape `src/stream.ts` can route to `unknown`, including the four that
   * are valid JSON with no `.type` at all. */
  const shapes: [string, unknown][] = [
    ["null", null],
    ["a number", 42],
    ["an empty array", []],
    ["a populated array", [1, 2, 3]],
    ["an empty string", ""],
    ["a string", "not an object"],
    ["an object with no keys", {}],
    ["an object with no type", { tool: "Read", pct: 0.62 }],
    ["a future event type", { type: "tool_progress_v2", tool: "Read", pct: 0.62, bytes: 18233 }],
    ["a future hook subtype", { type: "system", subtype: "hook_invented_future_thing" }],
  ]

  for (const [name, raw] of shapes) {
    test(`${name} renders legibly`, async () => {
      const mounted = await mount(<api.Stream rows={[eventRow("u", { kind: "unknown", raw })]} />)
      const row = mounted.row("u")
      expect(row).not.toBeNull()

      const text = row?.textContent ?? ""
      expect(text).toContain("Unrecognised event")
      /* Legibly means there is something to read beyond the badge. */
      expect(text.replace("Unrecognised event", "").trim().length).toBeGreaterThan(3)
      expect(text).toContain("shown as it arrived")

      /* And the thing itself is one click away. */
      const button = row?.querySelector("button")
      if (button instanceof HTMLElement) await click(button)
      expect(mounted.row("u")?.textContent).toContain(JSON.stringify(raw, null, 2) ?? String(raw))
    })
  }

  test("it is drawn as a question, not a failure", async () => {
    const mounted = await mount(<api.Stream rows={[eventRow("u", { kind: "unknown", raw: { type: "tool_progress_v2" } })]} />)
    const markup = mounted.row("u")?.outerHTML ?? ""
    for (const alarm of ["text-fail", "bg-fail", "attention", "border-fail"]) {
      expect(markup).not.toContain(alarm)
    }
    /* The dashed outline is what carries "not recognised" in greyscale. */
    expect(markup).toContain("border-dashed")
  })
})

describe("parse_error is normal input", () => {
  test("it reads as a note, keeps the line, and is not red", async () => {
    const line = '{"type":"assistant","message":{"content":[{"type":"text","te'
    const mounted = await mount(
      <api.Stream rows={[eventRow("p", { kind: "parse_error", line, error: "Unexpected end of JSON input" })]} />,
    )

    const row = mounted.row("p")
    expect(row?.textContent).toContain("One line wasn't JSON, so it's kept as plain text.")
    for (const alarm of ["text-fail", "bg-fail", "attention"]) {
      expect(row?.outerHTML ?? "").not.toContain(alarm)
    }

    const button = row?.querySelector("button")
    if (button instanceof HTMLElement) await click(button)
    const open = mounted.row("p")?.textContent ?? ""
    expect(open).toContain(line)
    expect(open).toContain("Unexpected end of JSON input")
  })

  test("a line too long to draw says how much it is not showing", async () => {
    const line = "x".repeat(300_000)
    const mounted = await mount(<api.Stream rows={[eventRow("p", { kind: "parse_error", line, error: "boom" })]} />)
    const button = mounted.row("p")?.querySelector("button")
    if (button instanceof HTMLElement) await click(button)

    const text = mounted.row("p")?.textContent ?? ""
    expect(text.length).toBeLessThan(40_000)
    expect(text).toContain("more characters are in the run log, not shown here")
  })
})

describe("a result explains itself even when the CLI said nothing", () => {
  test("the budget-exhausted fixture has no result text, and its reason lives in errors", () => {
    const result = fixtureEvents("budget-exhausted.jsonl").find((e) => e.kind === "result")
    expect(result?.kind).toBe("result")
    if (result?.kind !== "result") return

    /* Absent, not empty. This is the distinction `src/stream.ts` preserves. */
    expect(result.text).toBeUndefined()
    expect(result.subtype).toBe("error_max_budget_usd")
    expect(result.isError).toBe(true)

    expect(fixtureResultLine("budget-exhausted.jsonl").errors).toEqual(["Reached maximum budget ($0.0001)"])
  })

  test("the row prints that reason", async () => {
    const result = fixtureEvents("budget-exhausted.jsonl").find((e) => e.kind === "result")
    if (result?.kind !== "result") throw new Error("the fixture lost its result event")
    const errors = fixtureResultLine("budget-exhausted.jsonl").errors

    const mounted = await mount(<api.Stream rows={[eventRow("r", result, { errors })]} />)
    const text = mounted.row("r")?.textContent ?? ""

    expect(text).toContain("Reached maximum budget ($0.0001)")
    /* And the CLI's own name for the outcome, which is never paraphrased. */
    expect(text).toContain("error_max_budget_usd")
  })

  const texts: [string, string | undefined][] = [
    ["absent", undefined],
    ["the empty string", ""],
    ["whitespace", "   "],
    ["prose", "Wrote the mapper and the test."],
  ]
  const errorSets: [string, unknown][] = [
    ["absent", undefined],
    ["null", null],
    ["an empty array", []],
    ["one string", ["Reached maximum budget ($0.0001)"]],
    ["several strings", ["first reason", "second reason"]],
    ["non-strings", [{ code: 7 }, 42]],
    ["a bare string", "a single reason"],
    ["a number", 42],
  ]

  /**
   * What a reader should be able to find on the row, restated here rather than
   * imported, so the test is an independent claim about `errors` and not an
   * echo of the renderer.
   */
  function fragmentOf(errors: unknown): string | undefined {
    if (typeof errors === "string") return errors === "" ? undefined : errors
    if (Array.isArray(errors)) {
      if (errors.length === 0) return undefined
      const [first] = errors
      return typeof first === "string" ? first : JSON.stringify(first)
    }
    if (errors === undefined || errors === null) return undefined
    return JSON.stringify(errors)
  }

  for (const [textName, text] of texts) {
    for (const [errorName, errors] of errorSets) {
      test(`text ${textName} with errors ${errorName} still says something`, async () => {
        const event: Event = {
          kind: "result",
          subtype: "error_max_budget_usd",
          isError: true,
          costUsd: 0.0046,
          numTurns: 1,
          text,
          permissionDenials: [],
        }
        const mounted = await mount(<api.Stream rows={[eventRow("r", event, { errors })]} />)
        const row = mounted.row("r")
        expect(row).not.toBeNull()

        const shown = (row?.textContent ?? "").trim()
        /* The floor: a failure row is never blank, and always carries the
         * subtype and the cost whatever the prose turned out to be. */
        expect(shown.length).toBeGreaterThan(20)
        expect(shown).toContain("error_max_budget_usd")
        expect(shown).toContain("$0.0046")

        const fragment = fragmentOf(errors)
        if (text !== undefined && text.trim() !== "") expect(shown).toContain(text.trim())
        else if (fragment !== undefined) expect(shown).toContain(fragment)
        else expect(shown).toContain("The run ended without the CLI saying why.")
      })
    }
  }
})

describe("exit codes are printed, never paraphrased", () => {
  /* `src/testrun.ts` reports the command's own code, 124 for a timeout and
   * 128 + signal for a death by signal. Every one of them is a number a human
   * can look up, so every one of them is printed as itself. */
  for (const code of [0, 1, 2, 124, 127, 139, 255]) {
    test(`exit ${code} is printed as the number ${code}`, async () => {
      const mounted = await mount(
        <api.Stream rows={[{ id: "t", at: Date.now(), tests: { exitCode: code, attempt: 3, summary: "10 passing, 1 failing" } }]} />,
      )
      const text = mounted.row("t")?.textContent ?? ""
      expect(text).toContain(`exit ${code}`)
      expect(text).toContain("read by kantan")

      for (const paraphrase of ["looks good", "all good", "seems to pass", "success!"]) {
        expect(text.toLowerCase()).not.toContain(paraphrase)
      }
    })
  }

  test("a pass reads as exit 0, not as a word", async () => {
    const mounted = await mount(<api.Stream rows={[{ id: "t", tests: { exitCode: 0, attempt: 7 } }]} />)
    const chip = [...(mounted.row("t")?.querySelectorAll("span") ?? [])].find((el) => /^exit \d+$/.test(el.textContent ?? ""))
    expect(chip?.textContent).toBe("exit 0")
  })
})

describe("a rate-limit row reads the figure the way it arrives", () => {
  /*
   * `utilization` is a **0–1 fraction**: `src/stream.ts` passes through
   * whatever `unifiedWindows[rateLimitType].utilization` held, the fixtures
   * carry 0.41 and 0.22, and `test/stream.test.ts` asserts 0.88 for a
   * `seven_day` window. The row was rounding it without multiplying, so a
   * window at 41% read "0% of the window used" — a wrong number, printed
   * confidently, in the one region whose job is to be believed.
   *
   * The dimension is the fraction, enumerated across the range rather than at
   * the one value a fixture happens to hold: both ends, a value that rounds
   * down to zero but is not zero, and the two non-numbers the type allows.
   */
  const windows: [number | undefined, string][] = [
    [0, "0% of the window used"],
    [0.004, "0% of the window used"],
    [0.41, "41% of the window used"],
    [0.885, "89% of the window used"],
    [1, "100% of the window used"],
    [undefined, "the window's utilisation was not reported"],
    [Number.NaN, "the window's utilisation was not reported"],
  ]

  for (const [utilization, expected] of windows) {
    test(`${String(utilization)} reads as "${expected}"`, async () => {
      const mounted = await mount(
        <api.Stream rows={[eventRow("l", { kind: "rate_limit", status: "allowed", utilization })]} />,
      )
      expect(mounted.row("l")?.textContent).toContain(expected)
    })
  }

  test("it does not claim to know which window this is", async () => {
    /*
     * `src/stream.ts` reads whichever window `rateLimitType` names and then
     * drops the name, so a `seven_day` window arrives here indistinguishable
     * from a `five_hour` one. The artboard writes "the 5-hour window" because
     * it drew a five-hour case; a row that copied that wording would relabel
     * every weekly window as an hourly one.
     */
    const mounted = await mount(
      <api.Stream rows={[eventRow("l", { kind: "rate_limit", status: "allowed", utilization: 0.88 })]} />,
    )
    const text = mounted.row("l")?.textContent ?? ""
    expect(text).toContain("88% of the window used")
    expect(text).not.toContain("5-hour")
    expect(text).not.toContain("seven")
  })
})

describe("an edit prints what went and what came", () => {
  /*
   * `Return.dc.html` puts `+2 −1` beside an edit's path. The counts come from
   * the same `markLines` pass that tints the before/after panel, so the two
   * cannot disagree — and the case worth pinning is the one where a naive
   * count is wrong: `Edit` with an empty `old_string` is a pure insertion, and
   * splitting "" yields one line, which would print a removal that never
   * happened.
   */
  const edits: [string, string, string, (text: string) => void][] = [
    [
      "a replacement",
      "const a = 1;\nreturn a;",
      "const a = 1;\nconst b = 2;\nreturn a + b;",
      (text) => {
        expect(text).toContain("+2")
        expect(text).toContain("−1")
      },
    ],
    [
      "a pure insertion",
      "",
      "const b = 2;\nconst c = 3;",
      (text) => {
        expect(text).toContain("+2")
        expect(text).not.toContain("−")
      },
    ],
    [
      "a pure deletion",
      "const gone = 1;",
      "",
      (text) => {
        expect(text).toContain("−1")
        expect(text).not.toContain("+")
      },
    ],
    [
      "no change at all",
      "const same = 1;",
      "const same = 1;",
      (text) => {
        expect(text).not.toContain("+")
        expect(text).not.toContain("−")
      },
    ],
  ]

  for (const [name, before, after, check] of edits) {
    test(`${name} is counted as it happened`, async () => {
      const mounted = await mount(
        <api.Stream
          rows={[
            eventRow("e", {
              kind: "tool_use",
              id: "t",
              name: "Edit",
              input: { file_path: "src/importer/map.ts", old_string: before, new_string: after },
            }),
          ]}
        />,
      )
      const text = mounted.row("e")?.textContent ?? ""
      expect(text).toContain("src/importer/map.ts")
      check(text)
    })
  }
})

describe("only new rows animate", () => {
  /**
   * Is this element playing the artboards' entrance?
   *
   * `bf` is `src/ui/artboard.css`'s blur fade — `kfade`, the same ten pixels
   * out of the same six-pixel blur the artboards use — and the component adds
   * it to a row only the first time it draws one.
   *
   * This used to read Motion's inline `opacity: 0`, because the entrance used
   * to be a Motion spring. `src/ui/Row.tsx` says why it is CSS now; the short
   * version is that cancelling a WAAPI animation rejects a promise nothing
   * catches, and a virtualized row scrolling out mid-fade cancels one.
   *
   * What is asserted narrowed with it, and this is the honest statement of how
   * far: the class is checked, not the animation. No stylesheet is loaded here
   * — the header says so about the wrapping rules too — so `.bf` could be
   * deleted from `artboard.css` and this file would not notice. What it still
   * catches is every mutation on *this* side of that line, which is where the
   * behaviour lives: drop the `enter` gate and rows re-animate on the way back
   * up the log, drop the reduced-motion gate and they animate for someone who
   * asked them not to. Both fail here. That the class then really animates is
   * checked in a browser, with `document.getAnimations()`.
   */
  function fading(el: HTMLElement | null): boolean {
    return el?.classList.contains("bf") ?? false
  }

  test("nothing in the log animates on the way in", async () => {
    const mounted = await mount(<api.Stream rows={syntheticLog(60)} />)
    for (const row of mounted.rows()) {
      expect(row.getAttribute("data-enter")).toBe("false")
      expect(fading(row)).toBe(false)
    }
  })

  test("an arrival animates, once, and not again when it is scrolled back", async () => {
    const rows = syntheticLog(60)
    const mounted = await mount(<api.Stream rows={rows} />)
    await mounted.scrollToBottom()

    const arrived: StreamRow[] = [
      ...rows,
      eventRow("fresh", { kind: "tool_use", id: "tf", name: "Bash", input: { command: "npm test" } }, { at: Date.now() }),
    ]
    await mounted.update(<api.Stream rows={arrived} />)

    // 1. It entered.
    const first = mounted.row("fresh")
    expect(first).not.toBeNull()
    expect(first?.getAttribute("data-enter")).toBe("true")
    expect(fading(first)).toBe(true)

    // 2. Nothing that was already there entered with it.
    for (const row of mounted.rows()) {
      if (row.getAttribute("data-row-id") === "fresh") continue
      expect(row.getAttribute("data-enter")).toBe("false")
    }

    // 3. It really leaves the DOM. Without this the next step proves nothing.
    await mounted.scrollTo(0)
    expect(mounted.row("fresh")).toBeNull()

    // 4. Coming back it is a new element, and it does not animate again.
    await mounted.scrollToBottom()
    const second = mounted.row("fresh")
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
    expect(second?.getAttribute("data-enter")).toBe("false")
    expect(fading(second)).toBe(false)
  })

  test("a history row's first ever appearance does not animate either", async () => {
    const mounted = await mount(<api.Stream rows={syntheticLog(10_000)} />)
    /* e0 has never been rendered: the record opened at the bottom. */
    expect(mounted.row("e0")).toBeNull()

    await mounted.scrollTo(0)
    const row = mounted.row("e0")
    expect(row).not.toBeNull()
    expect(row?.getAttribute("data-enter")).toBe("false")
    expect(fading(row)).toBe(false)
  })

  test("expanding a row does not restart its fade", async () => {
    const rows = syntheticLog(20)
    const mounted = await mount(<api.Stream rows={rows} />)
    const arrived = [...rows, eventRow("fresh", { kind: "text", text: "a".repeat(400) }, { at: Date.now() })]
    await mounted.update(<api.Stream rows={arrived} />)

    const button = mounted.row("fresh")?.querySelector("button")
    if (button instanceof HTMLElement) await click(button)

    /* Still latched to the single entry it was mounted with. */
    expect(mounted.row("fresh")?.getAttribute("data-enter")).toBe("true")

    /* And a second arrival after it does not re-enter the first. */
    await mounted.update(
      <api.Stream rows={[...arrived, eventRow("fresher", { kind: "thinking", length: 10 }, { at: Date.now() })]} />,
    )
    expect(mounted.row("fresher")?.getAttribute("data-enter")).toBe("true")
  })

  /*
   * The three tests below are the real delivery path, not a convenience: the
   * run stream replays the whole log from byte 0 on every connect, unbatched
   * and with no marker between the replay and the live tail, so a caller that
   * mounts this empty and fills it has no boundary to declare.
   */

  test("a log that arrives after mount settles into history, and a later arrival still animates", async () => {
    const mounted = await mount(<api.Stream rows={[]} />)
    expect(mounted.rows()).toHaveLength(0)

    /* Sixty records in one update — the shape a caller gets if it coalesces the
     * replay, which the server's own comment suggests it should. */
    const replayed = syntheticLog(60)
    await mounted.update(<api.Stream rows={replayed} />)
    expect(mounted.rows().length).toBeGreaterThan(4)

    /*
     * The guarantee: once drawn, they are history. Away and back is silent,
     * whatever happened on the way in.
     *
     * Note what is deliberately *not* asserted. A batch this size moves the
     * scroll far enough that following lands the viewer past the window that
     * animated, in a commit after the one that absorbed those ids — so some of
     * the rows finally on screen will not have faded in. That is the asymmetry
     * this component chooses: a fade that did not happen, never one that
     * happened twice. The incremental case below is the one a live run
     * actually produces, and it does animate.
     */
    await mounted.scrollTo(0)
    await mounted.scrollToBottom()
    for (const row of mounted.rows()) expect(row.getAttribute("data-enter")).toBe("false")

    /* One more record, the way the stream delivers them: unbatched. */
    await mounted.update(
      <api.Stream rows={[...replayed, eventRow("live", { kind: "thinking", length: 12 }, { at: Date.now() })]} />,
    )
    expect(mounted.row("live")?.getAttribute("data-enter")).toBe("true")
  })

  test("a reconnect re-delivers every record, and deterministic ids keep it silent", async () => {
    const mounted = await mount(<api.Stream rows={[]} />)
    const replayed = syntheticLog(60)
    await mounted.update(<api.Stream rows={replayed} />)

    /* What a reconnect produces: the same bytes, rebuilt into a new array, so
     * the same ids in the same order — plus whatever happened meanwhile. */
    const reconnected = [
      ...syntheticLog(60),
      eventRow("e60", { kind: "tool_use", id: "t60", name: "Bash", input: { command: "npm test" } }, { at: Date.now() }),
    ]
    expect(reconnected.map((row) => row.id).slice(0, 60)).toEqual(replayed.map((row) => row.id))

    await mounted.update(<api.Stream rows={reconnected} />)

    for (const row of mounted.rows()) {
      const id = row.getAttribute("data-row-id")
      expect(row.getAttribute("data-enter")).toBe(id === "e60" ? "true" : "false")
    }
  })

  test("an expanded row survives a reconnect, and does not survive reminted ids", async () => {
    /*
     * The cost of breaking the id contract, in the one place it is impossible
     * to argue with. Everything this component remembers about a row — that it
     * has already animated, that it is expanded, how tall it measured — is
     * keyed on the id. Mint a new one for the same log line and all three go.
     */
    const log = syntheticLog(40)
    const expanded = log[8]
    if (!expanded) throw new Error("the synthetic log is too short")

    const mounted = await mount(<api.Stream rows={log} />)
    await mounted.scrollTo(0)
    const button = mounted.row(expanded.id)?.querySelector("button")
    expect(button).not.toBeNull()
    if (button instanceof HTMLElement) await click(button)
    expect(mounted.row(expanded.id)?.querySelector("button")?.getAttribute("aria-expanded")).toBe("true")

    // A reconnect: the same bytes, a new array, the same ids.
    await mounted.update(<api.Stream rows={syntheticLog(40)} />)
    await mounted.scrollTo(0)
    expect(mounted.row(expanded.id)?.querySelector("button")?.getAttribute("aria-expanded")).toBe("true")

    // The same records under ids minted per delivery.
    const reminted = syntheticLog(40).map((row) => ({ ...row, id: `delivery2-${row.id}` }))
    await mounted.update(<api.Stream rows={reminted} />)
    await mounted.scrollTo(0)
    expect(mounted.row(expanded.id)).toBeNull()
    for (const row of mounted.rows()) {
      expect(row.querySelector("button")?.getAttribute("aria-expanded") ?? "false").toBe("false")
    }
  })

  test("reduced motion stops the fade, which MotionConfig alone does not", async () => {
    setPrefersReduce(true)

    const rows = syntheticLog(20)
    const mounted = await mount(
      <>
        <api.Stream rows={rows} />
        {/* The control, under the same `reducedMotion="user"` this app sets in
            main.tsx. Motion drops the transform and keeps opacity and filter,
            which is why the component has to gate the fade itself. */}
        <api.motion.div
          data-control
          initial={{ opacity: 0, y: 10, filter: "blur(6px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ duration: 0.7 }}
        />
      </>,
    )

    const control = mounted.host.querySelector("[data-control]")
    const controlStyle = control?.getAttribute("style") ?? ""
    /*
     * The control is still fading. `MotionConfig reducedMotion="user"` is
     * documented to drop transform animations and to leave opacity and filter
     * alone, and opacity and filter are most of a blur fade — so even at its
     * best it would not have stopped this.
     *
     * In this process it does less than that: the transform survives too,
     * because `reducedMotion="user"` resolves the preference through the same
     * module-level singleton `useReducedMotion` uses, and a sibling UI test
     * file imported Motion and initialised it before this file could say what
     * the preference was. Which is the whole argument for the component reading
     * the query itself: a gate you delegate is a gate you do not own.
     */
    expect(controlStyle).toMatch(/opacity:\s*0(\.\d+)?\s*;/)
    expect(controlStyle).toMatch(/filter:\s*blur\(/)

    const arrived = [...rows, eventRow("fresh", { kind: "thinking_tokens", tokens: 4200, delta: 180 }, { at: Date.now() })]
    await mounted.update(
      <>
        <api.Stream rows={arrived} />
        <api.motion.div data-control />
      </>,
    )

    const fresh = mounted.row("fresh")
    expect(fresh).not.toBeNull()
    expect(fresh?.getAttribute("data-enter")).toBe("false")
    expect(fading(fresh)).toBe(false)

    /* The card's own opening fade is gated by the same preference. */
    const card = mounted.host.querySelector("section")
    expect(fading(card instanceof HTMLElement ? card : null)).toBe(false)
  })
})

describe("every event kind draws something", () => {
  const at = Date.UTC(2026, 9, 11, 17, 55, 41)
  const samples: [string, StreamRow][] = [
    ["init", eventRow("1", { kind: "init", cwd: "/home/you/code/your-app", tools: 18, skills: 4, sessionId: "8e7b9ce0" }, { at })],
    ["text", eventRow("2", { kind: "text", text: "I will drop unknown fields." }, { at })],
    ["text, empty", eventRow("2b", { kind: "text", text: "" }, { at })],
    ["thinking", eventRow("3", { kind: "thinking", length: 1284 }, { at })],
    ["thinking_tokens", eventRow("4", { kind: "thinking_tokens", tokens: 4200, delta: 180 }, { at })],
    ["tool_use, Bash", eventRow("5", { kind: "tool_use", id: "t", name: "Bash", input: { command: "npm test" } }, { at })],
    ["tool_use, an unknown tool", eventRow("6", { kind: "tool_use", id: "t", name: "mcp__future__thing", input: { who: "knows" } }, { at })],
    ["tool_use, no name at all", eventRow("7", { kind: "tool_use", id: "t", name: "", input: null }, { at })],
    ["tool_use, Read with no path", eventRow("8", { kind: "tool_use", id: "t", name: "Read", input: { offset: 4 } }, { at })],
    ["tool_use, Read with a non-string path", eventRow("9", { kind: "tool_use", id: "t", name: "Read", input: { file_path: 42 } }, { at })],
    ["tool_use, input is a string", eventRow("10", { kind: "tool_use", id: "t", name: "Edit", input: "not an object" }, { at })],
    ["tool_result", eventRow("11", { kind: "tool_result", toolUseId: "t", content: "10 passing", isError: false }, { at })],
    ["tool_result, empty", eventRow("12", { kind: "tool_result", toolUseId: "t", content: "", isError: false }, { at })],
    ["tool_result, error", eventRow("13", { kind: "tool_result", toolUseId: "t", content: "ENOENT", isError: true }, { at })],
    ["rate_limit", eventRow("14", { kind: "rate_limit", status: "allowed", utilization: 41 }, { at })],
    ["rate_limit, no utilization", eventRow("15", { kind: "rate_limit", status: "allowed_warning", utilization: undefined }, { at })],
    ["rate_limit, no status", eventRow("16", { kind: "rate_limit", status: "", utilization: 0 }, { at })],
    ["result, success", eventRow("17", { kind: "result", subtype: "success", isError: false, costUsd: 0.0046, numTurns: 7, text: "Done.", permissionDenials: [] }, { at })],
    ["result, denials", eventRow("18", { kind: "result", subtype: "success", isError: false, costUsd: 0.0046, numTurns: 7, text: "Done.", permissionDenials: [{ tool: "Bash" }] }, { at })],
    ["unknown", eventRow("19", { kind: "unknown", raw: { type: "future" } }, { at })],
    ["parse_error", eventRow("20", { kind: "parse_error", line: "half a line", error: "boom" }, { at })],
    ["tests", { id: "21", at, tests: { exitCode: 1, attempt: 2, summary: "10 passing, 1 failing" } }],
    ["a row with no clock", eventRow("22", { kind: "thinking", length: 3 })],
  ]

  for (const [name, row] of samples) {
    test(`${name} is not a blank row`, async () => {
      const mounted = await mount(<api.Stream rows={[row]} />)
      const el = mounted.row(row.id)
      expect(el).not.toBeNull()

      const text = (el?.textContent ?? "").trim()
      /* The label alone would pass a "non-empty" check, so require more than
       * the label: a row that draws its icon and its label and nothing else is
       * exactly the silent failure this suite exists to catch. */
      expect(text.length).toBeGreaterThan(8)
      expect(el?.querySelector("svg")).not.toBeNull()
    })
  }

  test("an unknown tool keeps its name and its whole input", async () => {
    const input = { who: "knows", nested: { deep: [1, 2, 3] } }
    const mounted = await mount(
      <api.Stream rows={[eventRow("x", { kind: "tool_use", id: "t", name: "mcp__future__thing", input })]} />,
    )
    const text = mounted.row("x")?.textContent ?? ""
    expect(text).toContain("mcp__future__thing")
    expect(text).toContain("knows")
  })

  test("an Edit shows what went and what came", async () => {
    const mounted = await mount(
      <api.Stream
        rows={[
          eventRow("e", {
            kind: "tool_use",
            id: "t",
            name: "Edit",
            input: {
              file_path: "src/importer/map.ts",
              old_string: "const keys = Object.keys(rest);\nreturn { id, name, tags };",
              new_string: "const keys = Object.keys(rest);\nconst unique = [...new Set(tags)];\nreturn { id, name, tags: unique };",
            },
          }),
        ]}
      />,
    )

    const button = mounted.row("e")?.querySelector("button")
    if (button instanceof HTMLElement) await click(button)

    const text = mounted.row("e")?.textContent ?? ""
    expect(text).toContain("Before")
    expect(text).toContain("After")
    expect(text).toContain("const unique = [...new Set(tags)];")
    /* The unchanged line is context on both sides, not a change on either. */
    expect(text).toContain("const keys = Object.keys(rest);")
  })
})

describe("the record's own chrome", () => {
  test("it follows by default, and an upward scroll stops it", async () => {
    const mounted = await mount(<api.Stream rows={syntheticLog(500)} />)
    const button = [...mounted.host.querySelectorAll("button")].find((el) => /Follow/.test(el.textContent ?? ""))
    expect(button?.textContent).toContain("Following")

    await mounted.scrollTo(0)
    const after = [...mounted.host.querySelectorAll("button")].find((el) => /Follow/.test(el.textContent ?? ""))
    expect(after?.textContent).toContain("Follow")
    expect(after?.textContent).not.toContain("Following")
  })

  test("an empty log says so without breaking", async () => {
    const mounted = await mount(<api.Stream rows={[]} />)
    expect(mounted.host.textContent).toContain("0 events")
    expect(mounted.rows()).toHaveLength(0)
  })

  test("the footer the caller supplies sits below the last row", async () => {
    const mounted = await mount(
      <api.Stream rows={syntheticLog(30)} footer={<div data-footer>Gate · run paused until you decide</div>} />,
    )
    const footer = mounted.host.querySelector("[data-footer]")
    expect(footer).not.toBeNull()
    expect(mounted.viewport.contains(footer)).toBe(true)
  })

  test("the scroller is reachable from the keyboard and named", async () => {
    const mounted = await mount(<api.Stream rows={syntheticLog(30)} />)
    expect(mounted.viewport.getAttribute("tabindex")).toBe("0")
    expect(mounted.viewport.getAttribute("aria-label")).toContain("Run record")
  })

  test("the record is a log, and never announces a row the scroller merely reached", async () => {
    /*
     * `role="log"` is the pattern for an appended record, and it is the right
     * identity for this region. Its implicit `aria-live="polite"` is wrong
     * here, though, and the override is not timidity: rows are **virtualized**,
     * so scrolling back mounts old rows as if they had just arrived, and the
     * SSE replays the whole log from byte 0 on every reconnect with no
     * replay-versus-live marker. A polite live region would read a reconnect
     * out loud as a thousand new events. The states worth announcing - the
     * gate, a failed suite - are `role="status"` and `role="alert"` where they
     * belong, in the gate and the rail.
     */
    const mounted = await mount(<api.Stream rows={syntheticLog(30)} />)
    expect(mounted.viewport.getAttribute("role")).toBe("log")
    expect(mounted.viewport.getAttribute("aria-live")).toBe("off")
  })

  test("every control in the record says where the keyboard is", async () => {
    /*
     * A completeness check, not a rendering one: Tailwind's compiler does not
     * run under `bun test`, so what can be proved here is that no focusable
     * element is *missing* a focus style - which is the defect that actually
     * ships. That the ring is then visible and legible is checked in a real
     * browser, because no DOM assertion can see it.
     */
    const mounted = await mount(<api.Stream rows={syntheticLog(60)} />)
    const focusable = [
      ...mounted.host.querySelectorAll<HTMLElement>(
        'a[href], button, textarea, input, select, [tabindex]:not([tabindex="-1"])',
      ),
    ]
    expect(focusable.length).toBeGreaterThan(2)
    const unringed = focusable.filter((el) => !/\bfocus-visible:/.test(el.className))
    expect(unringed.map((el) => `${el.tagName.toLowerCase()}: ${el.className}`)).toEqual([])
  })
})
