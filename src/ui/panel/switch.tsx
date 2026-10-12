/**
 * One confirmation step, one toast, one Undo rule - for both ways into a
 * switch.
 *
 * Shared by the panel's cards and the chip's popover so the rule cannot drift
 * between them. The rules, which are about money rather than about UI:
 *
 * - **The only skip is an identity check on the pair.** Picking the option
 *   already stored changes nothing. On the word alone, picking a *different*
 *   folder of the same word would skip the confirmation and then do nothing at
 *   all, leaving the clicked card claiming a profile the runs never move to.
 *   One extra confirmation is cheap; a silent rebill is not.
 * - **Undo resolves the pair it came from, or is not offered.** Resolving the
 *   word would rebill to whichever folder happened to come first.
 * - **The toast names the folder**, because two options can read "work" and
 *   "now runs as work" would be true of the state just left.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react"

import { percentLabel } from "../format.ts"
import type { Account } from "../Tree.tsx"
import type { AccountOption } from "../ProjectPanel.tsx"
import { Check, Cross, PILL_GHOST, messageOf } from "./chrome.tsx"
import { optionId, storedId } from "./accounts.ts"

export const TOAST_MS = 5000

/* -------------------------------------------------------------------------- */
/* The shared switch                                                          */
/* -------------------------------------------------------------------------- */

export interface Toast {
  to: AccountOption
  /**
   * The pair it came from, in `optionId` spelling, which decides whether Undo
   * can exist.
   *
   * The pair rather than the word: with two options reading "work", a word
   * does not say which folder to go back to, and an Undo that picked the first
   * match would quietly rebill to the wrong one.
   */
  from: string
}

export interface SwitchController {
  pending: AccountOption | null
  busy: boolean
  error: string | null
  toast: Toast | null
  /** The option Undo would ask for, or `null` when there is no way back. */
  undoTarget: AccountOption | null
  ask: (account: AccountOption) => void
  cancel: () => void
  confirm: () => void
  undo: () => void
  dismissToast: () => void
}

/**
 * One confirmation step, one toast, one Undo rule, for both entry points.
 *
 * `onSwitched` is how the popover closes itself after a successful switch
 * without the panel also having to know about popovers.
 */
export function useAccountSwitch(
  stored: Account["kind"],
  /** The stored pair, from `storedId`. The identity `stored` alone is not. */
  storedKey: string,
  accounts: readonly AccountOption[],
  onSwitchAccount: (account: AccountOption) => void | Promise<void>,
  onSwitched?: () => void,
): SwitchController {
  const [pending, setPending] = useState<AccountOption | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  /* The 5s dismissal must not outlive the component: a timer firing into an
     unmounted tree is the kind of leak that only shows up as a warning in
     somebody else's suite. */
  useEffect(() => () => clearTimeout(timer.current), [])

  const dismissToast = useCallback(() => {
    clearTimeout(timer.current)
    setToast(null)
  }, [])

  const ask = useCallback(
    (account: AccountOption) => {
      setError(null)
      /* The only skip, and it is an identity check rather than a judgement:
         picking the option already stored would change nothing. Every other
         reading - including `unknown` - confirms.

         The identity is the pair. On the word alone, picking a *different*
         folder of the same word would skip the confirmation and then do
         nothing at all, leaving the card it was clicked on claiming a profile
         the runs never move to. One extra confirmation is the cheap
         direction; a silent rebill is not. */
      setPending(optionId(account) === storedKey ? null : account)
    },
    [storedKey],
  )

  const cancel = useCallback(() => {
    setPending(null)
    setError(null)
  }, [])

  const confirm = useCallback(() => {
    if (pending === null || busy) return
    setBusy(true)
    setError(null)
    void (async () => {
      try {
        await onSwitchAccount(pending)
        clearTimeout(timer.current)
        setToast({ to: pending, from: storedKey })
        timer.current = setTimeout(() => setToast(null), TOAST_MS)
        setPending(null)
        onSwitched?.()
      } catch (cause) {
        setError(messageOf(cause))
      } finally {
        setBusy(false)
      }
    })()
  }, [busy, onSwitchAccount, onSwitched, pending, storedKey])

  /* `updateProject` takes "personal" | "work", so there is no way back to
     "nobody has said"; and an account the caller no longer offers has no
     `configDir` to send. Either way the control that would try is not drawn,
     rather than drawn and broken. */
  const undoTarget = useMemo(() => {
    if (toast === null || toast.from.startsWith("unknown/")) return null
    /* Exactly one, or none: two options answering to the stored pair cannot
       both be where it came from, and guessing between them is a rebill. */
    const hits = accounts.filter((option) => optionId(option) === toast.from)
    return hits.length === 1 ? (hits[0] ?? null) : null
  }, [accounts, toast])

  const undo = useCallback(() => {
    if (undoTarget === null) return
    dismissToast()
    void (async () => {
      try {
        await onSwitchAccount(undoTarget)
      } catch (cause) {
        setError(messageOf(cause))
      }
    })()
  }, [dismissToast, onSwitchAccount, undoTarget])

  return { pending, busy, error, toast, undoTarget, ask, cancel, confirm, undo, dismissToast }
}

/** What the confirmation says, in one place, because both entry points say it. */
export function confirmProse(name: string, target: AccountOption, stored: Account["kind"]): { heading: string; body: ReactNode } {
  const used = target.window?.utilization
  const usage =
    used === undefined || !Number.isFinite(used)
      ? "no usage reported yet"
      : `${percentLabel(used)} of its window used`
  return {
    heading: `Switch ${name} to ${target.label}?`,
    body: (
      <>
        Future runs bill to <strong style={{ fontWeight: 620 }}>{target.label}</strong>
        {/* The folder, not only the word. This dialog is the last thing between
            a click and a real bill, and the word does not identify where the
            money goes: two options can read "work" and bill to different
            folders, so "bill to work" would be true of the state being left.
            `src/spawn.ts` turns exactly this string into `CLAUDE_CONFIG_DIR`,
            and it is printed verbatim for that reason.

            An option with no folder is the default profile, and saying so
            beats naming a directory the run will not use. */}
        {" ("}
        {target.configDir === undefined ? (
          "the default profile"
        ) : (
          <span className="m" style={{ overflowWrap: "anywhere" }}>
            {target.configDir}
          </span>
        )}
        {") "}
        and counts against its 5-hour window ({usage}).{" "}
        {/* The stored account can be one nobody named, and "their history
            under account unknown" is a sentence that invents a fact. */}
        {stored === "unknown"
          ? "Past runs keep the history they already have."
          : `Past runs keep their history under ${stored}.`}
      </>
    ),
  }
}

/** The toast both entry points finish with. */
export function SwitchToast({
  name,
  to,
  profile,
  canUndo,
  animate,
  onUndo,
  onDismiss,
}: {
  name: string
  to: string
  /**
   * The folder the runs will now use, printed beside the label.
   *
   * The label alone is not the answer to "what changed": two options can read
   * "work", so a toast saying "now runs as work" would be true of the state it
   * just left. Absent for an option with no folder, which the caller spells
   * out instead.
   */
  profile?: string
  canUndo: boolean
  animate: boolean
  onUndo: () => void
  onDismiss: () => void
}): ReactElement {
  return (
    <div
      data-toast
      role="status"
      /* `.kr` here as well as on the root: this layer is `position: fixed`, and
         the kill-switch is a descendant selector. */
      className={`kr${animate ? " toast" : ""}`}
      style={{
        position: "fixed",
        right: 24,
        bottom: 24,
        zIndex: 30,
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "12px 12px 12px 16px",
        borderRadius: 14,
        background: "#111216",
        color: "#F4F4F6",
        boxShadow: "0 18px 40px -12px rgba(17,18,22,.55)",
        fontSize: 14,
        lineHeight: "normal",
      }}
    >
      <Check size={16} />
      <span>
        {name} now runs as <strong style={{ fontWeight: 650 }}>{to}</strong>
        {profile !== undefined && (
          <>
            {" · "}
            <span className="m" style={{ color: "#C9CAD1" }}>
              {profile}
            </span>
          </>
        )}
      </span>
      {canUndo && (
        <button
          type="button"
          onClick={onUndo}
          className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          style={{
            height: 32,
            padding: "0 12px",
            borderRadius: 999,
            border: "1px solid rgba(255,255,255,.25)",
            background: "transparent",
            color: "#fff",
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          Undo
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        style={{
          width: 28,
          height: 28,
          display: "grid",
          placeItems: "center",
          borderRadius: 999,
          border: 0,
          background: "transparent",
          color: "#F4F4F6",
        }}
      >
        <Cross size={14} />
      </button>
    </div>
  )
}
