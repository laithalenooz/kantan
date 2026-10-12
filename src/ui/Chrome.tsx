/**
 * The page chrome: the app bar, the breadcrumb, and the tab.
 *
 * `docs/design/Main.dc.html` is the specification — the header at line 54, the
 * breadcrumb at line 137 — and the markup below is **ported from it rather than
 * re-derived**. Every value is the artboard's own inline style, in the
 * artboard's own order, and the two classes it leans on (`.m` for the mono
 * face, `.ic` for the icon stroke preset) are the artboard's own class names,
 * supplied by `src/ui/artboard.css`.
 *
 * ## Four exports, because they sit in four places
 *
 * `<AppBar>` is the top of the page, above everything. `<NeedsYouBand>` is the
 * full-width strip directly beneath it. `<Breadcrumb>` is the first thing in
 * the centre column. `usePageAttention` is none of those: it writes the browser
 * tab.
 *
 * The bar and the breadcrumb are drawn byte-identically on all five artboards,
 * so neither has a state dimension and neither moves. The band is the opposite
 * on both counts, and it shares its slot with `src/ui/Digest.tsx`'s
 * `ReturnBand`: that one is the calm indigo band a **running** run gets, this
 * one is the solid `#FF6A1A` band a **parked** one gets, and `App.tsx` shows
 * exactly one at a time.
 *
 * ## Only this band moves, and the gate for it is in JS
 *
 * `.band` is `kband` (slide down from above, once) and `.pulsed` is `kpulsed`
 * (the ring that makes "needs you" findable across a room). Both are withheld
 * when the reader asked for less movement, and that decision cannot be left to
 * CSS or to Motion alone:
 *
 * - `src/ui/artboard.css`'s own `prefers-reduced-motion` block is scoped to
 *   `.kr`, so it suppresses nothing unless an ancestor this component cannot
 *   see carries that class.
 * - `<MotionConfig reducedMotion="user">` in `main.tsx` switches off transforms
 *   and leaves opacity, filter and anything hand-rolled running.
 * - Motion's `useReducedMotion()` is a module-level singleton seeded at the
 *   first call anywhere in the process and has answered `false` with the media
 *   feature actually set (`CLAUDE.md`, probed by three agents).
 *
 * So the preference is read live through `useSyncExternalStore` and OR'd with
 * Motion's answer. Either source can miss a yes; the OR cannot. A spurious yes
 * costs one animation nobody asked to stop, a missed yes costs the thing the
 * preference exists for, and the OR fails toward the cheap one.
 *
 * ## The origin is a prop, and that is the whole point of it
 *
 * The chip names **where kantan is**, which is what a second browser tab needs
 * in order to find it. `window.location` cannot answer that: in development the
 * page is served by Vite and the server is on another port, so the one source
 * the page could read itself is wrong exactly when the chip matters. So it is a
 * prop, and a test spies on the `location` getter to keep it one.
 *
 * Note for whoever wires this up: **nothing supplies that prop today.**
 * `GET /api/session` answers `{ok, dev}` and the origin is not in it, so the
 * value has to come from somewhere - most cheaply from that route's payload,
 * since `createServer` already knows its own port. Reported, not fixed: neither
 * `src/server.ts` nor `src/ui/App.tsx` is this file's.
 *
 * ## Paths and sentences are printed verbatim
 *
 * The artboard's breadcrumb prints `importer.md` for a file that is really
 * `docs/features/importer.md`. That shortening is deliberately **not** ported.
 * `src/runindex.ts` keys a task on (`projectPath`, `featureFile`, `taskRef`)
 * precisely because every feature file in a repo has a `T1` and two of them can
 * share a basename, so a breadcrumb printing the basename would name two
 * different tasks identically. DESIGN.md's third promise - paths over 150
 * characters wrap, never overflow or truncate invisibly - is what replaces it,
 * so each crumb carries the breaking rule and a zero minimum width instead.
 *
 * ## One writer for the tab
 *
 * `src/ui/Digest.tsx`'s `ReturnBand` deliberately sets neither
 * `document.title` nor the favicon, on the grounds that both are properties of
 * the page rather than of a strip in it and a second writer would fight whoever
 * owns them. `usePageAttention` is that owner, and it is the only one.
 *
 * It reads the same two inputs the band does and must not contradict it: a calm
 * band above a "Needs you" tab is worse than either reading alone, because the
 * reader cannot tell which to trust. The two rules are **not** the same rule,
 * though, and that is deliberate - the band decides whether to claim calm,
 * this decides whether to raise an alarm, and withholding a claim is not the
 * same act as making the opposite one. A contradiction test in
 * `test/ui/Chrome.test.tsx` renders both over the whole matrix and holds them
 * together.
 *
 * Everything this file borrows from `Digest.tsx` is **type-only**, so nothing
 * here depends on that module at runtime. That was not the first design: an
 * earlier draft read `parked` off its exported `stateReading`, "so the two
 * agree by construction". `StateReading.parked` was then deleted by its own
 * author mid-task, which turned the claim into a compile error. The lesson is
 * worth keeping: agreement between two agents' files is a test's job, not an
 * import's.
 */

import { Fragment, useEffect, useState, useSyncExternalStore, type ReactNode } from "react"
import { useReducedMotion } from "motion/react"

/* Type-only, all three. `src/runlog.ts` opens `node:fs/promises` at module
 * scope, so a value import would drag it into the browser bundle; the other two
 * are borrowed so a change to either is a compile error here rather than a
 * chrome that renders something else. */
import type { WaitReason } from "../runlog.ts"
import type { DigestSubject } from "./Digest.tsx"
import type { Account } from "./Tree.tsx"

/* -------------------------------------------------------------------------- */
/* Shared bits of the artboard                                                */
/* -------------------------------------------------------------------------- */

/**
 * The artboard's `.ic` preset, as attributes.
 *
 * `.ic` itself lives in `src/ui/artboard.css` and governs the size and
 * `flex:none`. The four presentation attributes are repeated on the element
 * because without them an icon is not merely unstyled, it is *wrong*: an
 * unstroked `<path>` renders as a filled black blob, which is a visible defect
 * rather than a missing polish. Size overrides stay inline, exactly as the
 * artboard writes them.
 */
const ICON = {
  className: "ic",
  "aria-hidden": true,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const

/** `Main.dc.html`: the crumb separator, at 14px in `#A3A7B1`. */
function Separator() {
  return (
    <svg {...ICON} data-separator="true" style={{ width: 14, height: 14, color: "#A3A7B1", flex: "none" }}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

/** Is there anything here a person could read? */
function present(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim() !== ""
}

/* -------------------------------------------------------------------------- */
/* Reduced motion                                                            */
/* -------------------------------------------------------------------------- */

/** Motion asks `(prefers-reduced-motion)`, which means the same thing. */
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

/** Does this person want less movement? See the file header for why it is two
 * sources OR'd rather than either one. */
function usePrefersReducedMotion(): boolean {
  const motionsAnswer = useReducedMotion() === true
  const live = useSyncExternalStore(subscribeToReducePreference, readReducePreference, () => false)
  return motionsAnswer || live
}

/* -------------------------------------------------------------------------- */
/* The app bar                                                               */
/* -------------------------------------------------------------------------- */

export interface AppBarProps {
  /**
   * Back to the screen with nothing selected. Absent leaves the mark inert.
   *
   * The artboard draws the mark and the word as decoration, and this port kept
   * them that way - which is the right default for a thing that does nothing,
   * and the wrong one here: a brand in the top-left corner of an app is the one
   * control every user already knows. Reported from use as "why is kantan not
   * clickable to take me to default initial page". There is no router and no
   * URL to go to, so this is the shell's own "clear the selection", which is
   * exactly what that initial page is.
   */
  onHome?: () => void
  /**
   * Where **kantan** is, spelled however the caller spells it, e.g.
   * `localhost:4317`.
   *
   * Printed verbatim. Stripping a scheme to match the artboard's authority-only
   * chip would be a normalising rule over a dimension - the shape of a URL -
   * with no bound on its values, and the caller is the only party that knows
   * which spelling a second tab should be given.
   *
   * Blank, absent or `null` prints no chip at all. A chip around nothing says
   * kantan is at nowhere and cannot be told apart from a styling fault; no chip
   * says plainly that nobody told the page.
   */
  origin?: string | null
  className?: string
}

export function AppBar({ origin, onHome, className }: AppBarProps) {
  return (
    <header
      className={className}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        height: 56,
        padding: "0 20px",
        background: "rgba(255,255,255,.86)",
        borderBottom: "1px solid #E7E7EB",
      }}
    >
      <span
        data-testid="mark"
        aria-hidden="true"
        style={{
          width: 26,
          height: 26,
          borderRadius: 8,
          background: "linear-gradient(145deg,#2A2B31,#0E0F12)",
          display: "grid",
          placeItems: "center",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,.14),0 2px 6px -2px rgba(17,18,22,.5)",
          flex: "none",
        }}
      >
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#FF6A1A" }} />
      </span>

      {onHome === undefined ? (
        <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-.025em" }}>kantan</span>
      ) : (
        <button
          type="button"
          data-testid="home"
          onClick={onHome}
          /* The word, not the mark beside it: the mark is `aria-hidden` and a
             button around a hidden graphic has no name. The word is the name. */
          className="ghost rounded-[8px] px-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo"
          style={{
            border: 0,
            background: "none",
            font: "inherit",
            fontSize: 17,
            fontWeight: 700,
            letterSpacing: "-.025em",
            color: "inherit",
            cursor: "pointer",
          }}
        >
          kantan
        </button>
      )}

      {present(origin) && (
        <span
          data-testid="origin-chip"
          className="m"
          style={{
            fontSize: 12,
            color: "#6B7080",
            padding: "3px 8px",
            borderRadius: 999,
            background: "#F1F1F4",
            overflowWrap: "anywhere",
            minWidth: 0,
          }}
        >
          {origin}
        </span>
      )}
    </header>
  )
}

/* -------------------------------------------------------------------------- */
/* The "Needs you" band                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What the run is waiting for, in a clause the band can finish a line with.
 *
 * The first two are the artboards' own words - `Main.dc.html` line 70 and
 * `Question.dc.html` line 59. `satisfies` rather than a type annotation so
 * that a `WaitReason` added later is a compile error here, while the read below
 * stays honest about the runtime gap.
 */
const WAITING_FOR = {
  gate: "the plan is ready for review",
  question: "the agent asked a question",
  blocked: "it is blocked and cannot go on",
  stalled: "the same failure three times",
} satisfies Record<WaitReason, string>

/**
 * The clause for a reason, or `null` for one this build does not know.
 *
 * The dimension is `WaitReason`, whose four values are above, plus a fifth:
 * whatever a newer writer puts in a `waiting` record. `src/ui/Digest.tsx` folds
 * an unknown reason to the gate's *reading*, on the grounds that something is
 * parked on a human either way - and that is right for a label. It is not right
 * for a clause. "The plan is ready for review" is a statement about what
 * happened, printed in 16px on the loudest element of the page, and a reader
 * has no way to falsify it. So an unknown reason loses the clause and keeps
 * everything that is still true: the headline, the task's name and the clock.
 */
function waitingFor(reason: WaitReason): string | null {
  /* Read through a widened type on purpose: with `Record<WaitReason, string>`
   * the lookup is typed `string` and the `?? null` would look like dead code to
   * the next reader, which is how the fifth value gets forgotten. */
  const clauses: Partial<Record<string, string>> = WAITING_FOR
  return clauses[reason] ?? null
}

/** `your-app · T2 Map records to rows — the plan is ready for review`. */
function bandSubject(
  project: string | null | undefined,
  taskRef: string | null | undefined,
  taskText: string | null | undefined,
  clause: string | null,
): string {
  const task = [taskRef, taskText].filter(present).join(" ")
  const named = [project, task].filter(present).join(" · ")
  if (clause === null) return named
  return named === "" ? clause : `${named} — ${clause}`
}

/** `2m 14s`, `9m`, `14s`, `1h 5m`. */
function waitedFor(elapsedMs: number): string {
  const total = Math.floor(elapsedMs / 1000)
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  /* A zero component is dropped, which is what satisfies both artboards
   * exactly: `Main.dc.html` reads "waiting 2m 14s" and `Question.dc.html`
   * reads "waiting 9m". Capped at hours deliberately - no days - so a start
   * time that is nonsense prints a number that looks like nonsense instead of
   * a plausible one. */
  if (hours > 0) return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
  if (minutes > 0) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/** One second, which is the smallest unit the band ever prints. */
const TICK_MS = 1000

/**
 * Now, re-read on a timer this component owns.
 *
 * The clock cannot be driven by arriving data, and that is the entire point of
 * it: a run parked at a gate appends nothing to its log for as long as the
 * human is away, so a clock that re-rendered on records would freeze at the
 * last one and understate the wait by exactly the interval that matters.
 *
 * The interval is cleared on unmount. One that outlived the band would go on
 * calling `setState` on a component that is gone, once a second, for the life
 * of the page.
 */
function useTickingNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!active) return undefined
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [active])

  return now
}

export interface NeedsYouBandProps {
  /** The project, spelled as `projects.json` spells it. Printed verbatim. */
  project?: string | null
  /** `T2`. */
  taskRef?: string | null
  /** The task's own sentence, from the feature file. Printed verbatim. */
  taskText?: string | null
  /** Why the run is parked. `src/ui/live.ts`'s `Waiting.reason`, unchanged. */
  reason: WaitReason
  /**
   * When the park happened, epoch milliseconds.
   *
   * The clock reads this and nothing else. A non-finite value prints no clock
   * rather than `waiting NaNs`; a value in the future - a browser clock that
   * disagrees with the server's - reads as no time at all rather than as a
   * negative one.
   */
  startedAtMs: number
  className?: string
}

/**
 * The signature element: full width, solid orange, and the reason the product
 * works unattended.
 *
 * `role="status"`, never a dialog: nothing is trapped, nothing is disabled
 * behind it, and it carries no action. The clock inside it is
 * `aria-hidden` - a live region re-announces on every mutation, so a ticking
 * second hand would have a screen reader read the whole band out once a second
 * for as long as the run stayed parked.
 */
export function NeedsYouBand({ project, taskRef, taskText, reason, startedAtMs, className }: NeedsYouBandProps) {
  const reduced = usePrefersReducedMotion()
  const timed = Number.isFinite(startedAtMs)
  const now = useTickingNow(timed)

  const classes = [reduced ? "" : "band", className ?? ""].filter((name) => name !== "").join(" ")

  return (
    <div
      data-testid="needs-you-band"
      data-motion={reduced ? "static" : "animated"}
      role="status"
      className={classes}
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "10px 20px",
        padding: "18px 24px",
        background: "#FF6A1A",
        color: "#1A0B02",
      }}
    >
      <span
        data-testid="band-dot"
        aria-hidden="true"
        className={reduced ? undefined : "pulsed"}
        style={{ width: 14, height: 14, borderRadius: "50%", background: "#1A0B02", flex: "none" }}
      />

      <span data-testid="band-headline" style={{ fontSize: 28, lineHeight: 1, fontWeight: 700, letterSpacing: "-.025em" }}>
        Needs you
      </span>

      <span
        data-testid="band-subject"
        dir="auto"
        style={{ fontSize: 16, fontWeight: 500, minWidth: 0, overflowWrap: "anywhere" }}
      >
        {bandSubject(project, taskRef, taskText, waitingFor(reason))}
      </span>

      {timed && (
        <span
          data-testid="band-clock"
          aria-hidden="true"
          className="m"
          style={{ marginLeft: "auto", fontSize: 14, fontWeight: 500, flex: "none" }}
        >
          waiting {waitedFor(Math.max(0, now - startedAtMs))}
        </span>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* The breadcrumb                                                            */
/* -------------------------------------------------------------------------- */

/** What the chip prints and wears, for one `Account.kind`. */
interface ChipReading {
  text: string
  background: string
  colour: string
  glyph: "person" | "briefcase" | "none"
}

/**
 * The neutral chip: the only reading that claims nothing.
 *
 * docs/HANDOFF.md is explicit that "a silent default of personal is the exact
 * failure the chip exists to prevent", so this is both what `unknown` reads as
 * and what a kind a newer writer invented folds to.
 */
const NO_ACCOUNT: ChipReading = {
  text: "account unknown",
  background: "#F1F1F4",
  colour: "#5F6370",
  glyph: "none",
}

function chipReading(account: Account): ChipReading {
  /* Not a `switch`: an invented fourth kind must land on the neutral reading at
   * runtime rather than fall out of an exhaustive match as `undefined`, which
   * is the same choice `stateReading` makes for an invented `WaitReason`. */
  if (account.kind === "personal") {
    return { text: `runs as ${account.label ?? "personal"}`, background: "#E0F2FE", colour: "#075985", glyph: "person" }
  }
  if (account.kind === "work") {
    return { text: `runs as ${account.label ?? "work"}`, background: "#26272D", colour: "#F4F4F6", glyph: "briefcase" }
  }
  return NO_ACCOUNT
}

function ChipGlyph({ glyph }: { glyph: ChipReading["glyph"] }) {
  if (glyph === "person") {
    return (
      <svg {...ICON} style={{ width: 12, height: 12, flex: "none" }}>
        <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    )
  }
  if (glyph === "briefcase") {
    return (
      <svg {...ICON} style={{ width: 12, height: 12, flex: "none" }}>
        <path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
        <rect width="20" height="14" x="2" y="6" rx="2" />
      </svg>
    )
  }
  return null
}

export interface BreadcrumbProps {
  /** The project, spelled as `projects.json` spells it. Printed verbatim. */
  project: string
  /**
   * The feature file, repo-relative, printed **in full**.
   *
   * Never the basename: see the file header. A path over 150 characters wraps.
   */
  featureFile: string
  /** `T2`. `TaskId.taskRef` really is `null` when no task is selected. */
  taskRef?: string | null
  /** The task's own sentence, from the feature file. Absent leaves the ref. */
  taskText?: string | null
  /** Which CLI profile this project's runs bill to. */
  account: Account
  className?: string
}

/** `T2 · Map records to rows`, or whichever half exists. */
function taskLabel(taskRef: string | null | undefined, taskText: string | null | undefined): string | null {
  const parts = [taskRef, taskText].filter(present)
  return parts.length === 0 ? null : parts.join(" · ")
}

export function Breadcrumb({ project, featureFile, taskRef, taskText, account, className }: BreadcrumbProps) {
  /* Each crumb's text is a string a human chose, so the only thing decided here
   * is whether there is one at all. The dimension is that string and its values
   * are: a path, a sentence, a blank, whitespace, and `null`. Blankness is
   * judged on the trimmed value; the untrimmed value is what gets printed, so
   * no crumb can lose a byte to this test. A crumb rendered around nothing
   * leaves a separator pointing at nothing, which reads as a broken build. */
  const crumbs: { key: string; node: ReactNode }[] = []

  /** The wrapping contract DESIGN.md's third promise needs, on every crumb. */
  const wraps = { minWidth: 0, overflowWrap: "anywhere" } as const

  if (present(project)) {
    crumbs.push({
      key: "project",
      node: (
        <span data-crumb="project" dir="auto" style={wraps}>
          {project}
        </span>
      ),
    })
  }

  if (present(featureFile)) {
    crumbs.push({
      key: "feature",
      node: (
        <span data-crumb="feature" className="m" dir="auto" style={{ fontSize: 12.5, ...wraps }}>
          {featureFile}
        </span>
      ),
    })
  }

  const task = taskLabel(taskRef, taskText)
  if (task !== null) {
    crumbs.push({
      key: "task",
      node: (
        <span data-crumb="task" dir="auto" style={{ color: "#111216", fontWeight: 600, ...wraps }}>
          {task}
        </span>
      ),
    })
  }

  const chip = chipReading(account)

  return (
    <nav
      aria-label="Breadcrumb"
      className={className}
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 8,
        fontSize: 13.5,
        color: "#5F6370",
        marginBottom: 18,
      }}
    >
      {crumbs.map((crumb, index) => (
        <Fragment key={crumb.key}>
          {index > 0 && <Separator />}
          {crumb.node}
        </Fragment>
      ))}

      <span
        data-testid="account-chip"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: chip.glyph === "none" ? "2px 7px" : "2px 7px 2px 5px",
          borderRadius: 6,
          background: chip.background,
          color: chip.colour,
          fontSize: 11.5,
          fontWeight: 550,
          flex: "none",
        }}
      >
        <ChipGlyph glyph={chip.glyph} />
        {chip.text}
      </span>
    </nav>
  )
}

/* -------------------------------------------------------------------------- */
/* The tab                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A solid `#FF6A1A` disc, which is the `needs you` glyph from
 * `docs/design/States.dc.html` reduced to the sixteen pixels a tab gives it.
 *
 * Deliberately **not** the app bar's mark. That is a dark square already
 * containing a small orange dot, so "the mark" and "the mark with a dot on it"
 * are indistinguishable at favicon size — which would make the signal invisible
 * in the one place it exists to be seen from.
 */
const ATTENTION_ICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#FF6A1A"/></svg>',
)}`

/** The hook's marker, so it can only ever remove a link it created itself. */
const OWN_ICON = "data-kantan-attention"

/**
 * A count that can raise the alarm, or `null`.
 *
 * `needsYouClaim` in `src/ui/Digest.tsx` admits an integer of **zero or above**,
 * because zero is what its calm claim is made of. The tab has no calm claim to
 * make, so zero is simply nothing to say: a positive integer, and nothing else.
 * `NaN`, a fraction, a negative and `Infinity` all fail `Number.isInteger`,
 * which is the same gate the band uses, so neither reading can admit a figure
 * the other refuses.
 */
function usableCount(needsYou: number | undefined): number | null {
  if (needsYou === undefined) return null
  if (!Number.isInteger(needsYou) || needsYou <= 0) return null
  return needsYou
}

/**
 * Is this run waiting on a person?
 *
 * `RunState.kind === "waiting"` and nothing else, for all four `WaitReason`s
 * including `stalled`: `src/run.ts` parks a stalled run with `park(…,
 * "stalled")` exactly as it parks a gate, and a parked run only ever moves
 * again because a human moved it. The other four kinds do not park. `failed`
 * and `interrupted` are the arguable ones - an interrupted run never moves
 * until someone resumes it - and they are left out on purpose, because
 * `src/ui/Tree.tsx` reads both as their own states rather than as "needs you",
 * so a tab that shouted about them would shout about every dead run in the
 * tree. Flagged for the session rather than decided here.
 */
function parks(state: DigestSubject["state"]): boolean {
  return state.kind === "waiting"
}

/**
 * What the tab should say, or `null` when nothing needs anybody.
 *
 * **The dimension** is "does anything need the human", read from this run's
 * state and a count of the whole tree.
 *
 * **Its values** are the five `RunState` kinds - with all four `WaitReason`s,
 * since `waiting` is the only kind that parks - plus no run at all, crossed
 * with the count being absent, `NaN`, negative, fractional, infinite, zero, one
 * or several. The matrix is in `test/ui/Chrome.test.tsx`.
 *
 * **What a wrong guess costs, in each direction.** A missed "needs you" is the
 * expensive one: the user is in another tab and a parked run waits until they
 * next remember it, which is the single failure this product exists to prevent.
 * A spurious one costs a glance - *unless it is permanent*, and a caller whose
 * count is always unusable would make it permanent, at which point the dot
 * means nothing and the expensive direction arrives anyway by a longer road. So
 * an unusable count is read as "nobody counted" and the run's own state, which
 * is known-good data, decides alone.
 *
 * See `parks` for which states park, and why `interrupted` is not one of them.
 */
function attentionTitle(subject: DigestSubject | null, needsYou: number | undefined): string | null {
  const count = usableCount(needsYou)
  const parked = subject !== null && parks(subject.state)
  if (!parked && count === null) return null

  /* "Needs you" first, never last: a tab strip truncates the end, and this is
   * the only channel the product has to someone who walked away.
   *
   * The task is named **only when it is the task that parked**. A running run
   * sitting beside three parked ones elsewhere in the tree would otherwise put
   * that run's own name on the alarm, sending the reader to the one task that
   * does not need them. The subject's spelling is verbatim when it is used. */
  const named = parked && subject !== null ? [subject.project, subject.taskRef].filter(present) : []
  if (named.length > 0) return `Needs you · ${named.join(" ")}`
  if (count !== null) return `Needs you · ${count === 1 ? "1 task" : `${count} tasks`}`
  return "Needs you"
}

function showAttentionIcon(): void {
  if (document.head.querySelector(`link[${OWN_ICON}]`) !== null) return
  const link = document.createElement("link")
  link.setAttribute("rel", "icon")
  link.setAttribute("type", "image/svg+xml")
  link.setAttribute(OWN_ICON, "")
  link.setAttribute("href", ATTENTION_ICON)
  document.head.append(link)
}

function hideAttentionIcon(): void {
  document.head.querySelector(`link[${OWN_ICON}]`)?.remove()
}

export interface PageAttention {
  /** The run the page is about, or `null` when no task is selected. */
  subject: DigestSubject | null
  /**
   * How many tasks are waiting on a human, counted by the caller across the
   * whole tree. `undefined` means nobody counted.
   *
   * The same prop `ReturnBand` takes, and it must be the same value: pass one
   * number to both.
   */
  needsYou?: number
}

/**
 * Put "needs you" on the browser tab, and take it off again.
 *
 * The band only reads to someone already looking at the page. A run parked at a
 * gate emits nothing for minutes, which is the whole premise: the user walked
 * away. The title and the favicon are the only part of this design that reaches
 * them there.
 *
 * Both are restored when nothing needs them and when this unmounts. A dot left
 * on a tab after the run moved on is a lie about the present, and it is exactly
 * how a reader learns to ignore the dot.
 *
 * The favicon is **appended** as the hook's own `<link>` rather than written
 * over whatever the page had, which is what makes the restore provable instead
 * of a second guess at what was there before: `index.html` ships no icon link
 * today, so "put it back" has two cases, and removing a link nobody else owns
 * handles both.
 */
export function usePageAttention({ subject, needsYou }: PageAttention): void {
  const title = attentionTitle(subject, needsYou)

  useEffect(() => {
    if (title === null) return undefined

    /* Captured in the effect, and that is load-bearing rather than careless.
     * React runs an effect's cleanup **before** the next setup for the same
     * effect, so by the time this line runs the previous attention title has
     * already been put back and `document.title` is the page's own. An earlier
     * draft kept it in a `useRef` instead, on the theory that an in-effect
     * capture would catch the hook's own write when the title changed while
     * attention held - a run moving from one parked task to another. Mutating
     * the ref away could not be made to fail any test, in that case or in
     * StrictMode's double pass, because the ordering already guarantees it. The
     * ref was belief, not a guard, so it is gone. */
    const before = document.title

    document.title = title
    showAttentionIcon()

    return () => {
      document.title = before
      hideAttentionIcon()
    }
  }, [title])
}
