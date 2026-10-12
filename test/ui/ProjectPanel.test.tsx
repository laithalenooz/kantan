/**
 * Project settings and the account switch: `docs/design/Project.dc.html`.
 *
 * That artboard carries **16 `<sc-if>` branches and 2 `<sc-for>` loops**, and
 * they are the specification rather than decoration. Nine of them belong to the
 * account switch alone, which is why this file spends most of its length there.
 *
 * ## What is actually at risk here
 *
 * **Switching the account moves money.** `Tree.tsx`'s `Account` doc comment
 * forbids defaulting to "personal" because a wrong account bills a client from
 * the wrong place, and `src/projects.ts` keeps `account` optional for the same
 * reason: absent means *nobody has said*. So the panel has three readings to
 * render, not two, and the artboard's own `pick` guard - `if (acct ===
 * s.account) return` - reads exactly one dimension, the current account, whose
 * values are `personal | work | unknown`. `CLAUDE.md`'s skipping-guard rule
 * applies to it directly:
 *
 * | dimension | values | wrong guess costs |
 * |---|---|---|
 * | `project.account.kind` | `personal`, `work`, `unknown` | skipping a needed confirmation silently rebills; confirming a no-op costs one extra click |
 *
 * The cheap direction is to confirm, so **only an exact match with the pick
 * skips**, and `unknown` therefore always confirms. Tested as a 3x2 matrix
 * below, including the `unknown` row no artboard state produces.
 *
 * **The confirmation is the safety, not a flourish.** The artboard routes both
 * entry points - the sidebar chip's popover and the panel's radio cards -
 * through a confirmation *before anything changes*, and only then a toast. A
 * test that merely proved the callback fires would pass with the confirmation
 * deleted, so every switch test asserts the callback has **not** been called
 * until the confirm button is pressed.
 *
 * **"Undo" cannot always exist.** `updateProject` accepts `"personal" |
 * "work"` and nothing else, so a project switched *away* from `unknown` cannot
 * be switched back. Offering an Undo that would throw is worse than offering
 * none, so the toast hides it in exactly that case.
 *
 * **An exit code is a number or it is absent.** `DESIGN.md` forbids a tick
 * standing in for a code, so "Run it now" prints what the server returned and
 * nothing else: a signal is a signal, a timeout is a timeout, and neither
 * reads green. A result that arrives for a command string the field no longer
 * holds is dropped rather than shown against the wrong command.
 *
 * **The remove dialog is the only modal in the design**, and its copy is the
 * one sentence that must not drift: `src/projects.ts`'s `removeProject` leaves
 * run logs where they are and touches nothing on disk. The artboard's own text
 * says "deletes its run history", which is false against that implementation -
 * see "the copy the artboard gets wrong" below.
 *
 * ## Two things about this harness that are not incidental
 *
 * **happy-dom is registered before the component is imported**, and the window
 * is never given back. `docs/HANDOFF.md`: `bun test` runs every file in one
 * process, `motion-dom` decides `isBrowser` at module evaluation, and an
 * `unregister()` in an `afterAll` froze another suite's ticker. So
 * registration first, dynamic import second, and no `unregister`.
 *
 * **Motion's query is quarantined.** Its reduced-motion answer is a
 * module-level singleton seeded by the first call anywhere in the process, so
 * the component's exact string `(prefers-reduced-motion: reduce)` gets the
 * query this file toggles and anything looser gets a query that is always
 * `false` and never notified. The pattern is `test/ui/Empty.test.tsx`'s. That
 * means the reduced-motion tests here exercise the **live** `matchMedia` half
 * of `usePrefersReducedMotion`, which is the half that has to work.
 *
 * `docs/HANDOFF.md` also records why a green single-file run proves nothing:
 * judge by the full `bun run check`.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"

/* Type-only, so nothing here is evaluated before the window exists. */
import type { AccountOption, TestCommandResult } from "../../src/ui/ProjectPanel.tsx"
import type { Account, TreeProject } from "../../src/ui/Tree.tsx"

/** Taken only if free, and never given back. See the header. */
let ownsDocument = false

interface Api {
  act: typeof import("react").act
  createRoot: typeof import("react-dom/client").createRoot
  ProjectPanel: typeof import("../../src/ui/ProjectPanel.tsx").ProjectPanel
  AccountSwitch: typeof import("../../src/ui/ProjectPanel.tsx").AccountSwitch
  ringOffset: typeof import("../../src/ui/Sidebar.tsx").ringOffset
  percentLabel: typeof import("../../src/ui/Sidebar.tsx").percentLabel
  formatResetTime: typeof import("../../src/ui/Sidebar.tsx").formatResetTime
}

// --- The reduced-motion media feature ---------------------------------------

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
  const panel = await import("../../src/ui/ProjectPanel.tsx")
  const sidebar = await import("../../src/ui/Sidebar.tsx")
  api = {
    act: react.act,
    createRoot: client.createRoot,
    ProjectPanel: panel.ProjectPanel,
    AccountSwitch: panel.AccountSwitch,
    ringOffset: sidebar.ringOffset,
    percentLabel: sidebar.percentLabel,
    formatResetTime: sidebar.formatResetTime,
  }
})

afterAll(() => {
  if (realMatchMedia !== undefined) {
    Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: realMatchMedia })
  }
  /* Deliberately **not** `GlobalRegistrator.unregister()`. See the header. */
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

function maybe<E extends Element>(selector: string): E | null {
  return host.querySelector<E>(selector)
}

function all<E extends Element>(selector: string): E[] {
  return [...host.querySelectorAll<E>(selector)]
}

function classesOf(selector: string): string[] {
  return (one(selector).getAttribute("class") ?? "").split(/\s+/).filter((c) => c !== "")
}

/** The first element matching `selector` whose trimmed text is exactly `text`. */
function byText<E extends Element>(selector: string, text: string): E {
  const hit = all<E>(selector).find((el) => (el.textContent ?? "").trim() === text)
  if (hit === undefined) {
    throw new Error(
      `no ${selector} reading exactly ${JSON.stringify(text)}; saw ${JSON.stringify(
        all(selector).map((el) => (el.textContent ?? "").trim()),
      )}`,
    )
  }
  return hit
}

/** Everything the subtree says, with runs of whitespace flattened. */
function prose(): string {
  return (host.textContent ?? "").replace(/\s+/g, " ").trim()
}

async function click(el: Element): Promise<void> {
  await api.act(async () => {
    ;(el as HTMLElement).click()
  })
}

async function press(el: Element, key: string, init: KeyboardEventInit = {}): Promise<void> {
  await api.act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }))
  })
}

/**
 * Typing, through the **prototype's** value setter.
 *
 * React installs its own `value` property on the node and compares against it
 * to decide whether an `input` event changed anything. Assigning `node.value`
 * goes through that property, so React sees the new value already in place and
 * skips `onChange` entirely - the field looks typed and the component never
 * hears about it. `test/ui/Gate.test.tsx` and `test/ui/StartPanel.test.tsx`
 * reach past it the same way.
 */
/* Looked up on demand, not at module load: `HTMLInputElement` does not exist
 * until `GlobalRegistrator.register()` has run in `beforeAll`. */
function nativeInputValueSetter(): (this: HTMLInputElement, value: string) => void {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  if (set === undefined) throw new Error("HTMLInputElement has no value setter to borrow")
  return set
}

async function typeInto(el: Element, value: string): Promise<void> {
  const input = el as HTMLInputElement
  const set = nativeInputValueSetter()
  await api.act(async () => {
    set.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

/**
 * `focusout`, not `blur`.
 *
 * React implements `onBlur` on top of `focusout` because `blur` does not
 * bubble and React listens at the root container. A dispatched `blur` - even
 * with `bubbles: true` - reaches no React handler at all, which makes a
 * commit-on-blur field look like it never commits.
 */
async function blurOf(el: Element): Promise<void> {
  await api.act(async () => {
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))
  })
}

/** A promise this test resolves by hand, for an in-flight test run. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve: (v: T) => void = () => {}
  let reject: (e: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Lets a resolved promise's `.then` callbacks and React's commit land. */
async function settle(): Promise<void> {
  await api.act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

// --- Fixtures ---------------------------------------------------------------

const RESETS_PERSONAL = 1_760_000_000
const RESETS_WORK = 1_760_005_000

const PERSONAL: AccountOption = {
  kind: "personal",
  label: "personal",
  configDir: "~/.claude",
  window: { profile: null, label: "personal", status: "allowed", utilization: 0.41, resetsAtSec: RESETS_PERSONAL },
}

const WORK: AccountOption = {
  kind: "work",
  label: "work",
  configDir: "~/.claude-work",
  window: {
    profile: "/home/you/.claude-work",
    label: "work",
    status: "allowed",
    utilization: 0.12,
    resetsAtSec: RESETS_WORK,
  },
}

const ACCOUNTS = [PERSONAL, WORK] as const

function project(account: Account["kind"], over: Partial<TreeProject> = {}): TreeProject {
  return {
    path: "/home/you/code/your-app",
    account: { kind: account },
    testCmd: "npm test",
    features: [
      {
        path: "docs/features/importer.md",
        tasks: [
          { ref: "T1", text: "one", done: true },
          { ref: "T2", text: "two", done: false },
          { ref: "T3", text: "three", done: false },
        ],
      },
      { path: "docs/features/export.md", tasks: [{ ref: "T1", text: "only", done: false }] },
    ],
    ...over,
  }
}

/**
 * Every required callback, each recording its calls.
 *
 * The recorders are kept off `props` deliberately: spreading them into JSX
 * would hand the component three attributes it does not declare.
 */
function handlers() {
  const switched: string[] = []
  const saved: string[] = []
  const removed: number[] = []
  return {
    switched,
    saved,
    removed,
    props: {
      onSwitchAccount: (account: AccountOption) => void switched.push(account.kind),
      onSaveTestCmd: (cmd: string) => void saved.push(cmd),
      onRemove: () => void removed.push(1),
    },
  }
}

const CARD = (kind: string): string => `[role="radio"][data-card="${kind}"]`
const OPT = (kind: string): string => `[role="radio"][data-opt="${kind}"]`

// ---------------------------------------------------------------------------

describe("the panel itself", () => {
  test("names the repository, prints its path verbatim, and promises what it does", async () => {
    const h = handlers()
    await render(<api.ProjectPanel project={project("personal")} accounts={ACCOUNTS} {...h.props} />)

    expect(one("h1").textContent?.trim()).toBe("your-app")
    expect(prose()).toContain("/home/you/code/your-app")
    expect(prose()).toContain("Changes save as you go")
  })

  test("is the centre column, not a dialog", async () => {
    const h = handlers()
    await render(<api.ProjectPanel project={project("personal")} accounts={ACCOUNTS} {...h.props} />)

    /* The one modal in the design is the remove confirmation, and it is closed. */
    expect(all("[aria-modal]")).toHaveLength(0)
    expect(one("[data-panel]").getAttribute("role")).toBeNull()
  })

  test("carries `kr` so the reduced-motion kill-switch reaches it, and undoes preflight's leading", async () => {
    const h = handlers()
    await render(<api.ProjectPanel project={project("personal")} accounts={ACCOUNTS} {...h.props} />)

    const classes = classesOf("[data-panel]")
    expect(classes).toContain("kr")
    expect(classes).toContain("leading-[normal]")
  })

  test("prints a branch summary only when one is supplied", async () => {
    const h = handlers()
    await render(<api.ProjectPanel project={project("personal")} accounts={ACCOUNTS} {...h.props} />)
    expect(prose()).not.toContain("main · clean")

    await render(<api.ProjectPanel project={project("personal")} accounts={ACCOUNTS} branch="main · clean" {...h.props} />)
    expect(prose()).toContain("main · clean")
  })
})

describe("the account cards", () => {
  test("offer one radio per account, inside a labelled radiogroup", async () => {
    const h = handlers()
    await render(<api.ProjectPanel project={project("personal")} accounts={ACCOUNTS} {...h.props} />)

    const group = one('[role="radiogroup"][aria-label="Claude account"]')
    const radios = [...group.querySelectorAll('[role="radio"]')]
    expect(radios).toHaveLength(2)
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false"])
  })

  test("check the stored account, and check nothing at all when nobody has said", async () => {
    const h = handlers()
    await render(<api.ProjectPanel project={project("work")} accounts={ACCOUNTS} {...h.props} />)
    expect(all(`${CARD("personal")},${CARD("work")}`).map((r) => r.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
    ])

    await render(<api.ProjectPanel project={project("unknown")} accounts={ACCOUNTS} {...h.props} />)
    expect(all(`${CARD("personal")},${CARD("work")}`).map((r) => r.getAttribute("aria-checked"))).toEqual([
      "false",
      "false",
    ])
  })

  test("say plainly that an unknown account is unknown, rather than drawing a default", async () => {
    const h = handlers()
    await render(<api.ProjectPanel project={project("unknown")} accounts={ACCOUNTS} {...h.props} />)
    expect(prose()).toContain("Nobody has said which account this project runs as")
  })

  test("draw each account's usage ring from Sidebar's own geometry", async () => {
    const h = handlers()
    await render(<api.ProjectPanel project={project("personal")} accounts={ACCOUNTS} {...h.props} />)

    const arcs = all<SVGCircleElement>("[data-ring-arc]")
    expect(arcs).toHaveLength(2)
    expect(arcs[0]?.getAttribute("stroke-dashoffset")).toBe(String(api.ringOffset(0.41)))
    expect(arcs[1]?.getAttribute("stroke-dashoffset")).toBe(String(api.ringOffset(0.12)))
    expect(arcs[0]?.getAttribute("stroke-dasharray")).toBe("157.08")
  })

  test("print the percentage and the reset time the way the rail does", async () => {
    const h = handlers()
    await render(<api.ProjectPanel project={project("personal")} accounts={ACCOUNTS} {...h.props} />)

    expect(prose()).toContain(api.percentLabel(0.41))
    expect(prose()).toContain(`resets ${api.formatResetTime(RESETS_PERSONAL)}`)
    expect(prose()).toContain("~/.claude-work")
  })

  test("print an em dash, never 0%, for an account that has reported nothing", async () => {
    const h = handlers()
    const quiet: AccountOption = { kind: "work", label: "work" }
    await render(<api.ProjectPanel project={project("personal")} accounts={[PERSONAL, quiet]} {...h.props} />)

    const arcs = all<SVGCircleElement>("[data-ring-arc]")
    expect(arcs[1]?.getAttribute("stroke-dashoffset")).toBe(String(api.ringOffset(undefined)))
    expect(prose()).toContain("—")
    expect(prose()).not.toContain("0%")
  })
})

describe("switching the account asks first", () => {
  /**
   * The matrix `CLAUDE.md`'s skipping-guard rule asks for. The dimension is
   * `project.account.kind`; the second axis is which card is picked. Only an
   * exact match may skip the confirmation, so the `unknown` row - which no
   * artboard state produces - confirms both ways.
   */
  const matrix: ReadonlyArray<{ from: Account["kind"]; pick: "personal" | "work"; confirms: boolean }> = [
    { from: "personal", pick: "personal", confirms: false },
    { from: "personal", pick: "work", confirms: true },
    { from: "work", pick: "personal", confirms: true },
    { from: "work", pick: "work", confirms: false },
    { from: "unknown", pick: "personal", confirms: true },
    { from: "unknown", pick: "work", confirms: true },
  ]

  for (const { from, pick, confirms } of matrix) {
    test(`from ${from}, picking ${pick} ${confirms ? "confirms before anything changes" : "is a no-op"}`, async () => {
      const h = handlers()
      await render(<api.ProjectPanel project={project(from)} accounts={ACCOUNTS} {...h.props} />)

      await click(one(CARD(pick)))

      /* Whatever happens, nothing has been switched by the pick alone. */
      expect(h.switched).toEqual([])

      if (!confirms) {
        expect(maybe('[data-confirm="panel"]')).toBeNull()
        return
      }

      const confirmation = one('[data-confirm="panel"]')
      expect(confirmation.getAttribute("role")).toBe("alertdialog")
      await click(byText(`[data-confirm="panel"] button`, `Switch to ${pick}`))
      expect(h.switched).toEqual([pick])
    })
  }

  /**
   * The confirmation claims "future runs bill to work". That claim is only
   * true if what actually selects the profile changes, and **`account` does
   * not select it**: `src/spawn.ts` sets `CLAUDE_CONFIG_DIR` from
   * `project.configDir` and deletes it when there is none, and `src/run.ts`
   * keys the rate-limit window on `configDir` as well. Nothing reads
   * `project.account` to decide what gets billed - it is a label the human
   * wrote, which is exactly what `src/projects.ts` says it is.
   *
   * So the handler is given the whole option rather than a kind, and this test
   * holds that: a panel that passed `"work"` alone would leave the shell with
   * nothing to PATCH `configDir` from, and the chip would move while the
   * billing did not. That is the one defect the chip exists to prevent.
   */
  test("hands the handler the config folder, not just a word", async () => {
    const got: unknown[] = []
    await render(
      <api.ProjectPanel
        project={project("personal")}
        accounts={ACCOUNTS}
        onSwitchAccount={(account) => void got.push(account)}
        onSaveTestCmd={() => {}}
        onRemove={() => {}}
      />,
    )
    await click(one(CARD("work")))
    await click(byText('[data-confirm="panel"] button', "Switch to work"))
    await settle()

    expect(got).toEqual([WORK])
    expect((got[0] as AccountOption).configDir).toBe("~/.claude-work")
  })

  test("spells out what the switch costs, naming both accounts and the target's usage", async () => {
    const h = handlers()
    await render(<api.ProjectPanel project={project("personal")} accounts={ACCOUNTS} {...h.props} />)
    await click(one(CARD("work")))

    const said = (one('[data-confirm="panel"]').textContent ?? "").replace(/\s+/g, " ")
    expect(said).toContain("Switch your-app to work?")
    expect(said).toContain("Future runs bill to work")
    expect(said).toContain("12% of its window used")
    expect(said).toContain("Past runs keep their history under personal")
  })

  test("does not claim past runs belong to an account nobody named", async () => {
    const h = handlers()
    await render(<api.ProjectPanel project={project("unknown")} accounts={ACCOUNTS} {...h.props} />)
    await click(one(CARD("work")))

    const said = (one('[data-confirm="panel"]').textContent ?? "").replace(/\s+/g, " ")
    expect(said).not.toContain("under unknown")
    expect(said).not.toContain("under account unknown")
    expect(said).toContain("Past runs keep the history they already have")
  })

  test("says the target has reported nothing rather than printing a dash into a sentence", async () => {
    const h = handlers()
    const quiet: AccountOption = { kind: "work", label: "work" }
    await render(<api.ProjectPanel project={project("personal")} accounts={[PERSONAL, quiet]} {...h.props} />)
    await click(one(CARD("work")))

    const said = (one('[data-confirm="panel"]').textContent ?? "").replace(/\s+/g, " ")
    expect(said).toContain("no usage reported yet")
    expect(said).not.toContain("— of its window")
  })

  test("Cancel puts everything back and switches nothing", async () => {
    const h = handlers()
    await render(<api.ProjectPanel project={project("personal")} accounts={ACCOUNTS} {...h.props} />)
    await click(one(CARD("work")))
    await click(byText('[data-confirm="panel"] button', "Cancel"))

    expect(maybe('[data-confirm="panel"]')).toBeNull()
    expect(h.switched).toEqual([])
    expect(one(CARD("personal")).getAttribute("aria-checked")).toBe("true")
  })

  test("picking the account already in the confirmation's sights cancels it", async () => {
    const h = handlers()
    await render(<api.ProjectPanel project={project("personal")} accounts={ACCOUNTS} {...h.props} />)
    await click(one(CARD("work")))
    expect(maybe('[data-confirm="panel"]')).not.toBeNull()

    await click(one(CARD("personal")))
    expect(maybe('[data-confirm="panel"]')).toBeNull()
    expect(h.switched).toEqual([])
  })

  test("leaves the checked card to the props: the UI never owns the truth", async () => {
    const h = handlers()
    await render(<api.ProjectPanel project={project("personal")} accounts={ACCOUNTS} {...h.props} />)
    await click(one(CARD("work")))
    await click(byText('[data-confirm="panel"] button', "Switch to work"))
    await settle()

    /* The callback ran; the parent has not reloaded yet. The panel must still
       show what it was told, not what it hopes happened. */
    expect(h.switched).toEqual(["work"])
    expect(one(CARD("personal")).getAttribute("aria-checked")).toBe("true")
  })
})

describe("the toast that finishes the switch", () => {
  async function switchTo(from: Account["kind"], to: "personal" | "work") {
    const h = handlers()
    await render(<api.ProjectPanel project={project(from)} accounts={ACCOUNTS} {...h.props} />)
    await click(one(CARD(to)))
    await click(byText('[data-confirm="panel"] button', `Switch to ${to}`))
    await settle()
    return h
  }

  test("says which account the project now runs as", async () => {
    await switchTo("personal", "work")
    const toast = one("[data-toast]")
    expect(toast.getAttribute("role")).toBe("status")
    expect((toast.textContent ?? "").replace(/\s+/g, " ")).toContain("your-app now runs as work")
  })

  test("offers Undo, which asks for the account the project came from", async () => {
    const h = await switchTo("personal", "work")
    await click(byText("[data-toast] button", "Undo"))
    expect(h.switched).toEqual(["work", "personal"])
    expect(maybe("[data-toast]")).toBeNull()
  })

  /* Undo has the same obligation as the switch it reverses: without the
     option there is no `configDir` to send back. */
  test("Undo hands back the whole option too", async () => {
    const got: AccountOption[] = []
    await render(
      <api.ProjectPanel
        project={project("personal")}
        accounts={ACCOUNTS}
        onSwitchAccount={(account) => void got.push(account)}
        onSaveTestCmd={() => {}}
        onRemove={() => {}}
      />,
    )
    await click(one(CARD("work")))
    await click(byText('[data-confirm="panel"] button', "Switch to work"))
    await settle()
    await click(byText("[data-toast] button", "Undo"))
    expect(got).toEqual([WORK, PERSONAL])
  })

  /* An account the caller stopped offering has no option to send, so the
     control that would try is not drawn. */
  test("hides Undo when the account it came from is no longer on offer", async () => {
    const h = handlers()
    await render(<api.ProjectPanel project={project("work")} accounts={[PERSONAL]} {...h.props} />)
    await click(one(CARD("personal")))
    await click(byText('[data-confirm="panel"] button', "Switch to personal"))
    await settle()

    expect(maybe("[data-toast]")).not.toBeNull()
    expect(all("[data-toast] button").map((b) => (b.textContent ?? "").trim())).not.toContain("Undo")
  })

  test("hides Undo when there is nothing valid to go back to", async () => {
    await switchTo("unknown", "work")
    expect(maybe("[data-toast]")).not.toBeNull()
    expect(all("[data-toast] button").map((b) => (b.textContent ?? "").trim())).not.toContain("Undo")
  })

  test("can be dismissed by hand", async () => {
    await switchTo("personal", "work")
    await click(one('[data-toast] [aria-label="Dismiss"]'))
    expect(maybe("[data-toast]")).toBeNull()
  })

  test("never appears when the switch failed, and the failure is shown instead", async () => {
    const switched: string[] = []
    await render(
      <api.ProjectPanel
        project={project("personal")}
        accounts={ACCOUNTS}
        onSwitchAccount={(account) => {
          switched.push(account.kind)
          return Promise.reject(new Error("the server said no"))
        }}
        onSaveTestCmd={() => {}}
        onRemove={() => {}}
      />,
    )
    await click(one(CARD("work")))
    await click(byText('[data-confirm="panel"] button', "Switch to work"))
    await settle()

    expect(switched).toEqual(["work"])
    expect(maybe("[data-toast]")).toBeNull()
    expect(prose()).toContain("the server said no")
    expect(one('[role="alert"]')).toBeDefined()
  })
})

describe("the account chip and its popover", () => {
  function switchProps(account: Account["kind"]) {
    const switched: string[] = []
    return {
      switched,
      node: (
        <api.AccountSwitch
          project={project(account)}
          accounts={ACCOUNTS}
          onSwitchAccount={(a: AccountOption) => void switched.push(a.kind)}
        />
      ),
    }
  }

  test("is a chip that says what the project runs as, and announces a popover", async () => {
    const { node } = switchProps("personal")
    await render(node)

    const chip = one("[data-account-chip]")
    expect(chip.getAttribute("aria-haspopup")).toBe("dialog")
    expect(chip.getAttribute("aria-expanded")).toBe("false")
    expect((chip.textContent ?? "").trim()).toContain("personal")
    expect(maybe("[data-account-popover]")).toBeNull()
  })

  test("prints `account unknown` rather than guessing", async () => {
    const { node } = switchProps("unknown")
    await render(node)
    expect((one("[data-account-chip]").textContent ?? "").trim()).toContain("account unknown")
  })

  test("opens a dialog listing the accounts as radios, each with its own ring", async () => {
    const { node } = switchProps("personal")
    await render(node)
    await click(one("[data-account-chip]"))

    const pop = one("[data-account-popover]")
    expect(pop.getAttribute("role")).toBe("dialog")
    expect(pop.getAttribute("aria-label")).toBe("Claude account for your-app")
    /* A popover, not the one modal. */
    expect(pop.getAttribute("aria-modal")).toBeNull()
    expect(one("[data-account-chip]").getAttribute("aria-expanded")).toBe("true")
    expect(all("[data-account-popover] [data-ring-arc]")).toHaveLength(2)
    expect(all(`[data-account-popover] [role="radio"]`)).toHaveLength(2)
  })

  test("becomes a confirmation before anything changes, and the list goes away", async () => {
    const { node, switched } = switchProps("personal")
    await render(node)
    await click(one("[data-account-chip]"))
    await click(one(OPT("work")))

    expect(switched).toEqual([])
    expect(maybe('[data-account-popover] [role="radiogroup"]')).toBeNull()
    expect(one('[data-confirm="pop"]').getAttribute("role")).toBe("alertdialog")
    expect((one('[data-confirm="pop"]').textContent ?? "").replace(/\s+/g, " ")).toContain(
      "Switch your-app to work?",
    )
  })

  test("Cancel in the popover goes back to the list without switching", async () => {
    const { node, switched } = switchProps("personal")
    await render(node)
    await click(one("[data-account-chip]"))
    await click(one(OPT("work")))
    await click(byText('[data-confirm="pop"] button', "Cancel"))

    expect(switched).toEqual([])
    expect(maybe('[data-account-popover] [role="radiogroup"]')).not.toBeNull()
  })

  test("confirming switches, closes the popover and toasts", async () => {
    const { node, switched } = switchProps("personal")
    await render(node)
    await click(one("[data-account-chip]"))
    await click(one(OPT("work")))
    await click(byText('[data-confirm="pop"] button', "Switch to work"))
    await settle()

    expect(switched).toEqual(["work"])
    expect(maybe("[data-account-popover]")).toBeNull()
    expect((one("[data-toast]").textContent ?? "").replace(/\s+/g, " ")).toContain("your-app now runs as work")
  })

  test("picking the account it already runs as closes the popover and changes nothing", async () => {
    const { node, switched } = switchProps("personal")
    await render(node)
    await click(one("[data-account-chip]"))
    await click(one(OPT("personal")))

    expect(switched).toEqual([])
    expect(maybe('[data-confirm="pop"]')).toBeNull()
  })

  test("Escape closes it and gives focus back to the chip", async () => {
    const { node } = switchProps("personal")
    await render(node)
    const chip = one<HTMLButtonElement>("[data-account-chip]")
    await click(chip)
    expect(maybe("[data-account-popover]")).not.toBeNull()

    await press(one("[data-account-popover]"), "Escape")
    expect(maybe("[data-account-popover]")).toBeNull()
    expect(document.activeElement).toBe(chip)
  })

  test("focus follows the popover: into the confirmation, back to the list, out to the chip", async () => {
    const { node } = switchProps("personal")
    await render(node)
    const chip = one<HTMLButtonElement>("[data-account-chip]")
    await click(chip)
    expect(document.activeElement).toBe(one(OPT("personal")))

    await click(one(OPT("work")))
    expect(document.activeElement).toBe(byText('[data-confirm="pop"] button', "Switch to work"))

    await click(byText('[data-confirm="pop"] button', "Cancel"))
    expect(document.activeElement).toBe(one(OPT("personal")))

    /* The focused button unmounts when the popover closes. Focus must land
       somewhere deliberate, not on <body>. */
    await click(one(OPT("work")))
    await click(byText('[data-confirm="pop"] button', "Switch to work"))
    await settle()
    expect(document.activeElement).toBe(chip)
  })

  test("arrow keys move focus through the radios without picking one", async () =>{
    const { node, switched } = switchProps("personal")
    await render(node)
    await click(one("[data-account-chip]"))

    const first = one<HTMLButtonElement>(OPT("personal"))
    const second = one<HTMLButtonElement>(OPT("work"))
    await press(first, "ArrowDown")
    expect(document.activeElement).toBe(second)
    expect(switched).toEqual([])
    expect(maybe('[data-confirm="pop"]')).toBeNull()

    await press(second, "ArrowUp")
    expect(document.activeElement).toBe(first)
  })

  test("does not offer `Add an account` when nothing can receive one", async () => {
    const { node } = switchProps("personal")
    await render(node)
    await click(one("[data-account-chip]"))
    expect(all("[data-account-popover] button").map((b) => (b.textContent ?? "").trim())).not.toContain(
      "Add an account",
    )
  })

  test("offers `Add an account` when something can, and hands over what was typed", async () => {
    const added: Array<{ label: string; configDir: string }> = []
    await render(
      <api.AccountSwitch
        project={project("personal")}
        accounts={ACCOUNTS}
        onSwitchAccount={() => {}}
        onAddAccount={(a) => void added.push(a)}
      />,
    )
    await click(one("[data-account-chip]"))
    await click(byText("[data-account-popover] button", "Add an account"))

    await typeInto(one("#kp-acct-name"), "client-x")
    await typeInto(one("#kp-acct-dir"), "/home/you/.claude-client-x")
    await click(byText("[data-account-popover] button", "Add account"))

    expect(added).toEqual([{ label: "client-x", configDir: "/home/you/.claude-client-x" }])
  })

  test("refuses to add an account with a blank name or folder", async () => {
    const added: Array<{ label: string; configDir: string }> = []
    await render(
      <api.AccountSwitch
        project={project("personal")}
        accounts={ACCOUNTS}
        onSwitchAccount={() => {}}
        onAddAccount={(a) => void added.push(a)}
      />,
    )
    await click(one("[data-account-chip]"))
    await click(byText("[data-account-popover] button", "Add an account"))
    await typeInto(one("#kp-acct-name"), "   ")
    await click(byText("[data-account-popover] button", "Add account"))
    expect(added).toEqual([])
  })
})

describe("the test command, and proving it works", () => {
  test("shows the stored command and saves an edit once, on blur", async () => {
    const h = handlers()
    await render(<api.ProjectPanel project={project("personal")} accounts={ACCOUNTS} {...h.props} />)

    const field = one<HTMLInputElement>("#kp-testcmd")
    expect(field.value).toBe("npm test")

    await typeInto(field, "  bun test  ")
    expect(h.saved).toEqual([])
    await blurOf(field)
    expect(h.saved).toEqual(["bun test"])
  })

  test("saves on Enter too, and not twice for the same value", async () => {
    const h = handlers()
    await render(<api.ProjectPanel project={project("personal")} accounts={ACCOUNTS} {...h.props} />)
    const field = one<HTMLInputElement>("#kp-testcmd")

    await typeInto(field, "bun test")
    await press(field, "Enter")
    await blurOf(field)
    expect(h.saved).toEqual(["bun test"])
  })

  test("refuses to save a blank command, and says why", async () => {
    const h = handlers()
    await render(<api.ProjectPanel project={project("personal")} accounts={ACCOUNTS} {...h.props} />)
    const field = one<HTMLInputElement>("#kp-testcmd")

    await typeInto(field, "   ")
    await blurOf(field)
    expect(h.saved).toEqual([])
    expect(prose()).toContain("A test command is required")
  })

  test("offers `Run it now` only when something can run it", async () => {
    const h = handlers()
    await render(<api.ProjectPanel project={project("personal")} accounts={ACCOUNTS} {...h.props} />)
    expect(all("button").map((b) => (b.textContent ?? "").trim())).not.toContain("Run it now")

    await render(
      <api.ProjectPanel
        project={project("personal")}
        accounts={ACCOUNTS}
        onRunTest={() => Promise.resolve({ exitCode: 0 })}
        {...h.props}
      />,
    )
    expect(all("button").map((b) => (b.textContent ?? "").trim())).toContain("Run it now")
  })

  test("says what it is running while it runs, then prints the exit code", async () => {
    const h = handlers()
    const d = deferred<TestCommandResult>()
    await render(
      <api.ProjectPanel
        project={project("personal")}
        accounts={ACCOUNTS}
        onRunTest={() => d.promise}
        {...h.props}
      />,
    )
    await click(byText("button", "Run it now"))

    expect(one("[data-test-status]").getAttribute("role")).toBe("status")
    expect((one("[data-test-status]").textContent ?? "").replace(/\s+/g, " ")).toContain("Running npm test")

    d.resolve({ exitCode: 0, durationMs: 4100, summary: "12 passing" })
    await settle()

    expect((one("[data-exit-badge]").textContent ?? "").trim()).toBe("exit 0")
    expect(prose()).toContain("12 passing")
    expect(prose()).toContain("4.1s")
  })

  test("prints a non-zero code as the number it is, never as a verdict", async () => {
    const h = handlers()
    await render(
      <api.ProjectPanel
        project={project("personal")}
        accounts={ACCOUNTS}
        onRunTest={() => Promise.resolve({ exitCode: 1 })}
        {...h.props}
      />,
    )
    await click(byText("button", "Run it now"))
    await settle()

    const badge = one("[data-exit-badge]")
    expect((badge.textContent ?? "").trim()).toBe("exit 1")
    expect(badge.getAttribute("data-outcome")).toBe("fail")
    expect(prose()).not.toContain("looks good")
  })

  /**
   * The dimension is what the server can answer with. Its values are a zero
   * code, a non-zero code, no code with a signal, no code with a timeout, and
   * no code at all. Only the first may read as a pass; reading any other as
   * one is how an agent's "the tests pass" gets believed.
   */
  const outcomes: ReadonlyArray<{ name: string; result: TestCommandResult; reads: string; outcome: string }> = [
    { name: "a zero code", result: { exitCode: 0 }, reads: "exit 0", outcome: "pass" },
    { name: "a non-zero code", result: { exitCode: 7 }, reads: "exit 7", outcome: "fail" },
    { name: "a signal", result: { exitCode: null, signal: "SIGKILL" }, reads: "killed by SIGKILL", outcome: "fail" },
    { name: "a timeout", result: { exitCode: null, timedOut: true }, reads: "timed out", outcome: "fail" },
    { name: "nothing at all", result: { exitCode: null }, reads: "no exit code", outcome: "unknown" },
  ]

  for (const { name, result, reads, outcome } of outcomes) {
    test(`reads ${name} as ${JSON.stringify(reads)}`, async () => {
      const h = handlers()
      await render(
        <api.ProjectPanel
          project={project("personal")}
          accounts={ACCOUNTS}
          onRunTest={() => Promise.resolve(result)}
          {...h.props}
        />,
      )
      await click(byText("button", "Run it now"))
      await settle()

      const badge = one("[data-exit-badge]")
      expect((badge.textContent ?? "").trim()).toBe(reads)
      expect(badge.getAttribute("data-outcome")).toBe(outcome)
    })
  }

  /**
   * `canvas.json` draws the chip as "Badge + ShieldCheck", and the artboard
   * draws it only on `exit 0`. It stays there: `DESIGN.md` forbids a tick
   * standing in for a code, so a shield that reads "verified" beside a failing
   * number would be the defect the exit code exists to prevent.
   */
  test("wears the artboard's shield only when the code is zero", async () => {
    for (const [result, icons] of [
      [{ exitCode: 0 }, 1],
      [{ exitCode: 1 }, 0],
      [{ exitCode: null, signal: "SIGKILL" }, 0],
      [{ exitCode: null }, 0],
    ] as const) {
      const h = handlers()
      await render(
        <api.ProjectPanel
          project={project("personal")}
          accounts={ACCOUNTS}
          onRunTest={() => Promise.resolve(result)}
          {...h.props}
        />,
      )
      await click(byText("button", "Run it now"))
      await settle()
      expect(all("[data-exit-badge] svg")).toHaveLength(icons)
    }
  })

  test("drops a result that belongs to a command the field no longer holds", async () => {
    const h = handlers()
    const first = deferred<TestCommandResult>()
    const second = deferred<TestCommandResult>()
    const queue = [first, second]
    await render(
      <api.ProjectPanel
        project={project("personal")}
        accounts={ACCOUNTS}
        onRunTest={() => (queue.shift() ?? first).promise}
        {...h.props}
      />,
    )

    await click(byText("button", "Run it now"))
    await typeInto(one("#kp-testcmd"), "bun test")
    await click(byText("button", "Run it now"))

    /* The stale run answers last, and loudly. It must not be believed. */
    second.resolve({ exitCode: 1 })
    await settle()
    first.resolve({ exitCode: 0 })
    await settle()

    expect((one("[data-exit-badge]").textContent ?? "").trim()).toBe("exit 1")
  })

  test("forgets a result as soon as the command is edited", async () => {
    const h = handlers()
    await render(
      <api.ProjectPanel
        project={project("personal")}
        accounts={ACCOUNTS}
        onRunTest={() => Promise.resolve({ exitCode: 0 })}
        {...h.props}
      />,
    )
    await click(byText("button", "Run it now"))
    await settle()
    expect(maybe("[data-exit-badge]")).not.toBeNull()

    await typeInto(one("#kp-testcmd"), "bun test")
    expect(maybe("[data-exit-badge]")).toBeNull()
  })

  test("a run that could not even start is an error, not a green badge", async () => {
    const h = handlers()
    await render(
      <api.ProjectPanel
        project={project("personal")}
        accounts={ACCOUNTS}
        onRunTest={() => Promise.reject(new Error("a run is already holding this repo"))}
        {...h.props}
      />,
    )
    await click(byText("button", "Run it now"))
    await settle()

    expect(maybe("[data-exit-badge]")).toBeNull()
    expect(prose()).toContain("a run is already holding this repo")
  })
})

describe("task files", () => {
  test("lists every file kantan reads tasks from, with its count", async () => {
    const h = handlers()
    await render(<api.ProjectPanel project={project("personal")} accounts={ACCOUNTS} {...h.props} />)

    const rows = all("[data-files] li")
    expect(rows).toHaveLength(2)
    expect((rows[0]?.textContent ?? "").replace(/\s+/g, " ")).toContain("docs/features/importer.md")
    expect((rows[0]?.textContent ?? "").replace(/\s+/g, " ")).toContain("3 tasks")
    expect((rows[1]?.textContent ?? "").replace(/\s+/g, " ")).toContain("1 task")
  })

  test("says so when there are none, rather than drawing an empty box", async () => {
    const h = handlers()
    await render(<api.ProjectPanel project={project("personal", { features: [] })} accounts={ACCOUNTS} {...h.props} />)
    expect(prose()).toContain("No task file yet")
  })

  test("offers to stop tracking a file only when something can", async () => {
    const h = handlers()
    await render(<api.ProjectPanel project={project("personal")} accounts={ACCOUNTS} {...h.props} />)
    expect(maybe('[aria-label="Stop tracking docs/features/export.md"]')).toBeNull()

    const stopped: string[] = []
    await render(
      <api.ProjectPanel
        project={project("personal")}
        accounts={ACCOUNTS}
        onStopTracking={(p) => void stopped.push(p)}
        {...h.props}
      />,
    )
    await click(one('[aria-label="Stop tracking docs/features/export.md"]'))
    expect(stopped).toEqual(["docs/features/export.md"])
  })

  test("promises the file stays in the repo", async () => {
    const h = handlers()
    await render(<api.ProjectPanel project={project("personal")} accounts={ACCOUNTS} {...h.props} />)
    expect(prose()).toContain("leaves the file in your repo alone")
  })

  test("offers the combobox only when candidates and a handler both exist", async () => {
    const h = handlers()
    await render(<api.ProjectPanel project={project("personal")} accounts={ACCOUNTS} {...h.props} />)
    expect(maybe("#kp-newfile")).toBeNull()

    const added: string[] = []
    await render(
      <api.ProjectPanel
        project={project("personal")}
        accounts={ACCOUNTS}
        taskFileCandidates={[
          { path: "docs/features/search.md", taskCount: 4 },
          { path: "docs/roadmap.md", taskCount: 0 },
        ]}
        onAddTaskFile={(p) => void added.push(p)}
        {...h.props}
      />,
    )

    const field = one("#kp-newfile")
    expect(field.getAttribute("role")).toBe("combobox")
    expect(prose()).toContain("Found in the repo")
    expect(prose()).toContain("4 tasks found")
    expect(prose()).toContain("no tasks found")

    await click(one('[data-candidate="docs/features/search.md"]'))
    expect(added).toEqual(["docs/features/search.md"])
  })

  test("filters the candidates by what is typed, and can add a typed path", async () => {
    const h = handlers()
    const added: string[] = []
    await render(
      <api.ProjectPanel
        project={project("personal")}
        accounts={ACCOUNTS}
        taskFileCandidates={[
          { path: "docs/features/search.md", taskCount: 4 },
          { path: "docs/roadmap.md", taskCount: 0 },
        ]}
        onAddTaskFile={(p) => void added.push(p)}
        {...h.props}
      />,
    )

    await typeInto(one("#kp-newfile"), "roadmap")
    expect(all("[data-candidate]").map((c) => c.getAttribute("data-candidate"))).toEqual(["docs/roadmap.md"])

    await typeInto(one("#kp-newfile"), " docs/features/new.md ")
    await press(one("#kp-newfile"), "Enter")
    expect(added).toEqual(["docs/features/new.md"])
  })

  test("marks a candidate already tracked as added, and will not add it twice", async () => {
    const h = handlers()
    const added: string[] = []
    await render(
      <api.ProjectPanel
        project={project("personal")}
        accounts={ACCOUNTS}
        taskFileCandidates={[{ path: "docs/features/importer.md", taskCount: 3 }]}
        onAddTaskFile={(p) => void added.push(p)}
        {...h.props}
      />,
    )

    const row = one<HTMLButtonElement>('[data-candidate="docs/features/importer.md"]')
    expect((row.textContent ?? "").replace(/\s+/g, " ")).toContain("added")
    expect(row.disabled).toBe(true)
    await click(row)
    expect(added).toEqual([])
  })
})

describe("the default cost ceiling", () => {
  test("appears only when there is a figure and somewhere to send it", async () => {
    const h = handlers()
    await render(<api.ProjectPanel project={project("personal")} accounts={ACCOUNTS} {...h.props} />)
    expect(maybe("#kp-ceiling")).toBeNull()

    const budgets: number[] = []
    await render(
      <api.ProjectPanel
        project={project("personal")}
        accounts={ACCOUNTS}
        budgetUsd={50}
        onSaveBudget={(n) => void budgets.push(n)}
        {...h.props}
      />,
    )
    expect(one<HTMLInputElement>("#kp-ceiling").value).toBe("50.00")
  })

  test("saves a changed figure on blur", async () => {
    const h = handlers()
    const budgets: number[] = []
    await render(
      <api.ProjectPanel
        project={project("personal")}
        accounts={ACCOUNTS}
        budgetUsd={50}
        onSaveBudget={(n) => void budgets.push(n)}
        {...h.props}
      />,
    )
    await typeInto(one("#kp-ceiling"), "80")
    await blurOf(one("#kp-ceiling"))
    expect(budgets).toEqual([80])
  })

  /** `src/projects.ts` refuses a non-positive budget, so the field does too. */
  for (const bad of ["", "   ", "0", "-5", "abc"]) {
    test(`refuses ${JSON.stringify(bad)} as a ceiling`, async () => {
      const h = handlers()
      const budgets: number[] = []
      await render(
        <api.ProjectPanel
          project={project("personal")}
          accounts={ACCOUNTS}
          budgetUsd={50}
          onSaveBudget={(n) => void budgets.push(n)}
          {...h.props}
        />,
      )
      await typeInto(one("#kp-ceiling"), bad)
      await blurOf(one("#kp-ceiling"))
      expect(budgets).toEqual([])
      expect(prose()).toContain("A ceiling is a number of dollars above zero")
    })
  }
})

describe("removing the project: the only modal", () => {
  async function open(onRemove: () => void | Promise<void> = () => {}) {
    const h = handlers()
    await render(<api.ProjectPanel project={project("personal")} accounts={ACCOUNTS} {...h.props} onRemove={onRemove} />)
    const trigger = byText<HTMLButtonElement>("button", "Remove your-app")
    await click(trigger)
    return { h, trigger }
  }

  /**
   * The copy the artboard gets wrong. `docs/design/Project.dc.html` says
   * removal "deletes its run history" in both the section blurb and the
   * dialog. `src/projects.ts`'s `removeProject` deliberately leaves run logs
   * where they are - they are the record of work that cost real money and
   * nothing can rebuild one - and `src/runindex.ts` brings them all back when
   * the same path is registered again. A confirmation that invents a deletion
   * invites the reader to imagine the worse thing, so the implementation's
   * truth wins over the artboard's text.
   */
  test("the copy the artboard gets wrong: nothing on disk is touched and no history is deleted", async () => {
    const h = handlers()
    await render(<api.ProjectPanel project={project("personal")} accounts={ACCOUNTS} {...h.props} />)
    const section = (one("[data-danger]").textContent ?? "").replace(/\s+/g, " ")
    expect(section).toContain("nothing is deleted from disk")
    expect(section).not.toContain("run history is deleted")

    await click(byText("button", "Remove your-app"))
    const said = (one('[role="alertdialog"][aria-modal="true"]').textContent ?? "").replace(/\s+/g, " ")
    expect(said).toContain("kantan stops tracking it")
    expect(said).toContain("nothing is deleted from disk")
    expect(said).toContain("You can add it again")
    expect(said).not.toContain("deletes its run history")
  })

  test("is the only modal, and a real dialog while it is open", async () => {
    await open()
    const dialog = one('[role="alertdialog"][aria-modal="true"]')
    expect(all("[aria-modal]")).toHaveLength(1)
    expect(dialog.getAttribute("aria-labelledby")).not.toBeNull()
    expect(dialog.getAttribute("aria-describedby")).not.toBeNull()
    expect(one(`#${dialog.getAttribute("aria-labelledby")}`).textContent).toContain("Remove your-app from kantan?")
  })

  test("opens with focus on the safe choice", async () => {
    await open()
    expect(document.activeElement).toBe(byText("button", "Keep it"))
  })

  test("traps Tab inside itself, both ways", async () => {
    await open()
    const focusable = all<HTMLElement>('[role="alertdialog"] button')
    const first = focusable[0]
    const last = focusable.at(-1)
    if (first === undefined || last === undefined) throw new Error("the dialog has no buttons")

    last.focus()
    await press(last, "Tab")
    expect(document.activeElement).toBe(first)

    await press(first, "Tab", { shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  test("Escape closes it, removes nothing, and gives focus back to the button that opened it", async () => {
    const { h, trigger } = await open()
    await press(one('[role="alertdialog"]'), "Escape")

    expect(maybe('[role="alertdialog"][aria-modal="true"]')).toBeNull()
    expect(h.removed).toEqual([])
    expect(document.activeElement).toBe(trigger)
  })

  test("`Keep it` closes it and removes nothing", async () => {
    const { h } = await open()
    await click(byText('[role="alertdialog"] button', "Keep it"))
    expect(maybe('[role="alertdialog"][aria-modal="true"]')).toBeNull()
    expect(h.removed).toEqual([])
  })

  test("`Remove project` removes, once, and says it is working", async () => {
    const d = deferred<void>()
    const calls: number[] = []
    const { trigger } = await open(() => {
      calls.push(1)
      return d.promise
    })

    const go = byText<HTMLButtonElement>('[role="alertdialog"] button', "Remove project")
    await click(go)
    expect(calls).toEqual([1])
    expect(byText<HTMLButtonElement>('[role="alertdialog"] button', "Removing…").disabled).toBe(true)

    /* A second press while it is in flight must not remove twice. */
    await click(byText('[role="alertdialog"] button', "Removing…"))
    expect(calls).toEqual([1])

    d.resolve()
    await settle()
    expect(maybe('[role="alertdialog"][aria-modal="true"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  test("a failed removal is shown inside the dialog, which stays open", async () => {
    await open(() => Promise.reject(new Error("a run is in flight for this project")))
    await click(byText('[role="alertdialog"] button', "Remove project"))
    await settle()

    const dialog = one('[role="alertdialog"][aria-modal="true"]')
    expect((dialog.textContent ?? "").replace(/\s+/g, " ")).toContain("a run is in flight for this project")
    expect(one('[role="alertdialog"] [role="alert"]')).toBeDefined()
  })

  test("the scrim is reachable by the reduced-motion kill-switch", async () => {
    await open()
    expect(classesOf("[data-scrim]")).toContain("kr")
  })

  /**
   * A screenshot caught this; no assertion in this file did, which is exactly
   * what `CLAUDE.md`'s screenshot rule says to expect.
   *
   * `.bf` is `animation: kfade ... both`, and `kfade` ends on `filter:
   * blur(0)`. `blur(0)` is a filter, not `none`, so the fill mode leaves one
   * applied forever - and **an element with a filter is the containing block
   * for its `position: fixed` descendants**. The scrim rendered inside the
   * card was therefore laid out against the card rather than the viewport, and
   * then clipped by the card's `overflow: clip`: a quarter-size scrim with the
   * dialog cut in half. Every DOM assertion passed.
   *
   * So the invariant is structural, and it is the cause rather than the
   * symptom: neither fixed layer may sit under an animated ancestor. The
   * artboard already places both outside the card - this is fidelity, not a
   * workaround.
   */
  test("no fixed layer sits inside an animated ancestor, which would trap it", async () => {
    const h = handlers()
    await render(<api.ProjectPanel project={project("personal")} accounts={ACCOUNTS} {...h.props} />)
    await click(byText("button", "Remove your-app"))
    await click(byText('[role="alertdialog"] button', "Keep it"))

    await click(one(CARD("work")))
    await click(byText('[data-confirm="panel"] button', "Switch to work"))
    await settle()
    await click(byText("button", "Remove your-app"))

    for (const selector of ["[data-scrim]", "[data-toast]"]) {
      let node: HTMLElement | null = one<HTMLElement>(selector).parentElement
      while (node !== null && node !== host) {
        const classes = (node.getAttribute("class") ?? "").split(/\s+/)
        expect({ selector, ancestor: node.tagName, classes }).toEqual({
          selector,
          ancestor: node.tagName,
          classes: expect.not.arrayContaining(["bf", "pop", "dim", "toast", "ring", "spin"]),
        })
        node = node.parentElement
      }
    }
  })
})

describe("motion stops when it is asked to", () => {
  test("ships the artboard's own keyframe classes when motion is welcome", async () => {
    const h = handlers()
    await render(
      <api.ProjectPanel
        project={project("personal")}
        accounts={ACCOUNTS}
        onRunTest={() => Promise.resolve({ exitCode: 0 })}
        {...h.props}
      />,
    )

    expect(one("[data-panel]").getAttribute("data-motion")).toBe("animated")
    expect(classesOf("[data-card-section]")).toContain("bf")
    expect(classesOf("[data-card-section]")).toContain("d1")
    expect(all("[data-ring-arc]").every((a) => (a.getAttribute("class") ?? "").includes("ring"))).toBe(true)

    await click(one(CARD("work")))
    expect(classesOf('[data-confirm="panel"]')).toContain("pop")
    await click(byText('[data-confirm="panel"] button', "Switch to work"))
    await settle()
    expect(classesOf("[data-toast]")).toContain("toast")
  })

  test("drops every one of them when the live media query says reduce", async () => {
    setPrefersReduce(true)
    const h = handlers()
    await render(<api.ProjectPanel project={project("personal")} accounts={ACCOUNTS} {...h.props} />)

    expect(one("[data-panel]").getAttribute("data-motion")).toBe("static")
    expect(classesOf("[data-card-section]")).not.toContain("bf")
    expect(classesOf("[data-card-section]")).not.toContain("d1")
    expect(all("[data-ring-arc]").some((a) => (a.getAttribute("class") ?? "").includes("ring"))).toBe(false)

    await click(one(CARD("work")))
    expect(classesOf('[data-confirm="panel"]')).not.toContain("pop")
    await click(byText('[data-confirm="panel"] button', "Switch to work"))
    await settle()
    expect(classesOf("[data-toast]")).not.toContain("toast")
  })

  test("holds the scrim and the dialog still too", async () => {
    setPrefersReduce(true)
    const h = handlers()
    await render(<api.ProjectPanel project={project("personal")} accounts={ACCOUNTS} {...h.props} />)
    await click(byText("button", "Remove your-app"))

    expect(classesOf("[data-scrim]")).not.toContain("dim")
    expect(classesOf('[role="alertdialog"][aria-modal="true"]')).not.toContain("pop")
  })

  test("still draws the ring arc, because the geometry is not the animation", async () => {
    setPrefersReduce(true)
    const h = handlers()
    await render(<api.ProjectPanel project={project("personal")} accounts={ACCOUNTS} {...h.props} />)

    const arcs = all<SVGCircleElement>("[data-ring-arc]")
    expect(arcs[0]?.getAttribute("stroke-dashoffset")).toBe(String(api.ringOffset(0.41)))
  })

  test("the popover and its rings go still as well", async () => {
    setPrefersReduce(true)
    await render(
      <api.AccountSwitch project={project("personal")} accounts={ACCOUNTS} onSwitchAccount={() => {}} />,
    )
    await click(one("[data-account-chip]"))

    expect(classesOf("[data-account-popover]")).not.toContain("pop")
    expect(all("[data-ring-arc]").some((a) => (a.getAttribute("class") ?? "").includes("ring"))).toBe(false)
  })
})
