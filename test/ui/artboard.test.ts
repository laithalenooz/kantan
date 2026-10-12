/**
 * `src/ui/artboard.css` against the artboards it was extracted from.
 *
 * The point of this suite is not that the file parses. It is that the file still
 * *says what the artboards say*. Three things here break in silence:
 *
 *  - **A keyframe present by name with a drifted value.** A fade from 10px
 *    instead of 12px, a pulse ring at 8px instead of 11px: nothing throws, no
 *    assertion that queries for a node notices, and the screenshot looks
 *    plausible. So this suite does not check keyframe *names* — it parses each
 *    artboard's own `<style>` block and asserts every rule's **body** survived.
 *  - **`@property --a`.** It is the only reason the Border Beam moves. Drop it,
 *    or omit one of its three required descriptors, and the angle stops being
 *    interpolable: the conic gradient renders statically at its initial 0deg,
 *    which is a perfectly reasonable-looking border. Nothing throws.
 *  - **The reduced-motion guard.** Delete it and the suite still passes, the
 *    page still renders, and a user who asked for no motion gets a spinner.
 *
 * It is a text suite on purpose. These are CSS facts, so a DOM would add the
 * happy-dom registrator — which the other UI suites contend over — and prove
 * nothing extra: happy-dom does not run the cascade, resolve `@property`, or
 * honour a media query. The cascade claims were checked in a real browser
 * instead; see the harness notes in the task report.
 *
 * **What this suite cannot see**, stated per `CLAUDE.md`'s corollary: it reads
 * the source file, not the bundle. It cannot tell you that Vite and Lightning
 * CSS kept `@property` through minification — only a build can, and nothing in
 * `src/` imports `artboard.css` yet, so the repo's own build does not include
 * it. The grep that settles it once the adoption pass adds the import is in the
 * report.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO = join(import.meta.dir, "..", "..")
const ARTBOARDS = ["Main", "Return", "Question", "Empty", "States"] as const
type Artboard = (typeof ARTBOARDS)[number]

const source = readFileSync(join(REPO, "src", "ui", "artboard.css"), "utf8")

/** The comments in `artboard.css` quote CSS at length — they name `.beam`,
 * `@keyframes kbeam`, even `button{font:inherit}`. Matching against the file
 * with its comments intact would let a *mention* of a rule satisfy a test that
 * the rule exists. Strip them first, always. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "")
}

const css = stripComments(source)

/**
 * Collapse two spellings of the same CSS to one string.
 *
 * The artboards are minified one-liners; `artboard.css` is formatted for people
 * to read. Every difference between them is one of these, and none of them
 * changes what a browser does:
 *
 *   `#7A7F8C` / `#7a7f8c`      casing
 *   `'<angle>'` / `"<angle>"`  quote style
 *   `.55` / `0.55`             the optional leading zero
 *   `a{b:c}` / `a {\n b: c;\n}` whitespace, and the optional final semicolon
 *
 * Whitespace is **collapsed, not deleted**. Deleting it would fold `.kr-empty
 * .bf` (a descendant) into `.kr-empty.bf` (a compound) and let one match the
 * other. It is only removed where it cannot be meaningful: next to `{};:,()`.
 */
function normalize(cssText: string): string {
  return (
    cssText
      .replace(/'/g, '"')
      .toLowerCase()
      .replace(/\s+/g, " ")
      /* Around punctuation, whitespace carries nothing. Between values —
       * `0 0 0 9px`, `28px minmax(0,1fr)`, `translate:0 -7px` — it does. */
      .replace(/\s*([{};:,()])\s*/g, "$1")
      /* A declaration block's last semicolon is optional; the artboards omit it
       * and a formatter adds it. Looped because `;}}` nests. */
      .replace(/;+\}/g, "}")
      .replace(/;+\}/g, "}")
      /* `none !important` and `none!important` are the same declaration. */
      .replace(/\s*!/g, "!")
      /* `0.7s` and `.7s` are the same length of time. */
      .replace(/(^|[^0-9a-z.])0\./g, "$1.")
  )
}

/** One top-level rule: its prelude (selector or at-rule) and its whole body,
 * nesting included. `@keyframes kfade{from{…}to{…}}` comes back as one unit, so
 * comparing bodies compares the keyframe's actual values. */
type Rule = { prelude: string; body: string; text: string }

/**
 * Walk CSS and return its top-level rules.
 *
 * Hand-written rather than regex because the artboards pack several rules onto
 * one line — `.d1{…}.d2{…}.d3{…}`, `a{…}a:hover{…}` — so line splitting finds
 * nine delay classes as one rule, and because `@media` and `@keyframes` bodies
 * contain braces that a non-counting matcher ends on.
 */
function rules(cssText: string): Rule[] {
  const found: Rule[] = []
  let prelude = ""
  let i = 0

  while (i < cssText.length) {
    const ch = cssText[i]
    if (ch === undefined) break

    if (ch !== "{") {
      /* A statement at-rule — `@layer theme, base, …;` — ends at its
       * semicolon and never opens a block. */
      if (ch === ";" && prelude.trim().startsWith("@")) {
        found.push({ prelude: prelude.trim(), body: "", text: `${prelude.trim()};` })
        prelude = ""
      } else {
        prelude += ch
      }
      i += 1
      continue
    }

    let depth = 0
    let j = i
    for (; j < cssText.length; j += 1) {
      const c = cssText[j]
      if (c === "{") depth += 1
      else if (c === "}") {
        depth -= 1
        if (depth === 0) break
      }
    }

    const body = cssText.slice(i + 1, j)
    found.push({ prelude: prelude.trim(), body, text: `${prelude.trim()}{${body}}` })
    prelude = ""
    i = j + 1
  }

  return found
}

/** The `<style>` block of one artboard, verbatim. */
function artboardStyle(name: Artboard): string {
  const html = readFileSync(join(REPO, "docs", "design", `${name}.dc.html`), "utf8")
  const match = /<style[^>]*>([\s\S]*?)<\/style>/.exec(html)
  const block = match?.[1]
  if (block === undefined) throw new Error(`${name}.dc.html has no <style> block to extract`)
  return block
}

/**
 * Rules the extraction deliberately rewrote, keyed by their normalized artboard
 * form. Each maps to what `artboard.css` must contain instead.
 *
 * Everything in here is a case where two artboards disagreed, or where the
 * artboard's selector could not survive contact with Tailwind. Nothing is in
 * here to make a test pass.
 */
const REWRITTEN = new Map<string, string>([
  /* `Empty` fades further, slower, and from a heavier blur than the other four.
   * Both spellings have to coexist, so Empty's is renamed and scoped. */
  [
    "@keyframes kfade{from{opacity:0;transform:translatey(12px);filter:blur(8px)}to{opacity:1;transform:none;filter:blur(0)}}",
    "@keyframes kfade-empty{from{opacity:0;transform:translatey(12px);filter:blur(8px)}to{opacity:1;transform:none;filter:blur(0)}}",
  ],
  [
    ".bf{animation:kfade .8s cubic-bezier(.2,.7,.2,1) both}",
    ".kr-empty .bf{animation:kfade-empty .8s cubic-bezier(.2,.7,.2,1) both}",
  ],

  /* `Empty`'s pulse ring stops a pixel tighter than the gate's 9px. */
  [
    "@keyframes kpulse{0%{box-shadow:0 0 0 0 rgba(255,106,26,.55)}70%{box-shadow:0 0 0 8px rgba(255,106,26,0)}100%{box-shadow:0 0 0 0 rgba(255,106,26,0)}}",
    "@keyframes kpulse-empty{0%{box-shadow:0 0 0 0 rgba(255,106,26,.55)}70%{box-shadow:0 0 0 8px rgba(255,106,26,0)}100%{box-shadow:0 0 0 0 rgba(255,106,26,0)}}",
  ],
  /* Only the animation's *name* is re-pointed; the shorthand's timing comes
   * from the unscoped `.pulse`, exactly as in the artboard. */
  [".pulse{animation:kpulse 1.8s ease-out infinite}", ".kr-empty .pulse{animation-name:kpulse-empty}"],

  /* `Empty`'s delay ladder steps .08s, and its tail is irregular: .4s, .5s,
   * .6s rather than .4s, .48s, .56s. Transcribed literally, not computed. */
  [".d1{animation-delay:.08s}", ".kr-empty .d1{animation-delay:.08s}"],
  [".d2{animation-delay:.16s}", ".kr-empty .d2{animation-delay:.16s}"],
  [".d3{animation-delay:.24s}", ".kr-empty .d3{animation-delay:.24s}"],
  [".d4{animation-delay:.32s}", ".kr-empty .d4{animation-delay:.32s}"],
  [".d5{animation-delay:.4s}", ".kr-empty .d5{animation-delay:.4s}"],
  [".d6{animation-delay:.5s}", ".kr-empty .d6{animation-delay:.5s}"],
  [".d7{animation-delay:.6s}", ".kr-empty .d7{animation-delay:.6s}"],

  /* A different dot colour and a different mask ellipse — visibly different on
   * the one screen that uses it. */
  [
    ".dots{background-image:radial-gradient(#cfd0d8 1px,transparent 1px);background-size:20px 20px;-webkit-mask-image:radial-gradient(ellipse 70% 70% at 70% 40%,#000 15%,transparent 70%);mask-image:radial-gradient(ellipse 70% 70% at 70% 40%,#000 15%,transparent 70%)}",
    ".kr-empty .dots{background-image:radial-gradient(#cfd0d8 1px,transparent 1px);background-size:20px 20px;-webkit-mask-image:radial-gradient(ellipse 70% 70% at 70% 40%,#000 15%,transparent 70%);mask-image:radial-gradient(ellipse 70% 70% at 70% 40%,#000 15%,transparent 70%)}",
  ],

  /* Both motion kill-switches are widened from `X *` to `X, X *`. No artboard
   * animates its own root, so this changes nothing about them — it stops a
   * root-level `.bf` in a ported component from ignoring the preference. */
  [".still *{animation:none!important}", ".still,.still *{animation:none!important}"],
  [
    "@media(prefers-reduced-motion:reduce){.kr *{animation:none!important}}",
    "@media(prefers-reduced-motion:reduce){.kr,.kr *{animation:none!important}}",
  ],
])

/**
 * Rules that must **not** appear in `artboard.css`, keyed the same way.
 *
 * Asserted as absences rather than just left out, because a later careless
 * "take the union" pass would reintroduce them and break something quietly:
 * a second owner for `body`, or `States`' specimen-sheet geometry leaking onto
 * the real screens.
 */
const NOT_CARRIED = new Map<string, string>([
  [
    "body{margin:0;background:#f4f4f6}",
    "tokens.css owns body, and a second owner is how this project already wiped its own theme once",
  ],
  ["body{margin:0}", "same: body belongs to tokens.css"],
  [
    ".ic{fill:none;stroke:currentcolor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex:none}",
    "States omits the 16px default, but all nine of its .ic set a size inline, which outranks the class",
  ],
  [
    "@keyframes kpulse{0%{box-shadow:0 0 0 0 rgba(255,106,26,.55)}70%{box-shadow:0 0 0 11px rgba(255,106,26,0)}100%{box-shadow:0 0 0 0 rgba(255,106,26,0)}}",
    "States' 11px ring is specimen-sheet geometry; in-app glyphs pulse at Main's 9px",
  ],
  [".d1{animation-delay:.04s}", "States' .04s ladder is specimen-sheet only"],
  [".d2{animation-delay:.08s}", "States' .04s ladder is specimen-sheet only"],
  [".d3{animation-delay:.12s}", "States' .04s ladder is specimen-sheet only"],
  [".d4{animation-delay:.16s}", "States' .04s ladder is specimen-sheet only"],
  [".d5{animation-delay:.2s}", "States' .04s ladder is specimen-sheet only"],
  [".d6{animation-delay:.24s}", "States' .04s ladder is specimen-sheet only"],
  [".d7{animation-delay:.28s}", "States' .04s ladder is specimen-sheet only"],
  [".d8{animation-delay:.32s}", "States' .04s ladder is specimen-sheet only"],
  [".d9{animation-delay:.36s}", "States' .04s ladder is specimen-sheet only"],
])

/* Both maps are written in readable CSS and normalized here, rather than being
 * hand-typed in normalized form. Keying a lookup on a spelling the normalizer
 * would have changed — `) both` against `)both` — fails as a *missing rule*,
 * which reads like a transcription error in the stylesheet rather than a typo
 * in the test. */
const rewritten = new Map([...REWRITTEN].map(([from, to]) => [normalize(from), normalize(to)] as const))
const notCarried = new Map([...NOT_CARRIED].map(([rule, why]) => [normalize(rule), why] as const))

const normalizedCss = normalize(css)

describe("every rule in every artboard is accounted for", () => {
  /* The whole point of the extraction. A rule is carried verbatim, rewritten
   * for a named reason, or refused for a named reason — and this covers all
   * five artboards, so a rule only Question defines cannot be forgotten. */
  for (const name of ARTBOARDS) {
    test(`${name}.dc.html`, () => {
      const parsed = rules(artboardStyle(name))
      expect(parsed.length).toBeGreaterThan(0)

      const missing: string[] = []
      const leaked: string[] = []

      for (const rule of parsed) {
        const key = normalize(rule.text)

        const refusal = notCarried.get(key)
        if (refusal !== undefined) {
          if (normalizedCss.includes(key)) leaked.push(`${key} — should be absent: ${refusal}`)
          continue
        }

        const expected = rewritten.get(key) ?? key
        if (!normalizedCss.includes(expected)) missing.push(expected)
      }

      expect(missing).toEqual([])
      expect(leaked).toEqual([])
    })
  }
})

test("States' specimen geometry is nowhere in the file, under any name", () => {
  /* The NOT_CARRIED check above matches States' rules by their exact text, so it
   * catches the rule being copied in — but not its *values* being reintroduced
   * under a new keyframe name. A mutation battery found exactly that hole: a
   * `kpulse-states` keyframe holding the 11px ring passed every other test
   * here. These assertions are on the values, so the name cannot launder them.
   *
   * Only the figures unique to States are listed. Its .08s, .16s, .24s and .32s
   * steps are also Empty's, and its .2s is also the base ladder's. */
  expect(normalizedCss).not.toContain("0 0 0 11px")
  for (const delay of [".04s", ".12s", ".28s", ".36s"]) {
    expect(normalizedCss).not.toContain(`animation-delay:${delay}`)
  }
})

describe("@property, the one that fails without a symptom", () => {
  /* `--a` drives the Border Beam, `--s` the focused composer's Shine Border.
   * Without the registration the angle is an unparsed token, so it cannot be
   * interpolated and the gradient sits at its initial value forever. */
  for (const prop of ["--a", "--s"] as const) {
    test(`${prop} is registered with all three required descriptors`, () => {
      const match = new RegExp(`@property\\s+${prop}\\s*\\{([^}]*)\\}`).exec(css)
      expect(match).not.toBeNull()

      const body = normalize(match?.[1] ?? "")
      /* All three are required. A `@property` missing `syntax` or `inherits` is
       * invalid and the browser drops the whole rule without a word. */
      expect(body).toContain('syntax:"<angle>"')
      expect(body).toContain("initial-value:0deg")
      expect(body).toContain("inherits:false")
    })
  }

  test("each registered angle is actually animated by a keyframe", () => {
    /* A registration nothing drives, or a keyframe driving a name that is not
     * registered, are both dead code that looks alive. */
    expect(normalizedCss).toContain("@keyframes kbeam{to{--a:360deg}}")
    expect(normalizedCss).toContain("@keyframes kshineb{to{--s:360deg}}")
    expect(normalizedCss).toContain("conic-gradient(from var(--a)")
    expect(normalizedCss).toContain("conic-gradient(from var(--s)")
  })
})

describe("motion stops when it is asked to", () => {
  test("the reduced-motion guard exists, and covers the root as well as its children", () => {
    /* Compared as a whole parsed rule rather than a regex capture, so the
     * assertion cannot be satisfied by a prefix that stops before the brace
     * that closes the media block. */
    const guards = rules(css).filter((r) => r.prelude.startsWith("@media"))
    expect(guards.length).toBe(1)
    expect(normalize(guards[0]?.text ?? "")).toBe(
      "@media(prefers-reduced-motion:reduce){.kr,.kr *{animation:none!important}}",
    )
  })

  test("the guard is unlayered, so it outranks Tailwind's animate-* utilities", () => {
    /* `!important` beats every normal declaration in every layer — but only if
     * the rule is not itself inside a layer block whose closing brace this
     * would sit before. Both kill-switches live after the last `}` of the
     * `@layer components` block. */
    const components = css.lastIndexOf("@layer components")
    const still = css.indexOf(".still")
    const reduce = css.indexOf("prefers-reduced-motion")
    expect(still).toBeGreaterThan(components)
    expect(reduce).toBeGreaterThan(still)

    const tail = css.slice(still)
    expect(tail).not.toContain("@layer")
  })

  test("the screenshot mode exists", () => {
    expect(normalizedCss).toContain(".still,.still *{animation:none!important}")
  })
})

describe("the cascade", () => {
  test("Tailwind's layer order is restated, so this file cannot reorder it", () => {
    /* Unlayered CSS outranks every layer. Left unlayered, `button{font:inherit}`
     * here would beat `font-mono` on every button in the app. Restating the
     * order makes the file safe to import before or after tokens.css. */
    expect(normalizedCss).toContain("@layer theme,base,components,utilities;")
  })

  test("element rules are in @layer base and class rules in @layer components", () => {
    const base = /@layer\s+base\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ""
    expect(normalize(base)).toContain("button{font:inherit;cursor:pointer}")
    expect(normalize(base)).toContain("a{color:#4b4bc8}")

    const components = /@layer\s+components\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ""
    expect(normalize(components)).toContain(".m{font-family:")
    expect(normalize(components)).toContain(".ic{width:16px")
  })

  test("the delay ladder is declared after .bf, in both scopes", () => {
    /* Load-bearing order, not formatting. The `animation` shorthand resets
     * `animation-delay`, so `class=\"bf d2\"` only gets its 0.1s because `.d2`
     * comes after `.bf`. Reversing them silently unstaggers every entrance. */
    expect(css.indexOf(".bf {")).toBeLessThan(css.indexOf(".d1 {"))
    expect(css.indexOf(".kr-empty .bf {")).toBeLessThan(css.indexOf(".kr-empty .d1 {"))
  })
})

describe("the fonts stay local", () => {
  test("no network request, and no second owner for @font-face", () => {
    /* The artboards pull Geist from Google Fonts with a <link>. tokens.css
     * already declares both families from src/ui/fonts as variable faces, and a
     * tool that binds to loopback so it talks to nothing must not fetch a font
     * on every load. */
    expect(css).not.toContain("fonts.googleapis.com")
    expect(css).not.toContain("@font-face")
    expect(css).not.toContain("@import")
    expect(css).not.toMatch(/url\(\s*["']?https?:/)
  })

  test("tokens.css covers every weight the artboards ask for", () => {
    const tokens = readFileSync(join(REPO, "src", "ui", "tokens.css"), "utf8")
    /* The <link> asks for Geist 400;500;600;700 and Geist Mono 400;500;600, and
     * `.plan` additionally uses 650 and 620 — which only a variable face can
     * give without synthesizing. Three @font-face rules, each 100-900. */
    const faces = tokens.match(/@font-face\s*\{[\s\S]*?\}/g) ?? []
    expect(faces.length).toBe(3)
    for (const face of faces) expect(normalize(face)).toContain("font-weight:100 900")

    expect(tokens).toContain('font-family: "Geist"')
    expect(tokens).toContain('font-family: "Geist Mono"')
    /* The families this file names have to be the families tokens.css declares,
     * or `.m` falls through to ui-monospace and nobody notices in a screenshot. */
    expect(normalizedCss).toContain('.m{font-family:"geist mono"')
    expect(normalizedCss).toContain('.plan code{font-family:"geist mono"')
  })
})

describe("the class inventory a component can port against", () => {
  /* The contract with the adoption pass: these names exist, so artboard markup
   * can be lifted with its class attributes intact. A rename shows up here. */
  const CLASSES = [
    "m", "ic",
    "bf", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9", "d10",
    "band", "beam", "calm", "slide", "pop",
    "pulse", "pulsed", "pulsei", "spin",
    "shiny", "shineb", "ring", "tick",
    "fl", "fl2", "fl3", "flow",
    "trow", "lr", "ghost", "send", "cta", "card",
    "dots", "plan", "kw", "ty", "st",
    "still", "kr", "kr-empty",
  ] as const

  for (const cls of CLASSES) {
    test(`.${cls}`, () => {
      /* Anchored so `.d1` cannot be satisfied by `.d10`, and `.fl` by `.flow`. */
      expect(normalizedCss).toMatch(new RegExp(`\\.${cls.replace(/-/g, "\\-")}(?![a-z0-9_-])`))
    })
  }

  test("every keyframe any artboard defines is present by name", () => {
    /* Name-level and union-wide, so a keyframe added to an artboard later fails
     * here even if nothing in this suite names it. The two Empty renames are
     * the only accepted substitutions. */
    const renamed = new Map([
      ["kfade", ["kfade", "kfade-empty"]],
      ["kpulse", ["kpulse", "kpulse-empty"]],
    ])

    const wanted = new Set<string>()
    for (const name of ARTBOARDS) {
      for (const match of artboardStyle(name).matchAll(/@keyframes\s+([a-z0-9-]+)/gi)) {
        const kf = match[1]
        if (kf !== undefined) wanted.add(kf)
      }
    }
    /* Fifteen distinct names across the five artboards. DESIGN.md lists twelve;
     * it omits kpulsed, kpulsei and kshineb. The artboards are authoritative. */
    expect(wanted.size).toBe(15)

    const declared = new Set(
      [...css.matchAll(/@keyframes\s+([a-z0-9-]+)/gi)].map((m) => m[1]).filter((n): n is string => n !== undefined),
    )

    const absent = [...wanted].filter((kf) => {
      const accepted = renamed.get(kf) ?? [kf]
      return !accepted.some((n) => declared.has(n))
    })
    expect(absent).toEqual([])
  })
})
