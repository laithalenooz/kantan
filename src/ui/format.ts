/**
 * How kantan prints a number a human reads: money, a percentage, a duration,
 * a reset time, a ring's geometry.
 *
 * Out of `src/ui/Sidebar.tsx` because **seven modules were importing a
 * 1392-line component module to format a dollar amount.** `AddTasks`, `Row`,
 * `App`, `ProjectPanel`, `live.ts` and two panel modules each reached into it
 * for one or two of these, which put the whole rail - its hooks, its
 * sub-components, its motion - into their module graphs for the sake of a
 * `toFixed`.
 *
 * Every rule here is about not over-claiming, which is why they are shared
 * rather than re-derived per surface:
 *
 * - `percentLabel` does **not** clamp while `ringOffset` does, deliberately: an
 *   account over its window reads "104%" while the arc stops at full. The
 *   figure is the fact; the geometry is a drawing of it.
 * - A figure this reader cannot use prints `DASH`, never `0`. "Nothing
 *   reported" and "zero" are different states, and one of them is a claim.
 */

// ---------------------------------------------------------------------------
// Formatting. Durations and reset times render in mono, figures in tabular
// Geist — see "Typography: the artboard, not the summary" above.
// ---------------------------------------------------------------------------

/**
 * What every absent machine value prints: an em dash, as all three artboards
 * draw it. Never `0`, never `0:00`, never a blank cell — an empty slot where a
 * number belongs reads as "nothing happened" rather than "nobody said".
 */
export const DASH = "—"

export function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

export function formatUsd(usd: number): string {
  return `$${(Number.isFinite(usd) ? usd : 0).toFixed(2)}`
}

/**
 * `resetsAt` as a wall clock, from **epoch seconds**.
 *
 * Returns `undefined` for anything that cannot be a reset time — absent, zero,
 * negative, non-finite — because `18:40` and `01:00 on 1 Jan 1970` are equally
 * confident and only one of them is true.
 */
export function formatResetTime(resetsAtSec: number | undefined): string | undefined {
  if (resetsAtSec === undefined || !Number.isFinite(resetsAtSec) || resetsAtSec <= 0) return undefined
  return new Date(resetsAtSec * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
}

/** A 0–1 fraction as a percentage. `undefined` is `—`, never `0%`. */
export function percentLabel(utilization: number | undefined): string {
  if (utilization === undefined || !Number.isFinite(utilization)) return DASH
  return `${Math.round(utilization * 100)}%`
}

/** The artboard's own circumference, for r=25: 2π·25 = 157.0796. */
export const RING_CIRCUMFERENCE = 157.08

/**
 * How much of the ring to leave undrawn. Geometry only, so it clamps; the label
 * does not, because an account over its window should read "104%", not "100%".
 */
export function ringOffset(utilization: number | undefined): number {
  if (utilization === undefined || !Number.isFinite(utilization)) return RING_CIRCUMFERENCE
  return RING_CIRCUMFERENCE * (1 - clamp01(utilization))
}

/**
 * A finished duration, as the design prints it: `8s`, `2m 14s`, `19m`, `1h 4m`.
 * Seconds stop being interesting at ten minutes.
 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return DASH
  const total = Math.floor(ms / 1000)
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (total < 600) return `${minutes}m ${total % 60}s`
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** The running phase's clock: `0:42`, `12:07`, `1:02:33`. */
export function formatClock(ms: number | undefined): string {
  const total = ms === undefined || !Number.isFinite(ms) || ms < 0 ? 0 : Math.floor(ms / 1000)
  const seconds = String(total % 60).padStart(2, "0")
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
  return `${minutes}:${seconds}`
}
