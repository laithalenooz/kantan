/**
 * What every section of the project panel draws with.
 *
 * `src/ui/ProjectPanel.tsx` was 3546 lines - the largest file in the
 * repository - holding eight independent sections plus the primitives they
 * share. Measured before splitting: no section calls another. Each one reaches
 * back only to the leaves in this module, which is what made the split
 * mechanical rather than a rewrite.
 *
 * Inline `style` objects rather than utilities, and that is the artboard's own
 * decision carried over: these values are copied from `docs/design/*.dc.html`
 * verbatim, and a Tailwind step that rounds 13.5px to 14px is a drift nobody
 * would see in a diff. Where a hover is needed the class comes too, because an
 * inline `background` outranks a `:hover` rule.
 */

import { useId, useState, type CSSProperties, type ReactElement, type ReactNode } from "react"

import { RING_CIRCUMFERENCE, formatResetTime, percentLabel, ringOffset } from "../format.ts"
import type { Account } from "../Tree.tsx"
import type { AccountKind, AccountOption } from "../ProjectPanel.tsx"

/* -------------------------------------------------------------------------- */
/* Icons, as the artboard draws them                                          */
/* -------------------------------------------------------------------------- */

export const LINE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const

export function KindIcon({ kind, size }: { kind: Account["kind"]; size: number }): ReactElement {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="ic" style={{ width: size, height: size }} {...LINE}>
      {kind === "personal" ? (
        <>
          <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </>
      ) : kind === "work" ? (
        <>
          <path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
          <rect width="20" height="14" x="2" y="6" rx="2" />
        </>
      ) : (
        <>
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <path d="M12 17h.01" />
        </>
      )}
    </svg>
  )
}

export function Check({ size, width = 2.6 }: { size: number; width?: number }): ReactElement {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="ic"
      style={{ width: size, height: size, strokeWidth: width }}
      {...LINE}
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

export function Cross({ size }: { size: number }): ReactElement {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="ic" style={{ width: size, height: size }} {...LINE}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

export function Plus({ size }: { size: number }): ReactElement {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="ic" style={{ width: size, height: size }} {...LINE}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  )
}

export function FileIcon({ size, color }: { size: number; color: string }): ReactElement {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="ic"
      style={{ width: size, height: size, color }}
      {...LINE}
    >
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </svg>
  )
}

export function FolderIcon({ size }: { size: number }): ReactElement {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="ic" style={{ width: size, height: size }} {...LINE}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  )
}

/* -------------------------------------------------------------------------- */
/* Shared styles, verbatim from the artboard                                  */
/* -------------------------------------------------------------------------- */

export const SECTION: CSSProperties = {
  padding: "24px clamp(20px,4vw,40px)",
  borderBottom: "1px solid #EEEEF1",
}

export const H2: CSSProperties = { margin: 0, fontSize: 16, fontWeight: 650 }

export const BLURB: CSSProperties = {
  margin: "4px 0 12px",
  fontSize: 13.5,
  lineHeight: 1.5,
  color: "#4A4E59",
}

export const PILL_DARK =
  "cta inline-flex items-center justify-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo"

export const PILL_GHOST =
  "ghost inline-flex items-center justify-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo"

export const CONFIRM_DARK: CSSProperties = {
  height: 42,
  padding: "0 16px",
  borderRadius: 999,
  border: 0,
  background: "#111216",
  color: "#fff",
  fontSize: 13.5,
  fontWeight: 620,
}

export const CONFIRM_GHOST: CSSProperties = {
  height: 42,
  padding: "0 16px",
  borderRadius: 999,
  border: "1px solid #D9D9DF",
  background: "#fff",
  fontSize: 13.5,
  fontWeight: 560,
  color: "#1E2026",
}

/* -------------------------------------------------------------------------- */
/* AccountSwitch: the chip and its popover                                    */
/* -------------------------------------------------------------------------- */

export const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function focusablesIn(root: HTMLElement | null): HTMLElement[] {
  if (root === null) return []
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)]
}

/** The popover's two inputs. See the note on preflight in the file header. */
export const POP_INPUT: CSSProperties = {
  height: 42,
  boxSizing: "border-box",
  padding: "0 12px",
  borderRadius: 10,
  border: "1px solid transparent",
  background: "#EFEFF2",
  outline: "none",
  color: "#111216",
}

/* -------------------------------------------------------------------------- */

export const SELECTED_CARD: CSSProperties = {
  border: "1.5px solid #111216",
  background: "#fff",
  boxShadow: "0 8px 20px -14px rgba(17,18,22,.5)",
}

export const OFF_CARD: CSSProperties = { border: "1px solid #E2E2E7", background: "#FCFCFD" }

/** The repo's own directory name, which is what the design shows. */
export function repoName(path: string): string {
  const segments = path.split("/").filter((segment) => segment !== "")
  return segments.at(-1) ?? path
}

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function taskWord(n: number): string {
  return `${n} ${n === 1 ? "task" : "tasks"}`
}

/** `4100` -> `4.1s`. Absent prints nothing; this is not `formatDuration`'s job
 *  because a test run is seconds and the rail's rounding hides them. */
export function seconds(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined
  return `${(ms / 1000).toFixed(1)}s`
}

/** `41% · resets 18:40`, or just the half that is known. */
export function usageLine(option: AccountOption): string {
  const reset = formatResetTime(option.window?.resetsAtSec)
  const used = percentLabel(option.window?.utilization)
  return reset === undefined ? used : `${used} · resets ${reset}`
}

/** `~/.claude · resets 18:40`, the cards' subtitle. */
export function cardSubtitle(option: AccountOption): string {
  const reset = formatResetTime(option.window?.resetsAtSec)
  const parts = [option.configDir, reset === undefined ? undefined : `resets ${reset}`].filter(
    (p): p is string => p !== undefined && p !== "",
  )
  return parts.join(" · ")
}

/* -------------------------------------------------------------------------- */
/* The usage ring                                                             */
/* -------------------------------------------------------------------------- */

export const RING_LOOK: Record<AccountKind, { track: string; arc: string; ink: string }> = {
  personal: { track: "#E6F3FB", arc: "#0284C7", ink: "#075985" },
  work: { track: "#EEEEF1", arc: "#26272D", ink: "#26272D" },
}

/**
 * The Animated Circular Progress Bar, from Sidebar's geometry.
 *
 * `ringOffset` clamps and `percentLabel` does not, deliberately: an account
 * over its window reads "104%" while the arc stops at full. Both are imported
 * rather than re-derived so the rail and these rings cannot disagree.
 */
export function UsageRing({
  option,
  size,
  stroke,
  animate,
  showLabel,
}: {
  option: AccountOption
  size: number
  stroke: number
  animate: boolean
  showLabel: boolean
}): ReactElement {
  const look = RING_LOOK[option.kind]
  const utilization = option.window?.utilization
  return (
    <span style={{ position: "relative", width: size, height: size, flex: "none" }}>
      <svg
        viewBox="0 0 60 60"
        aria-hidden="true"
        style={{ width: size, height: size, transform: "rotate(-90deg)", display: "block" }}
      >
        <circle cx="30" cy="30" r="25" fill="none" stroke={look.track} strokeWidth={stroke} />
        <circle
          data-ring-arc
          className={animate ? "ring" : undefined}
          cx="30"
          cy="30"
          r="25"
          fill="none"
          stroke={look.arc}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={ringOffset(utilization)}
        />
      </svg>
      {showLabel && (
        <span
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "center",
            fontSize: size >= 44 ? 11 : 10,
            fontWeight: 650,
          }}
        >
          {percentLabel(utilization)}
        </span>
      )}
    </span>
  )
}
