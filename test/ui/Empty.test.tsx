/**
 * The empty screen: `docs/design/Empty.dc.html`, and the state that artboard
 * does not draw.
 *
 * ## What is actually at risk in this component
 *
 * **It is the only screen with no data on it**, so every string is one this
 * repo chose rather than one a run produced. That makes the copy the subject of
 * the tests rather than a label on them: the assertions below hold the
 * artboard's own bytes — curly quotes, the `lang="ja"` on 簡単, the full stop on
 * "Start a task." — because a retyped near-miss is invisible in a screenshot
 * and permanent in the product.
 *
 * **There are two emptinesses and only one is drawn.** `no-projects` is the
 * artboard. `no-selection` is the commoner one: repositories exist and nothing
 * is picked. The distinction is load-bearing in one direction — telling someone
 * who already has repositories to add one sends them to the wrong control — so
 * it is pinned as a matrix over both kinds rather than tested on the first.
 *
 * **It is the most heavily animated screen in the app**: a seven-rung entrance
 * ladder, three infinite float loops, a pulse ring and two marching dashed
 * connectors. `CLAUDE.md` records that Motion's `useReducedMotion()` is a
 * module-level singleton that has answered `false` with the media feature
 * actually set, so the component ORs it with a live `matchMedia` read. In here
 * Motion's half is quarantined to `false` on purpose (see "Two query objects"
 * below), which means these tests exercise the **live** half — the half that
 * has to work. Deleting either half of that `||` must turn this file red.
 *
 * `docs/HANDOFF.md` adds the measured reason to judge that by the whole suite:
 * a reduced-motion fallback can pass its own file and fail `bun run check`,
 * because whichever UI suite runs first seeds Motion's singleton.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"

/* Type-only, so nothing here is evaluated before the window exists. */
import type { EmptyProps } from "../../src/ui/Empty.tsx"

/*
 * The window is taken only if the slot is free, and **never given back**.
 *
 * `docs/HANDOFF.md`: `bun test` loads and runs one file at a time, so an
 * `unregister()` in this file's `afterAll` would close the window before a
 * later UI suite is even loaded — and `motion`, already imported and already
 * seeded, holds the first window's media query and timing primitives in
 * module-level state nothing can re-seed. That is how another agent's cost
 * ticker silently froze. So the window outlives this file.
 */
let ownsDocument = false

interface Api {
  act: typeof import("react").act
  StrictMode: typeof import("react").StrictMode
  createRoot: typeof import("react-dom/client").createRoot
  Empty: typeof import("../../src/ui/Empty.tsx").Empty
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
 * process-wide state and stay there.
 *
 * So the two are kept apart by their exact strings: the component asks
 * `(prefers-reduced-motion: reduce)` and gets `reduceQuery`; Motion asks
 * `(prefers-reduced-motion)` and gets a quarantined one that is always `false`
 * and whose listeners are never fired. The pattern is
 * `test/ui/Chrome.test.tsx`'s, and its header explains it at length.
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

  /* The stub goes in before `Empty.tsx` is pulled in: `motion-dom` decides
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
  const empty = await import("../../src/ui/Empty.tsx")
  api = { act: react.act, StrictMode: react.StrictMode, createRoot: client.createRoot, Empty: empty.Empty }
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

/** The serialised inline style, which is where every artboard value lives. */
function styleOf(selector: string): string {
  return one(selector).getAttribute("style") ?? ""
}

/** The class attribute, split, so a missing rung is named rather than hidden in a string. */
function classesOf(selector: string): string[] {
  return (one(selector).getAttribute("class") ?? "").split(/\s+/).filter((c) => c !== "")
}

/** The first element matching `selector` whose trimmed text is exactly `text`. */
function byText<E extends Element>(selector: string, text: string): E {
  const hit = all<E>(selector).find((el) => (el.textContent ?? "").trim() === text)
  if (hit === undefined) throw new Error(`no ${selector} reading exactly ${JSON.stringify(text)}`)
  return hit
}

/** Everything the whole subtree says, with runs of whitespace flattened. */
function prose(): string {
  return (host.textContent ?? "").replace(/\s+/g, " ").trim()
}

// --- Fixtures ---------------------------------------------------------------

/** What `App.tsx` passes for each state. The handler is per-render. */
function props(kind: EmptyProps["kind"], onAddProject: () => void): EmptyProps {
  return kind === "no-projects" ? { kind, onAddProject } : { kind }
}

const KINDS = ["no-projects", "no-selection"] as const

/**
 * The artboard's own bytes, copied out of `docs/design/Empty.dc.html` rather
 * than retyped from a summary of it. The quotes around *simple* are curly and
 * step three keeps its full stop.
 */
const ARTBOARD = {
  eyebrow: "kantan means “simple” in Japanese",
  heading: "Start with a repository.",
  lede:
    "kantan works through the tasks in a markdown file in your repo, one at a time. It writes a plan, " +
    "waits for your OK, then implements it and runs your tests until the exit code says they pass.",
  steps: [
    { lead: "Add a repository", rest: "and choose the Claude account it runs under: personal or work." },
    { lead: "Point at a task file", rest: "such as" },
    { lead: "Start a task.", rest: "kantan plans it, then stops and waits for you." },
  ],
  codeChip: "docs/features/importer.md",
  cta: "Add a repository",
} as const

/* -------------------------------------------------------------------------- */
/* First run: no repositories at all — the artboard                           */
/* -------------------------------------------------------------------------- */

describe("Empty, first run", () => {
  test("says what the artboard says, byte for byte", async () => {
    await render(<api.Empty {...props("no-projects", () => {})} />)

    expect(one("[data-testid='eyebrow']").textContent).toContain(ARTBOARD.eyebrow)
    expect(one("h1").textContent).toBe(ARTBOARD.heading)
    expect(one("[data-testid='lede']").textContent).toBe(ARTBOARD.lede)

    const steps = all("[data-testid='steps'] > li")
    expect(steps).toHaveLength(3)
    for (const [index, step] of ARTBOARD.steps.entries()) {
      const li = steps[index]
      if (li === undefined) throw new Error(`no step ${index + 1}`)
      const text = (li.textContent ?? "").replace(/\s+/g, " ")
      expect(text).toContain(step.lead)
      expect(text).toContain(step.rest)
      /* The lead is the artboard's `<strong>`, not a span that merely looks
       * bold: it is what a screen reader reads as the step's name. */
      expect(li.querySelector("strong")?.textContent).toBe(step.lead)
    }

    /* The path is a machine value, so it is mono — `.m`, per DESIGN.md. */
    const chip = one("[data-testid='steps'] code")
    expect(chip.textContent).toBe(ARTBOARD.codeChip)
    expect(classesOf("[data-testid='steps'] code")).toContain("m")
  })

  test("marks 簡単 as Japanese rather than leaving it to be read as English", async () => {
    await render(<api.Empty {...props("no-projects", () => {})} />)
    expect(one("[lang='ja']").textContent).toBe("簡単")
  })

  test("the only step with no way to be done yet is the one the orange marker points at", async () => {
    await render(<api.Empty {...props("no-projects", () => {})} />)
    const markers = all("[data-testid='steps'] > li > span:first-child")
    expect(markers.map((m) => m.textContent)).toEqual(["1", "2", "3"])
    /* `#FF6A1A` is the one colour that pulls the eye, and DESIGN.md allows it
     * for one thing only: what needs you. Here that is the live step. */
    expect(markers[0]?.getAttribute("style")).toContain("#fff")
    expect(markers[2]?.getAttribute("style")).toContain("#FF6A1A")
  })

  test("the primary action is a real button, and it reports the press", async () => {
    let pressed = 0
    await render(<api.Empty {...props("no-projects", () => void (pressed += 1))} />)

    const cta = one<HTMLButtonElement>("[data-testid='action'] button")
    expect(cta.type).toBe("button")
    expect((cta.textContent ?? "").trim()).toBe(ARTBOARD.cta)
    /* `.cta` is the artboard's own hook for the hover. The hover itself is a
     * utility, because a `style` attribute outranks every selector — including
     * `artboard.css`'s own `.cta:hover`, in the artboard too. */
    expect(classesOf("[data-testid='action'] button")).toContain("cta")
    expect(cta.getAttribute("style") ?? "").not.toContain("background")

    await api.act(async () => {
      cta.click()
    })
    expect(pressed).toBe(1)
  })
})

/* -------------------------------------------------------------------------- */
/* The commoner emptiness: repositories exist, nothing is picked              */
/* -------------------------------------------------------------------------- */

describe("Empty, nothing selected", () => {
  test("never tells someone who already has repositories to add one", async () => {
    await render(<api.Empty {...props("no-selection", () => {})} />)

    /* The whole screen, not just the action slot: the heading, the steps and
     * the cards all mention repositories, and the one thing that must not
     * survive is an *instruction* to add one. */
    expect(one("h1").textContent).not.toBe(ARTBOARD.heading)
    expect(all("[data-testid='action'] button")).toHaveLength(0)
    /* And nothing else in here is pressable either, so there is no control
     * that could be mistaken for the way forward. */
    expect(all("button, a, input, textarea, select, [tabindex]")).toHaveLength(0)
  })

  test("the heading is step three's own words, and the action names where the task is", async () => {
    await render(<api.Empty {...props("no-selection", () => {})} />)
    expect(one("h1").textContent).toBe("Start a task.")
    /* The one string on this screen that is not in the artboard. It points at
     * `Tree`'s column, which labels itself "Projects". */
    expect((one("[data-testid='action']").textContent ?? "").trim()).toBe(
      "Choose one in the projects list on the left.",
    )
  })

  test("keeps the teaching content, because the model is what someone needs either way", async () => {
    await render(<api.Empty {...props("no-selection", () => {})} />)
    expect(one("[data-testid='lede']").textContent).toBe(ARTBOARD.lede)
    expect(all("[data-testid='steps'] > li")).toHaveLength(3)
    expect(one("[data-testid='eyebrow']").textContent).toContain(ARTBOARD.eyebrow)
    expect(one("[data-testid='steps'] code").textContent).toBe(ARTBOARD.codeChip)
  })
})

/* -------------------------------------------------------------------------- */
/* The specimen cards, in both states                                         */
/* -------------------------------------------------------------------------- */

describe("the specimen cards", () => {
  /** What each card must say. DESIGN.md: drawn in the real UI so it teaches the real model. */
  const CARDS = [
    ["repo-card", ["your-app", "personal", "$ npm test"]],
    [
      "taskfile-card",
      [
        "docs/features/importer.md",
        "# Importer",
        "- [ ] T1 Parse the manifest",
        "- [ ] T2 Map records to rows",
        "- [ ] T3 Runtime shim (v1.2)",
      ],
    ],
    ["plan-card", ["Plan ready · T2", "Is this plan right?", "Approve", "Send back"]],
  ] as const

  for (const kind of KINDS) {
    for (const [testid, lines] of CARDS) {
      test(`${kind}: the ${testid} is drawn in the app's own UI`, async () => {
        await render(<api.Empty {...props(kind, () => {})} />)
        const text = (one(`[data-testid='${testid}']`).textContent ?? "").replace(/\s+/g, " ")
        for (const line of lines) expect(text).toContain(line)
      })
    }
  }

  test("the column is hidden from assistive tech, and holds nothing focusable", async () => {
    await render(<api.Empty {...props("no-projects", () => {})} />)
    const specimens = one("[data-testid='specimens']")
    expect(specimens.getAttribute("aria-hidden")).toBe("true")
    /* Approve and Send back are `<span>`s on purpose. A `<button>` in an
     * `aria-hidden` subtree is reachable by Tab and invisible to the reader
     * that would say what it is. */
    expect(specimens.querySelectorAll("button, a, input, textarea, select, [tabindex]")).toHaveLength(0)
  })

  test("the file card's highlighted line is T2, tinted rather than recoloured whole", async () => {
    await render(<api.Empty {...props("no-projects", () => {})} />)
    const t2 = byText("[data-testid='taskfile-card'] div", "- [ ] T2 Map records to rows")
    const style = t2.getAttribute("style") ?? ""
    expect(style).toContain("#FFF1E8")
    expect(style).toContain("#9A3B06")
  })
})

/* -------------------------------------------------------------------------- */
/* The artboard's scope, and the one layer that cannot hold content           */
/* -------------------------------------------------------------------------- */

describe("the artboard scope", () => {
  for (const kind of KINDS) {
    test(`${kind}: the root carries kr and kr-empty`, async () => {
      await render(<api.Empty {...props(kind, () => {})} />)
      const classes = classesOf("main")
      /* `kr-empty` is what switches on Empty's own longer fade, its 8px pulse
       * ring, its .08s delay ladder and its dot geometry — all of which
       * `artboard.css` scopes to a descendant of that class. `kr` is what the
       * reduced-motion `!important` guard is scoped to. */
      expect(classes).toContain("kr")
      expect(classes).toContain("kr-empty")
    })
  }

  test("the dot pattern is its own absolutely positioned layer and holds nothing", async () => {
    await render(<api.Empty {...props("no-projects", () => {})} />)
    const dots = one("[data-testid='dots']")
    expect(classesOf("[data-testid='dots']")).toContain("dots")
    /* `.dots` carries a `mask-image`, and a mask applies to the element's whole
     * rendering, children included. On a content container it silently fades
     * the content out — which has already cost this project a round. */
    expect(dots.children).toHaveLength(0)
    expect(dots.textContent).toBe("")
    expect(dots.getAttribute("aria-hidden")).toBe("true")
    const style = dots.getAttribute("style") ?? ""
    expect(style).toContain("position: absolute")
    expect(style).toContain("inset: 0")
    expect(style).toContain("pointer-events: none")
    /* And nothing the human reads is inside it. */
    expect(dots.contains(one("h1"))).toBe(false)
  })

  test("the entrance ladder is the artboard's: bf, then d1 to d6, with the cards at d3", async () => {
    await render(<api.Empty {...props("no-projects", () => {})} />)
    const rungs: Array<[string, string | null]> = [
      ["[data-testid='eyebrow']", null],
      ["h1", "d1"],
      ["[data-testid='lede']", "d2"],
      ["[data-testid='steps'] > li:nth-child(1)", "d3"],
      ["[data-testid='steps'] > li:nth-child(2)", "d4"],
      ["[data-testid='steps'] > li:nth-child(3)", "d5"],
      ["[data-testid='action']", "d6"],
      /* The specimen column rides in beside the first step, as the artboard
       * draws it — not at the end of the ladder. `d7` exists in
       * `artboard.css` and `Empty.dc.html` never uses it. */
      ["[data-testid='specimens']", "d3"],
    ]
    for (const [selector, rung] of rungs) {
      const classes = classesOf(selector)
      expect(classes).toContain("bf")
      if (rung !== null) expect(classes).toContain(rung)
    }
  })

  test("the three cards float a second apart, the plan dot pulses, the connectors march", async () => {
    await render(<api.Empty {...props("no-projects", () => {})} />)
    expect(classesOf("[data-testid='repo-card']")).toContain("fl")
    expect(classesOf("[data-testid='taskfile-card']")).toContain("fl2")
    expect(classesOf("[data-testid='plan-card']")).toContain("fl3")
    expect(classesOf("[data-testid='plan-card'] span:first-child")).toContain("pulse")
    const flows = all("[data-testid='specimens'] path.flow")
    expect(flows).toHaveLength(2)
  })
})

/* -------------------------------------------------------------------------- */
/* Reduced motion                                                             */
/* -------------------------------------------------------------------------- */

describe("reduced motion", () => {
  /** Every class in here is an `animation`, and every one must go. */
  const MOVING = ["bf", "fl", "fl2", "fl3", "pulse", "flow"]

  for (const kind of KINDS) {
    test(`${kind}: nothing animates for someone who asked for less movement`, async () => {
      setPrefersReduce(true)
      await render(<api.Empty {...props(kind, () => {})} />)

      /* Asserted over the whole subtree rather than per element: a gate applied
       * to six of seven call sites is the failure this is for. */
      const moving = all("*").filter((el) =>
        (el.getAttribute("class") ?? "").split(/\s+/).some((c) => MOVING.includes(c)),
      )
      expect(moving.map((el) => el.getAttribute("class"))).toEqual([])
      expect(one("main").getAttribute("data-motion")).toBe("static")
    })
  }

  test("the preference is still read when Motion's cached answer says no", async () => {
    /* In here Motion's singleton is quarantined to `false` for the life of the
     * process, so this is the live half of the component's `||` on its own —
     * the half that has to work. Deleting it turns this red; deleting the whole
     * gate turns this and the two above red. */
    expect(quarantinedQuery.matches).toBe(false)
    setPrefersReduce(true)
    await render(<api.Empty {...props("no-projects", () => {})} />)
    expect(one("main").getAttribute("data-motion")).toBe("static")
    expect(all(".bf")).toHaveLength(0)
  })

  test("turning the preference on mid-session stops the motion already on screen", async () => {
    await render(<api.Empty {...props("no-projects", () => {})} />)
    expect(one("main").getAttribute("data-motion")).toBe("animated")
    expect(all(".fl")).toHaveLength(1)

    await api.act(async () => {
      setPrefersReduce(true)
    })
    expect(one("main").getAttribute("data-motion")).toBe("static")
    expect(all(".fl")).toHaveLength(0)
  })

  test("and turning it back off lets the screen move again", async () => {
    setPrefersReduce(true)
    await render(<api.Empty {...props("no-projects", () => {})} />)
    expect(one("main").getAttribute("data-motion")).toBe("static")

    await api.act(async () => {
      setPrefersReduce(false)
    })
    expect(one("main").getAttribute("data-motion")).toBe("animated")
    expect(all(".pulse")).toHaveLength(1)
  })

  test("the copy and the cards survive the gate; only the movement goes", async () => {
    setPrefersReduce(true)
    await render(<api.Empty {...props("no-projects", () => {})} />)
    const text = prose()
    expect(text).toContain(ARTBOARD.eyebrow)
    expect(text).toContain(ARTBOARD.lede)
    expect(text).toContain("your-app")
    expect(text).toContain("Plan ready · T2")
    /* Scoped to the connector canvas: the three cards draw six more `path`s
       between them, and counting all of them would pass whatever happened to
       the two that matter. */
    expect(all("[data-testid='specimens'] > svg > path")).toHaveLength(2)
  })
})

/* -------------------------------------------------------------------------- */
/* The two preflight traps                                                    */
/* -------------------------------------------------------------------------- */

describe("Tailwind's preflight", () => {
  test("the root puts the line box back to the artboard's own", async () => {
    await render(<api.Empty {...props("no-projects", () => {})} />)
    /* Preflight sets `line-height: 1.5` on `html`; the artboard has no such
     * rule, so every element that does not declare one — the eyebrow,
     * `your-app`, `$ npm test`, the step digits — sat 2-4px taller than drawn.
     * `Tree.tsx` solves it the same way, with `leading-[normal]` on its aside. */
    expect(classesOf("main")).toContain("leading-[normal]")
  })

  test("every element the artboard sized as content-box still is one", async () => {
    await render(<api.Empty {...props("no-projects", () => {})} />)
    /* Preflight sets `box-sizing: border-box` and the artboard sets it only on
     * `<main>` and `<aside>`, so anything with an explicit width or height
     * *plus* padding or a border renders narrower here than it was drawn.
     * The rule is "explicit size + padding or border"; these are every element
     * in this artboard that matches it. */
    const contentBox = [
      ["[data-testid='repo-card']", "250px wide plus 14/16 padding plus a border = 284"],
      ["[data-testid='taskfile-card']", "280px wide plus a border = 282"],
      ["[data-testid='plan-card']", "270px wide plus 1.5px of gradient = 273"],
      ["[data-testid='steps'] > li:nth-child(1) > span:first-child", "32px plus a border = 34"],
      ["[data-testid='steps'] > li:nth-child(2) > span:first-child", "32px plus a border = 34"],
      ["[data-testid='send-back']", "32px tall plus a border = 34"],
    ] as const
    for (const [selector, why] of contentBox) {
      expect(styleOf(selector), why).toContain("box-sizing: content-box")
    }
    /* Step three's marker has no border, so it is 32px either way and says
     * nothing — a `content-box` there would be noise claiming to be a fix. */
    expect(styleOf("[data-testid='steps'] > li:nth-child(3) > span:first-child")).not.toContain("box-sizing")
    /* `<main>` is the one element the artboard declares border-box on itself. */
    expect(styleOf("main")).toContain("box-sizing: border-box")
  })

  test("the root scrolls rather than clipping, because the app shell does not", async () => {
    await render(<api.Empty {...props("no-projects", () => {})} />)
    /* The artboard's `overflow:hidden` relied on the document scrolling.
     * `App.tsx`'s shell is `h-dvh overflow-hidden`, so ported verbatim a short
     * viewport would clip the action off the bottom with no way to reach it.
     * Horizontal clipping is kept: that is what the rotated cards need. */
    const style = styleOf("main")
    expect(style).toContain("overflow-x: hidden")
    expect(style).toContain("overflow-y: auto")
  })
})

/* -------------------------------------------------------------------------- */
/* The caller's half of the contract                                          */
/* -------------------------------------------------------------------------- */

describe("the shell's seam", () => {
  for (const kind of KINDS) {
    test(`${kind}: the root is the <main> the shell swaps in, and takes a className`, async () => {
      await render(<api.Empty {...props(kind, () => {})} className="probe-seam" />)
      /* It renders `<main>` itself rather than content for `App.tsx`'s `<main>`:
       * that element already carries its own `.dots` layer with the *other*
       * mask, and `.kr-empty .dots` only reaches a layer inside this root. */
      expect(host.children[0]?.tagName).toBe("MAIN")
      expect(all("main")).toHaveLength(1)
      expect(classesOf("main")).toContain("probe-seam")
    })
  }

  test("one h1, so the screen has exactly one name", async () => {
    await render(<api.Empty {...props("no-projects", () => {})} />)
    /* `AppBar` draws "kantan" in a `<span>` and no other region has a heading,
     * so this is the page's only `<h1>`. */
    expect(all("h1")).toHaveLength(1)
  })

  test("survives StrictMode's double render without doubling anything", async () => {
    await render(
      <api.StrictMode>
        <api.Empty {...props("no-projects", () => {})} />
      </api.StrictMode>,
    )
    expect(all("main")).toHaveLength(1)
    expect(all("[data-testid='dots']")).toHaveLength(1)
    expect(all("[data-testid='steps'] > li")).toHaveLength(3)
  })
})
