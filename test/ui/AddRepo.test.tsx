/**
 * Adding a repository: `docs/design/AddRepo.dc.html`, and the failure that
 * screen exists to prevent.
 *
 * ## What is actually at risk in this component
 *
 * **It has already failed a user in production.** They typed a path, pressed
 * add, and got
 *
 *     that repository could not be added: 400 {"error":"/home/laithalenooz/…
 *     is not a usable git repository: fatal: cannot change to '…'"}
 *
 * The machine's home is `/home/lalenooz`. The real fault was four characters in
 * the home directory, the sentence named git, and it arrived only *after*
 * submitting. So the assertions below are mostly about **when a green tick is
 * allowed to be on screen**, not about how it is drawn.
 *
 * **Every answer the panel shows is about a string the user is mid-typing.** A
 * detection result belongs to the path it was asked about and to no other, so
 * the freshness rule is the subject of the first and largest matrix here:
 * `detection.path === path`, byte for byte, with no trim, no trailing-slash
 * fix, no `~` expansion and no Unicode normalisation. `CLAUDE.md`'s
 * skipping-guard rule is explicit that the risk of such a rule is its worst
 * case, and the worst case of a loose comparison is the production failure
 * above with a tick beside it.
 *
 * The cost is asymmetric, which is what picks the rule: reading a result as
 * **stale when it was fresh** costs one press of Check, and reading it as
 * **fresh when it was stale** shows "Git repository · on main" for a directory
 * that does not exist and enables the button. So every row of the matrix that
 * is not byte-identical must read as stale.
 *
 * **The checks must mirror `src/git.ts`'s `requireUsableRepo`**, because that
 * function is what registration will actually enforce. Its sentences are
 * asserted verbatim — including the one that finds the typo, *"The deepest part
 * of that path which does exist is /home"* — because the component must never
 * re-author a message from a code. Re-authoring is how that sentence would be
 * lost, and it is the only one that locates the mistake.
 *
 * **The probe can fail without the path being wrong.** The endpoint does not
 * exist yet (see the file header of `src/ui/AddRepo.tsx`). A 404, a 500 or a
 * dropped connection is not a verdict about the folder, and if it blocked the
 * button nothing could be registered at all — so `unknown` is a sixth state
 * with its own row in the matrix, and it must leave Add usable.
 *
 * **Reduced motion.** A progressive form is a staggered entrance: four blur
 * fades, a spinner and an animated list. `CLAUDE.md` records Motion's
 * `useReducedMotion()` as a module-level singleton that has answered `false`
 * with the media feature actually set, so the component ORs it with a live
 * `matchMedia` read. In here Motion's half is quarantined to `false`, which is
 * exactly the stale state `docs/HANDOFF.md` says such a test must create — so
 * these assertions exercise the **live** half, and deleting it turns this file
 * red on its own.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
/* Value import, and the only one: `react` has no DOM in it, so pulling it in
   before the window exists is safe where `react-dom/client` would not be. */
import * as React from "react"

/* Type-only, so nothing here is evaluated before the window exists. */
import type { AddRepoProps, Detection, DetectionCheck, RepoDraft } from "../../src/ui/AddRepo.tsx"

/*
 * The window is taken only if the slot is free, and **never given back**.
 *
 * `docs/HANDOFF.md`: `bun test` loads one file at a time, so an `unregister()`
 * in this file's `afterAll` would close the window before a later UI suite is
 * loaded — and `motion`, already imported and already seeded, holds the first
 * window's media query and timing primitives in module state nothing can
 * re-seed. That is how another agent's cost ticker silently froze.
 */
let ownsDocument = false

interface Api {
  act: typeof import("react").act
  StrictMode: typeof import("react").StrictMode
  createRoot: typeof import("react-dom/client").createRoot
  AddRepo: typeof import("../../src/ui/AddRepo.tsx").AddRepo
  repoLabel: typeof import("../../src/ui/AddRepo.tsx").repoLabel
}

// --- The reduced-motion media feature ---------------------------------------

/**
 * Two query objects, and the split is not cosmetic.
 *
 * `bun test` runs every file in one process and Motion keeps its reduced-motion
 * answer in a module-level singleton seeded at the **first call anywhere in
 * that process**, then updated from that query's own `change` events. A stub
 * matching the feature loosely would hand Motion the same object this file
 * toggles, and every `setPrefersReduce(true)` here would reach into Motion's
 * process-wide state and stay there.
 *
 * So the two are kept apart by their exact strings: the component asks
 * `(prefers-reduced-motion: reduce)` and gets `reduceQuery`; Motion asks
 * `(prefers-reduced-motion)` and gets a quarantined one that is always `false`
 * and whose listeners are never fired. The pattern is `test/ui/Empty.test.tsx`'s
 * and `test/ui/Chrome.test.tsx`'s.
 *
 * It is also the state the real trap occurs in: Motion's answer is permanently
 * stale here, so the live read is the only thing that can report the
 * preference, and removing it fails these tests rather than passing by luck.
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

/**
 * The preference flipped **without** firing `change`, which is the state
 * `docs/HANDOFF.md` says a reduced-motion test has to create: a stub that
 * fires `change` repairs Motion's singleton as a side effect and quietly fixes
 * the bug it was written to catch.
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

  /* The stub goes in before `AddRepo.tsx` is pulled in: `motion-dom` decides
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
  const mod = await import("../../src/ui/AddRepo.tsx")
  api = {
    act: react.act,
    StrictMode: react.StrictMode,
    createRoot: client.createRoot,
    AddRepo: mod.AddRepo,
    repoLabel: mod.repoLabel,
  }
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
  try {
    await api.act(async () => {
      root.unmount()
    })
  } finally {
    host.remove()
    setPrefersReduce(false)
  }
})

/**
 * The shell's half of the path.
 *
 * `path` is a controlled prop, so typing in the field is only half the story:
 * the parent has to hand the new string back. This is that parent, and it
 * deliberately leaves `detection` alone — which is exactly the real moment the
 * freshness guard exists for, one keystroke after a result arrived and before
 * the debounce has fired again.
 */
function Shell({ startingPath, ...rest }: Omit<AddRepoProps, "path"> & { startingPath: string }): React.ReactElement {
  const [here, setHere] = React.useState(startingPath)
  return (
    <api.AddRepo
      {...rest}
      path={here}
      onPathChange={(value) => {
        setHere(value)
        rest.onPathChange(value)
      }}
    />
  )
}

async function render(ui: React.ReactNode): Promise<void> {
  await api.act(async () => {
    root.render(ui)
  })
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

/** The class attribute, split, so a missing rung is named rather than hidden. */
function classesOf(selector: string): string[] {
  return (one(selector).getAttribute("class") ?? "").split(/\s+/).filter((c) => c !== "")
}

/** Everything the subtree says, with runs of whitespace flattened. */
function prose(): string {
  return (host.textContent ?? "").replace(/\s+/g, " ").trim()
}

/** The first element matching `selector` whose trimmed text is exactly `text`. */
function byText<E extends Element>(selector: string, text: string): E {
  const hit = all<E>(selector).find((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim() === text)
  if (hit === undefined) throw new Error(`no ${selector} reading exactly ${JSON.stringify(text)}`)
  return hit
}

async function click(el: Element): Promise<void> {
  await api.act(async () => {
    ;(el as HTMLElement).click()
  })
}

/**
 * Types into a controlled input.
 *
 * Through the prototype's own setter, not `input.value =`: React installs a
 * value tracker on the node, and assigning past it leaves React's idea of the
 * value and the DOM's disagreeing — which crashes its change plugin rather than
 * failing an assertion. The descriptor is read lazily because
 * `HTMLInputElement` does not exist until the window is registered.
 * `test/ui/Gate.test.tsx` does the same for textareas.
 */
async function type(input: HTMLInputElement, value: string): Promise<void> {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  if (set === undefined) throw new Error("no native input value setter to type through")
  await api.act(async () => {
    set.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

async function pressEnter(input: HTMLInputElement): Promise<void> {
  await api.act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
  })
}

// --- Handles ----------------------------------------------------------------

const PATH_FIELD = 'input[data-addrepo="path"]'
const CMD_FIELD = 'input[data-addrepo="cmd"]'
/** The one control allowed to mean "no command", spelled once. */
const NO_SUITE = "This project has no test suite"
const ADD_BUTTON = 'button[data-addrepo="add"]'
const CHECK_BUTTON = 'button[data-addrepo="check"]'
const PREVIEW = '[data-addrepo="preview"]'

function pathField(): HTMLInputElement {
  return one<HTMLInputElement>(PATH_FIELD)
}

function addButton(): HTMLButtonElement {
  return one<HTMLButtonElement>(ADD_BUTTON)
}

function section(n: 1 | 2 | 3 | 4): HTMLElement | null {
  return maybe<HTMLElement>(`[data-section="${n}"]`)
}

/**
 * Chooses an account.
 *
 * By attribute rather than by text: an account card prints its ring
 * percentage, its name and its profile directory, so there is no element whose
 * text is the word alone.
 */
async function pickAccount(kind: "personal" | "work" | "unknown"): Promise<void> {
  await click(one(`[data-account="${kind}"]`))
}

/** Chooses one specific profile, which `kind` alone cannot name. */
async function pickProfile(kind: "personal" | "work", configDir: string): Promise<void> {
  await click(one(`[data-account-key="${kind}\\0${configDir}"]`))
}

function checkedAccountKeys(): string[] {
  return all('[role="radio"]')
    .filter((el) => el.getAttribute("aria-checked") === "true")
    .map((el) => el.getAttribute("data-account-key") ?? "")
}

/** The detection list, as text per row, or `null` when no list is drawn. */
function detectionRows(): string[] | null {
  const list = maybe('[data-addrepo="checks"]')
  if (list === null) return null
  return [...list.querySelectorAll("li")].map((li) => (li.textContent ?? "").replace(/\s+/g, " ").trim())
}

// --- Fixtures ---------------------------------------------------------------

const USABLE_PATH = "/home/lalenooz/projects/kantan"

/** The three lines the artboard draws for a healthy repository. */
const HEALTHY: DetectionCheck[] = [
  { code: "repo", status: "pass", says: ["Git repository · on ", { mono: "main" }, ", no uncommitted changes"] },
  { code: "tests", status: "pass", says: [{ mono: "package.json" }, " has a ", { mono: "test" }, " script"] },
  { code: "tasks", status: "pass", says: ["2 markdown files with tasks under ", { mono: "docs/" }] },
]

function usable(path = USABLE_PATH, extra: Partial<Extract<Detection, { phase: "done" }>> = {}): Detection {
  return {
    phase: "done",
    path,
    usable: true,
    root: path,
    checks: HEALTHY,
    taskFiles: [
      { path: "docs/features/importer.md", tasks: [
        { ref: "T1", text: "Parse the manifest" },
        { ref: "T2", text: "Map records to rows" },
        { ref: "T3", text: "Runtime shim (v1.2)" },
      ] },
      { path: "docs/features/export.md", tasks: [{ ref: "T1", text: "Stream CSV export" }] },
    ],
    ...extra,
  }
}

/** Everything `AddRepo` requires, with the handlers recording what they saw. */
function props(over: Partial<AddRepoProps> = {}): AddRepoProps {
  return {
    path: "",
    onPathChange: () => {},
    detection: { phase: "idle" },
    onCheck: () => {},
    onSubmit: () => {},
    onCancel: () => {},
    ...over,
  }
}

/** A panel whose path is detected and usable: sections 1 and 2 are open. */
function checked(over: Partial<AddRepoProps> = {}): AddRepoProps {
  return props({ path: USABLE_PATH, detection: usable(), ...over })
}

/**
 * Walks the form to the end: path checked, account chosen, command typed.
 * Returns the draft slot the submit handler fills.
 */
async function fillIn(over: Partial<AddRepoProps> = {}): Promise<{ drafts: RepoDraft[] }> {
  const drafts: RepoDraft[] = []
  const { path: startingPath, ...rest } = checked({ onSubmit: (d) => void drafts.push(d), ...over })
  await render(<Shell startingPath={startingPath} {...rest} />)
  await pickAccount("personal")
  await type(one<HTMLInputElement>(CMD_FIELD), "bun test")
  return { drafts }
}

/**
 * The artboard's own bytes, copied out of `docs/design/AddRepo.dc.html` rather
 * than retyped from a summary of it. Straight apostrophes, because that file
 * has them, and the ellipsis in the placeholder is one character.
 */
const ARTBOARD = {
  heading: "Add a repository",
  lede: "Four things kantan needs to know. It checks as much as it can itself, so most of this fills in on its own.",
  where: "Where is it?",
  placeholder: "/home/you/code/…",
  check: "Check",
  checking: "Looking at the folder…",
  account: "Which Claude account runs it?",
  accountWhy: "Billing and the 5-hour limit follow this. You can change it later from the project.",
  tests: "How do you run the tests?",
  testsWhy: "kantan decides pass or fail from this command's exit code alone.",
  runOnce: "Run it once",
  tasks: "Where are the tasks?",
  cancel: "Cancel",
  previewTitle: "How it will look",
  previewFoot: "Every task starts as open. Nothing runs until you press start.",
} as const

/* ========================================================================== */
/* 1. Freshness: when a tick is allowed on screen                             */
/* ========================================================================== */

describe("a detection answers for one path and no other", () => {
  /**
   * The dimension this guard reads is **the relationship between the string in
   * the box and the string the detection was asked about** — not the path, and
   * not whether it looks plausible. Every value that dimension can take is a
   * row here, including the ones no earlier test produced.
   */
  const ROWS: ReadonlyArray<{ why: string; typed: string; detected: string; fresh: boolean }> = [
    { why: "byte-identical", typed: USABLE_PATH, detected: USABLE_PATH, fresh: true },
    { why: "a trailing space", typed: `${USABLE_PATH} `, detected: USABLE_PATH, fresh: false },
    { why: "a leading space", typed: ` ${USABLE_PATH}`, detected: USABLE_PATH, fresh: false },
    { why: "a trailing slash", typed: `${USABLE_PATH}/`, detected: USABLE_PATH, fresh: false },
    { why: "a different case", typed: "/home/lalenooz/projects/Kantan", detected: USABLE_PATH, fresh: false },
    { why: "an unexpanded tilde", typed: "~/projects/kantan", detected: USABLE_PATH, fresh: false },
    { why: "an empty box", typed: "", detected: USABLE_PATH, fresh: false },
    { why: "one more segment", typed: `${USABLE_PATH}/src`, detected: USABLE_PATH, fresh: false },
    { why: "one segment fewer", typed: "/home/lalenooz/projects", detected: USABLE_PATH, fresh: false },
    /* Decomposed vs composed: two different filenames on a Linux filesystem,
       and one `normalize()` away from reading as the same string. */
    { why: "the other Unicode normalisation", typed: "/home/lalenooz/café", detected: "/home/lalenooz/café", fresh: false },
  ]

  for (const row of ROWS) {
    test(`${row.fresh ? "shows its result for" : "ignores a result that differs by"} ${row.why}`, async () => {
      await render(<api.AddRepo {...props({ path: row.typed, detection: usable(row.detected) })} />)

      if (row.fresh) {
        expect(detectionRows()).toEqual([
          "Git repository · on main, no uncommitted changes",
          "package.json has a test script",
          "2 markdown files with tasks under docs/",
        ])
      } else {
        expect(detectionRows()).toBeNull()
        expect(prose()).not.toContain("Git repository")
      }
    })
  }

  test("a stale result cannot be added, however green it was", async () => {
    const seen: RepoDraft[] = []
    const { drafts } = await fillIn({ onSubmit: (d) => void seen.push(d) })
    void drafts
    expect(addButton().disabled).toBe(false)

    /* One character, which is all it takes for the answer on screen to be
       about a directory the user is no longer naming. */
    await type(pathField(), `${USABLE_PATH}x`)
    expect(addButton().disabled).toBe(true)
    expect(detectionRows()).toBeNull()
  })

  test("a stale result registers nothing, and the button says so", async () => {
    /**
     * What this can and cannot see, because the difference matters.
     *
     * It pins the reachable guarantee: with an answer that is about another
     * path, the control is `disabled` and a click through it registers
     * nothing. The `disabled` is asserted as well as the silence, or the test
     * would pass just as well if the button were missing altogether.
     *
     * It does **not** pin the re-read inside `submit`. Probed: React delivers
     * no `onClick` to a disabled form control, through either `.click()` or a
     * dispatched `MouseEvent`, so that branch is unreachable from here and
     * deleting it leaves this file green. It is kept as the second belt on a
     * one-line path — the attribute is the first — and this comment is here so
     * nobody reads the green as cover for it.
     */
    const seen: RepoDraft[] = []
    await render(
      <api.AddRepo
        {...props({ path: USABLE_PATH, detection: usable(`${USABLE_PATH}-other`), onSubmit: (d) => void seen.push(d) })}
      />,
    )
    expect(addButton().disabled).toBe(true)
    await click(addButton())
    expect(seen).toEqual([])
  })

  test("while checking, the previous answer is gone and the spinner says so", async () => {
    await render(<api.AddRepo {...props({ path: USABLE_PATH, detection: { phase: "checking", path: USABLE_PATH } })} />)
    expect(prose()).toContain(ARTBOARD.checking)
    expect(detectionRows()).toBeNull()
    expect(one('[role="status"]')).toBeDefined()
  })

  test("an idle detection draws no list at all", async () => {
    await render(<api.AddRepo {...props({ path: USABLE_PATH })} />)
    expect(detectionRows()).toBeNull()
    expect(prose()).not.toContain(ARTBOARD.checking)
  })
})

/* ========================================================================== */
/* 2. Every way `requireUsableRepo` refuses                                   */
/* ========================================================================== */

describe("the refusals `src/git.ts` will actually make", () => {
  /**
   * One row per refusal in `requireUsableRepo`, with the sentence it throws,
   * including the clause that found the production typo. The component renders
   * the server's prose verbatim and reaches no verdict of its own: `usable`
   * decides the button, `status` decides the glyph, and the words are whatever
   * came over the wire.
   */
  const REFUSALS: ReadonlyArray<{ code: DetectionCheck["code"]; says: string }> = [
    {
      code: "directory",
      says:
        "there is no directory at /home/laithalenooz/projects/kantan." +
        " The deepest part of that path which does exist is /home - check the spelling of what comes after it.",
    },
    {
      code: "directory",
      says:
        "/home/lalenooz/projects/kantan/README.md is a file, not a directory, so it cannot be a repository." +
        " Register the directory that contains your project.",
    },
    {
      code: "repo",
      says: "/home/lalenooz/tmp is not a usable git repository: fatal: not a git repository",
    },
    {
      code: "worktree",
      says:
        "/home/lalenooz/mirror.git is a bare git repository, so it has no working tree for an agent to edit." +
        " Register a checkout of it instead.",
    },
    {
      code: "root",
      says:
        "/home/lalenooz/projects/kantan/src is not the root of a git repository; it sits inside the one rooted at" +
        " /home/lalenooz/projects/kantan. Register that root, or make this directory a repository of its own -" +
        " kantan commits at the root, and a run here would commit there.",
    },
    {
      code: "commits",
      says:
        "/home/lalenooz/projects/fresh has no commits yet, so orch/<task> has no base commit to branch from." +
        " Make the first commit, then start the run.",
    },
    {
      code: "absolute",
      says: 'project: path must be an absolute repo path, got "~/projects/kantan"',
    },
    {
      code: "registered",
      says:
        "/home/lalenooz/projects/kantan is already registered in /home/lalenooz/.kantan/projects.json," +
        " so there is nothing to add.",
    },
  ]

  for (const refusal of REFUSALS) {
    test(`${refusal.code}: says what the server says, and blocks the button`, async () => {
      const path = "/home/laithalenooz/projects/kantan"
      await render(
        <api.AddRepo
          {...props({
            path,
            detection: {
              phase: "done",
              path,
              usable: false,
              checks: [{ code: refusal.code, status: "fail", says: [refusal.says] }],
            },
          })}
        />,
      )

      /* Verbatim. A component that rebuilt this from `code` would lose the
         "deepest part of that path which does exist" clause, which is the only
         sentence that points at the typo. */
      expect(detectionRows()).toEqual([refusal.says])
      expect(addButton().disabled).toBe(true)
    })
  }

  test("the typo sentence survives whitespace flattening in the DOM", async () => {
    /* The reason this is its own test: the sentence is long enough to wrap, and
       the fix it carries is a substring in the middle of it. */
    const path = "/home/laithalenooz/projects/kantan"
    const says = REFUSALS[0]?.says ?? ""
    await render(
      <api.AddRepo
        {...props({
          path,
          detection: { phase: "done", path, usable: false, checks: [{ code: "directory", status: "fail", says: [says] }] },
        })}
      />,
    )
    expect(prose()).toContain("The deepest part of that path which does exist is /home")
  })

  test("a failing check is marked as one, not just coloured", async () => {
    const path = "/nope"
    await render(
      <api.AddRepo
        {...props({
          path,
          detection: {
            phase: "done",
            path,
            usable: false,
            checks: [
              { code: "directory", status: "fail", says: ["there is no directory at /nope."] },
              { code: "repo", status: "info", says: ["nothing else was checked"] },
            ],
          },
        })}
      />,
    )
    const rows = all('[data-addrepo="checks"] li')
    expect(rows.map((li) => li.getAttribute("data-status"))).toEqual(["fail", "info"])
    /* A colour is not a reading. Something has to say it in words. */
    expect(rows[0]?.textContent).toContain("there is no directory at /nope.")
    /* The word reaches a screen reader as the glyph's accessible name, not as
       text in the row: a colour is not a reading, and the server's sentence
       must not have "failed" spliced into the middle of it. */
    expect(rows[0]?.querySelector("[data-glyph-label]")?.getAttribute("data-glyph-label")).toBe("failed")
    expect(rows[0]?.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("failed")
  })

  test("an unusable path reveals nothing further", async () => {
    const path = "/nope"
    await render(
      <api.AddRepo
        {...props({
          path,
          detection: {
            phase: "done",
            path,
            usable: false,
            checks: [{ code: "directory", status: "fail", says: ["there is no directory at /nope."] }],
          },
        })}
      />,
    )
    expect(section(2)).toBeNull()
    expect(section(3)).toBeNull()
    expect(section(4)).toBeNull()
  })
})

/* ========================================================================== */
/* 3. The probe failing is not the path failing                               */
/* ========================================================================== */

describe("when the check itself cannot be done", () => {
  /* The endpoint does not exist yet, so this is today's behaviour and not an
     edge: a 404 must not make the product unusable. */
  const BROKEN: Detection = {
    phase: "unknown",
    path: USABLE_PATH,
    why: "kantan could not check that folder: 404",
  }

  test("says so, without claiming anything about the folder", async () => {
    await render(<api.AddRepo {...props({ path: USABLE_PATH, detection: BROKEN })} />)
    expect(prose()).toContain("kantan could not check that folder: 404")
    expect(prose()).not.toContain("Git repository")
  })

  test("still lets the repository be added", async () => {
    const drafts: RepoDraft[] = []
    await render(
      <api.AddRepo {...props({ path: USABLE_PATH, detection: BROKEN, onSubmit: (d) => void drafts.push(d) })} />,
    )
    await pickAccount("personal")
    await type(one<HTMLInputElement>(CMD_FIELD), "bun test")
    expect(addButton().disabled).toBe(false)
    await click(addButton())
    expect(drafts).toEqual([{ path: USABLE_PATH, testCmd: "bun test", account: "personal" }])
  })

  test("an unknown answer is as stale as any other when the path moves on", async () => {
    await render(<api.AddRepo {...props({ path: `${USABLE_PATH}x`, detection: BROKEN })} />)
    expect(prose()).not.toContain("could not check")
    expect(section(2)).toBeNull()
  })
})

/* ========================================================================== */
/* 4. Progressive disclosure                                                  */
/* ========================================================================== */

describe("the form appears as it is answered", () => {
  test("only the path is asked for at first", async () => {
    await render(<api.AddRepo {...props()} />)
    expect(section(1)).not.toBeNull()
    expect(section(2)).toBeNull()
    expect(section(3)).toBeNull()
    expect(section(4)).toBeNull()
  })

  test("a usable path opens the account question", async () => {
    await render(<api.AddRepo {...checked()} />)
    expect(section(2)).not.toBeNull()
    expect(section(3)).toBeNull()
  })

  test("an answered account opens the test command, which opens the task files", async () => {
    await render(<api.AddRepo {...checked()} />)
    await pickAccount("personal")
    expect(section(3)).not.toBeNull()
    expect(section(4)).toBeNull()

    await type(one<HTMLInputElement>(CMD_FIELD), "bun test")
    expect(section(4)).not.toBeNull()
  })

  test("a command of nothing but spaces is not an answer", async () => {
    await render(<api.AddRepo {...checked()} />)
    await pickAccount("personal")
    await type(one<HTMLInputElement>(CMD_FIELD), "   ")
    expect(section(4)).toBeNull()
  })

  /**
   * Disclosure latches; freshness does not. If visibility read the current
   * detection, every keystroke would unmount sections 2 to 4 — replaying four
   * blur fades and discarding the answers already given.
   */
  test("sections stay once revealed, even when the path goes stale", async () => {
    await fillIn()
    expect(section(4)).not.toBeNull()

    await type(pathField(), `${USABLE_PATH}x`)
    expect(section(2)).not.toBeNull()
    expect(section(3)).not.toBeNull()
    expect(section(4)).not.toBeNull()
    expect(addButton().disabled).toBe(true)
  })

  test("a revealed section is mounted, never `hidden`", async () => {
    /* `CLAUDE.md`: a collapsed file list rendered in full because
       `display: flex` outranks `[hidden]`. Every section here is a
       `display: grid`, so the same defect is one `hidden` away. */
    await render(<api.AddRepo {...props()} />)
    expect(all("[hidden]")).toEqual([])
  })

  test("each section enters with the artboard's blur fade, on its own rung", async () => {
    await fillIn()
    expect(classesOf('[data-section="1"]')).toEqual(expect.arrayContaining(["bf", "d1"]))
    expect(classesOf('[data-section="2"]')).toEqual(expect.arrayContaining(["bf", "d2"]))
    expect(classesOf('[data-section="3"]')).toEqual(expect.arrayContaining(["bf", "d3"]))
    expect(classesOf('[data-section="4"]')).toEqual(expect.arrayContaining(["bf", "d4"]))
  })

  test("the action is on screen from the start, saying what is missing", async () => {
    /* The artboard's own logic: the hint reads "Check the folder first." before
       anything has been checked, so the footer is not progressive. A disabled
       button with no reason beside it is the defect this screen was redesigned
       to remove. */
    await render(<api.AddRepo {...props()} />)
    expect(addButton().disabled).toBe(true)
    expect(prose()).toContain("Check the folder first.")
  })

  test("the hint does not contradict the spinner", async () => {
    await render(<api.AddRepo {...props({ path: USABLE_PATH, detection: { phase: "checking", path: USABLE_PATH } })} />)
    expect(prose()).toContain("Checking that folder now.")
    expect(prose()).not.toContain("Check the folder first.")
  })

  test("the hint names one missing thing at a time, in order", async () => {
    await render(<api.AddRepo {...checked()} />)
    expect(prose()).toContain("Say which Claude account runs it.")

    await pickAccount("personal")
    expect(prose()).toContain("Say how to run the tests.")

    await type(one<HTMLInputElement>(CMD_FIELD), "bun test")
    /* The profile clause is this file's addition to the artboard's sentence,
       and it is the honest half: `account` is the human's word about billing
       and `configDir` is what selects a profile, so a card that carries no
       directory runs the default one and says so. */
    expect(prose()).toContain("Runs as personal on the default profile. Tests: bun test.")
  })
})

/* ========================================================================== */
/* 5. The account, which bills someone                                        */
/* ========================================================================== */

describe("which account runs it", () => {
  test("nothing is chosen until someone chooses", async () => {
    await render(<api.AddRepo {...checked()} />)
    for (const radio of all('[role="radio"]')) expect(radio.getAttribute("aria-checked")).toBe("false")
    expect(addButton().disabled).toBe(true)
  })

  test("not sure is one of the answers", async () => {
    const drafts: RepoDraft[] = []
    await render(<api.AddRepo {...checked({ onSubmit: (d) => void drafts.push(d) })} />)
    await pickAccount("unknown")
    await type(one<HTMLInputElement>(CMD_FIELD), "bun test")
    await click(addButton())

    /* Absent, not `null` and not "personal": `POST /api/projects` checks the
       body's keys against a fixed list, and not knowing is the absence of an
       answer. `Tree.tsx`'s `Account` renders it as a neutral chip. */
    expect(drafts).toEqual([{ path: USABLE_PATH, testCmd: "bun test" }])
    expect(Object.hasOwn(drafts[0] ?? {}, "account")).toBe(false)
  })

  /**
   * Two accounts of one kind, which this panel asks for.
   *
   * `Project.account` has two words, so a second client profile is another
   * `kind: "work"` — and "Add another account" is one of this panel's own
   * controls. Selecting by the word would check both cards and submit the
   * first one's `configDir`: a run billed from the wrong place, which is the
   * defect the question exists to prevent, on a dimension the rest of this
   * file never varies.
   */
  describe("two accounts of the same kind", () => {
    const ACME = "/home/lalenooz/.claude-acme"
    const GLOBEX = "/home/lalenooz/.claude-globex"
    const TWO_WORK = [
      { kind: "work" as const, label: "work · acme", configDir: ACME },
      { kind: "work" as const, label: "work · globex", configDir: GLOBEX },
    ]

    test("each submits its own profile, and only the clicked one is checked", async () => {
      const drafts: RepoDraft[] = []
      await render(<api.AddRepo {...checked({ onSubmit: (d) => void drafts.push(d), accounts: TWO_WORK })} />)
      await pickProfile("work", GLOBEX)
      expect(checkedAccountKeys()).toEqual([`work\0${GLOBEX}`])
      await type(one<HTMLInputElement>(CMD_FIELD), "bun test")
      await click(addButton())
      expect(drafts).toEqual([{ path: USABLE_PATH, testCmd: "bun test", account: "work", configDir: GLOBEX }])
    })

    test("the selection follows the account when the list reorders", async () => {
      /* Not the slot. A list that reorders — or grows when `onAddAccount`
         returns — would otherwise move a selection to another client in
         silence, and nothing on screen would say it had moved. */
      const drafts: RepoDraft[] = []
      const base = checked({ onSubmit: (d) => void drafts.push(d), accounts: TWO_WORK })
      await render(<api.AddRepo {...base} />)
      await pickProfile("work", ACME)
      await render(<api.AddRepo {...base} accounts={[...TWO_WORK].reverse()} />)
      expect(checkedAccountKeys()).toEqual([`work\0${ACME}`])
      await type(one<HTMLInputElement>(CMD_FIELD), "bun test")
      await click(addButton())
      expect(drafts).toEqual([{ path: USABLE_PATH, testCmd: "bun test", account: "work", configDir: ACME }])
    })

    test("an account that stops being offered reads as unanswered", async () => {
      const base = checked({ accounts: TWO_WORK })
      await render(<api.AddRepo {...base} />)
      await pickProfile("work", GLOBEX)
      await type(one<HTMLInputElement>(CMD_FIELD), "bun test")
      expect(addButton().disabled).toBe(false)

      await render(<api.AddRepo {...base} accounts={[TWO_WORK[0] as (typeof TWO_WORK)[number]]} />)
      /* Carrying the word forward after the profile behind it has gone would
         register a billing label nothing backs. */
      expect(checkedAccountKeys()).toEqual([])
      expect(addButton().disabled).toBe(true)
      expect(prose()).toContain("Say which Claude account runs it.")
      /* The question stays on screen, because disclosure latches. */
      expect(section(2)).not.toBeNull()
    })
  })

  test("the chosen account's own profile directory goes with it, and is never invented", async () => {
    const drafts: RepoDraft[] = []
    await render(
      <api.AddRepo
        {...checked({
          onSubmit: (d) => void drafts.push(d),
          accounts: [
            { kind: "personal" },
            { kind: "work", configDir: "/home/lalenooz/.claude-work", usedFraction: 0.12 },
          ],
        })}
      />,
    )
    await pickAccount("work")
    await type(one<HTMLInputElement>(CMD_FIELD), "bun test")
    await click(addButton())
    expect(drafts).toEqual([
      { path: USABLE_PATH, testCmd: "bun test", account: "work", configDir: "/home/lalenooz/.claude-work" },
    ])
  })

  test("an account with no profile directory says so rather than printing one", async () => {
    /* `src/projects.ts`: `account` is a label for billing and `configDir`
       selects the profile, and no rule turns one into the other. Printing
       `~/.claude-work` under a card that sends no `configDir` would promise a
       profile the run will not use — which is the billing defect itself. */
    await render(<api.AddRepo {...checked({ accounts: [{ kind: "personal" }, { kind: "work" }] })} />)
    expect(prose()).not.toContain("~/.claude-work")
    expect(prose()).toContain("default profile")
  })

  test("a profile directory that was given is printed verbatim", async () => {
    await render(
      <api.AddRepo {...checked({ accounts: [{ kind: "personal", configDir: "/home/lalenooz/.claude" }] })} />,
    )
    expect(prose()).toContain("/home/lalenooz/.claude")
  })

  /**
   * The dimension is `usedFraction`, and these are all the values it can take.
   *
   * A `NaN` reaches `stroke-dashoffset` as the string "NaN" and renders a ring
   * with no arc — a plausible-looking 0% that nobody measured — so anything
   * not finite draws nothing at all. A finite value out of range is clamped
   * instead of dropped: a server reporting 1.4 has still said "spent", and the
   * cheap direction there is to show the window full.
   *
   * `0` has its own row because it is the one the obvious implementation gets
   * wrong: `usedFraction && <Ring/>` drops a measured zero, which is the same
   * unmeasured-looking 0% the `NaN` row exists to prevent.
   */
  const RINGS: ReadonlyArray<{ why: string; usedFraction?: number; ring: boolean; reads?: string }> = [
    { why: "absent", ring: false },
    { why: "a measured zero", usedFraction: 0, ring: true, reads: "0%" },
    { why: "a fraction", usedFraction: 0.41, ring: true, reads: "41%" },
    { why: "exactly full", usedFraction: 1, ring: true, reads: "100%" },
    { why: "above full", usedFraction: 1.4, ring: true, reads: "100%" },
    { why: "below empty", usedFraction: -0.2, ring: true, reads: "0%" },
    { why: "not a number", usedFraction: Number.NaN, ring: false },
    { why: "infinite", usedFraction: Number.POSITIVE_INFINITY, ring: false },
    { why: "negatively infinite", usedFraction: Number.NEGATIVE_INFINITY, ring: false },
  ]

  for (const row of RINGS) {
    test(`a five-hour window reported as ${row.why} ${row.ring ? `reads ${row.reads}` : "draws no ring"}`, async () => {
      await render(
        <api.AddRepo
          {...checked({
            accounts: [
              { kind: "personal" },
              { kind: "work", ...(row.usedFraction === undefined ? {} : { usedFraction: row.usedFraction }) },
            ],
          })}
        />,
      )
      /* Scoped to the card, or a ring drawn on the wrong account passes. */
      expect(all('[data-account="personal"] [data-addrepo="ring"]')).toEqual([])
      const card = one('[data-account="work"]')
      const rings = card.querySelectorAll('[data-addrepo="ring"]')
      expect(rings.length).toBe(row.ring ? 1 : 0)
      const text = (card.textContent ?? "").replace(/\s+/g, " ")
      if (row.reads !== undefined) expect(text).toContain(row.reads)
      expect(text).not.toContain("NaN")
      expect(text).not.toContain("Infinity")
    })
  }

  test("adding another account is offered only when there is somewhere to go", async () => {
    await render(<api.AddRepo {...checked()} />)
    expect(all("button").some((b) => (b.textContent ?? "").includes("Add another account"))).toBe(false)

    let opened = 0
    await render(<api.AddRepo {...checked({ onAddAccount: () => void opened++ })} />)
    await click(byText("button", "Add another account"))
    expect(opened).toBe(1)
  })

  test("the hint names the profile it was given", async () => {
    await render(<api.AddRepo {...checked({ accounts: [{ kind: "work", configDir: "/home/lalenooz/.claude-work" }] })} />)
    await pickAccount("work")
    await type(one<HTMLInputElement>(CMD_FIELD), "bun test")
    expect(prose()).toContain("Runs as work from /home/lalenooz/.claude-work. Tests: bun test.")
  })

  test("not knowing the account is said as not knowing", async () => {
    await render(<api.AddRepo {...checked()} />)
    await pickAccount("unknown")
    await type(one<HTMLInputElement>(CMD_FIELD), "bun test")
    expect(prose()).toContain("No account recorded, so it runs on the default profile. Tests: bun test.")
  })

  test("the hint says which profile a run will use, and does not overstate", async () => {
    await render(<api.AddRepo {...checked({ accounts: [{ kind: "work" }] })} />)
    await pickAccount("work")
    await type(one<HTMLInputElement>(CMD_FIELD), "bun test")
    expect(prose()).toContain("Runs as work on the default profile. Tests: bun test.")
  })
})

/* ========================================================================== */
/* 6. The test command, which decides pass and fail                           */
/* ========================================================================== */

describe("the test command", () => {
  /**
   * The dimension: **has the human touched this field?** Values: never; typed
   * something; typed something and cleared it; typed exactly the suggestion.
   * Seeding over a value someone typed would silently run a different command
   * than the one they believe they set, so the rule fails toward never
   * overwriting.
   */
  test("fills in from the detection while untouched", async () => {
    await render(<api.AddRepo {...props({ path: USABLE_PATH, detection: usable(USABLE_PATH, { testCmd: "bun test", testCmdSource: "package.json" }) })} />)
    await pickAccount("personal")
    expect(one<HTMLInputElement>(CMD_FIELD).value).toBe("bun test")
    expect(prose()).toContain("from package.json")
  })

  test("never overwrites what was typed, not even on a new detection", async () => {
    const detection = usable(USABLE_PATH, { testCmd: "bun test", testCmdSource: "package.json" })
    await render(<api.AddRepo {...props({ path: USABLE_PATH, detection })} />)
    await pickAccount("personal")
    await type(one<HTMLInputElement>(CMD_FIELD), "make check")

    const other = "/home/lalenooz/projects/other"
    await render(
      <api.AddRepo
        {...props({ path: other, detection: usable(other, { testCmd: "npm test", testCmdSource: "package.json" }) })}
      />,
    )
    expect(one<HTMLInputElement>(CMD_FIELD).value).toBe("make check")
  })

  test("a field cleared on purpose stays cleared", async () => {
    await render(<api.AddRepo {...props({ path: USABLE_PATH, detection: usable(USABLE_PATH, { testCmd: "bun test" }) })} />)
    await pickAccount("personal")
    await type(one<HTMLInputElement>(CMD_FIELD), "")
    expect(one<HTMLInputElement>(CMD_FIELD).value).toBe("")
    /* Section 4 stays, because disclosure latches and a question once asked is
       not withdrawn. What an unanswered command costs is the button. */
    expect(addButton().disabled).toBe(true)
    expect(prose()).toContain("Say how to run the tests.")
  })

  /**
   * A repository with no suite is the common case, not the exotic one, and
   * before this it could not be added at all: `ready` wanted a non-empty
   * command, so the button stayed disabled with nothing the human could do
   * about it. The user's 2026-10-12 decision is that such a project exists and
   * the agent verifies its own work.
   *
   * The dimension this adds: **what the command field means when it is
   * empty.** Values: untouched and empty; emptied on purpose; and now, the
   * opt-out taken. The first two are an unanswered question and must keep
   * refusing, because `sh -c ""` exits 0 and a blank command would tick every
   * task as tested with nothing run. Only an explicit control may mean "none",
   * and it sends `null` - the one spelling `src/projects.ts` accepts.
   */
  test("offers to say the project has no suite, and sends `null` rather than a blank", async () => {
    const drafts: RepoDraft[] = []
    const { path: startingPath, ...rest } = checked({ onSubmit: (d) => void drafts.push(d) })
    await render(<Shell startingPath={startingPath} {...rest} />)
    await pickAccount("personal")

    /* An empty field is still an unanswered question. */
    expect(addButton().disabled).toBe(true)

    await click(byText("button", NO_SUITE))
    /* The field goes, rather than sitting empty behind a `$` under a promise
       about an exit code that will not be read. */
    expect(maybe(CMD_FIELD)).toBeNull()
    expect(prose()).toContain("verifies its own work")
    expect(addButton().disabled).toBe(false)

    await click(addButton())
    expect(drafts).toHaveLength(1)
    expect(drafts[0]?.testCmd).toBeNull()
  })

  test("the opt-out is reversible, and taking it back restores the question", async () => {
    await render(<api.AddRepo {...props({ path: USABLE_PATH, detection: usable(USABLE_PATH, { testCmd: "bun test", testCmdSource: "package.json" }) })} />)
    await pickAccount("personal")

    await click(byText("button", NO_SUITE))
    expect(maybe(CMD_FIELD)).toBeNull()

    await click(byText("button", "Give it a test command"))
    /* The detection's suggestion is still the suggestion: the opt-out did not
       answer the question, it declined it, so nothing was typed to preserve. */
    expect(one<HTMLInputElement>(CMD_FIELD).value).toBe("bun test")
    expect(addButton().disabled).toBe(false)
  })

  test("a command typed and then opted out of does not travel with the draft", async () => {
    const drafts: RepoDraft[] = []
    const { path: startingPath, ...rest } = checked({ onSubmit: (d) => void drafts.push(d) })
    await render(<Shell startingPath={startingPath} {...rest} />)
    await pickAccount("personal")
    await type(one<HTMLInputElement>(CMD_FIELD), "bun test")
    await click(byText("button", NO_SUITE))

    await click(addButton())
    expect(drafts[0]?.testCmd).toBeNull()
  })

  /** `src/testrun.ts` has nothing to run, and `sh -c ""` exits 0. */
  test("does not offer to run a command once there is to be none", async () => {
    await render(
      <api.AddRepo
        {...props({ path: USABLE_PATH, detection: usable(USABLE_PATH, { testCmd: "bun test" }), onRunTests: () => {} })}
      />,
    )
    await pickAccount("personal")
    expect(all("button").map((b) => (b.textContent ?? "").trim())).toContain("Run it once")

    await click(byText("button", NO_SUITE))
    expect(all("button").map((b) => (b.textContent ?? "").trim())).not.toContain("Run it once")
  })

  test("the source chip goes once the value is not what the source said", async () => {
    await render(<api.AddRepo {...props({ path: USABLE_PATH, detection: usable(USABLE_PATH, { testCmd: "bun test", testCmdSource: "package.json" }) })} />)
    await pickAccount("personal")
    await type(one<HTMLInputElement>(CMD_FIELD), "make check")
    expect(prose()).not.toContain("from package.json")
  })

  test("there is no default command, because a wrong one fails every run", async () => {
    await render(<api.AddRepo {...checked()} />)
    await pickAccount("personal")
    expect(one<HTMLInputElement>(CMD_FIELD).value).toBe("")
  })

  test("running it once is offered only when someone can run it", async () => {
    await render(<api.AddRepo {...checked()} />)
    await pickAccount("personal")
    expect(all("button").some((b) => (b.textContent ?? "").includes(ARTBOARD.runOnce))).toBe(false)

    let runs = 0
    await render(<api.AddRepo {...checked({ onRunTests: () => void runs++ })} />)
    await pickAccount("personal")
    await type(one<HTMLInputElement>(CMD_FIELD), "bun test")
    await click(byText("button", ARTBOARD.runOnce))
    expect(runs).toBe(1)
  })

  test("a run reports its exit code, never a verdict of its own", async () => {
    await render(
      <api.AddRepo
        {...checked({
          onRunTests: () => {},
          testRun: { phase: "done", cmd: "bun test", exitCode: 1, summary: "2 failing · 4.1s" },
        })}
      />,
    )
    await pickAccount("personal")
    await type(one<HTMLInputElement>(CMD_FIELD), "bun test")
    expect(prose()).toContain("exit 1")
    expect(prose()).toContain("2 failing · 4.1s")
  })

  test("a failing suite does not stop the repository being added", async () => {
    /* The tests are the run's business, not the registration's: a repo is
       usually registered precisely because its suite is red. */
    const { drafts } = await fillIn({
      onRunTests: () => {},
      testRun: { phase: "done", cmd: "bun test", exitCode: 1 },
    })
    expect(addButton().disabled).toBe(false)
    await click(addButton())
    expect(drafts.length).toBe(1)
  })

  test("a result for another command is not shown beside this one", async () => {
    /* Same guard as the path, same direction: a green `exit 0` under a command
       nobody ran is worse than no chip. */
    await render(
      <api.AddRepo {...checked({ onRunTests: () => {}, testRun: { phase: "done", cmd: "npm test", exitCode: 0 } })} />,
    )
    await pickAccount("personal")
    await type(one<HTMLInputElement>(CMD_FIELD), "bun test")
    expect(prose()).not.toContain("exit 0")
  })

  test("while a run is in flight it names the command it is running", async () => {
    await render(
      <api.AddRepo {...checked({ onRunTests: () => {}, testRun: { phase: "running", cmd: "bun test" } })} />,
    )
    await pickAccount("personal")
    await type(one<HTMLInputElement>(CMD_FIELD), "bun test")
    expect(prose()).toContain("Running bun test…")
  })
})

/* ========================================================================== */
/* 7. The task files, which this panel cannot choose                          */
/* ========================================================================== */

describe("where the tasks are", () => {
  test("lists what was found, with its task counts", async () => {
    await fillIn()
    const text = prose()
    expect(text).toContain("docs/features/importer.md")
    expect(text).toContain("3 tasks")
    expect(text).toContain("docs/features/export.md")
    expect(text).toContain("1 task")
  })

  test("offers no checkbox, because nothing could carry the choice", async () => {
    /* `POST /api/projects` takes `path`, `testCmd`, `account` and `configDir`
       and refuses any other key by name; `src/featurefile.ts` discovers task
       files by reading `docs/features` at request time. So a checkbox here
       would be a control whose answer is dropped — the artboard draws one, and
       drawing it anyway is the defect this repo keeps catching. */
    await fillIn()
    expect(all('[data-section="4"] input[type="checkbox"]')).toEqual([])
    expect(prose()).toContain("kantan reads every markdown file in")
  })

  test("a repository with no task files can still be added", async () => {
    const { drafts } = await fillIn({ detection: usable(USABLE_PATH, { taskFiles: [] }) })
    expect(addButton().disabled).toBe(false)
    await click(addButton())
    expect(drafts.length).toBe(1)
    expect(prose()).toContain("No task files yet")
  })

  test("a file with no tasks is listed as having none", async () => {
    await fillIn({
      detection: usable(USABLE_PATH, { taskFiles: [{ path: "docs/features/notes.md", tasks: [] }] }),
    })
    expect(prose()).toContain("docs/features/notes.md")
    expect(prose()).toContain("no tasks found")
  })

  test("paths are printed exactly as the tree will list them", async () => {
    /* `docs/HANDOFF.md`: the tree joins on `featureFile` by exact string, so a
       shortened path here teaches a name that will not match. */
    await fillIn()
    expect(byText("span", "docs/features/importer.md")).toBeDefined()
  })

  test("starting a new task file is offered only when there is somewhere to go", async () => {
    await fillIn()
    expect(all("button").some((b) => (b.textContent ?? "").includes("Start a new task file"))).toBe(false)

    let opened = 0
    await fillIn({ onNewTaskFile: () => void opened++ })
    await click(byText("button", "Start a new task file instead"))
    expect(opened).toBe(1)
  })
})

/* ========================================================================== */
/* 8. The right rail: what will be added                                      */
/* ========================================================================== */

describe("the preview", () => {
  test("shows the repository, its account and its command", async () => {
    await fillIn()
    const rail = one(PREVIEW)
    const text = (rail.textContent ?? "").replace(/\s+/g, " ")
    expect(text).toContain(ARTBOARD.previewTitle)
    expect(text).toContain("kantan")
    expect(text).toContain("personal")
    expect(text).toContain("$ bun test")
    expect(text).toContain(ARTBOARD.previewFoot)
  })

  test("shows every task it will read, with its ref", async () => {
    await fillIn()
    const text = (one(PREVIEW).textContent ?? "").replace(/\s+/g, " ")
    expect(text).toContain("T1")
    expect(text).toContain("Parse the manifest")
    expect(text).toContain("Runtime shim (v1.2)")
    expect(text).toContain("Stream CSV export")
  })

  test("a task with no ref is still drawn", async () => {
    await fillIn({
      detection: usable(USABLE_PATH, { taskFiles: [{ path: "docs/features/x.md", tasks: [{ ref: null, text: "Unlabelled work" }] }] }),
    })
    expect((one(PREVIEW).textContent ?? "")).toContain("Unlabelled work")
  })

  test("says plainly when there is nothing to read yet", async () => {
    await fillIn({ detection: usable(USABLE_PATH, { taskFiles: [] }) })
    expect((one(PREVIEW).textContent ?? "")).toContain("No task files yet")
  })

  test("claims no account before one is chosen", async () => {
    await render(<api.AddRepo {...checked()} />)
    const text = (one(PREVIEW).textContent ?? "").replace(/\s+/g, " ")
    expect(text).toContain("account unknown")
    expect(text).not.toContain("personal")
  })

  test("goes quiet while the path is unchecked", async () => {
    await render(<api.AddRepo {...props()} />)
    const text = (one(PREVIEW).textContent ?? "").replace(/\s+/g, " ")
    expect(text).toContain(ARTBOARD.previewTitle)
    expect(text).not.toContain("docs/features")
  })
})

/* ========================================================================== */
/* 9. Naming the repository                                                   */
/* ========================================================================== */

describe("what the repository is called", () => {
  /**
   * The label is read off the root **git reported**, never off the text in the
   * box. With `/home/laithalenooz/projects/kantan` typed, the last segment is
   * still `kantan` — so a label derived from the typing says "Add kantan" for a
   * directory that does not exist, which is the reassurance that let the
   * production failure through.
   */
  test("comes from the detected root, not from the typing", async () => {
    await render(<api.AddRepo {...props({ path: "/home/laithalenooz/projects/kantan" })} />)
    expect(prose()).toContain("Add this repository")
    expect(prose()).not.toContain("Add kantan")
  })

  test("uses the real name once git has reported one", async () => {
    await render(<api.AddRepo {...props({ path: USABLE_PATH, detection: usable() })} />)
    expect(byText("button", "Add kantan")).toBeDefined()
  })

  test("repoLabel over every shape a root can take", () => {
    expect(api.repoLabel("/home/lalenooz/projects/kantan")).toBe("kantan")
    expect(api.repoLabel("/kantan")).toBe("kantan")
    /* git prints no trailing slash, but a hand-written prop might. */
    expect(api.repoLabel("/home/lalenooz/projects/kantan/")).toBe("kantan")
    /* Nothing is left to name, so the whole thing is the name. */
    expect(api.repoLabel("/")).toBe("/")
    expect(api.repoLabel("")).toBe("this repository")
    /* A name that is itself a dot directory is still that directory's name. */
    expect(api.repoLabel("/home/lalenooz/.dotfiles")).toBe(".dotfiles")
    /* Spaces and non-ASCII are a directory name like any other. */
    expect(api.repoLabel("/home/lalenooz/my repo")).toBe("my repo")
    expect(api.repoLabel("/home/lalenooz/café")).toBe("café")
  })
})

/* ========================================================================== */
/* 10. Submitting, and being refused                                          */
/* ========================================================================== */

describe("adding it", () => {
  test("hands over exactly what was typed", async () => {
    /* Not trimmed, not resolved, not expanded. The server owns every one of
       those rules — `src/projects.ts` refuses a relative path rather than
       resolving it, because the answer would depend on where the server was
       launched — and a panel that tidied the string first would register a
       different directory than the one it checked. */
    const typed = `${USABLE_PATH} `
    const drafts: RepoDraft[] = []
    await render(
      <api.AddRepo {...props({ path: typed, detection: usable(typed), onSubmit: (d) => void drafts.push(d) })} />,
    )
    await pickAccount("personal")
    await type(one<HTMLInputElement>(CMD_FIELD), " bun test ")
    await click(addButton())
    expect(drafts).toEqual([{ path: typed, testCmd: " bun test ", account: "personal" }])
  })

  test("a refusal is shown beside the field that caused it, and the form survives", async () => {
    const { drafts } = await fillIn({
      onSubmit: () => Promise.reject(new Error("/x is already registered in projects.json, so there is nothing to add.")),
    })
    void drafts
    await click(addButton())
    expect(one('[role="alert"]').textContent).toContain("already registered")
    /* Restored, not spent: the draft is still there to fix. */
    expect(addButton().disabled).toBe(false)
    expect(one<HTMLInputElement>(CMD_FIELD).value).toBe("bun test")
  })

  test("the button does not fire twice while the first add is in flight", async () => {
    let calls = 0
    let release = (): void => {}
    const { drafts } = await fillIn({
      onSubmit: () => {
        calls++
        return new Promise<void>((resolve) => {
          release = resolve
        })
      },
    })
    void drafts
    await click(addButton())
    expect(addButton().disabled).toBe(true)
    await click(addButton())
    expect(calls).toBe(1)
    await api.act(async () => {
      release()
    })
  })

  test("says it is ready when the add succeeds", async () => {
    await fillIn()
    await click(addButton())
    expect(prose()).toContain("kantan is ready. Pick a task to start.")
    expect(maybe(ADD_BUTTON)).toBeNull()
  })

  test("offers no way in when the shell gave none", async () => {
    await fillIn()
    await click(addButton())
    expect(all("button").some((b) => (b.textContent ?? "").includes("Open kantan"))).toBe(false)
  })

  test("offers the way in when the shell gave one", async () => {
    let opened = 0
    await fillIn({ onOpenRepo: () => void opened++ })
    await click(addButton())
    await click(byText("button", "Open kantan"))
    expect(opened).toBe(1)
  })

  test("Enter in the path field checks, and never registers", async () => {
    /* The whole point of this screen is that nothing is submitted before it has
       been checked, so there is no `<form>` and no implicit submit. */
    let checks = 0
    const drafts: RepoDraft[] = []
    await render(
      <api.AddRepo {...props({ path: USABLE_PATH, onCheck: () => void checks++, onSubmit: (d) => void drafts.push(d) })} />,
    )
    await pressEnter(pathField())
    expect(checks).toBe(1)
    expect(drafts).toEqual([])
    expect(all("form")).toEqual([])
  })

  test("the Check button asks for a fresh look", async () => {
    let checks = 0
    await render(<api.AddRepo {...props({ path: USABLE_PATH, onCheck: () => void checks++ })} />)
    await click(one(CHECK_BUTTON))
    expect(checks).toBe(1)
  })

  test("typing reports the raw value upward, one event per change", async () => {
    const seen: string[] = []
    await render(<api.AddRepo {...props({ path: "", onPathChange: (v) => void seen.push(v) })} />)
    await type(pathField(), " ~/code ")
    expect(seen).toEqual([" ~/code "])
  })

  test("cancelling leaves", async () => {
    let cancels = 0
    await render(<api.AddRepo {...props({ onCancel: () => void cancels++ })} />)
    await click(byText("button", ARTBOARD.cancel))
    expect(cancels).toBe(1)
  })

  test("the path field asks the browser not to help", async () => {
    /* Autocapitalise and autocorrect are path guesses with a vendor behind
       them: a field that turns `/usr` into `/Usr` on a phone keyboard produces
       the production failure with nobody having typed it. */
    await render(<api.AddRepo {...props()} />)
    const field = pathField()
    expect(field.getAttribute("spellcheck")).toBe("false")
    expect(field.getAttribute("autocapitalize")).toBe("off")
    expect(field.getAttribute("autocorrect")).toBe("off")
    expect(field.getAttribute("autocomplete")).toBe("off")
  })
})

/* ========================================================================== */
/* 11. Reduced motion                                                         */
/* ========================================================================== */

describe("someone who asked for less movement", () => {
  test("gets no entrance, no spinner spin and no ring sweep", async () => {
    setPrefersReduce(true)
    await fillIn({ detection: usable(USABLE_PATH), accounts: [{ kind: "personal", usedFraction: 0.41 }] })
    expect(one('[data-addrepo="root"]').getAttribute("data-motion")).toBe("static")
    for (const el of all("[class]")) {
      const classes = (el.getAttribute("class") ?? "").split(/\s+/)
      for (const banned of ["bf", "pop", "spin", "ring"]) expect(classes).not.toContain(banned)
    }
  })

  test("keeps every word and every control", async () => {
    /* The reduced-motion path is a second rendering of the same screen, and the
       cheap way to get it wrong is to drop the elements rather than the
       animation. */
    setPrefersReduce(false)
    await fillIn()
    const moving = prose()
    /* Inside `act`, because a mounted panel is subscribed to this query
       through `useSyncExternalStore` and firing the listeners is a state
       update like any other. */
    await api.act(async () => {
      setPrefersReduce(true)
    })
    await fillIn()
    expect(prose()).toBe(moving)
  })

  test("is believed even when Motion's singleton says otherwise", async () => {
    /**
     * Motion's query is quarantined to `false` for this whole file, so its
     * `useReducedMotion()` can never report the preference here. Flipping the
     * media feature **without** firing `change` is the state
     * `docs/HANDOFF.md` records as the real trap — a stub that fires `change`
     * repairs Motion's singleton and passes for the wrong reason.
     *
     * So this test can only pass through the live `matchMedia` read. Delete
     * `|| live` from `usePrefersReducedMotion` and it fails on its own.
     */
    setPrefersReduceSilently(true)
    await render(<api.AddRepo {...checked()} />)
    expect(one('[data-addrepo="root"]').getAttribute("data-motion")).toBe("static")
    expect(classesOf('[data-section="1"]')).not.toContain("bf")
  })

  test("the animated classes are there for everyone else", async () => {
    setPrefersReduce(false)
    await render(<api.AddRepo {...props({ path: USABLE_PATH, detection: { phase: "checking", path: USABLE_PATH } })} />)
    expect(one('[data-addrepo="root"]').getAttribute("data-motion")).toBe("animated")
    expect(classesOf('[data-addrepo="spinner"]')).toContain("spin")
  })

  test("the detection list enters as a list, one row behind the last", async () => {
    setPrefersReduce(false)
    await render(<api.AddRepo {...props({ path: USABLE_PATH, detection: usable() })} />)
    const rows = all('[data-addrepo="checks"] li')
    expect(rows.length).toBe(3)
    for (const row of rows) expect((row.getAttribute("class") ?? "").split(/\s+/)).toContain("pop")
    /* The stagger is the artboard's own: .1s per row, declared inline because
       the delay ladder in `artboard.css` is a fixed set of rungs. */
    expect(rows[1]?.getAttribute("style")).toContain("animation-delay: 0.1s")
    expect(rows[2]?.getAttribute("style")).toContain("animation-delay: 0.2s")
  })
})

/* ========================================================================== */
/* 12. The artboard's own words                                               */
/* ========================================================================== */

describe("the copy is the artboard's", () => {
  test("the heading, the lede and the four questions", async () => {
    await fillIn()
    const text = prose()
    for (const line of [
      ARTBOARD.heading,
      ARTBOARD.lede,
      ARTBOARD.where,
      ARTBOARD.account,
      ARTBOARD.accountWhy,
      ARTBOARD.tests,
      ARTBOARD.testsWhy,
      ARTBOARD.tasks,
    ]) {
      expect(text).toContain(line)
    }
  })

  test("the path field's placeholder, with its one-character ellipsis", async () => {
    await render(<api.AddRepo {...props()} />)
    expect(pathField().getAttribute("placeholder")).toBe(ARTBOARD.placeholder)
  })

  test("it is a panel in the centre column, not a dialog", async () => {
    /* `docs/design/canvas.json`: "All of these replace the centre column. No
       routes, no settings page, and dialogs only for confirmations." */
    await render(<api.AddRepo {...props()} />)
    expect(all('[role="dialog"]')).toEqual([])
    expect(all("[aria-modal]")).toEqual([])
    expect(one("main")).toBeDefined()
  })

  test("the heading names the region for a screen reader", async () => {
    await render(<api.AddRepo {...props()} />)
    const panel = one("section[aria-labelledby]")
    const id = panel.getAttribute("aria-labelledby")
    expect(one(`#${id}`).textContent).toBe(ARTBOARD.heading)
  })

  test("the machine's own values are in the mono face", async () => {
    await fillIn()
    /* `artboard.css`: "Mono for every machine value: paths, commands, costs,
       refs, exit codes." */
    expect(classesOf(PATH_FIELD)).toContain("m")
    expect(classesOf(CMD_FIELD)).toContain("m")
  })

  test("the root carries `kr`, which is what the reduced-motion guard needs", async () => {
    await render(<api.AddRepo {...props()} />)
    expect(classesOf('[data-addrepo="root"]')).toContain("kr")
  })

  test("it accepts a className from the shell without losing its own", async () => {
    await render(<api.AddRepo {...props({ className: "col-span-2" })} />)
    const classes = classesOf('[data-addrepo="root"]')
    expect(classes).toContain("col-span-2")
    expect(classes).toContain("kr")
  })
})

/* ========================================================================== */
/* 13. Strict mode                                                            */
/* ========================================================================== */

test("double-invoked renders change nothing", async () => {
  /* The reveal latch is state adjusted during render, which React's strict
     mode double-invokes. If it were not idempotent this is where it shows. */
  const drafts: RepoDraft[] = []
  await render(
    <api.StrictMode>
      <api.AddRepo {...checked({ onSubmit: (d) => void drafts.push(d) })} />
    </api.StrictMode>,
  )
  await pickAccount("personal")
  await type(one<HTMLInputElement>(CMD_FIELD), "bun test")
  expect(section(4)).not.toBeNull()
  await click(addButton())
  expect(drafts).toEqual([{ path: USABLE_PATH, testCmd: "bun test", account: "personal" }])
})
