/**
 * Adding a repository: the panel that replaces the centre column.
 *
 * Translated from `docs/design/AddRepo.dc.html` — "kantan — add a repository" —
 * whose seven `<sc-if>` branches and two `<sc-for>` loops are the behaviour,
 * not decoration. Geometry and copy are read off that file rather than
 * summarised from `DESIGN.md`.
 *
 * ## The failure this screen exists to fix
 *
 * A user typed a path, pressed add, and got
 *
 *     that repository could not be added: 400 {"error":"/home/laithalenooz/…
 *     is not a usable git repository: fatal: cannot change to '…'"}
 *
 * The machine's home is `/home/lalenooz`. Four characters, and the sentence
 * that came back named git. Two things were wrong with the old dialog and both
 * are structural: the answer arrived **after** submitting, and it arrived
 * phrased as the last thing that failed rather than the first.
 *
 * So this panel checks as the path is typed and shows the result beside the
 * field — and `src/git.ts`'s own sentences are what it shows, verbatim,
 * including the one that locates the typo: *"The deepest part of that path
 * which does exist is /home - check the spelling of what comes after it."*
 * (That is an ASCII hyphen, because that is the byte `git.ts` writes.)
 * Nothing here re-authors a message from a code, because that sentence is the
 * only one that says where to look and it would be the first casualty.
 *
 * ## A panel, not a dialog
 *
 * `docs/design/canvas.json`: *"All of these replace the centre column. No
 * routes, no settings page, and dialogs only for confirmations."* The old
 * `AddProject` in `src/ui/App.tsx` is a `role="dialog"` with two inputs; this
 * is a `<main>`. `Empty.dc.html`'s call to action now links straight here.
 *
 * ## No fetching, and why the freshness rule lives here anyway
 *
 * Detection arrives as a prop and the shell does the probing, so the debounce
 * lives in one place and this file is testable without a server. What cannot
 * be delegated is the question *"is the answer on screen about the string in
 * the box?"* — and that is the whole guard:
 *
 *     detection.path === path
 *
 * Byte for byte. No trim, no trailing-slash fix, no `~` expansion, no Unicode
 * normalisation. `CLAUDE.md`'s skipping-guard rule asks what a wrong guess
 * costs in each direction, and these are nowhere near symmetric: reading a
 * result as **stale when it was fresh** costs one press of Check, while
 * reading it as **fresh when it was stale** puts "Git repository · on main"
 * under a directory that does not exist and lights the button. Ten values of
 * that dimension are enumerated as a matrix in `test/ui/AddRepo.test.tsx`.
 *
 * The same rule applies to a test run: a result belongs to the command it ran,
 * so an `exit 0` chip disappears the moment the command is edited.
 *
 * **This component contains no rule about path syntax at all.** It does not
 * decide that `~/code` is relative, that a trailing slash is harmless or that
 * `/home` is too shallow — `src/projects.ts` refuses a relative path rather
 * than resolving it (the answer would depend on where the server was
 * launched), and `src/git.ts` owns everything after that. The only string
 * operations here are that `===`, and `repoLabel` on a root **git reported**.
 * Never on what was typed: with `/home/laithalenooz/projects/kantan` in the
 * box the last segment is still `kantan`, so a label built from the typing
 * reads "Add kantan" for a directory that is not there. That reassurance is
 * what let the production failure through.
 *
 * ## The probe failing is not the path failing
 *
 * There is **no endpoint yet** (see "What the server still has to expose"
 * below). A 404, a 500 or a dropped connection is not a verdict about the
 * folder, and if it blocked the button nothing could be registered at all. So
 * `unknown` is its own state: it says what happened, claims nothing about the
 * directory, and leaves Add usable. `POST /api/projects` runs
 * `requireUsableRepo` regardless, so the worst case is exactly today's
 * behaviour — an error after submitting — rather than a dead screen.
 *
 * ## Progressive disclosure latches
 *
 * Sections appear as earlier ones are answered, each with the artboard's blur
 * fade on its own rung. Visibility is **monotonic**: if it read the current
 * detection, every keystroke would unmount sections 2 to 4 — replaying four
 * entrances and discarding answers already given. Going stale disables Add; it
 * never retracts a question. And a revealed section is mounted rather than
 * `hidden`: every one of them is a `display: grid`, and `CLAUDE.md` records a
 * collapsed list rendering in full because `display: flex` outranks `[hidden]`.
 *
 * The footer is not progressive, which is the artboard's own choice: its hint
 * reads "Check the folder first." before anything has been checked. A disabled
 * button with no reason beside it is what this redesign removes.
 *
 * ## Two places the artboard is not followed, and why
 *
 * **Step 4 has no checkboxes.** The artboard draws a checkbox per task file.
 * `POST /api/projects` takes `path`, `testCmd`, `account` and `configDir` and
 * refuses any other key by name, and `src/featurefile.ts` discovers task files
 * by reading `docs/features` at request time — so a checkbox here is a control
 * whose answer is silently dropped. It is a read-only list of what kantan will
 * read. Nor does Add depend on it: a repository with no task files is a repo's
 * normal first state and must be registrable, or the only route to a first
 * task file is unreachable.
 *
 * **An account prints its profile directory only when it was given one.** The
 * artboard prints `~/.claude` and `~/.claude-work` under the two cards.
 * `src/projects.ts` is explicit that `account` is the human's word about
 * billing while `configDir` selects the profile, and that no rule turns one
 * into the other. Printing `~/.claude-work` under a card that sends no
 * `configDir` would promise a profile the run will not use — which is the
 * billing defect the account chip exists to prevent. So `AccountOption`
 * carries the directory, this file passes it through untouched, and a card
 * without one says "default profile" out loud.
 *
 * Nothing preselects an account, either. `Account` in `src/ui/Tree.tsx`
 * forbids defaulting to "personal" because people bill clients from one of
 * these, so "Not sure" is a real third answer and it is the absence of an
 * `account` key in the draft.
 *
 * ## Motion
 *
 * CSS keyframes from `src/ui/artboard.css`, not Motion components:
 * `docs/HANDOFF.md` measured 195 unhandled `AbortError`s from Motion
 * entrances, and a progressive form is a staggered entrance by definition.
 * `.bf` with `.d1`–`.d4`, `.pop` for the list and `.spin` for the two
 * spinners are the artboard's own names for what it draws.
 *
 * The gate is in JS as well as CSS, and it **removes the classes** rather than
 * asking an animation to stop. Motion's `useReducedMotion()` is one of its two
 * sources and not enough alone: `CLAUDE.md` records it as a module-level
 * singleton seeded at the first call anywhere in the process, which has
 * answered `false` with the media feature actually set. So it is OR'd with a
 * live `matchMedia` read, and the OR fails toward the cheap direction.
 *
 * ## What the server still has to expose
 *
 * One route, which does not exist today. `POST /api/detect` with a JSON body
 * through `parseBody`'s fixed key list is the house shape and the safe one; a
 * `GET` with the path in the query works too, as long as both ends agree on
 * the encoding — `URLSearchParams` writes a space as `+` and a hand-rolled
 * `decodeURIComponent` does not read it back.
 *
 * Which it is barely matters, because **the shell keys `detection.path` on the
 * string it sent, captured at request time, not on whatever comes back.** Then
 * no transport detail can make a stale answer look fresh, and a late reply for
 * `/a` cannot land on a box that now reads `/ab`. The response should still
 * carry `root` — the resolved, symlink-followed spelling — because that is
 * what names the repository and what will be registered.
 *
 * The order of the checks is fixed by what each one assumes:
 *
 *  1. `src/projects.ts`'s `absolutePath`, **before** any `stat` or `git -C`,
 *     or a relative `foo` is probed against the server's working directory.
 *  2. `requireUsableRepo`, whose refusals are the `checks`, each carrying that
 *     function's own message. They are `Error`s with no code on them today,
 *     which is why `DetectionCheck.code` is optional: a route may compose a
 *     `says` out of values it already holds, and must never parse the prose to
 *     find them.
 *  3. The 409, against the **resolved root** — which is what
 *     `registerProject` compares — so "already registered" is caught here
 *     rather than after four sections have been filled in.
 *  4. `taskFiles`, through `listFeatureFiles` + `featurePath` + `readInside`,
 *     the same calls `GET /api/projects` makes. That keeps the preview's paths
 *     equal to the string the tree joins on, and keeps the symlink containment
 *     for a repository nobody has registered yet.
 *
 * It answers "does this path exist" for any path on the machine, so it takes
 * the same Host check and session token as every other route.
 */

import { useState, useSyncExternalStore, type CSSProperties, type ReactElement, type ReactNode } from "react"
import { useReducedMotion } from "motion/react"

import { SELF_CHECKED } from "./testcmd.ts"

/* -------------------------------------------------------------------------- */
/* Props                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Which dimension of "is this a usable repository" one line of the list
 * answers.
 *
 * These are `requireUsableRepo`'s own refusals plus the two the route around
 * it owns, and they exist for ordering and for tests. **They do not decide
 * anything here**: the glyph comes from `status` and the button from `usable`,
 * so that no reading of this list can drift from the server's.
 *
 * | code | what fails it |
 * |---|---|
 * | `absolute` | `src/projects.ts` refuses a relative path; the CLI expands no `~` |
 * | `directory` | nothing at that path, or a file — names the deepest ancestor that does exist |
 * | `repo` | `git rev-parse` does not answer for it |
 * | `worktree` | bare, so there is no working tree to edit |
 * | `root` | a subdirectory of a repo; names the root to register instead |
 * | `commits` | an unborn HEAD, so a task branch has no base commit |
 * | `registered` | already in `projects.json`, which the route refuses with a 409 |
 * | `tests` | *information*: a test command was found, or none was |
 * | `tasks` | *information*: what is in `docs/features` |
 * | `branch` | *information*: the branch, and whether the tree is clean |
 */
export type DetectionCode =
  | "absolute"
  | "directory"
  | "repo"
  | "worktree"
  | "root"
  | "commits"
  | "registered"
  | "tests"
  | "tasks"
  | "branch"

/**
 * A sentence the server said, in order.
 *
 * A `{ mono }` part is a machine value — a path, a branch, a filename, a
 * command — and renders in Geist Mono, which is `artboard.css`'s rule for
 * every machine value. Parts rather than one string because the artboard's own
 * lines interleave the two faces mid-sentence ("`package.json` has a `test`
 * script"), and a component that had to find the machine words inside prose
 * would be guessing at them.
 */
export type DetectionPhrase = ReadonlyArray<string | { mono: string }>

export interface DetectionCheck {
  /**
   * Optional, because nothing can supply it honestly yet: `requireUsableRepo`
   * throws plain `Error`s, and deriving a code by matching their prose would
   * be the guess this whole file refuses. Supply it when git.ts grows typed
   * errors; until then the glyph comes from `status` and the decision from
   * `usable`, and neither needs this.
   */
  code?: DetectionCode
  /**
   * `pass` is a green tick, `fail` the red cross, `info` a neutral ring: a
   * fact that decides nothing. A detached HEAD and a dirty tree belong here —
   * they refuse a *run*, not a registration, and reporting them as failures
   * would stop someone adding a repository over something one `git switch`
   * fixes.
   */
  status: "pass" | "fail" | "info"
  /** Rendered verbatim. Never rebuilt from `code`; see the file header. */
  says: DetectionPhrase
}

/** One task, as the preview draws it. `ref` is absent on an unlabelled line. */
export interface PreviewTask {
  ref: string | null
  text: string
}

export interface TaskFile {
  /**
   * Repo-relative, **exactly** the string the tree will list — `TreeFeature`'s
   * own rule, and `docs/HANDOFF.md` records that the tree joins on it by exact
   * string. Shown verbatim and never shortened.
   */
  path: string
  tasks: readonly PreviewTask[]
}

/** The answered shape, split out because three fields hang off it. */
export interface DetectionDone {
  phase: "done"
  /** The string that was checked. Compared `===` with the box; see the header. */
  path: string
  /**
   * May registration proceed? The server's answer, **never** inferred from
   * counting ticks in `checks` — a reading of the list here is a second
   * implementation of `requireUsableRepo` and would drift from the first.
   */
  usable: boolean
  checks: readonly DetectionCheck[]
  /**
   * The root git reported, which is the only thing that names the repository.
   * `requireUsableRepo` resolves symlinks, so this is what will be registered
   * and may differ from the spelling that was typed.
   */
  root?: string
  /** The command detection found. Absent means it found none; there is no default. */
  testCmd?: string
  /** Where it was found, e.g. `package.json`. Absent draws no source chip. */
  testCmdSource?: string
  /** What is in `docs/features`. Absent and empty both mean nothing to run yet. */
  taskFiles?: readonly TaskFile[]
}

/**
 * What the shell knows about the path in the box.
 *
 * Six states, because the sixth is load-bearing: `unknown` is the probe itself
 * failing, which is not a verdict about the folder and must not block the
 * button. The fifth, stale, is not a state but a comparison — any of these
 * whose `path` is not the string in the box reads as if nothing had been
 * checked.
 */
export type Detection =
  | { phase: "idle" }
  | { phase: "checking"; path: string }
  | DetectionDone
  | {
      phase: "unknown"
      path: string
      /** Shown to the person. A sentence, not a status code on its own. */
      why: string
    }

/**
 * One run of the test command, which the server performs.
 *
 * `exitCode` and nothing else: *"The server runs the tests, not the agent.
 * Branch on the exit code"* (`CLAUDE.md`). `summary` is prose beside it, never
 * instead of it.
 */
export type TestRun =
  | { phase: "idle" }
  | { phase: "running"; cmd: string }
  | { phase: "done"; cmd: string; exitCode: number; summary?: string }
  /**
   * The command did **not** run, and `why` says so in the server's words.
   *
   * A distinct phase rather than an exit code, because a refusal is not a
   * result: a run in flight in the same working tree and a command that could
   * not be started are both reasons nothing executed, and `runTestCommand`
   * throws on them for exactly that reason. Folding either into `done` would
   * print a number beside a command that never ran, which is the claim
   * `CLAUDE.md` forbids outright. Without this phase the shell could only
   * swallow the refusal, leaving a button that looks dead.
   */
  | { phase: "refused"; cmd: string; why: string }

/**
 * A Claude account the shell can offer.
 *
 * `configDir` is passed into the draft untouched and is never derived from
 * `kind`; `usedFraction` draws the five-hour ring and is ignored unless it is
 * a finite number. See the file header for why both are the shell's to supply.
 */
export interface AccountOption {
  kind: "personal" | "work"
  /** What the card prints. Defaults to the kind, as `Account.label` does. */
  label?: string
  /** `CLAUDE_CONFIG_DIR` for this account's runs. Printed verbatim. */
  configDir?: string
  /** 0–1 of the five-hour window spent. Absent, or not finite, draws no ring. */
  usedFraction?: number
}

/** What `POST /api/projects` is to be given. */
export interface RepoDraft {
  /** Exactly what is in the box: not trimmed, not resolved, not expanded. */
  path: string
  /**
   * Exactly what is in the command field, for the same reason - or `null`
   * when the human took the opt-out and this project has no suite.
   *
   * `null` and not `""`. `src/projects.ts` refuses a blank outright and should:
   * `sh -c ""` exits 0, so a blank command would tick every task as tested
   * with nothing run. The empty field and the opt-out are different answers,
   * and only one of them may reach the store.
   */
  testCmd: string | null
  /** Absent is "Not sure", which is the absence of an answer and the key omitted. */
  account?: "personal" | "work"
  /** Only ever the chosen `AccountOption`'s own value. */
  configDir?: string
}

export interface AddRepoProps {
  /** Controlled, because the shell probes this exact string. */
  path: string
  /** The raw value. Nothing upstream should tidy it either. */
  onPathChange: (value: string) => void
  detection: Detection
  /** Probe `path` now: the Check button, and Enter in the field. */
  onCheck: () => void
  /**
   * Register it. **Rejecting is how a refusal is reported** — the panel keeps
   * the draft, restores its controls and shows the message in `role="alert"`,
   * which is `Gate.tsx`'s contract and the reason the server's prose is worth
   * forwarding.
   */
  onSubmit: (draft: RepoDraft) => void | Promise<void>
  onCancel: () => void
  /** Defaults to the two `Project.account` accepts, with no profile and no ring. */
  accounts?: readonly AccountOption[]
  testRun?: TestRun
  /**
   * Tries the command in the field. Absent hides "Run it once".
   *
   * **It is handed the command**, because this panel owns that field and the
   * shell cannot see into it - and there is nowhere else the shell could get
   * one, since the whole premise of this screen is that the project is not
   * saved yet. It is the typed draft rather than whatever detection found,
   * for the reason `POST /api/test` takes its command from the body: the
   * control proves a command *before* it is trusted, so running anything but
   * the string on screen would answer a question nobody asked.
   *
   * The phase it reports arrives back as `testRun`, which the shell owns.
   */
  onRunTests?: (cmd: string) => void
  /** Absent hides "Add another account". */
  onAddAccount?: () => void
  /** Absent hides "Start a new task file instead". */
  onNewTaskFile?: () => void
  /** Absent hides the way in after a successful add. */
  onOpenRepo?: () => void
  className?: string
}

/* -------------------------------------------------------------------------- */
/* Reduced motion                                                             */
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

/** Two sources OR'd. See the file header for why either alone is not enough. */
function usePrefersReducedMotion(): boolean {
  const motionsAnswer = useReducedMotion() === true
  const live = useSyncExternalStore(subscribeToReducePreference, readReducePreference, () => false)
  return motionsAnswer || live
}

/* -------------------------------------------------------------------------- */
/* Reading the detection                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What the panel believes about the path in the box.
 *
 * `idle` is also what a **stale** answer reads as: one comparison, in one
 * place, and everything downstream — the list, the reveal, the preview, the
 * button — reads this instead of the prop.
 */
type Verdict =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "usable"; done: DetectionDone }
  | { kind: "unusable"; done: DetectionDone }
  | { kind: "unknown"; why: string }

function verdictOf(detection: Detection, path: string): Verdict {
  switch (detection.phase) {
    case "idle":
      return { kind: "idle" }
    case "checking":
      return detection.path === path ? { kind: "checking" } : { kind: "idle" }
    case "unknown":
      return detection.path === path ? { kind: "unknown", why: detection.why } : { kind: "idle" }
    case "done":
      if (detection.path !== path) return { kind: "idle" }
      return detection.usable ? { kind: "usable", done: detection } : { kind: "unusable", done: detection }
  }
}

/**
 * What to call the repository.
 *
 * Exported because it is the one derivation in this file and it has a matrix
 * behind it. Only ever handed a root the server reported; see the file header
 * for why the typed path is not a source.
 */
export function repoLabel(root: string): string {
  if (root === "") return "this repository"
  /* A name is what comes after the last separator, so trailing ones are not
     part of it. `git rev-parse --show-toplevel` prints none; a hand-written
     prop might. The floor of 1 keeps "/" a path rather than an empty string. */
  let end = root.length
  while (end > 1 && root[end - 1] === "/") end--
  const trimmed = root.slice(0, end)
  const cut = trimmed.lastIndexOf("/")
  const last = cut === -1 ? trimmed : trimmed.slice(cut + 1)
  /* Nothing left to name: the root directory is called "/", not "". */
  return last === "" ? trimmed : last
}

/** The two words `Project.account` accepts, with nothing claimed about either. */
const DEFAULT_ACCOUNTS: readonly AccountOption[] = [{ kind: "personal" }, { kind: "work" }]

/**
 * What identifies one account, and it is **not** `kind`.
 *
 * `Project.account` has two words, so a second client profile is another
 * `kind: "work"` — and this panel offers "Add another account", so a list with
 * two of a kind is something it asks for. Selecting by `kind` would check both
 * cards and submit the first one's `configDir`, which is a run billed from the
 * wrong place: the defect the account question exists to prevent, reached
 * through this file's own prop surface.
 *
 * `kind` plus `configDir` is what names a real profile. Not the index: a list
 * that reorders — or grows when `onAddAccount` returns — would move the
 * selection to a different client in silence. `\u0000` separates, as
 * `src/runindex.ts`'s `taskKey` does, because it is the one byte a path cannot
 * contain.
 */
function accountKey(option: AccountOption): string {
  return `${option.kind}\u0000${option.configDir ?? ""}`
}

/** "Not sure", which no `AccountOption` can collide with: `kind` is enumerated. */
const UNKNOWN_KEY = "\u0000not sure"

/**
 * The circumference of the r=25 circle both rings are drawn on.
 * `src/ui/Sidebar.tsx` exports the same figure as `RING_CIRCUMFERENCE`; it is
 * repeated rather than imported so neither file owns the other's drawing.
 */
const RING_CIRCUMFERENCE = 157.08

/**
 * The ring's arc, or `null` for an account that reported no usable figure.
 *
 * The dimension is `usedFraction` and its values are: absent, 0, a fraction,
 * 1, above 1, below 0, and not a finite number. A `NaN` would reach
 * `stroke-dashoffset` as the string "NaN" and draw a ring with no arc — a
 * plausible 0% nobody measured — so anything not finite draws nothing at all.
 * A finite value out of range is clamped instead: a server reporting 1.4 has
 * still said "spent", and showing the window full is the cheap direction.
 */
function ringArc(usedFraction: number | undefined): { percent: number; offset: number } | null {
  if (usedFraction === undefined || !Number.isFinite(usedFraction)) return null
  const spent = Math.min(1, Math.max(0, usedFraction))
  return { percent: Math.round(spent * 100), offset: RING_CIRCUMFERENCE * (1 - spent) }
}

/* -------------------------------------------------------------------------- */
/* Icons. Lucide shapes, as the artboard draws them.                          */
/* -------------------------------------------------------------------------- */

/** `.ic` carries the 16px default and the round joins; sizes are per use. */
const LINE = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const

function Folder({ size = 16, color }: { size?: number; color?: string }): ReactElement {
  return (
    <svg className="ic" aria-hidden="true" viewBox="0 0 24 24" style={{ width: size, height: size, ...(color === undefined ? {} : { color }) }} {...LINE}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  )
}

function Plus({ size = 14, weight = 2 }: { size?: number; weight?: number }): ReactElement {
  return (
    <svg className="ic" aria-hidden="true" viewBox="0 0 24 24" style={{ width: size, height: size, strokeWidth: weight }} {...LINE}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  )
}

function AccountIcon({ kind }: { kind: "personal" | "work" | "unknown" }): ReactElement {
  const box = { width: 14, height: 14 }
  if (kind === "personal") {
    return (
      <svg className="ic" aria-hidden="true" viewBox="0 0 24 24" style={box} {...LINE}>
        <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    )
  }
  if (kind === "work") {
    return (
      <svg className="ic" aria-hidden="true" viewBox="0 0 24 24" style={box} {...LINE}>
        <path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
        <rect width="20" height="14" x="2" y="6" rx="2" />
      </svg>
    )
  }
  return (
    <svg className="ic" aria-hidden="true" viewBox="0 0 24 24" style={box} {...LINE}>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </svg>
  )
}

/** The artboard's indigo half-ring, which is the only thing that spins. */
function Spinner({ spin }: { spin: boolean }): ReactElement {
  return (
    <svg
      data-addrepo="spinner"
      className={spin ? "spin" : ""}
      aria-hidden="true"
      viewBox="0 0 24 24"
      style={{ width: 15, height: 15 }}
    >
      <circle cx="12" cy="12" r="9" fill="none" stroke="#DCDCF6" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="#5B5BD6" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

/**
 * The reading of one check, as a shape and as a word.
 *
 * `role="img"` with a label rather than text: the word has to reach a screen
 * reader — a colour is not a reading — but it must not land in the row's
 * `textContent`, where it would interleave with the server's sentence.
 */
function CheckGlyph({ status }: { status: DetectionCheck["status"] }): ReactElement {
  const word = status === "pass" ? "passed" : status === "fail" ? "failed" : "note"
  const shell: CSSProperties = {
    width: 18,
    height: 18,
    borderRadius: "50%",
    display: "grid",
    placeItems: "center",
    flex: "none",
    boxSizing: "border-box",
  }
  if (status === "info") {
    return (
      <span role="img" aria-label={word} data-glyph-label={word} style={{ ...shell, border: "1.5px solid #A3A7B1" }} />
    )
  }
  const stroke = { fill: "none", stroke: "#fff", strokeWidth: 4, strokeLinecap: "round", strokeLinejoin: "round" } as const
  return (
    <span
      role="img"
      aria-label={word}
      data-glyph-label={word}
      style={{ ...shell, background: status === "pass" ? "#0F8A5F" : "#D92D3A" }}
    >
      <svg viewBox="0 0 24 24" style={{ width: 10, height: 10 }} {...stroke}>
        {status === "pass" ? <path d="M20 6 9 17l-5-5" /> : <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>}
      </svg>
    </span>
  )
}

/** A phrase, with its machine values in the mono face. */
function Phrase({ says }: { says: DetectionPhrase }): ReactNode {
  return says.map((part, index) =>
    typeof part === "string" ? (
      part
    ) : (
      <span key={index} className="m" style={{ fontSize: 12.5 }}>
        {part.mono}
      </span>
    ),
  )
}

/* -------------------------------------------------------------------------- */
/* Shared geometry, straight off the artboard                                 */
/* -------------------------------------------------------------------------- */

const SECTION: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "32px minmax(0,1fr)",
  gap: 14,
  padding: "24px clamp(20px,4vw,40px)",
}

/**
 * The rule between sections is on the **top** of each one but the first,
 * where the artboard puts it on the bottom of each but the last. Identical
 * with all four on screen, and correct with fewer: a bottom rule on whichever
 * section happened to be last would double up against the footer's own.
 */
const SECTION_RULE: CSSProperties = { borderTop: "1px solid #EEEEF1" }

const BADGE: CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 9,
  display: "grid",
  placeItems: "center",
  fontSize: 13,
  fontWeight: 650,
  boxSizing: "border-box",
}

const LABEL: CSSProperties = { display: "block", fontSize: 16, fontWeight: 650, paddingTop: 4 }
const WHY: CSSProperties = { margin: "4px 0 12px", fontSize: 13.5, lineHeight: 1.5, color: "#4A4E59" }
const STATUS_ROW: CSSProperties = { display: "flex", alignItems: "center", gap: 10, fontSize: 13.5, color: "#20205E" }

/** The two fields. The border is a utility so `:focus-within` can reach it. */
const FIELD_SHELL = "flex items-center gap-2 border border-[#E2E2E7] focus-within:border-[#A9AAF0] focus-within:shadow-[0_0_0_3px_rgba(91,91,214,.18)]"
const FIELD_BOX: CSSProperties = { minHeight: 46, borderRadius: 12, background: "#fff", boxSizing: "border-box" }
const BARE_INPUT: CSSProperties = { border: 0, outline: "none", background: "transparent", width: "100%", color: "#111216" }

/** A pill button. Background is a utility, or the inline value kills the hover. */
const PILL = "ghost bg-white hover:bg-[#F6F6F8]"
const PILL_BOX: CSSProperties = {
  height: 46,
  borderRadius: 999,
  border: "1px solid #D9D9DF",
  fontSize: 14,
  fontWeight: 560,
  color: "#1E2026",
  boxSizing: "border-box",
}

/** The artboard's quiet indigo text action. */
const QUIET = "ghost hover:bg-[#F6F6F8]"
const QUIET_BOX: CSSProperties = {
  marginTop: 10,
  height: 36,
  padding: "0 12px",
  borderRadius: 999,
  border: 0,
  background: "transparent",
  color: "#4B4BC8",
  fontSize: 13.5,
  fontWeight: 560,
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
}

const HEADING_ID = "addrepo-heading"

/* -------------------------------------------------------------------------- */
/* The panel                                                                  */
/* -------------------------------------------------------------------------- */

export function AddRepo({
  path,
  onPathChange,
  detection,
  onCheck,
  onSubmit,
  onCancel,
  accounts = DEFAULT_ACCOUNTS,
  testRun,
  onRunTests,
  onAddAccount,
  onNewTaskFile,
  onOpenRepo,
  className,
}: AddRepoProps): ReactElement {
  const reduced = usePrefersReducedMotion()
  const anim = (classes: string): string => (reduced ? "" : classes)

  /** An `accountKey`, or `UNKNOWN_KEY`. Never a `kind`; see `accountKey`. */
  const [chosenKey, setChosenKey] = useState<string | null>(null)
  /** `null` until the field is touched, which is what lets detection seed it. */
  const [typedCmd, setTypedCmd] = useState<string | null>(null)
  /**
   * The human said this project has no suite.
   *
   * Separate from `typedCmd` rather than folded into it as `""`: an empty
   * field is an unanswered question and must keep the button disabled, while
   * this is an answer. Collapsing them would make a half-deleted command mean
   * "no suite", which is the one reading that gets work merged on a
   * verification nobody performed.
   *
   * It does not clear `typedCmd`, so taking the opt-out back restores the
   * question as it stood - including a detection's suggestion, which the
   * opt-out declined rather than answered.
   */
  const [noSuite, setNoSuite] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [added, setAdded] = useState(false)

  const verdict = verdictOf(detection, path)
  const done = verdict.kind === "usable" ? verdict.done : verdict.kind === "unusable" ? verdict.done : null
  const usableDone = verdict.kind === "usable" ? verdict.done : null

  /**
   * The command, seeded from detection only while the field is untouched.
   *
   * The dimension is "has the human typed in here", and its values are: never,
   * typed something, typed something and cleared it, typed exactly the
   * suggestion. Seeding over a typed value would silently run a command other
   * than the one they believe they set — expensive and invisible — against one
   * extra field to fill in. So it fails toward never overwriting, which also
   * means a later detection for another repository cannot reach it.
   */
  const suggestion = usableDone?.testCmd ?? ""
  const cmd = typedCmd ?? suggestion
  const source = usableDone?.testCmdSource
  const showSource = source !== undefined && suggestion !== "" && cmd === suggestion

  /** The probe failing is not the path failing; see the file header. */
  const canProceed = verdict.kind === "usable" || verdict.kind === "unknown"

  /**
   * The answer, resolved against the list as it stands now.
   *
   * An account that is no longer offered reads as **unanswered** rather than
   * as its old `kind`: the list can change under this panel — `onAddAccount`
   * is one of its own controls — and carrying a word forward after the profile
   * behind it has gone would submit a billing label nothing backs.
   */
  const chosenOption = accounts.find((a) => accountKey(a) === chosenKey)
  const chosen: "personal" | "work" | "unknown" | null =
    chosenKey === UNKNOWN_KEY ? "unknown" : (chosenOption?.kind ?? null)

  /**
   * How far the form has opened. Monotonic: `want` falls as the path goes
   * stale, `reached` does not follow it down. Adjusting state during render is
   * React's own documented pattern for this, and `Math.max` keeps it correct
   * within the pass that raises it — including under strict mode's double
   * invoke, where the second pass computes the same answer.
   */
  /** Section 3 is answered by a command **or** by the opt-out. */
  const commandAnswered = noSuite || cmd.trim() !== ""
  const want: 1 | 2 | 3 | 4 = !canProceed ? 1 : chosen === null ? 2 : !commandAnswered ? 3 : 4
  const [reached, setReached] = useState<1 | 2 | 3 | 4>(1)
  if (want > reached) setReached(want)
  const reveal = want > reached ? want : reached

  const ready = canProceed && chosen !== null && commandAnswered
  const label = repoLabel(usableDone?.root ?? "")
  const taskFiles = usableDone?.taskFiles ?? []

  const submit = async (): Promise<void> => {
    /* Re-read, rather than trusting `disabled`: that attribute is one render
       behind the truth, and a click is not. Nothing may register a path this
       panel has not seen checked. */
    if (!ready || busy || added) return
    setBusy(true)
    setFailure(null)
    try {
      await onSubmit({
        path,
        /* `null` and not the field's contents: a command typed and then opted
           out of is not the answer the human gave. */
        testCmd: noSuite ? null : cmd,
        ...(chosen === "personal" || chosen === "work" ? { account: chosen } : {}),
        ...(chosenOption?.configDir === undefined ? {} : { configDir: chosenOption.configDir }),
      })
      setAdded(true)
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  /** One sentence naming the single next thing, as the artboard's hint does. */
  const profileClause =
    chosen === "unknown"
      ? null
      : chosenOption?.configDir === undefined
        ? " on the default profile"
        : ` from ${chosenOption.configDir}`
  const hint = !canProceed
    ? verdict.kind === "unusable"
      ? "Fix the path above, then check it again."
      : verdict.kind === "checking"
        ? /* Not "Check the folder first." while a check is visibly running:
             the spinner two sections up is already saying otherwise. */
          "Checking that folder now."
        : "Check the folder first."
    : chosen === null
      ? "Say which Claude account runs it."
      : cmd.trim() === ""
        ? "Say how to run the tests."
        : chosen === "unknown"
          ? `No account recorded, so it runs on the default profile. Tests: ${cmd}.`
          : `Runs as ${chosenOption?.label ?? chosen}${profileClause ?? ""}. Tests: ${cmd}.`

  return (
    <>
      <main
        data-addrepo="root"
        data-motion={reduced ? "static" : "animated"}
        /* `kr` is what `artboard.css`'s reduced-motion `!important` guard needs;
           `leading-[normal]` undoes Tailwind's preflight 1.5, which the
           artboard never had. `Empty.tsx` and `Tree.tsx` do the same. */
        className={`kr leading-[normal]${className === undefined ? "" : ` ${className}`}`}
        style={{
          flex: "999 1 560px",
          minWidth: 0,
          minHeight: 0,
          position: "relative",
          overflowY: "auto",
          padding: "24px clamp(16px,3vw,44px) 48px",
          boxSizing: "border-box",
        }}
      >
        {/* The dotted ground is its own layer: `.dots` carries a mask, and a
            mask applies to an element's whole rendering, children included. */}
        <div className="dots pointer-events-none absolute inset-0" aria-hidden="true" />

        <div style={{ position: "relative", maxWidth: 780, margin: "0 auto" }}>
          <section
            aria-labelledby={HEADING_ID}
            className={anim("bf")}
            style={{
              background: "#fff",
              border: "1px solid #E7E7EB",
              borderRadius: 24,
              boxShadow: "0 1px 2px rgba(17,18,22,.04),0 18px 50px -22px rgba(17,18,22,.2)",
              overflow: "clip",
            }}
          >
            <div style={{ padding: "30px clamp(20px,4vw,40px) 22px", borderBottom: "1px solid #EEEEF1" }}>
              <h1
                id={HEADING_ID}
                style={{
                  margin: 0,
                  fontSize: "clamp(28px,3.4vw,38px)",
                  lineHeight: 1.08,
                  fontWeight: 650,
                  letterSpacing: "-.035em",
                }}
              >
                Add a repository
              </h1>
              <p style={{ margin: "10px 0 0", maxWidth: "58ch", fontSize: 15, lineHeight: 1.6, color: "#4A4E59" }}>
                Four things kantan needs to know. It checks as much as it can itself, so most of this fills in on its
                own.
              </p>
            </div>

            {/* ── 1. Where is it? ─────────────────────────────────────────── */}
            <div data-section="1" className={anim("bf d1")} style={SECTION}>
              <span style={{ ...BADGE, background: "#111216", color: "#fff" }}>1</span>
              <div style={{ minWidth: 0 }}>
                <label htmlFor="addrepo-path" style={LABEL}>
                  Where is it?
                </label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 12 }}>
                  <span className={FIELD_SHELL} style={{ ...FIELD_BOX, flex: "1 1 300px", padding: "0 14px" }}>
                    <Folder size={15} color="#6B7080" />
                    <input
                      id="addrepo-path"
                      data-addrepo="path"
                      className="m placeholder:text-[#7A7F8C]"
                      value={path}
                      onChange={(e) => onPathChange(e.target.value)}
                      onKeyDown={(e) => {
                        /* Enter checks. There is no form and no implicit
                           submit: the point of this screen is that nothing
                           registers before it has been looked at. */
                        if (e.key === "Enter") {
                          e.preventDefault()
                          onCheck()
                        }
                      }}
                      placeholder="/home/you/code/…"
                      /* Every one of these is a path guess with a vendor behind
                         it. A keyboard that turns `/usr` into `/Usr` produces
                         the production failure with nobody having typed it. */
                      spellCheck={false}
                      autoCapitalize="off"
                      autoCorrect="off"
                      autoComplete="off"
                      style={{ ...BARE_INPUT, fontSize: 13.5 }}
                    />
                  </span>
                  <button
                    type="button"
                    data-addrepo="check"
                    onClick={onCheck}
                    className={PILL}
                    style={{ ...PILL_BOX, padding: "0 16px" }}
                  >
                    Check
                  </button>
                </div>

                {verdict.kind === "checking" && (
                  <div role="status" className={anim("pop")} style={{ ...STATUS_ROW, marginTop: 12 }}>
                    <Spinner spin={!reduced} />
                    Looking at the folder…
                  </div>
                )}

                {verdict.kind === "unknown" && (
                  <div
                    role="status"
                    className={anim("pop")}
                    style={{ ...STATUS_ROW, marginTop: 12, color: "#6B4A05", alignItems: "flex-start" }}
                  >
                    <CheckGlyph status="info" />
                    <span>
                      {verdict.why} kantan will check it again when you add it.
                    </span>
                  </div>
                )}

                {done !== null && (
                  <ul
                    data-addrepo="checks"
                    style={{
                      listStyle: "none",
                      margin: "12px 0 0",
                      padding: 0,
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                      fontSize: 13.5,
                      color: "#2A2C33",
                    }}
                  >
                    {done.checks.map((check, index) => (
                      <li
                        key={`${check.code ?? "check"}-${index}`}
                        data-status={check.status}
                        className={anim("pop")}
                        style={{
                          display: "flex",
                          /* `flex-start`, where the artboard writes `center`.
                             Every row it draws is one line, so the two agree
                             there to within a pixel — and the row that matters
                             most here is the refusal, which runs to three
                             lines and floated its cross into the middle of the
                             paragraph. Caught in a screenshot. */
                          alignItems: "flex-start",
                          gap: 10,
                          /* The artboard's own .1s-per-row stagger, inline
                             because `artboard.css`'s delay ladder is a fixed
                             set of rungs and this list is any length. */
                          ...(index === 0 || reduced ? {} : { animationDelay: `${index / 10}s` }),
                        }}
                      >
                        <CheckGlyph status={check.status} />
                        <span>
                          <Phrase says={check.says} />
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {/* ── 2. Which account? ───────────────────────────────────────── */}
            {reveal >= 2 && (
              <div data-section="2" className={anim("bf d2")} style={{ ...SECTION, ...SECTION_RULE }}>
                <span style={{ ...BADGE, background: "#111216", color: "#fff" }}>2</span>
                <div style={{ minWidth: 0 }}>
                  <h2 style={{ ...LABEL, margin: 0 }}>Which Claude account runs it?</h2>
                  <p style={WHY}>
                    Billing and the 5-hour limit follow this. You can change it later from the project.
                  </p>
                  <div
                    role="radiogroup"
                    aria-label="Claude account"
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit,minmax(min(220px,100%),1fr))",
                      gap: 10,
                    }}
                  >
                    {accounts.map((option) => (
                      <AccountCard
                        key={accountKey(option)}
                        option={option}
                        selected={chosenKey === accountKey(option)}
                        onPick={() => setChosenKey(accountKey(option))}
                        reduced={reduced}
                      />
                    ))}
                    {/* The third answer. `Tree.tsx`'s `Account` forbids
                        defaulting to "personal", so not knowing has to be
                        sayable rather than assumed. */}
                    <AccountCard
                      option={{ kind: "personal", label: "Not sure" }}
                      unknown
                      selected={chosenKey === UNKNOWN_KEY}
                      onPick={() => setChosenKey(UNKNOWN_KEY)}
                      reduced={reduced}
                    />
                  </div>
                  {onAddAccount !== undefined && (
                    <button type="button" onClick={onAddAccount} className={QUIET} style={QUIET_BOX}>
                      <Plus />
                      Add another account
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* ── 3. How are the tests run? ───────────────────────────────── */}
            {reveal >= 3 && (
              <div data-section="3" className={anim("bf d3")} style={{ ...SECTION, ...SECTION_RULE }}>
                <span style={{ ...BADGE, background: "#111216", color: "#fff" }}>3</span>
                <div style={{ minWidth: 0 }}>
                  {/* A `for` naming an input that is not on screen points at
                      nothing, so the heading is only a label while the field
                      exists. The question itself does not change. */}
                  {noSuite ? (
                    <span style={{ ...LABEL, display: "block" }}>How do you run the tests?</span>
                  ) : (
                    <label htmlFor="addrepo-cmd" style={LABEL}>
                      How do you run the tests?
                    </label>
                  )}
                  <p style={WHY}>
                    {noSuite
                      ? "You have said there is none, so a fresh agent verifies its own work and every run records that nothing outside it checked the result."
                      : "kantan decides pass or fail from this command's exit code alone."}
                  </p>
                  {noSuite ? (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
                      <span
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
                        data-addrepo="cmd-restore"
                        onClick={() => setNoSuite(false)}
                        className={PILL}
                        style={{ ...PILL_BOX, padding: "0 16px" }}
                      >
                        Give it a test command
                      </button>
                    </div>
                  ) : (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
                    <span className={FIELD_SHELL} style={{ ...FIELD_BOX, flex: "1 1 260px", padding: "0 8px 0 14px" }}>
                      <span className="m" style={{ color: "#8A8F9C" }}>
                        $
                      </span>
                      <input
                        id="addrepo-cmd"
                        data-addrepo="cmd"
                        className="m"
                        value={cmd}
                        onChange={(e) => setTypedCmd(e.target.value)}
                        style={{ ...BARE_INPUT, fontSize: 14 }}
                      />
                      {showSource && (
                        <span
                          style={{
                            flex: "none",
                            padding: "3px 8px",
                            borderRadius: 999,
                            background: "#F1F1F4",
                            fontSize: 11.5,
                            color: "#4A4E59",
                            whiteSpace: "nowrap",
                          }}
                        >
                          from {source}
                        </span>
                      )}
                    </span>
                    {onRunTests !== undefined && (
                      <button
                        type="button"
                        onClick={() => onRunTests(cmd)}
                        className={PILL}
                        style={{ ...PILL_BOX, padding: "0 16px 0 14px", display: "inline-flex", alignItems: "center", gap: 8 }}
                      >
                        <svg aria-hidden="true" viewBox="0 0 24 24" style={{ width: 12, height: 12, fill: "#1E2026" }}>
                          <polygon points="6 3 20 12 6 21 6 3" />
                        </svg>
                        Run it once
                      </button>
                    )}
                  </div>
                  )}
                  {!noSuite && (
                    <button
                      type="button"
                      data-addrepo="cmd-none"
                      onClick={() => setNoSuite(true)}
                      style={{
                        marginTop: 10,
                        border: 0,
                        padding: 0,
                        background: "none",
                        font: "inherit",
                        fontSize: 13.5,
                        fontWeight: 560,
                        color: "#5B5BD6",
                        cursor: "pointer",
                        textDecoration: "underline",
                        textUnderlineOffset: 3,
                      }}
                    >
                      This project has no test suite
                    </button>
                  )}
                  {!noSuite && <TestOutcome run={testRun} cmd={cmd} reduced={reduced} />}
                </div>
              </div>
            )}

            {/* ── 4. Where are the tasks? ─────────────────────────────────── */}
            {reveal >= 4 && (
              <div data-section="4" className={anim("bf d4")} style={{ ...SECTION, ...SECTION_RULE }}>
                <span style={{ ...BADGE, background: "#FF6A1A", color: "#1A0B02", fontWeight: 700 }}>4</span>
                <div style={{ minWidth: 0 }}>
                  <h2 style={{ ...LABEL, margin: 0 }}>Where are the tasks?</h2>
                  <p style={WHY}>
                    kantan reads every markdown file in <span className="m">docs/features/</span>, so this is what it
                    will find. You can add more later.
                  </p>
                  {taskFiles.length === 0 ? (
                    <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: "#4A4E59" }}>
                      No task files yet. Nothing will run until there is one, and you can write the first from the
                      project once it is added.
                    </p>
                  ) : (
                    <ul
                      style={{
                        listStyle: "none",
                        margin: 0,
                        padding: 0,
                        border: "1px solid #EEEEF1",
                        borderRadius: 14,
                        overflow: "hidden",
                      }}
                    >
                      {taskFiles.map((file, index) => (
                        <li key={file.path} style={index === 0 ? { borderTop: 0 } : { borderTop: "1px solid #F0F0F3" }}>
                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns: "22px minmax(0,1fr) auto",
                              gap: 12,
                              alignItems: "center",
                              minHeight: 50,
                              padding: "0 14px",
                              ...(file.tasks.length === 0 ? { color: "#6B7080" } : {}),
                            }}
                          >
                            {file.tasks.length === 0 ? <span /> : <CheckGlyph status="pass" />}
                            <span className="m" style={{ fontSize: 13, overflowWrap: "anywhere" }}>
                              {file.path}
                            </span>
                            <span style={{ fontSize: 12.5, ...(file.tasks.length === 0 ? {} : { color: "#5F6370" }) }}>
                              {file.tasks.length === 0
                                ? "no tasks found"
                                : `${file.tasks.length} ${file.tasks.length === 1 ? "task" : "tasks"}`}
                            </span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  {onNewTaskFile !== undefined && (
                    <button type="button" onClick={onNewTaskFile} className={QUIET} style={QUIET_BOX}>
                      <svg className="ic" aria-hidden="true" viewBox="0 0 24 24" style={{ width: 14, height: 14 }} {...LINE}>
                        <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
                        <path d="M14 2v4a2 2 0 0 0 2 2h4" />
                        <path d="M12 12v6" />
                        <path d="M9 15h6" />
                      </svg>
                      Start a new task file instead
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* ── The action ──────────────────────────────────────────────── */}
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: "12px 14px",
                padding: "20px clamp(20px,4vw,40px) 24px",
                borderTop: "1px solid #EEEEF1",
                background: "#FBFBFC",
              }}
            >
              {failure !== null && (
                <p
                  role="alert"
                  style={{
                    flex: "1 1 100%",
                    margin: 0,
                    borderRadius: 12,
                    border: "1px solid #F3C6C9",
                    background: "#FDF2F3",
                    padding: "10px 14px",
                    fontSize: 13,
                    lineHeight: 1.5,
                    color: "#D92D3A",
                  }}
                >
                  {failure}
                </p>
              )}

              {added ? (
                <div
                  className={anim("pop")}
                  role="status"
                  style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px 14px", minHeight: 54 }}
                >
                  <span
                    aria-hidden="true"
                    style={{ width: 24, height: 24, borderRadius: "50%", background: "#111216", display: "grid", placeItems: "center" }}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      style={{ width: 12, height: 12 }}
                      fill="none"
                      stroke="#fff"
                      strokeWidth={3.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  </span>
                  <span style={{ fontSize: 16, fontWeight: 620 }}>{label} is ready. Pick a task to start.</span>
                  {onOpenRepo !== undefined && (
                    <button
                      type="button"
                      onClick={onOpenRepo}
                      className="ghost"
                      style={{
                        border: 0,
                        background: "transparent",
                        padding: "4px 6px",
                        borderRadius: 999,
                        color: "#4B4BC8",
                        fontSize: 14,
                        fontWeight: 600,
                      }}
                    >
                      Open {label}
                    </button>
                  )}
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    data-addrepo="add"
                    onClick={() => void submit()}
                    disabled={!ready || busy}
                    className={`cta ${ready && !busy ? "bg-[#111216] hover:bg-[#2A2B31]" : "bg-[#E4E4E9]"}`}
                    style={{
                      height: 54,
                      padding: "0 24px 0 20px",
                      borderRadius: 999,
                      border: 0,
                      fontSize: 16,
                      fontWeight: 620,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 10,
                      boxSizing: "border-box",
                      ...(ready && !busy
                        ? { color: "#fff", boxShadow: "0 10px 28px -10px rgba(17,18,22,.6)" }
                        : { color: "#6B7080", cursor: "not-allowed" }),
                    }}
                  >
                    <Plus size={18} weight={2.4} />
                    {busy ? `Adding ${label}…` : `Add ${label}`}
                  </button>
                  <button
                    type="button"
                    onClick={onCancel}
                    className={PILL}
                    style={{ ...PILL_BOX, height: 48, padding: "0 18px", display: "inline-flex", alignItems: "center" }}
                  >
                    Cancel
                  </button>
                  <span style={{ fontSize: 13, color: "#4A4E59", flex: "1 1 200px" }}>{hint}</span>
                </>
              )}
            </div>
          </section>
        </div>
      </main>

      {/* ── The right rail: what will be added ───────────────────────────── */}
      <aside
        data-addrepo="preview"
        aria-label="Preview"
        className="kr leading-[normal]"
        style={{
          flex: "1 1 260px",
          minWidth: 0,
          borderLeft: "1px solid #E7E7EB",
          background: "#FAFAFB",
          padding: "20px 16px 28px",
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          gap: 14,
          overflowY: "auto",
        }}
      >
        <section
          style={{
            background: "#fff",
            border: "1px solid #E7E7EB",
            borderRadius: 16,
            padding: "14px 10px 12px",
            boxShadow: "0 1px 2px rgba(17,18,22,.04)",
          }}
        >
          <h2
            style={{
              margin: "0 6px 10px",
              fontSize: 11.5,
              fontWeight: 600,
              letterSpacing: ".07em",
              textTransform: "uppercase",
              color: "#6B7080",
            }}
          >
            How it will look
          </h2>

          {/* Wrapping, and `break-word` rather than `anywhere`. Caught in a
              screenshot: this rail is 260px, "account unknown" is a wide chip,
              and with neither of those the name shrank and broke mid-word —
              "your-" / "app", and "this / reposit / ory". `break-word` breaks
              inside a word only when the word cannot fit a line of its own,
              so a repository called something long still cannot overflow. */}
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: 6 }}>
            {/* The icon and the name are one flex item, so the only place the
                row may break is before the chip. Wrapping is decided on
                max-content widths before anything shrinks, so a long name
                would otherwise go to its own line and leave the folder icon
                stranded above it. */}
            <span style={{ display: "flex", alignItems: "center", gap: 8, flex: "1 1 auto", minWidth: 0 }}>
              <Folder color="#6B7080" />
              <span style={{ fontSize: 14, fontWeight: 620, minWidth: 0, overflowWrap: "break-word" }}>{label}</span>
            </span>
            <AccountChip chosen={chosen} option={chosenOption} />
          </div>

          {cmd.trim() !== "" && (
            <div className="m" style={{ padding: "0 6px 6px 30px", fontSize: 12, color: "#6B7080", overflowWrap: "anywhere" }}>
              $ {cmd}
            </div>
          )}

          {usableDone === null ? (
            <p style={{ margin: 6, fontSize: 12.5, lineHeight: 1.5, color: "#5F6370" }}>
              Nothing to preview until the folder checks out.
            </p>
          ) : taskFiles.length === 0 ? (
            <p style={{ margin: 6, fontSize: 12.5, color: "#5F6370" }}>No task files yet.</p>
          ) : (
            taskFiles.map((file) => (
              <div key={file.path} className={anim("pop")} style={{ padding: "4px 6px" }}>
                <div
                  className="m"
                  style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#5F6370", padding: "4px 0" }}
                >
                  <svg className="ic" aria-hidden="true" viewBox="0 0 24 24" style={{ width: 12, height: 12 }} {...LINE}>
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                  <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{file.path}</span>
                </div>
                {file.tasks.map((task, index) => (
                  <div
                    key={`${task.ref ?? "none"}-${index}`}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "16px 20px minmax(0,1fr)",
                      gap: 6,
                      alignItems: "center",
                      padding: "4px 0 4px 8px",
                      fontSize: 13,
                      color: "#2A2C33",
                    }}
                  >
                    {/* Every task starts open, which is the empty circle. */}
                    <span
                      aria-hidden="true"
                      style={{ width: 12, height: 12, borderRadius: "50%", border: "1.5px solid #A3A7B1", boxSizing: "border-box" }}
                    />
                    <span className="m" style={{ fontSize: 11, color: "#6B7080" }}>
                      {task.ref ?? ""}
                    </span>
                    <span>{task.text}</span>
                  </div>
                ))}
              </div>
            ))
          )}
        </section>
        <p style={{ margin: "0 4px", fontSize: 12.5, lineHeight: 1.5, color: "#5F6370" }}>
          Every task starts as open. Nothing runs until you press start.
        </p>
      </aside>
    </>
  )
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One account, as a radio.
 *
 * The ring column is dropped entirely when there is no figure to draw, rather
 * than left as a 40px hole: the artboard's three-column grid assumes a ring,
 * and an empty first column reads as a rendering fault.
 */
function AccountCard({
  option,
  selected,
  onPick,
  reduced,
  unknown = false,
}: {
  option: AccountOption
  selected: boolean
  onPick: () => void
  reduced: boolean
  unknown?: boolean
}): ReactElement {
  const kind = unknown ? "unknown" : option.kind
  const arc = unknown ? null : ringArc(option.usedFraction)
  const name = option.label ?? option.kind
  const nameColour = unknown ? "#5F6370" : option.kind === "personal" ? "#075985" : "#26272D"
  const track = option.kind === "personal" ? "#E6F3FB" : "#EEEEF1"
  const stroke = option.kind === "personal" ? "#0284C7" : "#26272D"

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-account={kind}
      /* The identity, where `data-account` is only the word. Two work accounts
         for two clients share the latter and must not share the former. */
      data-account-key={unknown ? UNKNOWN_KEY : accountKey(option)}
      onClick={onPick}
      style={{
        display: "grid",
        gridTemplateColumns: arc === null ? "minmax(0,1fr) 20px" : "40px minmax(0,1fr) 20px",
        gap: 12,
        alignItems: "center",
        minHeight: 72,
        padding: "12px 14px",
        borderRadius: 16,
        textAlign: "left",
        color: "#111216",
        boxSizing: "border-box",
        ...(selected
          ? { border: "1.5px solid #111216", background: "#fff", boxShadow: "0 8px 20px -14px rgba(17,18,22,.5)" }
          : { border: "1px solid #E2E2E7", background: "#FCFCFD" }),
      }}
    >
      {arc !== null && (
        <span style={{ position: "relative", width: 40, height: 40 }}>
          <svg
            data-addrepo="ring"
            viewBox="0 0 60 60"
            aria-hidden="true"
            style={{ width: 40, height: 40, transform: "rotate(-90deg)" }}
          >
            <circle cx="30" cy="30" r="25" fill="none" stroke={track} strokeWidth="7" />
            <circle
              className={reduced ? "" : "ring"}
              cx="30"
              cy="30"
              r="25"
              fill="none"
              stroke={stroke}
              strokeWidth="7"
              strokeLinecap="round"
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={arc.offset}
            />
          </svg>
          <span style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", fontSize: 10.5, fontWeight: 650 }}>
            {arc.percent}%
          </span>
        </span>
      )}
      <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span
          style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 15, fontWeight: 620, color: nameColour }}
        >
          <AccountIcon kind={kind} />
          {name}
        </span>
        {/* The profile, or the absence of one said out loud. Never derived from
            the kind: see the file header. */}
        <span className="m" style={{ fontSize: 12, color: "#5F6370", overflowWrap: "anywhere" }}>
          {unknown ? "no account recorded" : (option.configDir ?? "default profile")}
        </span>
      </span>
      <span
        aria-hidden="true"
        style={{
          width: 20,
          height: 20,
          borderRadius: "50%",
          boxSizing: "border-box",
          background: "#fff",
          ...(selected ? { border: "6px solid #111216" } : { border: "1.5px solid #C4C7CE" }),
        }}
      />
    </button>
  )
}

/**
 * The result of running the tests once, or nothing.
 *
 * Stale is nothing: a result belongs to the command that produced it, and a
 * green `exit 0` under a command nobody ran is worse than no chip at all. Same
 * guard as the path, same direction.
 */
function TestOutcome({ run, cmd, reduced }: { run: TestRun | undefined; cmd: string; reduced: boolean }): ReactNode {
  if (run === undefined || run.phase === "idle" || run.cmd !== cmd) return null
  if (run.phase === "refused") {
    /* The server's own sentence, forwarded: it names the run that is in flight
       or the reason the command could not start, and either is the only thing
       the reader can act on. No chip and no number - nothing ran. */
    return (
      <div role="status" className={reduced ? "" : "pop"} style={{ ...STATUS_ROW, marginTop: 10, color: "#9A3412" }}>
        {run.why}
      </div>
    )
  }
  if (run.phase === "running") {
    return (
      <div role="status" className={reduced ? "" : "pop"} style={{ ...STATUS_ROW, marginTop: 10 }}>
        <Spinner spin={!reduced} />
        Running <span className="m">{cmd}</span>…
      </div>
    )
  }
  return (
    <div
      role="status"
      className={reduced ? "" : "pop"}
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
      {/* The code, always printed. `Row.tsx`'s solid chip, which is the
          treatment `Return.dc.html` draws for a test result. */}
      <span
        className="m"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          padding: "3px 9px",
          borderRadius: 999,
          background: run.exitCode === 0 ? "#0F8A5F" : "#D92D3A",
          color: "#fff",
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        exit {run.exitCode}
      </span>
      {run.summary === undefined ? null : run.summary}
    </div>
  )
}

/** The preview's account badge, which claims nothing before an answer. */
function AccountChip({
  chosen,
  option,
}: {
  chosen: "personal" | "work" | "unknown" | null
  option: AccountOption | undefined
}): ReactElement {
  const known = chosen === "personal" || chosen === "work"
  return (
    <span
      data-addrepo="preview-account"
      style={{
        marginLeft: "auto",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 7px",
        borderRadius: 6,
        fontSize: 11.5,
        fontWeight: 550,
        whiteSpace: "nowrap",
        ...(chosen === "personal"
          ? { background: "#E0F2FE", color: "#075985" }
          : chosen === "work"
            ? { background: "#26272D", color: "#F4F4F6" }
            : { background: "#F1F1F4", color: "#5F6370" }),
      }}
    >
      {known ? (option?.label ?? chosen) : "account unknown"}
    </span>
  )
}
