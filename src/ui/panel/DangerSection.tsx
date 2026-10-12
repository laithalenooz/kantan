/**
 * Removing the project from kantan, and the one modal in the app.
 *
 * A dialog here and nowhere else, which is the rule `DESIGN.md` sets: this is
 * the only action on this screen that cannot be undone from it. It traps Tab,
 * opens focus on the safe choice, and closes on Escape.
 *
 * The scrim is rendered **outside** the card, and that placement is
 * load-bearing rather than tidy: `.bf` ends on `filter: blur(0)` with
 * `animation-fill-mode: both`, and a filter other than `none` makes an element
 * the containing block for `position: fixed` descendants - so a scrim inside
 * the card was laid out against the card and clipped by its `overflow: clip`.
 * Caught by a screenshot; no DOM assertion saw it.
 */

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactElement } from "react"

import { BLURB, H2, LINE, PILL_GHOST, SECTION, messageOf } from "./chrome.tsx"
import { CONFIRM_DARK, CONFIRM_GHOST, FOCUSABLE, focusablesIn } from "./chrome.tsx"

/* -------------------------------------------------------------------------- */

/**
 * Remove from kantan: the section, which is only copy and a trigger.
 *
 * The dialog it opens is rendered by `ProjectPanel` at the panel root rather
 * than here. See the comment at that call site: `.bf` leaves a `filter` behind,
 * a filter makes an element the containing block for `position: fixed`, and the
 * card is `overflow: clip`.
 *
 * The copy diverges from the artboard on purpose. `docs/design/Project.dc.html`
 * says removal "deletes its run history"; `src/projects.ts`'s `removeProject`
 * documents the opposite at length - run logs live in `~/.orch/runs` keyed by
 * run id, they are the record of work that cost real money, nothing can
 * rebuild one, and re-registering the same path brings every run of it back
 * into the tree. A confirmation that invents a deletion invites the reader to
 * imagine the worse thing, so the implementation's truth wins.
 */
export function DangerSection({
  name,
  anim,
  triggerRef,
  onAsk,
}: {
  name: string
  anim: (classes: string) => string | undefined
  triggerRef: React.RefObject<HTMLButtonElement | null>
  onAsk: () => void
}): ReactElement {
  return (
    <div
      data-danger
      className={anim("bf d5")}
      style={{
        padding: "22px clamp(20px,4vw,40px) 26px",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "12px 20px",
      }}
    >
      <div style={{ flex: "1 1 300px" }}>
        <div style={{ fontSize: 15, fontWeight: 650, color: "#A61B27" }}>Remove from kantan</div>
        <p style={{ ...BLURB, margin: "4px 0 0" }}>
          kantan stops tracking it. Your repository, its branches and its task files stay exactly as they are &mdash;
          nothing is deleted from disk, and the run history is kept.
        </p>
      </div>
      <button
        type="button"
        ref={triggerRef}
        onClick={onAsk}
        className={PILL_GHOST}
        style={{
          height: 44,
          padding: "0 18px",
          borderRadius: 999,
          border: "1px solid #F0B8BE",
          background: "#fff",
          color: "#A61B27",
          fontSize: 14,
          fontWeight: 600,
        }}
      >
        Remove {name}
      </button>
    </div>
  )
}

/**
 * The one modal in the whole design, with the semantics a modal owes: focus
 * starts on the safe choice, Tab is trapped both ways, Escape closes, and
 * focus returns to the control that opened it.
 */
export function RemoveDialog({
  name,
  animate,
  onRemove,
  onClose,
}: {
  name: string
  animate: boolean
  onRemove: () => void | Promise<void>
  onClose: () => void
}): ReactElement {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const keepRef = useRef<HTMLButtonElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const headingId = useId()
  const bodyId = useId()

  /* Focus starts on the safe choice, never on the destructive one. */
  useEffect(() => {
    keepRef.current?.focus()
  }, [])

  const go = (): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    void (async () => {
      try {
        await onRemove()
        onClose()
      } catch (cause) {
        setError(messageOf(cause))
      } finally {
        setBusy(false)
      }
    })()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault()
      if (!busy) onClose()
      return
    }
    if (event.key !== "Tab") return
    const nodes = focusablesIn(dialogRef.current)
    const first = nodes[0]
    const last = nodes.at(-1)
    if (first === undefined || last === undefined) return
    const active = document.activeElement
    /* Trapped both ways. Without this, Tab walks out of a modal into controls
       the scrim is covering, which is how a destructive dialog gets confirmed
       by a keystroke aimed at something behind it. */
    if (event.shiftKey && active === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      data-scrim
      /* `.kr` on the scrim as well as the root: it is `position: fixed`, and
         the kill-switch is a descendant selector. */
      className={`kr${animate ? " dim" : ""}`}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 40,
        background: "rgba(17,18,22,.32)",
        display: "grid",
        placeItems: "center",
        padding: 16,
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={bodyId}
        onKeyDown={onKeyDown}
        className={animate ? "pop" : undefined}
        style={{
          width: "100%",
          maxWidth: 440,
          boxSizing: "border-box",
          padding: 24,
          borderRadius: 20,
          background: "#fff",
          boxShadow: "0 30px 80px -20px rgba(17,18,22,.5)",
          lineHeight: "normal",
        }}
      >
        <h2 id={headingId} style={{ margin: 0, fontSize: 20, fontWeight: 650, letterSpacing: "-.02em" }}>
          Remove {name} from kantan?
        </h2>
        <p id={bodyId} style={{ margin: "10px 0 20px", fontSize: 14.5, lineHeight: 1.55, color: "#3A3D45" }}>
          kantan stops tracking it. The repository, its branches and its task files stay exactly as they are &mdash;
          nothing is deleted from disk, and the runs it has already done keep their logs. You can add it again at any
          time, and its history comes back with it.
        </p>
        {error !== null && (
          <p
            role="alert"
            style={{
              margin: "0 0 16px",
              borderRadius: 10,
              border: "1px solid #F3C6C9",
              background: "#FDF2F3",
              padding: "10px 12px",
              fontSize: 13,
              lineHeight: 1.5,
              color: "#D92D3A",
            }}
          >
            {error}
          </p>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            ref={keepRef}
            onClick={onClose}
            className={PILL_GHOST}
            style={{
              height: 44,
              padding: "0 18px",
              borderRadius: 999,
              border: "1px solid #D9D9DF",
              background: "#fff",
              fontSize: 14,
              fontWeight: 560,
              color: "#1E2026",
            }}
          >
            Keep it
          </button>
          <button
            type="button"
            onClick={go}
            disabled={busy}
            className="inline-flex items-center justify-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo"
            style={{
              height: 44,
              padding: "0 18px",
              borderRadius: 999,
              border: 0,
              background: "#B4232F",
              color: "#fff",
              fontSize: 14,
              fontWeight: 620,
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? "Removing…" : "Remove project"}
          </button>
        </div>
      </div>
    </div>
  )
}
