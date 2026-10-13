/**
 * One line of the run record.
 *
 * The design is authoritative: `docs/design/Main.dc.html` draws the rows under
 * the gate and `docs/design/Return.dc.html` the same log while a run is coming
 * back. Both use the same four-column grid — icon, label, body, clock — at
 * `22px 58px minmax(0,1fr) auto`. That `minmax(0,...)` is load-bearing: a grid
 * track defaults to `min-content`, so without it a 156-character path from
 * `test/fixtures/plan-success.jsonl` widens the whole row and overflows the
 * card instead of wrapping.
 *
 * ## Three rules this file exists to keep
 *
 * **Nothing is hidden.** A row shows everything it holds, or it is a button
 * that expands to the rest. The classifier below reads the event kind and, for
 * a tool, the tool's name — and every branch of it, including the ones no
 * fixture produces, ends in a body with text in it. `src/backlog.ts` cost this
 * project fourteen defects by guessing which input to skip; a renderer that
 * draws a blank row is the same mistake with a different surface.
 *
 * **`unknown` is not an error.** `src/stream.ts` routes anything it does not
 * recognise there on purpose, so a future CLI event *appears* rather than
 * vanishing. It gets a dashed outline, a muted icon, the discriminator it
 * arrived with, and its raw JSON one click away. Never red, never dropped.
 *
 * **`parse_error` is normal input.** A process killed mid-write produces one.
 * It reads as a calm note, in the design's own words, with the line kept.
 *
 * ## The one deliberate departure from the artboards
 *
 * The artboards draw `read`, `write`, `shell` and `raw` rows as plain `div`s,
 * so the parts of a tool input the body does not name have nowhere to go. Here
 * every row that holds more than it shows is a `button` with `aria-expanded`
 * instead. At rest it is pixel-identical — the artboards already give every row
 * the same hover — and it is the cheap direction: an extra click beats a value
 * that silently never appears.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"

import type { Event } from "../stream"
/* The rail already formats this exact field. See the `rate_limit` row. */
import { formatResetTime } from "./format.ts"

// --- The rows a run record can hold ----------------------------------------

/**
 * A parsed CLI event, with the identity and arrival time the parser does not
 * carry. `id` must be stable and unique for the life of the run: the entry
 * animation and the virtualizer's measurement cache are both keyed on it, so a
 * reused id makes an old row animate and mismeasure.
 */
export interface EventRow {
  id: string
  /** Epoch milliseconds. Absent leaves the clock column empty. */
  at?: number
  event: Event
  /**
   * The raw `result` line's `errors`, verbatim.
   *
   * `src/stream.ts` deliberately does not surface it, and on
   * `error_max_budget_usd` the event carries no `result` key at all — the
   * fixture's only prose is `["Reached maximum budget ($0.0001)"]` in here. A
   * caller that drops it hands this component a failure with nothing to say,
   * so whoever builds these rows has to pass it through.
   */
  errors?: unknown
}

/** What the server read after running the project's own test command. */
export interface TestsSeen {
  /**
   * Printed, never paraphrased. It is the product's core promise: the server
   * runs the tests and branches on this number, and what the agent says about
   * its own work is never used. `src/testrun.ts` also reports 124 for a
   * timeout and 128 + signal for a death by signal, so "non-zero" is the only
   * safe reading of anything but 0.
   */
  exitCode: number
  /** 1 for the first run of the tests in this run. */
  attempt?: number
  /** The runner's own summary line, e.g. "10 passing, 1 failing". */
  summary?: string
  /** The tail of the output, shown when the row is expanded. */
  output?: string
}

/** A test run, which is the orchestrator's own record rather than a CLI event. */
export interface TestsRow {
  id: string
  at?: number
  tests: TestsSeen
}

export type StreamRow = EventRow | TestsRow

/** Narrowing helper, so callers do not have to know which key discriminates. */
export function isTestsRow(row: StreamRow): row is TestsRow {
  return "tests" in row
}

// --- Bounds -----------------------------------------------------------------

/**
 * How much of a long value an expanded panel shows.
 *
 * A `parse_error` line can be megabytes — it is whatever the CLI had written
 * when it died — and a `tool_result` carries file contents. The cap keeps one
 * row from stalling the page, and the panel says how many characters it is not
 * showing, because a cap that does not announce itself is the invisible
 * truncation DESIGN.md forbids.
 */
export const MAX_PANEL_CHARS = 20_000

/** Lines shown per side of a before/after comparison, before the same note. */
export const MAX_DIFF_LINES = 60

/** What the virtualizer assumes before it measures: one unwrapped line. */
export const ROW_ESTIMATE_PX = 38

/**
 * The tint `Return.dc.html` puts under a failing suite — and under nothing
 * else in either artboard.
 *
 * Inline, exactly as the artboard writes it, because as a class it loses. Both
 * `bg-[#FFFBFB]` and the row's own `hover:bg-panel` are Tailwind utilities, and
 * Tailwind emits the hover variant *after* the plain one, so the tint was being
 * repainted #FAFAFB the moment the pointer crossed a failing row. `.lr:hover`
 * from `artboard.css` is a second claimant on the same property. An inline
 * style outranks every one of them, which is why the artboard puts it there.
 */
const FAIL_TINT: CSSProperties = { background: "#FFFBFB" }

// --- Icons ------------------------------------------------------------------

/**
 * Lucide paths, lifted from the artboards' own inline SVG. Hand-written rather
 * than imported: `lucide-react` is not a dependency, and adding one would mean
 * editing `package.json` and `bun.lock`, which three other agents share.
 */
const ICONS = {
  terminal: (
    <>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" x2="20" y1="19" y2="19" />
    </>
  ),
  file: (
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </>
  ),
  pencil: (
    <>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <path d="m15 5 4 4" />
    </>
  ),
  message: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  clock: (
    <>
      <path d="m12 14 4-4" />
      <path d="M3.34 19a10 10 0 1 1 17.32 0" />
    </>
  ),
  /**
   * Lucide's `git-commit-horizontal`: a node on a line.
   *
   * Added rather than reused. The nearest existing glyph is `flag`, which is
   * the *result* row - so a commit wearing it would read as a run outcome on a
   * glance down the log, and a glance down the log is how this record is
   * actually read. `check` was the other candidate and belongs to a successful
   * tool result.
   */
  commit: (
    <>
      <circle cx="12" cy="12" r="3" />
      <line x1="3" x2="9" y1="12" y2="12" />
      <line x1="15" x2="21" y1="12" y2="12" />
    </>
  ),
  /** The dashes are the point: this shape says "not recognised", in greyscale. */
  queried: (
    <>
      <circle cx="12" cy="12" r="10" strokeDasharray="3 3" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </>
  ),
  braces: (
    <>
      <path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1" />
      <path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" />
    </>
  ),
  flask: (
    <>
      <path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2" />
      <path d="M8.5 2h7" />
      <path d="M7 16h10" />
    </>
  ),
  shield: (
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
  ),
  shieldCheck: (
    <>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  check: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  warn: (
    <>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </>
  ),
  play: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M10 8l6 4-6 4z" />
    </>
  ),
  flag: (
    <>
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <line x1="4" x2="4" y1="22" y2="15" />
    </>
  ),
  ellipsis: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </>
  ),
  list: (
    <>
      <path d="m3 17 2 2 4-4" />
      <path d="m3 7 2 2 4-4" />
      <path d="M13 6h8" />
      <path d="M13 12h8" />
      <path d="M13 18h8" />
    </>
  ),
  bot: (
    <>
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M15 13v2" />
      <path d="M9 13v2" />
    </>
  ),
  wrench: (
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  ),
  arrowDown: (
    <>
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </>
  ),
} as const

export type IconName = keyof typeof ICONS

/**
 * One icon, drawn the way the artboard draws every icon.
 *
 * `ic` is the artboard's own preset — `fill:none;stroke:currentColor;
 * stroke-width:2;round caps;flex:none`, at 16px — and `src/ui/artboard.css`
 * carries it verbatim. The same values are repeated as presentation attributes
 * so the icon is still an icon when that file has not loaded, and so that this
 * component is correct on its own.
 *
 * The size is an **inline style**, not a utility, for the one property where
 * the two would fight: `.ic` sets `width:16px`, it is unlayered, and unlayered
 * CSS outranks anything Tailwind puts in `@layer utilities` whatever the
 * specificity. The artboard solves it the same way — `class="ic"
 * style="width:15px;height:15px"` on every row glyph.
 */
export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ width: size, height: size }}
      className={`ic shrink-0 ${className ?? ""}`}
    >
      {ICONS[name]}
    </svg>
  )
}

// --- The exit-code chip -----------------------------------------------------

/**
 * The number, in mono, always.
 *
 * DESIGN.md's sixth promise and the designer's note agree: exit codes are
 * printed, never paraphrased. No "looks good", no "passed" standing in for a
 * code, and no bare green tick.
 *
 * The geometry is `Return.dc.html`'s failing suite, to the pixel: `class="m"`,
 * `padding:2px 8px`, `border-radius:999px`, `font-size:12px`, `font-weight:600`,
 * white on the outcome colour. The artboard puts **no glyph inside the chip** —
 * the digits are the whole message, and "read by kantan" beside it is who read
 * them. A previous version carried a shield in here that the design does not
 * draw.
 */
export function ExitCodeChip({ code }: { code: number }) {
  const passed = code === 0
  return (
    <span
      className={[
        "m inline-flex items-center rounded-full px-2 py-[2px]",
        "font-mono text-xs font-semibold text-white",
        passed ? "bg-pass" : "bg-fail",
      ].join(" ")}
    >
      exit {code}
    </span>
  )
}

// --- Small text helpers -----------------------------------------------------

/** `1234567` as `1,234,567`, without depending on the host's locale. */
export function group(n: number): string {
  const digits = Math.trunc(Math.abs(n)).toString()
  let out = ""
  for (const [i, ch] of [...digits].entries()) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ","
    out += ch
  }
  return (n < 0 ? "-" : "") + out
}

/** `HH:MM:SS`, the artboards' clock column. */
export function clock(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}


/** A string field of an unknown tool input, or `undefined` if it is not one. */
function field(input: unknown, key: string): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
  const v = (input as Record<string, unknown>)[key]
  return typeof v === "string" && v !== "" ? v : undefined
}

/** `JSON.stringify` that never throws and never returns `undefined`. */
function json(value: unknown, indent = 0): string {
  try {
    const out = JSON.stringify(value, null, indent)
    return out === undefined ? String(value) : out
  } catch {
    return String(value)
  }
}

/** The first line with something on it, for a collapsed one-line body. */
function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    if (line.trim() !== "") return line
  }
  return ""
}

// --- Building blocks --------------------------------------------------------

/**
 * A machine value. `wrap-anywhere` plus the `min-w-0` here and the
 * `minmax(0,1fr)` on the row's grid are the three things that make a
 * 156-character path wrap instead of overflowing. Nothing on this path may
 * clamp: `truncate`, `text-ellipsis` and `whitespace-nowrap` would hide the
 * end of a path with no sign that they had.
 */
function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={`m block min-w-0 font-mono text-[12.5px] wrap-anywhere ${className ?? "text-muted-900"}`}>
      {children}
    </span>
  )
}

/**
 * Agent prose, the one thing that clamps — and only behind the expand control
 * the artboards give it (`c4` in `Main.dc.html`, `cProse` in `Return.dc.html`).
 */
function Prose({ children, open }: { children: ReactNode; open: boolean }) {
  return (
    <span className={open ? "block min-w-0" : "block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"}>
      {children}
    </span>
  )
}

/**
 * What an expanded row reveals, indented to line up with the body column.
 *
 * 106px is that column's own offset — 16 padding + 22 icon + 10 gap + 58 label
 * + 10 gap — so this sits under the text it belongs to rather than under the
 * gutter, which is where `Main.dc.html` puts an unrecognised event's raw JSON
 * and `Return.dc.html` a failing suite's output.
 *
 * ## Why it is not *in* that column, which is where the artboards draw it
 *
 * Because an expandable row is a `<button>`, and **text inside a button cannot
 * be selected**. Probed in headless Chrome against this very panel: a drag
 * across the raw JSON of an unrecognised event selected zero characters, and
 * the mouse-up collapsed the row. So nesting it cost exactly the thing the
 * `unknown` row exists for — a `system/vcs_state_changed` nobody can copy out
 * is not much better than one that was never shown.
 *
 * The artboards are static HTML and could not have discovered this. The cost
 * of the departure is a few pixels of vertical space and a panel outside the
 * row's hover tint; the cost of following them is an uncopyable record.
 */
function Detail({ children }: { children: ReactNode }) {
  return <div className="pt-1 pr-4 pb-3.5 pl-[106px]">{children}</div>
}

/**
 * An expanded block of machine text, bounded and announcing its own bound.
 *
 * No margin of its own: every container that holds one is a flex column with
 * the artboard's own gap, and a margin here would be added to it.
 */
function Pre({ text, tone }: { text: string; tone?: "fail" }) {
  const shown = text.length > MAX_PANEL_CHARS ? text.slice(0, MAX_PANEL_CHARS) : text
  const dropped = text.length - shown.length
  return (
    <span
      className={[
        "m block rounded-[10px] border px-3 py-2.5",
        "font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere",
        tone === "fail" ? "border-[#F5D5D9] bg-white text-muted-900" : "border-hairline bg-panel text-muted-900",
      ].join(" ")}
    >
      {shown}
      {dropped > 0 ? (
        <span className="mt-2 block font-sans text-[11.5px] text-muted-400">
          {group(dropped)} more characters are in the run log, not shown here.
        </span>
      ) : null}
    </span>
  )
}

/** The dashed badge the artboard puts in front of an unrecognised event. */
function NewBadge() {
  return (
    <span className="mr-1.5 inline-block rounded-md border border-dashed border-muted-300 px-[7px] py-px text-[11.5px] font-[550] text-muted-900">
      Unrecognised event
    </span>
  )
}

// --- Before / after, for an edit -------------------------------------------

type Marked = { text: string; mark: "same" | "del" | "add" }

/**
 * A line-level before/after, from an `Edit`'s `old_string` and `new_string`.
 *
 * Common leading and trailing lines stay untinted, which is what gives the
 * artboard's comparison its two lines of context. It is not a real diff
 * algorithm and does not pretend to be: the middle is "what went" on the left
 * and "what came" on the right.
 */
export function markLines(before: string, after: string): { before: Marked[]; after: Marked[] } {
  const a = before.split("\n")
  const b = after.split("\n")

  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1

  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1
  }

  const mark = (lines: string[], changed: "del" | "add"): Marked[] =>
    lines.map((text, i) => ({
      text,
      mark: i < head || i >= lines.length - tail ? "same" : changed,
    }))

  return { before: mark(a, "del"), after: mark(b, "add") }
}

function Side({ title, lines }: { title: string; lines: Marked[] }) {
  const shown = lines.slice(0, MAX_DIFF_LINES)
  const dropped = lines.length - shown.length
  return (
    <div className="overflow-hidden rounded-xl border border-hairline bg-[#FCFCFD]">
      <div className="border-b border-hairline px-3 py-[7px] text-[11.5px] font-semibold tracking-[0.05em] uppercase text-muted-400">
        {title}
      </div>
      <pre className="m m-0 overflow-x-auto py-2 font-mono text-xs leading-[1.7] text-muted-900">
        {shown.map((line, i) => (
          <span
            key={i}
            className={[
              "block px-3",
              line.mark === "del" ? "bg-[#FDECEE] text-[#8F1520]" : "",
              line.mark === "add" ? "bg-[#E3F5EC] text-[#0B5A3E]" : "",
            ].join(" ")}
          >
            {line.text === "" ? " " : line.text}
          </span>
        ))}
        {dropped > 0 ? (
          <span className="block px-3 font-sans text-[11.5px] text-muted-400">
            {group(dropped)} more lines, not shown here.
          </span>
        ) : null}
      </pre>
    </div>
  )
}

function Comparison({ before, after }: { before: string; after: string }) {
  const marked = markLines(before, after)
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-2.5 pt-1 pr-4 pb-3.5 pl-[106px]">
      <Side title="Before" lines={marked.before} />
      <Side title="After" lines={marked.after} />
    </div>
  )
}

// --- The classifier ---------------------------------------------------------

interface View {
  /** The 58px column. */
  label: string
  icon: IconName
  /** Tailwind colour for the icon. */
  iconClass: string
  /** The body column. Never empty — see the file comment. */
  body: ReactNode
  /** True when the row is a button that reveals more than the body shows. */
  expandable: boolean
  /**
   * Block-level detail, drawn full width **below** the row rather than in the
   * body column, as `Return.dc.html` draws an edit's before/after: its own
   * `<div>` outside the `<button>`, indented to the body column with
   * `padding:4px 16px 14px 106px`.
   *
   * Everything else the artboards expand — the unrecognised event's raw JSON,
   * a failing suite's output — is a `<span>` **inside** the body column
   * instead, so it lines up under the text it belongs to. That is not a style
   * choice either way: `<div>` and `<pre>` are not valid inside a `<button>`,
   * and the row is a button whenever it expands.
   */
  panel?: ReactNode
  /**
   * The row's own tint, as an inline style because the artboard writes it that
   * way — and because it has to win: `.lr:hover{background:#FAFAFB}` is
   * unlayered and would otherwise repaint a failing row on hover.
   */
  rowStyle?: CSSProperties
  /** Extra classes on the row itself, for the artboard's per-kind geometry. */
  rowClass?: string
  /**
   * This row's body is sans-serif prose, not a machine value.
   *
   * The artboards set those two rows — `agent` and `tests` — a half-point
   * larger than the rest at 13.5px, and nudge the label down a pixel to sit on
   * the first line of it.
   */
  prose?: boolean
}

/**
 * How an unrecognised event names itself.
 *
 * `src/stream.ts` sends five shapes here, not one: `null`, a number, an array
 * and a bare string all reach `unknown` because they are valid JSON that has
 * no `.type`, and so does an object whose `type` this version has never seen.
 * Each gets something to read.
 */
export function discriminator(raw: unknown): string {
  if (raw === null) return "null"
  if (Array.isArray(raw)) return `array of ${group(raw.length)}`
  if (typeof raw === "object") {
    const o = raw as Record<string, unknown>
    const type = typeof o.type === "string" && o.type !== "" ? o.type : undefined
    const subtype = typeof o.subtype === "string" && o.subtype !== "" ? o.subtype : undefined
    if (type && subtype) return `${type}/${subtype}`
    if (type) return type
    if (subtype) return subtype
    const keys = Object.keys(o)
    return keys.length === 0 ? "object with no keys" : `object keyed ${keys.slice(0, 4).join(", ")}`
  }
  if (typeof raw === "string") return raw === "" ? "empty string" : json(raw)
  return json(raw)
}

/**
 * Tool name to the label the artboards use.
 *
 * This is the file's one classifying guard, so `CLAUDE.md`'s rule applies: the
 * dimension is the tool's `name`, its values are unbounded because the CLI
 * gains tools and an MCP server contributes its own, and the two directions are
 * not symmetric. Guessing a label wrong costs a wrong word in a 58px column.
 * Falling through to nothing costs the input. So the default keeps the name and
 * the whole input, and every named branch falls back to the same when the field
 * it wants is missing or is not a string.
 */
function toolView(name: string, input: unknown): Omit<View, "expandable"> {
  const whole = json(input, 2)
  const fallback = <Mono>{whole}</Mono>

  switch (name) {
    case "Bash":
    case "BashOutput":
    case "KillShell": {
      const command = field(input, "command") ?? field(input, "shell_id")
      return {
        label: "shell",
        icon: "terminal",
        iconClass: "text-ink",
        body: command ? <Mono className="text-ink-deep">{command}</Mono> : fallback,
      }
    }
    case "Read":
    case "NotebookRead": {
      const path = field(input, "file_path") ?? field(input, "notebook_path")
      return { label: "read", icon: "file", iconClass: "text-muted-500", body: path ? <Mono>{path}</Mono> : fallback }
    }
    case "Write": {
      const path = field(input, "file_path")
      const content = field(input, "content")
      const added = content === undefined ? undefined : content.split("\n").length
      return {
        label: "write",
        icon: "pencil",
        iconClass: "text-indigo-deep",
        body: path ? (
          <Mono>
            {path}
            {added === undefined ? null : <span className="font-semibold text-pass-deep"> +{group(added)}</span>}
            <span className="font-sans text-muted-500"> · new file</span>
          </Mono>
        ) : (
          fallback
        ),
      }
    }
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      const path = field(input, "file_path") ?? field(input, "notebook_path")
      const edits = editPairs(input)
      const { added, removed } = editCounts(edits)
      return {
        label: "edit",
        icon: "pencil",
        iconClass: "text-indigo-deep",
        body: path ? (
          <Mono>
            {path}
            {/* `src/importer/map.ts +2 −1`, as `Return.dc.html` writes it: a
                real minus sign, green for what came and red for what went. */}
            {added > 0 ? <span className="font-semibold text-pass-deep"> +{group(added)}</span> : null}
            {removed > 0 ? <span className="font-semibold text-fail"> −{group(removed)}</span> : null}
            {edits.length > 1 ? <span className="font-sans text-muted-500"> · {edits.length} edits</span> : null}
          </Mono>
        ) : (
          fallback
        ),
        panel:
          edits.length > 0 ? (
            <>
              {edits.map((pair, i) => (
                <Comparison key={i} before={pair.before} after={pair.after} />
              ))}
            </>
          ) : undefined,
      }
    }
    case "Glob":
    case "Grep": {
      const pattern = field(input, "pattern")
      const where = field(input, "path")
      return {
        label: name === "Glob" ? "glob" : "grep",
        icon: "search",
        iconClass: "text-muted-500",
        body: pattern ? (
          <Mono>
            {pattern}
            {where ? <span className="text-muted-400"> in {where}</span> : null}
          </Mono>
        ) : (
          fallback
        ),
      }
    }
    case "Task": {
      const what = field(input, "description") ?? field(input, "subagent_type")
      return {
        label: "task",
        icon: "bot",
        iconClass: "text-indigo",
        body: what ? <span className="block min-w-0 wrap-anywhere">{what}</span> : fallback,
      }
    }
    case "WebFetch":
    case "WebSearch": {
      const what = field(input, "url") ?? field(input, "query")
      return { label: "web", icon: "globe", iconClass: "text-muted-500", body: what ? <Mono>{what}</Mono> : fallback }
    }
    case "TodoWrite": {
      const todos = (input as { todos?: unknown } | null)?.todos
      return {
        label: "todo",
        icon: "list",
        iconClass: "text-muted-500",
        body: Array.isArray(todos) ? (
          <span className="block min-w-0">{group(todos.length)} items on the agent's list</span>
        ) : (
          fallback
        ),
      }
    }
    default:
      // A tool this version has never heard of. The name goes in the label and
      // wraps rather than truncating, and the input goes in the body whole.
      return {
        label: name === "" ? "tool" : name.toLowerCase(),
        icon: "wrench",
        iconClass: "text-muted-500",
        body: (
          <Mono>
            <span className="font-sans text-muted-500">{name === "" ? "an unnamed tool" : name} · </span>
            {whole}
          </Mono>
        ),
      }
  }
}

/** `Edit`'s single pair, or `MultiEdit`'s list, as the same shape. */
function editPairs(input: unknown): { before: string; after: string }[] {
  const single = { before: field(input, "old_string"), after: field(input, "new_string") }
  if (single.before !== undefined || single.after !== undefined) {
    return [{ before: single.before ?? "", after: single.after ?? "" }]
  }
  const edits = (input as { edits?: unknown } | null)?.edits
  if (!Array.isArray(edits)) return []
  const out: { before: string; after: string }[] = []
  for (const edit of edits) {
    const before = field(edit, "old_string")
    const after = field(edit, "new_string")
    if (before !== undefined || after !== undefined) out.push({ before: before ?? "", after: after ?? "" })
  }
  return out
}

/**
 * Lines that went and lines that came, across every pair of an edit.
 *
 * `Return.dc.html` prints these beside the path as `+2 −1`. They come from
 * `markLines`, the same pass that tints the before/after panel, so the two can
 * never disagree about what changed.
 *
 * An empty side counts as **no lines**, not as one. `editPairs` builds a pair
 * from `field()`, which reports an empty string as absent, so `before: ""`
 * means "this edit inserted and removed nothing" rather than "it removed one
 * blank line" — and `markLines` would otherwise mark that empty string as a
 * deleted line and put a `−1` on every pure insertion. A single genuinely
 * blank `old_string` cannot reach here to be miscounted the other way.
 */
function editCounts(edits: readonly { before: string; after: string }[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const pair of edits) {
    const marked = markLines(pair.before, pair.after)
    if (pair.before !== "") removed += marked.before.filter((line) => line.mark === "del").length
    if (pair.after !== "") added += marked.after.filter((line) => line.mark === "add").length
  }
  return { added, removed }
}

/** The `errors` field of a raw result line, as prose, if it holds any. */
export function errorsProse(errors: unknown): string | undefined {
  if (errors === undefined || errors === null) return undefined
  if (typeof errors === "string") return errors === "" ? undefined : errors
  if (Array.isArray(errors)) {
    const parts = errors.map((e) => (typeof e === "string" ? e : json(e))).filter((s) => s.trim() !== "")
    return parts.length === 0 ? undefined : parts.join("\n")
  }
  const out = json(errors)
  return out.trim() === "" ? undefined : out
}

function resultView(event: Extract<Event, { kind: "result" }>, errors: unknown, open: boolean): View {
  const said = event.text !== undefined && event.text.trim() !== "" ? event.text : undefined
  const explained = errorsProse(errors)
  /* Three sources, in order of how close they are to what the CLI said. The
   * last is the floor: on an error with neither a `result` key nor `errors`
   * the row would otherwise have only the subtype, which reads like a bug. */
  const prose =
    said ??
    explained ??
    (event.isError ? "The run ended without the CLI saying why." : event.text === "" ? "The CLI returned no text." : undefined)

  const denials = event.permissionDenials.length

  return {
    label: "result",
    icon: "flag",
    iconClass: event.isError ? "text-fail" : "text-pass-deep",
    rowStyle: event.isError ? FAIL_TINT : undefined,
    expandable: prose !== undefined,
    body: (
      <span className="flex min-w-0 flex-col gap-1.5">
        {prose === undefined ? null : <Prose open={open}>{prose}</Prose>}
        {/* Always printed, so no result row can be blank: the subtype is the
            CLI's own name for the outcome and the cost is never a surprise. */}
        <Mono className="text-muted-400">
          {event.subtype} · {group(event.numTurns)} turns · ${event.costUsd.toFixed(4)}
          {denials > 0 ? ` · ${group(denials)} permission denials` : ""}
        </Mono>
      </span>
    ),
  }
}

/** Everything a row needs to draw itself, from the row and its open state. */
export function viewFor(row: StreamRow, open: boolean): View {
  if (isTestsRow(row)) {
    const { exitCode, attempt, summary, output } = row.tests
    return {
      label: "tests",
      icon: "flask",
      iconClass: exitCode === 0 ? "text-pass-deep" : "text-fail",
      rowStyle: exitCode === 0 ? undefined : FAIL_TINT,
      /* `Return.dc.html` gives this row alone `padding:10px 16px` against every
       * other row's 9px, and 13.5px prose with the label nudged to match. */
      rowClass: "py-2.5",
      prose: true,
      expandable: output !== undefined && output !== "",
      body: (
        <span className="flex min-w-0 flex-col gap-2">
          <span className="flex flex-wrap items-center gap-2">
            {attempt === undefined ? null : <span className="font-semibold">Attempt {group(attempt)}</span>}
            {summary ? <span className="font-semibold">{summary}</span> : null}
            <ExitCodeChip code={exitCode} />
            {/* No glyph. The artboard writes this as plain 12.5px text beside
                the chip: the digits say what the code was, these four words say
                who read it, and neither needs a tick to be believed. */}
            <span className="text-[12.5px] text-muted-500">read by kantan</span>
          </span>
        </span>
      ),
      panel:
        output === undefined || output === "" ? undefined : (
          <Detail>
            <Pre text={output} tone={exitCode === 0 ? undefined : "fail"} />
          </Detail>
        ),
    }
  }

  const { event } = row

  switch (event.kind) {
    case "init":
      return {
        label: "init",
        icon: "play",
        iconClass: "text-ink",
        expandable: false,
        body: (
          <span className="flex min-w-0 flex-col gap-1">
            <Mono>{event.cwd}</Mono>
            <Mono className="text-muted-400">
              {group(event.tools)} tools · {group(event.skills)} skills · session {event.sessionId}
            </Mono>
          </span>
        ),
      }

    case "text":
      return {
        label: "agent",
        icon: "message",
        iconClass: "text-indigo",
        /* The artboards' one larger row: `font-size:13.5px`, because this is
         * the only place the agent speaks in sentences. */
        prose: true,
        expandable: true,
        body: <Prose open={open}>{event.text === "" ? "The agent sent an empty message." : event.text}</Prose>,
      }

    case "thinking":
      return {
        label: "think",
        icon: "ellipsis",
        iconClass: "text-muted-300",
        expandable: false,
        body: (
          <span className="block min-w-0 text-muted-500">
            thought for <span className="m font-mono text-[12.5px]">{group(event.length)}</span> characters
          </span>
        ),
      }

    case "thinking_tokens":
      return {
        label: "think",
        icon: "ellipsis",
        iconClass: "text-muted-300",
        expandable: false,
        body: (
          <span className="block min-w-0 text-muted-500">
            <span className="m font-mono text-[12.5px]">{group(event.tokens)}</span> thinking tokens
            <span className="m font-mono text-[12.5px]"> (+{group(event.delta)})</span>
          </span>
        ),
      }

    case "tool_use": {
      const view = toolView(event.name, event.input)
      // Expandable whether or not there is more: the body names the field that
      // matters, and the whole input is behind the control either way.
      if (view.panel !== undefined) return { ...view, expandable: true }
      return {
        ...view,
        expandable: true,
        panel: (
          <Detail>
            <ToolInput input={event.input} />
          </Detail>
        ),
      }
    }

    case "tool_result": {
      const content = event.content
      const head = firstLine(content)
      return {
        label: "result",
        icon: event.isError ? "warn" : "check",
        iconClass: event.isError ? "text-fail" : "text-pass-deep",
        rowStyle: event.isError ? FAIL_TINT : undefined,
        expandable: content !== "",
        body: (
          <span className="flex min-w-0 flex-col gap-1.5">
            <Mono className={event.isError ? "text-[#8F1520]" : "text-muted-900"}>
              {content === "" ? (
                <span className="font-sans text-muted-500">The tool returned nothing.</span>
              ) : open ? (
                content
              ) : (
                head
              )}
            </Mono>
            {content === "" ? null : (
              <Mono className="text-muted-400">for {event.toolUseId}</Mono>
            )}
          </span>
        ),
      }
    }

    case "rate_limit": {
      const resetsAt = formatResetTime(event.resetsAt)
      return {
        label: "limit",
        icon: "clock",
        iconClass: "text-[#0369A1]",
        expandable: false,
        body: (
          <span className="block min-w-0 text-muted-900">
            <span className="font-medium text-account-ink">{event.status === "" ? "unnamed status" : event.status}</span>
            {/*
             * Two things the artboard's "41% of the 5-hour window used"
             * cannot be followed on, and one it can.
             *
             * **A fraction, not a percentage.** `utilization` arrives as
             * `0.41`, which the rail's `percentLabel` multiplies by 100 and
             * this did not — so every rate-limit row in the record has been
             * reading "0% of the window used" for a window at 41%. The same
             * `Math.round(x * 100)` as the rail, so the two cannot disagree
             * about the same number.
             *
             * **Not necessarily the five-hour one.** `src/stream.ts` reads
             * whichever window `rateLimitType` names — `test/stream.test.ts`
             * has it surface `seven_day` at 88% — and then drops the name. So
             * the row cannot say which window this is, and "the window" is the
             * only wording that is true of all of them. The artboard drew a
             * five-hour case; naming it here would mislabel a weekly one.
             */}
            {event.utilization === undefined || !Number.isFinite(event.utilization)
              ? " · the window's utilisation was not reported"
              : ` · ${Math.round(event.utilization * 100)}% of the window used`}
            {/*
             * "· resets 18:40", the last clause of the artboard's limit row.
             *
             * Formatted by the rail's own `formatResetTime`, imported rather
             * than copied. It is the same `resetsAt`, in the same epoch
             * seconds, shown twice on one screen; two formatters would be two
             * chances to disagree about one number — and the one this row
             * would have got wrong is already named in that function's
             * comment, which rejects zero and negatives because "18:40 and
             * 01:00 on 1 Jan 1970 are equally confident and only one of them
             * is true".
             */}
            {resetsAt === undefined ? null : ` · resets ${resetsAt}`}
          </span>
        ),
      }
    }

    case "result":
      return resultView(event, row.errors, open)

    case "vcs": {
      /**
       * `system/vcs_state_changed`: the CLI saying the agent committed. It
       * arrives twice per run that does.
       *
       * Three decisions, each the cheap direction of a lopsided pair:
       *
       * - **A verb, not the CLI's token.** "commit" beside a branch name
       *   reads as a noun and leaves the tense to the reader. Only `commit`
       *   gets one, because it is the only value four real events showed.
       * - **An unrecognised change prints its own word.** `src/stream.ts`
       *   carries the string through rather than enumerating it, so this has
       *   to draw a word it has no verb for. Drawing nothing would hide a
       *   repository event completely - worse than the raw blob this row
       *   replaced. An awkward sentence for an event no CLI has sent yet is
       *   the lesser cost.
       * - **Neither field is assumed present.** `str()` answers `""` for an
       *   absent one, so both halves are conditional and the row still names
       *   what it is when the CLI sends a shape nobody here predicted.
       */
      const verb = event.change === "commit" ? "Committed" : event.change === "" ? "Repository changed" : event.change
      return {
        label: "git",
        icon: "commit",
        /* Deliberately not `text-pass-deep`: that green belongs to a passing
           suite and an ok result, and a commit is not a verification. This is
           a neutral note that something was saved. */
        iconClass: "text-muted-500",
        expandable: false,
        body: (
          <span className="block min-w-0 text-muted-500">
            {verb}
            {event.branch === "" ? null : (
              <>
                {" on "}
                <Mono className="wrap-anywhere">{event.branch}</Mono>
              </>
            )}
          </span>
        ),
      }
    }

    case "unknown":
      /* Not an error, and never hidden. `src/stream.ts` routes a future CLI
       * event here so that it shows up; a row that swallowed it would make
       * `unknown` useless as the "the CLI changed" signal it exists to be. */
      return {
        label: "new",
        icon: "queried",
        iconClass: "text-muted-400",
        expandable: true,
        body: (
          <span className="block min-w-0">
            <NewBadge />
            <span className="m font-mono text-[12.5px] wrap-anywhere">{discriminator(event.raw)}</span>
            <span className="text-muted-500"> · shown as it arrived</span>
          </span>
        ),
        panel: (
          <Detail>
            <Pre text={json(event.raw, 2)} />
          </Detail>
        ),
      }

    case "parse_error":
      /* Normal input. A process killed mid-write leaves half a line behind, so
       * this is a note in the record's own voice, not an alarm — no red, no
       * icon that means failure. */
      return {
        label: "raw",
        icon: "braces",
        iconClass: "text-muted-300",
        expandable: true,
        body: (
          <span className="block min-w-0 text-muted-500">
            One line wasn't JSON, so it's kept as plain text.
            <span className="m font-mono text-[12.5px]"> {group(event.line.length)} characters</span>
          </span>
        ),
        panel: (
          <Detail>
            <Pre text={event.line === "" ? "(the line was empty)" : event.line} />
            <span className="mt-1.5 block text-[12.5px] text-muted-500">The parser said: {event.error}</span>
          </Detail>
        ),
      }
  }
}

function ToolInput({ input }: { input: unknown }) {
  return <Pre text={json(input, 2)} />
}

// --- The row ----------------------------------------------------------------

export interface RowProps {
  row: StreamRow
  /** The virtual index. `measureElement` reads it back off the DOM. */
  index: number
  /** `virtualItem.start`, in pixels down the scrolled content. */
  top: number
  /** `virtualizer.measureElement`, so a wrapped row reports its real height. */
  measure: (node: Element | null) => void
  /**
   * `virtualizer.resizeItem`, for the one height change `measureElement`
   * cannot report: see the comment on the expand effect below.
   */
  resize: (index: number, px: number) => void
  open: boolean
  onToggle: () => void
  /**
   * First arrival. `Stream` owns the set of ids it has already drawn, because a
   * virtualized row unmounts when it scrolls out of the window and state kept
   * here would come back blank — which is exactly the bug where every row
   * re-animates on the way back.
   */
  enter: boolean
  /**
   * Which step of the entrance stagger this row is on: 0 for the first row of
   * a batch, 1 for the next, and so on.
   *
   * A step, not a duration. The delays live in `artboard.css` as `.d1`…`.d9`
   * and this picks one of them, so the ladder has exactly one owner — and so
   * that a value arriving as `3 * 0.05 === 0.15000000000000002` cannot miss it.
   */
  stagger: number
}

/**
 * The entrance is the artboards' own, in CSS: `bf` is `kfade` — ten pixels up,
 * out of a six-pixel blur, over .7s — and `d1`…`d9` is the stagger, .05s a
 * step. Both live in `src/ui/artboard.css`, transcribed from the artboards.
 *
 * ## Why not a Motion spring, which is what this was
 *
 * Three reasons, and the first is the one that actually bites here.
 *
 * **Cancelling a WAAPI animation rejects a promise nothing catches.** A
 * sibling region measured 195 unhandled `AbortError`s in one test run from
 * exactly this. An interrupted entrance is not an edge case for this component,
 * it is the normal case: rows are virtualized, so one scrolls out mid-fade
 * whenever the log moves, and the run stream replays from byte 0 on reconnect.
 *
 * **A CSS animation is covered by the stylesheet's reduced-motion guards; a JS
 * one is not.** `tokens.css` cuts every CSS animation to `0.01ms` under
 * `prefers-reduced-motion` — which ends it rather than stopping it starting —
 * and `artboard.css` adds the artboards' own `animation:none!important`,
 * scoped to `.kr, .kr *` and so live only while `App.tsx`'s root carries `kr`,
 * which today it does. Neither can reach a Motion spring.
 *
 * None of that is the gate, though. The gate is `Stream`'s: under `reduce` it
 * passes `enter={false}`, so the class below is never added at all — stronger
 * than either stylesheet guard, because it does not depend on a stylesheet
 * loading or on a root keeping a class. Probed in headless Chrome under
 * emulated `reduce`: no row carries `bf` and `document.getAnimations()` is 0,
 * against 2 running `kfade` animations for the same two arrivals without the
 * preference.
 *
 * **Motion's reduced-motion answer is a module-level singleton** initialised by
 * the first call anywhere in the process, and `CLAUDE.md` records it answering
 * `false` with the media feature set. Every Motion component in a file is
 * another chance to initialise it early for everyone else.
 *
 * What does not change: **which** rows animate. The class is added only when
 * `enter` is true, and `enter` is `Stream`'s answer — an id it has never drawn,
 * and no reduced-motion preference. So a row that has been drawn before stays
 * still, on a reconnect and on the way back up the log. That contract is the
 * component's, not the animation's.
 */
const STAGGER_CLASSES = ["", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9"] as const

/**
 * The delay class for a step of the stagger, for any number at all.
 *
 * The dimension is the step index, and its values are every number a caller
 * can produce: `0` is the first row of a batch, `1`…`9` are the ladder, and
 * anything past the end, negative, fractional or `NaN` is reachable the moment
 * a caller counts differently. Guessing low costs nothing — a row enters
 * sooner than the one before it — while falling through to no class at all
 * would silently delete the stagger, so this clamps rather than tests.
 * `Main.dc.html` stops at `d9` and the tenth row onward joins it there.
 */
function staggerClass(step: number): string {
  const last = STAGGER_CLASSES.length - 1
  const index = Number.isFinite(step) ? Math.min(Math.max(Math.trunc(step), 0), last) : 0
  return STAGGER_CLASSES[index] ?? ""
}

export function Row({ row, index, top, measure, resize, open, onToggle, enter, stagger }: RowProps) {
  /* Latched on mount. Without this, the next event's render would strip
   * `initial` off a row still fading in and snap it into place. */
  const [entering] = useState(enter)

  /*
   * Expanding changes this row's height, and the virtualizer has to learn the
   * new one or every row below it sits at the wrong offset.
   *
   * `measureElement` is the wrong tool for it twice over: the ref identity does
   * not change on a re-render, so React never calls it again, and when it *is*
   * called without a `ResizeObserver` entry it returns the **cached** size
   * rather than reading the element — which is right for a remount and useless
   * for a resize. So the new height is reported explicitly. A browser's
   * observer would get there too; this does not wait for it, and it is the only
   * path an environment without live layout has.
   */
  const node = useRef<HTMLElement | null>(null)
  const attach = (el: HTMLElement | null) => {
    node.current = el
    measure(el)
  }
  const lastOpen = useRef(open)
  useEffect(() => {
    /* Only a real change. `measureElement` already measured this row when the
     * ref attached, so resizing on mount would be a second, redundant
     * notification per row — and StrictMode's double mount would make it a
     * third. Comparing against the value we last acted on is what skips both,
     * where a "first run" flag would not. */
    if (lastOpen.current === open) return
    lastOpen.current = open
    const el = node.current
    if (!el) return
    /* Read now — layout has settled by the time an effect runs — but report in
     * a microtask. The virtualizer answers a resize with `flushSync`, and React
     * refuses to flush from inside a lifecycle method; this is the escape it
     * names. The row may also have scrolled out by then, hence `isConnected`. */
    const px = el.offsetHeight
    queueMicrotask(() => {
      if (el.isConnected) resize(index, px)
    })
    // Deliberately only `open`: `resize` notifies the virtualizer, which
    // re-renders, so re-running on its identity would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const view = viewFor(row, open)
  const time = row.at === undefined ? "" : clock(row.at)

  const cells = (
    <>
      <Icon name={view.icon} size={15} className={`mt-0.5 ${view.iconClass}`} />
      <span
        className={[
          "m font-mono text-[10.5px] tracking-[0.06em] uppercase text-muted-400 wrap-anywhere",
          /* 3px against the row's 13.5px prose, 2px against its 13px mono:
             both artboards nudge the label onto the first line of the body. */
          view.prose ? "pt-[3px]" : "pt-0.5",
        ].join(" ")}
      >
        {view.label}
      </span>
      {view.body}
      <span className="m font-mono text-[11.5px] tabular-nums text-muted-400">{time}</span>
    </>
  )

  /* The artboards' row grid, `22px 58px minmax(0,1fr) auto` at `gap:10px`,
   * `padding:9px 16px`, `border-top:1px solid #F0F0F3`. `minmax(0,1fr)` on the
   * body track is what lets a long path wrap: a default `1fr` floors at
   * `min-content` and overflows.
   *
   * `lr` is the artboards' own list-row class and carries only the hover. The
   * Tailwind `hover:bg-panel` is the same #FAFAFB, kept beside it so a row
   * still responds if `artboard.css` is ever not loaded. */
  const grid = [
    "lr grid w-full grid-cols-[22px_58px_minmax(0,1fr)_auto] items-start gap-2.5",
    "border-t border-panel-2 px-4 text-left leading-[1.5] text-ink-deep hover:bg-panel",
    view.prose ? "text-[13.5px]" : "text-[13px]",
    view.rowClass ?? "py-[9px]",
  ].join(" ")

  return (
    <div
      data-index={index}
      data-row-id={row.id}
      data-enter={entering ? "true" : "false"}
      /* What the reduced-motion probes read, as in `Digest` and `Tree`. */
      data-motion={entering ? "animated" : "static"}
      ref={attach}
      /* `bf` is the artboards' blur fade and `d1`…`d9` its stagger; both come
         from `artboard.css`. Only a row `Stream` has never drawn gets them. */
      className={entering ? `bf ${staggerClass(stagger)}` : undefined}
      style={{ position: "absolute", top, left: 0, width: "100%" }}
    >
      {view.expandable ? (
        /* The ring is inset. A row is absolutely positioned and full width
           inside a scroller, so a ring with a positive offset would be clipped
           at the scroller's edges and would overlap the rows above and below
           everywhere else. */
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          style={view.rowStyle}
          className={`${grid} focus-visible:outline-2 focus-visible:outline-indigo focus-visible:[outline-offset:-2px]`}
        >
          {cells}
        </button>
      ) : (
        <div className={grid} style={view.rowStyle}>
          {cells}
        </div>
      )}
      {/* Block-level detail only — an edit's before/after. Outside the button
          because `<div>` and `<pre>` are not valid inside one, and inside the
          measured element so the virtualizer learns the taller height. */}
      {open && view.panel ? view.panel : null}
    </div>
  )
}
