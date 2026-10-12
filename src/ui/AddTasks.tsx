/**
 * Adding tasks to a task file, in the centre column.
 *
 * Translated from `docs/design/AddTasks.dc.html` — "kantan — add tasks" —
 * whose six `<sc-if>` branches and three `<sc-for>` loops are the
 * specification, not its pixels. `docs/design/canvas.json` governs the shape:
 *
 * > *"All of these replace the centre column. No routes, no settings page, and
 * > dialogs only for confirmations."*
 *
 * > *"Add tasks: shadcn Tabs (Ask Claude / Write them). The ask box is a
 * > Textarea with Shine Border. Drafts appear as an Animated List of Checkbox
 * > rows with editable text. The file change shows as a diff (Code Comparison,
 * > unified). The add button counts the checked drafts."*
 *
 * So this is a **panel, never a modal**, and the drafts are **proposed**: the
 * human unticks what they do not want, edits any line, reads the unified diff
 * of what will be written, and only then adds. What it replaces — `App.tsx`'s
 * `DescribeWork` dialog — had one textarea, wrote the file on submit, and
 * offered no preview, no selection and no editing.
 *
 * ## Why the prop surface is two promise-returning callbacks
 *
 * `onDraft` resolves with the proposals; `onAdd` resolves with the refs the
 * server wrote. Both follow `Gate.tsx`'s documented convention — "may return a
 * promise, and **rejecting is how a refusal is reported**" — which is the house
 * answer for an action whose outcome the server decides.
 *
 * The alternative, taking `drafts` as a prop with the shell owning the phase,
 * was rejected for one concrete reason: the rows are **editable**, so the
 * component would hold text derived from a prop and would need a rule for when
 * to discard the human's typing. The shell re-renders on every tree refresh,
 * so that rule would run constantly, and `CLAUDE.md`'s skipping-guard note is
 * about exactly this class of invented rule. Owning the rows outright removes
 * the question: nothing but a new proposal can replace them, and a generation
 * token decides which proposal is new.
 *
 * `onDraft` is **optional** and the tabs disappear without it, because the
 * endpoint it needs does not exist yet (see "What the server still owes this
 * screen"). "Write them" needs nothing but `onAdd`, so the screen is useful
 * before the drafting route lands rather than after.
 *
 * ## Four rules that decide what to skip, number or normalise
 *
 * `CLAUDE.md`: name the dimension, enumerate it, say what a wrong guess costs
 * in each direction, test the enumeration. All four matrices are in
 * `test/ui/AddTasks.test.tsx`.
 *
 * **`nextRefNumber` — the highest numeric ref plus one.** The artboard
 * hardcodes `n = 4` after `T3`, so it could not have discovered this. Both
 * near-misses collide: count-plus-one repeats `T4` on `[T1, T3, T4]`, and a
 * string maximum answers `T9` for `[T9, T10]`. A duplicate ref makes
 * `tickTask` **throw** — "appears on lines 4, 7; refusing to guess which to
 * tick" — so the file stops working mid-run, while a gap is valid markdown
 * `parseFeature` reads fine. Every uncertain value therefore numbers *higher*.
 *
 * **`manualLines` — blank lines go, nothing else does.** The dimension is the
 * bytes someone typed or pasted. Blanks must go, because pressing Enter twice
 * is how people write lists; `trim` also absorbs a CRLF paste's `\r`, a tab
 * indent and U+3000. Nothing else is touched: a pasted `- [ ] T5 foo` is kept
 * verbatim and shows up in the diff, because stripping it would be guessing at
 * what someone meant, and dropping a line someone typed loses work with no
 * trace. U+2028 inside a line stays inside it — `backlog.ts`'s `TASK_RE`
 * carries the `s` flag for precisely that character.
 *
 * **A checked draft someone has emptied is not written.** `src/draft.ts`
 * refuses a task line with no text, and `parseFeature` reads `- [ ] T4 ` as a
 * task whose body is empty, which renders as a blank row in the tree. The row
 * stays on screen, marked "needs text", and the count visibly falls: dropping
 * it silently would be the invisible kind of wrong.
 *
 * **`refsOf` — what the server says it wrote.** The confirmation prints the
 * refs `onAdd` resolves with, never the preview's, because the human may have
 * edited the file since the draft. Anything that is not a non-empty string
 * falls back to the count, since "Added 2 tasks" is true while "Added
 * T4–undefined" is not.
 *
 * ## Reduced motion
 *
 * `CLAUDE.md` records Motion's `useReducedMotion()` as a module-level singleton
 * that has answered `false` with the media feature actually set, so it is OR'd
 * with a live `matchMedia` read. The animations are the artboard's own CSS
 * keyframes (`bf`, `pop`, `shineb`, `skel`) rather than Motion components:
 * `docs/HANDOFF.md` measured 195 unhandled `AbortError`s from Motion
 * entrances, and a list that re-enters as rows are consumed is that case. The
 * root carries `kr` so `artboard.css`'s CSS kill-switch reaches them too, and
 * the JS gate **removes** the classes, so there is nothing left to animate
 * rather than an animation asked to stop.
 *
 * ## Tailwind's preflight
 *
 * `leading-[normal]` on the root undoes preflight's `line-height: 1.5`, which
 * the artboard never had. Preflight also sets `button { cursor: default }`,
 * against the artboard's `button{cursor:pointer}`, so every button here says
 * `cursor-pointer`; and it resets the placeholder colour, so the ask and manual
 * boxes restate the artboard's `#7A7F8C`.
 *
 * Hover lives in utilities, never inline. The artboard writes `.cta:hover`,
 * `.send:hover` and `.ghost:hover` *and* sets those backgrounds inline, and a
 * `style` attribute outranks every selector — so those hovers are dead in the
 * artboard itself. `Empty.tsx` and `Tree.tsx` fix the same collision the same
 * way. The class names stay, because they are the artboard's names for the
 * controls.
 *
 * ## What the server still owes this screen
 *
 * `docs/HANDOFF.md` records the gap and this is the component that needs it:
 * `POST /api/features` drafts *and writes* a whole new `docs/features/<slug>.md`
 * in one step. This screen appends to a file that already exists, so it needs
 *
 *  - a **propose** call that returns task texts for an existing file and writes
 *    nothing. `draftFeature` in `src/draft.ts` already returns without writing,
 *    but it returns a whole file numbered from `T1`, which is the wrong shape.
 *    Its prompt must also carry the file's current contents, or the artboard's
 *    "Reads importer.md and the repo, read-only" is not yet true — `askHaiku`
 *    runs with `--tools ""`.
 *  - a **write-the-subset** call taking `{projectPath, featureFile, texts}`,
 *    which re-reads the bytes, numbers from the highest ref on disk, inserts
 *    after the last task line of the parsed region rather than at the end of
 *    the file, preserves CRLF, a BOM and a missing trailing newline through
 *    `featurefile.ts`, and answers with the refs it wrote.
 *
 * Until the first exists, mount this without `onDraft`.
 */

import {
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react"
import { useReducedMotion } from "motion/react"

/* The bound on a rendered diff and the sentence that announces it, so this
 * screen and the run record agree about both. `Row.tsx`'s own renderer is a
 * two-pane Before/After `Comparison` and is not exported; see the report. */
import { MAX_DIFF_LINES, group } from "./Row.tsx"
/* One money format in the UI. */
import { formatUsd } from "./Sidebar.tsx"
import type { Account, TreeTask } from "./Tree.tsx"

/* -------------------------------------------------------------------------- */
/* Props                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One task line already in the file.
 *
 * `Pick` of the tree's own task, so the shell hands over `feature.tasks`
 * unmapped and a change in `Tree.tsx` is a compile error here — the pattern
 * `TreeTaskRun extends Pick<TaskStatus, …>` already uses. `done` is read: a
 * finished task is `- [x]` in the file, and the diff's context lines say so.
 */
export type ExistingTask = Pick<TreeTask, "ref" | "text" | "done">

/** What one drafting call came back with. */
export interface Proposal {
  /** One per proposed task, in order, verbatim as the model wrote them. */
  tasks: readonly string[]
  /** What the call cost, when the server reports it. Omitted, never guessed. */
  costUsd?: number
}

export interface AddTasksProps {
  /** The repository's display name, as the shell names it elsewhere. */
  project: string
  /** The task file, repo-relative and verbatim: `docs/features/importer.md`. */
  featureFile: string
  /** The file's tasks, for the context lines and the numbering. */
  tasks: readonly ExistingTask[]
  /** Which account a drafting call bills to. Drawn as the artboard's chip. */
  account?: Account
  /**
   * Asks for tasks that fit this file. Resolves with the proposals; rejecting
   * is how a refusal is reported, and `src/draft.ts` refuses a dozen reply
   * shapes, so that is the normal path.
   *
   * **Optional.** Without it there is one way in rather than two, and the tabs
   * are not drawn at all: a tab whose action is not wired is a dead control,
   * and the person who would find that out is the user.
   */
  onDraft?: (prompt: string) => Proposal | PromiseLike<Proposal>
  /**
   * Writes the chosen tasks, in order, trimmed, and **without refs** — the
   * server numbers them against the bytes on disk, because the human may have
   * edited the file since these were drafted.
   *
   * Resolves with the refs it wrote, which is what the confirmation prints. A
   * server that cannot say gets a count instead. Rejecting reports a refusal
   * and keeps the selection.
   */
  onAdd: (texts: readonly string[]) => readonly string[] | undefined | void | PromiseLike<readonly string[] | undefined | void>
  /** Leaves without adding. Not drawn when it is not wired. */
  onCancel?: () => void
  /** Opens one of the tasks that were just added. Not drawn when unwired. */
  onOpen?: (ref: string) => void
  className?: string
}

/* -------------------------------------------------------------------------- */
/* The rules                                                                  */
/* -------------------------------------------------------------------------- */

/** The last segment of a path, falling back to the whole of it: a heading
 * reading "Add tasks to " says nothing, while a long one is merely long. */
export function fileName(path: string): string {
  return path.split("/").filter((segment) => segment !== "").at(-1) ?? path
}

/** A `T<n>` ref, and nothing else. `T1x`, `t1` and `` are not refs. */
const REF_RE = /^T(\d+)$/

/**
 * The number the next task gets: the highest `T<n>` in the file plus one.
 *
 * Never the count plus one, and never a string maximum — both collide, and a
 * duplicate ref makes `tickTask` throw rather than tick. A ref-less line
 * consumes nothing, because it has no number to consume.
 */
export function nextRefNumber(tasks: readonly ExistingTask[]): number {
  let highest = 0
  for (const task of tasks) {
    const matched = task.ref === null ? null : REF_RE.exec(task.ref)
    const digits = matched?.[1]
    if (digits === undefined) continue
    const n = Number.parseInt(digits, 10)
    if (Number.isSafeInteger(n) && n > highest) highest = n
  }
  return highest + 1
}

/**
 * The tasks in the "Write them" box: one per line, blanks dropped.
 *
 * `trim` is what makes a CRLF paste, a tab indent and U+3000 behave, and it is
 * also required rather than cosmetic: `parseFeature` trims a task's text on the
 * way back, so an untrimmed line would not round-trip. Nothing else is
 * normalised — see the file header.
 */
export function manualLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
}

/** One backlog line, as `src/backlog.ts` parses it: column zero, `- [ ] T4 …`. */
export function taskLine(ref: string | null, text: string, done: boolean): string {
  const box = done ? "- [x]" : "- [ ]"
  return ref === null ? `${box} ${text}` : `${box} ${ref} ${text}`
}

/**
 * The refs the server says it wrote.
 *
 * Anything else — no answer, an empty list, a list with a hole in it — falls
 * back to the count, because "Added 2 tasks to importer.md" is true and
 * "Added T4–undefined" is a sentence this screen would have invented.
 */
export function refsOf(answer: unknown): readonly string[] {
  if (!Array.isArray(answer)) return []
  const refs = answer.filter((ref): ref is string => typeof ref === "string" && ref.trim() !== "")
  return refs.length === answer.length ? refs : []
}

/** The artboard's two lines of context above the change. */
const CONTEXT_LINES = 2

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as PromiseLike<unknown>).then === "function"
}

/** `Gate.tsx`'s wording, for the same kind of refusal. */
function describeRefusal(err: unknown): string {
  if (err instanceof Error && err.message.trim() !== "") return err.message
  if (typeof err === "string" && err.trim() !== "") return err
  return "The server refused it and did not say why."
}

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
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

function readReducePreference(): boolean {
  return canAskForMotionPreference() ? window.matchMedia(REDUCE_QUERY).matches : false
}

/** Two sources OR'd. See the file header for why one is not enough. */
function usePrefersReducedMotion(): boolean {
  const motionsAnswer = useReducedMotion() === true
  const live = useSyncExternalStore(subscribeToReducePreference, readReducePreference, () => false)
  return motionsAnswer || live
}

/* -------------------------------------------------------------------------- */
/* Icons                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `.ic` carries the artboard's icon preset and the attributes repeat it, so an
 * icon is still a line drawing in a harness that has not loaded
 * `artboard.css`. The size is an **inline style** and not a utility, because
 * `.ic` sets `width:16px` unlayered and unlayered CSS outranks anything
 * Tailwind puts in `@layer utilities`. `Row.tsx` documents the same trap.
 */
function Icon({ size = 16, style, children }: { size?: number; style?: CSSProperties; children: ReactNode }): ReactElement {
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
      style={{ width: size, height: size, ...style }}
    >
      {children}
    </svg>
  )
}

const SPARKLES = (
  <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
)
const PENCIL = (
  <>
    <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
    <path d="m15 5 4 4" />
  </>
)
const FILE = (
  <>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
  </>
)
const CHEVRON = <path d="m9 18 6-6-6-6" />
const PLUS = (
  <>
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </>
)
const REDRAFT = (
  <>
    <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
    <path d="M21 3v5h-5" />
  </>
)
const PERSON = (
  <>
    <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </>
)

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

/** One proposed task, with the identity its editing and removal are keyed on. */
interface Row {
  id: string
  text: string
  on: boolean
}

type DraftState =
  | { kind: "blank" }
  | { kind: "busy" }
  | { kind: "rows"; rows: readonly Row[]; costUsd?: number }
  | { kind: "failed"; message: string }

/**
 * The last outcome of a write, which is **not** whether one is in flight.
 *
 * Keeping them apart is what makes the one-write guard hold: every edit on this
 * screen clears a finished confirmation, and while "in flight" lived in here, a
 * single keystroke during the write cleared it, re-enabled the button and let
 * the same lines be appended twice.
 */
type AddState =
  | { kind: "idle" }
  | { kind: "done"; refs: readonly string[]; count: number }
  | { kind: "failed"; message: string }

/** The artboard's em-dash for a row that is not going in. */
const NO_REF = "—"

/* The card's horizontal padding, which every band of it shares. */
const PAD = "px-[clamp(20px,4vw,44px)]"

/* -------------------------------------------------------------------------- */
/* The screen                                                                 */
/* -------------------------------------------------------------------------- */

export function AddTasks(props: AddTasksProps): ReactElement {
  const { project, featureFile, tasks, account, onDraft, onAdd, onCancel, onOpen, className } = props

  const ids = useId()
  const headingId = `kat-h-${ids}`
  const askTabId = `kat-ask-tab-${ids}`
  const writeTabId = `kat-write-tab-${ids}`
  const panelId = `kat-panel-${ids}`
  const askBoxId = `kat-ask-${ids}`
  const manualBoxId = `kat-manual-${ids}`

  const reduced = usePrefersReducedMotion()
  const anim = (classes: string): string => (reduced ? "" : classes)

  const canAsk = onDraft !== undefined
  const [mode, setMode] = useState<"ask" | "write">(canAsk ? "ask" : "write")
  const [prompt, setPrompt] = useState("")
  const [manual, setManual] = useState("")
  const [draft, setDraft] = useState<DraftState>({ kind: "blank" })
  const [added, setAdded] = useState<AddState>({ kind: "idle" })
  const [writing, setWriting] = useState(false)

  /* Which drafting call is the live one. See "a stale draft" in the tests: the
   * newest wins, and a superseded answer — or refusal — is dropped. */
  const draftToken = useRef(0)
  /* The one-write latch. A ref and not state, because a click arriving in the
   * same tick would read a stale `writing`, and because no other state change
   * can reach it. `Gate.tsx`'s `acted` ref is the same device. */
  const writeLatch = useRef(false)
  const rowSerial = useRef(0)

  /* `onDraft` can disappear between renders; without it there is no ask tab. */
  const asking = canAsk && mode === "ask"
  const file = fileName(featureFile)

  /**
   * What would be written, and the ref each visible row would get.
   *
   * `refs[i]` is row `i`'s ref or `null` when it is not going in — unticked, or
   * emptied. `consumed` is the ids a successful add takes away, by **id** and
   * not by index, so an edit landing while the write is in flight cannot shift
   * which row is removed.
   */
  const plan = useMemo(() => {
    const start = nextRefNumber(tasks)
    if (!asking) {
      const texts = manualLines(manual)
      return {
        planned: texts.map((text, i) => ({ text, ref: `T${start + i}` })),
        refs: [] as readonly (string | null)[],
        consumed: [] as readonly string[],
      }
    }
    const rows = draft.kind === "rows" ? draft.rows : []
    const planned: { text: string; ref: string }[] = []
    const refs: (string | null)[] = []
    const consumed: string[] = []
    let n = start
    for (const row of rows) {
      const text = row.text.trim()
      if (row.on && text !== "") {
        const ref = `T${n}`
        n += 1
        planned.push({ text, ref })
        refs.push(ref)
        consumed.push(row.id)
      } else {
        refs.push(null)
      }
    }
    return { planned, refs, consumed }
  }, [asking, manual, draft, tasks])

  const count = plan.planned.length

  /* --- Drafting ----------------------------------------------------------- */

  const runDraft = useCallback(() => {
    if (onDraft === undefined) return
    const words = prompt.trim()
    if (words === "") return

    draftToken.current += 1
    const token = draftToken.current
    setDraft({ kind: "busy" })
    setAdded({ kind: "idle" })

    const land = (proposal: Proposal): void => {
      if (draftToken.current !== token) return
      const rows = proposal.tasks.map((text) => {
        rowSerial.current += 1
        return { id: `r${rowSerial.current}`, text, on: true }
      })
      setDraft(
        proposal.costUsd === undefined
          ? { kind: "rows", rows }
          : { kind: "rows", rows, costUsd: proposal.costUsd },
      )
    }
    const fail = (err: unknown): void => {
      if (draftToken.current !== token) return
      setDraft({ kind: "failed", message: describeRefusal(err) })
    }

    try {
      const result = onDraft(words)
      if (isPromiseLike(result)) void (result as PromiseLike<Proposal>).then(land, fail)
      else land(result)
    } catch (err) {
      fail(err)
    }
  }, [onDraft, prompt])

  /* --- Adding ------------------------------------------------------------- */

  /**
   * Writes once per selection.
   *
   * Guarded where drafting is not, and the asymmetry is the point: a second
   * draft costs a fraction of a cent and writes nothing, while a second write
   * appends the same lines again. On success the selection is **consumed** —
   * the artboard's own state machine clears `added` on the next keystroke and
   * leaves the written lines still counted, which offers to write them twice.
   */
  const runAdd = useCallback(() => {
    if (writeLatch.current) return
    const texts = plan.planned.map((p) => p.text)
    if (texts.length === 0) return
    const wasAsking = asking

    /* What was sent, so only that is consumed. A line typed while the write is
     * in flight must not be deleted: the header's own rule is that dropping
     * what someone typed loses work with no trace, while leaving it offers the
     * written line a second time — in the diff, where it can be seen. */
    const consumed = new Set(plan.consumed)
    const sentRows = new Map(
      (draft.kind === "rows" ? draft.rows : []).filter((row) => consumed.has(row.id)).map((row) => [row.id, row.text]),
    )
    const sentManual = manual

    writeLatch.current = true
    setWriting(true)

    const land = (answer: unknown): void => {
      writeLatch.current = false
      setWriting(false)
      setAdded({ kind: "done", refs: refsOf(answer), count: texts.length })
      if (wasAsking) {
        setDraft((current) => {
          if (current.kind !== "rows") return current
          const left = current.rows.filter((row) => sentRows.get(row.id) !== row.text)
          return left.length === 0 ? { kind: "blank" } : { ...current, rows: left }
        })
      } else {
        setManual((current) => (current === sentManual ? "" : current))
      }
    }
    const fail = (err: unknown): void => {
      writeLatch.current = false
      setWriting(false)
      setAdded({ kind: "failed", message: describeRefusal(err) })
    }

    try {
      const result = onAdd(texts)
      if (isPromiseLike(result)) void result.then(land, fail)
      else land(result)
    } catch (err) {
      fail(err)
    }
  }, [plan, asking, draft, manual, onAdd])

  /* --- Editing the rows --------------------------------------------------- */

  const editRow = useCallback((id: string, change: (row: Row) => Row): void => {
    setDraft((current) => {
      if (current.kind !== "rows") return current
      return { ...current, rows: current.rows.map((row) => (row.id === id ? change(row) : row)) }
    })
    /* The human's own edit, so a finished confirmation is no longer the news.
     * Driven from the handler and not an effect, which is what lets a
     * *programmatic* clear on success leave the confirmation standing. */
    setAdded((current) => (current.kind === "idle" ? current : { kind: "idle" }))
  }, [])

  /* --- The tabs ----------------------------------------------------------- */

  const pickTab = useCallback((next: "ask" | "write"): void => {
    setMode(next)
    setAdded({ kind: "idle" })
  }, [])

  /** The WAI-ARIA tabs pattern the canvas note's "shadcn Tabs" names. */
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    const order: ("ask" | "write")[] = ["ask", "write"]
    const at = order.indexOf(mode)
    let next: "ask" | "write" | undefined
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = order[(at + 1) % order.length]
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = order[(at + order.length - 1) % order.length]
    else if (event.key === "Home") next = order[0]
    else if (event.key === "End") next = order[order.length - 1]
    if (next === undefined) return
    event.preventDefault()
    pickTab(next)
    /* Automatic activation moves focus with the selection. */
    document.getElementById(next === "ask" ? askTabId : writeTabId)?.focus()
  }

  /* --- The diff ----------------------------------------------------------- */

  const context = tasks.slice(-CONTEXT_LINES)
  const diffAll: { text: string; added: boolean }[] = [
    ...context.map((task) => ({ text: taskLine(task.ref, task.text, task.done), added: false })),
    ...plan.planned.map((p) => ({ text: taskLine(p.ref, p.text, false), added: true })),
  ]
  const diffShown = diffAll.slice(0, MAX_DIFF_LINES)
  const diffDropped = diffAll.length - diffShown.length

  /* --- Copy --------------------------------------------------------------- */

  const next = nextRefNumber(tasks)
  const numbering = next === 1 ? "numbered from T1" : `numbered after T${next - 1}`
  const addLabel = writing
    ? "Adding…"
    : count === 0
      ? "Nothing to add yet"
      : `Add ${count} ${count === 1 ? "task" : "tasks"} to ${file}`

  const accountLabel = account === undefined ? null : (account.label ?? (account.kind === "unknown" ? "account unknown" : account.kind))

  return (
    <div
      className={[
        /* `kr` is the reduced-motion scope `artboard.css` keys its CSS
         * kill-switch on; `App.tsx`'s root carries it too, and standalone this
         * is the only root there is. */
        "kr relative mx-auto w-full max-w-[860px] pt-6 leading-[normal]",
        className ?? "",
      ]
        .join(" ")
        .trim()}
    >
      <nav
        aria-label="Breadcrumb"
        className="mb-[18px] flex flex-wrap items-center gap-2 text-[13.5px] text-muted-500"
      >
        <span>{project}</span>
        <Icon size={14} style={{ color: "#A3A7B1" }}>
          {CHEVRON}
        </Icon>
        <span className="m font-mono text-[12.5px] font-semibold text-ink">{file}</span>
      </nav>

      <section
        aria-labelledby={headingId}
        className={[
          anim("bf"),
          "rounded-[24px] border border-edge bg-white [overflow:clip]",
          "shadow-[0_1px_2px_rgba(17,18,22,.04),0_18px_50px_-22px_rgba(17,18,22,.2)]",
        ]
          .join(" ")
          .trim()}
      >
        <div className={`${PAD} pt-[30px]`}>
          <h1
            id={headingId}
            className="m-0 text-[clamp(28px,3.4vw,38px)] leading-[1.08] font-[650] tracking-[-0.035em]"
          >
            Add tasks to {file}
          </h1>
          <p className="mt-2.5 max-w-[62ch] text-[15px] leading-[1.6] text-muted-700">
            New tasks go at the end of <span className="m font-mono text-[13.5px]">{featureFile}</span> in your working
            tree, {numbering}. Commit the file whenever you like.
          </p>

          {canAsk ? (
            <div
              role="tablist"
              aria-label="How to add tasks"
              className="mt-[22px] inline-flex gap-1 rounded-full bg-[#EFEFF2] p-1"
            >
              <Tab
                id={askTabId}
                panelId={panelId}
                selected={mode === "ask"}
                onSelect={() => pickTab("ask")}
                onKeyDown={onTabKeyDown}
                icon={SPARKLES}
              >
                Ask Claude
              </Tab>
              <Tab
                id={writeTabId}
                panelId={panelId}
                selected={mode === "write"}
                onSelect={() => pickTab("write")}
                onKeyDown={onTabKeyDown}
                icon={PENCIL}
              >
                Write them
              </Tab>
            </div>
          ) : null}
        </div>

        {asking ? (
          <div
            role="tabpanel"
            id={panelId}
            aria-labelledby={askTabId}
            /* No `tabIndex`. The tabs pattern makes a panel focusable only
             * when it holds nothing focusable, and both of these open with a
             * text box — so a stop here would be one with nothing to do. */
          >
            <div className={`${PAD} pt-5`}>
              <label htmlFor={askBoxId} className="mb-2 ml-1 block text-[13px] font-semibold text-[#2A2C33]">
                What&apos;s missing?
              </label>
              {/* Shine Border: the artboard's 1.5px conic ring. */}
              <div className={`${anim("shineb")} rounded-[18px] p-[1.5px] ${reduced ? "bg-edge" : ""}`.trim()}>
                <div className="rounded-[16.5px] bg-white p-1">
                  <textarea
                    id={askBoxId}
                    rows={3}
                    value={prompt}
                    onChange={(e) => {
                      setPrompt(e.target.value)
                      setAdded({ kind: "idle" })
                    }}
                    placeholder="Describe the work. Claude drafts tasks that fit this file and this repo."
                    className={[
                      "block min-h-[92px] w-full resize-y rounded-[13px] border-0 bg-[#F7F7F9] px-3.5 py-3",
                      "text-[15px] leading-[1.55] text-ink outline-none placeholder:text-[#7A7F8C]",
                      /* The artboard's own `.tin:focus` treatment: the shine
                       * border runs whether or not the box has focus, so it is
                       * decoration and not a focus indicator. */
                      "focus:bg-white focus:shadow-[0_0_0_3px_rgba(91,91,214,.18)]",
                    ].join(" ")}
                  />
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-2.5 pr-2 pb-1.5 pl-2.5">
                    <span className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-700">
                      <Icon size={13}>{FILE}</Icon>
                      Reads {file} and the repo, read-only
                    </span>
                    {accountLabel === null ? null : (
                      <span className="inline-flex items-center gap-1 rounded-md bg-account-tint py-0.5 pr-[7px] pl-[5px] text-[11.5px] font-[550] text-account-ink">
                        <Icon size={12}>{PERSON}</Icon>
                        bills to {accountLabel}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={runDraft}
                      disabled={prompt.trim() === ""}
                      className={[
                        "send ml-auto inline-flex h-11 cursor-pointer items-center gap-2 rounded-full border-0",
                        "bg-indigo-deep pr-[18px] pl-3.5 text-[14.5px] font-semibold text-white",
                        "shadow-[0_8px_20px_-10px_rgba(75,75,200,.8)] hover:bg-[#3F3FB8]",
                        "disabled:cursor-not-allowed disabled:bg-[#E4E4E9] disabled:text-muted-400 disabled:shadow-none",
                      ].join(" ")}
                    >
                      <Icon size={15}>{SPARKLES}</Icon>
                      {draft.kind === "busy" ? "Drafting…" : "Draft tasks"}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {draft.kind === "failed" ? (
              <div className={`${PAD} pt-[18px]`}>
                <p
                  role="alert"
                  className="m-0 rounded-[12px] border border-[#F3C6C9] bg-[#FDF2F3] px-3.5 py-2.5 text-[13px] leading-[1.5] text-fail"
                >
                  {draft.message}
                </p>
              </div>
            ) : null}

            {draft.kind === "busy" ? (
              <div
                role="status"
                aria-label="Drafting tasks"
                className={`${PAD} flex flex-col gap-2.5 pt-[22px]`}
              >
                {/* A live region with no text announces nothing, which is this
                 * screen's one a11y gap in the artboard. */}
                <span className="sr-only">Drafting tasks…</span>
                <div className="skel h-12 w-full rounded-[12px]" />
                <div className="skel h-12 w-[86%] rounded-[12px]" />
                <div className="skel h-12 w-[72%] rounded-[12px]" />
              </div>
            ) : null}

            {draft.kind === "rows" ? (
              <div className={`${PAD} pt-[22px]`}>
                <div className="mb-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
                  <h2 className="m-0 text-[16px] font-[650]">
                    Claude drafted {draft.rows.length} {draft.rows.length === 1 ? "task" : "tasks"}
                  </h2>
                  <span className="text-[13px] text-muted-500">
                    Untick what you don&apos;t want, edit any line, then add.
                  </span>
                  {draft.costUsd === undefined && accountLabel === null ? null : (
                    <span className="m ml-auto font-mono text-xs text-muted-500">
                      {[draft.costUsd === undefined ? null : formatUsd(draft.costUsd), accountLabel]
                        .filter((part) => part !== null)
                        .join(" · ")}
                    </span>
                  )}
                </div>
                <ul className="m-0 list-none overflow-hidden rounded-[16px] border border-hairline p-0">
                  {draft.rows.map((row, i) => {
                    const ref = plan.refs[i] ?? null
                    const blank = row.on && row.text.trim() === ""
                    return (
                      <li
                        key={row.id}
                        className={[
                          "drow",
                          /* The artboard's bare `pop`, and it cannot carry the
                           * `.d1`–`.d9` stagger the canvas note's "Animated
                           * List" implies: `artboard.css` declares `.pop` with
                           * the `animation` **shorthand** after those rungs, at
                           * the same specificity, so it resets
                           * `animation-delay` back to zero. `.bf` is declared
                           * before them, which is why `Row.tsx`'s stagger
                           * works and this one would not. */
                          anim("pop"),
                          "grid grid-cols-[24px_34px_minmax(0,1fr)] items-center gap-2.5 px-3.5 py-2.5",
                          i === 0 ? "" : "border-t border-[#F0F0F3]",
                          row.on ? "bg-white" : "bg-panel",
                          "hover:bg-panel",
                        ]
                          .join(" ")
                          .replaceAll(/\s+/g, " ")
                          .trim()}
                      >
                        <input
                          type="checkbox"
                          checked={row.on}
                          onChange={() => editRow(row.id, (r) => ({ ...r, on: !r.on }))}
                          aria-label={`Include draft ${i + 1}`}
                          className="m-0 h-[18px] w-[18px] cursor-pointer accent-ink"
                        />
                        <span
                          className={`m font-mono text-xs font-semibold ${row.on && !blank ? "text-indigo-deep" : "text-muted-300"}`}
                        >
                          {ref ?? NO_REF}
                        </span>
                        <span className="flex min-w-0 items-center gap-2">
                          <input
                            type="text"
                            value={row.text}
                            onChange={(e) => editRow(row.id, (r) => ({ ...r, text: e.target.value }))}
                            aria-label={`Edit draft ${i + 1}`}
                            className={[
                              "tin min-h-[38px] min-w-0 flex-1 rounded-[10px] border-0 bg-transparent px-2.5",
                              "text-[14.5px] focus:bg-white focus:shadow-[0_0_0_3px_rgba(91,91,214,.18)] focus:outline-none",
                              row.on ? "text-ink" : "text-[#7A7F8C] line-through",
                            ].join(" ")}
                          />
                          {blank ? (
                            <span className="shrink-0 pr-1 text-[11.5px] text-muted-400">needs text</span>
                          ) : null}
                        </span>
                      </li>
                    )
                  })}
                </ul>
                <button
                  type="button"
                  onClick={runDraft}
                  /* `box-content`: the artboard declares `border-box` on
                   * `<main>` and `<aside>` only, so a 36px control with a 1px
                   * border is drawn 38px tall. Preflight's blanket border-box
                   * would eat the border and lose 2px. Measured against the
                   * artboard in a browser; `Empty.tsx` records the same rule. */
                  className="ghost mt-2.5 box-content inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full border border-edge-strong bg-white px-3.5 text-[13px] font-[560] text-muted-900 hover:bg-[#F6F6F8]"
                >
                  <Icon size={13}>{REDRAFT}</Icon>
                  Draft again
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <WritePanel
            panelProps={canAsk ? { role: "tabpanel", id: panelId, "aria-labelledby": writeTabId } : {}}
            boxId={manualBoxId}
            value={manual}
            onChange={(value) => {
              setManual(value)
              setAdded({ kind: "idle" })
            }}
          />
        )}

        <div className={`${PAD} pt-[22px]`}>
          <h2 className="m-0 mb-2 text-[11.5px] font-semibold tracking-[0.07em] uppercase text-muted-400">
            Change to the file
          </h2>
          <div className="overflow-hidden rounded-[14px] border border-hairline bg-[#FCFCFD]">
            <div className="m flex items-center gap-1.5 border-b border-hairline px-3.5 py-2 font-mono text-xs text-muted-700">
              <Icon size={13}>{FILE}</Icon>
              {featureFile}
              <span className="ml-auto font-semibold text-pass-deep">+{count}</span>
            </div>
            <pre className="m m-0 overflow-x-auto py-2 font-mono text-[12.5px] leading-[1.75] text-muted-500">
              {diffShown.map((line, i) => (
                <span
                  key={i}
                  className={`block px-3.5 ${line.added ? "bg-[#E3F5EC] text-[#0B5A3E]" : ""}`.trim()}
                >
                  {line.added ? "+ " : "  "}
                  {line.text}
                </span>
              ))}
              {diffDropped > 0 ? (
                <span className="block px-3.5 font-sans text-[11.5px] text-muted-400">
                  {group(diffDropped)} more lines, not shown here.
                </span>
              ) : null}
            </pre>
          </div>
        </div>

        <div
          className={`${PAD} mt-6 flex flex-wrap items-center gap-x-3.5 gap-y-3 border-t border-hairline bg-[#FBFBFC] pt-5 pb-6`}
        >
          {added.kind === "done" ? (
            <div className={`${anim("pop")} flex min-h-[52px] flex-wrap items-center gap-x-3.5 gap-y-2.5`.trim()} role="status">
              <span aria-hidden="true" className="grid h-[22px] w-[22px] place-items-center rounded-full bg-ink">
                <svg viewBox="0 0 24 24" style={{ width: 12, height: 12 }} fill="none" stroke="#fff" strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              </span>
              <span className="text-[15.5px] font-semibold">{addedMessage(added, file)}</span>
              {onOpen !== undefined && added.refs.length > 0 && added.refs[0] !== undefined ? (
                <button
                  type="button"
                  onClick={() => onOpen(added.refs[0] ?? "")}
                  className="cursor-pointer border-0 bg-transparent p-0 text-sm font-semibold text-indigo-deep hover:text-indigo-deeper"
                >
                  Open {added.refs[0]}
                </button>
              ) : null}
            </div>
          ) : (
            <>
              <button
                type="button"
                onClick={runAdd}
                disabled={writing || count === 0}
                className={[
                  "cta inline-flex h-[52px] items-center gap-2.5 rounded-full border-0",
                  "pr-[22px] pl-[18px] text-[15.5px] font-[620] text-white",
                  "bg-ink shadow-[0_10px_28px_-10px_rgba(17,18,22,.6)] hover:bg-ink-hover",
                  "cursor-pointer disabled:cursor-not-allowed disabled:bg-[#E4E4E9] disabled:text-muted-400 disabled:shadow-none",
                ].join(" ")}
              >
                <Icon size={17} style={{ strokeWidth: 2.4 }}>
                  {PLUS}
                </Icon>
                {addLabel}
              </button>
              {onCancel === undefined ? null : (
                <button
                  type="button"
                  onClick={onCancel}
                  /* 48px plus its 1px border, which is 50. See "Draft again". */
                  className="ghost box-content inline-flex h-12 cursor-pointer items-center rounded-full border border-[#D9D9DF] bg-white px-[18px] text-sm font-[560] text-ink-deep hover:bg-[#F6F6F8]"
                >
                  Cancel
                </button>
              )}
              {added.kind === "failed" ? (
                <p
                  role="alert"
                  className="m-0 basis-full rounded-[12px] border border-[#F3C6C9] bg-[#FDF2F3] px-3.5 py-2.5 text-[13px] leading-[1.5] text-fail"
                >
                  {added.message}
                </p>
              ) : null}
            </>
          )}
        </div>
      </section>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Parts                                                                      */
/* -------------------------------------------------------------------------- */

function Tab({
  id,
  panelId,
  selected,
  onSelect,
  onKeyDown,
  icon,
  children,
}: {
  id: string
  panelId: string
  selected: boolean
  onSelect: () => void
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void
  icon: ReactNode
  children: ReactNode
}): ReactElement {
  return (
    <button
      type="button"
      role="tab"
      id={id}
      aria-selected={selected}
      aria-controls={panelId}
      /* Roving tabindex: the tablist is one stop in the tab order. */
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      className={[
        "inline-flex h-[38px] cursor-pointer items-center gap-2 rounded-full border-0 pr-4 pl-3",
        "text-sm font-semibold",
        selected
          ? "bg-white text-ink shadow-[0_1px_2px_rgba(17,18,22,.08),0_4px_10px_-6px_rgba(17,18,22,.3)]"
          : "bg-transparent text-muted-700",
      ].join(" ")}
    >
      <Icon size={15}>{icon}</Icon>
      {children}
    </button>
  )
}

/**
 * Writing them by hand, which exists nowhere else in the product.
 *
 * Mono, because the lines are the file's own text and the diff below prints
 * them in the same face. No refs in the box: the hint says they are assigned,
 * and `manualLines` keeps a pasted `- [ ] T5 foo` verbatim rather than guessing
 * whether someone meant it.
 */
function WritePanel({
  panelProps,
  boxId,
  value,
  onChange,
}: {
  panelProps: Record<string, unknown>
  boxId: string
  value: string
  onChange: (value: string) => void
}): ReactElement {
  return (
    <div {...panelProps}>
      <div className={`${PAD} pt-5`}>
        <label htmlFor={boxId} className="mb-2 ml-1 block text-[13px] font-semibold text-[#2A2C33]">
          One task per line
        </label>
        <textarea
          id={boxId}
          rows={4}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={"Make imports resumable after a crash\nAdd a --dry-run flag"}
          className={[
            "m block min-h-[120px] w-full resize-y rounded-[16px] border border-transparent bg-[#EFEFF2]",
            "px-4 py-3.5 font-mono text-sm leading-[1.7] text-ink outline-none placeholder:text-[#7A7F8C]",
            "focus:bg-white focus:shadow-[0_0_0_3px_rgba(91,91,214,.18)]",
          ].join(" ")}
        />
        <p className="mt-2 mr-1 ml-1 text-[12.5px] text-muted-500">
          Refs are assigned for you. Non-English text is fine.
        </p>
      </div>
    </div>
  )
}

/**
 * What the confirmation says.
 *
 * The refs are the server's. With none to print it is a count, because that is
 * the most this screen can say truthfully about a write it did not number.
 */
function addedMessage(state: { refs: readonly string[]; count: number }, file: string): string {
  const [first] = state.refs
  const last = state.refs.at(-1)
  if (first !== undefined && state.refs.length === 1) return `Added ${first} to ${file}`
  if (first !== undefined && last !== undefined) return `Added ${first}–${last} to ${file}`
  return `Added ${state.count} ${state.count === 1 ? "task" : "tasks"} to ${file}`
}
