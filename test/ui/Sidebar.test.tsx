/**
 * The right rail.
 *
 * Four of these tests exist because the thing they check has already gone wrong
 * in this project, and one because the library lies:
 *
 * - **Two accounts, two windows.** A single global meter reads the wrong window
 *   for every project that is not on the default profile.
 * - **`overageStatus` is not the limit signal.** Every normal event carries
 *   `overageStatus: "rejected"`, so the raw JSON line below carries it too, is
 *   pushed through the real `StreamParser`, and must still produce no notice.
 * - **Cost resets per process.** The fixture is two processes **sharing one
 *   session id**, so grouping by session id — the obvious wrong rule, since
 *   `--resume` reuses it — fails here rather than silently halving the bill.
 * - **Utilization is a 0–1 fraction**, asserted through the artboard's own
 *   percentages *and* its own `stroke-dashoffset` figures.
 * - **Motion's reduced-motion handling does not cover a counting number**, and
 *   its `useReducedMotion()` caches the query globally on first call. So the
 *   media feature is set for real, and the ticker is checked mid-flight: a test
 *   that only looked at the final figure would pass with the gate removed.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

import type { Event } from "../../src/stream.ts"

/* Registered at module load, before React is imported, and only if nobody else
 * got there first: the other UI suites need the same DOM, and registering twice
 * would hand them a different window than the one their roots are mounted in.
 * Unregistered again at the end, because the registrator replaces `fetch`,
 * `Request` and `Response` globally and `test/server.test.ts` talks to a real
 * server over them. */
const registeredHere = !GlobalRegistrator.isRegistered
if (registeredHere) GlobalRegistrator.register()

const React = await import("react")
const { act } = React
const { createRoot } = await import("react-dom/client")
const { StreamParser } = await import("../../src/stream.ts")
const {
  Sidebar,
  accountKey,
  dedupeWindows,
  formatClock,
  formatDuration,
  formatResetTime,
  formatUsd,
  limitNotice,
  percentLabel,
  phaseLadder,
  ringOffset,
  splitProcesses,
  sumProcessCost,
  NEAR_LIMIT,
  RING_CIRCUMFERENCE,
} = await import("../../src/ui/Sidebar.tsx")
type AccountWindow = import("../../src/ui/Sidebar.tsx").AccountWindow
type PhaseStep = import("../../src/ui/Sidebar.tsx").PhaseStep

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

/** Lets queued frames and timers run, so an animation can finish. */
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

function textOf(selector: string): string {
  return (one(selector).textContent ?? "").replace(/\s+/g, " ").trim()
}

function buttonSaying(label: string): HTMLButtonElement {
  const match = all("button").find((button) => (button.textContent ?? "").includes(label))
  if (match === undefined) throw new Error(`no button says "${label}" in:\n${host.innerHTML}`)
  return match as HTMLButtonElement
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click()
  })
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

function parse(lines: readonly string[]): Event[] {
  const parser = new StreamParser()
  const events: Event[] = []
  for (const line of lines) events.push(...parser.push(`${line}\n`))
  events.push(...parser.end())
  return events
}

/**
 * One session id for both processes. A plan phase and the re-plan that gate
 * feedback resumes share a conversation, so the session id cannot be the
 * process boundary; `--resume` is a second process on the same session.
 */
const SESSION = "d531c4e8-f26e-7991-1c38-8a0450ba73a0"

function initLine(): string {
  return JSON.stringify({
    type: "system",
    subtype: "init",
    cwd: "/repo",
    tools: ["Read", "Edit"],
    skills: [],
    session_id: SESSION,
  })
}

function resultLine(costUsd: number, turns: number): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    total_cost_usd: costUsd,
    num_turns: turns,
    result: "ORCH: done",
    permission_denials: [],
    result_index: turns - 1,
    queued_turn_count: 0,
  })
}

/**
 * Two processes, each reporting a **cumulative** figure per turn.
 *
 * Process one ends at 0.42, process two at 2.76, so the run spent **$3.18** —
 * which is the figure the Return artboard prints. Adding up all six results
 * gives **$5.56**, the double-counted number this fixture exists to catch.
 */
const TWO_PROCESS_LINES = [
  initLine(),
  resultLine(0.12, 1),
  resultLine(0.31, 2),
  resultLine(0.42, 3),
  initLine(),
  resultLine(0.55, 1),
  resultLine(1.4, 2),
  resultLine(2.76, 3),
]

const TWO_PROCESS = parse(TWO_PROCESS_LINES)
/** Just the first process, for a before-and-after on the ticker. */
const ONE_PROCESS = parse(TWO_PROCESS_LINES.slice(0, 4))

const CORRECT_TOTAL = 3.18
const NAIVE_TOTAL = 5.56

function naiveSum(events: readonly Event[]): number {
  return events.reduce((total, event) => (event.kind === "result" ? total + event.costUsd : total), 0)
}

/** A real `rate_limit_event`, shaped like the captured fixtures. */
function rateLimitLine(opts: {
  status: string
  utilization: number
  overageStatus?: string
}): string {
  return JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: {
      status: opts.status,
      resetsAt: 1800000000,
      rateLimitType: "five_hour",
      overageStatus: opts.overageStatus ?? "rejected",
      overageDisabledReason: "org_level_disabled",
      isUsingOverage: false,
      unifiedWindows: {
        five_hour: { utilization: opts.utilization, resetsAt: 1800000000 },
        seven_day: { utilization: 0.22, resetsAt: 1800400000 },
      },
    },
    uuid: "aaa6af84-ce78-fa7d-7d96-c6e3646300eb",
    session_id: SESSION,
  })
}

function rateLimitEvent(opts: { status: string; utilization: number; overageStatus?: string }) {
  const [event] = parse([rateLimitLine(opts)])
  if (event === undefined || event.kind !== "rate_limit") {
    throw new Error(`the parser did not read that line as a rate limit: ${JSON.stringify(event)}`)
  }
  return event
}

const PERSONAL = "/home/u/.claude-personal"

function windowFor(
  profile: string | null,
  label: string,
  event: { status: string; utilization: number | undefined },
  extra: Partial<AccountWindow> = {},
): AccountWindow {
  return {
    profile,
    label,
    status: event.status,
    utilization: event.utilization,
    resetsAtSec: 1800000000,
    ...extra,
  }
}

const ALLOWED_41 = rateLimitEvent({ status: "allowed", utilization: 0.41 })
const ALLOWED_12 = rateLimitEvent({ status: "allowed", utilization: 0.12 })

const TWO_ACCOUNTS: AccountWindow[] = [
  windowFor(PERSONAL, "personal", ALLOWED_41, { current: true }),
  windowFor(null, "work", ALLOWED_12, { resetsAtSec: 1800005100 }),
]

/* Built per call, never hoisted into a constant: a step with `startedAtMs` is
 * measured against the clock at render, so a fixture minted at module load
 * reads a second older by the time a later test renders it. */
function gatePhases(): PhaseStep[] {
  return [
    { phase: "plan", state: "done", elapsedMs: 8_000 },
    { phase: "gate", state: "waiting", startedAtMs: Date.now() - 134_000, note: "waiting" },
  ]
}

function runningPhases(): PhaseStep[] {
  return [
    { phase: "plan", state: "done", elapsedMs: 8_000 },
    { phase: "gate", state: "done", elapsedMs: 134_000, note: "approved" },
    { phase: "implement", state: "done", elapsedMs: 400_000 },
    { phase: "test", state: "running", startedAtMs: Date.now() - 42_000, note: "attempt 6" },
    { phase: "refine", state: "flagged", elapsedMs: 1_140_000, note: "5 rounds" },
  ]
}

function rail(overrides: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  return (
    <Sidebar
      phases={runningPhases()}
      events={TWO_PROCESS}
      ceilingUsd={50}
      windows={TWO_ACCOUNTS}
      {...overrides}
    />
  )
}

/** The machine figure a phase row prints, on its own. */
function phaseFigure(phase: string): string {
  return textOf(`li[data-phase="${phase}"] [data-figure]`)
}

// ---------------------------------------------------------------------------
// Two accounts means two windows
// ---------------------------------------------------------------------------

describe("the 5-hour window, per account", () => {
  test("two accounts render two rings, keyed on the profile that pays", async () => {
    await render(rail())

    const windows = all('[data-testid="window"]')
    expect(windows).toHaveLength(2)
    expect(windows.map((element) => element.dataset["account"])).toEqual([
      `profile:${PERSONAL}`,
      "profile:default",
    ])
    expect(textOf('[data-testid="window"]:nth-of-type(1)')).toContain("personal")
    expect(all('[data-testid="window-percent"]').map((element) => element.textContent)).toEqual(["41%", "12%"])
  })

  test("the account this run spends against is the one wearing the pill", async () => {
    await render(rail())

    const [first, second] = all('[data-testid="window"]')
    expect(first?.textContent).toContain("this run")
    expect(second?.textContent).not.toContain("this run")
  })

  test("the default profile is an account, not an absence", () => {
    expect(accountKey(null)).toBe("profile:default")
    expect(accountKey(PERSONAL)).toBe(`profile:${PERSONAL}`)
    /* No trimming, no resolving: merging two accounts shows a run the wrong
     * window, while splitting one shows two rings and is harmless. */
    expect(accountKey("/home/u/.claude-personal/")).not.toBe(accountKey(PERSONAL))
    expect(accountKey(" /home/u/.claude-personal")).not.toBe(accountKey(PERSONAL))
  })

  test("an event for one account leaves the other account's ring alone", async () => {
    await render(rail())
    expect(all('[data-testid="window-percent"]').map((element) => element.textContent)).toEqual(["41%", "12%"])

    const movedWork = [
      TWO_ACCOUNTS[0] as AccountWindow,
      windowFor(null, "work", rateLimitEvent({ status: "allowed", utilization: 0.58 }), {
        resetsAtSec: 1800005100,
      }),
    ]
    await render(rail({ windows: movedWork }))

    expect(all('[data-testid="window-percent"]').map((element) => element.textContent)).toEqual(["41%", "58%"])
    expect(all('[data-testid="window-ring"]')[0]?.getAttribute("stroke-dashoffset")).toBe("92.68")
  })

  test("one account reported twice collapses, newest wins, and 'this run' sticks", () => {
    const collapsed = dedupeWindows([
      windowFor(PERSONAL, "personal", ALLOWED_41, { current: true }),
      windowFor(PERSONAL, "personal", rateLimitEvent({ status: "allowed", utilization: 0.58 })),
    ])

    expect(collapsed).toHaveLength(1)
    expect(collapsed[0]?.utilization).toBe(0.58)
    expect(collapsed[0]?.current).toBe(true)
  })

  test("no window reported yet says so rather than drawing an empty ring", async () => {
    await render(rail({ windows: [] }))

    expect(all('[data-testid="window"]')).toHaveLength(0)
    expect(host.textContent).toContain("No window reported yet")
  })

  test("a reset time is read as epoch seconds and shown in mono", async () => {
    await render(rail())

    const expected = new Date(1800000000 * 1000).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
    expect(formatResetTime(1800000000)).toBe(expected)
    expect(expected).toMatch(/^\d{2}:\d{2}$/)
    /* Reading the same number as milliseconds would put the reset in 1970. */
    expect(formatResetTime(1800000000)).not.toBe(
      new Date(1800000000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
    )
    expect(textOf('[data-testid="window"]:nth-of-type(1)')).toContain(`resets ${expected}`)
    expect(one('[data-testid="window"]:nth-of-type(1) .font-mono')).toBeDefined()
  })

  test("a reset time nobody reported is a dash, not 1970", async () => {
    expect(formatResetTime(undefined)).toBeUndefined()
    expect(formatResetTime(0)).toBeUndefined()
    expect(formatResetTime(-1)).toBeUndefined()
    expect(formatResetTime(Number.NaN)).toBeUndefined()

    await render(rail({ windows: [windowFor(PERSONAL, "personal", ALLOWED_41, { resetsAtSec: undefined })] }))
    expect(textOf('[data-testid="window"]')).toContain("resets —")
  })
})

// ---------------------------------------------------------------------------
// Utilization is a fraction
// ---------------------------------------------------------------------------

describe("utilization is a 0-1 fraction", () => {
  test("the parser's fraction becomes the artboard's percentage", () => {
    expect(ALLOWED_41.utilization).toBe(0.41)
    expect(percentLabel(0.41)).toBe("41%")
    expect(percentLabel(0.12)).toBe("12%")
    expect(percentLabel(0.58)).toBe("58%")
    expect(percentLabel(1)).toBe("100%")
    /* Read as a percentage, 41 would render as "4100%". */
    expect(percentLabel(41)).toBe("4100%")
  })

  test("and the artboard's own stroke-dashoffsets", async () => {
    expect(RING_CIRCUMFERENCE).toBe(157.08)
    expect(ringOffset(0.41).toFixed(2)).toBe("92.68")
    expect(ringOffset(0.12).toFixed(2)).toBe("138.23")
    expect(ringOffset(0.58).toFixed(2)).toBe("65.97")

    await render(rail())
    expect(all('[data-testid="window-ring"]').map((ring) => ring.getAttribute("stroke-dashoffset"))).toEqual([
      "92.68",
      "138.23",
    ])
    expect(all('[data-testid="window-ring"]')[0]?.getAttribute("stroke-dasharray")).toBe("157.08")
  })

  test("a window nobody has reported on is empty and labelled a dash, never 0%", async () => {
    expect(percentLabel(undefined)).toBe("—")
    expect(ringOffset(undefined)).toBe(RING_CIRCUMFERENCE)

    await render(
      rail({
        windows: [windowFor(PERSONAL, "personal", { status: "allowed", utilization: undefined })],
      }),
    )
    expect(textOf('[data-testid="window-percent"]')).toBe("—")
    expect(one('[data-testid="window-ring"]').getAttribute("stroke-dashoffset")).toBe("157.08")
  })

  test("an account past its window keeps an honest label and a full ring", () => {
    expect(percentLabel(1.04)).toBe("104%")
    expect(ringOffset(1.04)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The limit notice: status, never overageStatus
// ---------------------------------------------------------------------------

describe("the limit notice", () => {
  test("an allowed event carrying overageStatus 'rejected' shows nothing", async () => {
    const event = rateLimitEvent({ status: "allowed", utilization: 0.41, overageStatus: "rejected" })

    /* The field cannot even reach the rail: the parser drops it. If that ever
     * changes, this is the line that says so. */
    expect(Object.keys(event).sort()).toEqual(["kind", "status", "utilization"])
    expect(event.status).toBe("allowed")
    expect(limitNotice([windowFor(PERSONAL, "personal", event)])).toBeNull()

    await render(rail({ windows: [windowFor(PERSONAL, "personal", event, { current: true })] }))
    expect(host.querySelector('[data-testid="limit-notice"]')).toBeNull()
  })

  test("every normal run would raise one if it keyed on overageStatus", async () => {
    /* The whole two-account fixture carries overageStatus "rejected" with
     * org_level_disabled, because that is what a normal event looks like. */
    await render(rail())
    expect(host.querySelector('[data-testid="limit-notice"]')).toBeNull()
  })

  test("a genuinely constrained status does raise one", async () => {
    const rejected = rateLimitEvent({ status: "rejected", utilization: 0.97 })
    await render(rail({ windows: [windowFor(PERSONAL, "personal", rejected, { current: true })] }))

    const notice = one('[data-testid="limit-notice"]')
    expect(notice.getAttribute("role")).toBe("status")
    expect(notice.dataset["tone"]).toBe("constrained")
    expect(notice.textContent).toContain("personal")
    expect(notice.textContent).toContain("rejected")
    expect(notice.textContent).toContain("97%")
  })

  test("the status it keys on, enumerated", () => {
    const fires = (status: string) =>
      limitNotice([windowFor(PERSONAL, "personal", { status, utilization: 0.1 })]) !== null

    expect(fires("allowed")).toBe(false)
    expect(fires("allowed_warning")).toBe(true)
    expect(fires("rejected")).toBe(true)
    expect(fires("something_a_later_cli_invented")).toBe(true)
    /* `src/stream.ts` yields "" for an absent or non-string status, and a
     * window whose status cannot be read is not one that can be called
     * allowed. */
    expect(fires("")).toBe(true)
  })

  test("utilization is the second, quieter trigger — and it is read as a fraction", async () => {
    const near = limitNotice([windowFor(PERSONAL, "personal", { status: "allowed", utilization: 0.95 })])
    expect(near?.tone).toBe("near")
    expect(NEAR_LIMIT).toBe(0.9)
    /* 0.95 read as "0.95%" would stay silent. */
    expect(0.95).toBeGreaterThan(NEAR_LIMIT)

    await render(
      rail({
        windows: [windowFor(PERSONAL, "personal", { status: "allowed", utilization: 0.95 }, { current: true })],
      }),
    )
    const notice = one('[data-testid="limit-notice"]')
    expect(notice.dataset["tone"]).toBe("near")
    expect(notice.textContent).toContain("95%")
    expect(notice.textContent).toContain("near the end")
  })

  test("not being told is not being fine", () => {
    expect(limitNotice([windowFor(PERSONAL, "personal", { status: "allowed", utilization: undefined })])).toBeNull()
    expect(limitNotice([])).toBeNull()
  })

  test("a constrained account outranks one that is merely close", () => {
    const notice = limitNotice([
      windowFor(PERSONAL, "personal", { status: "allowed", utilization: 0.99 }),
      windowFor(null, "work", { status: "rejected", utilization: 0.1 }),
    ])
    expect(notice?.tone).toBe("constrained")
    expect(notice?.window.label).toBe("work")
  })
})

// ---------------------------------------------------------------------------
// Cost: the last result of each process
// ---------------------------------------------------------------------------

describe("cost", () => {
  test("the fixture really is two processes on one session id", () => {
    const inits = TWO_PROCESS.filter((event) => event.kind === "init")
    expect(inits).toHaveLength(2)
    expect(inits.map((event) => (event.kind === "init" ? event.sessionId : ""))).toEqual([SESSION, SESSION])
    expect(splitProcesses(TWO_PROCESS)).toHaveLength(2)
  })

  test("it sums the last result of each process, and naive summation differs", () => {
    const processes = splitProcesses(TWO_PROCESS)
    expect(processes.map((process) => process.results.at(-1)?.costUsd)).toEqual([0.42, 2.76])

    const correct = sumProcessCost(processes)
    const naive = naiveSum(TWO_PROCESS)

    expect(correct).toBeCloseTo(CORRECT_TOTAL, 10)
    expect(naive).toBeCloseTo(NAIVE_TOTAL, 10)
    expect(naive).not.toBeCloseTo(correct, 2)
    /* Double-counting can only ever overstate the bill. */
    expect(naive).toBeGreaterThan(correct)
    expect(formatUsd(correct)).toBe("$3.18")
    expect(formatUsd(naive)).toBe("$5.56")
  })

  test("the rail prints the correct total, not the double-counted one", async () => {
    setReducedMotion(true)
    await render(rail())

    expect(textOf('[data-testid="cost-figure"]')).toBe("$3.18")
    expect(textOf('[data-testid="cost-figure"]')).not.toBe("$5.56")
  })

  test("results before any init form one window rather than vanishing", () => {
    const orphans = parse([resultLine(0.2, 1), resultLine(0.5, 2)])
    expect(splitProcesses(orphans)).toHaveLength(1)
    expect(sumProcessCost(splitProcesses(orphans))).toBeCloseTo(0.5, 10)
  })

  test("a process that reported nothing contributes nothing", () => {
    const empty = parse([initLine(), initLine(), resultLine(0.7, 1)])
    expect(splitProcesses(empty)).toHaveLength(2)
    expect(sumProcessCost(splitProcesses(empty))).toBeCloseTo(0.7, 10)
    expect(sumProcessCost([])).toBe(0)
  })

  test("the ceiling and the bar read the spend against the budget", async () => {
    setReducedMotion(true)
    await render(rail({ events: ONE_PROCESS }))

    expect(textOf('[data-testid="cost-figure"]')).toBe("$0.42")
    expect(host.textContent).toContain("of $50.00 ceiling for this run")
    /* 0.42 of 50 is the artboard's own 0.84%. */
    expect(one('[data-testid="cost-bar"]').style.width).toBe("0.84%")
  })

  test("the bar never overflows its track", async () => {
    setReducedMotion(true)
    await render(rail({ events: TWO_PROCESS, ceilingUsd: 1 }))
    expect(one('[data-testid="cost-bar"]').style.width).toBe("100.00%")

    await render(rail({ events: TWO_PROCESS, ceilingUsd: 0 }))
    expect(one('[data-testid="cost-bar"]').style.width).toBe("0.00%")
  })

  test("the chip says whether the figure is still moving", async () => {
    setReducedMotion(true)
    await render(rail())
    expect(host.textContent).toContain("live")

    await render(rail({ phases: gatePhases() }))
    expect(host.textContent).toContain("paused at gate")
    expect(host.textContent).not.toContain("live")
  })
})

// ---------------------------------------------------------------------------
// Reduced motion
// ---------------------------------------------------------------------------

describe("reduced motion", () => {
  test("stops the ticker: the figure is assigned, not counted", async () => {
    setReducedMotion(true)
    await render(rail({ events: ONE_PROCESS }))
    expect(textOf('[data-testid="cost-figure"]')).toBe("$0.42")
    expect(one('[data-testid="cost-figure"]').dataset["ticker"]).toBe("static")

    await render(rail({ events: TWO_PROCESS }))
    /* Immediately, with no frames run at all. */
    expect(textOf('[data-testid="cost-figure"]')).toBe("$3.18")
    await settle(200)
    expect(textOf('[data-testid="cost-figure"]')).toBe("$3.18")
  })

  test("and without it the ticker really does count", async () => {
    setReducedMotion(false)
    await render(rail({ events: ONE_PROCESS }))
    expect(textOf('[data-testid="cost-figure"]')).toBe("$0.42")
    expect(one('[data-testid="cost-figure"]').dataset["ticker"]).toBe("animated")

    await render(rail({ events: TWO_PROCESS }))
    /* Mid-flight: somewhere between the two figures, not at the target. */
    const midFlight = textOf('[data-testid="cost-figure"]')
    expect(midFlight).not.toBe("$3.18")
    const value = Number(midFlight.replace("$", ""))
    expect(value).toBeGreaterThanOrEqual(0.42)
    expect(value).toBeLessThan(CORRECT_TOTAL)

    await settle()
    expect(textOf('[data-testid="cost-figure"]')).toBe("$3.18")
  })

  test("holds the ring and the cost bar still, which no transform gate would", async () => {
    setReducedMotion(true)
    await render(rail())

    expect(one('[data-testid="window-ring"]').style.transition).toBe("none")
    expect(one('[data-testid="cost-bar"]').style.transition).toBe("none")
    /* The figures are still the truth. */
    expect(one('[data-testid="window-ring"]').getAttribute("stroke-dashoffset")).toBe("92.68")
  })

  test("and the two glyphs that move stop moving", async () => {
    setReducedMotion(true)
    await render(rail({ phases: [...gatePhases(), { phase: "test", state: "running" }] }))
    expect(one('[data-glyph="waiting"]').dataset["motion"]).toBe("static")
    expect(one('[data-glyph="running"]').dataset["motion"]).toBe("static")

    setReducedMotion(false)
    await render(rail({ phases: [...gatePhases(), { phase: "test", state: "running" }] }))
    expect(one('[data-glyph="waiting"]').dataset["motion"]).toBe("animated")
    expect(one('[data-glyph="running"]').dataset["motion"]).toBe("animated")
  })
})

// ---------------------------------------------------------------------------
// Grinding
// ---------------------------------------------------------------------------

describe("the grinding notice", () => {
  const FLAG = { runId: "run-1", attempts: 6, failureHref: "#fail" }

  test("appears with its cost, and blocks nothing", async () => {
    setReducedMotion(true)
    const stops: number[] = []
    await render(rail({ grinding: FLAG, onStop: () => stops.push(1) }))

    const notice = one('[data-testid="grinding-notice"]')
    expect(notice.getAttribute("role")).toBe("status")
    expect(notice.textContent).toContain("6")
    expect(notice.textContent).toContain("$3.18")
    expect(notice.textContent).toContain("nothing is blocked")

    /* Not a modal, and not an alert: nothing is trapped, nothing interrupts. */
    expect(host.querySelector("[aria-modal]")).toBeNull()
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(host.querySelector('[role="alertdialog"]')).toBeNull()
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(notice.contains(document.activeElement)).toBe(false)

    /* It never pulses, and it never takes the primary button. */
    expect(notice.className).not.toMatch(/pulse|animate/)
    expect(notice.querySelector('[data-glyph="waiting"]')).toBeNull()

    /* Stop is still there, still enabled, and still works while it shows. */
    const stop = buttonSaying("Stop run")
    expect(stop.disabled).toBe(false)
    await click(stop)
    expect(stops).toHaveLength(1)
  })

  test("'Let it run' dismisses it and leaves the rest of the rail standing", async () => {
    setReducedMotion(true)
    await render(rail({ grinding: FLAG }))
    expect(host.querySelector('[data-testid="grinding-notice"]')).not.toBeNull()

    await click(buttonSaying("Let it run"))

    expect(host.querySelector('[data-testid="grinding-notice"]')).toBeNull()
    expect(buttonSaying("Stop run")).toBeDefined()
    expect(textOf('[data-testid="cost-figure"]')).toBe("$3.18")
    expect(all('[data-testid="window"]')).toHaveLength(2)
  })

  test("a later attempt in the same run does not nag again", async () => {
    setReducedMotion(true)
    await render(rail({ grinding: FLAG }))
    await click(buttonSaying("Let it run"))

    await render(rail({ grinding: { ...FLAG, attempts: 9 } }))
    expect(host.querySelector('[data-testid="grinding-notice"]')).toBeNull()
  })

  test("but the next run gets its own notice", async () => {
    setReducedMotion(true)
    await render(rail({ grinding: FLAG }))
    await click(buttonSaying("Let it run"))

    await render(rail({ grinding: { runId: "run-2", attempts: 6 } }))
    expect(host.querySelector('[data-testid="grinding-notice"]')).not.toBeNull()
  })

  test("no flag, no notice", async () => {
    await render(rail({ grinding: null }))
    expect(host.querySelector('[data-testid="grinding-notice"]')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

describe("phases", () => {
  test("the ladder is always the five, in order", async () => {
    await render(rail({ phases: [{ phase: "test", state: "running" }] }))

    expect(all("li[data-phase]").map((row) => row.dataset["phase"])).toEqual([
      "plan",
      "gate",
      "implement",
      "test",
      "refine",
    ])
    expect(all("li[data-phase]").map((row) => row.dataset["state"])).toEqual([
      "pending",
      "pending",
      "pending",
      "running",
      "pending",
    ])
  })

  test("a phase sent twice keeps the last word", () => {
    const ladder = phaseLadder([
      { phase: "refine", state: "running" },
      { phase: "refine", state: "flagged", note: "5 rounds" },
    ])
    expect(ladder).toHaveLength(5)
    expect(ladder.find((step) => step.phase === "refine")?.state).toBe("flagged")
  })

  test("only the one that needs you pulses, and only the running one spins", async () => {
    await render(rail())

    expect(all('[data-glyph="waiting"]')).toHaveLength(0)
    expect(all('[data-glyph="running"]')).toHaveLength(1)
    expect(all('[data-glyph="done"]')).toHaveLength(3)
    expect(all('[data-glyph="flagged"]')).toHaveLength(1)

    await render(rail({ phases: gatePhases() }))
    expect(all('[data-glyph="waiting"]')).toHaveLength(1)
    expect(all('[data-glyph="running"]')).toHaveLength(0)
    expect(all('[data-glyph="pending"]')).toHaveLength(3)
  })

  test("the current phase is the obvious one", async () => {
    await render(rail())
    const current = one('li[data-state="running"]')
    expect(current.textContent).toContain("Test")
    expect(current.textContent).toContain("attempt 6")
    expect(current.className).toContain("shadow-[inset_0_0_0_1px_#D6D7FA]")

    await render(rail({ phases: gatePhases() }))
    const gate = one('li[data-state="waiting"]')
    expect(gate.textContent).toContain("waiting")
    expect(gate.className).toContain("bg-attention-tint")
  })

  test("a finished phase prints a duration; the current one prints a clock", async () => {
    await render(rail())

    expect(phaseFigure("plan")).toBe("8s")
    expect(phaseFigure("gate")).toBe("2m 14s")
    expect(phaseFigure("implement")).toBe("6m 40s")
    expect(phaseFigure("refine")).toBe("19m")
    /* The current phase counts, so it reads as a clock rather than a duration. */
    expect(phaseFigure("test")).toBe("0:42")
    expect(one('li[data-phase="gate"]').textContent).toContain("approved")
    expect(one('li[data-phase="refine"]').textContent).toContain("5 rounds")
  })

  test("a phase that has not run has nothing to say about how long it took", async () => {
    await render(rail({ phases: [{ phase: "plan", state: "done", elapsedMs: 8_000 }] }))
    expect(phaseFigure("implement")).toBe("—")
  })

  test("durations and clocks, at the boundaries", () => {
    expect(formatDuration(0)).toBe("0s")
    expect(formatDuration(8_000)).toBe("8s")
    expect(formatDuration(59_999)).toBe("59s")
    expect(formatDuration(60_000)).toBe("1m 0s")
    expect(formatDuration(134_000)).toBe("2m 14s")
    expect(formatDuration(599_999)).toBe("9m 59s")
    expect(formatDuration(600_000)).toBe("10m")
    expect(formatDuration(1_140_000)).toBe("19m")
    expect(formatDuration(3_600_000)).toBe("1h 0m")
    expect(formatDuration(3_840_000)).toBe("1h 4m")
    expect(formatDuration(undefined)).toBe("—")
    expect(formatDuration(-1)).toBe("—")

    expect(formatClock(0)).toBe("0:00")
    expect(formatClock(42_000)).toBe("0:42")
    expect(formatClock(727_000)).toBe("12:07")
    expect(formatClock(3_753_000)).toBe("1:02:33")
    expect(formatClock(undefined)).toBe("0:00")
  })
})

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

describe("stop", () => {
  test("says what pressing it costs, permanently and to a screen reader", async () => {
    await render(rail())

    const stop = buttonSaying("Stop run")
    const describedBy = stop.getAttribute("aria-describedby")
    expect(describedBy).not.toBeNull()
    const note = one(`#${describedBy}`)
    expect(note.textContent).toBe("Resumable. Stopping costs nothing.")
  })

  test("calls back once per press, and can be withheld", async () => {
    const presses: number[] = []
    await render(rail({ onStop: () => presses.push(1) }))
    await click(buttonSaying("Stop run"))
    expect(presses).toHaveLength(1)

    await render(rail({ onStop: () => presses.push(1), stopDisabled: true }))
    expect(buttonSaying("Stop run").disabled).toBe(true)
    await click(buttonSaying("Stop run"))
    expect(presses).toHaveLength(1)
  })

  test("it is the rail's only button, so nothing competes with it", async () => {
    await render(rail())
    expect(all("button")).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Machine values are mono
// ---------------------------------------------------------------------------

describe("machine values", () => {
  test("the cost, the ceiling, the durations, the percentages and the reset times are mono", async () => {
    setReducedMotion(true)
    await render(rail())

    const mono = all(".font-mono").map((element) => (element.textContent ?? "").trim())
    expect(one('[data-testid="cost-figure"]').className).toContain("font-mono")
    expect(one('[data-testid="window-percent"]').className).toContain("font-mono")
    expect(mono).toContain("$3.18")
    expect(mono).toContain("$50.00")
    expect(mono).toContain("41%")
    expect(mono).toContain(phaseFigure("test"))
    expect(phaseFigure("test")).toMatch(/^\d+:\d{2}$/)
    expect(mono).toContain("8s")
  })

  test("a figure is a figure even when it is zero", () => {
    expect(formatUsd(0)).toBe("$0.00")
    expect(formatUsd(Number.NaN)).toBe("$0.00")
    expect(formatUsd(3.1799999999999997)).toBe("$3.18")
  })
})
