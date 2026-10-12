/**
 * The page chrome: the app bar, the breadcrumb, and the one writer of the tab's
 * title and favicon.
 *
 * `docs/design/Main.dc.html` is the specification — the header at line 54, the
 * breadcrumb at line 137. The other four artboards draw the same two regions
 * unchanged, so there is no state dimension here: neither component animates on
 * any artboard, and neither has a mood.
 *
 * ## What is actually at risk in these three exports
 *
 * **The origin chip is the one value on the page that cannot come from the
 * page.** The UI is served by Vite in development and by Bun in production, so
 * `window.location` names the wrong port exactly when the chip matters — a
 * second tab needs to find *kantan*, not the dev server. So one test spies on
 * the `location` getter and asserts it is never read.
 *
 * **The breadcrumb's three crumbs are strings a human chose.** A project path, a
 * feature-file path and a task's own sentence. The artboard prints `importer.md`
 * for a file that is really `docs/features/importer.md`, and that shortening is
 * deliberately *not* ported: `src/runindex.ts` keys a task on
 * (`projectPath`, `featureFile`, `taskRef`) precisely because two feature files
 * in one repo can share a basename, so a breadcrumb that printed the basename
 * would name two different tasks identically. DESIGN.md's third promise - paths
 * over 150 characters wrap, never overflow or truncate invisibly - is tested
 * here against a real 164-character path.
 *
 * **The title and the favicon are the whole unattended-run mechanism**, and a
 * wrong answer is not symmetric. A missed "needs you" is the failure the product
 * exists to prevent; a spurious one costs a glance. But a *permanent* spurious
 * one costs the signal itself, so the enumeration matrix below pins every cell
 * rather than picking a direction and hoping.
 *
 * And `src/ui/Digest.tsx`'s `ReturnBand` reads the same `needsYou` count to
 * decide whether to claim "Nothing needs you". If the two readings drift, the
 * band and the tab contradict each other on one screen. The last test here
 * renders both and asserts they never do.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"

/* Type-only, so none of these survive compilation. `src/runindex.ts` opens
 * files at module scope and has no business in a browser bundle; the other two
 * are borrowed so a change to either becomes a compile error here rather than a
 * chrome that renders something else. */
import type { RunState } from "../../src/runindex.ts"
import type { WaitReason } from "../../src/runlog.ts"
import type { DigestSubject } from "../../src/ui/Digest.tsx"
import type { Account } from "../../src/ui/Tree.tsx"

/*
 * `bun test` runs every file in one process and `register()` throws on a second
 * call (docs/HANDOFF.md), so the document is taken only if the slot is free.
 * Static imports hoist above that call, so everything that senses a DOM is
 * pulled in dynamically below: `motion-dom` decides `isBrowser` at module
 * evaluation, and `Chrome.tsx` imports `motion/react`.
 *
 * ## It is taken and never given back, which is a correction to that pattern
 *
 * docs/HANDOFF.md says to `unregister()` only what you took, and this file did,
 * and that was still wrong. Probed - two throwaway suites, each logging from
 * module scope, `beforeAll`, its test body and `afterAll`, run as
 * `bun test a.test.ts b.test.ts`, print all four of A's lines before B's module
 * scope - `bun test` loads and runs one file at a
 * time, so this file's `beforeAll` wins the slot, and an `unregister()` in its
 * `afterAll` closes that window before `test/ui/Sidebar.test.tsx` has even been
 * loaded. Sidebar then registers a **second** window — while `motion`, already
 * imported and already seeded, holds the first one's media query and timing
 * primitives in module-level state that nothing can re-seed. Sidebar's cost
 * ticker then never advances, and its "the ticker really does count" test fails
 * with `$0.42` against `$3.18`: a failure in a component that is fine, in
 * another agent's file, with nothing wrong in either copy of the code.
 *
 * Verified by experiment, three ways: removing the `unregister()` makes the
 * pair pass, removing this file's clock patching does not, and removing its
 * `matchMedia` stub does not.
 *
 * So the window is created once and left standing for the life of the process.
 * The cost is one window alive at exit, when the process is ending anyway.
 *
 * The other four UI suites still unregister. They get away with it only because
 * none of them currently runs before a sibling that animates - which is a
 * property of today's file order, not of their code. Reported, not touched.
 */
/** Whether this file is the one that created the window. Read only by the
 * note above: nothing unregisters it. Kept because a later reader checking
 * whether this file owns the teardown needs the answer to be visible. */
let ownsDocument = false

interface Api {
  act: typeof import("react").act
  StrictMode: typeof import("react").StrictMode
  createRoot: typeof import("react-dom/client").createRoot
  AppBar: typeof import("../../src/ui/Chrome.tsx").AppBar
  Breadcrumb: typeof import("../../src/ui/Chrome.tsx").Breadcrumb
  NeedsYouBand: typeof import("../../src/ui/Chrome.tsx").NeedsYouBand
  usePageAttention: typeof import("../../src/ui/Chrome.tsx").usePageAttention
  ReturnBand: typeof import("../../src/ui/Digest.tsx").ReturnBand
}

// --- The reduced-motion media feature, and the clock ------------------------

/**
 * A `matchMedia` that this file drives, installed over happy-dom's.
 *
 * The band's slide and its pulse are gated in JS, which `CLAUDE.md` requires
 * and `src/ui/artboard.css` confirms from the other side: its own
 * `prefers-reduced-motion` block is scoped to `.kr`, so an ancestor without
 * that class suppresses nothing, and a Motion animation would ignore the CSS
 * either way.
 *
 * ## Two query objects, and the split is not cosmetic
 *
 * `bun test` runs every file in one process, and Motion keeps its
 * reduced-motion answer in a **module-level singleton seeded at the first call
 * anywhere in that process** — the trap `CLAUDE.md` records. It seeds that
 * singleton from `matchMedia("(prefers-reduced-motion)")` and then keeps it up
 * to date from that query's own `change` events.
 *
 * A stub that matched the feature loosely would therefore hand Motion the same
 * object this file toggles, and every `setPrefersReduce(true)` here would reach
 * into Motion's process-wide state and stay there. The loose form was written
 * first and did exactly that: `motion` printed "You have Reduced Motion enabled
 * on your device" into this file's output, which is it reporting a singleton
 * this file had moved.
 *
 * It was **not**, however, the cause of the sibling failure described on
 * `ownsDocument` — that was the `unregister()`, and the experiment there
 * separates the two. This split is a hazard closed on its own merits, not a fix
 * for that bug.
 *
 * So the two queries are kept apart by their exact strings. The component asks
 * `(prefers-reduced-motion: reduce)` and gets the object below. Motion asks
 * `(prefers-reduced-motion)` and gets a quarantined one that is always `false`
 * and whose listeners are never fired, so its singleton is seeded `false` once
 * and never moves again.
 *
 * That has a consequence worth stating: in here, Motion's half of the
 * component's `||` is permanently `false`, so these tests exercise the **live**
 * half. Which is the half that has to work - a Motion answer that cannot be
 * driven from a test is the same Motion answer that answered `false` with the
 * feature set on a real machine, and that is why `CLAUDE.md` says not to trust
 * it on its own.
 *
 * (`test/ui/Stream.test.tsx` matches `/prefers-reduced-motion/` and so still
 * has the loose form. It is harmless only because it runs last today. Reported,
 * not touched: not this file's to change.)
 */
/**
 * The component's query, spelled exactly as `src/ui/Chrome.tsx` spells it.
 *
 * Restated rather than imported. A static import hoists above
 * `GlobalRegistrator.register()`, so it would evaluate `Chrome.tsx` - and
 * `motion-dom` behind it - before there is a `window` and before this stub is
 * installed, which is the trap `test/ui/Stream.test.tsx`'s header documents.
 * If this string ever stops matching, the component's query falls through to
 * `quarantinedQuery` and the reduced-motion tests fail with no clue why, so
 * `reduceQuery.media` is set from it to keep the two spellings together.
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

/** Every `setInterval` this file's renders asked for, and whether it was cleared. */
interface Ticker {
  id: number
  ms: number | undefined
  run: () => void
  cleared: boolean
}
let tickers: Ticker[] = []
/** Monotonic, and never a real timer id: the platform recycles those, and a
 * recycled id would let one `clearInterval` mark the wrong ticker cleared. */
let nextTickerId = 1
let realSetInterval: typeof globalThis.setInterval
let realClearInterval: typeof globalThis.clearInterval
let realNow: () => number
/** What the component sees as `Date.now()`, so a tick is deterministic. */
let fakeNow = 0

let api: Api

beforeAll(async () => {
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register()
    ownsDocument = true
  }
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

  /* The stubs go in before `Chrome.tsx` is pulled in, because `motion-dom`
   * decides `isBrowser` and seeds its reduced-motion singleton at module
   * evaluation (see `test/ui/Stream.test.tsx`'s header). */
  realMatchMedia = window.matchMedia.bind(window)
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    /* Matched on the **exact** string, not on the feature name, so this file's
     * toggles cannot reach `motion`'s process-wide singleton. See "Two query
     * objects" above `REDUCE_QUERY`. */
    value: (query: string) => {
      if (query === REDUCE_QUERY) return reduceQuery
      if (query.includes("prefers-reduced-motion")) return quarantinedQuery
      return realMatchMedia?.(query)
    },
  })

  realSetInterval = globalThis.setInterval
  realClearInterval = globalThis.clearInterval
  realNow = Date.now

  const react = await import("react")
  const client = await import("react-dom/client")
  const chrome = await import("../../src/ui/Chrome.tsx")
  const digest = await import("../../src/ui/Digest.tsx")
  api = {
    act: react.act,
    StrictMode: react.StrictMode,
    createRoot: client.createRoot,
    AppBar: chrome.AppBar,
    Breadcrumb: chrome.Breadcrumb,
    NeedsYouBand: chrome.NeedsYouBand,
    usePageAttention: chrome.usePageAttention,
    ReturnBand: digest.ReturnBand,
  }
})

afterAll(async () => {
  if (realMatchMedia !== undefined) {
    Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: realMatchMedia })
  }
  /* Deliberately **not** `GlobalRegistrator.unregister()`, even though this
   * file may be the one that registered. See the note on `ownsDocument`: the
   * window has to outlive this file, because `motion` is seeded against it and
   * cannot be re-seeded against a replacement. */
  reduceListeners.clear()
})

/**
 * Take over the clock and the interval for one test.
 *
 * Not `jest.useFakeTimers`, which `bun test` does not have here, and not a real
 * one-second wait either: the point of the band's clock is that it ticks from
 * its own timer rather than from arriving data, so the test has to *hold* the
 * timer and fire it.
 */
function captureClock(startAt: number): void {
  fakeNow = startAt
  tickers = []
  Date.now = () => fakeNow
  Object.defineProperty(globalThis, "setInterval", {
    configurable: true,
    writable: true,
    value: ((run: () => void, ms?: number) => {
      /* No real timer is started at all, so nothing can fire on its own while
       * the test is holding the callback. */
      const id = nextTickerId
      nextTickerId += 1
      tickers.push({ id, ms, run, cleared: false })
      return id as unknown as ReturnType<typeof setInterval>
    }) as typeof globalThis.setInterval,
  })
  Object.defineProperty(globalThis, "clearInterval", {
    configurable: true,
    writable: true,
    value: ((id: unknown) => {
      const known = tickers.find((ticker) => ticker.id === id)
      if (known !== undefined) {
        known.cleared = true
        return
      }
      // Not one of ours: a real timer started before the patch went in.
      realClearInterval(id as Parameters<typeof clearInterval>[0])
    }) as typeof globalThis.clearInterval,
  })
}

function releaseClock(): void {
  Date.now = realNow
  Object.defineProperty(globalThis, "setInterval", { configurable: true, writable: true, value: realSetInterval })
  Object.defineProperty(globalThis, "clearInterval", { configurable: true, writable: true, value: realClearInterval })
}

/** Move the fake clock on, then fire every interval the render registered. */
async function tick(byMs: number): Promise<void> {
  fakeNow += byMs
  await api.act(async () => {
    for (const ticker of tickers) if (!ticker.cleared) ticker.run()
  })
}

// --- Rendering --------------------------------------------------------------

let host: HTMLElement
let root: ReturnType<typeof api.createRoot>

/** The page state this file must hand back, since the document is shared. */
let titleBefore = ""

beforeEach(() => {
  titleBefore = document.title
  host = document.createElement("div")
  document.body.append(host)
  root = api.createRoot(host)
})

afterEach(async () => {
  /* The unmount is the statement most likely to throw here - a cleanup that
   * fails, or `act` surfacing a React error - and the document, the clock and
   * the timer are shared with every other file in this process. So the restore
   * is in a `finally`: a test that dies mid-way still hands all of it back
   * rather than leaking a patched `Date.now` into the next file.
   *
   * The order matters too. The unmount runs first, so the component's own
   * `clearInterval` reaches the fake one and marks its ticker cleared, instead
   * of handing a fake id to the real `clearInterval`. */
  try {
    await api.act(async () => {
      root.unmount()
    })
  } finally {
    host.remove()
    releaseClock()
    setPrefersReduce(false)
    /* A failing test can leave the hook's own link behind, and the next file in
     * this process would inherit it. */
    for (const stray of document.head.querySelectorAll("link[data-kantan-attention]")) stray.remove()
    document.title = titleBefore
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

/** The serialised inline style, which is where every artboard value lives. */
function styleOf(selector: string): string {
  return one(selector).getAttribute("style") ?? ""
}

// --- Fixtures ---------------------------------------------------------------

const PERSONAL: Account = { kind: "personal" }
const WORK: Account = { kind: "work" }
const UNKNOWN: Account = { kind: "unknown" }

/** `Main.dc.html`'s own breadcrumb, with the path unshortened. */
const CRUMBS = {
  project: "your-app",
  featureFile: "docs/features/importer.md",
  taskRef: "T2",
  taskText: "Map records to rows",
  account: PERSONAL,
} as const

function subjectOf(state: RunState, over: Partial<DigestSubject> = {}): DigestSubject {
  return { state, taskRef: "T2", title: "Map records to rows", project: "your-app", ...over }
}

function Probe({ subject, needsYou }: { subject: DigestSubject | null; needsYou?: number }) {
  api.usePageAttention({ subject, needsYou })
  return null
}

/** The hook's own favicon link, or `null`. */
function attentionIcon(): HTMLLinkElement | null {
  return document.head.querySelector<HTMLLinkElement>("link[data-kantan-attention]")
}

/* -------------------------------------------------------------------------- */
/* The app bar                                                                */
/* -------------------------------------------------------------------------- */

describe("AppBar", () => {
  test("prints the wordmark and the origin it was handed", async () => {
    await render(<api.AppBar origin="localhost:4317" />)

    expect(one("header").textContent).toContain("kantan")
    expect(one('[data-testid="origin-chip"]').textContent).toBe("localhost:4317")
  })

  test("never reads window.location for the origin", async () => {
    /* The point of the prop. In development the page is on Vite's port and the
     * server is on Bun's, so `window.location` is the one source that is wrong
     * exactly when the chip matters. A spy rather than a value comparison,
     * because a component that read `location` and happened to agree with the
     * prop would pass a value test. */
    const real = window.location
    let consulted = 0
    Object.defineProperty(window, "location", {
      configurable: true,
      get: () => {
        consulted += 1
        return real
      },
    })
    try {
      await render(<api.AppBar origin="localhost:4317" />)
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: real, writable: true })
    }

    expect(consulted).toBe(0)
  })

  test("prints the origin verbatim, scheme and all", async () => {
    /* The caller owns the spelling. Stripping `http://` to match the artboard's
     * `localhost:4317` would be a normalising guard over a dimension - the
     * shape of a URL - with no bound on its values. */
    await render(<api.AppBar origin="http://127.0.0.1:3100" />)

    expect(one('[data-testid="origin-chip"]').textContent).toBe("http://127.0.0.1:3100")
  })

  test("the origin chip is the mono face, as every machine value is", async () => {
    await render(<api.AppBar origin="localhost:4317" />)

    /* `.m` is the artboard's own class, provided by `src/ui/artboard.css`. */
    expect(one('[data-testid="origin-chip"]').className.split(/\s+/)).toContain("m")
  })

  test.each([
    ["a real authority", "localhost:4317", true],
    ["an empty string", "", false],
    ["whitespace only", "   ", false],
    ["absent", undefined, false],
    ["explicitly null", null, false],
  ])("a chip for %s", async (_name, origin: string | null | undefined, expected: boolean) => {
    /* The dimension is the origin string. Its values: an authority, an absolute
     * URL, empty, whitespace, absent, null. A chip shown for a blank value says
     * kantan is at nowhere, and the reader cannot tell that from a styling bug;
     * no chip says plainly that nobody told the page. So blank fails toward
     * silence. */
    await render(<api.AppBar origin={origin} />)

    expect(host.querySelector('[data-testid="origin-chip"]') !== null).toBe(expected)
    // The header itself is never withheld: the wordmark is the page's identity.
    expect(one("header").textContent).toContain("kantan")
  })

  test("the mark is hidden from the accessibility tree and carries the orange dot", async () => {
    await render(<api.AppBar origin="localhost:4317" />)

    const mark = one('[data-testid="mark"]')
    expect(mark.getAttribute("aria-hidden")).toBe("true")
    expect(styleOf('[data-testid="mark"] > span')).toContain("#FF6A1A")
  })
})

/* -------------------------------------------------------------------------- */
/* The breadcrumb                                                             */
/* -------------------------------------------------------------------------- */

describe("Breadcrumb", () => {
  test("reads project, then feature file, then task, in that order", async () => {
    await render(<api.Breadcrumb {...CRUMBS} />)

    const crumbs = [...one("nav").querySelectorAll("[data-crumb]")].map((el) => el.getAttribute("data-crumb"))
    expect(crumbs).toEqual(["project", "feature", "task"])
    expect(one('[data-crumb="project"]').textContent).toBe("your-app")
    expect(one('[data-crumb="task"]').textContent).toBe("T2 · Map records to rows")
    expect(one("nav").getAttribute("aria-label")).toBe("Breadcrumb")
  })

  test("prints the feature file in full, never its basename", async () => {
    /* The artboard prints `importer.md`. Not ported: two feature files in one
     * repo can share a basename, and `src/runindex.ts` keys a task on the whole
     * triple for exactly that reason. */
    await render(<api.Breadcrumb {...CRUMBS} />)

    expect(one('[data-crumb="feature"]').textContent).toBe("docs/features/importer.md")
  })

  test("a 164-character path appears whole and is allowed to wrap", async () => {
    const long = `docs/features/${"deeply-nested-directory/".repeat(5)}a-feature-file-with-a-very-long-name.md`
    expect(long.length).toBeGreaterThan(150)

    await render(<api.Breadcrumb {...CRUMBS} featureFile={long} />)

    const crumb = one('[data-crumb="feature"]')
    expect(crumb.textContent).toBe(long)
    /* DESIGN.md's third promise. happy-dom runs no layout, so this checks the
     * contract that produces the wrap rather than the wrap itself: the breaking
     * rule present, a zero minimum so a flex item may shrink below its content,
     * and nothing that would clip. */
    const style = crumb.getAttribute("style") ?? ""
    expect(style).toContain("overflow-wrap: anywhere")
    expect(style).toContain("min-width: 0")
    expect(style).not.toContain("text-overflow")
    expect(style).not.toContain("nowrap")
  })

  test("prints the task's own sentence verbatim, including non-Latin text", async () => {
    // `Main.dc.html` puts this exact string in the tree, so it is a real case.
    const arabic = "مزامنة البيانات عند عودة الاتصال"
    await render(<api.Breadcrumb {...CRUMBS} taskRef="T2" taskText={arabic} />)

    const crumb = one('[data-crumb="task"]')
    expect(crumb.textContent).toBe(`T2 · ${arabic}`)
    // So a right-to-left sentence is laid out as its own text, not as English.
    expect(crumb.getAttribute("dir")).toBe("auto")
  })

  test.each([
    ["all three", "your-app", "docs/features/importer.md", "T2", 3],
    ["no project", "", "docs/features/importer.md", "T2", 2],
    ["no feature file", "your-app", "", "T2", 2],
    ["no task", "your-app", "docs/features/importer.md", null, 2],
    ["project only", "your-app", "", null, 1],
    ["whitespace project", "   ", "docs/features/importer.md", "T2", 2],
    ["nothing at all", "", "", null, 0],
  ])(
    "drops an absent crumb and its separator: %s",
    async (_name, project: string, featureFile: string, taskRef: string | null, expected: number) => {
      /* The dimension is one crumb's string, and the values are: a path, a
       * blank, whitespace, and - for the task - `null`, which `TaskId.taskRef`
       * really is when no task is selected. A rendered blank crumb leaves a
       * chevron pointing at nothing, which reads as a broken build; dropping it
       * reads as a shorter trail. Blankness is judged on the trimmed string and
       * the untrimmed one is what gets printed. */
      await render(<api.Breadcrumb project={project} featureFile={featureFile} taskRef={taskRef} account={PERSONAL} />)

      const crumbs = one("nav").querySelectorAll("[data-crumb]")
      expect(crumbs.length).toBe(expected)
      // One separator between neighbours, and never a trailing one.
      expect(one("nav").querySelectorAll('[data-separator="true"]').length).toBe(Math.max(0, expected - 1))
    },
  )

  test("a task with no sentence is still named by its ref", async () => {
    await render(<api.Breadcrumb {...CRUMBS} taskText={undefined} />)

    expect(one('[data-crumb="task"]').textContent).toBe("T2")
  })

  test.each([
    ["personal", PERSONAL, "runs as personal", "#E0F2FE", "#075985"],
    ["work", WORK, "runs as work", "#26272D", "#F4F4F6"],
    ["unknown", UNKNOWN, "account unknown", "#F1F1F4", "#5F6370"],
  ])(
    "the account chip for %s",
    async (_name, account: Account, text: string, background: string, colour: string) => {
      /* The dimension is `Account.kind`, whose three values are enumerated here
       * in full. docs/HANDOFF.md: "a silent default of personal is the exact
       * failure the chip exists to prevent", so `unknown` says neither word and
       * wears neither colour. */
      await render(<api.Breadcrumb {...CRUMBS} account={account} />)

      const chip = one('[data-testid="account-chip"]')
      expect(chip.textContent).toBe(text)
      const style = chip.getAttribute("style") ?? ""
      expect(style.toUpperCase()).toContain(background)
      expect(style.toUpperCase()).toContain(colour)
    },
  )

  test("an unknown account never says personal or work", async () => {
    await render(<api.Breadcrumb {...CRUMBS} account={UNKNOWN} />)

    const chip = one('[data-testid="account-chip"]').textContent ?? ""
    expect(chip).not.toContain("personal")
    expect(chip).not.toContain("work")
  })

  test("a labelled account prints its label, not its kind", async () => {
    await render(<api.Breadcrumb {...CRUMBS} account={{ kind: "work", label: "acme" }} />)

    expect(one('[data-testid="account-chip"]').textContent).toBe("runs as acme")
  })

  test("an account kind this build has never heard of reads as unknown", async () => {
    /* A newer writer's value folds to the neutral chip, which is the one
     * direction that cannot claim an account the project does not have. */
    const invented = { kind: "service-account" } as unknown as Account
    await render(<api.Breadcrumb {...CRUMBS} account={invented} />)

    expect(one('[data-testid="account-chip"]').textContent).toBe("account unknown")
  })
})

/* -------------------------------------------------------------------------- */
/* The "Needs you" band                                                       */
/* -------------------------------------------------------------------------- */

describe("NeedsYouBand", () => {
  const BAND = {
    project: "your-app",
    taskRef: "T2",
    taskText: "Map records to rows",
    reason: "gate" as WaitReason,
    startedAtMs: 1_000_000,
  } as const

  test("says Needs you, on solid orange, as a status", async () => {
    await render(<api.NeedsYouBand {...BAND} />)

    const band = one('[data-testid="needs-you-band"]')
    expect(band.getAttribute("role")).toBe("status")
    /* The one colour that pulls the eye, and `DESIGN.md` allows it here only. */
    expect((band.getAttribute("style") ?? "").toUpperCase()).toContain("#FF6A1A")
    expect(one('[data-testid="band-headline"]').textContent).toBe("Needs you")
    // Legible from across the room: the artboard's 28px display weight.
    expect(styleOf('[data-testid="band-headline"]')).toContain("font-size: 28px")
  })

  test("names the project, the ref and the task's own sentence, verbatim", async () => {
    const arabic = "مزامنة البيانات عند عودة الاتصال"
    await render(<api.NeedsYouBand {...BAND} taskText={arabic} />)

    const subject = one('[data-testid="band-subject"]')
    expect(subject.textContent).toContain("your-app")
    expect(subject.textContent).toContain("T2")
    expect(subject.textContent).toContain(arabic)
    expect(subject.getAttribute("dir")).toBe("auto")
  })

  test.each([
    ["gate", "gate", "the plan is ready for review"],
    ["question", "question", "the agent asked a question"],
    ["blocked", "blocked", "it is blocked and cannot go on"],
    ["stalled", "stalled", "the same failure three times"],
  ])("says what it is waiting for: %s", async (_name, reason: string, clause: string) => {
    /* The dimension is `WaitReason` and these are all four of its values
     * (`src/runlog.ts:130`). The artboards supply the first two clauses
     * literally - `Main.dc.html` line 70 and `Question.dc.html` line 59. */
    await render(<api.NeedsYouBand {...BAND} reason={reason as WaitReason} />)

    expect(one('[data-testid="band-subject"]').textContent).toContain(clause)
  })

  test("a reason this build has never heard of loses the clause, not the alarm", async () => {
    /* The fifth value of the dimension: whatever a newer writer puts in a
     * `waiting` record. A clause is a statement about why the run stopped, so
     * guessing one would put a false statement on the loudest element of the
     * page; the headline, the task's name and the clock are all still true, and
     * they are the half that must not be lost. */
    await render(<api.NeedsYouBand {...BAND} reason={"escalation" as WaitReason} />)

    expect(one('[data-testid="band-headline"]').textContent).toBe("Needs you")
    const subject = one('[data-testid="band-subject"]').textContent ?? ""
    expect(subject).toContain("T2")
    expect(subject).not.toContain("—")
    expect(subject).not.toContain("plan is ready")
    expect(one('[data-testid="band-clock"]').textContent).toContain("waiting")
  })

  test.each([
    ["under a minute", 14_000, "waiting 14s"],
    ["the artboard's own reading", 134_000, "waiting 2m 14s"],
    ["a whole number of minutes", 540_000, "waiting 9m"],
    ["an hour and change", 3_900_000, "waiting 1h 5m"],
    ["a whole hour", 3_600_000, "waiting 1h"],
    ["the instant it parked", 0, "waiting 0s"],
  ])("the clock reads %s", async (_name, elapsed: number, expected: string) => {
    /* Both artboards are satisfied exactly: `Main.dc.html` says
     * "waiting 2m 14s" and `Question.dc.html` says "waiting 9m", so a zero
     * component is dropped rather than printed. */
    captureClock(BAND.startedAtMs + elapsed)
    await render(<api.NeedsYouBand {...BAND} />)

    expect(one('[data-testid="band-clock"]').textContent).toBe(expected)
  })

  test("the clock ticks from its own timer, not from arriving data", async () => {
    /* The whole reason the clock is the band's. A run parked at a gate writes
     * nothing to its log for minutes, so a clock driven by incoming records
     * freezes at the last one and quietly understates how long the user has
     * been away - which is the one number this band exists to tell them. */
    captureClock(BAND.startedAtMs + 10_000)
    await render(<api.NeedsYouBand {...BAND} />)
    expect(one('[data-testid="band-clock"]').textContent).toBe("waiting 10s")

    // No new props and no new data: only time passing.
    await tick(65_000)

    expect(one('[data-testid="band-clock"]').textContent).toBe("waiting 1m 15s")
  })

  test("it asks for a one-second tick and gives it back on unmount", async () => {
    captureClock(BAND.startedAtMs)
    await render(<api.NeedsYouBand {...BAND} />)

    const mine = tickers.filter((ticker) => ticker.ms === 1000)
    expect(mine.length).toBe(1)
    expect(mine[0]?.cleared).toBe(false)

    await api.act(async () => {
      root.unmount()
    })

    expect(mine[0]?.cleared).toBe(true)
  })

  test("the clock is hidden from the accessibility tree", async () => {
    /* `role="status"` makes the whole band a live region, so a screen reader
     * reads it again on every mutation. A clock inside it would mean "Needs
     * you, your-app T2, waiting two minutes fifteen seconds" announced once a
     * second, for as long as the run stays parked. */
    await render(<api.NeedsYouBand {...BAND} />)

    expect(one('[data-testid="band-clock"]').getAttribute("aria-hidden")).toBe("true")
  })

  test.each([
    ["not a number", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["negative infinite", Number.NEGATIVE_INFINITY],
  ])("a %s start time prints no clock at all", async (_name, startedAtMs: number) => {
    /* The dimension is `startedAtMs`. Its values: a past instant, this instant,
     * a future one (a clock that disagrees with the server's), and the three
     * non-finite readings a caller can lose a figure to. "waiting NaNs" on the
     * loudest element of the page is worse than no clock, and the reader cannot
     * falsify it either; silence is the cheap direction. */
    captureClock(1_000_000)
    await render(<api.NeedsYouBand {...BAND} startedAtMs={startedAtMs} />)

    expect(host.querySelector('[data-testid="band-clock"]')).toBeNull()
    // The alarm still stands: the clock is the only part that is unknown.
    expect(one('[data-testid="band-headline"]').textContent).toBe("Needs you")
  })

  test("a start time in the future reads as no time at all, never as negative", async () => {
    captureClock(1_000_000)
    await render(<api.NeedsYouBand {...BAND} startedAtMs={1_030_000} />)

    expect(one('[data-testid="band-clock"]').textContent).toBe("waiting 0s")
  })

  test("the slide and the pulse are both gated on prefers-reduced-motion", async () => {
    /* `CLAUDE.md`: Motion's `useReducedMotion()` is a module-level singleton
     * seeded at the first call anywhere in the process and has answered `false`
     * with the feature set, so the component ORs it with a live `matchMedia`
     * read. And `src/ui/artboard.css`'s own reduced-motion block is scoped to
     * `.kr`, so the CSS cannot be relied on by a component that does not know
     * what its ancestors are. */
    setPrefersReduce(true)
    await render(<api.NeedsYouBand {...BAND} />)

    const band = one('[data-testid="needs-you-band"]')
    expect(band.className.split(/\s+/)).not.toContain("band")
    expect(one('[data-testid="band-dot"]').className.split(/\s+/)).not.toContain("pulsed")
    expect(band.getAttribute("data-motion")).toBe("static")
  })

  test("with motion allowed it wears the artboard's own band and pulse classes", async () => {
    setPrefersReduce(false)
    await render(<api.NeedsYouBand {...BAND} />)

    const band = one('[data-testid="needs-you-band"]')
    /* `.band` is `kband` and `.pulsed` is `kpulsed`, both from
     * `src/ui/artboard.css`, which is where the artboards' own keyframes now
     * live. Ported rather than re-derived, so the markup matches the drawing. */
    expect(band.className.split(/\s+/)).toContain("band")
    expect(one('[data-testid="band-dot"]').className.split(/\s+/)).toContain("pulsed")
    expect(band.getAttribute("data-motion")).toBe("animated")
  })

  test("turning the preference on while the page is open stops the movement", async () => {
    setPrefersReduce(false)
    await render(<api.NeedsYouBand {...BAND} />)
    expect(one('[data-testid="needs-you-band"]').getAttribute("data-motion")).toBe("animated")

    /* The case the live read exists for, and the one a cached singleton cannot
     * see: a parked band pulses for as long as the run waits, so this is
     * precisely when a reader is most likely to go and turn the setting on. */
    await api.act(async () => {
      setPrefersReduce(true)
    })

    expect(one('[data-testid="needs-you-band"]').getAttribute("data-motion")).toBe("static")
  })

  test("the dot is hidden from the accessibility tree", async () => {
    await render(<api.NeedsYouBand {...BAND} />)

    expect(one('[data-testid="band-dot"]').getAttribute("aria-hidden")).toBe("true")
  })

  test("a run with no project or sentence is still named by its ref", async () => {
    await render(<api.NeedsYouBand reason="question" startedAtMs={BAND.startedAtMs} taskRef="T7" />)

    const subject = one('[data-testid="band-subject"]').textContent ?? ""
    expect(subject.startsWith("T7")).toBe(true)
    expect(subject).toContain("the agent asked a question")
  })
})

/* -------------------------------------------------------------------------- */
/* The tab: title and favicon                                                 */
/* -------------------------------------------------------------------------- */

describe("usePageAttention", () => {
  test("a parked run puts Needs you at the front of the tab title", async () => {
    document.title = "kantan"
    await render(<Probe subject={subjectOf({ kind: "waiting", reason: "gate" })} needsYou={0} />)

    /* First, not last: a tab strip truncates the end, and this is the only
     * channel the product has to a user who walked away. */
    expect(document.title.startsWith("Needs you")).toBe(true)
    expect(document.title).toContain("your-app")
    expect(document.title).toContain("T2")
  })

  test("it hangs an orange dot on the tab", async () => {
    await render(<Probe subject={subjectOf({ kind: "waiting", reason: "question" })} />)

    const icon = attentionIcon()
    expect(icon).not.toBeNull()
    expect(icon?.getAttribute("rel")).toBe("icon")
    const href = icon?.getAttribute("href") ?? ""
    expect(href.startsWith("data:image/svg+xml,")).toBe(true)
    // The one colour that pulls the eye, and the only one allowed to.
    expect(decodeURIComponent(href).toUpperCase()).toContain("#FF6A1A")
  })

  test("unmounting restores the title and takes the dot away", async () => {
    document.title = "kantan"
    await render(<Probe subject={subjectOf({ kind: "waiting", reason: "gate" })} />)
    expect(document.title).not.toBe("kantan")

    await api.act(async () => {
      root.unmount()
    })

    expect(document.title).toBe("kantan")
    expect(attentionIcon()).toBeNull()
  })

  test("going calm restores the title and takes the dot away, without unmounting", async () => {
    document.title = "kantan"
    await render(<Probe subject={subjectOf({ kind: "waiting", reason: "gate" })} needsYou={1} />)
    expect(attentionIcon()).not.toBeNull()

    await render(<Probe subject={subjectOf({ kind: "running", phase: "implement" })} needsYou={0} />)

    /* A dot left on the tab after the run moved on is a lie about the present,
     * and it is the failure that teaches a reader to ignore the dot. */
    expect(document.title).toBe("kantan")
    expect(attentionIcon()).toBeNull()
  })

  test("it never writes a claim that nothing needs you", async () => {
    document.title = "kantan"
    await render(<Probe subject={subjectOf({ kind: "running", phase: "test" })} needsYou={0} />)

    /* "Nothing needs you" in a tab title would be a standing claim about the
     * whole tree, read long after it stopped being true. The calm reading is
     * the page's own, and the tab says nothing instead. */
    expect(document.title).toBe("kantan")
    expect(attentionIcon()).toBeNull()
  })

  test("it restores the title the page had first, not one it wrote itself", async () => {
    document.title = "kantan"
    await render(<Probe subject={subjectOf({ kind: "waiting", reason: "gate" }, { taskRef: "T2" })} />)
    const first = document.title
    await render(<Probe subject={subjectOf({ kind: "waiting", reason: "question" }, { taskRef: "T7" })} />)
    expect(document.title).not.toBe(first)

    await api.act(async () => {
      root.unmount()
    })

    expect(document.title).toBe("kantan")
  })

  test("it leaves a favicon the page already had alone, and removes only its own", async () => {
    /* `index.html` ships no `<link rel="icon">` today, so "restore" has two
     * cases and this is the other one. The hook appends its own link rather
     * than editing whatever it finds, which is what makes the restore provable
     * instead of a second guess at what was there. */
    const existing = document.createElement("link")
    existing.setAttribute("rel", "icon")
    existing.setAttribute("href", "/favicon.ico")
    document.head.append(existing)
    try {
      await render(<Probe subject={subjectOf({ kind: "waiting", reason: "blocked" })} />)

      expect(existing.getAttribute("href")).toBe("/favicon.ico")
      expect(attentionIcon()).not.toBeNull()

      await api.act(async () => {
        root.unmount()
      })

      expect(attentionIcon()).toBeNull()
      expect(existing.isConnected).toBe(true)
      expect(existing.getAttribute("href")).toBe("/favicon.ico")
    } finally {
      existing.remove()
    }
  })

  test("it survives StrictMode's double pass without capturing its own write", async () => {
    document.title = "kantan"
    await render(
      <api.StrictMode>
        <Probe subject={subjectOf({ kind: "waiting", reason: "gate" })} />
      </api.StrictMode>,
    )
    expect(document.title.startsWith("Needs you")).toBe(true)

    await api.act(async () => {
      root.unmount()
    })

    expect(document.title).toBe("kantan")
  })

  test("a counted backlog names the count, never the run that is not parked", async () => {
    /* The run in front of you is running happily; three others elsewhere in the
     * tree are parked. Naming this one on the alarm would send the reader to
     * the single task that does not need them. */
    document.title = "kantan"
    await render(<Probe subject={subjectOf({ kind: "running", phase: "implement" })} needsYou={3} />)

    expect(document.title).toBe("Needs you · 3 tasks")
    expect(document.title).not.toContain("T2")
    expect(document.title).not.toContain("your-app")
  })

  test("a parked run names itself, even with a backlog behind it", async () => {
    document.title = "kantan"
    await render(<Probe subject={subjectOf({ kind: "waiting", reason: "gate" })} needsYou={3} />)

    expect(document.title).toBe("Needs you · your-app T2")
  })

  test("with no run selected, a counted backlog still reaches the tab", async () => {
    document.title = "kantan"
    await render(<Probe subject={null} needsYou={2} />)

    expect(document.title.startsWith("Needs you")).toBe(true)
    expect(document.title).toContain("2")
    expect(attentionIcon()).not.toBeNull()
  })

  // --- The enumeration --------------------------------------------------

  const STATES: ReadonlyArray<{ name: string; state: RunState | null; parked: boolean }> = [
    { name: "no run selected", state: null, parked: false },
    { name: "running", state: { kind: "running", phase: "implement" }, parked: false },
    { name: "waiting(gate)", state: { kind: "waiting", reason: "gate" }, parked: true },
    { name: "waiting(question)", state: { kind: "waiting", reason: "question" }, parked: true },
    { name: "waiting(blocked)", state: { kind: "waiting", reason: "blocked" }, parked: true },
    { name: "waiting(stalled)", state: { kind: "waiting", reason: "stalled" }, parked: true },
    { name: "done", state: { kind: "done", merged: true }, parked: false },
    { name: "failed", state: { kind: "failed", why: "tests failed" }, parked: false },
    { name: "interrupted", state: { kind: "interrupted", resumeFrom: "implement" }, parked: false },
  ]

  const COUNTS: ReadonlyArray<{ name: string; value: number | undefined; usable: boolean }> = [
    { name: "nobody counted", value: undefined, usable: false },
    { name: "not a number", value: Number.NaN, usable: false },
    { name: "negative", value: -1, usable: false },
    { name: "not an integer", value: 1.5, usable: false },
    { name: "infinite", value: Number.POSITIVE_INFINITY, usable: false },
    { name: "zero", value: 0, usable: false },
    { name: "one", value: 1, usable: true },
    { name: "three", value: 3, usable: true },
  ]

  /*
   * The matrix the skipping-guard rule asks for.
   *
   * **The dimension** is "does anything need the human", read from two inputs:
   * this run's state and a tree-wide count the caller supplies.
   *
   * **Its values** are the five `RunState` kinds (with all four `WaitReason`s
   * spelled out, since `waiting` is the only kind that parks) plus no run at
   * all, crossed with eight readings of the count: absent, `NaN`, negative,
   * fractional, infinite, zero, one, several.
   *
   * **What a wrong guess costs, in each direction.** A missed "needs you" is
   * the expensive one: the user is in another tab and a parked run waits until
   * they next remember it, which is the single failure this product exists to
   * prevent. A spurious one costs a glance - *unless it is permanent*, and a
   * count that is always unusable would make it permanent, at which point the
   * dot stops meaning anything and the expensive direction arrives anyway by a
   * longer road. So an unusable count is read as "nobody counted" rather than
   * as "something waits", and the run's own state - which is known-good data -
   * carries the decision alone.
   *
   * That also keeps this reading identical to `needsYouClaim`'s in
   * `src/ui/Digest.tsx`, which is not a nicety: see the contradiction test
   * below.
   */
  for (const row of STATES) {
    for (const col of COUNTS) {
      test(`${row.name} × ${col.name}`, async () => {
        document.title = "kantan"
        const subject = row.state === null ? null : subjectOf(row.state)
        await render(<Probe subject={subject} needsYou={col.value} />)

        const expected = row.parked || col.usable
        expect(document.title.startsWith("Needs you")).toBe(expected)
        expect(attentionIcon() !== null).toBe(expected)
        if (!expected) expect(document.title).toBe("kantan")
      })
    }
  }

  test("the tab and the band never contradict each other about the same count", async () => {
    /* `ReturnBand` decides whether to claim "Nothing needs you" from the same
     * two inputs, with its own copy of the rule. One screen showing a calm band
     * and a "Needs you" tab - or the reverse - is worse than either reading
     * alone, because the user cannot tell which to trust. */
    for (const row of STATES) {
      if (row.state === null) continue
      for (const col of COUNTS) {
        const subject = subjectOf(row.state)

        document.title = "kantan"
        await render(<Probe subject={subject} needsYou={col.value} />)
        const tabWants = document.title.startsWith("Needs you")

        await render(<api.ReturnBand subject={subject} needsYou={col.value} />)
        const claim = host.querySelector('[data-testid="band-claim"]')?.textContent ?? ""

        const where = `${row.name} × ${col.name}`
        if (claim.includes("Nothing needs you")) {
          expect(tabWants, `band says calm, tab says needs you: ${where}`).toBe(false)
        }
        if (/needs? you/.test(claim) && !claim.includes("Nothing")) {
          expect(tabWants, `band says needs you, tab is quiet: ${where}`).toBe(true)
        }
      }
    }
  })
})
