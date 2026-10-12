/**
 * Starting and resuming a task: `docs/design/Start.dc.html`, ported.
 *
 * ## What this is
 *
 * The centre column's card for a task that is **not running**: it either has
 * never run (offer to start it), or a run was killed and its log just stops
 * (offer to resume). `docs/design/canvas.json` is explicit that this is a panel
 * and never a modal - *"All of these replace the centre column. No routes, no
 * settings page, and dialogs only for confirmations."*
 *
 * `App.tsx` already draws the centre `<main>`, its `.dots` layer and the
 * breadcrumb, so this file renders the artboard's `<section>` only - the same
 * boundary `Gate` has.
 *
 * ## The three variants are two cards
 *
 * The artboard declares `variant: "open" | "interrupted" | "busy"` and branches
 * on it with nine `<sc-if>`s. Three of those are sidebar rows and belong to
 * `Tree.tsx`; the six here are `showOpen`, the busy alert, `canStart`,
 * `blocked`, `started` and `isInt`.
 *
 * The load-bearing detail is that **`showOpen` is `!isInt`, not
 * `!isInt && !busy`**: a blocked task keeps the whole offer on screen and gains
 * a notice over its footer. `busy` is the open card with the alert and a greyed
 * button, not a third card. So the prop surface has two shapes, and "busy" is
 * `blockedBy` being present on the start shape - which also makes a busy card
 * without the blocking run's name a compile error, since that name is the one
 * thing the alert must print.
 *
 * ## The ceiling is money, so it fails toward refusing
 *
 * `src/server.ts`'s raise route enumerates what a budget field must refuse, and
 * the same dimension is in this input. Treated as `CLAUDE.md` requires of a
 * skipping guard:
 *
 * - **The dimension:** the string in the ceiling field. Not "the input".
 * - **Its values:** blank, whitespace, a plain decimal, a decimal with a
 *   leading or trailing dot, a thousands separator, a currency sign, trailing
 *   junk (`50abc`), exponent notation (`1e2`), hex (`0x32`), the literals `NaN`
 *   and `Infinity`, a signed figure, `-0`, zero, and a figure long enough to
 *   round to `Infinity` (400 digits does).
 * - **The cost in each direction, which is wildly asymmetric.** A bad figure
 *   let through is either `NaN`/`0`, which funds no turn and fails at the
 *   spawn - where the UI cannot attribute the failure to the input that caused
 *   it, since the CLI rejects a non-positive `--max-budget-usd` (probed) - or
 *   `Infinity`, which funds a run with no ceiling at all, and this app's own
 *   memo says budgets run to ~$100 a session. A good figure refused costs one
 *   retype of a field that is on screen with the reason beside it.
 * - **So:** the syntax is checked first (digits, one optional decimal part),
 *   then `Number`, then finite and strictly above zero. `parseFloat` is not
 *   used anywhere near this - `parseFloat("50abc")` is `50`, which is the one
 *   answer no reading of that string justifies. `1e2` and `0x32` are refused
 *   even though `Number` accepts them, because a human typing money types a
 *   decimal, and refusing is the cheap direction. The finite check still runs
 *   **after** the regex, because a 400-digit run of digits passes the syntax
 *   and overflows to `Infinity`.
 *
 * Whitespace is trimmed, which is the one normalisation here, and tested as
 * such.
 *
 * ## Two things the server cannot do yet
 *
 * Both are reported rather than faked, and both are why the ceiling field is
 * optional instead of always drawn:
 *
 * 1. `START_KEYS` in `src/server.ts` is `["projectPath", "featureFile",
 *    "taskRef"]` and `parseBody` refuses unknown keys by name, so a per-run
 *    `budgetUsd` on `POST /api/runs` is a 400 today. A run takes the project's
 *    `Project.budgetUsd` instead.
 * 2. `TreeProject` carries `path`, `account`, `testCmd` and `features` - no
 *    `budgetUsd` - so the shell cannot even learn the figure to seed the field
 *    with.
 *
 * Until both land, `App.tsx` passes no `defaultCeilingUsd`, no ceiling control
 * is drawn, and `onStart` is called with `undefined`. That is the honest state:
 * a control that cannot change what it claims to change is worse than an
 * absent one. When they land, one prop turns it on.
 *
 * Likewise `onStartOver` is optional because a fresh start on a task that has
 * already run is refused `branch-exists` by `src/run.ts`; the artboard's
 * "Start over from planning" button therefore appears only when a caller has
 * something to put behind it.
 *
 * ## Motion
 *
 * The artboard's own keyframes, via `artboard.css`'s `.bf`/`.d1`-`.d3`/`.spin`,
 * rather than Motion components: `docs/HANDOFF.md` measured 195 unhandled
 * `AbortError`s from Motion entrances in one run, and these classes are also
 * covered by the `.kr, .kr *` reduced-motion guard that a Motion spring is not.
 * `useReducedMotion()` is OR'd with a live `matchMedia` read because
 * `CLAUDE.md` records it answering `false` with the feature actually set, and
 * every animated class is withheld in JS as well - happy-dom never evaluates
 * `@media`, so the CSS guard is invisible to every assertion.
 */

import { useCallback, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactElement, type ReactNode } from "react"
import { useReducedMotion } from "motion/react"

import type { Account, TreeTask } from "./Tree.tsx"
import { commandOf, SELF_CHECKED } from "./testcmd.ts"
/* Type-only on purpose: a value import drags `node:fs/promises` into the
 * browser bundle. */
import type { RunState } from "../runindex.ts"

/* -------------------------------------------------------------------------- */
/* Props                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The run that holds the lock, which is why this task cannot start.
 *
 * `state` is required, and that is deliberate. `src/run.ts` takes the lock with
 * `acquireRunLock(repo, …)` and names the refusal *"Another run holds this
 * project's lock"*, while `Runner.stop`'s docstring notes that a run parked at
 * the gate holds no process at all - so a blocker is not necessarily working,
 * and the artboard's *"… is running."* would then be a false claim that sends
 * someone looking for an agent that is not there. Carrying the state makes the
 * sentence match the blocker.
 */
export interface Blocker {
  /** What the alert prints, e.g. the artboard's `other-repo · T2 Refund path`.
   *  The shell's words: it knows whether the blocker is in this project. */
  label: string
  state: RunState
  /** Offered as a link only when there is somewhere to go. */
  onGoToRun?: () => void
}

interface PanelCommon {
  /** The row this card is about. `ref` and `text` are printed verbatim. */
  task: TreeTask
  /** The feature file as the project lists it, shown unshortened. */
  featureFile: string
  account: Account
  /**
   * The project's test command, printed in step 3 and under "Tests".
   *
   * `null` is a real value, not a missing one: the user decided on 2026-10-12
   * that a project may have no suite and the agent verifies its own work
   * instead (`docs/HANDOFF.md`). `Project.testCmd` in `src/projects.ts` is
   * already `string | null`; `TreeProject.testCmd` is still `string`, so the
   * shell cannot deliver the null case until that widens too.
   *
   * What this card must not do is settled by that record: *"Every surface that
   * today prints an exit code must distinguish the two … 'Self-checked by the
   * agent - no test command' is true; a green tick is not."* So without a
   * command, step 3 claims no exit code at all.
   */
  testCmd: string | null
  /** Percent of the account's 5-hour window already used, for the artboard's
   *  "41% used". Omitted rather than guessed. */
  usagePct?: number
  onChangeAccount?: () => void
  className?: string
}

export interface StartShape extends PanelCommon {
  kind: "start"
  /**
   * Seeds the ceiling field, which is drawn **only** when this is supplied.
   * `Project.budgetUsd`, whose own default is 50 - the artboard's `50.00`.
   * See the file header for why it is optional.
   */
  defaultCeilingUsd?: number
  /** Present means the artboard's `busy` variant: the offer stays, the alert
   *  appears, the button greys. */
  blockedBy?: Blocker
  /** The backlog line's number, for "· line 7". */
  line?: number
  /**
   * The task's markdown line, **as the file has it**, for the artboard's
   * `- [ ] T3 Runtime shim (v1.2)` chip. Taken rather than rebuilt from `ref`
   * and `text`: `src/backlog.ts` owns those bytes, and a chip that reflowed
   * them would be showing the human a line their file does not contain.
   */
  backlogLine?: string
  /**
   * May return a promise, and **rejecting is how a refusal is reported** - the
   * contract `Gate.onApprove` already uses here. The button comes back and the
   * rejection's message is shown.
   *
   * The figure is `undefined` exactly when no ceiling control was offered; when
   * one was, it is finite and strictly above zero, because the button is
   * disabled otherwise.
   */
  onStart: (ceilingUsd?: number) => unknown
  onResume?: never
  onStartOver?: never
}

export interface ResumeShape extends PanelCommon {
  kind: "resume"
  /**
   * Preformatted, as `Gate` takes `askedAt`: the clock belongs to the shell.
   * Omitted rather than printing a time the run never recorded.
   */
  stoppedAt?: string
  /** The artboard's "attempt 2". Omitted when nothing counted it, which drops
   *  the clause rather than inventing a number. */
  attempt?: number
  /**
   * What the run has spent. For a run with no `end` record this is a **floor**
   * (see `RunSummary.costUsd`), and the shell passes the figure it computed.
   */
  spentUsd?: number
  /** The run's ceiling, for "of $50.00". */
  ceilingUsd?: number
  /** The last records the log kept, newest last, drawn above the
   *  "Server stopped" rule. */
  lastEvents?: readonly RunEvent[]
  /** Rejects to report a refusal, as `onStart` does. */
  onResume: () => unknown
  /** Absent means no button: see the file header on `branch-exists`. */
  onStartOver?: () => unknown
  onStart?: never
}

/** One row of the interrupted card's tail. */
export interface RunEvent {
  kind: "edit" | "shell"
  /** The path or the command, printed verbatim. */
  text: string
  /** Preformatted, like `stoppedAt`. */
  at?: string
  added?: number
  removed?: number
}

export type StartPanelProps = StartShape | ResumeShape

/* -------------------------------------------------------------------------- */
/* Motion preference                                                          */
/* -------------------------------------------------------------------------- */

const REDUCE_QUERY = "(prefers-reduced-motion: reduce)"

function canAskForMotionPreference(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
}

function subscribeToReducePreference(onChange: () => void): () => void {
  if (!canAskForMotionPreference()) return () => {}
  const query = window.matchMedia(REDUCE_QUERY)
  if (typeof query.addEventListener !== "function") return () => {}
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

function readReducePreference(): boolean {
  return canAskForMotionPreference() ? window.matchMedia(REDUCE_QUERY).matches : false
}

/** Two sources OR'd. See the file header for why neither is trusted alone. */
function usePrefersReducedMotion(): boolean {
  const motionsAnswer = useReducedMotion() === true
  const live = useSyncExternalStore(subscribeToReducePreference, readReducePreference, () => false)
  return motionsAnswer || live
}

/* -------------------------------------------------------------------------- */
/* The ceiling                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A plain decimal and nothing else: digits, then at most one decimal part.
 *
 * `\d` is ASCII-only in JavaScript, so fullwidth digits are refused too. No
 * sign, no exponent, no `0x`, no separator. The header explains why that is the
 * cheap direction.
 */
const PLAIN_DECIMAL = /^\d+(?:\.\d+)?$/


/** The figure a run may be funded with, or `null` for every other string. */
function parseCeiling(raw: string): number | null {
  const trimmed = raw.trim()
  if (!PLAIN_DECIMAL.test(trimmed)) return null
  const figure = Number(trimmed)
  /* After the syntax check, not instead of it: 400 digits is valid syntax and
   * overflows to Infinity. */
  if (!Number.isFinite(figure) || figure <= 0) return null
  return figure
}

function money(usd: number): string {
  return `$${usd.toFixed(2)}`
}

/* -------------------------------------------------------------------------- */
/* Icons. Lucide shapes, as the artboard draws them.                          */
/* -------------------------------------------------------------------------- */

/**
 * `.ic` carries the 16px default, the `fill:none` and the round joins, and they
 * are repeated here as attributes so a specimen still reads as a line drawing
 * in a harness that has not loaded `artboard.css`.
 */
function Icon({ children, style }: { children: ReactNode; style?: CSSProperties }): ReactElement {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="ic"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
    >
      {children}
    </svg>
  )
}

function FileIcon(): ReactElement {
  return (
    <Icon style={{ width: 13, height: 13 }}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </Icon>
  )
}

function WrenchIcon(): ReactElement {
  return (
    <Icon style={{ width: 15, height: 15 }}>
      <path d="m19 5 3-3" />
      <path d="m2 22 3-3" />
      <path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z" />
      <path d="M7.5 13.5 10 11" />
      <path d="M10.5 16.5 13 14" />
      <path d="m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z" />
    </Icon>
  )
}

function UserIcon(): ReactElement {
  return (
    <Icon style={{ width: 12, height: 12 }}>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </Icon>
  )
}

function BriefcaseIcon(): ReactElement {
  return (
    <Icon style={{ width: 12, height: 12 }}>
      <path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
      <rect width="20" height="14" x="2" y="6" rx="2" />
    </Icon>
  )
}

function PencilIcon(): ReactElement {
  return (
    <Icon style={{ width: 15, height: 15, color: "#4B4BC8", marginTop: 2 }}>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <path d="m15 5 4 4" />
    </Icon>
  )
}

function TerminalIcon(): ReactElement {
  return (
    <Icon style={{ width: 15, height: 15, color: "#111216", marginTop: 2 }}>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" x2="20" y1="19" y2="19" />
    </Icon>
  )
}

/** The artboard's play triangle. Filled, so it is not an `.ic`. */
function PlayIcon({ fill }: { fill: string }): ReactElement {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" style={{ width: 14, height: 14, fill }}>
      <polygon points="6 3 20 12 6 21 6 3" />
    </svg>
  )
}

/**
 * The artboard's two-tone ring. `track`/`arc` differ between the alert (paler)
 * and the footer, exactly as the artboard draws them.
 */
function Spinner({
  size,
  spin,
  track = "#DCDCF6",
  arc = "#5B5BD6",
  label,
}: {
  size: number
  spin: boolean
  track?: string
  arc?: string
  label?: string
}): ReactElement {
  return (
    <svg
      className={spin ? "spin" : undefined}
      {...(label === undefined ? { "aria-hidden": true } : { "aria-label": label })}
      viewBox="0 0 24 24"
      style={{ width: size, height: size, flex: "none" }}
    >
      <circle cx="12" cy="12" r="9" fill="none" stroke={track} strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke={arc} strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

/* -------------------------------------------------------------------------- */
/* Component-scoped CSS                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The two rules this artboard has and `artboard.css` does not.
 *
 * `.shinyi` is Start's **indigo** shine; `artboard.css`'s `.shiny` is Main's
 * orange one, and orange means needs-you in this app - wrong colour for a line
 * that says a run is working. `.fld` is the input's focus ring, which no other
 * artboard needed. Both are prefixed `ks-` so nothing here redeclares a shared
 * rule, and the keyframe is this file's own so the component still shines in a
 * harness that has not loaded `artboard.css`.
 *
 * The `@media` block is the belt to the JS braces: the classes are also
 * withheld when the preference is set, and this covers a preference that
 * changes before React has re-rendered.
 */
const PANEL_CSS = `
.ks-shine {
  background-image: linear-gradient(90deg,#20205E 0%,#20205E 38%,#8B8BEF 50%,#20205E 62%,#20205E 100%);
  background-size: 250% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: ks-shine-move 3s linear infinite;
}
@keyframes ks-shine-move { from { background-position: 150% 0 } to { background-position: -50% 0 } }
.ks-fld:focus-within { box-shadow: 0 0 0 3px rgba(91,91,214,.18); border-color: #A9AAF0 }
@media (prefers-reduced-motion: reduce) {
  .ks-shine { animation: none; background-image: none; color: #20205E }
}
`

/* -------------------------------------------------------------------------- */
/* Shared pieces                                                              */
/* -------------------------------------------------------------------------- */

const CARD: CSSProperties = {
  background: "#fff",
  border: "1px solid #E7E7EB",
  borderRadius: 24,
  boxShadow: "0 1px 2px rgba(17,18,22,.04),0 18px 50px -22px rgba(17,18,22,.2)",
  overflow: "clip",
  /* Preflight's own value, repeated so a padded card is never 88px narrow in a
   * harness without it. `CLAUDE.md` has the measurement. */
  boxSizing: "border-box",
  width: "100%",
}

const H1: CSSProperties = {
  margin: "12px 0 0",
  fontSize: "clamp(30px,3.8vw,44px)",
  lineHeight: 1.06,
  fontWeight: 650,
  letterSpacing: "-.035em",
}

/** The artboard's horizontal rhythm, which every band of both cards shares. */
const GUTTER = "clamp(20px,4vw,44px)"

const FOOTER: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  marginTop: 24,
  padding: `20px ${GUTTER} 24px`,
  borderTop: "1px solid #EEEEF1",
  background: "#FBFBFC",
}

const CTA: CSSProperties = {
  height: 56,
  padding: "0 24px 0 20px",
  borderRadius: 999,
  border: 0,
  background: "#111216",
  color: "#fff",
  fontSize: 16,
  fontWeight: 620,
  display: "inline-flex",
  alignItems: "center",
  gap: 10,
  boxShadow: "0 10px 28px -10px rgba(17,18,22,.6),inset 0 1px 0 rgba(255,255,255,.16)",
}

const CTA_OFF: CSSProperties = {
  ...CTA,
  background: "#E4E4E9",
  color: "#6B7080",
  boxShadow: "none",
  cursor: "not-allowed",
}

const ASIDE: CSSProperties = { fontSize: 13.5, color: "#4A4E59" }

const FIELD_LABEL: CSSProperties = { fontSize: 12.5, fontWeight: 600, color: "#4A4E59" }

const EYEBROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  fontSize: 13,
  fontWeight: 600,
}

/** The account badge: one variant per kind, as `DESIGN.md` requires. */
function AccountChip({ account }: { account: Account }): ReactElement {
  const work = account.kind === "work"
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 7px 2px 5px",
        borderRadius: 6,
        background: work ? "#26272D" : "#E0F2FE",
        color: work ? "#F4F4F6" : "#075985",
        fontSize: 12,
        fontWeight: 550,
      }}
    >
      {work ? <BriefcaseIcon /> : <UserIcon />}
      {account.label ?? (account.kind === "unknown" ? "account unknown" : account.kind)}
    </span>
  )
}

/** "Runs as", shared by both cards' summaries. */
function RunsAs({
  account,
  usagePct,
  onChangeAccount,
}: {
  account: Account
  usagePct?: number
  onChangeAccount?: () => void
}): ReactElement {
  const body = (
    <>
      <AccountChip account={account} />
      {usagePct !== undefined && (
        <span className="m" style={{ fontSize: 12, color: "#5F6370" }}>
          {`${usagePct}% used`}
        </span>
      )}
      {/* The word appears only when there is a handler behind it: a dead
          "Change" is a promise the card cannot keep. */}
      {onChangeAccount !== undefined && (
        <span style={{ marginLeft: "auto", fontSize: 12.5, color: "#4B4BC8", fontWeight: 550 }}>Change</span>
      )}
    </>
  )

  const shell: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    minHeight: 44,
    padding: "0 12px",
    borderRadius: 12,
    border: "1px solid #E7E7EB",
    background: "#fff",
    color: "#111216",
    fontSize: 14,
    boxSizing: "border-box",
    textAlign: "left",
    width: "100%",
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={FIELD_LABEL}>Runs as</span>
      {onChangeAccount === undefined ? (
        <span style={shell}>{body}</span>
      ) : (
        <button type="button" onClick={onChangeAccount} style={{ ...shell, cursor: "pointer" }}>
          {body}
        </button>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* The component                                                              */
/* -------------------------------------------------------------------------- */

export function StartPanel(props: StartPanelProps): ReactElement {
  const reduced = usePrefersReducedMotion()
  /** `.bf` and its rung, dropped whole when the person asked for less. */
  const anim = (classes: string): string => (reduced ? "" : classes)

  /**
   * Whatever the human has set or done applies to **this** task, so a new one
   * clears it. The shell is not obliged to remount this card - the design says
   * only the centre changes shape - so the reset lives here. Identical props,
   * which is what polling produces, change nothing.
   */
  const signature = `${props.kind}\u0000${props.featureFile}\u0000${props.task.ref ?? ""}\u0000${props.task.text}`
  const seeded = props.kind === "start" && props.defaultCeilingUsd !== undefined ? props.defaultCeilingUsd.toFixed(2) : ""

  const [acting, setActing] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [draft, setDraft] = useState(seeded)
  /* A latch in a **ref**, not in state: two clicks in one tick would both read
   * the old state and both pay for a run. */
  const latched = useRef(false)
  /* Bumped whenever the card is handed another task, so a promise from the
   * previous one cannot come back and undo this one's state. */
  const generation = useRef(0)
  const [seen, setSeen] = useState(signature)
  if (seen !== signature) {
    setSeen(signature)
    setActing(false)
    setRefusal(null)
    setDraft(seeded)
    latched.current = false
    generation.current += 1
  }

  const fire = useCallback((act: () => unknown) => {
    if (latched.current) return
    latched.current = true
    const mine = generation.current
    setActing(true)
    setRefusal(null)

    const undo = (cause: unknown): void => {
      /* The card has moved on to another task; this refusal is about a decision
       * nobody is looking at. */
      if (generation.current !== mine) return
      latched.current = false
      setActing(false)
      setRefusal(cause instanceof Error ? cause.message : String(cause))
    }

    try {
      const out = act()
      if (out instanceof Promise) void out.catch(undo)
    } catch (cause) {
      undo(cause)
    }
  }, [])

  if (props.kind === "resume") {
    return (
      <InterruptedCard
        {...props}
        reduced={reduced}
        anim={anim}
        acting={acting}
        refusal={refusal}
        fire={fire}
      />
    )
  }

  return (
    <OpenCard
      {...props}
      reduced={reduced}
      anim={anim}
      acting={acting}
      refusal={refusal}
      fire={fire}
      draft={draft}
      setDraft={setDraft}
    />
  )
}

interface Wiring {
  reduced: boolean
  anim: (classes: string) => string
  acting: boolean
  refusal: string | null
  fire: (act: () => unknown) => void
}

/* -------------------------------------------------------------------------- */
/* The open card, which is also the busy one                                  */
/* -------------------------------------------------------------------------- */

/** What the alert's first clause may claim, by what the blocker is doing. */
function blockerActivity(state: RunState): string {
  switch (state.kind) {
    case "running":
      return "is running."
    case "waiting":
      return "is waiting for you."
    case "interrupted":
      return "was interrupted and still holds the run lock."
    case "done":
    case "failed":
      return "still holds the run lock."
  }
}

const REFUSAL: CSSProperties = {
  flex: "1 1 260px",
  margin: 0,
  fontSize: 13.5,
  lineHeight: 1.5,
  color: "#B42318",
}

function OpenCard(props: StartShape & Wiring & { draft: string; setDraft: (value: string) => void }): ReactElement {
  const { task, featureFile, testCmd, account, blockedBy, reduced, anim, acting, refusal, fire, draft, setDraft } = props

  const command = commandOf(testCmd)
  const offersCeiling = props.defaultCeilingUsd !== undefined
  const ceiling = offersCeiling ? parseCeiling(draft) : undefined
  const ceilingBad = offersCeiling && ceiling === null
  const blocked = blockedBy !== undefined
  /* The artboard: `canStart = !isInt && !busy && !started`. The bad-ceiling
   * term is this port's, and it is the money guard. */
  const canStart = !blocked && !acting && !ceilingBad

  const headingId = "kantan-start-task"
  const ceilingId = "kantan-start-ceiling"
  const ceilingNoteId = "kantan-start-ceiling-note"

  return (
    <section
      data-testid="open-card"
      aria-labelledby={headingId}
      /* `kr` is what `artboard.css`'s `.kr, .kr *` reduced-motion guard needs;
         `leading-[normal]` undoes Tailwind preflight's 1.5, which the artboards
         do not have and which measured 2-4px too tall per line. */
      className={`kr leading-[normal]${props.className === undefined ? "" : ` ${props.className}`} ${anim("bf")}`.trimEnd()}
      data-motion={reduced ? "static" : "animated"}
      style={CARD}
    >
      <style>{PANEL_CSS}</style>

      <div style={{ padding: `30px ${GUTTER} 26px` }}>
        <div style={{ ...EYEBROW, color: "#5F6370" }}>
          <span
            aria-hidden="true"
            style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              border: "1.5px solid #A3A7B1",
              boxSizing: "border-box",
            }}
          />
          Open · not started
        </div>
        <h1 id={headingId} style={H1}>
          {task.text}
        </h1>
        <div
          className="m"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 8,
            marginTop: 14,
            fontSize: 12.5,
            color: "#4A4E59",
          }}
        >
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "5px 10px",
              borderRadius: 999,
              background: "#F4F4F6",
            }}
          >
            <FileIcon />
            {props.line === undefined ? featureFile : `${featureFile} · line ${props.line}`}
          </span>
          {props.backlogLine !== undefined && (
            <span data-testid="backlog-line" style={{ padding: "5px 10px", borderRadius: 999, background: "#F4F4F6" }}>
              {props.backlogLine}
            </span>
          )}
        </div>
      </div>

      <div style={{ padding: `0 ${GUTTER}` }}>
        <h2
          style={{
            margin: "0 0 12px",
            fontSize: 11.5,
            fontWeight: 600,
            letterSpacing: ".07em",
            textTransform: "uppercase",
            color: "#6B7080",
          }}
        >
          What happens when you start
        </h2>
        <ol
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(min(200px,100%),1fr))",
            gap: 10,
          }}
        >
          <Step n={1} title="Plan" className={anim("bf d1")}>
            An agent reads the repo and writes a plan to{" "}
            <span className="m" style={{ fontSize: 12.5 }}>
              docs/plans/
            </span>
            . Then it stops.
          </Step>
          <Step n={2} title="You decide" className={anim("bf d2")} accent>
            Approve the plan, or send it back with a note. Nothing else moves until you do.
          </Step>
          {/* The only branch in the artboard's copy that the artboard does not
              draw: it was drawn before a project could have no suite. With no
              command there is no exit code, so the sentence claims none. */}
          <Step n={3} title={command === null ? "Build and check" : "Build and test"} className={anim("bf d3")}>
            {command === null ? (
              <>A fresh agent implements it, then verifies its own work and records how it did — this project has no test command.</>
            ) : (
              <>
                A fresh agent implements it. kantan runs{" "}
                <span className="m" data-testid="step-cmd" style={{ fontSize: 12.5 }}>
                  {command}
                </span>{" "}
                until it exits 0.
              </>
            )}
          </Step>
        </ol>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(min(200px,100%),1fr))",
          gap: 12,
          padding: `22px ${GUTTER} 4px`,
        }}
      >
        <RunsAs
          account={account}
          {...(props.usagePct === undefined ? {} : { usagePct: props.usagePct })}
          {...(props.onChangeAccount === undefined ? {} : { onChangeAccount: props.onChangeAccount })}
        />

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={FIELD_LABEL}>Tests</span>
          <span
            /* The mono face is for machine values, so it is withheld from the
               sentence that stands in for one. */
            className={command === null ? undefined : "m"}
            data-testid="test-cmd"
            style={{
              display: "flex",
              alignItems: "center",
              minHeight: 44,
              padding: "0 12px",
              borderRadius: 12,
              background: "#F4F4F6",
              fontSize: 13.5,
              boxSizing: "border-box",
              ...(command === null ? { color: "#5F6370" } : {}),
            }}
          >
            {command ?? SELF_CHECKED}
          </span>
        </div>

        {offersCeiling && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label htmlFor={ceilingId} style={FIELD_LABEL}>
              Cost ceiling for this run
            </label>
            <span
              className="ks-fld"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                minHeight: 44,
                padding: "0 12px",
                borderRadius: 12,
                border: `1px solid ${ceilingBad ? "#E4A0A6" : "#E7E7EB"}`,
                background: "#fff",
                boxSizing: "border-box",
              }}
            >
              <span style={{ color: "#5F6370" }}>$</span>
              <input
                id={ceilingId}
                data-testid="ceiling"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                inputMode="decimal"
                aria-invalid={ceilingBad}
                {...(ceilingBad ? { "aria-describedby": ceilingNoteId } : {})}
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
            </span>
            {/* Not `role="alert"`: it would announce on every keystroke of a
                figure still being typed. The button is already disabled, so the
                note explains rather than interrupts. */}
            {ceilingBad && (
              <span id={ceilingNoteId} data-testid="ceiling-note" style={{ fontSize: 12.5, color: "#B42318" }}>
                Enter a dollar figure above zero, like 50 or 12.50.
              </span>
            )}
          </div>
        )}
      </div>

      {blockedBy !== undefined && (
        <div
          data-testid="one-at-a-time"
          role="status"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "10px 14px",
            margin: `20px ${GUTTER} 0`,
            padding: "14px 16px",
            borderRadius: 14,
            background: "#F3F3FE",
            border: "1px solid #D6D7FA",
            color: "#20205E",
            fontSize: 14,
            lineHeight: 1.5,
          }}
        >
          <Spinner size={16} spin={!reduced} track="#C9CAF5" arc="#4B4BC8" />
          <span style={{ flex: "1 1 300px" }}>
            <strong style={{ fontWeight: 620 }}>{`${blockedBy.label} ${blockerActivity(blockedBy.state)}`}</strong>{" "}
            kantan runs one task at a time, so this one can start once that run finishes or you stop it.
          </span>
          {blockedBy.onGoToRun !== undefined && (
            <button
              type="button"
              onClick={blockedBy.onGoToRun}
              style={{
                border: 0,
                background: "transparent",
                padding: 0,
                fontWeight: 600,
                fontSize: 13.5,
                color: "#4B4BC8",
                textDecoration: "underline",
              }}
            >
              Go to that run
            </button>
          )}
        </div>
      )}

      <div style={{ ...FOOTER, gap: "14px 20px" }}>
        {acting ? (
          <>
            <div
              className={anim("bf")}
              data-testid="starting"
              role="status"
              style={{ display: "flex", alignItems: "center", gap: 12, minHeight: 56 }}
            >
              <Spinner size={20} spin={!reduced} />
              <span className={reduced ? undefined : "ks-shine"} style={{ fontSize: 16, fontWeight: 620, color: "#20205E" }}>
                Planning. The agent is reading your repo.
              </span>
            </div>
            <span style={ASIDE}>You can leave. kantan calls you back when the plan is ready.</span>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={!canStart}
              {...(canStart ? {} : { "aria-disabled": true })}
              onClick={() => {
                if (!canStart) return
                const act = props.onStart
                /* `undefined` only when no control was offered; otherwise a
                 * figure this card has already proved finite and above zero. */
                fire(() => act(offersCeiling && ceiling !== null ? ceiling : undefined))
              }}
              style={canStart ? CTA : CTA_OFF}
            >
              <PlayIcon fill={canStart ? "#fff" : "#8A8F9C"} />
              Start planning
            </button>
            <span style={ASIDE}>
              {blocked ? "Available when the current run ends." : "No code changes until you approve the plan."}
            </span>
          </>
        )}
        {refusal !== null && (
          <p data-testid="refusal" role="alert" style={REFUSAL}>
            {refusal}
          </p>
        )}
      </div>
    </section>
  )
}

function Step({
  n,
  title,
  className,
  accent = false,
  children,
}: {
  n: number
  title: string
  className: string
  accent?: boolean
  children: ReactNode
}): ReactElement {
  return (
    <li
      data-testid="step"
      className={className}
      style={{
        padding: 16,
        borderRadius: 16,
        background: accent ? "#FFF6F0" : "#FAFAFB",
        border: `1px solid ${accent ? "#FFD9C2" : "#EEEEF1"}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14.5, fontWeight: 620 }}>
        <span
          style={{
            width: 24,
            height: 24,
            borderRadius: 8,
            background: accent ? "#FF6A1A" : "#111216",
            color: accent ? "#1A0B02" : "#fff",
            display: "grid",
            placeItems: "center",
            fontSize: 12,
            flex: "none",
          }}
        >
          {n}
        </span>
        {title}
      </div>
      <p style={{ margin: "8px 0 0", fontSize: 13.5, lineHeight: 1.5, color: "#4A4E59" }}>{children}</p>
    </li>
  )
}

/* -------------------------------------------------------------------------- */
/* The interrupted card                                                       */
/* -------------------------------------------------------------------------- */

const PHASE_WORDS: Record<string, string> = {
  plan: "plan",
  gate: "gate",
  implement: "implement",
  test: "test",
  refine: "refine",
}

/** Title case for the summary cell, which the artboard capitalises. */
function capitalise(word: string): string {
  return `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`
}

const SUMMARY_CELL: CSSProperties = {
  padding: "14px 16px",
  borderRadius: 14,
  background: "#FAFAFB",
  border: "1px solid #EEEEF1",
}

const DT: CSSProperties = { fontSize: 12, color: "#5F6370" }
const DD: CSSProperties = { margin: "4px 0 0", fontSize: 15, fontWeight: 620 }

/*
 * `featureFile` is deliberately **not** printed here, though it is on the
 * props: the artboard's interrupted card does not carry it, because the
 * breadcrumb `App.tsx` draws is already showing it. It is on `PanelCommon` for
 * the reset signature, where it is load-bearing - every feature file in a repo
 * has a `T1`, so the ref alone does not identify the task this card is about.
 */
function InterruptedCard(props: ResumeShape & Wiring): ReactElement {
  const { task, account, reduced, anim, acting, refusal, fire } = props

  /* The phase comes from `RunState`, which is where the server records it -
   * `{ kind: "interrupted", resumeFrom }`. Absent or another kind drops the
   * clause rather than naming a phase nobody recorded. */
  const state = task.run?.state
  const phase = state !== undefined && state.kind === "interrupted" ? (PHASE_WORDS[state.resumeFrom] ?? null) : null
  const attempt = props.attempt
  const attemptClause = attempt === undefined ? "" : `, attempt ${attempt}`

  const headingId = "kantan-resume-task"
  const events = props.lastEvents ?? []

  return (
    <section
      data-testid="interrupted-card"
      aria-labelledby={headingId}
      className={`kr leading-[normal]${props.className === undefined ? "" : ` ${props.className}`} ${anim("bf")}`.trimEnd()}
      data-motion={reduced ? "static" : "animated"}
      style={CARD}
    >
      <style>{PANEL_CSS}</style>

      <div
        style={{
          padding: `30px ${GUTTER} 22px`,
          background: "linear-gradient(180deg,#F3F5F8 0%,rgba(255,255,255,0) 100%)",
        }}
      >
        <div style={{ ...EYEBROW, color: "#475569" }}>
          <WrenchIcon />
          {props.stoppedAt === undefined ? "Interrupted" : `Interrupted · ${props.stoppedAt}`}
        </div>
        <h1 id={headingId} style={H1}>
          {task.text}
        </h1>
        <p style={{ margin: "12px 0 0", maxWidth: "60ch", fontSize: 15.5, lineHeight: 1.6, color: "#4A4E59" }}>
          {phase === null
            ? `The kantan server stopped mid-run${attemptClause}.`
            : `The kantan server stopped during ${phase}${attemptClause}.`}{" "}
          That is normal in development and nothing was lost. Resuming continues the same run from its last recorded
          event.
        </p>
      </div>

      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(min(170px,100%),1fr))",
          gap: 10,
          margin: 0,
          padding: `0 ${GUTTER}`,
        }}
      >
        {phase !== null && (
          <div style={SUMMARY_CELL}>
            <dt style={DT}>Stopped in</dt>
            <dd style={DD}>{`${capitalise(phase)}${attempt === undefined ? "" : ` · attempt ${attempt}`}`}</dd>
          </div>
        )}
        {props.spentUsd !== undefined && (
          <div style={SUMMARY_CELL}>
            <dt style={DT}>Spent so far</dt>
            <dd style={{ ...DD, fontVariantNumeric: "tabular-nums" }}>
              {money(props.spentUsd)}
              {props.ceilingUsd !== undefined && (
                <span style={{ fontWeight: 450, color: "#5F6370" }}>{` of ${money(props.ceilingUsd)}`}</span>
              )}
            </dd>
          </div>
        )}
        <div style={SUMMARY_CELL}>
          <dt style={DT}>Runs as</dt>
          <dd style={{ margin: "4px 0 0" }}>
            <AccountChip account={account} />
          </dd>
        </div>
      </dl>

      {/* The tail of the log, and the rule that says why it stops. The rule is
          drawn even with no rows: "the log just stops" is the fact this card
          exists to explain, and it is true whether or not the shell passed the
          last few records. */}
      <div
        data-testid="tail"
        style={{ margin: `18px ${GUTTER} 0`, border: "1px solid #EEEEF1", borderRadius: 14, overflow: "hidden" }}
      >
        {events.map((event, index) => (
          <div
            key={`${event.kind}\u0000${event.text}\u0000${index}`}
            data-testid="tail-row"
            style={{
              display: "grid",
              gridTemplateColumns: "22px 58px minmax(0,1fr) auto",
              gap: 10,
              alignItems: "start",
              padding: "9px 14px",
              fontSize: 13,
              ...(index === 0 ? {} : { borderTop: "1px solid #F0F0F3" }),
            }}
          >
            {event.kind === "edit" ? <PencilIcon /> : <TerminalIcon />}
            <span
              className="m"
              style={{
                fontSize: 10.5,
                letterSpacing: ".06em",
                textTransform: "uppercase",
                color: "#6B7080",
                paddingTop: 2,
              }}
            >
              {event.kind}
            </span>
            <span className="m" style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>
              {event.text}
              {event.added !== undefined && <span style={{ color: "#0F7A54", fontWeight: 600 }}>{` +${event.added}`}</span>}
              {event.removed !== undefined && (
                <span style={{ color: "#C4232F", fontWeight: 600 }}>{` −${event.removed}`}</span>
              )}
            </span>
            <span className="m" style={{ fontSize: 11.5, color: "#6B7080" }}>
              {event.at ?? ""}
            </span>
          </div>
        ))}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 14px",
            background: "#F7F8FA",
            ...(events.length === 0 ? {} : { borderTop: "1px solid #F0F0F3" }),
          }}
        >
          <span aria-hidden="true" style={{ flex: 1, height: 0, borderTop: "1.5px dashed #B8C0CC" }} />
          <span style={{ fontSize: 12.5, fontWeight: 600, color: "#475569" }}>Server stopped · last event kept</span>
          <span aria-hidden="true" style={{ flex: 1, height: 0, borderTop: "1.5px dashed #B8C0CC" }} />
        </div>
      </div>

      <div style={{ ...FOOTER, gap: "12px 14px" }}>
        <button
          type="button"
          disabled={acting}
          {...(acting ? { "aria-disabled": true } : {})}
          onClick={() => {
            const act = props.onResume
            fire(() => act())
          }}
          className={acting ? undefined : "cta"}
          style={acting ? CTA_OFF : CTA}
        >
          <PlayIcon fill={acting ? "#8A8F9C" : "#fff"} />
          Resume run
        </button>
        {/* Offered only when a caller has something behind it: a fresh start on
            a task that has already run is refused `branch-exists`. */}
        {props.onStartOver !== undefined && (
          <button
            type="button"
            disabled={acting}
            {...(acting ? { "aria-disabled": true } : {})}
            onClick={() => {
              const act = props.onStartOver
              if (act === undefined) return
              fire(() => act())
            }}
            className={acting ? undefined : "ghost"}
            style={{
              height: 48,
              padding: "0 18px",
              borderRadius: 999,
              border: "1px solid #D9D9DF",
              background: "#fff",
              color: acting ? "#8A8F9C" : "#1E2026",
              fontSize: 14,
              fontWeight: 560,
              ...(acting ? { cursor: "not-allowed" } : {}),
            }}
          >
            Start over from planning
          </button>
        )}
        {/* The artboard's aside explains the *second* button, so with no second
            button there is nothing for it to explain. The earlier stand-in here
            was invented copy that restated the lede. */}
        {props.onStartOver !== undefined && (
          <span style={{ fontSize: 13, color: "#4A4E59", flex: "1 1 220px" }}>
            Starting over keeps this run in the history.
          </span>
        )}
        {refusal !== null && (
          <p data-testid="refusal" role="alert" style={REFUSAL}>
            {refusal}
          </p>
        )}
      </div>
    </section>
  )
}
