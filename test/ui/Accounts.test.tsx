/**
 * The accounts view, and the three claims it must not make.
 *
 * This screen has no artboard — the design never drew one, because the rail's
 * rings are per-run and there was nowhere to see an account nothing is running
 * on. So its correctness is entirely about **not over-claiming**, and that is
 * what these assert:
 *
 * 1. An **expired** reading draws no bar and says "was X%", because the figure
 *    describes a window that no longer exists.
 * 2. A window with **no figure** draws no bar either: a 0%-wide bar and
 *    "nothing reported" look identical, and one of them is a claim.
 * 3. The footnote that kantan only sees its own runs is always present, because
 *    every figure on the screen depends on it.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"

import type { AccountUsage } from "../../src/ui/live.ts"

let ownsDocument = false
try {
  GlobalRegistrator.register()
  ownsDocument = true
} catch {
  // Another UI suite in this process registered first; its document will do.
}
void ownsDocument

interface Api {
  act: typeof import("react").act
  createRoot: typeof import("react-dom/client").createRoot
  Accounts: typeof import("../../src/ui/Accounts.tsx").Accounts
}
let api: Api

beforeAll(async () => {
  const react = await import("react")
  const client = await import("react-dom/client")
  const mod = await import("../../src/ui/Accounts.tsx")
  api = { act: react.act, createRoot: client.createRoot, Accounts: mod.Accounts }
})

let host: HTMLElement
let root: ReturnType<typeof api.createRoot>

beforeEach(() => {
  host = document.createElement("div")
  document.body.append(host)
  root = api.createRoot(host)
})

afterEach(async () => {
  try {
    await api.act(async () => root.unmount())
  } finally {
    host.remove()
  }
})

async function render(accounts: AccountUsage[] | null, over: Partial<{ error: string | null; busy: boolean }> = {}) {
  await api.act(async () => {
    root.render(
      <api.Accounts
        accounts={accounts}
        error={over.error ?? null}
        busy={over.busy ?? false}
        onRefresh={() => {}}
        onClose={() => {}}
      />,
    )
  })
}

const prose = (): string => (host.textContent ?? "").replace(/\s+/g, " ").trim()
const row = (profile: string): Element | null => host.querySelector(`[data-account="${profile}"]`)

const HOUR = 3600
const SOON = Math.floor(Date.now() / 1000) + HOUR
const PAST = Math.floor(Date.now() / 1000) - HOUR

describe("the accounts view", () => {
  test("says it is reading before the first answer arrives", async () => {
    await render(null)
    expect(prose()).toContain("Reading the run logs")
  })

  test("a current reading draws a bar per window, shortest first", async () => {
    await render([
      {
        profile: "~/.claude-work",
        freshness: "current",
        status: "allowed",
        windows: [
          { name: "five_hour", utilization: 0.38, resetsAt: SOON },
          { name: "seven_day", utilization: 0.58, resetsAt: SOON + 48 * HOUR },
        ],
      },
    ])
    expect(prose()).toContain("5-hour window")
    expect(prose()).toContain("7-day window")
    expect(prose()).toContain("38%")
    expect(prose()).toContain("58%")
    expect(host.querySelectorAll("[data-bar]")).toHaveLength(2)
  })

  /** Claim 1: the figure is about a window that has ended. */
  test("an expired reading draws no bar, and says what the figure was", async () => {
    await render([
      {
        profile: null,
        freshness: "expired",
        windows: [{ name: "five_hour", utilization: 0.9, resetsAt: PAST }],
      },
    ])
    expect(host.querySelectorAll("[data-bar]")).toHaveLength(0)
    expect(prose()).toContain("was 90%")
    expect(prose()).toContain("about a window that has ended")
    expect(prose()).toContain("unknown until the next run reports it")
    expect(row("")?.querySelector("[data-freshness]")?.getAttribute("data-freshness")).toBe("expired")
  })

  /** Claim 2: a blank figure and a zero figure are different states. */
  test("a window with no figure draws no bar either", async () => {
    await render([
      { profile: null, freshness: "current", windows: [{ name: "five_hour", utilization: undefined, resetsAt: SOON }] },
    ])
    expect(host.querySelectorAll("[data-bar]")).toHaveLength(0)
    expect(prose()).toContain("no figure reported")
  })

  /** A non-zero figure must never render as an invisible bar. */
  test("a tiny figure still draws something", async () => {
    await render([
      { profile: null, freshness: "current", windows: [{ name: "five_hour", utilization: 0.004, resetsAt: SOON }] },
    ])
    const bar = host.querySelector<HTMLElement>("[data-bar]")
    expect(bar?.style.minWidth).toBe("3px")
  })

  test("a live account says so, and says the figure keeps updating", async () => {
    await render([
      { profile: null, freshness: "live", windows: [{ name: "five_hour", utilization: 0.2, resetsAt: SOON }] },
    ])
    expect(prose()).toContain("live")
    expect(prose()).toContain("updates as it reports")
  })

  test("an account nothing has run on says that, rather than showing zeroes", async () => {
    await render([{ profile: "~/.claude-new", freshness: "never" }])
    expect(host.querySelectorAll("[data-bar]")).toHaveLength(0)
    expect(prose()).toContain("No run has billed to this account yet")
    expect(prose()).not.toContain("0%")
  })

  test("the default profile is named, not left blank", async () => {
    await render([{ profile: null, freshness: "never" }])
    expect(prose()).toContain("default profile")
  })

  /** Claim 3: every figure above depends on it. */
  test("always says kantan only sees its own runs", async () => {
    for (const accounts of [
      null,
      [],
      [{ profile: null, freshness: "never" } as AccountUsage],
      [{ profile: null, freshness: "current", windows: [{ name: "five_hour", utilization: 0.5, resetsAt: SOON }] } as AccountUsage],
    ]) {
      await render(accounts)
      expect(prose()).toContain("kantan only sees what its own runs report")
    }
  })

  /** A dropped poll must not look like "no accounts". */
  test("a failed refetch keeps the last figures beside the message", async () => {
    await render(
      [{ profile: null, freshness: "current", windows: [{ name: "five_hour", utilization: 0.42, resetsAt: SOON }] }],
      { error: "the accounts could not be read: 503" },
    )
    expect(prose()).toContain("503")
    expect(prose()).toContain("the last ones that arrived")
    expect(prose()).toContain("42%")
  })

  test("a status other than allowed is shown; `allowed` is not noise on every row", async () => {
    await render([
      { profile: null, freshness: "current", status: "rejected", windows: [{ name: "five_hour", utilization: 1, resetsAt: SOON }] },
    ])
    expect(prose()).toContain("rejected")

    await render([
      { profile: null, freshness: "current", status: "allowed", windows: [{ name: "five_hour", utilization: 0.1, resetsAt: SOON }] },
    ])
    expect(prose()).not.toContain("allowed")
  })

  /** A window name this build has never heard of is printed, not dropped. */
  test("an unknown window name is shown as sent", async () => {
    await render([
      { profile: null, freshness: "current", windows: [{ name: "thirty_day", utilization: 0.1, resetsAt: SOON }] },
    ])
    expect(prose()).toContain("thirty day")
  })

  test("with no accounts at all it says what to do", async () => {
    await render([])
    expect(prose()).toContain("No accounts yet")
  })
})
