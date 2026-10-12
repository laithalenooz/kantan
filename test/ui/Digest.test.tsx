/**
 * Coming back: the band that says whether anything needs you, and the digest
 * that says what happened while you were away.
 *
 * `docs/design/Return.dc.html` is the specification. Four promises are checked
 * here because breaking any of them is silent:
 *
 * 1. **An exit code is printed verbatim or declared missing.** Never "looks
 *    good", never a green tick standing in for a number, and never a code
 *    invented for an attempt whose outcome nobody read.
 * 2. **"Nothing needs you" is a claim, not a decoration.** It is only ever
 *    made from a count the caller supplies, and never over a run that is
 *    itself parked on a human.
 * 3. **Only one `RunState` is "still going".** The other eight read
 *    differently, and a digest that greets a failed run with "still going"
 *    is the worst defect this component could have.
 * 4. **The stagger and the slide stop under `prefers-reduced-motion`.**
 *
 * ## Two things about this harness that are not incidental
 *
 * **happy-dom is registered before `motion` is imported.** `motion-dom` decides
 * `const isBrowser = typeof window !== "undefined"` at module evaluation, and
 * ES imports hoist above the module body — so a plain top-level
 * `import { motion } from "motion/react"` evaluates while there is no `window`,
 * and `useReducedMotion()` answers `null` for the life of the process whatever
 * the media query says. Registration first, DOM-sensing modules second, via
 * `await import()`.
 *
 * **The first render in this file must happen with the preference off.**
 * Motion's `useReducedMotion()` latches a module-level singleton at the first
 * call anywhere in the process. If this file's first render were the reduced
 * one, that singleton could hold `true` for the rest of the suite and the
 * reduced-motion tests would pass through Motion's hook alone — which is the
 * thing they exist to disprove. So `beforeEach` sets the feature off, the
 * first describe renders with it off, and the reduced-motion tests turn it on
 * themselves. Verified by deleting the live `matchMedia` read from
 * `usePrefersReducedMotion` in `src/ui/Digest.tsx`: the four tests in
 * "reduced motion" fail, and they are the only ones that do.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

import type { RunState } from "../../src/runindex.ts"

/* Registered at module load, before React is imported, and only if nobody else
 * got there first: `register()` throws on a second call and `bun test` runs
 * every file in one process (docs/HANDOFF.md). Unregistered only if we took
 * the slot. */
const registeredHere = !GlobalRegistrator.isRegistered
if (registeredHere) GlobalRegistrator.register()

const React = await import("react")
const { act } = React
const { createRoot } = await import("react-dom/client")
const { Digest, ReturnBand, awayLabel, clockLabel, digestProse, exitReading, stateReading } = await import(
  "../../src/ui/Digest.tsx"
)
type DigestEntry = import("../../src/ui/Digest.tsx").DigestEntry
type DigestSubject = import("../../src/ui/Digest.tsx").DigestSubject

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const happy = globalThis as unknown as {
  happyDOM?: { settings: { device: { prefersReducedMotion: string } } }
}

/** Sets the media feature itself, not a flag the component reads. */
function setReducedMotion(on: boolean): void {
  const settings = happy.happyDOM?.settings
  if (settings === undefined) throw new Error("happy-dom is not registered, so the media feature cannot be set")
  settings.device.prefersReducedMotion = on ? "reduce" : "no-preference"
}

let host: HTMLElement
let root: ReturnType<typeof createRoot>

async function render(ui: React.ReactNode): Promise<void> {
  await act(async () => {
    root.render(ui)
  })
}

/** Lets queued frames and timers run, so an entrance can finish. */
async function settle(ms = 900): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

function one(selector: string): HTMLElement {
  const found = host.querySelector(selector)
  if (found === null) throw new Error(`nothing matched ${selector} in:\n${host.innerHTML}`)
  return found as HTMLElement
}

function all(selector: string): HTMLElement[] {
  return [...host.querySelectorAll(selector)] as HTMLElement[]
}

function flat(text: string | null): string {
  return (text ?? "").replace(/\s+/g, " ").trim()
}

function textOf(selector: string): string {
  return flat(one(selector).textContent)
}

function entries(): HTMLElement[] {
  return all("[data-digest-entry]")
}

function entryOfKind(kind: string): HTMLElement {
  const found = entries().find((item) => item.dataset["kind"] === kind)
  if (found === undefined) throw new Error(`no ${kind} entry in:\n${host.innerHTML}`)
  return found
}

beforeEach(() => {
  setReducedMotion(false)
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  host.remove()
  setReducedMotion(false)
})

afterAll(async () => {
  if (registeredHere) await GlobalRegistrator.unregister()
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Every shape `RunState` can take. Nine, counting both `done`s. */
const STATES: readonly RunState[] = [
  { kind: "running", phase: "test" },
  { kind: "waiting", reason: "gate" },
  { kind: "waiting", reason: "question" },
  { kind: "waiting", reason: "blocked" },
  { kind: "waiting", reason: "stalled" },
  { kind: "done", merged: true },
  { kind: "done", merged: false },
  { kind: "failed", why: "tests failed after 3 attempts" },
  { kind: "interrupted", resumeFrom: "implement" },
]

const RUN = "r-8f3a1c"
const id = (index: number) => `${RUN}#${index}`

const SUBJECT: DigestSubject = {
  state: { kind: "running", phase: "test" },
  taskRef: "T2",
  title: "Map records to rows",
  project: "your-app",
  attempt: 6,
}

/** 17:58 and 18:31 on a fixed day, so the clock column is deterministic. */
const APPROVED_AT = new Date(2026, 9, 11, 17, 58, 0).getTime()
const NOW = new Date(2026, 9, 11, 18, 31, 0).getTime()
const MINUTE = 60_000

/** The artboard's own timeline, entry for entry. */
const TIMELINE: readonly DigestEntry[] = [
  { id: id(1), kind: "approved", at: APPROVED_AT },
  { id: id(2), kind: "implemented", at: APPROVED_AT + MINUTE, files: 2, added: 21, removed: 2 },
  { id: id(3), kind: "tests", at: APPROVED_AT + 8 * MINUTE, attempt: 1, exitCode: 1, summary: "9 passing, 1 failing", signature: "a" },
  { id: id(4), kind: "tests", at: APPROVED_AT + 11 * MINUTE, attempt: 2, exitCode: 1, signature: "a" },
  { id: id(5), kind: "tests", at: APPROVED_AT + 14 * MINUTE, attempt: 3, exitCode: 1, signature: "a" },
  { id: id(6), kind: "escalation", at: APPROVED_AT + 14 * MINUTE, effort: "high", identicalFailures: 3 },
  { id: id(7), kind: "tests", at: APPROVED_AT + 21 * MINUTE, attempt: 4, exitCode: 1, signature: "b" },
  { id: id(8), kind: "tests", at: APPROVED_AT + 28 * MINUTE, attempt: 5, exitCode: 1, summary: "10 passing, 1 failing", signature: "b", grinding: true },
  { id: id(9), kind: "running", at: NOW, attempt: 6, command: "npm test", elapsed: "0:42" },
]

function digest(over: Partial<Parameters<typeof Digest>[0]> = {}) {
  return (
    <Digest
      subject={SUBJECT}
      entries={TIMELINE}
      needsYou={0}
      startedAtMs={APPROVED_AT}
      nowMs={NOW}
      testCommand="npm test"
      {...over}
    />
  )
}

function band(over: Partial<Parameters<typeof ReturnBand>[0]> = {}) {
  return <ReturnBand subject={SUBJECT} needsYou={0} {...over} />
}

// ---------------------------------------------------------------------------
// The band
// ---------------------------------------------------------------------------

describe("the band", () => {
  test("reads the run and says nothing needs you", async () => {
    await render(band())

    const el = one('[data-testid="return-band"]')
    expect(el.getAttribute("role")).toBe("status")
    expect(el.dataset["state"]).toBe("running")
    expect(flat(el.textContent)).toContain("Running")
    expect(flat(el.textContent)).toContain("your-app")
    expect(flat(el.textContent)).toContain("T2")
    expect(flat(el.textContent)).toContain("Map records to rows")
    expect(flat(el.textContent)).toContain("attempt 6")
    expect(textOf('[data-testid="band-claim"]')).toBe("Nothing needs you")
  })

  test("is a notice: nothing is trapped and nothing is a dialog", async () => {
    await render(band())

    expect(host.querySelector("[aria-modal]")).toBeNull()
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(host.querySelector('[role="alertdialog"]')).toBeNull()
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  test("only running spins", async () => {
    for (const state of STATES) {
      await render(band({ subject: { ...SUBJECT, state } }))
      const spinners = all('[data-glyph="running"]')
      expect(spinners).toHaveLength(state.kind === "running" ? 1 : 0)
      /* And nothing else in the band pulses: the pulse belongs to "needs you",
       * and this band is the calm one. */
      expect(all('[data-motion="pulse"]')).toHaveLength(0)
    }
  })

  test("prints the attempt it was given, and nothing when it has none", async () => {
    await render(band({ subject: { ...SUBJECT, attempt: undefined } }))
    expect(flat(one('[data-testid="return-band"]').textContent)).not.toContain("attempt")
  })

  test("a task with no title reads as its ref alone", async () => {
    await render(band({ subject: { ...SUBJECT, title: undefined } }))
    const text = flat(one('[data-testid="return-band"]').textContent)
    expect(text).toContain("T2")
    expect(text).not.toContain("undefined")
  })

  test("a 190-character task title wraps rather than being clipped", async () => {
    const title = `Retry webhook deliveries with exponential backoff, and stop once the provider returns 410 Gone, ${"x".repeat(90)}`
    await render(band({ subject: { ...SUBJECT, title } }))

    const subject = one('[data-testid="band-subject"]')
    expect(flat(subject.textContent)).toContain(title)
    expect(subject.className).toContain("[overflow-wrap:anywhere]")
    expect(subject.className).not.toMatch(/\btruncate\b|text-ellipsis|line-clamp/)
  })
})

// ---------------------------------------------------------------------------
// "Nothing needs you" is a claim
// ---------------------------------------------------------------------------

describe('"nothing needs you"', () => {
  test("is only made when the caller counted zero", async () => {
    await render(band({ needsYou: 0 }))
    expect(textOf('[data-testid="band-claim"]')).toBe("Nothing needs you")
  })

  test("becomes the count when something is waiting, elsewhere in the tree", async () => {
    await render(band({ needsYou: 1 }))
    expect(textOf('[data-testid="band-claim"]')).toBe("1 task needs you")

    await render(band({ needsYou: 3 }))
    expect(textOf('[data-testid="band-claim"]')).toBe("3 tasks need you")
  })

  test("is withheld entirely when nobody counted", async () => {
    await render(band({ needsYou: undefined }))
    expect(host.querySelector('[data-testid="band-claim"]')).toBeNull()
    expect(flat(one('[data-testid="return-band"]').textContent)).not.toContain("needs you")
  })

  /**
   * The guard that matters. `needsYou` counts the tree; the run in front of
   * you is its own fact, and a run parked on a human needs you whatever the
   * count says. Claiming calm over a parked run is the expensive direction —
   * the user walks away from a run that will never move — so a human wait
   * suppresses the claim even when the caller passes 0.
   */
  test("is never made over a run that is itself parked on a human", async () => {
    for (const reason of ["gate", "question", "blocked"] as const) {
      await render(band({ subject: { ...SUBJECT, state: { kind: "waiting", reason } }, needsYou: 0 }))
      const text = flat(one('[data-testid="return-band"]').textContent)
      expect(text).not.toContain("Nothing needs you")
      expect(host.querySelector('[data-testid="band-claim"]')).toBeNull()
    }
  })

  test("and the digest's heading makes the same claim on the same terms", async () => {
    await render(digest({ needsYou: 0 }))
    expect(textOf('[data-testid="digest-heading"]')).toBe("Still going. Nothing needs you.")

    await render(digest({ needsYou: 2 }))
    expect(textOf('[data-testid="digest-heading"]')).toBe("Still going.")

    await render(digest({ needsYou: undefined }))
    expect(textOf('[data-testid="digest-heading"]')).toBe("Still going.")

    await render(digest({ subject: { ...SUBJECT, state: { kind: "waiting", reason: "gate" } }, needsYou: 0 }))
    expect(textOf('[data-testid="digest-heading"]')).not.toContain("Nothing needs you")
  })
})

// ---------------------------------------------------------------------------
// The nine readings
// ---------------------------------------------------------------------------

describe("every run state reads as itself", () => {
  test("one of them is still going and eight are not", async () => {
    const stillGoing: string[] = []
    for (const state of STATES) {
      await render(digest({ subject: { ...SUBJECT, state } }))
      const heading = textOf('[data-testid="digest-heading"]')
      expect(heading).not.toBe("")
      if (heading.includes("Still going")) stillGoing.push(heading)
    }
    expect(stillGoing).toHaveLength(1)
  })

  test("each state has its own words in the band and the heading", async () => {
    const readings = STATES.map((state) => stateReading(state))
    const labels = readings.map((reading) => reading.label)
    expect(new Set(labels).size).toBe(STATES.length)
    expect(new Set(readings.map((reading) => reading.heading)).size).toBe(STATES.length)
    expect(labels).toEqual([
      "Running",
      "Waiting at the gate",
      "Asked you a question",
      "Blocked",
      "Stalled",
      "Done",
      "Done · unmerged",
      "Failed",
      "Interrupted",
    ])
  })

  test("stalled is plum, and the grinding amber is nowhere near it", async () => {
    const stalled = stateReading({ kind: "waiting", reason: "stalled" })
    expect(stalled.core).toBe("#A23B87")

    await render(digest({ subject: { ...SUBJECT, state: { kind: "waiting", reason: "stalled" } } }))
    const el = one('[data-testid="digest-state"]')
    expect(el.className + el.getAttribute("style")).not.toMatch(/FEF3C7|FFFBEB|F7D98B/i)
  })

  test("a failure prints the reason the fold recorded, verbatim", async () => {
    const why = "the agent answered ORCH: blocked no writable branch"
    await render(digest({ subject: { ...SUBJECT, state: { kind: "failed", why } } }))
    expect(flat(one('[data-testid="digest"]').textContent)).toContain(why)
  })

  test("an interrupted run says where it resumes from", async () => {
    await render(digest({ subject: { ...SUBJECT, state: { kind: "interrupted", resumeFrom: "implement" } } }))
    expect(flat(one('[data-testid="digest"]').textContent)).toContain("implement")
  })

  test("a done-but-unmerged run is not dressed up as merged", async () => {
    await render(digest({ subject: { ...SUBJECT, state: { kind: "done", merged: false } } }))
    const text = flat(one('[data-testid="digest"]').textContent)
    expect(text).toContain("unmerged")
  })
})

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

describe("exit codes", () => {
  function testsEntry(over: Partial<Omit<Extract<DigestEntry, { kind: "tests" }>, "kind">>): DigestEntry {
    return { id: id(3), kind: "tests", attempt: 1, ...over }
  }

  test("every number is printed exactly as it was read", async () => {
    /* 0 and 1 are the ordinary pair; 127 is the shell's "command not found",
     * 124 is `src/testrun.ts`'s timeout, 137 is 128 + SIGKILL, and -1 is a
     * number no writer produces but a caller could still hand over. */
    for (const code of [0, 1, 2, 124, 127, 137, 255, -1]) {
      await render(digest({ entries: [testsEntry({ exitCode: code })] }))
      expect(textOf('[data-testid="exit-chip"]')).toBe(`exit ${code}`)
      expect(one('[data-testid="exit-chip"]').dataset["exit"]).toBe(code === 0 ? "pass" : "fail")
    }
  })

  test("an attempt whose code nobody read says so, and is never dressed as a pass", async () => {
    await render(digest({ entries: [testsEntry({ exitCode: undefined, summary: "9 passing, 1 failing" })] }))

    const chip = one('[data-testid="exit-chip"]')
    expect(chip.dataset["exit"]).toBe("unknown")
    expect(flat(chip.textContent)).toBe("no exit code recorded")
    expect(flat(chip.textContent)).not.toContain("exit 0")
    /* No tick, and none of the pass colour: the shield says who read it, and
     * nobody did. */
    expect(chip.querySelector('[data-glyph="shield-check"]')).toBeNull()
    expect(chip.className).not.toMatch(/E3F5EC|0F8A5F|0F7A54|bg-pass/)
  })

  test("a code that is not a finite number is treated as no code at all", async () => {
    for (const code of [Number.NaN, Number.POSITIVE_INFINITY]) {
      await render(digest({ entries: [testsEntry({ exitCode: code })] }))
      expect(one('[data-testid="exit-chip"]').dataset["exit"]).toBe("unknown")
      expect(flat(one('[data-testid="exit-chip"]').textContent)).not.toMatch(/NaN|Infinity/)
    }
  })

  test("the summary is the runner's own words, printed beside the code and never instead of it", async () => {
    await render(digest({ entries: [testsEntry({ exitCode: 0, summary: "10 passing" })] }))
    const row = entryOfKind("tests")
    expect(flat(row.textContent)).toContain("10 passing")
    expect(flat(row.textContent)).toContain("exit 0")
  })

  test("nothing anywhere paraphrases a code", async () => {
    await render(digest())
    const text = flat(one('[data-testid="digest"]').textContent)
    expect(text).not.toMatch(/looks good|all good|everything passed|seems to work|success!/i)
    /* And the footnote names the command whose code it is. */
    expect(textOf('[data-testid="digest-footnote"]')).toContain("npm test")
    expect(textOf('[data-testid="digest-footnote"]')).toContain("What the agent says about its own work is never used")
  })

  test("with no test command the footnote still refuses the agent's word for it", async () => {
    await render(digest({ testCommand: undefined }))
    const note = textOf('[data-testid="digest-footnote"]')
    expect(note).toContain("exit code")
    expect(note).toContain("What the agent says about its own work is never used")
    expect(note).not.toContain("undefined")
  })

  test("exitReading is the one place the three cases are decided", () => {
    expect(exitReading(0)).toEqual({ outcome: "pass", text: "exit 0" })
    expect(exitReading(1)).toEqual({ outcome: "fail", text: "exit 1" })
    expect(exitReading(137)).toEqual({ outcome: "fail", text: "exit 137" })
    expect(exitReading(undefined)).toEqual({ outcome: "unknown", text: "no exit code recorded" })
    expect(exitReading(Number.NaN)).toEqual({ outcome: "unknown", text: "no exit code recorded" })
  })
})

// ---------------------------------------------------------------------------
// The timeline
// ---------------------------------------------------------------------------

describe("the timeline", () => {
  test("is a list, in the order it was given, one item per entry", async () => {
    await render(digest())
    const list = one('[data-testid="digest-timeline"]')
    expect(list.tagName).toBe("OL")
    const items = entries()
    expect(items).toHaveLength(TIMELINE.length)
    expect(items.map((item) => item.dataset["kind"])).toEqual([
      "approved",
      "implemented",
      "tests",
      "tests",
      "tests",
      "escalation",
      "tests",
      "tests",
      "running",
    ])
  })

  test("prints the clock for an entry that has one and leaves it blank for one that does not", async () => {
    await render(digest({ entries: [{ id: id(1), kind: "approved", at: APPROVED_AT }] }))
    expect(flat(entryOfKind("approved").textContent)).toContain("17:58")

    await render(digest({ entries: [{ id: id(1), kind: "approved" }] }))
    const text = flat(entryOfKind("approved").textContent)
    expect(text).not.toMatch(/\d\d:\d\d/)
    expect(text).toContain("You approved the plan")
  })

  test("an implemented entry counts files and lines, and omits what it was not told", async () => {
    await render(digest({ entries: [{ id: id(2), kind: "implemented", files: 2, added: 21, removed: 2 }] }))
    const row = flat(entryOfKind("implemented").textContent)
    expect(row).toContain("2 files")
    expect(row).toContain("+21")
    expect(row).toContain("−2")

    await render(digest({ entries: [{ id: id(2), kind: "implemented" }] }))
    const bare = flat(entryOfKind("implemented").textContent)
    expect(bare).toContain("Implemented the plan")
    expect(bare).not.toMatch(/\+|−|files/)
  })

  test("one file is one file", async () => {
    await render(digest({ entries: [{ id: id(2), kind: "implemented", files: 1 }] }))
    expect(flat(entryOfKind("implemented").textContent)).toContain("1 file")
  })

  test("the escalation prints the effort verbatim and never re-decides it", async () => {
    await render(digest({ entries: [{ id: id(6), kind: "escalation", effort: "high", identicalFailures: 3 }] }))
    const row = flat(entryOfKind("escalation").textContent)
    expect(row).toContain("effort: high")
    expect(row).toContain("3")

    /* An effort this build has never heard of is still printed. */
    await render(digest({ entries: [{ id: id(6), kind: "escalation", effort: "max" }] }))
    expect(flat(entryOfKind("escalation").textContent)).toContain("effort: max")
  })

  test("the running entry prints the command, the attempt and the shell's own clock", async () => {
    await render(digest({ entries: [{ id: id(9), kind: "running", attempt: 6, command: "npm test", elapsed: "0:42" }] }))
    const row = flat(entryOfKind("running").textContent)
    expect(row).toContain("npm test")
    expect(row).toContain("Attempt 6")
    expect(row).toContain("0:42")
    expect(one('[data-digest-entry][data-kind="running"] [data-glyph="running"]')).toBeDefined()
  })

  test("an ended entry says how it ended and carries its warnings", async () => {
    await render(
      digest({
        entries: [
          {
            id: id(10),
            kind: "ended",
            state: "done",
            warnings: ["the feature file changed while the run was going"],
          },
        ],
      }),
    )
    const row = flat(entryOfKind("ended").textContent)
    expect(row).toContain("the feature file changed while the run was going")

    await render(digest({ entries: [{ id: id(10), kind: "ended", state: "failed", why: "budget exhausted" }] }))
    expect(flat(entryOfKind("ended").textContent)).toContain("budget exhausted")
  })

  test("an empty timeline says nothing happened rather than drawing an empty list", async () => {
    await render(digest({ entries: [] }))
    expect(entries()).toHaveLength(0)
    expect(flat(one('[data-testid="digest"]').textContent)).toContain("Nothing is recorded")
  })

  /**
   * The failure comparison is a judgment over two signatures, and
   * `src/stall.ts` is the only thing that computes one. Both have to be
   * present before the digest may say they match: a missing signature is not
   * evidence of sameness, and "same failure" is the claim that invites a human
   * to stop reading.
   */
  test("says 'same failure' only when two consecutive signatures are both present and equal", async () => {
    const pair = (first: string | undefined, second: string | undefined): readonly DigestEntry[] => [
      { id: id(3), kind: "tests", attempt: 1, exitCode: 1, signature: first },
      { id: id(4), kind: "tests", attempt: 2, exitCode: 1, signature: second },
    ]

    await render(digest({ entries: pair("a", "a") }))
    expect(flat(entries()[1]?.textContent ?? "")).toContain("same failure")

    await render(digest({ entries: pair("a", "b") }))
    expect(flat(entries()[1]?.textContent ?? "")).toContain("a different failure")

    for (const [first, second] of [
      ["a", undefined],
      [undefined, "a"],
      [undefined, undefined],
    ] as const) {
      await render(digest({ entries: pair(first, second) }))
      const text = flat(entries()[1]?.textContent ?? "")
      expect(text).not.toContain("same failure")
      expect(text).not.toContain("a different failure")
    }
  })

  test("the grinding flag is a chip the caller sets, not a threshold this file re-decides", async () => {
    await render(digest({ entries: [{ id: id(8), kind: "tests", attempt: 9, exitCode: 1 }] }))
    expect(host.querySelector('[data-testid="grinding-chip"]')).toBeNull()

    await render(digest({ entries: [{ id: id(8), kind: "tests", attempt: 9, exitCode: 1, grinding: true }] }))
    expect(flat(textOf('[data-testid="grinding-chip"]'))).toContain("grinding")
  })
})

// ---------------------------------------------------------------------------
// While you were away
// ---------------------------------------------------------------------------

describe("the away strip", () => {
  test("counts from the approval when there is one, and prints both clocks", async () => {
    await render(digest())
    const strip = textOf('[data-testid="digest-away"]')
    expect(strip).toContain("33 min")
    expect(strip).toContain("approved 17:58")
    expect(strip).toContain("now 18:31")
  })

  test("falls back to the run's own start when nothing was approved", async () => {
    await render(digest({ entries: [{ id: id(3), kind: "tests", attempt: 1, exitCode: 1 }] }))
    const strip = textOf('[data-testid="digest-away"]')
    expect(strip).toContain("33 min")
    expect(strip).not.toContain("approved")
  })

  test("says nothing about a duration it cannot know", async () => {
    await render(digest({ startedAtMs: undefined, nowMs: undefined, entries: [{ id: id(1), kind: "approved" }] }))
    const strip = flat(host.querySelector('[data-testid="digest-away"]')?.textContent ?? "")
    expect(strip).not.toMatch(/min|hr|NaN|Invalid/)
  })

  test("awayLabel is minutes, then hours and minutes, and never a negative", () => {
    expect(awayLabel(0)).toBe("just now")
    expect(awayLabel(59_000)).toBe("just now")
    expect(awayLabel(60_000)).toBe("1 min")
    expect(awayLabel(33 * MINUTE)).toBe("33 min")
    expect(awayLabel(90 * MINUTE)).toBe("1 hr 30 min")
    expect(awayLabel(120 * MINUTE)).toBe("2 hr")
    /* A clock that went backwards is the caller's problem, not a negative
     * duration printed at a human. */
    expect(awayLabel(-5)).toBeUndefined()
    expect(awayLabel(Number.NaN)).toBeUndefined()
  })

  test("clockLabel is 24-hour, zero-padded, and refuses a time it cannot read", () => {
    expect(clockLabel(APPROVED_AT)).toBe("17:58")
    expect(clockLabel(new Date(2026, 9, 11, 9, 5, 0).getTime())).toBe("09:05")
    expect(clockLabel(undefined)).toBeUndefined()
    expect(clockLabel(Number.NaN)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// The paragraph
// ---------------------------------------------------------------------------

describe("the paragraph under the heading", () => {
  test("counts what happened and says only that", async () => {
    await render(digest())
    const prose = textOf('[data-testid="digest-prose"]')
    expect(prose).toContain("Tests failed five times")
    expect(prose).toContain("high")
  })

  test("is built from counts, so it cannot claim a pass that no code backs", () => {
    const failures: readonly DigestEntry[] = [
      { id: id(1), kind: "tests", attempt: 1, exitCode: 1 },
      { id: id(2), kind: "tests", attempt: 2, exitCode: 1 },
    ]
    const prose = digestProse(failures, { kind: "running", phase: "test" })
    expect(prose).toContain("Tests failed twice")
    expect(prose).not.toMatch(/passed|looks good/i)
  })

  test("names the attempts whose code was never read, instead of counting them as either", () => {
    const mixed: readonly DigestEntry[] = [
      { id: id(1), kind: "tests", attempt: 1, exitCode: 0 },
      { id: id(2), kind: "tests", attempt: 2 },
    ]
    const prose = digestProse(mixed, { kind: "interrupted", resumeFrom: "test" })
    expect(prose).toContain("Tests passed once")
    expect(prose).toContain("no exit code")
  })

  test("says plainly when nothing was recorded", () => {
    expect(digestProse([], { kind: "running", phase: "implement" })).toContain("Nothing is recorded")
  })
})

// ---------------------------------------------------------------------------
// Reduced motion
// ---------------------------------------------------------------------------

describe("reduced motion", () => {
  test("the staggered list does not stagger: no entrance class, no delay", async () => {
    setReducedMotion(true)
    await render(digest())

    const items = entries()
    expect(items).toHaveLength(TIMELINE.length)
    for (const item of items) {
      expect(item.dataset["motion"]).toBe("static")
      expect(item.className).not.toContain("kantan-digest-fade")
      expect(item.style.animationDelay).toBe("")
      expect(item.style.animation).toBe("")
    }
  })

  test("and without the preference the same list really does stagger, in the artboard's steps", async () => {
    setReducedMotion(false)
    await render(digest())

    const items = entries()
    expect(items.every((item) => item.dataset["motion"] === "animated")).toBe(true)
    expect(items.every((item) => item.className.includes("kantan-digest-fade"))).toBe(true)
    /* `.d1` through `.d9`: 50ms apart, which is what the artboard draws. */
    expect(items.slice(0, 3).map((item) => item.style.animationDelay)).toEqual(["0s", "0.05s", "0.1s"])
  })

  test("the card and the band hold still too", async () => {
    setReducedMotion(true)
    await render(digest())
    expect(one('[data-testid="digest"]').dataset["motion"]).toBe("static")
    expect(one('[data-testid="digest"]').className).not.toContain("kantan-digest-fade")

    await render(band())
    expect(one('[data-testid="return-band"]').dataset["motion"]).toBe("static")
    expect(one('[data-testid="return-band"]').className).not.toContain("kantan-digest-band")
  })

  test("and the spinner stops spinning without losing its meaning", async () => {
    setReducedMotion(true)
    await render(band())
    const spinner = one('[data-glyph="running"]')
    expect(spinner.dataset["motion"]).toBe("static")
    expect(spinner.className).not.toContain("kantan-digest-spin")
    expect(flat(one('[data-testid="return-band"]').textContent)).toContain("Running")

    setReducedMotion(false)
    await render(band())
    const moving = one('[data-glyph="running"]')
    expect(moving.dataset["motion"]).toBe("animated")
    expect(moving.className).toContain("kantan-digest-spin")
  })

  /**
   * The keyframes travel with the component.
   *
   * `tokens.css` does not carry them and this file compiles no CSS, so a
   * component that only added the class would be relying on a stylesheet
   * nobody wrote — which is how `StateGlyph` can stop animating outside the
   * tree (docs/HANDOFF.md). Both roots ship their own.
   */
  test("each root carries the keyframes it uses", async () => {
    await render(digest())
    const cardCss = one('[data-testid="digest"] style').textContent ?? ""
    expect(cardCss).toContain("@keyframes kantan-digest-fade")
    expect(cardCss).toContain("@keyframes kantan-digest-spin")
    expect(cardCss).toContain("prefers-reduced-motion")

    await render(band())
    const bandCss = one('[data-testid="return-band"] style').textContent ?? ""
    expect(bandCss).toContain("@keyframes kantan-digest-band")
    expect(bandCss).toContain("prefers-reduced-motion")
  })
})

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/**
 * `GET /api/runs/:id/stream` replays the whole log from byte 0 on every
 * connect, with no marker between the replay and the live tail (HANDOFF). So
 * the same entries arrive again on every reconnect, and a list that staggered
 * on identity rather than on id would replay its whole entrance each time.
 */
describe("a reconnect does not replay the entrance", () => {
  test("the same ids, in a new array, do not animate again", async () => {
    await render(digest())
    /* The opening stagger: every entry is an arrival the first time. */
    expect(entries().every((item) => item.dataset["motion"] === "animated")).toBe(true)
    await settle()

    /* A fresh array, same ids: this is what a replay looks like. */
    await render(digest({ entries: [...TIMELINE] }))
    expect(entries().every((item) => item.dataset["motion"] === "static")).toBe(true)
    expect(entries().every((item) => !item.className.includes("kantan-digest-fade"))).toBe(true)
    expect(entries().every((item) => item.style.animationDelay === "")).toBe(true)
  })

  test("but an entry nobody has seen does", async () => {
    await render(digest())
    await settle()

    const arrival: DigestEntry = { id: id(10), kind: "tests", attempt: 7, exitCode: 0, summary: "11 passing" }
    await render(digest({ entries: [...TIMELINE, arrival] }))

    const items = entries()
    const last = items[items.length - 1]
    expect(last?.dataset["motion"]).toBe("animated")
    expect(items.slice(0, -1).every((item) => item.dataset["motion"] === "static")).toBe(true)
  })
})
