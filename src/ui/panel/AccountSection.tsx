/**
 * The panel's account cards: which Claude account this project bills to.
 *
 * Billing and the five-hour window follow this choice, so switching always
 * asks - and the two readings that could get it wrong are both refused here
 * rather than guessed:
 *
 * - **Nothing is drawn as checked when the stored pair matches no option, or
 *   more than one.** A checked card is a claim about where the money goes, and
 *   a note says plainly that kantan cannot tell which profile is in use.
 * - **The handler is given the whole option, not a kind.** `src/spawn.ts` sets
 *   `CLAUDE_CONFIG_DIR` from `configDir` and nothing reads `account` to decide
 *   what gets billed, so a shell that PATCHed the word alone would move the
 *   chip and keep billing the same profile - the one defect the confirmation
 *   exists to prevent.
 *
 * "Add another account" lives here because the options are derived from what is
 * registered: with one project on one profile there is exactly one card, and
 * without this there was no way to reach a second account anywhere in the app.
 */

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactElement } from "react"

import {
  BLURB,
  CONFIRM_DARK,
  CONFIRM_GHOST,
  H2,
  KindIcon,
  LINE,
  OFF_CARD,
  PILL_DARK,
  PILL_GHOST,
  RING_LOOK,
  SECTION,
  SELECTED_CARD,
  UsageRing,
  cardSubtitle,
  messageOf,
} from "./chrome.tsx"
import { optionId } from "./accounts.ts"
import { confirmProse } from "./switch.tsx"
import type { SwitchController } from "./switch.tsx"
import type { Account } from "../Tree.tsx"
import type { AccountKind, AccountOption } from "../ProjectPanel.tsx"

export function AccountSection({
  name,
  stored,
  checkedKey,
  ambiguous,
  accounts,
  animate,
  anim,
  switcher,
  onAddAccount,
}: {
  name: string
  stored: Account["kind"]
  /** The pair to draw as checked, or `null` to check nothing. */
  checkedKey: string | null
  /** The stored word names more than one of the options on offer. */
  ambiguous: boolean
  accounts: readonly AccountOption[]
  animate: boolean
  anim: (classes: string) => string | undefined
  switcher: SwitchController
  onAddAccount?: (account: { kind: AccountKind; label: string; configDir: string }) => void | Promise<void>
}): ReactElement {
  const target = switcher.pending
  const [adding, setAdding] = useState(false)
  const [kind, setKind] = useState<AccountKind>("work")
  const [label, setLabel] = useState("")
  const [dir, setDir] = useState("")
  const [addError, setAddError] = useState<string | null>(null)
  const addIds = useId()

  const submitAccount = (): void => {
    const trimmedLabel = label.trim()
    const trimmedDir = dir.trim()
    if (trimmedLabel === "" || trimmedDir === "") {
      setAddError("A name and a Claude config folder are both required.")
      return
    }
    /* The folder is what gets billed, so an obviously unusable one is refused
       here rather than after a run has spent on it. The store checks this too
       and its refusal would arrive just as well - saying it in the form is for
       the human, not for the data. */
    if (!trimmedDir.startsWith("/") && !trimmedDir.startsWith("~")) {
      setAddError("The folder has to be an absolute path, or start with ~ for your home directory.")
      return
    }
    setAddError(null)
    void (async () => {
      try {
        await onAddAccount?.({ kind, label: trimmedLabel, configDir: trimmedDir })
        setLabel("")
        setDir("")
        setAdding(false)
      } catch (cause) {
        setAddError(messageOf(cause))
      }
    })()
  }
  return (
    <div data-card-section className={anim("bf d1")} style={SECTION}>
      <h2 style={H2}>Claude account</h2>
      <p style={{ ...BLURB, margin: "4px 0 14px" }}>
        Billing and the 5-hour rate limit follow this choice. Getting it wrong costs real money, so switching always
        asks first.
      </p>

      {stored === "unknown" && (
        <p
          style={{
            margin: "0 0 12px",
            padding: "10px 12px",
            borderRadius: 12,
            background: "#F1F1F4",
            fontSize: 13,
            lineHeight: 1.5,
            color: "#3A3D45",
          }}
        >
          Nobody has said which account this project runs as, so kantan will not guess. Pick one before the next run.
        </p>
      )}

      {ambiguous && (
        <p
          data-ambiguous
          style={{
            margin: "0 0 12px",
            padding: "10px 12px",
            borderRadius: 12,
            background: "#F1F1F4",
            fontSize: 13,
            lineHeight: 1.5,
            color: "#3A3D45",
          }}
        >
          More than one account here reads <strong style={{ fontWeight: 620 }}>{stored}</strong>, and the folder this
          project stores does not match any of them — so kantan cannot tell which profile it runs on and checks none of
          them. Picking one says which, and future runs bill there.
        </p>
      )}

      <div
        role="radiogroup"
        aria-label="Claude account"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(min(240px,100%),1fr))",
          gap: 10,
        }}
      >
        {accounts.map((option) => {
          const checked = checkedKey !== null && optionId(option) === checkedKey
          const subtitle = cardSubtitle(option)
          return (
            <button
              key={optionId(option)}
              type="button"
              role="radio"
              data-card={option.kind}
              data-card-key={optionId(option)}
              aria-checked={checked}
              onClick={() => switcher.ask(option)}
              className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo"
              style={{
                display: "grid",
                gridTemplateColumns: "44px minmax(0,1fr) 20px",
                gap: 12,
                alignItems: "center",
                minHeight: 76,
                padding: "12px 14px",
                borderRadius: 16,
                textAlign: "left",
                color: "#111216",
                boxSizing: "border-box",
                ...(checked ? SELECTED_CARD : OFF_CARD),
              }}
            >
              <UsageRing option={option} size={44} stroke={7} animate={animate} showLabel />
              <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 15,
                    fontWeight: 620,
                    color: RING_LOOK[option.kind].ink,
                  }}
                >
                  <KindIcon kind={option.kind} size={14} />
                  {option.label}
                </span>
                {subtitle !== "" && (
                  <span className="m" style={{ fontSize: 12, color: "#5F6370" }}>
                    {subtitle}
                  </span>
                )}
              </span>
              <span
                aria-hidden="true"
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: "50%",
                  boxSizing: "border-box",
                  ...(checked
                    ? { border: "6px solid #111216", background: "#fff" }
                    : { border: "1.5px solid #C4C7CE", background: "#fff" }),
                }}
              />
            </button>
          )
        })}
      </div>

      {onAddAccount !== undefined && (
        <div style={{ marginTop: 10 }}>
          {adding ? (
            <div
              className={animate ? "pop" : undefined}
              data-add-account
              style={{
                display: "grid",
                gap: 10,
                padding: 12,
                borderRadius: 14,
                border: "1px solid #E2E2E7",
                background: "#FCFCFD",
              }}
            >
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: "#4A4E59", maxWidth: "62ch" }}>
                A Claude account <strong style={{ fontWeight: 620 }}>is</strong> a config folder — the one{" "}
                <span className="m" style={{ fontSize: 12.5 }}>CLAUDE_CONFIG_DIR</span> points at. Name it, say where it
                is, and {name} switches to it; every project that uses the same folder will offer it from then on.
              </p>

              <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit,minmax(min(200px,100%),1fr))" }}>
                <div>
                  <label htmlFor={`${addIds}-label`} style={{ display: "block", fontSize: 12.5, fontWeight: 560, color: "#4A4E59", marginBottom: 5 }}>
                    What to call it
                  </label>
                  <input
                    id={`${addIds}-label`}
                    data-add-account-label
                    value={label}
                    placeholder="acme"
                    onChange={(e) => {
                      setLabel(e.target.value)
                      setAddError(null)
                    }}
                    style={{ width: "100%", minHeight: 42, padding: "0 12px", borderRadius: 10, border: "1px solid #E2E2E7", background: "#fff", fontSize: 13.5, boxSizing: "border-box" }}
                  />
                </div>
                <div>
                  <label htmlFor={`${addIds}-dir`} style={{ display: "block", fontSize: 12.5, fontWeight: 560, color: "#4A4E59", marginBottom: 5 }}>
                    Claude config folder
                  </label>
                  <input
                    id={`${addIds}-dir`}
                    data-add-account-dir
                    className="m"
                    value={dir}
                    placeholder="~/.claude-acme"
                    onChange={(e) => {
                      setDir(e.target.value)
                      setAddError(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault()
                        submitAccount()
                      }
                    }}
                    style={{ width: "100%", minHeight: 42, padding: "0 12px", borderRadius: 10, border: "1px solid #E2E2E7", background: "#fff", fontSize: 13.5, boxSizing: "border-box" }}
                  />
                </div>
              </div>

              <div>
                <span style={{ display: "block", fontSize: 12.5, fontWeight: 560, color: "#4A4E59", marginBottom: 5 }}>
                  Which kind of account
                </span>
                {/* `kind` is only the chip's word - `configDir` above is what
                    gets billed - but it is the word every surface prints, so
                    the human chooses it rather than having one guessed from a
                    folder name. */}
                <div role="radiogroup" aria-label="Account kind" style={{ display: "flex", gap: 8 }}>
                  {(["personal", "work"] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      role="radio"
                      aria-checked={kind === option}
                      data-add-account-kind={option}
                      onClick={() => setKind(option)}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 7,
                        height: 38,
                        padding: "0 14px",
                        borderRadius: 999,
                        boxSizing: "border-box",
                        border: kind === option ? "1.5px solid #111216" : "1px solid #E2E2E7",
                        background: "#fff",
                        fontSize: 13.5,
                        fontWeight: 560,
                        color: "#111216",
                      }}
                    >
                      <KindIcon kind={option} size={13} />
                      {option}
                    </button>
                  ))}
                </div>
              </div>

              {addError !== null && (
                <p role="alert" style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: "#D92D3A" }}>
                  {addError}
                </p>
              )}

              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <button
                  type="button"
                  onClick={submitAccount}
                  className={PILL_DARK}
                  style={{ height: 40, padding: "0 16px", borderRadius: 999, border: 0, background: "#111216", color: "#fff", fontSize: 13.5, fontWeight: 620 }}
                >
                  Use this account
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAdding(false)
                    setAddError(null)
                  }}
                  className={PILL_GHOST}
                  style={{ height: 40, padding: "0 16px", borderRadius: 999, border: "1px solid #D9D9DF", background: "#fff", fontSize: 13.5, fontWeight: 560, color: "#1E2026" }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              data-add-account-open
              onClick={() => setAdding(true)}
              style={{
                border: 0,
                padding: 0,
                background: "none",
                font: "inherit",
                fontSize: 13.5,
                fontWeight: 560,
                // The artboard's colour for a text button, as "Add another
                // account" in `AddRepo.dc.html` has it.
                color: "#4B4BC8",
                cursor: "pointer",
                textDecoration: "underline",
                textUnderlineOffset: 3,
              }}
            >
              Add another account
            </button>
          )}
        </div>
      )}

      {target !== null && (
        <div
          data-confirm="panel"
          role="alertdialog"
          aria-label="Confirm account switch"
          /* `role="alertdialog"` without `aria-modal`: the artboard draws this
             inline, and the remove dialog is the only modal in the design. */
          className={anim("pop")}
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "12px 16px",
            marginTop: 12,
            padding: "14px 16px",
            borderRadius: 14,
            background: "#F6F6F8",
            border: "1px solid #E2E2E7",
          }}
        >
          <span style={{ flex: "1 1 300px", fontSize: 14, lineHeight: 1.5, color: "#2A2C33" }}>
            <strong style={{ fontWeight: 650 }}>{confirmProse(name, target, stored).heading}</strong>{" "}
            {confirmProse(name, target, stored).body}
          </span>
          <button
            type="button"
            onClick={switcher.confirm}
            disabled={switcher.busy}
            className={PILL_DARK}
            style={CONFIRM_DARK}
          >
            {switcher.busy ? "Switching…" : `Switch to ${target.label}`}
          </button>
          <button type="button" onClick={switcher.cancel} className={PILL_GHOST} style={CONFIRM_GHOST}>
            Cancel
          </button>
        </div>
      )}

      {switcher.error !== null && (
        <p
          role="alert"
          style={{
            margin: "12px 0 0",
            borderRadius: 12,
            border: "1px solid #F3C6C9",
            background: "#FDF2F3",
            padding: "10px 12px",
            fontSize: 13,
            lineHeight: 1.5,
            color: "#D92D3A",
          }}
        >
          {switcher.error}
        </p>
      )}
    </div>
  )
}
