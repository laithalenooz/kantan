/**
 * What kantan knows about each Claude account's rate-limit windows.
 *
 * **There is no way to ask.** `claude --help` lists eighteen subcommands and
 * none of them reports usage, so the only source is the `rate_limit_event` the
 * CLI emits *during a run*. Everything here follows from that one fact.
 *
 * Three honesty rules, and they are the whole design:
 *
 * 1. **kantan only sees usage its own runs reported.** A Claude Code session in
 *    a terminal spends from the same window and is invisible here. So a figure
 *    is never "your usage" - it is "what kantan last saw", and every surface
 *    has to say so or it is lying by omission.
 * 2. **A reading expires.** `resetsAt` names the end of the window the figure
 *    describes. Once that moment passes the number is not stale, it is *about a
 *    window that no longer exists* - and the new one holds whatever has been
 *    spent since, which kantan cannot know. `expired` is therefore a different
 *    answer from `0%`, and the cheap direction is to say "unknown".
 * 3. **Both windows are reported.** `src/stream.ts` narrows to the window
 *    `rateLimitType` names, which is right for the rail - it draws one ring -
 *    and wrong here: a reading of 38% on the five-hour window and 58% on the
 *    seven-day one is one account in two different states, and someone deciding
 *    whether to start an expensive run needs the second number.
 */

import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"

import { replay } from "./runlog"

/** How many logs are scanned, newest first. */
const MAX_LOGS = 40

/** One rate-limit window, as the CLI reports it. */
export interface Window {
  /** `five_hour`, `seven_day`, or whatever a newer CLI names. Passed through. */
  name: string
  /** 0–1. `undefined` when the CLI sent a window with no figure in it. */
  utilization: number | undefined
  /** Epoch **seconds**, the unit the CLI sends. */
  resetsAt: number | undefined
}

/**
 * How much a reading can still be trusted.
 *
 * - `live` — a run is driving on this profile right now, so the figure is
 *   current to within one event.
 * - `current` — no run is driving, but the window the figure describes has not
 *   reset, so the figure is still true of that window.
 * - `expired` — the window has reset since. The figure described a window that
 *   is gone, and what has been spent in the new one is unknown.
 * - `never` — no run on this profile has ever reported one.
 */
export type Freshness = "live" | "current" | "expired" | "never"

export interface AccountUsage {
  /** `CLAUDE_CONFIG_DIR`, or `null` for the default profile. The identity. */
  profile: string | null
  freshness: Freshness
  /** `allowed`, `allowed_warning`, `rejected`… Passed through, never judged. */
  status?: string
  windows?: Window[]
  /** The run the reading came from, so a human can go and look at it. */
  runId?: string
  /** When that run started, ISO, as its header recorded it. The reading was
   *  taken at some point after this - the log does not timestamp `cli`
   *  records, so this is a lower bound and is labelled as one. */
  seenDuringRunStartedAt?: string
}

/** The shape `rate_limit_event` carries. Read loosely: it is another process's
 *  JSON, and a newer CLI may add windows this version has never heard of. */
interface RawLimit {
  status?: unknown
  rateLimitType?: unknown
  unifiedWindows?: unknown
}

function windowsOf(info: RawLimit): Window[] {
  const unified = info.unifiedWindows
  if (unified === null || typeof unified !== "object") return []
  const out: Window[] = []
  for (const [name, value] of Object.entries(unified as Record<string, unknown>)) {
    if (value === null || typeof value !== "object") continue
    const w = value as { utilization?: unknown; resetsAt?: unknown }
    out.push({
      name,
      utilization: typeof w.utilization === "number" && Number.isFinite(w.utilization) ? w.utilization : undefined,
      resetsAt: typeof w.resetsAt === "number" && Number.isFinite(w.resetsAt) ? w.resetsAt : undefined,
    })
  }
  /* Shortest window first, which is the order someone reads them in: the
     five-hour one is what blocks the next run, the seven-day one is what
     blocks the week. Windows with no reset sort last - they say nothing about
     when anything frees up. */
  return out.sort((a, b) => (a.resetsAt ?? Infinity) - (b.resetsAt ?? Infinity))
}

/** The newest reading in one log, with the profile its header names. */
async function readingIn(
  path: string,
): Promise<{ profile: string | null; status?: string; windows: Window[]; runId?: string; startedAt?: string } | null> {
  let profile: string | null = null
  let runId: string | undefined
  let startedAt: string | undefined
  let status: string | undefined
  let windows: Window[] = []
  let seen = false

  for await (const record of replay(path)) {
    if (record.kind === "header") {
      const h = record as { profile?: unknown; runId?: unknown; startedAt?: unknown }
      profile = typeof h.profile === "string" && h.profile !== "" ? h.profile : null
      runId = typeof h.runId === "string" ? h.runId : undefined
      startedAt = typeof h.startedAt === "string" ? h.startedAt : undefined
      continue
    }
    if (record.kind !== "cli") continue
    const event = (record as { event?: unknown }).event
    if (event === null || typeof event !== "object") continue
    const e = event as { type?: unknown; rate_limit_info?: unknown }
    if (e.type !== "rate_limit_event") continue
    const info = e.rate_limit_info
    if (info === null || typeof info !== "object") continue
    // The **last** one wins: a run emits several and the newest is the state.
    const raw = info as RawLimit
    status = typeof raw.status === "string" ? raw.status : undefined
    windows = windowsOf(raw)
    seen = true
  }
  if (!seen) return null
  return {
    profile,
    windows,
    ...(status === undefined ? {} : { status }),
    ...(runId === undefined ? {} : { runId }),
    ...(startedAt === undefined ? {} : { startedAt }),
  }
}

/**
 * The newest reading per profile, across the newest `MAX_LOGS` run logs.
 *
 * Newest-first by mtime and it stops as soon as every profile it has seen has
 * a reading, because the newest log that mentions a profile holds that
 * profile's newest reading. `profiles` is what the caller already knows exists
 * - the distinct `configDir`s in the project store - so an account that has
 * never run still gets a row saying `never` rather than being absent, which is
 * the difference between "nothing to report" and "no such account".
 */
export async function accountUsage(options: {
  runsDir: string
  /** Every profile the store knows about. `null` is the default profile. */
  profiles: ReadonlyArray<string | null>
  /** Profiles a run is driving right now, so a reading can be called `live`. */
  liveProfiles?: ReadonlyArray<string | null>
  /** Epoch **milliseconds**. Injected so a test can decide what has expired. */
  now?: number
}): Promise<AccountUsage[]> {
  const nowMs = options.now ?? Date.now()
  const live = new Set(options.liveProfiles ?? [])

  let names: string[] = []
  try {
    const entries = await readdir(options.runsDir, { withFileTypes: true })
    const logs = entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl")).map((e) => e.name)
    const timed = await Promise.all(
      logs.map(async (name) => {
        try {
          return { name, at: (await stat(join(options.runsDir, name))).mtimeMs }
        } catch {
          return { name, at: 0 }
        }
      }),
    )
    names = timed.sort((a, b) => b.at - a.at).slice(0, MAX_LOGS).map((t) => t.name)
  } catch {
    // No runs directory yet is the first-ever state, not an error.
    names = []
  }

  const found = new Map<string | null, Awaited<ReturnType<typeof readingIn>>>()
  for (const name of names) {
    let reading
    try {
      reading = await readingIn(join(options.runsDir, name))
    } catch {
      // A damaged log is skipped rather than failing the whole answer: the
      // other accounts' readings are still worth having.
      continue
    }
    if (reading === null) continue
    // First writer wins, and the walk is newest-first, so this keeps the newest.
    if (!found.has(reading.profile)) found.set(reading.profile, reading)
  }

  /* Every profile the store knows, plus any the logs mention that it does not -
     a project can be re-pointed at a different folder, and the usage it already
     spent does not stop existing because nothing is registered on it now. */
  const keys: Array<string | null> = [...new Set<string | null>([...options.profiles, ...found.keys()])]

  return keys.map((profile) => {
    const reading = found.get(profile)
    if (reading === undefined || reading === null) return { profile, freshness: "never" as const }
    /* Expiry is decided by the **shortest** window: if the five-hour one has
       reset then the figure beside it is about a window that is gone, whatever
       the seven-day one still says. Reporting the pair as current because one
       half of it is would be the over-claim this module exists to avoid. */
    const soonest = reading.windows.map((w) => w.resetsAt).filter((r): r is number => r !== undefined).sort((a, b) => a - b)[0]
    const expired = soonest !== undefined && soonest * 1000 <= nowMs
    const freshness: Freshness = live.has(profile) ? "live" : expired ? "expired" : "current"
    return {
      profile,
      freshness,
      ...(reading.status === undefined ? {} : { status: reading.status }),
      windows: reading.windows,
      ...(reading.runId === undefined ? {} : { runId: reading.runId }),
      ...(reading.startedAt === undefined ? {} : { seenDuringRunStartedAt: reading.startedAt }),
    }
  })
}
