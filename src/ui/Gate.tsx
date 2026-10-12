/**
 * The approval gate, and the shape it takes when the agent asked a question
 * instead of writing a plan.
 *
 * The design is `docs/design/Main.dc.html` (the gate) and
 * `docs/design/Question.dc.html` (the question). Read those before changing
 * anything here; they are far more specific than this comment, and every
 * colour, radius and keyframe below is lifted from them.
 *
 * ## Two shapes, one of which cannot be approved
 *
 * `kind: "gate"` is a plan waiting for a decision: Border Beam, an
 * Animated-Shiny-Text eyebrow, the rendered plan, Approve.
 *
 * `kind: "question"` is the agent asking something. Per DESIGN.md there is
 * **no Border Beam, no Approve, no check icon and no black button** — the
 * question is a speech bubble and the only action is an indigo "Send answer".
 * Approving a run that asked a question is a mistake this component has to
 * make impossible, so the question shape carries no `onApprove` at all:
 * `onApprove?: never` makes handing it one a compile error, not a prop that
 * happens to be ignored, and no approve control is rendered or keybound.
 *
 * ## The plan path is dictated, never derived
 *
 * `PlanSource.path` is the path the plan prompt dictated, recorded on the plan
 * phase's log record. This component prints it and nothing else: it holds no
 * task ref, no date and no convention it could rebuild a path from. A plan
 * phase that recorded no path, or a file that cannot be read, is a first-class
 * state here — `docs/HANDOFF.md` notes that nothing checks the plan file exists
 * and that this component is where that shows up — and in both cases Approve is
 * disabled, because approving a plan nobody can read is worse than a dead end.
 *
 * ## Markdown is agent-written, so it is rendered inert
 *
 * `react-markdown` with no `rehype-raw` and no `skipHtml`: raw HTML arrives as
 * literal text, so `<script>alert(1)</script>` is five visible words and a plan
 * that discusses a `<Button>` still reads as written. Nothing is dropped, which
 * matters more here than anywhere — this is the document a human is being asked
 * to approve, and silently deleting part of it is the worst defect this file
 * could have. Links keep react-markdown's default `urlTransform`, which empties
 * a `javascript:` URL; an emptied URL renders as plain text rather than as an
 * `<a href="">` that reloads the page. Images are never fetched: they render as
 * a labelled mono string. Long unbroken strings (paths, hashes, base64) wrap via
 * `overflow-wrap: anywhere` in the prose, the path chip and the file list, and
 * code blocks scroll on their own axis instead of widening the card.
 *
 * ## The focus ring belongs to the ground it sits on
 *
 * `outline-offset` is positive, so the ring is drawn **outside** the control, on
 * whatever is behind it. An earlier version of this project shipped an ink ring
 * on a coloured plate at 2.56:1 for exactly that reason. One ring colour is
 * declared here, `--kg-ring`, on the gate root, and nothing overrides it per
 * control; `test/ui/Gate.test.tsx` walks every focusable element's ancestors,
 * composites any translucent layers, and asserts 3:1 against the real computed
 * ground. The Shine Border on the answer box is decoration, not a focus
 * indicator — it is far below 3:1 — so the ring is drawn there too.
 *
 * ## Motion
 *
 * The beam, the shiny-text sweep, the blur-fade entrance, the pulse and the
 * cursor spotlight are all read off `prefers-reduced-motion` in JS and simply
 * not applied when it is set, as well as being guarded in CSS. A class that is
 * never added cannot animate, which is a stronger guarantee than a duration
 * override and is what the test asserts.
 */

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react"

/* The three keystroke predicates, imported rather than restated.
 *
 * They live in `Tree.tsx` because the tree owns the `[data-task-row]` contract
 * one of them reads, and because a second copy of a rule about when *not* to
 * act would drift from this one - and the direction it drifted in would be the
 * expensive one. The dependency is one-way: the tree knows nothing about the
 * gate. */
import { bareKeystroke, isTypingSurface, pointsAtATask } from "./Tree.tsx"
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react"
import Markdown from "react-markdown"
import type { Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { GATE_CSS } from "./gate.css.ts"

/* -------------------------------------------------------------------------- */
/* Props                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The plan file, as the run log describes it.
 *
 * Three states rather than a nullable string, because the two failures read
 * differently to a human: a plan phase that never recorded a path is a hole in
 * the run, and a recorded path that will not read is a hole in the repo.
 */
export type PlanSource =
  | { status: "loaded"; path: string; markdown: string }
  | { status: "unreadable"; path: string; why: string }
  | { status: "undictated" }

/** Which conversation is waiting. An answer goes back to the one that asked. */
export type AskingPhase = "plan" | "implement"

/** A plan is on the table. */
export interface GateShape {
  kind: "gate"
  /**
   * Which park this is.
   *
   * Anything that changes every time the run stops for the human: the index of
   * the phase record that parked it is enough, and `${runId}#${index}` is better.
   * It exists because the content cannot carry it. An agent can ask the same
   * question twice, in the same phase, in the same words — and a card that told
   * the two apart by their text alone would read the second one as a re-render of
   * the first, keep the "answer sent" state it was already in, and leave the
   * human with no composer and a wedged run.
   */
  waitId: string
  plan: PlanSource
  /**
   * The project's test command, printed verbatim: it is the promise Approve
   * makes - or `null`, meaning this project has none and the agent verifies
   * its own work.
   *
   * `null` is the store's own spelling (`Project.testCmd` is `string | null`),
   * and blanks fold into it rather than being printed, for the reason
   * `commandOf` below gives. A card that printed a blank would promise "kantan
   * runs    until the exit code says it passed", which is the one promise no
   * value of this field justifies - and it would make it at the moment a human
   * is deciding whether to let an agent change their repository.
   */
  testCommand: string | null
  /** Other files the planning step read. Collapsed, and omitted when empty. */
  filesRead?: readonly string[]
  /** How long the plan phase took, if the log has both ends of it. */
  planDurationMs?: number
  /** Spend so far on this run. */
  costUsd?: number
  /**
   * Accepted the plan.
   *
   * May return a promise, and **rejecting is how a refusal is reported**: the
   * card puts the controls back and shows the rejection's message. The server
   * refuses with `busy`, `dirty`, `wrong-state` or `unknown-run`, and answers
   * 503 while no machine is wired, so this is the normal path and not an edge.
   */
  onApprove: () => unknown
  /**
   * Resumes the planning conversation with the human's words, verbatim.
   * Rejects to report a refusal, as `onApprove` does; the draft is kept.
   */
  onFeedback: (text: string) => unknown
}

/**
 * The agent asked something and there is no plan.
 *
 * `onApprove` and `onFeedback` are declared `never` so that the call site
 * cannot hand this shape either one. TypeScript's excess-property check against
 * a union permits any property that exists in *some* member, so without these
 * two lines `<Gate kind="question" onApprove={…} />` would typecheck and look
 * supported.
 */
export interface QuestionShape {
  kind: "question"
  /**
   * Which park this is.
   *
   * Anything that changes every time the run stops for the human: the index of
   * the phase record that parked it is enough, and `${runId}#${index}` is better.
   * It exists because the content cannot carry it. An agent can ask the same
   * question twice, in the same phase, in the same words — and a card that told
   * the two apart by their text alone would read the second one as a re-render of
   * the first, keep the "answer sent" state it was already in, and leave the
   * human with no composer and a wedged run.
   */
  waitId: string
  phase: AskingPhase
  /** The agent's own words, verbatim. Markdown, rendered inert. */
  question: string
  /** Preformatted, e.g. "asked at 18:22 · 9 min ago". The clock is the shell's. */
  askedAt?: string
  /**
   * Sends the human's words back into the conversation that asked, verbatim.
   * Rejects to report a refusal, as the gate's actions do; the draft is kept.
   */
  onAnswer: (text: string) => unknown
  onApprove?: never
  onFeedback?: never
}

export type GateProps = GateShape | QuestionShape

/* -------------------------------------------------------------------------- */
/* Motion preference                                                           */
/* -------------------------------------------------------------------------- */

const REDUCE_QUERY = "(prefers-reduced-motion: reduce)"

function matchReduce(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null
  return window.matchMedia(REDUCE_QUERY)
}

function subscribeReduce(onChange: () => void): () => void {
  const mql = matchReduce()
  if (!mql || typeof mql.addEventListener !== "function") return () => {}
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

function readReduce(): boolean {
  return matchReduce()?.matches ?? false
}

/**
 * Read straight from the media feature rather than from Motion's own hook,
 * which caches its answer for the life of the module and so cannot be exercised
 * by a test that sets the feature.
 */
function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduce, readReduce, () => false)
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—"
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

function formatCost(usd: number): string {
  if (!Number.isFinite(usd)) return "—"
  return `$${usd.toFixed(2)}`
}

function countLabel(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`
}

/**
 * The command this card may promise, or `null` for a project that has none.
 *
 * The dimension is the value of `testCommand`, and it takes four kinds of
 * value: a command, `null`, `""`, and whitespace. The store refuses `""`,
 * `"   "` and `"\t\n"` outright, so they cannot come from a valid record - but
 * this card is handed a prop by a shell that reads a tree over HTTP, and
 * `App.tsx` spells the null case `?? ""` on the way in. So the blanks arrive,
 * and they fold rather than being printed.
 *
 * The two directions are not symmetric. Printing a blank promises *"kantan
 * runs    until the exit code says it passed"* to a human who is deciding
 * whether to let an agent change their repository: they approve believing
 * something outside the agent will check the work. Folding a real command to
 * `null` would under-claim to someone who does have a suite, who is then more
 * careful than they needed to be and can read the command in the start panel
 * and the project settings anyway. Under-claiming is the cheap direction, so
 * that is the way this fails.
 *
 * The command is never trimmed for display: it is a shell string handed to
 * `sh -c` verbatim, so its spacing is the user's.
 *
 * Deliberately a local mirror of `commandOf` in `StartPanel.tsx`, not a shared
 * import: that one is module-private in a file another agent owns, and a third
 * module to hold six lines is not a thing anyone asked for. The two are kept
 * identical in behaviour, and both are tested against the same enumeration.
 */
function commandOf(testCommand: string | null | undefined): string | null {
  if (testCommand === null || testCommand === undefined) return null
  return testCommand.trim() === "" ? null : testCommand
}

/* -------------------------------------------------------------------------- */
/* Icons. Lucide shapes, as the artboards draw them.                           */
/* -------------------------------------------------------------------------- */

type IconProps = { className?: string; style?: CSSProperties }

function Icon({ children, className, style }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
    >
      {children}
    </svg>
  )
}

const CheckIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Icon>
)

const FileIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
  </Icon>
)

const ChevronIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m9 18 6-6-6-6" />
  </Icon>
)

const ReplyIcon = (p: IconProps) => (
  <Icon {...p}>
    <polyline points="9 14 4 9 9 4" />
    <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
  </Icon>
)

const SendIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
    <path d="m21.854 2.147-10.94 10.939" />
  </Icon>
)

const HelpIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
    <path d="M12 17h.01" />
  </Icon>
)

const InfoIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4" />
    <path d="M12 8h.01" />
  </Icon>
)

const AlertIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </Icon>
)

function Spinner({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={className}>
      <circle cx="12" cy="12" r="9" fill="none" stroke="#DCDCF6" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="#5B5BD6" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

/* -------------------------------------------------------------------------- */
/* Markdown                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Overrides for the two node types that would otherwise reach the network or
 * mislead. Everything else keeps react-markdown's own element, styled by the
 * `.kg-prose` rules below.
 */
/**
 * GitHub-flavoured markdown, because the plans this renders have tables in them.
 *
 * Measured rather than assumed: this repository's own plan documents carry 127
 * table rows and a task list between them, and the plan prompt tells the agent
 * the file is the whole handoff — so a plan that renders its steps as pipe soup
 * is the likely case, not the exotic one. GFM adds tables, task lists,
 * strikethrough and autolinks. It does **not** enable raw HTML, so the safety
 * story above is unchanged.
 */
const PROSE_PLUGINS = [remarkGfm]

const PROSE_COMPONENTS: Components = {
  /* Never fetched. The alt text and the URL are shown as text so the human can
   * see what the plan pointed at without the page requesting it. */
  img: ({ alt, src }) => (
    <span className="kg-inert">
      {`[image: ${typeof alt === "string" && alt.length > 0 ? alt : "no description"}`}
      {typeof src === "string" && src.length > 0 ? ` — ${src}` : ""}
      {"]"}
    </span>
  ),
  /* `urlTransform` empties a URL it refuses, e.g. `javascript:`. An `<a href="">`
   * would silently reload the page, so an emptied URL degrades to plain text and
   * the link's words survive. */
  a: ({ href, children }) =>
    typeof href === "string" && href.length > 0 ? (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    ) : (
      <span className="kg-inert">{children}</span>
    ),
}

/** The plan and the question go through the same pipeline: both are agent text. */
function AgentProse({ children }: { children: string }) {
  return (
    <Markdown remarkPlugins={PROSE_PLUGINS} components={PROSE_COMPONENTS}>
      {children}
    </Markdown>
  )
}

/* -------------------------------------------------------------------------- */
/* The component                                                               */
/* -------------------------------------------------------------------------- */

type Settled = null | "approved" | "sent-back"

/**
 * What to show when an action does not land.
 *
 * `src/server.ts` answers an approve or a feedback with a tagged refusal —
 * `busy`, `dirty`, `wrong-state`, `unknown-run`, or a 503 while no machine is
 * wired — and each carries a message written for a human. None of the artboards
 * draws this state, because they draw a run that behaves. A card that kept
 * saying "Approved. A fresh agent is implementing the plan." after the server
 * said no would be lying about the one decision this screen exists to take, so
 * the handlers may return a promise and a rejection puts the controls back.
 */
function describeRefusal(err: unknown): string {
  if (err instanceof Error && err.message.trim() !== "") return err.message
  if (typeof err === "string" && err.trim() !== "") return err
  return "The server refused it and did not say why. The run record may have more."
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as PromiseLike<unknown>).then === "function"
}

export function Gate(props: GateProps) {
  const reduce = useReducedMotion()
  const ids = useId()
  const headingId = `kg-h-${ids}`

  /* The action the human has taken in this render tree, so the card can answer
   * immediately and each action can fire exactly once. The run's real state
   * lives on the server; this only covers the moment between the click and the
   * run moving on. */
  const [settled, setSettled] = useState<Settled>(null)
  const [reply, setReply] = useState("")
  const [answer, setAnswer] = useState("")

  /**
   * Whatever the human has done applies to *this* plan or *this* question, so
   * new content clears it.
   *
   * Without this, a tree that was an approved gate and is then handed a
   * question renders the question with the gate's "sent" state — no composer,
   * and a reply box still holding words written about a different document. The
   * shell is not obliged to remount this card, and the design says only the
   * centre changes shape, so the reset has to live here. Identical props, which
   * is what polling produces, change nothing.
   */
  const signature =
    props.kind === "gate"
      ? `gate\u0000${props.waitId}\u0000${props.plan.status}\u0000${
          props.plan.status === "undictated" ? "" : props.plan.path
        }\u0000${props.plan.status === "loaded" ? props.plan.markdown : props.plan.status === "unreadable" ? props.plan.why : ""}`
      : `question\u0000${props.waitId}\u0000${props.phase}\u0000${props.question}`
  const [refused, setRefused] = useState<string | null>(null)
  const acted = useRef(false)
  /* Bumped whenever the card is handed a new park, so a promise from the
   * previous one cannot come back and undo this one's state. */
  const generation = useRef(0)
  const [seen, setSeen] = useState(signature)
  if (seen !== signature) {
    setSeen(signature)
    setSettled(null)
    setRefused(null)
    setReply("")
    setAnswer("")
    acted.current = false
    generation.current += 1
  }
  const replyRef = useRef<HTMLTextAreaElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const rafRef = useRef(0)

  const canApprove = props.kind === "gate" && props.plan.status === "loaded" && settled === null

  /**
   * One action, once.
   *
   * The latch is a ref rather than the `settled` state because a listener
   * registered by an effect outlives the render that queued the state change:
   * a second chord arriving in the same tick would read the old `settled` and
   * fire again. A ref is updated the moment the first one is accepted.
   */
  const fire = useCallback((optimistic: Settled, action: () => unknown) => {
    if (acted.current) return
    acted.current = true
    const token = generation.current
    setSettled(optimistic)
    setRefused(null)
    const undo = (err: unknown) => {
      /* The card has moved on to another park; this refusal is about a decision
       * that is no longer on screen, and applying it would wipe the new one. */
      if (generation.current !== token) return
      acted.current = false
      setSettled(null)
      setRefused(describeRefusal(err))
    }
    try {
      const result = action()
      if (isPromiseLike(result)) void result.then(undefined, undo)
    } catch (err) {
      undo(err)
    }
  }, [])

  const approve = useCallback(() => {
    if (props.kind !== "gate" || props.plan.status !== "loaded") return
    const act = props.onApprove
    fire("approved", act)
  }, [props, fire])

  const sendBack = useCallback(() => {
    if (props.kind !== "gate") return
    if (reply.trim() === "") return
    const act = props.onFeedback
    /* Verbatim. The human's words are the next turn of a conversation, so
     * trimming or reflowing them would edit what the agent reads. The draft is
     * also kept in state, so a refusal hands it back rather than losing it. */
    fire("sent-back", () => act(reply))
  }, [props, reply, fire])

  const sendAnswer = useCallback(() => {
    if (props.kind !== "question") return
    if (answer.trim() === "") return
    const act = props.onAnswer
    fire("sent-back", () => act(answer))
  }, [props, answer, fire])

  /**
   * `a` and ⌘↵ / Ctrl+↵ approve — and neither may do so while the human is
   * writing an objection, which is the one input where their intent is the
   * opposite.
   *
   * Two keystrokes, one set of guards, because the cost of being wrong is the
   * same for both: approving by accident starts an implementation run on a plan
   * nobody agreed to, and refusing by accident costs one click on a button that
   * is on screen. **Every uncertain case fails toward refusing.**
   *
   * The dimensions, enumerated:
   *
   * - **The keystroke.** `bareKeystroke` owns the letter: it is the one place
   *   in this app that decides when a single character is a command rather than
   *   text, and it reads the target, the modifiers, `isComposing` and
   *   `defaultPrevented`. The chord's own shape is checked here, and then runs
   *   through the same target test — through the same predicate, so the two can
   *   no longer disagree about what counts as a text box.
   * - **`event.repeat`.** Refused for both. A held key is as likely to be a
   *   stuck one or an elbow as an intention, and neither action is worth
   *   repeating.
   * - **The target.** The reply box, any other typing surface, a task row other
   *   than the current one, or anything else. Only the last approves. In the
   *   reply box the *chord* sends the reply, which is what submitting a
   *   composer means, and does nothing at all when it is empty; the *letter*
   *   there is a letter, and is left alone so it reaches the box.
   * - **A draft.** A reply in progress is an objection, so neither keystroke
   *   approves while one exists.
   *
   * Registered only while there is something to approve, and torn down by the
   * effect's own cleanup. That is what makes the question shape unapprovable
   * even in a tree that was the gate a moment ago: the listener is gone before
   * the question renders.
   */
  useEffect(() => {
    if (!canApprove) return
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.repeat) return
      const target = event.target

      /* Something nearer the keystroke already acted on it: a dialog, or the
       * app-wide shortcuts. Two handlers for one chord is one too many.
       * `bareKeystroke` makes the same check for the letter. */
      const chord =
        !event.defaultPrevented &&
        !event.isComposing &&
        event.key === "Enter" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey
      const letter = bareKeystroke(event) === "a"
      if (!chord && !letter) return

      if (chord && target === replyRef.current) {
        if (reply.trim() === "") return
        event.preventDefault()
        sendBack()
        return
      }
      /* A draft in the reply box is an objection in progress, and approving
       * would implement the plan it objects to and throw the words away. The
       * chord does nothing while one exists; Send back is a tab away, and so is
       * clearing the box. Refusing costs a click, approving costs a run. */
      if (reply.trim() !== "") return
      /* `j` moves focus through the tree without selecting, so focus can sit on
       * a task the gate is not showing - and `aria-current` cannot tell us
       * whether this card has caught up with the selection, only what the tree
       * thinks. So no keystroke raised on a task row approves, selected or not.
       * It costs a Tab; the alternative costs a run on the wrong plan. */
      if (pointsAtATask(target)) return
      if (chord && isTypingSurface(target)) return
      event.preventDefault()
      approve()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [canApprove, reply, approve, sendBack])

  /* Magic Card's spotlight. A gradient that chases the cursor is motion, so it
   * is not wired up at all under a reduced-motion preference. */
  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    },
    [],
  )

  const onCardMouseMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    const card = cardRef.current
    if (!card || reduce) return
    const rect = card.getBoundingClientRect()
    const x = Math.round(event.clientX - rect.left)
    const y = Math.round(event.clientY - rect.top)
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      card.style.setProperty("--kg-mx", `${x}px`)
      card.style.setProperty("--kg-my", `${y}px`)
    })
  }

  const fade = reduce ? "" : " kg-fade"

  if (props.kind === "question") {
    const agent = props.phase === "plan" ? "Planning agent" : "Implementing agent"
    const nothing =
      props.phase === "plan"
        ? "There is no plan yet, so there is nothing to approve. Your answer goes back into the same planning conversation and planning continues."
        : "This is a question from the work in progress, not a plan, so there is nothing to approve. Your answer goes back into the same implementation conversation and the work continues."
    /* The second half of the implement hint used to read "The tests still
       decide when it is done", which is the lede's over-claim in another
       place: a project may have no test command, and then nothing outside the
       agent decides anything. `QuestionShape` carries no command and has no
       reason to, so the sentence is made true of every project instead of
       conditioned on one. What was worth keeping is that an answer is not a
       sign-off, and that survives without naming a suite - while "records how
       it was verified" is exactly what `EndRecord.verifiedBy` now does on
       every finished run, whichever way it was checked. */
    const hint =
      props.phase === "plan"
        ? "Resumes planning. No code is written until you approve a plan."
        : "Resumes the implementation. Answering is not signing off: the run still has to finish, and it records how it was verified."
    const resumed =
      props.phase === "plan"
        ? "Planning resumed. You'll be asked to approve the plan when it's ready."
        : "Answer sent. The implementation continues from here."

    return (
      <section className={`kg kg-ask${fade}`} aria-labelledby={headingId}>
        <style href="kantan-gate" precedence="medium">
          {GATE_CSS}
        </style>

        <div className="kg-ask-head">
          <span aria-hidden="true" className="kg-avatar">
            <span />
          </span>
          <span className="kg-who">
            {/* The artboard's byline is the agent's name alone; what it *is* is
                carried visually by the speech bubble and the "A question, not a
                plan" pill beside it. Neither of those reaches a screen reader
                from the heading, and this heading is the card's accessible
                name, so the rest of the sentence stays in the DOM and is hidden
                from sight only. */}
            <h1 id={headingId} className="kg-who-name">
              {agent}
              <span className="kg-visually-hidden"> asked a question</span>
            </h1>
            {props.askedAt ? <span className="kg-mono kg-who-when">{props.askedAt}</span> : null}
          </span>
          <span className="kg-ask-pill">
            <HelpIcon />
            A question, not a plan
          </span>
        </div>

        {/* The agent's own words, rendered inert: no raw HTML, no fetched
            images, no live `javascript:` links. */}
        <div className={`kg-bubble${reduce ? "" : " kg-pop"}`}>
          <AgentProse>{props.question}</AgentProse>
        </div>

        {settled === null ? (
          <>
            <p className="kg-nothing">
              <InfoIcon />
              <span>{nothing}</span>
            </p>
            <div className="kg-composer">
              {refused !== null ? <Refusal did="Not sent." message={refused} /> : null}
              <label className="kg-composer-label" htmlFor={`kg-answer-${ids}`}>
                Your answer
              </label>
              <div className={`kg-shineframe${reduce ? "" : " kg-shineframe-anim"}`}>
                <div className="kg-composer-inner">
                  <textarea
                    id={`kg-answer-${ids}`}
                    className="kg-answer"
                    rows={3}
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    onKeyDown={(e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault()
                        sendAnswer()
                      }
                    }}
                    placeholder="Answer in your own words, e.g. Persist it. Losing a queued write is worse than a migration."
                  />
                  <div className="kg-composer-foot">
                    <span className="kg-composer-hint">{hint}</span>
                    <button type="button" className="kg-send" onClick={sendAnswer} disabled={answer.trim() === ""}>
                      <SendIcon />
                      Send answer
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </>
        ) : (
          <>
            <p className={`kg-mine${reduce ? "" : " kg-pop"}`}>{answer}</p>
            <p className={`kg-resumed${reduce ? "" : " kg-pop"}`} role="status">
              <Spinner className={reduce ? "" : "kg-spin"} />
              {resumed}
            </p>
          </>
        )}
      </section>
    )
  }

  /* --- the gate -------------------------------------------------------- */

  const { plan, testCommand, filesRead, planDurationMs, costUsd } = props
  const command = commandOf(testCommand)
  const loaded = plan.status === "loaded"
  const planPath = plan.status === "undictated" ? null : plan.path
  const whyId = `kg-why-${ids}`

  const eyebrow = loaded ? "Plan ready · waiting for you" : "Waiting for you · no plan to read"
  const heading = loaded
    ? "Is this plan right?"
    : plan.status === "unreadable"
      ? "The plan file will not open"
      : "This run recorded no plan file"

  const meta: string[] = []
  if (planDurationMs !== undefined) meta.push(`Planned in ${formatDuration(planDurationMs)}`)
  if (costUsd !== undefined) meta.push(formatCost(costUsd))

  const beamClass = settled === null ? (reduce ? "" : " kg-beam") : " kg-calm"

  return (
    <section className={`kg kg-beamframe${beamClass}${fade}`} aria-labelledby={headingId}>
      <style href="kantan-gate" precedence="medium">
        {GATE_CSS}
      </style>

      <div className="kg-card" ref={cardRef} onMouseMove={onCardMouseMove}>
        <div className="kg-head">
          <div className="kg-eyebrow">
            <span aria-hidden="true" className={`kg-dot${reduce || settled !== null ? "" : " kg-pulse"}`} />
            <span className={`kg-shiny${reduce || settled !== null ? "" : " kg-shiny-anim"}`}>{eyebrow}</span>
          </div>
          <h1 id={headingId} className="kg-h1">
            {heading}
          </h1>
          {loaded ? (
            /* The promise Approve makes, and the one sentence on this card that
               must be true of the project in front of the person reading it.
               With a command it is kantan's own claim, checkable from outside
               the agent; with none there is no exit code to promise, and the
               honest sentence says so rather than borrowing the language of a
               run that passed. The wording of the second is
               `StartPanel.tsx`'s, because the two cards are read minutes apart
               by the same person. */
            <p className="kg-lede">
              Read it the way you would read a teammate's draft. If you approve, a fresh agent implements it
              {command === null ? (
                <>
                  , then verifies its own work and records how it did — this project has no test command, so nothing
                  outside the agent will check it.
                </>
              ) : (
                <>
                  , and kantan runs <code className="kg-mono">{command}</code> until the exit code says it passed.
                </>
              )}
            </p>
          ) : (
            <p className="kg-lede" id={whyId}>
              {plan.status === "unreadable"
                ? `There is nothing to approve until the file at the recorded path can be read. ${plan.why}`
                : "The planning step finished without recording where it wrote the plan, so there is no file to show and nothing to approve."}{" "}
              Reply below to resume the planning conversation, or stop the run.
            </p>
          )}

          <div className="kg-chips">
            {planPath !== null ? (
              /* The dictated path, verbatim. There is nothing here to rebuild
                 one from, and that is deliberate. */
              <span className="kg-mono kg-chip-path" data-testid="kg-plan-path">
                <FileIcon className="kg-chip-icon" />
                {planPath}
              </span>
            ) : null}
            {/* Sans, not mono, which is what the artboard draws for this chip
                and the one case where DESIGN.md's "mono for every machine
                value" does not apply: a duration and a cost rounded for a
                human are prose about the run, not values to be read off
                character by character. The dictated path beside it stays mono. */}
            {meta.length > 0 ? <span className="kg-chip">{meta.join(" · ")}</span> : null}
          </div>
        </div>

        {plan.status === "loaded" ? (
          <article className="kg-prose" data-plan-path={plan.path}>
            <AgentProse>{plan.markdown}</AgentProse>
          </article>
        ) : (
          <p className="kg-missing">
            <AlertIcon style={{ width: 18, height: 18, flex: "none", marginTop: 1 }} />
            <span>
              {plan.status === "unreadable" ? (
                <>
                  kantan looked for the plan where the run log says the agent was told to write it, and could not read
                  it.
                  <span className="kg-mono kg-missing-path">{plan.path}</span>
                </>
              ) : (
                <>
                  The plan phase's log record carries no path. kantan will not guess one by convention, because a
                  guessed path can find a different run's plan.
                </>
              )}
            </span>
          </p>
        )}

        {/* Collapsed by default, and absent when there is nothing in it: an
            expander that opens onto an empty list is worse than no expander. */}
        {filesRead && filesRead.length > 0 ? (
          <FilesTouched files={filesRead} id={`kg-files-${ids}`} reduce={reduce} />
        ) : null}

        <div className="kg-actions">
          {refused !== null ? <Refusal did="Not done." message={refused} /> : null}
          {settled === null ? (
            <>
              <div className="kg-reply">
                <label className="kg-label" htmlFor={`kg-note-${ids}`}>
                  Not quite? Reply to the draft
                </label>
                <div className="kg-reply-row">
                  <textarea
                    id={`kg-note-${ids}`}
                    ref={replyRef}
                    className="kg-textarea"
                    /* Two, not the artboard's one: see `.kg-textarea`. One row
                       cuts this placeholder in half in the app's column. */
                    rows={2}
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    placeholder="e.g. Keep unknown fields under row.meta instead of dropping them"
                  />
                  <button type="button" className="kg-send-back" onClick={sendBack} disabled={reply.trim() === ""}>
                    <ReplyIcon style={{ width: 15, height: 15, flex: "none" }} />
                    Send back
                  </button>
                </div>
              </div>
              <button
                type="button"
                className="kg-approve"
                onClick={approve}
                disabled={!loaded}
                /* Advertised only while the listener is actually registered:
                   announcing a shortcut that does nothing is worse than none. */
                aria-keyshortcuts={loaded ? "a Meta+Enter Control+Enter" : undefined}
                /* `aria-keyshortcuts` tells a screen reader about `a`; nothing
                   told anyone else, because the artboard draws the chord's chip
                   alone and a visual pass rightly restored that. A shortcut
                   that starts an implementation run should not be a secret
                   from the person most likely to press it, so the hint lives
                   here instead: no pixels, no second chip, still findable. */
                title={loaded ? "Approve plan — press A, or ⌘↵" : undefined}
                aria-describedby={loaded ? undefined : whyId}
              >
                <CheckIcon className="kg-approve-icon" />
                Approve plan
                {/* One chip, the chord, exactly as `Main.dc.html` draws it.
                    An earlier version printed a second chip for the bare `a`
                    shortcut, on the argument that a key which can start an
                    implementation run should be visible. That was an addition
                    to the approved artboard and the user has since asked for
                    the artboard. The shortcut itself is unchanged and both keys
                    are still announced through `aria-keyshortcuts` below, which
                    costs no pixels. */}
                <span className="kg-mono kg-kbd">⌘↵</span>
              </button>
            </>
          ) : (
            <p className={`kg-settled${fade}`} role="status">
              <Spinner className={`kg-settled-icon${reduce ? "" : " kg-spin"}`} />
              <span className="kg-settled-main">
                {settled === "approved"
                  ? "Approved. A fresh agent is implementing the plan."
                  : "Sent back. The planning conversation has your reply."}
              </span>
              <span className="kg-settled-aside">You can leave. This tab will call you back.</span>
            </p>
          )}
        </div>
      </div>
    </section>
  )
}

/** What the server said when it would not take the action. */
function Refusal({ message, did }: { message: string; did: string }) {
  return (
    <p className="kg-refused" role="alert">
      <AlertIcon />
      <span>
        <strong>{did}</strong> {message}
      </span>
    </p>
  )
}

/** shadcn's Collapsible, by hand: a button, `aria-expanded`, and a panel. */
function FilesTouched({
  files,
  id,
  reduce,
}: {
  files: readonly string[]
  id: string
  reduce: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="kg-files">
      <button
        type="button"
        className="kg-files-toggle"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={id}
      >
        <ChevronIcon className={`kg-files-chev${open ? " kg-files-chev-open" : ""}`} />
        Planning also read {countLabel(files.length, "file", "files")}
        <span className="kg-mono kg-files-note">read-only</span>
      </button>
      <ul className={`kg-mono kg-files-list${reduce ? "" : " kg-fade"}`} id={id} hidden={!open}>
        {files.map((file, index) => (
          /* Indexed, because a run log can name the same file twice and the
             list is a record of what happened, not a set. */
          <li key={`${index}-${file}`}>{file}</li>
        ))}
      </ul>
    </div>
  )
}
