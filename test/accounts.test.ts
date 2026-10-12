import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { accountUsage } from "../src/accounts"

/** Scratch keyed on the pid, per CLAUDE.md. */
async function runsDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), `orch-accounts-${process.pid}-`))
}

const HOUR = 3600
const NOW_MS = 1_800_000_000_000
const NOW_S = NOW_MS / 1000

/** A log holding a header and one `rate_limit_event`, as the CLI sends it. */
async function log(
  dir: string,
  name: string,
  opts: {
    profile?: string | null
    runId?: string
    startedAt?: string
    fiveHour?: { utilization?: number; resetsAt?: number }
    sevenDay?: { utilization?: number; resetsAt?: number }
    status?: string
    events?: number
  },
): Promise<void> {
  const header = {
    kind: "header",
    runId: opts.runId ?? name.replace(".jsonl", ""),
    startedAt: opts.startedAt ?? "2026-10-12T10:00:00.000Z",
    ...(opts.profile === undefined ? {} : { profile: opts.profile }),
    projectPath: "/repo",
    featureFile: "docs/features/x.md",
    taskRef: "T1",
  }
  const windows: Record<string, unknown> = {}
  if (opts.fiveHour) windows["five_hour"] = opts.fiveHour
  if (opts.sevenDay) windows["seven_day"] = opts.sevenDay
  const lines = [JSON.stringify(header)]
  for (let i = 0; i < (opts.events ?? 1); i++) {
    lines.push(
      JSON.stringify({
        kind: "cli",
        event: {
          type: "rate_limit_event",
          rate_limit_info: {
            status: opts.status ?? "allowed",
            rateLimitType: "five_hour",
            // Each successive event reports a touch more usage, so "the last
            // one wins" is observable rather than asserted.
            unifiedWindows: {
              /* The figure only advances when there *is* one: defaulting an
                 absent utilization to 0 would inject the exact value the
                 "never as zero" case exists to rule out. */
              ...(opts.fiveHour
                ? {
                    five_hour:
                      opts.fiveHour.utilization === undefined
                        ? { ...opts.fiveHour }
                        : { ...opts.fiveHour, utilization: opts.fiveHour.utilization + i * 0.1 },
                  }
                : {}),
              ...(opts.sevenDay ? { seven_day: opts.sevenDay } : {}),
            },
          },
        },
      }),
    )
  }
  await writeFile(join(dir, name), lines.join("\n") + "\n")
}

describe("accountUsage", () => {
  test("an account that has never run says so, rather than being absent", async () => {
    const dir = await runsDir()
    const got = await accountUsage({ runsDir: dir, profiles: ["~/.claude-work"], now: NOW_MS })
    expect(got).toEqual([{ profile: "~/.claude-work", freshness: "never" }])
  })

  test("a runs directory that does not exist is the first-ever state, not an error", async () => {
    const got = await accountUsage({ runsDir: "/definitely/not/here", profiles: [null], now: NOW_MS })
    expect(got).toEqual([{ profile: null, freshness: "never" }])
  })

  /**
   * Both windows, shortest first. `src/stream.ts` narrows to the one
   * `rateLimitType` names, which is right for a rail that draws one ring and
   * wrong here: 38% on the five-hour and 58% on the seven-day is one account in
   * two states, and the second number is the one that decides a week.
   */
  test("reports every window the CLI sent, shortest reset first", async () => {
    const dir = await runsDir()
    await log(dir, "a.jsonl", {
      profile: null,
      fiveHour: { utilization: 0.38, resetsAt: NOW_S + HOUR },
      sevenDay: { utilization: 0.58, resetsAt: NOW_S + 48 * HOUR },
    })
    const [usage] = await accountUsage({ runsDir: dir, profiles: [null], now: NOW_MS })
    expect(usage?.windows?.map((w) => w.name)).toEqual(["five_hour", "seven_day"])
    expect(usage?.windows?.[0]?.utilization).toBeCloseTo(0.38, 6)
    expect(usage?.windows?.[1]?.utilization).toBeCloseTo(0.58, 6)
    expect(usage?.status).toBe("allowed")
  })

  test("the last event in a log wins, because a run emits several", async () => {
    const dir = await runsDir()
    await log(dir, "a.jsonl", { profile: null, fiveHour: { utilization: 0.1, resetsAt: NOW_S + HOUR }, events: 4 })
    const [usage] = await accountUsage({ runsDir: dir, profiles: [null], now: NOW_MS })
    // 0.1 + 3 * 0.1, the fourth event.
    expect(usage?.windows?.[0]?.utilization).toBeCloseTo(0.4, 6)
  })

  /**
   * The rule the module exists for. Once `resetsAt` passes, the figure is not
   * stale - it is about a window that no longer exists, and the new one holds
   * whatever has been spent since, which kantan cannot know. `expired` is a
   * different answer from `0%`.
   */
  test("a reading whose window has reset is expired, never a percentage", async () => {
    const dir = await runsDir()
    await log(dir, "a.jsonl", { profile: null, fiveHour: { utilization: 0.9, resetsAt: NOW_S - 60 } })
    const [usage] = await accountUsage({ runsDir: dir, profiles: [null], now: NOW_MS })
    expect(usage?.freshness).toBe("expired")
    // The figure is still carried, for a surface that wants to say what it was.
    expect(usage?.windows?.[0]?.utilization).toBeCloseTo(0.9, 6)
  })

  /** Decided by the **shortest** window: reporting the pair as current because
   *  half of it is would be the over-claim this avoids. */
  test("expiry follows the shortest window, not the longest", async () => {
    const dir = await runsDir()
    await log(dir, "a.jsonl", {
      profile: null,
      fiveHour: { utilization: 0.9, resetsAt: NOW_S - 60 },
      sevenDay: { utilization: 0.2, resetsAt: NOW_S + 48 * HOUR },
    })
    const [usage] = await accountUsage({ runsDir: dir, profiles: [null], now: NOW_MS })
    expect(usage?.freshness).toBe("expired")
  })

  test("a window that has not reset is current", async () => {
    const dir = await runsDir()
    await log(dir, "a.jsonl", { profile: null, fiveHour: { utilization: 0.4, resetsAt: NOW_S + HOUR } })
    const [usage] = await accountUsage({ runsDir: dir, profiles: [null], now: NOW_MS })
    expect(usage?.freshness).toBe("current")
  })

  /** A run driving right now makes the figure current to within one event. */
  test("a profile a run is driving on reads live, even past its reset", async () => {
    const dir = await runsDir()
    await log(dir, "a.jsonl", { profile: "~/.claude-work", fiveHour: { utilization: 0.4, resetsAt: NOW_S - 60 } })
    const [usage] = await accountUsage({
      runsDir: dir,
      profiles: ["~/.claude-work"],
      liveProfiles: ["~/.claude-work"],
      now: NOW_MS,
    })
    expect(usage?.freshness).toBe("live")
  })

  test("the newest log wins per profile, and each profile is separate", async () => {
    const dir = await runsDir()
    await log(dir, "old.jsonl", { profile: "~/.claude-work", fiveHour: { utilization: 0.2, resetsAt: NOW_S + HOUR } })
    await new Promise((r) => setTimeout(r, 12))
    await log(dir, "new.jsonl", { profile: "~/.claude-work", fiveHour: { utilization: 0.7, resetsAt: NOW_S + HOUR } })
    await new Promise((r) => setTimeout(r, 12))
    await log(dir, "other.jsonl", { profile: null, fiveHour: { utilization: 0.05, resetsAt: NOW_S + HOUR } })

    const got = await accountUsage({ runsDir: dir, profiles: ["~/.claude-work", null], now: NOW_MS })
    const work = got.find((a) => a.profile === "~/.claude-work")
    const dflt = got.find((a) => a.profile === null)
    expect(work?.windows?.[0]?.utilization).toBeCloseTo(0.7, 6)
    expect(dflt?.windows?.[0]?.utilization).toBeCloseTo(0.05, 6)
  })

  /** `profile: null` and an absent `profile` are the same account: the default
   *  one. A header written before the field existed must not become a row. */
  test("an absent profile is the default profile, not a third account", async () => {
    const dir = await runsDir()
    await log(dir, "a.jsonl", { fiveHour: { utilization: 0.3, resetsAt: NOW_S + HOUR } })
    const got = await accountUsage({ runsDir: dir, profiles: [null], now: NOW_MS })
    expect(got).toHaveLength(1)
    expect(got[0]?.profile).toBeNull()
  })

  /**
   * A project can be re-pointed at a different folder, and the usage already
   * spent on the old one does not stop existing because nothing is registered
   * on it now.
   */
  test("a profile the logs know but the store does not still gets a row", async () => {
    const dir = await runsDir()
    await log(dir, "a.jsonl", { profile: "~/.claude-retired", fiveHour: { utilization: 0.5, resetsAt: NOW_S + HOUR } })
    const got = await accountUsage({ runsDir: dir, profiles: [null], now: NOW_MS })
    expect(got.map((a) => a.profile).sort()).toEqual([null, "~/.claude-retired"])
  })

  test("names the run a reading came from, and that run's start as a lower bound", async () => {
    const dir = await runsDir()
    await log(dir, "a.jsonl", {
      profile: null,
      runId: "11111111-1111-4111-8111-111111111111",
      startedAt: "2026-10-12T09:30:00.000Z",
      fiveHour: { utilization: 0.4, resetsAt: NOW_S + HOUR },
    })
    const [usage] = await accountUsage({ runsDir: dir, profiles: [null], now: NOW_MS })
    expect(usage?.runId).toBe("11111111-1111-4111-8111-111111111111")
    expect(usage?.seenDuringRunStartedAt).toBe("2026-10-12T09:30:00.000Z")
  })

  test("a window with no figure in it is carried as undefined, never as zero", async () => {
    const dir = await runsDir()
    await log(dir, "a.jsonl", { profile: null, fiveHour: { resetsAt: NOW_S + HOUR } })
    const [usage] = await accountUsage({ runsDir: dir, profiles: [null], now: NOW_MS })
    expect(usage?.windows?.[0]?.utilization).toBeUndefined()
  })

  test("a damaged log is skipped rather than failing the whole answer", async () => {
    const dir = await runsDir()
    await writeFile(join(dir, "broken.jsonl"), "{not json\n")
    await new Promise((r) => setTimeout(r, 12))
    await log(dir, "good.jsonl", { profile: null, fiveHour: { utilization: 0.4, resetsAt: NOW_S + HOUR } })
    const got = await accountUsage({ runsDir: dir, profiles: [null], now: NOW_MS })
    expect(got[0]?.windows?.[0]?.utilization).toBeCloseTo(0.4, 6)
  })

  test("a log with no rate-limit event contributes nothing", async () => {
    const dir = await runsDir()
    await writeFile(
      join(dir, "quiet.jsonl"),
      JSON.stringify({ kind: "header", runId: "r", startedAt: "2026-10-12T10:00:00.000Z", projectPath: "/r", featureFile: "f.md", taskRef: "T1" }) + "\n",
    )
    const got = await accountUsage({ runsDir: dir, profiles: [null], now: NOW_MS })
    expect(got).toEqual([{ profile: null, freshness: "never" }])
  })
})
