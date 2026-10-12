/**
 * The gate, and the question that is not a gate.
 *
 * Four of these tests are about facts that are cheap to get wrong and
 * expensive to ship wrong, so each says how it proves itself rather than
 * trusting the markup to look right:
 *
 *  - **The plan comes from the dictated path.** The fixtures use a path no
 *    convention would produce, so a component that rebuilt one by convention
 *    could not pass by accident.
 *  - **A question cannot be approved.** Proved three ways: the type (a
 *    `@ts-expect-error` that `tsc` fails if the field ever becomes legal), the
 *    accessible names of every rendered control, and a keyboard chord fired at
 *    a tree that was the gate a moment earlier.
 *  - **The focus ring meets 3:1 against its real ground.** Computed colours,
 *    walked up the ancestor chain and composited, with `var()` resolved from
 *    `src/ui/tokens.css`. Nothing here reads a hard-coded expectation of what
 *    the ground is; it reads what the cascade produces. `outline-offset` is
 *    read from the rule, and its sign decides whether the ground is the
 *    parent's or the control's own — that sign is what an earlier version of
 *    this project got wrong, shipping an ink ring on a blue plate at 2.56:1.
 *  - **Reduced motion is set as a media feature**, not stubbed in the
 *    component, and the animated classes are then absent.
 *
 * What this file cannot see, stated so the next person does not trust it
 * further than it goes: Tailwind does not run under `bun test`, so a ring or a
 * ground written as a Tailwind arbitrary value (`outline-[#fff]`,
 * `bg-[#FF6A1A]`) would be invisible to the contrast walk. That is the reason
 * `Gate.tsx` declares both in its own stylesheet.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator"

/* Registered before React is imported, and guarded: three other UI agents own
 * sibling test files and bun runs them in one process. */
if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register()
}

import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { act } from "react"
import type { ReactElement } from "react"

import { Gate } from "../../src/ui/Gate.tsx"
import type { GateShape, PlanSource, QuestionShape } from "../../src/ui/Gate.tsx"
import { Tree } from "../../src/ui/Tree.tsx"
import type { TreeProject } from "../../src/ui/Tree.tsx"

/**
 * `react-dom` is imported **after** happy-dom is registered, and that is not a
 * tidiness preference.
 *
 * ES module imports are all evaluated before a module's own statements, so a
 * static `import "react-dom/client"` runs while `window` still does not exist.
 * React reads its DOM capabilities once, at module init: with no document it
 * concludes that `input` events are unsupported and installs an IE-era polyfill
 * that watches `keydown` and `selectionchange` instead. Measured, before this
 * line existed: `onChange` never fired for a dispatched `input` event, and
 * every `keydown` threw inside React's change plugin — so the component looked
 * broken while nothing was wrong with it. Deferring the import by one tick
 * restores the real event path, which is the one these tests should exercise.
 */
const { createRoot } = await import("react-dom/client")

/* React's own flag for a test environment; without it every act() warns. */
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

interface Mounted {
  host: HTMLElement
  rerender: (next: ReactElement) => Promise<void>
}

const mounted: Array<{ host: HTMLElement; root: ReturnType<typeof createRoot> }> = []

async function render(ui: ReactElement): Promise<Mounted> {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ host, root })
  await act(async () => {
    root.render(ui)
  })
  return {
    host,
    rerender: async (next: ReactElement) => {
      await act(async () => {
        root.render(next)
      })
    },
  }
}

afterEach(async () => {
  for (const entry of mounted.splice(0)) {
    await act(async () => {
      entry.root.unmount()
    })
    entry.host.remove()
  }
  setReducedMotion("no-preference")
})

/** happy-dom's real media feature, so the component reads it through matchMedia. */
function setReducedMotion(value: "reduce" | "no-preference"): void {
  const hd = (globalThis as unknown as { happyDOM?: { settings: { device: { prefersReducedMotion: string } } } })
    .happyDOM
  if (hd) hd.settings.device.prefersReducedMotion = value
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** Deliberately not `docs/plans/<date>-<ref>.md`: nothing may reconstruct it. */
const DICTATED_PATH = "notes/odd dir/PLAN final (v2).md"

const PLAN_MARKDOWN = [
  "## Goal",
  "",
  "Turn each parsed manifest entry into a row the writer accepts. T1 gave us `parseManifest()`.",
  "",
  "## Steps",
  "",
  "1. Write a failing test in `map.test.ts`.",
  "2. Run `npm test` and confirm it fails for the right reason.",
  "",
  "```ts",
  "export function mapRecord(entry: ManifestEntry): Row {}",
  "```",
].join("\n")

const QUESTION_TEXT = [
  "Should writes queued while offline survive an app restart?",
  "",
  "Right now `lib/sync/queue.dart` keeps the queue in memory. I see two ways to go:",
  "",
  "- **Keep it in memory.** A smaller change, but a force-quit loses anything not yet sent.",
  "- **Persist it with sqflite.** Survives restarts, but adds a dependency.",
].join("\n")

const loadedPlan: PlanSource = { status: "loaded", path: DICTATED_PATH, markdown: PLAN_MARKDOWN }

function gateProps(over: Partial<Omit<GateShape, "kind">> = {}): GateShape {
  return {
    kind: "gate" as const,
    waitId: "run-7#4",
    plan: loadedPlan,
    testCommand: "npm test",
    filesRead: ["src/importer/manifest.ts", "src/importer/writer.ts"],
    planDurationMs: 8_000,
    costUsd: 0.42,
    onApprove: () => {},
    onFeedback: (_: string) => {},
    ...over,
  }
}

function questionProps(over: Partial<Omit<QuestionShape, "kind">> = {}): QuestionShape {
  return {
    kind: "question" as const,
    waitId: "run-9#2",
    phase: "plan" as const,
    question: QUESTION_TEXT,
    askedAt: "asked at 18:22 · 9 min ago",
    onAnswer: (_: string) => {},
    ...over,
  }
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                     */
/* -------------------------------------------------------------------------- */

function accessibleName(el: Element): string {
  const label = el.getAttribute("aria-label")
  if (label !== null && label.trim() !== "") return label.trim()
  return (el.textContent ?? "").replace(/\s+/g, " ").trim()
}

function buttons(host: HTMLElement): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll("button"))
}

function buttonNamed(host: HTMLElement, pattern: RegExp): HTMLButtonElement {
  const found = buttons(host).filter((b) => pattern.test(accessibleName(b)))
  const first = found[0]
  if (!first) {
    throw new Error(
      `no button matching ${pattern}; present: ${JSON.stringify(buttons(host).map(accessibleName))}`,
    )
  }
  return first
}

function textareaNamed(host: HTMLElement, pattern: RegExp): HTMLTextAreaElement {
  for (const label of Array.from(host.querySelectorAll("label"))) {
    if (!pattern.test(accessibleName(label))) continue
    const el = host.querySelector(`#${CSS.escape(label.htmlFor)}`)
    if (el instanceof HTMLTextAreaElement) return el
  }
  throw new Error(`no textarea labelled ${pattern}`)
}

/**
 * Types into a controlled textarea.
 *
 * Through the prototype's own setter, not `el.value =`: React installs its own
 * value tracker on the node, and assigning past it leaves React's idea of the
 * value and the DOM's disagreeing — which crashes its change plugin rather than
 * failing an assertion, so this is not a style preference.
 */
const NATIVE_TEXTAREA_VALUE = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set

async function type(el: HTMLTextAreaElement, value: string): Promise<void> {
  if (!NATIVE_TEXTAREA_VALUE) throw new Error("no native textarea value setter to type through")
  await act(async () => {
    NATIVE_TEXTAREA_VALUE.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}

/** The approve chord, fired at whatever currently holds it. */
async function pressSubmitChord(target: EventTarget, mod: "meta" | "ctrl" = "meta"): Promise<void> {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        metaKey: mod === "meta",
        ctrlKey: mod === "ctrl",
        bubbles: true,
        cancelable: true,
      }),
    )
  })
}

/* -------------------------------------------------------------------------- */
/* Colour, for the focus-ring proof                                            */
/* -------------------------------------------------------------------------- */

/**
 * The token layer, parsed from the file the component names in its `var()`s.
 * Tailwind's compiler does not run here, so without this a declaration like
 * `background-color: var(--color-panel-3)` would measure as nothing at all and
 * the contrast walk would pass vacuously.
 */
const TOKENS: ReadonlyMap<string, string> = (() => {
  const css = readFileSync(join(import.meta.dir, "..", "..", "src", "ui", "tokens.css"), "utf8")
  const theme = /@theme\s*\{([\s\S]*?)\n\}/.exec(css)
  if (!theme?.[1]) throw new Error("tokens.css has no @theme block; the contrast proof cannot resolve var()")
  const out = new Map<string, string>()
  for (const line of theme[1].split("\n")) {
    const match = /^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/i.exec(line)
    if (match?.[1] && match[2]) out.set(match[1], match[2].trim())
  }
  return out
})()

/** Resolves `var(--x)` and `var(--x, fallback)` against the token layer. */
function resolveVars(value: string, scope: Element | null): string {
  let out = value.trim()
  for (let pass = 0; pass < 8 && out.includes("var("); pass += 1) {
    out = out.replace(/var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^()]*))?\)/gi, (_whole, name: string, fallback?: string) => {
      const fromScope = scope === null ? "" : inheritedCustomProperty(scope, name)
      if (fromScope !== "") return fromScope
      const token = TOKENS.get(name)
      if (token !== undefined) return token
      if (fallback !== undefined) return fallback
      throw new Error(`${name} resolves to nothing: not declared on the element chain and not a token in tokens.css`)
    })
  }
  return out.trim()
}

/**
 * Custom properties inherit, and happy-dom's computed style reports one only on
 * the element that declares it — so the walk is the inheritance. It also means
 * a per-element override, which is exactly the bug this file guards against, is
 * found before the value it would shadow.
 */
function inheritedCustomProperty(start: Element, name: string): string {
  let node: Element | null = start
  while (node) {
    const own = getComputedStyle(node).getPropertyValue(name).trim()
    if (own !== "") return own
    node = node.parentElement
  }
  return ""
}

interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

function parseColour(raw: string): Rgba | null {
  const value = raw.trim().toLowerCase()
  if (value === "" || value === "transparent" || value === "none" || value === "initial") return null
  const hex = /^#([0-9a-f]{3,8})$/.exec(value)
  if (hex?.[1]) {
    const digits = hex[1]
    const expand = (s: string) => Number.parseInt(s.length === 1 ? s + s : s, 16)
    if (digits.length === 3 || digits.length === 4) {
      const [r, g, b, a = "f"] = digits.split("") as [string, string, string, string?]
      return { r: expand(r), g: expand(g), b: expand(b), a: expand(a ?? "f") / 255 }
    }
    if (digits.length === 6 || digits.length === 8) {
      return {
        r: expand(digits.slice(0, 2)),
        g: expand(digits.slice(2, 4)),
        b: expand(digits.slice(4, 6)),
        a: digits.length === 8 ? expand(digits.slice(6, 8)) / 255 : 1,
      }
    }
    return null
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(value)
  if (fn?.[1]) {
    const parts = fn[1].split(/[,\s/]+/).filter((p) => p !== "")
    const [r, g, b, a] = parts
    if (r === undefined || g === undefined || b === undefined) return null
    const channel = (s: string) => (s.endsWith("%") ? (Number.parseFloat(s) / 100) * 255 : Number.parseFloat(s))
    const alpha = a === undefined ? 1 : a.endsWith("%") ? Number.parseFloat(a) / 100 : Number.parseFloat(a)
    return { r: channel(r), g: channel(g), b: channel(b), a: Number.isFinite(alpha) ? alpha : 1 }
  }
  return null
}

/** Source-over, so a translucent plate is measured as it is seen. */
function over(front: Rgba, back: Rgba): Rgba {
  const a = front.a + back.a * (1 - front.a)
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 }
  const mix = (f: number, b: number) => (f * front.a + b * back.a * (1 - front.a)) / a
  return { r: mix(front.r, back.r), g: mix(front.g, back.g), b: mix(front.b, back.b), a }
}

function luminance({ r, g, b }: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * The colour actually behind a point, by walking up and compositing every
 * translucent layer until an opaque one. Throws rather than guessing: a walk
 * that reaches the root, or meets a gradient with no colour under it, means the
 * ring's ground is unknown, and a contrast assertion against an unknown ground
 * is worse than no assertion.
 */
function groundBehind(start: Element): { colour: Rgba; where: string } {
  const layers: Rgba[] = []
  let node: Element | null = start
  const trail: string[] = []
  while (node) {
    const style = getComputedStyle(node)
    const where = `${node.tagName.toLowerCase()}.${node.className || "(no class)"}`
    trail.push(where)
    const colour = parseColour(resolveVars(style.backgroundColor, node))
    if (colour && colour.a > 0) {
      layers.push(colour)
      if (colour.a >= 1) {
        const flat = layers.reduceRight((back, front) => over(front, back))
        return { colour: flat, where }
      }
    } else {
      const image = style.backgroundImage.trim()
      if (image !== "" && image !== "none") {
        throw new Error(`ground at ${where} is a gradient with no colour under it; trail: ${trail.join(" < ")}`)
      }
    }
    node = node.parentElement
  }
  throw new Error(`no opaque ground above ${start.tagName}; trail: ${trail.join(" < ")}`)
}

interface RingRule {
  colour: string
  offsetPx: number
  widthPx: number
  style: string
}

/** The last `:focus-visible` rule in the document that matches this element. */
function ringRuleFor(el: Element): RingRule {
  let found: RingRule | null = null
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      if (!(rule instanceof CSSStyleRule)) continue
      const selector = rule.selectorText ?? ""
      if (!selector.includes(":focus-visible")) continue
      const base = selector.replaceAll(":focus-visible", "")
      if (!el.matches(base)) continue
      found = {
        colour: rule.style.getPropertyValue("outline-color"),
        offsetPx: Number.parseFloat(rule.style.getPropertyValue("outline-offset") || "0"),
        widthPx: Number.parseFloat(rule.style.getPropertyValue("outline-width") || "0"),
        style: rule.style.getPropertyValue("outline-style"),
      }
    }
  }
  if (!found) throw new Error(`no :focus-visible rule matches ${el.tagName}.${el.className}`)
  return found
}

function focusables(host: HTMLElement): HTMLElement[] {
  return Array.from(
    host.querySelectorAll<HTMLElement>('button, textarea, a[href], [tabindex]:not([tabindex="-1"])'),
  )
}

/** Every focusable control in a tree, with the contrast of its ring. */
function ringReport(host: HTMLElement): Array<{ control: string; ratio: number; ground: string }> {
  const out: Array<{ control: string; ratio: number; ground: string }> = []
  const found = focusables(host)
  if (found.length === 0) throw new Error("nothing focusable in this tree, so the ring proof would be vacuous")
  for (const el of found) {
    const rule = ringRuleFor(el)
    expect(rule.style).not.toBe("none")
    expect(rule.widthPx).toBeGreaterThanOrEqual(2)
    const ring = parseColour(resolveVars(rule.colour, el))
    if (!ring) throw new Error(`ring colour ${rule.colour} on ${el.tagName} does not parse`)

    /* The sign of the offset decides the ground: a positive offset draws the
     * ring outside the control, on its parent. */
    const start = rule.offsetPx > 0 ? el.parentElement : el
    if (!start) throw new Error("a control with a positive ring offset has no parent to draw it on")
    const ground = groundBehind(start)
    out.push({
      control: `${el.tagName.toLowerCase()} "${accessibleName(el) || el.className}"`,
      ratio: contrast(ring, ground.colour),
      ground: ground.where,
    })
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* The plan renders from the dictated path                                     */
/* -------------------------------------------------------------------------- */

describe("the plan comes from the path the run log recorded", () => {
  test("prints the dictated path verbatim and renders that markdown", async () => {
    const { host } = await render(<Gate {...gateProps()} />)

    const chip = host.querySelector('[data-testid="kg-plan-path"]')
    expect(chip?.textContent).toBe(DICTATED_PATH)

    const article = host.querySelector("article")
    expect(article?.getAttribute("data-plan-path")).toBe(DICTATED_PATH)
    expect(article?.querySelector("h2")?.textContent).toBe("Goal")
    expect(article?.textContent).toContain("Turn each parsed manifest entry")
    expect(article?.querySelector("pre code")?.textContent).toContain("export function mapRecord")

    /* Nothing may invent a path by convention. */
    expect(host.textContent).not.toContain("docs/plans/")
  })

  test("a path the plan phase never recorded disables approval instead of guessing one", async () => {
    const { host } = await render(<Gate {...gateProps({ plan: { status: "undictated" } })} />)

    expect(host.querySelector('[data-testid="kg-plan-path"]')).toBeNull()
    expect(host.querySelector("article")).toBeNull()
    expect(host.textContent).toContain("no plan file")
    expect(host.textContent).toContain("will not guess one by convention")
    expect(buttonNamed(host, /approve/i).disabled).toBe(true)
  })

  test("an unreadable plan names the path and says why, and approval is off", async () => {
    const { host } = await render(
      <Gate
        {...gateProps({
          plan: { status: "unreadable", path: DICTATED_PATH, why: "ENOENT: no such file or directory." },
        })}
      />,
    )

    expect(host.textContent).toContain(DICTATED_PATH)
    expect(host.textContent).toContain("ENOENT")
    const approve = buttonNamed(host, /approve/i)
    expect(approve.disabled).toBe(true)
    /* The reason is announced with the control, not just printed near it. */
    const describedBy = approve.getAttribute("aria-describedby")
    expect(describedBy).toBeTruthy()
    expect(host.querySelector(`#${CSS.escape(describedBy ?? "")}`)?.textContent).toContain("nothing to approve")
  })

  test("the other files the planning step read are collapsed, and listed when opened", async () => {
    const { host } = await render(<Gate {...gateProps()} />)
    const toggle = buttonNamed(host, /planning also read/i)
    expect(accessibleName(toggle)).toContain("2 files")
    expect(toggle.getAttribute("aria-expanded")).toBe("false")

    const panelId = toggle.getAttribute("aria-controls") ?? ""
    const panel = host.querySelector(`#${CSS.escape(panelId)}`)
    expect(panel?.hasAttribute("hidden")).toBe(true)

    /* The attribute is not the behaviour: `display: flex` on the list's own
       class outranks the user agent's [hidden] rule, and the collapsed list
       rendered in full under a toggle that said it was closed. */
    expect(getComputedStyle(panel as Element).display).toBe("none")

    await click(toggle)
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    expect(panel?.hasAttribute("hidden")).toBe(false)
    expect(getComputedStyle(panel as Element).display).not.toBe("none")
    expect(Array.from(panel?.querySelectorAll("li") ?? []).map((li) => li.textContent)).toEqual([
      "src/importer/manifest.ts",
      "src/importer/writer.ts",
    ])
  })

  test("a file the log names twice is listed twice", async () => {
    const { host } = await render(<Gate {...gateProps({ filesRead: ["src/a.ts", "src/a.ts"] })} />)
    await click(buttonNamed(host, /planning also read/i))
    const panelId = buttonNamed(host, /planning also read/i).getAttribute("aria-controls") ?? ""
    const items = host.querySelectorAll(`#${CSS.escape(panelId)} li`)
    expect(Array.from(items).map((li) => li.textContent)).toEqual(["src/a.ts", "src/a.ts"])
  })

  test("no expander appears when planning read nothing else", async () => {
    const { host } = await render(<Gate {...gateProps({ filesRead: [] })} />)
    expect(buttons(host).map(accessibleName).join(" ")).not.toContain("Planning also read")
  })
})

/* -------------------------------------------------------------------------- */
/* Approve and feedback are different actions                                  */
/* -------------------------------------------------------------------------- */

describe("approve and feedback fire distinct actions", () => {
  test("Approve calls onApprove once and never onFeedback", async () => {
    const calls: string[] = []
    const { host } = await render(
      <Gate
        {...gateProps({
          onApprove: () => calls.push("approve"),
          onFeedback: (text: string) => calls.push(`feedback:${text}`),
        })}
      />,
    )

    const approve = buttonNamed(host, /approve/i)
    await click(approve)
    await click(approve)

    expect(calls).toEqual(["approve"])
    expect(host.textContent).toContain("A fresh agent is implementing the plan")
  })

  test("Send back calls onFeedback with the text exactly as typed, and never onApprove", async () => {
    const calls: string[] = []
    const { host } = await render(
      <Gate
        {...gateProps({
          onApprove: () => calls.push("approve"),
          onFeedback: (text: string) => calls.push(`feedback:${text}`),
        })}
      />,
    )

    const reply = textareaNamed(host, /reply to the draft/i)
    const typed = "  Keep unknown fields under row.meta.\n\nAnd say so in the summary.  "
    await type(reply, typed)
    await click(buttonNamed(host, /send back/i))

    expect(calls).toEqual([`feedback:${typed}`])
    expect(host.textContent).toContain("The planning conversation has your reply")
  })

  test("the reply reads as answering a draft, not as restating a task", async () => {
    const { host } = await render(<Gate {...gateProps()} />)
    const label = Array.from(host.querySelectorAll("label")).map(accessibleName).join(" | ")
    expect(label).toContain("Reply to the draft")
    expect(host.textContent).toContain("Read it the way you would read a teammate's draft")
  })

  test("an empty or whitespace-only reply cannot be sent", async () => {
    const calls: string[] = []
    const { host } = await render(<Gate {...gateProps({ onFeedback: (t: string) => calls.push(t) })} />)
    const send = buttonNamed(host, /send back/i)
    expect(send.disabled).toBe(true)

    await type(textareaNamed(host, /reply to the draft/i), "   \n  ")
    expect(send.disabled).toBe(true)
    await click(send)
    expect(calls).toEqual([])
  })

  test("the test command is printed, because it is what Approve promises", async () => {
    const { host } = await render(<Gate {...gateProps({ testCommand: "vendor/bin/pest --parallel" })} />)
    expect(host.querySelector("code")?.textContent).toBe("vendor/bin/pest --parallel")
  })

  test("the plan phase's own numbers are shown, and nothing derived from the plan text is", async () => {
    const { host } = await render(<Gate {...gateProps()} />)
    expect(host.textContent).toContain("Planned in 8s · $0.42")
    /* "4 steps" and "2 files to change" would mean parsing the plan. */
    expect(host.textContent).not.toMatch(/\d+ steps/)
    expect(host.textContent).not.toMatch(/files to change/)
  })
})

describe("the approve chord", () => {
  test("⌘↵ and Ctrl+↵ approve from the page", async () => {
    for (const mod of ["meta", "ctrl"] as const) {
      const calls: string[] = []
      const { host } = await render(<Gate {...gateProps({ onApprove: () => calls.push("approve") })} />)
      await pressSubmitChord(host.ownerDocument.body, mod)
      expect(calls).toEqual(["approve"])
    }
  })

  test("⌘↵ in the reply box sends the reply instead of approving", async () => {
    const calls: string[] = []
    const { host } = await render(
      <Gate
        {...gateProps({
          onApprove: () => calls.push("approve"),
          onFeedback: (text: string) => calls.push(`feedback:${text}`),
        })}
      />,
    )
    const reply = textareaNamed(host, /reply to the draft/i)
    await type(reply, "Persist the queue instead.")
    await pressSubmitChord(reply)

    expect(calls).toEqual(["feedback:Persist the queue instead."])
  })

  test("⌘↵ in an empty reply box does nothing at all", async () => {
    const calls: string[] = []
    const { host } = await render(
      <Gate
        {...gateProps({
          onApprove: () => calls.push("approve"),
          onFeedback: () => calls.push("feedback"),
        })}
      />,
    )
    await pressSubmitChord(textareaNamed(host, /reply to the draft/i))
    expect(calls).toEqual([])
  })

  test("a draft in the reply box stops the chord approving from anywhere", async () => {
    /* The hole this closes: the first version only refused when the chord
     * arrived *in* the reply box. Type an objection, tab to Send back or click
     * into the plan, press the chord, and it approved the plan being objected
     * to and threw the words away. */
    for (const where of ["body", "send-back", "files-toggle"] as const) {
      const calls: string[] = []
      const { host } = await render(
        <Gate
          {...gateProps({
            onApprove: () => calls.push("approve"),
            onFeedback: (text: string) => calls.push(`feedback:${text}`),
          })}
        />,
      )
      await type(textareaNamed(host, /reply to the draft/i), "Not this way.")
      const target =
        where === "body"
          ? host.ownerDocument.body
          : where === "send-back"
            ? buttonNamed(host, /send back/i)
            : buttonNamed(host, /planning also read/i)
      await pressSubmitChord(target)
      expect(calls).toEqual([])
      expect(textareaNamed(host, /reply to the draft/i).value).toBe("Not this way.")
    }
  })

  test("a chord something nearer already handled is left alone", async () => {
    const calls: string[] = []
    const { host } = await render(<Gate {...gateProps({ onApprove: () => calls.push("approve") })} />)
    const swallow = (event: Event) => event.preventDefault()
    document.addEventListener("keydown", swallow, true)
    try {
      await pressSubmitChord(host.ownerDocument.body)
      expect(calls).toEqual([])
    } finally {
      document.removeEventListener("keydown", swallow, true)
    }
    /* And still live once the other handler is gone, so this proves a guard
     * rather than a broken listener. */
    await pressSubmitChord(host.ownerDocument.body)
    expect(calls).toEqual(["approve"])
  })

  test("the chord is not live when there is no readable plan", async () => {
    const calls: string[] = []
    const { host } = await render(
      <Gate
        {...gateProps({
          plan: { status: "unreadable", path: DICTATED_PATH, why: "unreadable." },
          onApprove: () => calls.push("approve"),
        })}
      />,
    )
    await pressSubmitChord(host.ownerDocument.body)
    expect(calls).toEqual([])
  })

  test("the chord is announced on the control that owns it, and only while it works", async () => {
    const { host } = await render(<Gate {...gateProps()} />)
    /* The letter shares the attribute with the chord; both approve, so both are
     * announced on the control that owns them. */
    expect(buttonNamed(host, /approve/i).getAttribute("aria-keyshortcuts")).toBe(
      "a Meta+Enter Control+Enter",
    )

    const { host: noPlan } = await render(<Gate {...gateProps({ plan: { status: "undictated" } })} />)
    expect(buttonNamed(noPlan, /approve/i).hasAttribute("aria-keyshortcuts")).toBe(false)
  })
})

describe("`a` approves, and the one letter that does is the one that must not fire while typing", () => {
  /*
   * The trap this suite exists for: a document-level `a` handler makes the
   * reply box unusable, because the first letter of "Actually, ..." approves the
   * plan being objected to. So the guard is enumerated rather than sampled, and
   * **every refusal here is paired with the same keystroke from the page**, in
   * the same render. Without the pair, each of these would pass before the
   * shortcut existed at all.
   */

  /** One bare letter, at whatever holds it. */
  async function pressLetter(
    target: EventTarget,
    key = "a",
    init: KeyboardEventInit = {},
  ): Promise<void> {
    await act(async () => {
      target.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
      )
    })
  }

  /** Something that takes typed characters, in the document, outside the card. */
  function typingSurface(kind: string): HTMLElement {
    if (kind === "contenteditable-child") {
      const outer = document.createElement("div")
      outer.setAttribute("contenteditable", "true")
      outer.setAttribute("data-surface", "")
      const inner = document.createElement("span")
      inner.textContent = "half a sentence"
      outer.append(inner)
      document.body.append(outer)
      return inner
    }
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
    if (kind === "role=searchbox") made.setAttribute("role", "searchbox")
    made.setAttribute("data-surface", "")
    document.body.append(made)
    return made
  }

  afterEach(() => {
    for (const el of [...document.querySelectorAll("[data-surface]")]) el.remove()
  })

  test("a bare `a` from the page approves", async () => {
    const calls: string[] = []
    const { host } = await render(<Gate {...gateProps({ onApprove: () => calls.push("approve") })} />)
    await pressLetter(host.ownerDocument.body)
    expect(calls).toEqual(["approve"])
  })

  test("and it fires once, however many times it arrives", async () => {
    const calls: string[] = []
    const { host } = await render(<Gate {...gateProps({ onApprove: () => calls.push("approve") })} />)
    await pressLetter(host.ownerDocument.body)
    await pressLetter(host.ownerDocument.body)
    await pressLetter(host.ownerDocument.body)
    expect(calls).toEqual(["approve"])
  })

  test("`a` in the reply box is the letter a, even when the box is empty", async () => {
    /* The empty box is the case that isolates the target guard. With a draft
     * present the draft rule would refuse anyway, and a missing target guard
     * would hide behind it. */
    const calls: string[] = []
    const { host } = await render(
      <Gate
        {...gateProps({
          onApprove: () => calls.push("approve"),
          onFeedback: () => calls.push("feedback"),
        })}
      />,
    )
    const reply = textareaNamed(host, /reply to the draft/i)
    expect(reply.value).toBe("")

    let swallowed = true
    await act(async () => {
      const event = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true })
      reply.dispatchEvent(event)
      swallowed = event.defaultPrevented
    })
    expect(calls).toEqual([])
    /* Not consumed either: the character has to reach the box. */
    expect(swallowed).toBe(false)

    await pressLetter(host.ownerDocument.body)
    expect(calls).toEqual(["approve"])
  })

  const SURFACES = [
    "textarea",
    "input:text",
    "input:search",
    "input:password",
    "input:email",
    "input:number",
    "input:checkbox",
    "select",
    "contenteditable",
    "contenteditable-child",
    "role=textbox",
    "role=searchbox",
  ] as const

  for (const kind of SURFACES) {
    test(`\`a\` typed into ${kind} approves nothing`, async () => {
      const calls: string[] = []
      const { host } = await render(<Gate {...gateProps({ onApprove: () => calls.push("approve") })} />)
      const surface = typingSurface(kind)
      surface.focus()
      await pressLetter(surface)
      expect(calls).toEqual([])

      await pressLetter(host.ownerDocument.body)
      expect(calls).toEqual(["approve"])
    })
  }

  const MODIFIED: Array<[string, KeyboardEventInit]> = [
    ["Ctrl+A, which selects all", { ctrlKey: true }],
    ["⌘A, which selects all", { metaKey: true }],
    ["Alt+a", { altKey: true }],
    ["Shift+A", { shiftKey: true }],
  ]

  for (const [name, init] of MODIFIED) {
    test(`${name} is not the shortcut`, async () => {
      const calls: string[] = []
      const { host } = await render(<Gate {...gateProps({ onApprove: () => calls.push("approve") })} />)
      await pressLetter(host.ownerDocument.body, init.shiftKey === true ? "A" : "a", init)
      expect(calls).toEqual([])

      await pressLetter(host.ownerDocument.body)
      expect(calls).toEqual(["approve"])
    })
  }

  test("a held `a` is not an approval", async () => {
    const calls: string[] = []
    const { host } = await render(<Gate {...gateProps({ onApprove: () => calls.push("approve") })} />)
    await pressLetter(host.ownerDocument.body, "a", { repeat: true })
    expect(calls).toEqual([])

    await pressLetter(host.ownerDocument.body)
    expect(calls).toEqual(["approve"])
  })

  test("an `a` mid-composition belongs to the IME", async () => {
    const calls: string[] = []
    const { host } = await render(<Gate {...gateProps({ onApprove: () => calls.push("approve") })} />)
    await pressLetter(host.ownerDocument.body, "a", { isComposing: true })
    expect(calls).toEqual([])

    await pressLetter(host.ownerDocument.body)
    expect(calls).toEqual(["approve"])
  })

  test("an `a` something nearer already handled is left alone", async () => {
    const calls: string[] = []
    const { host } = await render(<Gate {...gateProps({ onApprove: () => calls.push("approve") })} />)
    const swallow = (event: Event) => event.preventDefault()
    document.addEventListener("keydown", swallow, true)
    try {
      await pressLetter(host.ownerDocument.body)
      expect(calls).toEqual([])
    } finally {
      document.removeEventListener("keydown", swallow, true)
    }
    await pressLetter(host.ownerDocument.body)
    expect(calls).toEqual(["approve"])
  })

  test("a draft in the reply box stops `a` approving from anywhere", async () => {
    const calls: string[] = []
    const { host } = await render(
      <Gate
        {...gateProps({
          onApprove: () => calls.push("approve"),
          onFeedback: (text: string) => calls.push(`feedback:${text}`),
        })}
      />,
    )
    await type(textareaNamed(host, /reply to the draft/i), "Not this way.")
    await pressLetter(host.ownerDocument.body)
    await pressLetter(buttonNamed(host, /send back/i))
    expect(calls).toEqual([])
    expect(textareaNamed(host, /reply to the draft/i).value).toBe("Not this way.")

    /* Clearing the objection puts the shortcut back, so this is a rule about
     * the draft rather than a listener that never worked. */
    await type(textareaNamed(host, /reply to the draft/i), "")
    await pressLetter(host.ownerDocument.body)
    expect(calls).toEqual(["approve"])
  })

  test("`a` approves nothing when there is no readable plan", async () => {
    const calls: string[] = []
    const { host } = await render(
      <Gate
        {...gateProps({
          plan: { status: "unreadable", path: DICTATED_PATH, why: "unreadable." },
          onApprove: () => calls.push("approve"),
        })}
      />,
    )
    await pressLetter(host.ownerDocument.body)
    expect(calls).toEqual([])
  })

  test("`a` cannot approve a question, in a tree that was the gate a moment ago", async () => {
    const calls: string[] = []
    const { host, rerender } = await render(
      <Gate {...gateProps({ onApprove: () => calls.push("approve") })} />,
    )
    await rerender(<Gate {...questionProps()} />)
    await pressLetter(host.ownerDocument.body)
    expect(calls).toEqual([])
  })

  test("`a` is announced on the control that owns it, and only while it works", async () => {
    const { host } = await render(<Gate {...gateProps()} />)
    expect(buttonNamed(host, /approve/i).getAttribute("aria-keyshortcuts")).toBe(
      "a Meta+Enter Control+Enter",
    )

    const { host: noPlan } = await render(<Gate {...gateProps({ plan: { status: "undictated" } })} />)
    expect(buttonNamed(noPlan, /approve/i).hasAttribute("aria-keyshortcuts")).toBe(false)
  })

  test("the shortcut is printed on the button, not only announced", async () => {
    /* A shortcut that can start an implementation run and is advertised only to
     * a screen reader is a hazard to everyone else. Both keys are printed, in
     * the key-chip style the artboard already uses for the chord. */
    const { host } = await render(<Gate {...gateProps()} />)
    const approve = buttonNamed(host, /approve/i)
    const chips = [...approve.querySelectorAll(".kg-kbd")].map((chip) =>
      (chip.textContent ?? "").trim(),
    )
    expect(chips).toEqual(["A", "\u2318\u21b5"])
  })
})

describe("a keystroke aimed at a task the screen is no longer about", () => {
  /*
   * `j` moves focus without selecting, so focus can sit on one task while the
   * gate still shows another's plan. Approving then would implement a plan the
   * human has stopped looking at. Both approval keystrokes refuse on a row that
   * is not `aria-current`, which costs one Enter.
   *
   * The real tree is rendered rather than a stand-in row, because the thing
   * being tested is that the two columns agree on the contract.
   */
  const PROJECTS: TreeProject[] = [
    {
      path: "/home/me/code/your-app",
      account: { kind: "personal" },
      testCmd: "npm test",
      features: [
        {
          path: "docs/features/importer.md",
          tasks: [
            { ref: "T1", text: "Parse the manifest", done: false },
            { ref: "T2", text: "Map records to rows", done: false },
          ],
        },
      ],
    },
  ]

  const SELECTED = {
    projectPath: "/home/me/code/your-app",
    featureFile: "docs/features/importer.md",
    taskRef: "T1",
  }

  async function screen(onApprove: () => void) {
    const mounted = await render(
      <>
        <Tree projects={PROJECTS} selected={SELECTED} onSelect={() => {}} />
        <Gate {...gateProps({ onApprove })} />
      </>,
    )
    const rows = [...mounted.host.querySelectorAll<HTMLElement>("button[data-task-row]")]
    const current = rows.find((row) => row.getAttribute("aria-current") === "true")
    const other = rows.find((row) => row.getAttribute("aria-current") !== "true")
    if (current === undefined || other === undefined) throw new Error("the tree rendered no pair of rows")
    return { ...mounted, current, other }
  }

  test("`a` on another task's row refuses; on the current one it approves", async () => {
    const calls: string[] = []
    const { current, other } = await screen(() => calls.push("approve"))

    await act(async () => {
      other.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }))
    })
    expect(calls).toEqual([])

    await act(async () => {
      current.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }))
    })
    expect(calls).toEqual(["approve"])
  })

  test("the chord refuses there too, since the hazard is the same", async () => {
    const calls: string[] = []
    const { current, other } = await screen(() => calls.push("approve"))

    await pressSubmitChord(other)
    expect(calls).toEqual([])

    await pressSubmitChord(current)
    expect(calls).toEqual(["approve"])
  })
})

describe("an action the server refuses", () => {
  test("a refused approve puts the button back and says what happened", async () => {
    let attempts = 0
    const { host } = await render(
      <Gate
        {...gateProps({
          onApprove: () => {
            attempts += 1
            return Promise.reject(new Error("Another run holds this project. Stop it first."))
          },
        })}
      />,
    )
    await click(buttonNamed(host, /approve/i))
    /* The promise rejects in a microtask; let React flush its state. */
    await act(async () => {})

    expect(attempts).toBe(1)
    expect(host.textContent).not.toContain("A fresh agent is implementing")
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Another run holds this project")
    expect(buttonNamed(host, /approve/i).disabled).toBe(false)

    /* Tried again for real: the one-shot latch has to be released too, not just
     * the rendered state, or the button comes back and does nothing. */
    await click(buttonNamed(host, /approve/i))
    await act(async () => {})
    expect(attempts).toBe(2)
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
  })

  test("a refused reply hands the words back instead of losing them", async () => {
    const { host } = await render(
      <Gate {...gateProps({ onFeedback: () => Promise.reject(new Error("This run is not at a gate.")) })} />,
    )
    const typed = "Keep unknown fields under row.meta."
    await type(textareaNamed(host, /reply to the draft/i), typed)
    await click(buttonNamed(host, /send back/i))
    await act(async () => {})

    expect(host.querySelector('[role="alert"]')?.textContent).toContain("not at a gate")
    expect(textareaNamed(host, /reply to the draft/i).value).toBe(typed)
    expect(buttonNamed(host, /send back/i).disabled).toBe(false)
  })

  test("a refused answer does the same in the question shape", async () => {
    const { host } = await render(
      <Gate {...questionProps({ onAnswer: () => Promise.reject(new Error("No route accepts an answer yet.")) })} />,
    )
    await type(textareaNamed(host, /your answer/i), "Persist it.")
    await click(buttonNamed(host, /send answer/i))
    await act(async () => {})

    expect(host.textContent).not.toContain("Planning resumed")
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("No route accepts an answer yet")
    expect(textareaNamed(host, /your answer/i).value).toBe("Persist it.")
  })

  test("a handler that throws outright is treated the same as a rejection", async () => {
    const { host } = await render(
      <Gate
        {...gateProps({
          onApprove: () => {
            throw new Error("boom")
          },
        })}
      />,
    )
    await click(buttonNamed(host, /approve/i))
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("boom")
    expect(buttonNamed(host, /approve/i).disabled).toBe(false)
  })

  test("a refusal that arrives after the run has moved on is dropped", async () => {
    /* Otherwise a slow rejection from the previous park wipes the state of the
     * one now on screen and shows a message about a decision nobody can see. */
    let refuse: (err: unknown) => void = () => {}
    const slow = new Promise<never>((_resolve, reject) => {
      refuse = reject
    })
    const { host, rerender } = await render(<Gate {...gateProps({ onApprove: () => slow })} />)
    await click(buttonNamed(host, /approve/i))
    expect(host.textContent).toContain("A fresh agent is implementing")

    await rerender(<Gate {...questionProps()} />)
    await act(async () => {
      refuse(new Error("Stale: that gate is gone."))
      await Promise.resolve()
    })

    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(host.textContent).not.toContain("Stale: that gate is gone")
    /* The question is still answerable. */
    expect(textareaNamed(host, /your answer/i).value).toBe("")
  })

  test("the refusal message is legible against the bar it sits on", async () => {
    const { host } = await render(<Gate {...gateProps({ onApprove: () => Promise.reject(new Error("Nope.")) })} />)
    await click(buttonNamed(host, /approve/i))
    await act(async () => {})
    const alert = host.querySelector('[role="alert"]') as HTMLElement
    const ink = parseColour(resolveVars(getComputedStyle(alert).color, alert))
    const ground = groundBehind(alert)
    expect(ink).not.toBeNull()
    if (ink) expect(contrast(ink, ground.colour)).toBeGreaterThanOrEqual(4.5)
  })
})

/* -------------------------------------------------------------------------- */
/* A question is not a gate                                                    */
/* -------------------------------------------------------------------------- */

describe("a waiting(question) run renders the question shape", () => {
  test("the agent's question is rendered as a bubble from the agent", async () => {
    const { host } = await render(<Gate {...questionProps()} />)
    expect(host.textContent).toContain("Should writes queued while offline survive an app restart?")
    expect(host.textContent).toContain("sqflite")
    expect(host.textContent).toContain("Planning agent asked a question")
    expect(host.textContent).toContain("asked at 18:22")
    expect(host.textContent).toContain("A question, not a plan")
    expect(host.querySelector("h1")?.textContent).toContain("asked a question")
  })

  test("the copy says plainly that there is nothing to approve", async () => {
    const { host } = await render(<Gate {...questionProps()} />)
    expect(host.textContent).toContain("There is no plan yet, so there is nothing to approve")
    expect(host.textContent).toContain("goes back into the same planning conversation")
  })

  test("an implement-phase question says what is true for it instead", async () => {
    const { host } = await render(<Gate {...questionProps({ phase: "implement" })} />)
    expect(host.textContent).toContain("Implementing agent asked a question")
    expect(host.textContent).toContain("nothing to approve")
    expect(host.textContent).toContain("same implementation conversation")
    expect(host.textContent).not.toContain("There is no plan yet")
    expect(buttons(host).some((b) => /approve/i.test(accessibleName(b)))).toBe(false)
  })

  test("Send answer passes the text verbatim and is refused while blank", async () => {
    const calls: string[] = []
    const { host } = await render(<Gate {...questionProps({ onAnswer: (t: string) => calls.push(t) })} />)
    const send = buttonNamed(host, /send answer/i)
    expect(send.disabled).toBe(true)

    const box = textareaNamed(host, /your answer/i)
    await type(box, " Persist it.\nLosing a queued write is worse. ")
    expect(send.disabled).toBe(false)
    await click(send)
    await click(send)

    expect(calls).toEqual([" Persist it.\nLosing a queued write is worse. "])
    expect(host.textContent).toContain("Planning resumed")
  })

  test("⌘↵ in the answer box sends the answer", async () => {
    const calls: string[] = []
    const { host } = await render(<Gate {...questionProps({ onAnswer: (t: string) => calls.push(t) })} />)
    const box = textareaNamed(host, /your answer/i)
    await type(box, "Persist it.")
    await pressSubmitChord(box)
    expect(calls).toEqual(["Persist it."])
  })
})

describe("the question shape exposes no way to approve", () => {
  test("no control is named approve, and the only action is the indigo send", async () => {
    const { host } = await render(<Gate {...questionProps()} />)

    expect(buttons(host).map(accessibleName)).toEqual(["Send answer"])
    expect(buttons(host).some((b) => /approve/i.test(accessibleName(b)))).toBe(false)
    expect(host.querySelectorAll("[aria-keyshortcuts]")).toHaveLength(0)
  })

  test("the word approve in the agent's own prose is not a control", async () => {
    const { host } = await render(
      <Gate {...questionProps({ question: "Shall I approve the migration myself? **Approve plan** either way." })} />,
    )
    expect(host.textContent).toContain("Approve plan")
    expect(buttons(host).map(accessibleName)).toEqual(["Send answer"])
  })

  test("no Border Beam, no check icon, no black button", async () => {
    const { host } = await render(<Gate {...questionProps()} />)

    expect(host.querySelectorAll(".kg-beam, .kg-beamframe")).toHaveLength(0)
    /* The check mark, by its path: a tick is the gate's approval glyph. */
    expect(host.querySelector('path[d="M20 6 9 17l-5-5"]')).toBeNull()

    const ink = parseColour(resolveVars("var(--color-ink)", host))
    expect(ink).not.toBeNull()
    for (const button of buttons(host)) {
      const bg = parseColour(resolveVars(getComputedStyle(button).backgroundColor, button))
      if (!bg || !ink) continue
      expect(contrast(bg, ink)).toBeGreaterThan(1.2)
    }
  })

  test("the gate's chord cannot approve a tree that has become a question", async () => {
    const calls: string[] = []
    const onApprove = () => calls.push("approve")
    const { host, rerender } = await render(<Gate {...gateProps({ onApprove })} />)

    /* Proven live first, so the negative below is not a test of nothing. */
    await pressSubmitChord(host.ownerDocument.body)
    expect(calls).toEqual(["approve"])

    await rerender(<Gate {...questionProps()} />)
    calls.length = 0
    await pressSubmitChord(host.ownerDocument.body)
    await pressSubmitChord(host, "ctrl")
    await pressSubmitChord(textareaNamed(host, /your answer/i))

    expect(calls).toEqual([])
    expect(buttons(host).some((b) => /approve/i.test(accessibleName(b)))).toBe(false)
  })

  test("the same question asked a second time is answerable again", async () => {
    /* The agent can ask the same thing twice, in the same words. Told apart by
     * their text alone the second would look like a re-render of the first, keep
     * the "sent" state, and leave the human with no composer at all. */
    const calls: string[] = []
    const onAnswer = (text: string) => calls.push(text)
    const { host, rerender } = await render(<Gate {...questionProps({ waitId: "run-9#2", onAnswer })} />)
    await type(textareaNamed(host, /your answer/i), "Persist it.")
    await click(buttonNamed(host, /send answer/i))
    expect(calls).toEqual(["Persist it."])
    expect(host.textContent).toContain("Planning resumed")

    await rerender(<Gate {...questionProps({ waitId: "run-9#6", onAnswer })} />)
    const again = textareaNamed(host, /your answer/i)
    expect(again.value).toBe("")
    await type(again, "Persist it, and say so in the plan.")
    await click(buttonNamed(host, /send answer/i))
    expect(calls).toEqual(["Persist it.", "Persist it, and say so in the plan."])
  })

  test("the same park re-rendered keeps the decision it already took", async () => {
    /* The other direction: polling re-renders identical props, and that must not
     * put the Approve button back in front of someone who just pressed it. */
    const calls: string[] = []
    const { host, rerender } = await render(
      <Gate {...gateProps({ onApprove: () => calls.push("approve") })} />,
    )
    await click(buttonNamed(host, /approve/i))
    await rerender(<Gate {...gateProps({ onApprove: () => calls.push("approve") })} />)
    expect(calls).toEqual(["approve"])
    expect(buttons(host).some((b) => /approve/i.test(accessibleName(b)))).toBe(false)
    expect(host.textContent).toContain("A fresh agent is implementing the plan")
  })

  test("a revised plan asks again rather than showing the last decision", async () => {
    const { host, rerender } = await render(<Gate {...gateProps()} />)
    await click(buttonNamed(host, /approve/i))
    expect(host.textContent).toContain("A fresh agent is implementing")

    await rerender(
      <Gate
        {...gateProps({
          waitId: "run-7#11",
          plan: { status: "loaded", path: DICTATED_PATH, markdown: "## Goal\n\nA second draft." },
        })}
      />,
    )
    expect(host.textContent).toContain("A second draft")
    expect(buttonNamed(host, /approve/i).disabled).toBe(false)
  })

  test("the type system refuses an approve handler on the question shape", () => {
    /* Not a runtime assertion. `tsc --noEmit` fails if a `@ts-expect-error`
     * line stops erroring, which is the only way to prove the shape cannot be
     * wired up at all.
     *
     * The twin below it carries identical props minus the one under test, with
     * no directive. That is what keeps the proof honest: a `@ts-expect-error` is
     * satisfied by *any* error on the line, so without a compiling twin this
     * would also pass on a typo or a missing required field. */
    const twin = <Gate kind="question" waitId="run-9#2" phase="plan" question="Which?" onAnswer={() => {}} />
    expect(twin).toBeTruthy()

    const noApprove = (
      // @ts-expect-error a question has nothing to approve, so it has no onApprove
      <Gate
        kind="question"
        waitId="run-9#2"
        phase="plan"
        question="Which?"
        onAnswer={() => {}}
        onApprove={() => {}}
      />
    )
    expect(noApprove).toBeTruthy()

    const noFeedback = (
      // @ts-expect-error feedback replies to a draft; a question has no draft to reply to
      <Gate
        kind="question"
        waitId="run-9#2"
        phase="plan"
        question="Which?"
        onAnswer={() => {}}
        onFeedback={() => {}}
      />
    )
    expect(noFeedback).toBeTruthy()
  })
})

/* -------------------------------------------------------------------------- */
/* The focus ring                                                              */
/* -------------------------------------------------------------------------- */

describe("the focus ring meets 3:1 against the ground it is drawn on", () => {
  test("every focusable control in the gate, including the disabled-plan variants", async () => {
    const variants: PlanSource[] = [
      loadedPlan,
      { status: "unreadable", path: DICTATED_PATH, why: "ENOENT." },
      { status: "undictated" },
    ]
    for (const plan of variants) {
      const { host } = await render(<Gate {...gateProps({ plan })} />)
      /* Open the collapsible so its control and panel are measured too. */
      const toggle = buttons(host).find((b) => /planning also read/i.test(accessibleName(b)))
      if (toggle) await click(toggle)

      const report = ringReport(host)
      expect(report.length).toBeGreaterThanOrEqual(3)
      for (const row of report) {
        expect(row.ratio).toBeGreaterThanOrEqual(3)
      }
    }
  })

  test("every focusable control in the question shape, including inside the Shine Border", async () => {
    const { host } = await render(<Gate {...questionProps()} />)
    const report = ringReport(host)
    expect(report.length).toBeGreaterThanOrEqual(2)
    for (const row of report) {
      expect(row.ratio).toBeGreaterThanOrEqual(3)
    }
  })

  test("links inside agent-written markdown are ringed too", async () => {
    const { host } = await render(
      <Gate
        {...gateProps({
          plan: {
            status: "loaded",
            path: DICTATED_PATH,
            markdown: "See [the RFC](https://example.com/rfc) before approving.",
          },
        })}
      />,
    )
    const link = host.querySelector("a[href]")
    expect(link).not.toBeNull()
    const measured = ringReport(host).filter((row) => row.control.startsWith("a "))
    expect(measured).toHaveLength(1)
    expect(measured[0]?.ratio).toBeGreaterThanOrEqual(3)
  })

  test("the walk fails loudly rather than passing when a ground cannot be measured", async () => {
    const { host } = await render(<Gate {...gateProps()} />)
    /* A plate the component does not draw: if the walk ever silently fell back
     * to a default, this would pass at 1:1 and nobody would know. */
    const orphan = document.createElement("div")
    orphan.innerHTML = '<button class="kg-orphan">x</button>'
    document.body.appendChild(orphan)
    try {
      expect(() => groundBehind(orphan)).toThrow(/no opaque ground/)
    } finally {
      orphan.remove()
    }
    /* And the real tree still measures, so the harness is not broken. */
    expect(ringReport(host).length).toBeGreaterThan(0)
  })

  test("every colour in the gate's stylesheet resolves without Tailwind's compiler", async () => {
    /* The blind spot this closes: happy-dom resolves `var(--color-x)` to the
     * empty string, because the compiled token layer is not loaded here. A
     * ground written that way would measure as transparent, the walk would pass
     * through it to the white card behind, and a ring on an orange plate would
     * report 19:1. Every colour the gate declares therefore carries a literal
     * fallback, and this is the test that keeps it true. */
    const { host } = await render(<Gate {...gateProps()} />)
    const scope = host.querySelector(".kg")
    expect(scope).not.toBeNull()

    const properties = ["background-color", "color", "outline-color", "border-color", "border-left-color"]
    const offenders: string[] = []
    for (const sheet of Array.from(document.styleSheets)) {
      for (const rule of Array.from(sheet.cssRules)) {
        if (!(rule instanceof CSSStyleRule)) continue
        if (!rule.selectorText.includes(".kg")) continue
        for (const property of properties) {
          const raw = rule.style.getPropertyValue(property)
          if (raw === "") continue
          /* A token reference with no fallback: invisible to this harness. */
          if (/var\(\s*--[a-z0-9-]+\s*\)/i.test(raw) && !raw.includes("--kg-")) {
            offenders.push(`${rule.selectorText} { ${property}: ${raw} }`)
            continue
          }
          const resolved = resolveVars(raw, scope)
          const named = ["transparent", "currentcolor", "inherit", "initial", "unset", "revert", "none"].includes(
            resolved.toLowerCase(),
          )
          if (!named && parseColour(resolved) === null) {
            offenders.push(`${rule.selectorText} { ${property}: ${raw} } -> ${resolved}`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test("each local alias repeats the token it mirrors, so the two cannot drift", async () => {
    const { host } = await render(<Gate {...gateProps()} />)
    const scope = host.querySelector(".kg")
    let checked = 0
    for (const sheet of Array.from(document.styleSheets)) {
      for (const rule of Array.from(sheet.cssRules)) {
        if (!(rule instanceof CSSStyleRule) || rule.selectorText !== ".kg") continue
        for (let i = 0; i < rule.style.length; i += 1) {
          const property = rule.style.item(i)
          if (!property.startsWith("--kg-")) continue
          const raw = rule.style.getPropertyValue(property)
          const match = /var\(\s*(--color-[a-z0-9-]+)\s*,\s*([^)]+)\)/i.exec(raw)
          if (!match?.[1] || !match[2]) continue
          expect(TOKENS.get(match[1])?.toLowerCase()).toBe(match[2].trim().toLowerCase())
          checked += 1
        }
      }
    }
    expect(checked).toBeGreaterThan(10)
    /* And the ring resolves to the ink token, not to some near-black of its own. */
    expect(resolveVars("var(--kg-ring)", scope).toLowerCase()).toBe((TOKENS.get("--color-ink") ?? "").toLowerCase())
  })

  test("the ring is one colour for the whole gate, with no per-control override", async () => {
    const { host } = await render(<Gate {...gateProps()} />)
    const colours = new Set(
      focusables(host).map((el) => resolveVars(ringRuleFor(el).colour, el).toLowerCase()),
    )
    expect(colours.size).toBe(1)
    /* Positive offset, which is what makes the ground the parent's. */
    for (const el of focusables(host)) {
      expect(ringRuleFor(el).offsetPx).toBeGreaterThan(0)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Reduced motion                                                              */
/* -------------------------------------------------------------------------- */

describe("prefers-reduced-motion", () => {
  test("the beam and the shiny sweep run by default", async () => {
    const { host } = await render(<Gate {...gateProps()} />)
    const section = host.querySelector("section") as HTMLElement
    expect(section.classList.contains("kg-beam")).toBe(true)
    expect(getComputedStyle(section).animation).toContain("kg-beam")
    expect(host.querySelector(".kg-shiny-anim")).not.toBeNull()
    expect(host.querySelector(".kg-pulse")).not.toBeNull()
  })

  test("set as a media feature, the beam and the sweep stop", async () => {
    setReducedMotion("reduce")
    expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true)

    const { host } = await render(<Gate {...gateProps()} />)
    const section = host.querySelector("section") as HTMLElement
    expect(section.classList.contains("kg-beam")).toBe(false)
    expect(section.classList.contains("kg-fade")).toBe(false)
    expect(getComputedStyle(section).animation).not.toContain("kg-beam")
    expect(host.querySelector(".kg-shiny-anim")).toBeNull()
    expect(host.querySelector(".kg-pulse")).toBeNull()
    expect(host.querySelector(".kg-fade")).toBeNull()
    expect(host.querySelector(".kg-spin")).toBeNull()
  })

  test("the question shape stops its pop and its Shine Border too", async () => {
    setReducedMotion("reduce")
    const { host } = await render(<Gate {...questionProps()} />)
    expect(host.querySelector(".kg-pop")).toBeNull()
    expect(host.querySelector(".kg-shineframe-anim")).toBeNull()
    /* The frame itself stays: it is the composer's edge, not the motion. */
    expect(host.querySelector(".kg-shineframe")).not.toBeNull()
  })

  test("the spinner after a decision does not spin either", async () => {
    setReducedMotion("reduce")
    const { host } = await render(<Gate {...gateProps()} />)
    await click(buttonNamed(host, /approve/i))
    expect(host.textContent).toContain("A fresh agent is implementing")
    expect(host.querySelector(".kg-spin")).toBeNull()
  })

  test("the stylesheet guards the same keyframes for a preference set after render", async () => {
    await render(<Gate {...gateProps()} />)
    const guards = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .filter((rule): rule is CSSMediaRule => rule instanceof CSSMediaRule)
      .filter((rule) => rule.conditionText.includes("prefers-reduced-motion"))
    expect(guards.length).toBeGreaterThan(0)
    const text = guards.map((rule) => Array.from(rule.cssRules).map((r) => r.cssText).join(" ")).join(" ")
    for (const animated of ["kg-beam", "kg-shiny-anim", "kg-shineframe-anim", "kg-fade", "kg-pulse", "kg-spin"]) {
      expect(text).toContain(animated)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Markdown written by an agent is not trusted                                 */
/* -------------------------------------------------------------------------- */

describe("the plan is untrusted content", () => {
  const HOSTILE = [
    "# Mapping records",
    "",
    "A plan may legitimately discuss a <Button> component, or <b>bold</b> markup.",
    "",
    "<script>alert('xss')</script>",
    "",
    '<div onclick="steal()">a raw block</div>',
    "",
    "[click me](javascript:alert(1)) and [the RFC](https://example.com/rfc)",
    "",
    "![logo](https://example.com/tracker.png)",
    "",
    `Writes to \`${"/very/deep".repeat(20)}/manifest-with-an-extremely-long-name.json\`.`,
  ].join("\n")

  async function hostile() {
    return render(<Gate {...gateProps({ plan: { status: "loaded", path: DICTATED_PATH, markdown: HOSTILE } })} />)
  }

  test("raw HTML is shown as text, never parsed, and never dropped", async () => {
    const { host } = await hostile()
    expect(host.querySelector("script")).toBeNull()
    expect(host.querySelector("b")).toBeNull()
    expect(host.querySelector("[onclick]")).toBeNull()
    /* Shown, because this is the document a human is approving: deleting part
     * of it quietly would be the worse defect. */
    expect(host.textContent).toContain("<script>alert('xss')</script>")
    expect(host.textContent).toContain("<Button>")
    expect(host.textContent).toContain('<div onclick="steal()">a raw block</div>')
  })

  test("a javascript: link is neutralised but its words survive", async () => {
    const { host } = await hostile()
    for (const anchor of Array.from(host.querySelectorAll("a"))) {
      expect(anchor.getAttribute("href") ?? "").not.toMatch(/^javascript:/i)
    }
    expect(host.textContent).toContain("click me")
    expect(host.querySelector('a[href="https://example.com/rfc"]')).not.toBeNull()
    expect(host.querySelector('a[href="https://example.com/rfc"]')?.getAttribute("rel")).toContain("noreferrer")
  })

  test("images are described, not fetched", async () => {
    const { host } = await hostile()
    expect(host.querySelector("img")).toBeNull()
    expect(host.textContent).toContain("[image: logo — https://example.com/tracker.png]")
  })

  test("a list item with mixed inline content is not laid out in columns", async () => {
    /* Markdown gives a list item a mix of text, <code> and <strong>. The
       artboard's two-column grid worked because its content was one
       hand-written <span>; applied here, every inline child became its own
       column and the text rendered a character per line. The marker is
       positioned instead, and this is the pin for it. */
    const { host } = await render(
      <Gate
        {...gateProps({
          plan: {
            status: "loaded",
            path: DICTATED_PATH,
            markdown: "1. Write `map.test.ts` **first**, then run it.\n\n- A **bullet** with `code` in it.",
          },
        })}
      />,
    )
    const items = Array.from(host.querySelectorAll("article li"))
    expect(items.length).toBe(2)
    for (const li of items) {
      const display = getComputedStyle(li).display
      expect(display === "grid" || display === "flex").toBe(false)
    }

    const { host: asked } = await render(
      <Gate {...questionProps({ question: "Which?\n\n- **Memory.** Smaller, but a force-quit loses writes." })} />,
    )
    const bubbleItem = asked.querySelector(".kg-bubble li") as HTMLElement
    const bubbleDisplay = getComputedStyle(bubbleItem).display
    expect(bubbleDisplay === "grid" || bubbleDisplay === "flex").toBe(false)
    expect(bubbleItem.textContent).toContain("Memory. Smaller, but a force-quit loses writes.")
  })

  test("long unbroken strings wrap instead of overflowing", async () => {
    const { host } = await hostile()
    const prose = host.querySelector("article") as HTMLElement
    expect(getComputedStyle(prose).overflowWrap).toBe("anywhere")
    expect(getComputedStyle(host.querySelector('[data-testid="kg-plan-path"]') as Element).overflowWrap).toBe(
      "anywhere",
    )
    const pre = host.querySelector("pre")
    if (pre) expect(getComputedStyle(pre).overflowX).toBe("auto")
  })

  test("a table in the plan renders as a table, because plans here have tables", async () => {
    const { host } = await render(
      <Gate
        {...gateProps({
          plan: {
            status: "loaded",
            path: DICTATED_PATH,
            markdown: ["| File | What |", "|---|---|", "| `map.ts` | the new mapper |"].join("\n"),
          },
        })}
      />,
    )
    expect(host.querySelector("table")).not.toBeNull()
    expect(Array.from(host.querySelectorAll("th")).map((th) => th.textContent)).toEqual(["File", "What"])
    expect(host.querySelector("td code")?.textContent).toBe("map.ts")
    /* And it scrolls on its own axis rather than widening the card. */
    expect(getComputedStyle(host.querySelector("table") as Element).overflowX).toBe("auto")
  })

  test("a task list keeps its boxes, and they are not operable", async () => {
    const { host } = await render(
      <Gate
        {...gateProps({
          plan: {
            status: "loaded",
            path: DICTATED_PATH,
            markdown: "- [x] Write the failing test\n- [ ] Make it pass",
          },
        })}
      />,
    )
    const boxes = Array.from(host.querySelectorAll('input[type="checkbox"]'))
    expect(boxes).toHaveLength(2)
    /* A plan is a document, not a form: ticking a box here would record nothing
     * and the orchestrator owns the real tick. */
    for (const box of boxes) expect((box as HTMLInputElement).disabled).toBe(true)
    expect(focusables(host).some((el) => el.tagName === "INPUT")).toBe(false)
  })

  test("GFM does not open the door to raw HTML", async () => {
    const { host } = await render(
      <Gate
        {...gateProps({
          plan: {
            status: "loaded",
            path: DICTATED_PATH,
            markdown: "| A |\n|---|\n| <script>alert(1)</script> |",
          },
        })}
      />,
    )
    expect(host.querySelector("script")).toBeNull()
    expect(host.querySelector("td")?.textContent).toContain("<script>alert(1)</script>")
  })

  test("the question text goes through the same pipeline", async () => {
    const { host } = await render(
      <Gate {...questionProps({ question: "Use <script>alert(1)</script> or ![x](https://e/x.png)?" })} />,
    )
    expect(host.querySelector("script")).toBeNull()
    expect(host.querySelector("img")).toBeNull()
    expect(host.textContent).toContain("<script>alert(1)</script>")
  })
})
