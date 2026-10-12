/**
 * The default cost ceiling a new run starts with.
 *
 * The figure is the money guard, and the refusals are the point of it: a blank,
 * a zero, a negative and anything that is not a plain decimal are all turned
 * away rather than stored, because a ceiling this reader cannot use would
 * unbound the next run silently.
 */

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactElement } from "react"

import { BLURB, H2, LINE, PILL_GHOST, SECTION, messageOf } from "./chrome.tsx"

export function CeilingSection({
  budgetUsd,
  onSaveBudget,
  anim,
}: {
  budgetUsd: number
  onSaveBudget: (usd: number) => void | Promise<void>
  anim: (classes: string) => string | undefined
}): ReactElement {
  const [draft, setDraft] = useState(budgetUsd.toFixed(2))
  const [saved, setSaved] = useState(budgetUsd)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setDraft(budgetUsd.toFixed(2))
    setSaved(budgetUsd)
  }, [budgetUsd])

  const commit = (): void => {
    const trimmed = draft.trim()
    const parsed = trimmed === "" ? Number.NaN : Number(trimmed)
    /* `src/projects.ts` refuses a non-positive or non-finite budget with the
       field named in the message, so the field refuses it here rather than
       sending a request that is already known to fail. */
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError("A ceiling is a number of dollars above zero.")
      return
    }
    setError(null)
    if (parsed === saved) return
    setSaved(parsed)
    void (async () => {
      try {
        await onSaveBudget(parsed)
      } catch (cause) {
        setError(messageOf(cause))
      }
    })()
  }

  return (
    <div
      className={anim("bf d4")}
      style={{
        ...SECTION,
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit,minmax(min(240px,100%),1fr))",
        gap: 16,
        alignItems: "end",
      }}
    >
      <div>
        <label htmlFor="kp-ceiling" style={{ display: "block", ...H2 }}>
          Default cost ceiling
        </label>
        <p style={{ ...BLURB, margin: "4px 0 0" }}>
          Used for new runs. You can change it per run when you start one.
        </p>
        {error !== null && (
          <p role="alert" style={{ margin: "8px 0 0", fontSize: 13, lineHeight: 1.5, color: "#D92D3A" }}>
            {error}
          </p>
        )}
      </div>
      <span
        className="fld"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          minHeight: 46,
          padding: "0 14px",
          borderRadius: 12,
          border: "1px solid #E2E2E7",
          background: "#fff",
          boxSizing: "border-box",
        }}
      >
        <span style={{ color: "#5F6370" }}>$</span>
        <input
          id="kp-ceiling"
          value={draft}
          inputMode="decimal"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              commit()
            }
          }}
          style={{
            border: 0,
            outline: "none",
            background: "transparent",
            width: "100%",
            fontSize: 14,
            fontVariantNumeric: "tabular-nums",
            color: "#111216",
          }}
        />
        <span style={{ fontSize: 13, color: "#5F6370", whiteSpace: "nowrap" }}>per run</span>
      </span>
    </div>
  )
}
