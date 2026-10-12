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

import type { AccountWindow } from "./Sidebar.tsx"
import { RING_CIRCUMFERENCE, formatResetTime, percentLabel, ringOffset } from "./format.ts"
import { usePrefersReducedMotion } from "./reducedmotion.ts"
import type { Account, AdvancedSettings, Effort, PermissionMode, ProjectSummary, TreeProject } from "./Tree.tsx"
import { commandOf, SELF_CHECKED } from "./testcmd.ts"
import {
  BLURB,
  CONFIRM_DARK,
  CONFIRM_GHOST,
  Check,
  Cross,
  FOCUSABLE,
  FileIcon,
  FolderIcon,
  H2,
  KindIcon,
  LINE,
  OFF_CARD,
  PILL_DARK,
  PILL_GHOST,
  POP_INPUT,
  Plus,
  RING_LOOK,
  SECTION,
  SELECTED_CARD,
  UsageRing,
  cardSubtitle,
  focusablesIn,
  messageOf,
  repoName,
  seconds,
  taskWord,
  usageLine,
} from "./panel/chrome.tsx"
import { SummarySection } from "./panel/summary.tsx"
import { TestCommandSection } from "./panel/TestCommandSection.tsx"
import { TaskFilesSection } from "./panel/TaskFilesSection.tsx"
import { CeilingSection } from "./panel/CeilingSection.tsx"
import { AdvancedSection } from "./panel/AdvancedSection.tsx"
import { DangerSection, RemoveDialog } from "./panel/DangerSection.tsx"
import { accountOptionsFor, optionId, profileAmbiguous, storedId, storedOption } from "./panel/accounts.ts"
import { SwitchToast, confirmProse, useAccountSwitch } from "./panel/switch.tsx"
import { AccountSection } from "./panel/AccountSection.tsx"
import type { SwitchController } from "./panel/switch.tsx"

/* Re-exported: `src/ui/App.tsx` and the suite both reach for this here, and it
   is about accounts rather than about this component - but moving it was a
   refactor, not a rename, so the old path keeps working. */
export { accountOptionsFor }

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
  /**
   * Points this project at a Claude profile folder it has not used before.
   *
   * Absent hides the control. It exists because the options are **derived from
   * what is registered** - the distinct `(kind, configDir)` pairs across the
   * tree, plus the default profile - so a machine with one project on one
   * profile offers exactly one card, and there was no way to reach a second
   * account from anywhere in the app. `AccountSwitch` has carried this handler
   * since it was written and is mounted nowhere, so the form lived in a
   * component nothing rendered.
   *
   * It is an *add plus a switch*, not a registry: kantan keeps no list of
   * accounts, and `PATCH /api/projects` with `{ account, configDir }` is the
   * whole operation. Naming it after what the human wants - another account -
   * rather than after the field it writes.
   */
  onAddAccount?: (account: { kind: AccountKind; label: string; configDir: string }) => void | Promise<void>
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
  /** Runs the command now. Absent hides "Run it now"; `App.tsx` passes it
   * through `POST /api/test`, so it is only absent in a test or a story. */
  onRunTest?: (cmd: string) => Promise<TestCommandResult>
  /** The stored default ceiling. Absent hides the section. */
  budgetUsd?: number
  onSaveBudget?: (usd: number) => void | Promise<void>
  /**
   * Saves one advanced setting. Absent hides the whole section.
   *
   * One key at a time, like every other handler here, because the section is
   * six independent settings rather than a form: committing a model should not
   * also rewrite an effort the human was still thinking about. `PATCH
   * /api/projects` is a partial update for exactly this reason.
   */
  onSaveAdvanced?: (change: Partial<AdvancedSettings>) => void | Promise<void>
  /**
   * What this project amounts to, from `projectSummary` in `src/ui/Tree.tsx`.
   *
   * Absent hides the section, like every other optional one here. Passed in
   * rather than computed, because the costs live in the tree's separate runs
   * map and only the shell holds both halves.
   */
  summary?: ProjectSummary
  /** `main · clean`, already composed. Absent prints nothing. */
  branch?: string
  /** Files the repo offers. Absent hides the "Found in the repo" group. */
  taskFileCandidates?: readonly TaskFileCandidate[]
  /** Absent hides the combobox entirely. */
  onAddTaskFile?: (path: string) => void | Promise<void>
  /** Absent hides every row's dismiss button. */
  onStopTracking?: (path: string) => void | Promise<void>
  /**
   * Starts a **new** task file. Absent hides the option.
   *
   * The artboard's own placement: the last option under "Found in the repo" in
   * the combobox (`Project.dc.html`, "Create a new task file"), not a button of
   * its own. It belongs there because it answers the same question as the rows
   * above it - *where do the tasks come from* - and because the moment someone
   * looks down that list and sees nothing that fits is exactly the moment they
   * need it.
   */
  onNewTaskFile?: () => void
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

/* -------------------------------------------------------------------------- */
/* ProjectPanel                                                               */
/* -------------------------------------------------------------------------- */

export function ProjectPanel({
  project,
  accounts,
  onSwitchAccount,
  onAddAccount,
  onSaveTestCmd,
  onClearTestCmd,
  summary,
  onRemove,
  onRunTest,
  budgetUsd,
  onSaveBudget,
  onSaveAdvanced,
  branch,
  taskFileCandidates,
  onAddTaskFile,
  onStopTracking,
  onNewTaskFile,
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

          {summary !== undefined && <SummarySection summary={summary} testCmd={project.testCmd} anim={anim} />}

          <AccountSection
            name={name}
            stored={stored}
            checkedKey={checkedKey}
            ambiguous={ambiguous}
            {...(onAddAccount === undefined ? {} : { onAddAccount })}
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
            {...(onNewTaskFile === undefined ? {} : { onNewTaskFile })}
          />

          {budgetUsd !== undefined && onSaveBudget !== undefined && (
            <CeilingSection budgetUsd={budgetUsd} onSaveBudget={onSaveBudget} anim={anim} />
          )}

          {/* Both or neither, for the reason the ceiling's own pair gives: a
              form with nothing to save it is a control that silently does
              nothing, and a handler with nothing to read is a form of blanks
              that cannot tell "unset" from "this wire is older than this
              page". */}
          {project.advanced !== undefined && onSaveAdvanced !== undefined && (
            <AdvancedSection advanced={project.advanced} onSaveAdvanced={onSaveAdvanced} anim={anim} />
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
