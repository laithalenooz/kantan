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
  /** The project's test command, printed verbatim: it is the promise Approve makes. */
  testCommand: string
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
/* Styles                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Scoped CSS rather than Tailwind utilities, for three reasons that are all
 * load-bearing:
 *
 *  - The gate needs `@property`, a conic-gradient beam, counter-numbered plan
 *    steps and a cursor-tracked radial spotlight. None are expressible as
 *    utilities.
 *  - The prose styles would otherwise want `@tailwindcss/typography`, which has
 *    to be registered in `src/ui/tokens.css`. That file belongs to someone else.
 *  - Every ground a focus ring can land on has to resolve to a real colour in a
 *    test. Utilities resolve through Tailwind's compiler, which does not run in
 *    `bun test`; these declarations resolve through the token layer, which the
 *    test reads from `tokens.css`.
 *
 * Token names come from `src/ui/tokens.css`. Literal hexes appear only where the
 * artboard uses a value the token layer does not name.
 *
 * ## Why this does not use `src/ui/artboard.css`
 *
 * That file now carries the artboards' own classes — `.beam`, `.shiny`, `.bf`,
 * `.plan` — and `main.tsx` loads it. The gate deliberately keeps its own copy of
 * those four effects, for two reasons that were measured rather than assumed:
 *
 *  - **`.beam` bundles paint and motion into one class.** It declares the
 *    conic-gradient border *and* `animation: kbeam …, kfade …`. The artboard can
 *    do that because it stops motion with `.kr * { animation: none }`, keeping
 *    the class. This component is required to withhold the animated class in JS
 *    instead — three tests assert its absence under the media feature, and
 *    `CLAUDE.md` explains why a class that is never added beats a duration
 *    override. Withholding `.beam` would take the border away with the
 *    animation and leave the card with no edge at all, so the two are split here
 *    into `.kg-beamframe` (the edge) and `.kg-beam` (the motion).
 *  - **`.plan ol li` is a two-column grid that assumes one child.** The artboard
 *    hand-wraps each step in a single `<span>`; `react-markdown` emits the text,
 *    every `<code>` and every `<strong>` as siblings, and each becomes its own
 *    grid item. Measured by the agent that wrote `artboard.css`: a step renders
 *    105px tall in a 273.5px column instead of 27px in a 618px one — the
 *    one-word-per-line defect `CLAUDE.md` already records. `.kg-prose` positions
 *    the marker absolutely instead, which has no opinion about how many children
 *    a list item has. Measured side by side against the artboard at a 1440px
 *    viewport, the first step comes out 698.8 x 52.7 in both, so this is a
 *    different implementation of the same drawing, not a different drawing.
 *
 * The element rules in `artboard.css` (`button { font: inherit }`,
 * `textarea { font: inherit }`, the placeholder colour, `a { color: … }`) agree
 * with what this stylesheet sets, and they sit in `@layer base` while this is
 * unlayered, so the two do not fight.
 */
const GATE_CSS = `
@property --kg-a { syntax: "<angle>"; initial-value: 0deg; inherits: false; }
@property --kg-s { syntax: "<angle>"; initial-value: 0deg; inherits: false; }

@keyframes kg-beam { to { --kg-a: 360deg; } }
@keyframes kg-shineborder { to { --kg-s: 360deg; } }
@keyframes kg-fade {
  from { opacity: 0; transform: translateY(10px); filter: blur(6px); }
  to { opacity: 1; transform: none; filter: blur(0); }
}
@keyframes kg-pop {
  from { opacity: 0; transform: translateY(8px) scale(.98); }
  to { opacity: 1; transform: none; }
}
@keyframes kg-pulse {
  0% { box-shadow: 0 0 0 0 rgba(255,106,26,.55); }
  70% { box-shadow: 0 0 0 9px rgba(255,106,26,0); }
  100% { box-shadow: 0 0 0 0 rgba(255,106,26,0); }
}
@keyframes kg-shine {
  from { background-position: 150% 0; }
  to { background-position: -50% 0; }
}
@keyframes kg-spin { to { transform: rotate(360deg); } }

/* --- the one ring, and the ground rule ---------------------------------- */

.kg {
  /* Local aliases for the token layer, each carrying the artboard's literal as
     its fallback. Two reasons, both load-bearing: this stylesheet then renders
     correctly even if it is ever mounted without tokens.css, and every colour
     in it resolves under bun test, where Tailwind's compiler does not run —
     which is what lets the focus-ring test measure a real ground instead of
     measuring nothing and passing. test/ui/Gate.test.tsx fails if a colour
     here ever references a token without a fallback. */
  --kg-ink: var(--color-ink, #111216);
  --kg-ink-deep: var(--color-ink-deep, #1e2026);
  --kg-ink-soft: var(--color-ink-soft, #26272d);
  --kg-ink-hover: var(--color-ink-hover, #2a2b31);
  --kg-ground: var(--color-ground, #f4f4f6);
  --kg-panel: var(--color-panel, #fafafb);
  --kg-panel-2: var(--color-panel-2, #f0f0f3);
  --kg-panel-3: var(--color-panel-3, #f1f1f4);
  --kg-hairline: var(--color-hairline, #eeeef1);
  --kg-edge: var(--color-edge, #e7e7eb);
  --kg-edge-strong: var(--color-edge-strong, #dcdce2);
  --kg-muted-900: var(--color-muted-900, #3a3d45);
  --kg-muted-700: var(--color-muted-700, #4a4e59);
  --kg-muted-500: var(--color-muted-500, #5f6370);
  --kg-muted-400: var(--color-muted-400, #6b7080);
  --kg-muted-300: var(--color-muted-300, #a3a7b1);
  --kg-attention: var(--color-attention, #ff6a1a);
  --kg-attention-tint: var(--color-attention-tint, #fff1e8);
  --kg-attention-ink: var(--color-attention-ink, #9a3b06);
  --kg-indigo: var(--color-indigo, #5b5bd6);
  --kg-indigo-deep: var(--color-indigo-deep, #4b4bc8);
  --kg-indigo-deeper: var(--color-indigo-deeper, #3a3aa8);
  --kg-indigo-tint: var(--color-indigo-tint, #dcdcf6);
  --kg-fail: var(--color-fail, #d92d3a);

  /* The card and the composer are white in the artboard; the token layer names
     no white, so this is the one surface colour declared here outright. */
  --kg-paper: #ffffff;

  /* One ring for the whole gate, and no control overrides it. outline-offset
     is positive, so the ring lands on the ground BEHIND the control: an ink ring
     is 19:1 on the card and on the action bar, where a paper-coloured one would
     be invisible. Re-declaring this per control is how the earlier version of
     this project shipped 2.56:1. */
  --kg-ring: var(--kg-ink);
}

/* Mouse focus on a textarea should not draw the UA ring next to ours. The
   :focus-visible rule below re-adds a ring for keyboard focus and must stay
   after this one, since both have the same specificity. */
.kg textarea:focus { outline-style: none; }

.kg button:focus-visible,
.kg textarea:focus-visible,
.kg a:focus-visible,
.kg [tabindex]:focus-visible {
  outline-width: 2px;
  outline-style: solid;
  outline-color: var(--kg-ring);
  outline-offset: 2px;
}

/* --- shared ------------------------------------------------------------- */

.kg { font-family: var(--font-sans, ui-sans-serif, system-ui, sans-serif); color: var(--kg-ink); }
.kg-mono { font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
.kg-inert { overflow-wrap: anywhere; }
/* Tailwind names this "sr-only", and the tree and the sidebar use that. Declared
   here instead for the reason the rest of this stylesheet exists: Tailwind's
   compiler does not run under "bun test", so a utility class is simply absent
   there, and a rule this file depends on has to resolve where this file is
   tested. */
.kg-visually-hidden {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
}
.kg-fade { animation: kg-fade .7s cubic-bezier(.2,.7,.2,1) both; }
.kg-pop { animation: kg-pop .5s cubic-bezier(.2,.7,.2,1) both; }
.kg-pulse { animation: kg-pulse 1.8s ease-out infinite; }
.kg-spin { animation: kg-spin .9s linear infinite; transform-origin: 50% 50%; }

/* --- Border Beam -------------------------------------------------------- */

.kg-beamframe {
  padding: 1.5px;
  border-radius: 24px;
  background-color: #e8e3de;
  box-shadow:
    0 1px 2px rgba(17,18,22,.04),
    0 18px 50px -18px rgba(17,18,22,.18),
    0 40px 90px -50px rgba(255,106,26,.35);
}
.kg-beam {
  background-image: conic-gradient(
    from var(--kg-a),
    transparent 0deg 200deg,
    #ffd2b3 270deg,
    var(--kg-attention) 330deg,
    transparent 360deg
  );
  animation: kg-beam 5s linear infinite;
}
/* Once the decision is made the beam stops asking for one. */
.kg-calm { background-color: #dcefe6; background-image: none; animation: none; }

/* --- Magic Card --------------------------------------------------------- */

.kg-card {
  --kg-mx: -600px;
  --kg-my: -600px;
  border-radius: 22.5px;
  overflow: clip;
  background-color: var(--kg-paper);
  background-image: radial-gradient(
    560px circle at var(--kg-mx) var(--kg-my),
    rgba(255,106,26,.07),
    transparent 45%
  );
}

/* --- gate head ---------------------------------------------------------- */

.kg-head {
  padding: 32px clamp(20px,4vw,44px) 26px;
  border-bottom: 1px solid var(--kg-hairline);
  /* No background-colour. The artboard's head is a warm gradient over a
     transparent base, so the Magic Card spotlight on .kg-card beneath shows
     through it; painting the head white as well occluded the spotlight over
     the whole top third of the card, which is exactly where the cursor is when
     someone starts reading. */
  background-image: linear-gradient(180deg, #fff8f3 0%, rgba(255,255,255,0) 100%);
}
.kg-eyebrow { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.kg-dot { width: 10px; height: 10px; border-radius: 50%; background-color: var(--kg-attention); flex: none; }
.kg-shiny {
  font-size: 13px; font-weight: 620; letter-spacing: .02em;
  color: var(--kg-attention-ink);
}
.kg-shiny-anim {
  background-image: linear-gradient(90deg,
    var(--kg-attention-ink) 0%, var(--kg-attention-ink) 38%,
    #ff9a5e 50%,
    var(--kg-attention-ink) 62%, var(--kg-attention-ink) 100%);
  background-size: 250% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: kg-shine 3.2s linear infinite;
}
.kg-h1 {
  margin: 0;
  font-size: clamp(32px, 4vw, 46px);
  line-height: 1.05;
  font-weight: 650;
  letter-spacing: -.035em;
  text-wrap: balance;
}
.kg-lede {
  margin: 12px 0 0;
  max-width: 60ch;
  font-size: 15.5px;
  line-height: 1.6;
  color: var(--kg-muted-700);
  text-wrap: pretty;
}
.kg-lede code {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 13.5px; background-color: var(--kg-panel-3);
  border-radius: 6px; padding: 1px 5px;
}
.kg-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
.kg-chip {
  padding: 6px 10px; border-radius: 999px;
  background-color: var(--kg-panel-3);
  font-size: 12.5px; font-weight: 500; color: var(--kg-muted-900);
}
.kg-chip-path {
  display: inline-flex; align-items: center; gap: 6px; min-width: 0;
  padding: 6px 10px; border-radius: 999px;
  background-color: var(--kg-paper); border: 1px solid var(--kg-edge);
  font-size: 12px; color: #2a2c33; overflow-wrap: anywhere;
}
.kg-chip-icon { width: 13px; height: 13px; flex: none; color: var(--kg-muted-400); }

/* --- plan prose, per Main.dc.html .plan ---------------------------------- */

/* content-box, against the app's preflight, because the measure is the point.
 *
 * Tailwind's preflight sets box-sizing:border-box on everything, and this
 * rule is one of three here that pair a max-width with padding. Under
 * border-box the padding comes out of the 68ch instead of sitting beside it, so
 * the prose measured 610.8px against the artboard's 698.8px and every line of
 * the plan rewrapped - 88px narrower than the document a human is being asked
 * to approve was drawn to be. DESIGN.md names 68ch for this text specifically.
 * The artboard has no preflight and so is already content-box; this restores
 * the same sizing model rather than re-tuning the number to hide the symptom. */
.kg-prose {
  box-sizing: content-box;
  padding: 30px clamp(20px,4vw,44px) 8px;
  font-size: 15.5px; line-height: 1.7; color: #272930;
  max-width: 68ch;
  overflow-wrap: anywhere;
}
.kg-prose h1, .kg-prose h2, .kg-prose h3, .kg-prose h4 {
  font-size: 19px; line-height: 1.3; font-weight: 650;
  letter-spacing: -.015em; color: var(--kg-ink); margin: 32px 0 10px;
}
.kg-prose > :first-child { margin-top: 0; }
.kg-prose p { margin: 0 0 14px; text-wrap: pretty; }
.kg-prose code {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 13.5px;
  background-color: var(--kg-panel-3); border: 1px solid var(--kg-edge);
  border-radius: 6px; padding: 1px 5px;
}
.kg-prose pre {
  margin: 16px 0 18px; padding: 16px 18px;
  background-color: var(--kg-panel); border: 1px solid var(--kg-edge);
  border-radius: 14px; overflow-x: auto;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 13px; line-height: 1.65; color: #272930;
}
.kg-prose pre code { background: none; border: 0; padding: 0; font-size: inherit; }
/* The marker is positioned, never a grid or flex column. Markdown hands a list
   item a mix of text, <code> and <strong>, and each of those would become its
   own column in a grid: the artboard could use one because its content was a
   single hand-written <span>. The symptom is a word per line. */
.kg-prose ol {
  list-style: none; counter-reset: kgs; margin: 0 0 14px; padding: 0;
  display: flex; flex-direction: column; gap: 10px;
}
.kg-prose ol > li { counter-increment: kgs; position: relative; padding-left: 40px; min-height: 26px; }
.kg-prose ol > li::before {
  content: counter(kgs);
  position: absolute; left: 0; top: 0;
  display: grid; place-items: center;
  width: 26px; height: 26px; border-radius: 999px;
  background-color: var(--kg-ink); color: var(--kg-paper);
  font-size: 12.5px; font-weight: 600;
}
.kg-prose ul { margin: 0 0 14px; padding: 0; list-style: none; }
.kg-prose ul > li { position: relative; padding-left: 18px; margin-bottom: 8px; }
.kg-prose ul > li::before {
  content: ""; position: absolute; left: 2px; top: 11px;
  width: 6px; height: 6px; border-radius: 50%;
  background-color: var(--kg-muted-300);
}
.kg-prose li > ul, .kg-prose li > ol { margin-top: 8px; }
.kg-prose strong { font-weight: 620; color: var(--kg-ink); }
.kg-prose blockquote {
  margin: 16px 0; padding: 2px 0 2px 16px;
  border-left: 2px solid var(--kg-edge-strong); color: var(--kg-muted-700);
}
.kg-prose table {
  display: block; overflow-x: auto; max-width: 100%;
  border-collapse: collapse; margin: 0 0 16px; font-size: 14px;
}
.kg-prose th, .kg-prose td {
  border: 1px solid var(--kg-edge); padding: 7px 10px; text-align: left; vertical-align: top;
}
.kg-prose th { background-color: var(--kg-panel-3); font-weight: 620; }
/* A task list is a list of boxes, not a list of bullets. */
.kg-prose li:has(> input[type="checkbox"]) { padding-left: 0; }
.kg-prose li:has(> input[type="checkbox"])::before { content: none; }
.kg-prose li > input[type="checkbox"] { margin: 0 8px 0 0; accent-color: var(--kg-ink); }
.kg-prose del { color: var(--kg-muted-500); }
.kg-prose a { color: var(--kg-indigo-deep); overflow-wrap: anywhere; }
.kg-prose a:hover { color: var(--kg-indigo-deeper); }
.kg-prose img { max-width: 100%; }

/* --- missing plan ------------------------------------------------------- */

.kg-missing {
  display: flex; gap: 12px; align-items: flex-start;
  margin: 24px clamp(20px,4vw,44px) 8px;
  padding: 16px 18px; border-radius: 14px;
  background-color: var(--kg-attention-tint); border: 1px solid #ffd3b8;
  font-size: 14px; line-height: 1.6; color: #6b2c05;
}
.kg-missing-path { display: block; margin-top: 8px; overflow-wrap: anywhere; font-size: 12.5px; }

/* --- files touched (Collapsible) ---------------------------------------- */

.kg-files { padding: 8px clamp(20px,4vw,44px) 24px; }
.kg-files-toggle {
  display: flex; align-items: center; gap: 8px; width: 100%;
  min-height: 44px; padding: 0 14px;
  border-radius: 12px; border: 1px solid var(--kg-hairline);
  background-color: #fcfcfd; color: var(--kg-muted-900);
  font-size: 13.5px; font-weight: 550; text-align: left; cursor: pointer;
}
.kg-files-toggle:hover { background-color: #f6f6f8; }
.kg-files-chev { width: 14px; height: 14px; flex: none; transition: transform .2s; }
.kg-files-chev-open { transform: rotate(90deg); }
.kg-files-note { margin-left: auto; font-size: 12px; color: var(--kg-muted-400); font-weight: 400; }
.kg-files-list {
  list-style: none; margin: 8px 0 0; padding: 6px 14px;
  border-radius: 12px; background-color: var(--kg-panel); border: 1px solid var(--kg-hairline);
  font-size: 12.5px; color: var(--kg-muted-900);
  display: flex; flex-direction: column; gap: 6px;
}
.kg-files-list li { overflow-wrap: anywhere; }
/* display:flex on a class outranks the user agent's [hidden] rule, so the
   collapsed list rendered in full with its toggle still saying "closed".
   Caught by a screenshot, not by a test that only read the attribute. */
.kg-files-list[hidden] { display: none; }

/* --- the actions bar ---------------------------------------------------- */

.kg-actions {
  position: sticky; bottom: 0;
  padding: 20px clamp(20px,4vw,44px) 24px;
  background-color: rgba(251,251,252,.94);
  border-top: 1px solid var(--kg-hairline);
  display: flex; flex-wrap: wrap; align-items: flex-end; gap: 16px;
}
.kg-reply { flex: 1 1 380px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.kg-label { font-size: 13px; font-weight: 600; color: #2a2c33; }
.kg-reply-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-end; }
/* The artboard's composer, with one arithmetic fix.
 *
 * Measured on Main.dc.html itself at a 1440px viewport: scrollHeight 67
 * against clientHeight 46, so the artboard clips its own placeholder and shows
 * a scrollbar before a character is typed. Two causes, and both are fixed here
 * rather than reproduced:
 *
 *  - 48px box - 26px padding - 2px border leaves 20px for a 20.3px line, so
 *    even a single line overflowed. 12px padding leaves 22px and it fits.
 *  - The placeholder is two lines in this column, so the box is given two rows.
 *    That makes it ~18px taller at rest than the artboard draws it, which is
 *    the one place this component deliberately departs from the drawing: a
 *    control whose own example text is cut in half reads as broken, and the
 *    gate's column is narrower in the app than on the artboard, so the wrap is
 *    the common case rather than the edge.
 */
.kg-textarea {
  flex: 1 1 240px; min-height: 48px; resize: vertical;
  padding: 12px 16px; border-radius: 14px;
  border: 1px solid transparent; background-color: #efeff2;
  font: inherit; font-size: 14px; line-height: 1.45; color: var(--kg-ink);
  box-sizing: border-box;
}
.kg-textarea::placeholder { color: #7a7f8c; }
.kg-send-back {
  height: 48px; padding: 0 18px; border-radius: 999px;
  border: 1px solid #d9d9df; background-color: var(--kg-paper);
  color: var(--kg-ink-deep); font: inherit; font-size: 14px; font-weight: 560;
  display: inline-flex; align-items: center; gap: 8px; cursor: pointer;
}
.kg-send-back:hover:not(:disabled) { background-color: #f6f6f8; }
.kg-send-back:disabled { cursor: not-allowed; color: var(--kg-muted-300); border-color: var(--kg-edge); }
.kg-approve {
  height: 56px; padding: 0 22px 0 20px; border-radius: 999px; border: 0;
  background-color: var(--kg-ink); color: var(--kg-paper);
  font: inherit; font-size: 16px; font-weight: 620;
  display: inline-flex; align-items: center; gap: 10px; cursor: pointer;
  box-shadow: 0 10px 28px -10px rgba(17,18,22,.6), inset 0 1px 0 rgba(255,255,255,.16);
}
.kg-approve:hover:not(:disabled) { background-color: var(--kg-ink-hover); }
.kg-approve:disabled {
  background-color: var(--kg-panel-2); color: var(--kg-muted-400);
  box-shadow: none; cursor: not-allowed;
}
.kg-approve-icon { width: 18px; height: 18px; stroke-width: 2.5; flex: none; }
.kg-kbd {
  margin-left: 4px; padding: 3px 7px; border-radius: 7px;
  background-color: rgba(255,255,255,.14); font-size: 12px; font-weight: 500;
}
.kg-approve:disabled .kg-kbd { background-color: rgba(17,18,22,.06); }
.kg-refused {
  flex: 1 1 100%;
  display: flex; align-items: flex-start; gap: 10px;
  padding: 10px 12px; border-radius: 12px;
  background-color: var(--kg-paper); border: 1px solid var(--kg-fail);
  color: var(--kg-fail); font-size: 13.5px; line-height: 1.5;
}
.kg-refused svg { width: 16px; height: 16px; flex: none; margin-top: 1px; }
.kg-refused strong { font-weight: 620; }
.kg-refused span { min-width: 0; overflow-wrap: anywhere; }
.kg-settled {
  flex: 1; display: flex; flex-wrap: wrap; align-items: center; gap: 12px; min-height: 56px;
}
.kg-settled-icon { width: 20px; height: 20px; flex: none; }
.kg-settled-main { font-size: 16px; font-weight: 600; }
.kg-settled-aside { margin-left: auto; font-size: 13px; color: var(--kg-muted-500); }

/* --- the question shape ------------------------------------------------- */

.kg-ask {
  background-color: var(--kg-paper);
  border: 1px solid var(--kg-edge);
  border-radius: 24px;
  padding: 28px clamp(20px,4vw,40px) 30px;
  box-shadow: 0 1px 2px rgba(17,18,22,.04), 0 18px 50px -22px rgba(17,18,22,.2);
}
.kg-ask-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; }
.kg-avatar {
  width: 34px; height: 34px; border-radius: 11px; flex: none;
  background-image: linear-gradient(145deg, #2a2b31, #0e0f12);
  background-color: var(--kg-ink-soft);
  display: grid; place-items: center;
}
.kg-avatar span { width: 9px; height: 9px; border-radius: 50%; background-color: var(--kg-attention); }
.kg-who { display: flex; flex-direction: column; min-width: 0; }
.kg-who-name { font-size: 14.5px; font-weight: 620; margin: 0; }
.kg-who-when { font-size: 12px; color: var(--kg-muted-400); }
.kg-ask-pill {
  margin-left: auto; display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 11px; border-radius: 999px;
  border: 1px solid #cfd0f7; color: var(--kg-indigo-deeper);
  font-size: 12.5px; font-weight: 600;
}
.kg-ask-pill svg { width: 14px; height: 14px; flex: none; }
/* content-box for the same reason as .kg-prose: 640px is the speech bubble's
   measure in the artboard, with the padding outside it. */
.kg-bubble {
  box-sizing: content-box;
  margin: 16px 0 0; max-width: 640px;
  padding: 22px 26px 20px;
  border-radius: 6px 22px 22px 22px;
  background-color: #f3f3fe; border: 1px solid #e2e3fb;
  font-size: 15px; line-height: 1.65; color: #2f3140;
  overflow-wrap: anywhere;
}
.kg-bubble > :first-child { margin-top: 0; }
/* The question itself, at the artboard's #ask-h size. The agent writes the
   question as markdown, so it arrives as a leading paragraph far more often
   than as a heading; both are drawn as the heading the artboard draws. */
.kg-bubble > p:first-of-type {
  font-size: clamp(22px, 2.6vw, 28px); line-height: 1.2; font-weight: 640;
  letter-spacing: -.025em; color: #17174a; text-wrap: pretty; margin-bottom: 12px;
}
.kg-bubble h1, .kg-bubble h2, .kg-bubble h3 {
  font-size: clamp(22px, 2.6vw, 28px); line-height: 1.2; font-weight: 640;
  letter-spacing: -.025em; color: #17174a; margin: 0 0 12px;
}
.kg-bubble p { margin: 0 0 10px; }
.kg-bubble code {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 13px;
  background-color: var(--kg-paper); border: 1px solid #e2e3fb; border-radius: 6px; padding: 1px 5px;
}
.kg-bubble pre {
  margin: 12px 0; padding: 12px 14px; overflow-x: auto;
  background-color: var(--kg-paper); border: 1px solid #e2e3fb; border-radius: 12px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12.5px; line-height: 1.6;
}
.kg-bubble pre code { background: none; border: 0; padding: 0; }
.kg-bubble ul, .kg-bubble ol { margin: 0 0 12px; padding: 0; list-style: none; }
.kg-bubble ol { counter-reset: kgq; }
.kg-bubble li { position: relative; padding-left: 18px; margin-bottom: 8px; }
.kg-bubble li::before {
  content: ""; position: absolute; left: 0; top: 10px;
  width: 6px; height: 6px; border-radius: 50%;
  background-color: var(--kg-indigo);
}
.kg-bubble ol > li { counter-increment: kgq; padding-left: 22px; }
.kg-bubble ol > li::before {
  content: counter(kgq) ".";
  top: 0; left: 0; width: auto; height: auto; border-radius: 0;
  background: none; color: var(--kg-indigo-deeper); font-weight: 620; font-size: 13.5px;
}
.kg-bubble strong { font-weight: 620; color: #17174a; }
.kg-bubble a { color: var(--kg-indigo-deep); overflow-wrap: anywhere; }
.kg-nothing {
  display: flex; align-items: flex-start; gap: 10px;
  margin: 20px 0 14px; font-size: 13.5px; line-height: 1.5; color: var(--kg-muted-700);
}
.kg-nothing svg { width: 16px; height: 16px; flex: none; margin-top: 1px; color: var(--kg-muted-500); }
.kg-composer { margin-left: auto; max-width: 640px; }
.kg-composer-label { display: block; margin: 0 0 8px 4px; font-size: 13px; font-weight: 600; color: #2a2c33; }
/* Shine Border: decoration while the box has focus. Never the focus ring —
   #c7c8f6 on white is nowhere near 3:1. */
.kg-shineframe {
  padding: 1.5px; border-radius: 18px;
  background-color: var(--kg-indigo-tint);
}
.kg-shineframe-anim {
  background-image: conic-gradient(from var(--kg-s), #c7c8f6, #5b5bd6, #38bdf8, #a5b4fc, #c7c8f6);
  animation: kg-shineborder 6s linear infinite;
}
.kg-composer-inner { border-radius: 16.5px; background-color: var(--kg-paper); padding: 4px; }
.kg-answer {
  display: block; width: 100%; box-sizing: border-box;
  min-height: 96px; resize: vertical;
  padding: 12px 14px; border: 0; border-radius: 13px;
  background-color: #f7f7f9;
  font: inherit; font-size: 15px; line-height: 1.55; color: var(--kg-ink);
}
.kg-answer::placeholder { color: #7a7f8c; }
.kg-composer-foot {
  display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
  padding: 10px 8px 6px 10px;
}
.kg-composer-hint { font-size: 12.5px; color: var(--kg-muted-500); }
.kg-send {
  margin-left: auto; height: 44px; padding: 0 18px 0 16px;
  border-radius: 999px; border: 0;
  background-color: var(--kg-indigo-deep); color: var(--kg-paper);
  font: inherit; font-size: 14.5px; font-weight: 600;
  display: inline-flex; align-items: center; gap: 8px; cursor: pointer;
  box-shadow: 0 8px 20px -10px rgba(75,75,200,.8);
}
.kg-send svg { width: 15px; height: 15px; flex: none; }
.kg-send:hover:not(:disabled) { background-color: #3f3fb8; }
.kg-send:disabled { background-color: var(--kg-indigo-tint); color: #4a4e59; box-shadow: none; cursor: not-allowed; }
/* And the human's own reply bubble, the third max-width-plus-padding rule. */
.kg-mine {
  box-sizing: content-box;
  margin: 18px 0 0 auto; max-width: 560px;
  padding: 16px 20px; border-radius: 22px 6px 22px 22px;
  background-color: var(--kg-ink); color: var(--kg-ground);
  font-size: 15px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere;
}
.kg-resumed {
  display: flex; align-items: center; gap: 10px; margin-top: 16px;
  font-size: 14px; font-weight: 560; color: #20205e;
}
.kg-resumed svg { width: 16px; height: 16px; flex: none; }

/* The artboards guard every keyframe this way, and so does the token layer.
   The classes above are also withheld in JS when the feature is set; this is
   the belt to that braces, and covers a preference that changes mid-session
   before React has re-rendered. */
@media (prefers-reduced-motion: reduce) {
  .kg-beam, .kg-shineframe-anim, .kg-shiny-anim, .kg-fade, .kg-pop, .kg-pulse, .kg-spin {
    animation: none;
  }
  .kg-card { background-image: none; }
  .kg-files-chev { transition: none; }
}
`

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
    const hint =
      props.phase === "plan"
        ? "Resumes planning. No code is written until you approve a plan."
        : "Resumes the implementation. The tests still decide when it is done."
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
            <p className="kg-lede">
              Read it the way you would read a teammate's draft. If you approve, a fresh agent implements it, and
              kantan runs <code className="kg-mono">{testCommand}</code> until the exit code says it passed.
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
