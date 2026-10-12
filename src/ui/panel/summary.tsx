/**
 * "Where this project is": what the project amounts to, above the settings
 * that change it.
 *
 * First in the card, because what is in here and what it has cost is the
 * question a human opens a project with - the settings answer what it should
 * do next, which is a different and rarer one.
 *
 * Two figures follow rules rather than taste. The **spend says "at least"**,
 * because its parts are floors and it is the one number here someone might
 * budget against. **Self-checked work is counted apart** from work a test
 * command passed, and apart again from a log that cannot say - folding any two
 * together is the over-claim `verificationOf` exists to prevent.
 */

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactElement } from "react"

import { BLURB, H2, LINE, PILL_GHOST, SECTION, messageOf } from "./chrome.tsx"
import type { ProjectSummary } from "../Tree.tsx"

/**
 * What the project amounts to, above the settings that change it.
 *
 * First in the card, because "what is in here and what has it cost" is the
 * question a human opens a project with - the settings answer "what should it
 * do next", which is a different and rarer one. Reported as missing: clicking
 * a project went straight to a form.
 *
 * Two of its figures are shaped by rules rather than by taste:
 *
 * - **The spend says "at least".** Its parts are floors (`RunSummary` in
 *   `src/runindex.ts` keeps the largest `total_cost_usd` it read for a run with
 *   no `end` record), and this is the one number in the panel someone might
 *   budget against. A total that could only ever be low must not be printed as
 *   a total.
 * - **Self-checked work is counted apart, and so is work from a log that
 *   cannot say.** Folding either into "verified" would be the over-claim
 *   `verificationOf` exists to prevent.
 */
export function SummarySection({
  summary,
  testCmd,
  anim,
}: {
  summary: ProjectSummary
  testCmd: string | null
  anim: (classes: string) => string | undefined
}): ReactElement {
  const { byState } = summary
  const needsYou = byState["needs-you"]
  const running = byState.running + byState.grinding
  const unfinished = byState.failed + byState.stalled + byState.interrupted
  const open = byState.open

  /** One figure and its word. `null` rows are dropped rather than shown as 0. */
  const stats: ReadonlyArray<{ value: string; label: string; tone?: "attention" | "muted" } | null> = [
    { value: String(summary.tasks), label: summary.tasks === 1 ? "task" : "tasks" },
    { value: String(summary.done), label: "ticked" },
    open === 0 ? null : { value: String(open), label: "not started", tone: "muted" },
    needsYou === 0 ? null : { value: String(needsYou), label: needsYou === 1 ? "needs you" : "need you", tone: "attention" },
    running === 0 ? null : { value: String(running), label: "running" },
    unfinished === 0 ? null : { value: String(unfinished), label: "stopped or failed", tone: "muted" },
  ]

  return (
    <div data-summary style={SECTION} className={anim("bf d1")}>
      <h2 style={H2}>Where this project is</h2>
      <p style={{ ...BLURB, margin: "4px 0 14px" }}>
        {summary.tasks === 0
          ? "No tasks yet. Add a task file below, or describe the work and let kantan draft one."
          : `${summary.tasks} task${summary.tasks === 1 ? "" : "s"} across ${summary.taskFiles} file${summary.taskFiles === 1 ? "" : "s"}.`}
      </p>

      {summary.tasks > 0 && (
        <div
          style={{
            display: "grid",
            gap: 10,
            gridTemplateColumns: "repeat(auto-fit,minmax(min(116px,100%),1fr))",
          }}
        >
          {stats.filter((s): s is NonNullable<typeof s> => s !== null).map((stat) => (
            <div
              key={stat.label}
              data-stat={stat.label}
              style={{
                padding: "10px 12px",
                borderRadius: 12,
                border: `1px solid ${stat.tone === "attention" ? "#FFD2B3" : "#EEEEF1"}`,
                background: stat.tone === "attention" ? "#FFF8F2" : "#FCFCFD",
              }}
            >
              <div
                style={{
                  fontSize: 24,
                  fontWeight: 650,
                  letterSpacing: "-.03em",
                  fontVariantNumeric: "tabular-nums",
                  color: stat.tone === "attention" ? "#9A3B06" : "#111216",
                }}
              >
                {stat.value}
              </div>
              <div style={{ marginTop: 1, fontSize: 12.5, color: stat.tone === "attention" ? "#9A3B06" : "#5F6370" }}>
                {stat.label}
              </div>
            </div>
          ))}
        </div>
      )}

      {summary.everRun > 0 && (
        <div style={{ marginTop: 14, display: "grid", gap: 6 }}>
          <div data-spend style={{ fontSize: 13.5, color: "#2A2C33" }}>
            {/* "At least", every time. See the docstring. */}
            At least <strong style={{ fontWeight: 650, fontVariantNumeric: "tabular-nums" }}>${summary.spentUsd.toFixed(2)}</strong>{" "}
            spent across {summary.everRun} task{summary.everRun === 1 ? " that has" : "s that have"} run.{" "}
            <span style={{ color: "#5F6370" }}>
              A run kantan is still driving reports a floor rather than a total, so this can only be low.
            </span>
          </div>

          <div data-verification style={{ fontSize: 13.5, lineHeight: 1.5, color: "#2A2C33" }}>
            {summary.verified.testCommand + summary.verified.selfCheck + summary.verified.unknown === 0 ? (
              <span style={{ color: "#5F6370" }}>Nothing has finished yet, so nothing has been verified.</span>
            ) : (
              <>
                Of the work that finished:{" "}
                {summary.verified.testCommand > 0 && (
                  <>
                    <strong style={{ fontWeight: 650 }}>{summary.verified.testCommand}</strong> passed{" "}
                    {testCmd === null ? "a test command" : <span className="m">{testCmd}</span>}
                    {summary.verified.selfCheck + summary.verified.unknown > 0 ? ", " : ". "}
                  </>
                )}
                {summary.verified.selfCheck > 0 && (
                  <>
                    <strong style={{ fontWeight: 650 }}>{summary.verified.selfCheck}</strong> was checked by the agent
                    itself and by nothing else
                    {summary.verified.unknown > 0 ? ", " : ". "}
                  </>
                )}
                {summary.verified.unknown > 0 && (
                  <>
                    <strong style={{ fontWeight: 650 }}>{summary.verified.unknown}</strong> came from a log that does
                    not record how it was checked.{" "}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
