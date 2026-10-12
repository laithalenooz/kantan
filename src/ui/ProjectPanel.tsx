/**
 * Project settings, and the account switch: `docs/design/Project.dc.html`.
 *
 * The centre column, not a settings page and not a dialog. `canvas.json`'s
 * note is explicit about both: *"All of these replace the centre column. No
 * routes, no settings page, and dialogs only for confirmations."* So this file
 * exports a panel the shell renders in place of the run view, plus the chip
 * popover that belongs beside the repo name in the tree.
 *
 * Two components, one switch:
 *
 *   - `ProjectPanel`  - the Card with sections, the artboard's `<main>`.
 *   - `AccountSwitch` - the chip and its popover, the artboard's `<aside>`.
 *
 * They share `useAccountSwitch`, so the confirmation step, the toast and the
 * Undo rule cannot drift apart between the two entry points. That sharing is
 * the point rather than tidiness: both paths move money.
 *
 * ## Props and callbacks only
 *
 * Nothing here fetches. The shell owns `src/ui/live.ts` and reloads the tree
 * after a change lands, which is also why **the checked card follows the props
 * and never local state**: the backlog is markdown in the target repo and the
 * UI renders and remote-controls, it never owns truth (`CLAUDE.md`).
 *
 * ## What is optional, and why that matters
 *
 * Four regions of the artboard have no server behind them today. Each is gated
 * on its own callback and **hidden when the callback is absent**, because the
 * alternative is drawing a control that silently does nothing - or worse,
 * printing `50.00` and `main · clean` from nowhere, which is the "invented
 * data" defect this project has already fixed once. The absent ones are listed
 * in the task's report rather than stubbed:
 *
 * | region | gate | what the server would need |
 * |---|---|---|
 * | "Run it now" | `onRunTest` | an endpoint that runs `testCmd` and returns its exit code |
 * | Default cost ceiling | `budgetUsd` + `onSaveBudget` | `budgetUsd` on the tree payload |
 * | Stop tracking a task file | `onStopTracking` | an explicit task-file list; today they are globbed |
 * | Add a task file | `onAddTaskFile` | the same list |
 * | Add an account | `onAddAccount` | a profile registry |
 *
 * ## The one guard that decides anything, and its matrix
 *
 * `project.account.kind` is `personal | work | unknown`, and `unknown` is not a
 * placeholder: `src/projects.ts` keeps `account` optional because nobody may
 * have said, and `Tree.tsx`'s `Account` forbids defaulting to "personal"
 * because a wrong account bills a client from the wrong place.
 *
 * So the skip in `ask()` reads exactly one dimension and takes exactly one
 * value as permission to skip:
 *
 * | pick vs stored | skips the confirmation | cost of being wrong |
 * |---|---|---|
 * | identical | yes | none: nothing would change |
 * | different | no | a silent rebill |
 * | stored is `unknown` | **no** | a silent rebill, and nothing to undo to |
 *
 * The cheap direction is to confirm, so only an exact match skips. The
 * expensive direction - skipping when the stored account is unknown - is the
 * one `if (acct === s.account) return` would have taken if `unknown` had ever
 * been spelled `''` or defaulted. `test/ui/ProjectPanel.test.tsx` holds the
 * full 3x2 matrix, including the two rows no artboard state produces.
 *
 * `unknown` has a second consequence, downstream: `updateProject` accepts
 * `"personal" | "work"` and nothing else, so a project switched away from
 * `unknown` **cannot be switched back**. The toast therefore offers no Undo in
 * that one case, rather than an Undo that would throw.
 *
 * ## Motion
 *
 * CSS keyframes from `src/ui/artboard.css`, never Motion components:
 * `docs/HANDOFF.md` measured 195 unhandled `AbortError`s from Motion
 * entrances in one run. `usePrefersReducedMotion` is Sidebar's, which ORs
 * Motion's singleton with a live `matchMedia` read because the singleton has
 * answered `false` with the feature actually set (`CLAUDE.md`).
 *
 * `.kr` is on the root **and** on the two fixed-position layers - the toast
 * and the remove scrim - so the `@media (prefers-reduced-motion: reduce) {
 * .kr, .kr * }` kill-switch reaches them wherever they end up in the box tree.
 *
 * ## Tailwind's preflight is not the artboard's reset
 *
 * Preflight sets `box-sizing: border-box` and `line-height: 1.5`; the artboard
 * has neither. `leading-[normal]` on the root undoes the second. For the
 * first, every element whose artboard declaration *omits* `box-sizing` but
 * carries a border has its height written here as the artboard's **rendered**
 * box - 46px plus a 1px border is `47px` under `border-box` - rather than the
 * number in the artboard, which would come out short. Elements the artboard
 * marks `box-sizing:border-box` itself are copied verbatim.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react"

import {
  RING_CIRCUMFERENCE,
  formatResetTime,
  percentLabel,
  ringOffset,
  usePrefersReducedMotion,
  type AccountWindow,
} from "./Sidebar.tsx"
import type { Account, TreeProject } from "./Tree.tsx"
import { commandOf, SELF_CHECKED } from "./testcmd.ts"

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** The two accounts a project can be switched *to*. `unknown` is not one. */
export type AccountKind = "personal" | "work"

/**
 * One row of the radiogroup, in both the cards and the popover.
 *
 * `window` is `Sidebar.AccountWindow` rather than a loose number pair, so the
 * ring here and the ring in the rail are fed by the same shape and a change to
 * the parser is a compile error in both. Its `label` is ignored in favour of
 * this option's: a window is keyed on a `profile` path and may be absent
 * entirely, while the row still has to print a name.
 */
export interface AccountOption {
  kind: AccountKind
  /** What the row prints. */
  label: string
  /** `CLAUDE_CONFIG_DIR`, printed verbatim. Absent prints nothing. */
  configDir?: string
  /** The 5-hour window. Absent draws an empty ring and prints an em dash. */
  window?: AccountWindow
}

/**
 * What running the test command answered.
 *
 * `exitCode: null` is a run that produced no code, and the three reasons are
 * not interchangeable: a signal, a timeout, and neither. None of them may read
 * as a pass. `DESIGN.md` forbids a tick standing in for a code, and the server
 * runs the tests precisely so that nobody has to take the agent's word for it.
 */
export interface TestCommandResult {
  exitCode: number | null
  signal?: string | null
  timedOut?: boolean
  durationMs?: number
  /** `12 passing`, verbatim from the runner. Absent prints nothing. */
  summary?: string
}

/** A markdown file in the repo that could be a task file. */
export interface TaskFileCandidate {
  path: string
  /** How many tasks were found. Absent means nobody counted. */
  taskCount?: number
}

export interface ProjectPanelProps {
  project: TreeProject
  /** Every account that can be chosen, in the order they are drawn. */
  accounts: readonly AccountOption[]
  /**
   * Asked only after the human confirmed. Rejecting shows the reason.
   *
   * It is handed the whole `AccountOption`, not a kind, and that is a safety
   * rather than a convenience. **`account` is only a label.** `src/spawn.ts`
   * sets `CLAUDE_CONFIG_DIR` from `project.configDir` and deletes it when
   * there is none; `src/run.ts` keys the rate-limit window on `configDir` too.
   * Nothing anywhere reads `project.account` to decide what gets billed.
   *
   * So a shell that PATCHed `{ account }` alone would move the chip and change
   * nothing else - this panel would say "future runs bill to work" and they
   * would keep billing to personal, which is the one defect the chip exists to
   * prevent. Passing the option means the handler has the `configDir` it must
   * send with it, and a handler that ignores it has to do so on purpose.
   */
  onSwitchAccount: (account: AccountOption) => void | Promise<void>
  /** Called with a trimmed, non-empty command, once per change. */
  onSaveTestCmd: (cmd: string) => void | Promise<void>
  /**
   * Sends `null`, which is the only way this panel can say "no suite".
   *
   * Separate from `onSaveTestCmd` rather than `onSaveTestCmd("")` because the
   * store refuses `""` - and it should: `sh -c ""` exits 0, so a blank command
   * would tick every task as tested with nothing run. The opt-out is a
   * different request, so it gets a different handler, and a shell that cannot
   * express it simply omits this and the control is not drawn.
   *
   * Absent hides "Remove the test command".
   */
  onClearTestCmd?: () => void | Promise<void>
  /** Called only from the confirmation dialog. */
  onRemove: () => void | Promise<void>
  /** Runs the command now. Absent hides "Run it now" - there is no endpoint. */
  onRunTest?: (cmd: string) => Promise<TestCommandResult>
  /** The stored default ceiling. Absent hides the section. */
  budgetUsd?: number
  onSaveBudget?: (usd: number) => void | Promise<void>
  /** `main · clean`, already composed. Absent prints nothing. */
  branch?: string
  /** Files the repo offers. Absent hides the "Found in the repo" group. */
  taskFileCandidates?: readonly TaskFileCandidate[]
  /** Absent hides the combobox entirely. */
  onAddTaskFile?: (path: string) => void | Promise<void>
  /** Absent hides every row's dismiss button. */
  onStopTracking?: (path: string) => void | Promise<void>
  className?: string
}

export interface AccountSwitchProps {
  project: TreeProject
  accounts: readonly AccountOption[]
  /** The whole option, for the reason `ProjectPanelProps` gives at length. */
  onSwitchAccount: (account: AccountOption) => void | Promise<void>
  /** Absent hides "Add an account". */
  onAddAccount?: (account: { label: string; configDir: string }) => void | Promise<void>
  className?: string
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * What identifies an account option: the word **and** the folder.
 *
 * `kind` alone is not an identity. It is one of three words, while the thing
 * that decides what a run costs is `configDir` - so a list may hold two
 * options reading "work" that bill to different folders, and `AccountSwitch`'s
 * own "Add an account" is how they get there.
 *
 * Keying a React list on `kind` in that list is not a cosmetic slip. Two
 * children with the same key put the reconciler in a state it calls
 * unsupported, and measured here it does not merely mis-render: a single
 * render of a three-card list holding two `work` options never returned, and
 * the process grew until a 3 GB cgroup killed it. Uncapped, that is the whole
 * machine. `docs/probes/account-key-collision.ts` reruns it.
 *
 * The separator is `/` because a `kind` is one of three words and none of them
 * contains one, so the first `/` always ends the word and the rest is the path
 * verbatim. A NUL would also be unambiguous, and was tried: happy-dom's
 * selector parser reads `\0` in a selector as that NUL and matches, but CSS
 * says an escape of zero is U+FFFD, so the same selector finds nothing in a
 * real browser. A separator that only works in the test harness is worse than
 * no separator.
 *
 * An absent `configDir` and an empty one both mean the default profile, and
 * folding them together is the reading, not a loss.
 */
function optionId(option: { kind: Account["kind"]; configDir?: string }): string {
  return `${option.kind}/${option.configDir ?? ""}`
}

/** The pair a project stores, in the same spelling `optionId` produces. */
function storedId(project: { account: Account; configDir?: string }): string {
  return optionId({ kind: project.account.kind, ...(project.configDir === undefined ? {} : { configDir: project.configDir }) })
}

/**
 * The one option a project runs as, or `null` when the record cannot say.
 *
 * `null` has two causes and they are not distinguished here because the
 * surface treats them alike: no option matches the stored pair, or more than
 * one does. Either way nothing may be drawn as checked - a checked card is a
 * claim about where the money goes, and the cheap direction is to check
 * nothing and say so.
 */
function storedOption(
  project: { account: Account; configDir?: string },
  accounts: readonly AccountOption[],
): AccountOption | null {
  const want = storedId(project)
  const hits = accounts.filter((option) => optionId(option) === want)
  return hits.length === 1 ? (hits[0] ?? null) : null
}

/** Whether the stored word names more than one of the options on offer. */
function profileAmbiguous(
  project: { account: Account; configDir?: string },
  accounts: readonly AccountOption[],
): boolean {
  if (storedOption(project, accounts) !== null) return false
  return accounts.filter((option) => option.kind === project.account.kind).length > 1
}

/** The repo's own directory name, which is what the design shows. */
function repoName(path: string): string {
  const segments = path.split("/").filter((segment) => segment !== "")
  return segments.at(-1) ?? path
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function taskWord(n: number): string {
  return `${n} ${n === 1 ? "task" : "tasks"}`
}

/** `4100` -> `4.1s`. Absent prints nothing; this is not `formatDuration`'s job
 *  because a test run is seconds and the rail's rounding hides them. */
function seconds(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined
  return `${(ms / 1000).toFixed(1)}s`
}

const TOAST_MS = 5000

/* -------------------------------------------------------------------------- */
/* The shared switch                                                          */
/* -------------------------------------------------------------------------- */

interface Toast {
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

interface SwitchController {
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
function useAccountSwitch(
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

/* -------------------------------------------------------------------------- */
/* The usage ring                                                             */
/* -------------------------------------------------------------------------- */

const RING_LOOK: Record<AccountKind, { track: string; arc: string; ink: string }> = {
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
function UsageRing({
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

/** `41% · resets 18:40`, or just the half that is known. */
function usageLine(option: AccountOption): string {
  const reset = formatResetTime(option.window?.resetsAtSec)
  const used = percentLabel(option.window?.utilization)
  return reset === undefined ? used : `${used} · resets ${reset}`
}

/** `~/.claude · resets 18:40`, the cards' subtitle. */
function cardSubtitle(option: AccountOption): string {
  const reset = formatResetTime(option.window?.resetsAtSec)
  const parts = [option.configDir, reset === undefined ? undefined : `resets ${reset}`].filter(
    (p): p is string => p !== undefined && p !== "",
  )
  return parts.join(" · ")
}

/* -------------------------------------------------------------------------- */
/* Icons, as the artboard draws them                                          */
/* -------------------------------------------------------------------------- */

const LINE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const

function KindIcon({ kind, size }: { kind: Account["kind"]; size: number }): ReactElement {
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

function Check({ size, width = 2.6 }: { size: number; width?: number }): ReactElement {
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

function Cross({ size }: { size: number }): ReactElement {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="ic" style={{ width: size, height: size }} {...LINE}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

function Plus({ size }: { size: number }): ReactElement {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="ic" style={{ width: size, height: size }} {...LINE}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  )
}

function FileIcon({ size, color }: { size: number; color: string }): ReactElement {
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

function FolderIcon({ size }: { size: number }): ReactElement {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="ic" style={{ width: size, height: size }} {...LINE}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  )
}

/* -------------------------------------------------------------------------- */
/* Shared styles, verbatim from the artboard                                  */
/* -------------------------------------------------------------------------- */

const SECTION: CSSProperties = {
  padding: "24px clamp(20px,4vw,40px)",
  borderBottom: "1px solid #EEEEF1",
}

const H2: CSSProperties = { margin: 0, fontSize: 16, fontWeight: 650 }

const BLURB: CSSProperties = {
  margin: "4px 0 12px",
  fontSize: 13.5,
  lineHeight: 1.5,
  color: "#4A4E59",
}

const PILL_DARK =
  "cta inline-flex items-center justify-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo"

const PILL_GHOST =
  "ghost inline-flex items-center justify-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo"

const CONFIRM_DARK: CSSProperties = {
  height: 42,
  padding: "0 16px",
  borderRadius: 999,
  border: 0,
  background: "#111216",
  color: "#fff",
  fontSize: 13.5,
  fontWeight: 620,
}

const CONFIRM_GHOST: CSSProperties = {
  height: 42,
  padding: "0 16px",
  borderRadius: 999,
  border: "1px solid #D9D9DF",
  background: "#fff",
  fontSize: 13.5,
  fontWeight: 560,
  color: "#1E2026",
}

/** What the confirmation says, in one place, because both entry points say it. */
function confirmProse(name: string, target: AccountOption, stored: Account["kind"]): { heading: string; body: ReactNode } {
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
function SwitchToast({
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

/* -------------------------------------------------------------------------- */
/* AccountSwitch: the chip and its popover                                    */
/* -------------------------------------------------------------------------- */

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusablesIn(root: HTMLElement | null): HTMLElement[] {
  if (root === null) return []
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)]
}

/**
 * The artboard's chip, which opens a popover rather than a settings dialog.
 *
 * Exported separately because the chip lives in the tree, beside the repo name,
 * and `src/ui/Tree.tsx` draws its own static `AccountChip` with no handler.
 * The shell mounts this where that chip sits; see the task report for the slot
 * `Tree.tsx` needs.
 *
 * Anchored to the chip (`top: 100% + 8px; right: 0`) rather than to the aside's
 * full width as the artboard's absolute coordinates do, so it is mountable
 * anywhere. `.pop`'s transform origin is already top right, which is what that
 * anchoring wants.
 */
export function AccountSwitch({
  project,
  accounts,
  onSwitchAccount,
  onAddAccount,
  className,
}: AccountSwitchProps): ReactElement {
  const reduced = usePrefersReducedMotion()
  const animate = !reduced
  const name = repoName(project.path)
  const stored = project.account.kind
  const key = storedId(project)
  /* `null` when no option answers to the stored pair, or when more than one
     does. Nothing is drawn as checked in either case. */
  const checkedKey = storedOption(project, accounts) === null ? null : key

  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [acctName, setAcctName] = useState("")
  const [acctDir, setAcctDir] = useState("")
  const [addError, setAddError] = useState<string | null>(null)

  const chipRef = useRef<HTMLButtonElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)

  const close = useCallback(() => {
    setOpen(false)
    setAdding(false)
    setAddError(null)
    chipRef.current?.focus()
  }, [])

  const confirmRef = useRef<HTMLButtonElement | null>(null)

  const switcher = useAccountSwitch(stored, key, accounts, onSwitchAccount, () => {
    setOpen(false)
    setAdding(false)
    /* The button that was focused is about to unmount. Without this, focus
       falls to `<body>` and a keyboard user is dropped out of the app. */
    chipRef.current?.focus()
  })

  /* Focus follows what the popover is showing. On open it lands on the
     account the project already runs as, rather than the top of an unlabelled
     list; when the list becomes a confirmation it moves to that dialog; and
     when Cancel brings the list back it returns, instead of being left on a
     button that no longer exists. */
  useEffect(() => {
    if (!open) return
    if (switcher.pending !== null) {
      confirmRef.current?.focus()
      return
    }
    const rows = [...(popRef.current?.querySelectorAll<HTMLElement>("[data-opt]") ?? [])]
    const current = rows.find((r) => r.getAttribute("data-opt") === stored)
    ;(current ?? rows[0])?.focus()
  }, [open, stored, switcher.pending])

  const label = project.account.label ?? (stored === "unknown" ? "account unknown" : stored)
  const chipLook: CSSProperties =
    stored === "personal"
      ? { background: "#E0F2FE", color: "#075985" }
      : stored === "work"
        ? { background: "#26272D", color: "#F4F4F6" }
        : { background: "#F1F1F4", color: "#4A4E59", boxShadow: "inset 0 0 0 1px #E2E2E7" }

  const target = switcher.pending

  const onPopKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault()
      close()
      return
    }
    const keys = ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"]
    if (!keys.includes(event.key)) return
    const rows = [...(popRef.current?.querySelectorAll<HTMLElement>("[data-opt]") ?? [])]
    if (rows.length === 0) return
    const at = rows.indexOf(document.activeElement as HTMLElement)
    if (at === -1) return
    event.preventDefault()
    /* Focus only. A radiogroup that selected on arrow would fire a
       confirmation from a keystroke meant to look around. */
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? rows.length - 1
          : event.key === "ArrowDown" || event.key === "ArrowRight"
            ? (at + 1) % rows.length
            : (at - 1 + rows.length) % rows.length
    rows[next]?.focus()
  }

  const submitAccount = (): void => {
    const trimmedName = acctName.trim()
    const trimmedDir = acctDir.trim()
    if (trimmedName === "" || trimmedDir === "") {
      setAddError("A name and a Claude config folder are both required.")
      return
    }
    setAddError(null)
    void (async () => {
      try {
        await onAddAccount?.({ label: trimmedName, configDir: trimmedDir })
        setAcctName("")
        setAcctDir("")
        setAdding(false)
      } catch (cause) {
        setAddError(messageOf(cause))
      }
    })()
  }

  /* The pair, so a list with two of a word does not hand the roving tab index
     to whichever of them happens to come first. */
  const checkedIndex = accounts.findIndex((a) => optionId(a) === checkedKey)

  return (
    <span className={`kr${className === undefined ? "" : ` ${className}`}`} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        data-account-chip
        ref={chipRef}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Change the Claude account for ${name}`}
        onClick={() => {
          if (open) {
            setOpen(false)
            setAdding(false)
            switcher.cancel()
          } else {
            setOpen(true)
          }
        }}
        className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          height: 28,
          padding: "0 7px 0 6px",
          border: 0,
          borderRadius: 7,
          fontSize: 11.5,
          fontWeight: 550,
          lineHeight: "normal",
          whiteSpace: "nowrap",
          ...chipLook,
          ...(open ? { boxShadow: "0 0 0 2px #fff,0 0 0 4px #5B5BD6" } : {}),
        }}
      >
        <KindIcon kind={stored} size={12} />
        {label}
        <svg aria-hidden="true" viewBox="0 0 24 24" className="ic" style={{ width: 11, height: 11 }} {...LINE}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          data-account-popover
          ref={popRef}
          role="dialog"
          aria-label={`Claude account for ${name}`}
          onKeyDown={onPopKeyDown}
          className={animate ? "pop" : undefined}
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            width: 268,
            zIndex: 20,
            background: "#fff",
            border: "1px solid #E2E2E7",
            borderRadius: 18,
            boxShadow: "0 2px 4px rgba(17,18,22,.04),0 24px 60px -18px rgba(17,18,22,.35)",
            padding: 8,
            boxSizing: "border-box",
            textAlign: "left",
            lineHeight: "normal",
          }}
        >
          {target === null ? (
            <>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "8px 8px 6px 10px",
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 620 }}>{name} runs as</span>
                <button
                  type="button"
                  aria-label="Close"
                  onClick={close}
                  className={`${PILL_GHOST} rounded-[8px]`}
                  style={{
                    width: 30,
                    height: 30,
                    border: 0,
                    background: "transparent",
                    color: "#5F6370",
                  }}
                >
                  <Cross size={14} />
                </button>
              </div>

              <div role="radiogroup" aria-label="Accounts" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {accounts.map((option, index) => {
                  const checked = checkedKey !== null && optionId(option) === checkedKey
                  return (
                    <button
                      key={optionId(option)}
                      type="button"
                      role="radio"
                      data-opt={option.kind}
                      data-opt-key={optionId(option)}
                      aria-checked={checked}
                      tabIndex={checked || (checkedIndex === -1 && index === 0) ? 0 : -1}
                      onClick={() => switcher.ask(option)}
                      className="opt focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo"
                      style={{
                        display: "grid",
                        gridTemplateColumns: "32px minmax(0,1fr) 18px",
                        gap: 10,
                        alignItems: "center",
                        minHeight: 52,
                        padding: "6px 10px",
                        border: 0,
                        borderRadius: 12,
                        background: "transparent",
                        textAlign: "left",
                        color: "#111216",
                      }}
                    >
                      <UsageRing option={option} size={32} stroke={8} animate={animate} showLabel={false} />
                      <span style={{ display: "flex", flexDirection: "column" }}>
                        <span style={{ fontSize: 14, fontWeight: 620, color: RING_LOOK[option.kind].ink }}>
                          {option.label}
                        </span>
                        <span className="m" style={{ fontSize: 11.5, color: "#5F6370" }}>
                          {usageLine(option)}
                        </span>
                      </span>
                      {checked ? <Check size={16} /> : <span />}
                    </button>
                  )
                })}
              </div>

              {stored === "unknown" && (
                <p style={{ margin: "6px 10px 2px", fontSize: 11.5, lineHeight: 1.45, color: "#5F6370" }}>
                  Nobody has said which account this project runs as.
                </p>
              )}

              {onAddAccount !== undefined && (
                <>
                  <div style={{ height: 1, background: "#EEEEF1", margin: "6px 4px" }} />
                  {adding ? (
                    <div
                      className={animate ? "pop" : undefined}
                      style={{ display: "flex", flexDirection: "column", gap: 8, padding: "6px 8px 8px" }}
                    >
                      <label htmlFor="kp-acct-name" style={{ fontSize: 12, fontWeight: 600, color: "#4A4E59" }}>
                        Name
                      </label>
                      <input
                        id="kp-acct-name"
                        value={acctName}
                        onChange={(e) => setAcctName(e.target.value)}
                        placeholder="client-x"
                        /* 40px + a 1px border on each side is the artboard's
                           rendered box; preflight's border-box would eat it. */
                        style={{ ...POP_INPUT, fontSize: 14 }}
                      />
                      <label htmlFor="kp-acct-dir" style={{ fontSize: 12, fontWeight: 600, color: "#4A4E59" }}>
                        Claude config folder
                      </label>
                      <input
                        id="kp-acct-dir"
                        className="m"
                        value={acctDir}
                        onChange={(e) => setAcctDir(e.target.value)}
                        placeholder="/home/you/.claude-client-x"
                        style={{ ...POP_INPUT, fontSize: 13 }}
                      />
                      {addError !== null && (
                        <p role="alert" style={{ margin: 0, fontSize: 12, lineHeight: 1.45, color: "#D92D3A" }}>
                          {addError}
                        </p>
                      )}
                      <button
                        type="button"
                        onClick={submitAccount}
                        className={PILL_DARK}
                        style={{
                          height: 40,
                          borderRadius: 999,
                          border: 0,
                          background: "#111216",
                          color: "#fff",
                          fontSize: 13.5,
                          fontWeight: 600,
                        }}
                      >
                        Add account
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setAdding(true)}
                      className="opt focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        width: "100%",
                        minHeight: 44,
                        padding: "0 12px",
                        border: 0,
                        borderRadius: 12,
                        background: "transparent",
                        color: "#3A3D45",
                        fontSize: 13.5,
                        fontWeight: 550,
                        textAlign: "left",
                      }}
                    >
                      <Plus size={15} />
                      Add an account
                    </button>
                  )}
                </>
              )}
            </>
          ) : (
            <div
              data-confirm="pop"
              role="alertdialog"
              aria-label="Confirm account switch"
              className={animate ? "pop" : undefined}
              style={{ padding: "12px 12px 10px" }}
            >
              <div style={{ fontSize: 16, fontWeight: 650, letterSpacing: "-.01em" }}>
                {confirmProse(name, target, stored).heading}
              </div>
              <p style={{ margin: "8px 0 14px", fontSize: 13.5, lineHeight: 1.55, color: "#3A3D45" }}>
                {confirmProse(name, target, stored).body}
              </p>
              {switcher.error !== null && (
                <p role="alert" style={{ margin: "0 0 12px", fontSize: 13, lineHeight: 1.5, color: "#D92D3A" }}>
                  {switcher.error}
                </p>
              )}
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  ref={confirmRef}
                  onClick={switcher.confirm}
                  disabled={switcher.busy}
                  className={PILL_DARK}
                  style={{ ...CONFIRM_DARK, flex: 1 }}
                >
                  {switcher.busy ? "Switching…" : `Switch to ${target.label}`}
                </button>
                <button type="button" onClick={switcher.cancel} className={PILL_GHOST} style={CONFIRM_GHOST}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {switcher.toast !== null && (
        <SwitchToast
          name={name}
          to={switcher.toast.to.label}
          {...(switcher.toast.to.configDir === undefined ? {} : { profile: switcher.toast.to.configDir })}
          canUndo={switcher.undoTarget !== null}
          animate={animate}
          onUndo={switcher.undo}
          onDismiss={switcher.dismissToast}
        />
      )}
    </span>
  )
}

/** The popover's two inputs. See the note on preflight in the file header. */
const POP_INPUT: CSSProperties = {
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
/* ProjectPanel                                                               */
/* -------------------------------------------------------------------------- */

export function ProjectPanel({
  project,
  accounts,
  onSwitchAccount,
  onSaveTestCmd,
  onClearTestCmd,
  onRemove,
  onRunTest,
  budgetUsd,
  onSaveBudget,
  branch,
  taskFileCandidates,
  onAddTaskFile,
  onStopTracking,
  className,
}: ProjectPanelProps): ReactElement {
  const reduced = usePrefersReducedMotion()
  const animate = !reduced
  const anim = (classes: string): string | undefined => (animate ? classes : undefined)

  const name = repoName(project.path)
  const stored = project.account.kind
  const key = storedId(project)
  /* `null` when no option answers to the stored pair, or when more than one
     does - a checked card is a claim about where the money goes. */
  const checkedKey = storedOption(project, accounts) === null ? null : key
  const ambiguous = profileAmbiguous(project, accounts)
  const headingId = useId()
  const switcher = useAccountSwitch(stored, key, accounts, onSwitchAccount)
  const [removeOpen, setRemoveOpen] = useState(false)
  const removeTrigger = useRef<HTMLButtonElement | null>(null)

  return (
    <main
      data-panel
      /* `kr` for the reduced-motion kill-switch; `leading-[normal]` undoes
         preflight's 1.5, which the artboard does not have. */
      className={`kr leading-[normal]${className === undefined ? "" : ` ${className}`}`}
      data-motion={animate ? "animated" : "static"}
      style={{
        flex: "999 1 560px",
        minWidth: 0,
        minHeight: 0,
        position: "relative",
        overflowX: "hidden",
        overflowY: "auto",
        padding: "24px clamp(16px,3vw,44px) 48px",
        boxSizing: "border-box",
      }}
    >
      {/* Its own absolutely positioned layer: `.dots` carries a `mask-image`,
          and a mask applies to the element's whole rendering, children
          included. On the container it fades the card out. */}
      <div className="dots" aria-hidden="true" style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />

      <div style={{ position: "relative", maxWidth: 820, margin: "0 auto", width: "100%" }}>
        <section
          aria-labelledby={headingId}
          className={anim("bf")}
          style={{
            background: "#fff",
            border: "1px solid #E7E7EB",
            borderRadius: 24,
            boxShadow: "0 1px 2px rgba(17,18,22,.04),0 18px 50px -22px rgba(17,18,22,.2)",
            overflow: "clip",
          }}
        >
          <Header id={headingId} name={name} path={project.path} branch={branch} />

          <AccountSection
            name={name}
            stored={stored}
            checkedKey={checkedKey}
            ambiguous={ambiguous}
            accounts={accounts}
            animate={animate}
            anim={anim}
            switcher={switcher}
          />

          <TestCommandSection
            testCmd={project.testCmd}
            anim={anim}
            animate={animate}
            onSaveTestCmd={onSaveTestCmd}
            {...(onClearTestCmd === undefined ? {} : { onClearTestCmd })}
            {...(onRunTest === undefined ? {} : { onRunTest })}
          />

          <TaskFilesSection
            project={project}
            anim={anim}
            animate={animate}
            {...(taskFileCandidates === undefined ? {} : { taskFileCandidates })}
            {...(onAddTaskFile === undefined ? {} : { onAddTaskFile })}
            {...(onStopTracking === undefined ? {} : { onStopTracking })}
          />

          {budgetUsd !== undefined && onSaveBudget !== undefined && (
            <CeilingSection budgetUsd={budgetUsd} onSaveBudget={onSaveBudget} anim={anim} />
          )}

          <DangerSection name={name} anim={anim} triggerRef={removeTrigger} onAsk={() => setRemoveOpen(true)} />
        </section>
      </div>

      {/* Outside the card, exactly as the artboard places it, and the placement
          is load-bearing rather than tidy. `.bf` ends on `filter: blur(0)` with
          `animation-fill-mode: both`, and a filter other than `none` makes an
          element the containing block for `position: fixed` descendants - so a
          scrim rendered inside the card was laid out against the card and then
          clipped by its `overflow: clip`. Caught by a screenshot; no DOM
          assertion saw it. `test/ui/ProjectPanel.test.tsx` now pins the
          structure that avoids it. */}
      {removeOpen && (
        <RemoveDialog
          name={name}
          animate={animate}
          onRemove={onRemove}
          onClose={() => {
            setRemoveOpen(false)
            removeTrigger.current?.focus()
          }}
        />
      )}

      {switcher.toast !== null && (
        <SwitchToast
          name={name}
          to={switcher.toast.to.label}
          {...(switcher.toast.to.configDir === undefined ? {} : { profile: switcher.toast.to.configDir })}
          canUndo={switcher.undoTarget !== null}
          animate={animate}
          onUndo={switcher.undo}
          onDismiss={switcher.dismissToast}
        />
      )}
    </main>
  )
}

/* -------------------------------------------------------------------------- */

function Header({
  id,
  name,
  path,
  branch,
}: {
  id: string
  name: string
  path: string
  branch: string | undefined
}): ReactElement {
  return (
    <div style={{ padding: "28px clamp(20px,4vw,40px) 22px", borderBottom: "1px solid #EEEEF1" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
        <span
          aria-hidden="true"
          style={{
            width: 40,
            height: 40,
            borderRadius: 12,
            background: "#F1F1F4",
            display: "grid",
            placeItems: "center",
            color: "#3A3D45",
          }}
        >
          <FolderIcon size={20} />
        </span>
        <h1 id={id} style={{ margin: 0, fontSize: 32, lineHeight: 1.1, fontWeight: 650, letterSpacing: "-.03em" }}>
          {name}
        </h1>
        {/* Not a promise about the future: every section here saves on commit,
            and the ones that cannot save are not drawn. */}
        <span
          style={{
            marginLeft: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12.5,
            color: "#0F7A54",
            fontWeight: 560,
          }}
        >
          <Check size={14} />
          Changes save as you go
        </span>
      </div>
      <div
        className="m"
        style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12, fontSize: 12, color: "#4A4E59" }}
      >
        {/* The registered spelling, verbatim: run logs reference it, and
            `updateProject` refuses to edit it for that reason. */}
        <span style={{ padding: "5px 10px", borderRadius: 999, background: "#F4F4F6", overflowWrap: "anywhere" }}>
          {path}
        </span>
        {branch !== undefined && branch !== "" && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "5px 10px",
              borderRadius: 999,
              background: "#F4F4F6",
            }}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="ic" style={{ width: 12, height: 12 }} {...LINE}>
              <line x1="6" x2="6" y1="3" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
            {branch}
          </span>
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

const SELECTED_CARD: CSSProperties = {
  border: "1.5px solid #111216",
  background: "#fff",
  boxShadow: "0 8px 20px -14px rgba(17,18,22,.5)",
}

const OFF_CARD: CSSProperties = { border: "1px solid #E2E2E7", background: "#FCFCFD" }

function AccountSection({
  name,
  stored,
  checkedKey,
  ambiguous,
  accounts,
  animate,
  anim,
  switcher,
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
}): ReactElement {
  const target = switcher.pending
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

/* -------------------------------------------------------------------------- */

interface TestRunState {
  phase: "idle" | "running" | "done"
  /** The command the result belongs to, so a stale answer can be recognised. */
  cmd: string
  result?: TestCommandResult
}

/** What a result reads as. Only a zero code may read as a pass. */
function readOutcome(result: TestCommandResult): { reads: string; outcome: "pass" | "fail" | "unknown" } {
  if (typeof result.exitCode === "number" && Number.isFinite(result.exitCode)) {
    return { reads: `exit ${result.exitCode}`, outcome: result.exitCode === 0 ? "pass" : "fail" }
  }
  if (result.timedOut === true) return { reads: "timed out", outcome: "fail" }
  if (typeof result.signal === "string" && result.signal !== "") {
    return { reads: `killed by ${result.signal}`, outcome: "fail" }
  }
  /* No code and no reason. "unknown" rather than "fail": the command may have
     run fine and the server may simply not have said, and inventing either
     verdict is the thing exit codes exist to prevent. */
  return { reads: "no exit code", outcome: "unknown" }
}

const BADGE_LOOK: Record<"pass" | "fail" | "unknown", CSSProperties> = {
  pass: { background: "#0F8A5F", color: "#fff" },
  fail: { background: "#D92D3A", color: "#fff" },
  unknown: { background: "#F1F1F4", color: "#3A3D45" },
}

/**
 * Two states behind one heading, and which one shows is read through
 * `commandOf` rather than `testCmd === null`.
 *
 * With a command: the field, and a blurb promising kantan reads an exit code.
 * Without one: no field at all, and the sentence that says so. An empty field
 * behind a `$` is the defect this avoids - it reads as a command that failed
 * to load, under a promise that is false for this project.
 *
 * The transitions between them are deliberate in both directions:
 *
 * - **Blank is refused when a command exists.** `sh -c ""` exits 0, so saving
 *   one would tick every task as tested with nothing run. The message names
 *   the opt-out instead, and only when something can take it.
 * - **Blank is not an error when there is none.** Nothing was required, the
 *   human changed nothing, and the field simply closes again.
 */
function TestCommandSection({
  testCmd,
  anim,
  animate,
  onSaveTestCmd,
  onClearTestCmd,
  onRunTest,
}: {
  testCmd: string | null
  anim: (classes: string) => string | undefined
  animate: boolean
  onSaveTestCmd: (cmd: string) => void | Promise<void>
  onClearTestCmd?: () => void | Promise<void>
  onRunTest?: (cmd: string) => Promise<TestCommandResult>
}): ReactElement {
  const stored = commandOf(testCmd)
  const [draft, setDraft] = useState(stored ?? "")
  const [saved, setSaved] = useState(stored ?? "")
  const [error, setError] = useState<string | null>(null)
  const [run, setRun] = useState<TestRunState>({ phase: "idle", cmd: stored ?? "" })
  /** The human asked for a field on a project that has no command yet. */
  const [opening, setOpening] = useState(false)
  /**
   * The opt-out this panel took and the handler accepted, before the props it
   * came from have been refetched.
   *
   * Local because the handler's success is the event: `project.testCmd` is a
   * copy of the store fetched by whatever mounted this, and waiting for it to
   * come back `null` would leave the panel printing a command the store no
   * longer has. Cleared by the effect below the moment the props do change.
   */
  const [optedOut, setOptedOut] = useState(false)
  const [clearing, setClearing] = useState(false)
  /** Monotonic, so an answer from an abandoned request can be dropped. */
  const ticket = useRef(0)
  const field = useRef<HTMLInputElement>(null)

  /* The stored command is the truth; a reload that changes it wins over a
     draft nobody committed, over a field nobody filled, and over an opt-out
     this panel is still holding optimistically. */
  useEffect(() => {
    const fresh = commandOf(testCmd)
    setDraft(fresh ?? "")
    setSaved(fresh ?? "")
    setOpening(false)
    setOptedOut(false)
    setError(null)
    ticket.current += 1
    setRun({ phase: "idle", cmd: fresh ?? "" })
  }, [testCmd])

  useEffect(() => {
    if (opening) field.current?.focus()
  }, [opening])

  /** What this project has as far as this panel can tell right now. */
  const command = optedOut ? null : stored
  /** Whether the field is on screen: there is a command, or one is being typed. */
  const open = command !== null || opening

  const blankRefusal = (): string =>
    onClearTestCmd === undefined
      ? 'A blank command is not an opt-out. `sh -c ""` exits 0, so kantan would tick every task as tested with nothing run.'
      : 'A blank command is not an opt-out. `sh -c ""` exits 0, so kantan would tick every task as tested with nothing run. Use "Remove the test command" to say this project has no suite.'

  const commit = (): void => {
    const trimmed = draft.trim()
    if (trimmed === "") {
      /* Nothing was required and nothing changed, so there is nothing to
         refuse: the field closes and the section says what it said before. */
      if (command === null) {
        setOpening(false)
        setDraft("")
        setError(null)
        return
      }
      setError(blankRefusal())
      return
    }
    setError(null)
    if (trimmed === saved) return
    setSaved(trimmed)
    void (async () => {
      try {
        await onSaveTestCmd(trimmed)
      } catch (cause) {
        setError(messageOf(cause))
      }
    })()
  }

  const clear = (): void => {
    if (onClearTestCmd === undefined || clearing) return
    setError(null)
    setClearing(true)
    void (async () => {
      try {
        await onClearTestCmd()
        /* Only now. A refused PATCH that had already blanked the field would
           leave the panel claiming this project has no suite while the store
           still has a command - the mirror of claiming a verification nobody
           observed. */
        setOptedOut(true)
        setOpening(false)
        setDraft("")
        setSaved("")
        ticket.current += 1
        setRun({ phase: "idle", cmd: "" })
      } catch (cause) {
        setError(messageOf(cause))
      } finally {
        setClearing(false)
      }
    })()
  }

  const go = (): void => {
    if (onRunTest === undefined) return
    const cmd = draft.trim()
    if (cmd === "") return
    const mine = ++ticket.current
    setError(null)
    setRun({ phase: "running", cmd })
    void (async () => {
      try {
        const result = await onRunTest(cmd)
        /* Dropped, not shown: this answer is about a command the field no
           longer holds, and a result attributed to the wrong command is worse
           than no result. */
        if (mine !== ticket.current) return
        setRun({ phase: "done", cmd, result })
      } catch (cause) {
        if (mine !== ticket.current) return
        setRun({ phase: "idle", cmd })
        setError(messageOf(cause))
      }
    })()
  }

  const read = run.phase === "done" && run.result !== undefined ? readOutcome(run.result) : null
  const took = seconds(run.result?.durationMs)

  return (
    <div style={SECTION} className={anim("bf d2")}>
      {/* A `for` that names an input which is not on screen points at nothing,
          so the heading is only a label while the field exists. */}
      {open ? (
        <label htmlFor="kp-testcmd" style={{ display: "block", ...H2 }}>
          Test command
        </label>
      ) : (
        <h3 style={H2}>Test command</h3>
      )}
      <p style={BLURB}>
        {open ? (
          <>kantan runs this itself and trusts only its exit code. It never takes the agent&rsquo;s word for it.</>
        ) : (
          <>
            This project has none, so a fresh agent verifies its own work and the run records that nothing
            outside it checks the result.
          </>
        )}
      </p>

      {!open && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          <span
            data-test-cmd
            className="m"
            style={{
              flex: "1 1 260px",
              display: "flex",
              alignItems: "center",
              minHeight: 46,
              padding: "0 14px",
              borderRadius: 12,
              background: "#F4F4F6",
              fontSize: 13.5,
              color: "#5F6370",
              boxSizing: "border-box",
            }}
          >
            {SELF_CHECKED}
          </span>
          <button
            type="button"
            onClick={() => {
              setOpening(true)
              setError(null)
            }}
            className={PILL_GHOST}
            style={{
              height: 46,
              padding: "0 16px",
              borderRadius: 999,
              border: "1px solid #D9D9DF",
              background: "#fff",
              fontSize: 14,
              fontWeight: 560,
              color: "#1E2026",
            }}
          >
            Set a test command
          </button>
        </div>
      )}

      {open && (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <span
          className="fld"
          style={{
            flex: "1 1 260px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            minHeight: 46,
            padding: "0 14px",
            borderRadius: 12,
            border: "1px solid #E2E2E7",
            background: "#fff",
            boxSizing: "border-box",
          }}
        >
          <span className="m" style={{ color: "#8A8F9C" }}>
            $
          </span>
          <input
            id="kp-testcmd"
            ref={field}
            className="m"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              /* A result is about a command string. Editing it makes the
                 result meaningless, so it goes rather than lingering beside a
                 command it never ran. */
              ticket.current += 1
              setRun({ phase: "idle", cmd: e.target.value })
              setError(null)
            }}
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
              color: "#111216",
            }}
          />
        </span>
        {onRunTest !== undefined && draft.trim() !== "" && (
          <button
            type="button"
            onClick={go}
            disabled={run.phase === "running"}
            className={PILL_GHOST}
            style={{
              height: 46,
              padding: "0 16px 0 14px",
              borderRadius: 999,
              border: "1px solid #D9D9DF",
              background: "#fff",
              fontSize: 14,
              fontWeight: 560,
              color: "#1E2026",
              gap: 8,
            }}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" style={{ width: 12, height: 12, fill: "#1E2026" }}>
              <polygon points="6 3 20 12 6 21 6 3" />
            </svg>
            Run it now
          </button>
        )}
      </div>
      )}

      {/* The consequence sits beside the control rather than arriving after
          the fact, because the opt-out changes what a green run means: from
          here on nothing outside the agent checks it. */}
      {command !== null && onClearTestCmd !== undefined && (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "6px 12px", marginTop: 12 }}>
          <button
            type="button"
            onClick={clear}
            disabled={clearing}
            style={{
              border: 0,
              padding: 0,
              background: "none",
              font: "inherit",
              fontSize: 13.5,
              fontWeight: 560,
              color: "#5B5BD6",
              cursor: clearing ? "default" : "pointer",
              textDecoration: "underline",
              textUnderlineOffset: 3,
            }}
          >
            Remove the test command
          </button>
          <span style={{ fontSize: 13, lineHeight: 1.5, color: "#5F6370", maxWidth: "58ch" }}>
            Then a fresh agent verifies its own work, and every run records that it was never tested.
          </span>
        </div>
      )}

      {run.phase === "running" && (
        <div
          data-test-status
          role="status"
          className={anim("pop")}
          style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, fontSize: 13.5, color: "#20205E" }}
        >
          <svg
            className={animate ? "spin" : undefined}
            aria-hidden="true"
            viewBox="0 0 24 24"
            style={{ width: 15, height: 15 }}
          >
            <circle cx="12" cy="12" r="9" fill="none" stroke="#DCDCF6" strokeWidth="3" />
            <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="#5B5BD6" strokeWidth="3" strokeLinecap="round" />
          </svg>
          Running{" "}
          <span className="m">{run.cmd}</span>…
        </div>
      )}

      {read !== null && (
        <div
          data-test-status
          role="status"
          className={anim("pop")}
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "8px 10px",
            marginTop: 10,
            fontSize: 13.5,
            color: "#2A2C33",
          }}
        >
          <span
            data-exit-badge
            data-outcome={read.outcome}
            className="m"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "3px 9px",
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 600,
              ...BADGE_LOOK[read.outcome],
            }}
          >
            {/* The artboard's shield-check, and **only** on a zero code.
                `canvas.json` names the chip as "Badge + ShieldCheck", but
                `DESIGN.md` forbids a tick standing in for a code - so a glyph
                that reads "verified" beside `exit 1` would be the exact defect
                the exit code exists to prevent. The number is the content; the
                shield only ever agrees with it. */}
            {read.outcome === "pass" && (
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className="ic"
                style={{ width: 12, height: 12 }}
                {...LINE}
              >
                <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
                <path d="m9 12 2 2 4-4" />
              </svg>
            )}
            {read.reads}
          </span>
          {(run.result?.summary !== undefined || took !== undefined) && (
            <span>
              {[run.result?.summary, took].filter((p): p is string => p !== undefined && p !== "").join(" · ")}
            </span>
          )}
        </div>
      )}

      {error !== null && (
        <p
          role="alert"
          style={{ margin: "10px 0 0", fontSize: 13, lineHeight: 1.5, color: "#D92D3A", maxWidth: "68ch" }}
        >
          {error}
        </p>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function TaskFilesSection({
  project,
  anim,
  animate,
  taskFileCandidates,
  onAddTaskFile,
  onStopTracking,
}: {
  project: TreeProject
  anim: (classes: string) => string | undefined
  animate: boolean
  taskFileCandidates?: readonly TaskFileCandidate[]
  onAddTaskFile?: (path: string) => void | Promise<void>
  onStopTracking?: (path: string) => void | Promise<void>
}): ReactElement {
  const [query, setQuery] = useState("")
  const [error, setError] = useState<string | null>(null)
  const listId = useId()
  const tracked = useMemo(() => new Set(project.features.map((f) => f.path)), [project.features])

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const all = taskFileCandidates ?? []
    return needle === "" ? all : all.filter((c) => c.path.toLowerCase().includes(needle))
  }, [query, taskFileCandidates])

  const add = (path: string): void => {
    if (onAddTaskFile === undefined) return
    const trimmed = path.trim()
    if (trimmed === "" || tracked.has(trimmed)) return
    setError(null)
    setQuery("")
    void (async () => {
      try {
        await onAddTaskFile(trimmed)
      } catch (cause) {
        setError(messageOf(cause))
      }
    })()
  }

  const stop = (path: string): void => {
    if (onStopTracking === undefined) return
    setError(null)
    void (async () => {
      try {
        await onStopTracking(path)
      } catch (cause) {
        setError(messageOf(cause))
      }
    })()
  }

  return (
    <div style={SECTION} className={anim("bf d3")}>
      <h2 style={H2}>Task files</h2>
      <p style={BLURB}>
        Markdown files kantan reads tasks from. Removing one here leaves the file in your repo alone.
      </p>

      {project.features.length === 0 ? (
        <p
          style={{
            margin: 0,
            padding: "14px 16px",
            borderRadius: 14,
            border: "1px dashed #E2E2E7",
            fontSize: 13.5,
            lineHeight: 1.55,
            color: "#5F6370",
          }}
        >
          No task file yet. kantan reads tasks from <span className="m">docs/features/*.md</span>, one at a time.
        </p>
      ) : (
        <ul
          data-files
          style={{ listStyle: "none", margin: 0, padding: 0, border: "1px solid #EEEEF1", borderRadius: 14, overflow: "hidden" }}
        >
          {project.features.map((feature, index) => (
            <li
              key={feature.path}
              style={{
                display: "grid",
                gridTemplateColumns: onStopTracking === undefined ? "18px minmax(0,1fr) auto" : "18px minmax(0,1fr) auto 40px",
                gap: 10,
                alignItems: "center",
                /* 50px plus the 1px rule the artboard adds from the second row
                   on: preflight's border-box would take it out of the row. */
                minHeight: index === 0 ? 50 : 51,
                padding: "0 6px 0 14px",
                boxSizing: "border-box",
                ...(index === 0 ? {} : { borderTop: "1px solid #F0F0F3" }),
              }}
            >
              <FileIcon size={15} color="#5F6370" />
              <span className="m" style={{ fontSize: 13, overflowWrap: "anywhere" }}>
                {feature.path}
              </span>
              <span style={{ fontSize: 12.5, color: "#5F6370" }}>{taskWord(feature.tasks.length)}</span>
              {onStopTracking !== undefined && (
                <button
                  type="button"
                  aria-label={`Stop tracking ${feature.path}`}
                  onClick={() => stop(feature.path)}
                  className={`${PILL_GHOST} rounded-[10px]`}
                  style={{ width: 36, height: 36, border: 0, background: "transparent", color: "#5F6370" }}
                >
                  <Cross size={15} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {onAddTaskFile !== undefined && (
        <div
          style={{
            marginTop: 10,
            border: "1px solid #E2E2E7",
            borderRadius: 14,
            background: "#fff",
            overflow: "hidden",
          }}
        >
          <label
            htmlFor="kp-newfile"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              /* 46px plus the 1px rule below it. See the file header. */
              minHeight: 47,
              padding: "0 14px",
              borderBottom: "1px solid #F0F0F3",
              boxSizing: "border-box",
            }}
          >
            <Plus size={15} />
            <input
              id="kp-newfile"
              className="m"
              role="combobox"
              aria-expanded={shown.length > 0}
              aria-controls={listId}
              aria-autocomplete="list"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return
                e.preventDefault()
                add(query)
              }}
              placeholder="Add a task file: type a path or pick one below"
              style={{
                border: 0,
                outline: "none",
                background: "transparent",
                width: "100%",
                fontSize: 13,
                color: "#111216",
              }}
            />
          </label>
          <div id={listId} role="listbox" aria-label="Task files found in the repo" style={{ padding: 6 }}>
            {(taskFileCandidates ?? []).length > 0 && (
              <div
                style={{
                  padding: "4px 8px 6px",
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: ".06em",
                  textTransform: "uppercase",
                  color: "#6B7080",
                }}
              >
                Found in the repo
              </div>
            )}
            {shown.map((candidate) => {
              const already = tracked.has(candidate.path)
              const hint = already
                ? "added"
                : candidate.taskCount === undefined
                  ? "not counted"
                  : candidate.taskCount === 0
                    ? "no tasks found"
                    : `${taskWord(candidate.taskCount)} found`
              return (
                <button
                  key={candidate.path}
                  type="button"
                  role="option"
                  aria-selected={already}
                  data-candidate={candidate.path}
                  disabled={already}
                  onClick={() => add(candidate.path)}
                  className={`opt ${animate ? "pop " : ""}focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo`}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0,1fr) auto",
                    gap: 10,
                    alignItems: "center",
                    width: "100%",
                    minHeight: 42,
                    padding: "0 10px",
                    border: 0,
                    borderRadius: 10,
                    background: "transparent",
                    textAlign: "left",
                    color: already ? "#5F6370" : "#111216",
                  }}
                >
                  <span className="m" style={{ fontSize: 13 }}>
                    {candidate.path}
                  </span>
                  <span style={{ fontSize: 12.5, color: "#5F6370" }}>{hint}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {error !== null && (
        <p role="alert" style={{ margin: "10px 0 0", fontSize: 13, lineHeight: 1.5, color: "#D92D3A" }}>
          {error}
        </p>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function CeilingSection({
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
function DangerSection({
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
function RemoveDialog({
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
