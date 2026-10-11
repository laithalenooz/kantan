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

import { useEffect, useRef, useState, type ReactNode } from "react"
import { motion } from "motion/react"

import type { Event } from "../stream"

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

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? "size-[15px] shrink-0"}
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
 * code, and no bare green tick — the shield says who read it, the digits say
 * what it was.
 */
export function ExitCodeChip({ code }: { code: number }) {
  const passed = code === 0
  return (
    <span
      className={[
        "inline-flex items-center gap-[5px] rounded-full px-2 py-[2px]",
        "font-mono text-xs font-semibold text-white",
        passed ? "bg-pass" : "bg-fail",
      ].join(" ")}
    >
      <Icon name="shield" className="size-3 shrink-0" />
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
    <span className={`block min-w-0 font-mono text-[12.5px] wrap-anywhere ${className ?? "text-muted-900"}`}>
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

/** An expanded block of machine text, bounded and announcing its own bound. */
function Pre({ text, tone }: { text: string; tone?: "fail" }) {
  const shown = text.length > MAX_PANEL_CHARS ? text.slice(0, MAX_PANEL_CHARS) : text
  const dropped = text.length - shown.length
  return (
    <span
      className={[
        "mt-1.5 block rounded-[10px] border px-3 py-2.5",
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
    <span className="mr-1.5 inline-block rounded-md border border-dashed border-muted-300 px-[7px] py-px text-[11.5px] font-medium text-muted-900">
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
      <pre className="m-0 overflow-x-auto py-2 font-mono text-xs leading-[1.7] text-muted-900">
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
  /** Rendered below the row header, inside the measured element. */
  panel?: ReactNode
  /** Tints the whole row. */
  rowClass?: string
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
      return {
        label: "edit",
        icon: "pencil",
        iconClass: "text-indigo-deep",
        body: path ? (
          <Mono>
            {path}
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
    rowClass: event.isError ? "bg-[#FFFBFB]" : undefined,
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
      rowClass: exitCode === 0 ? undefined : "bg-[#FFFBFB]",
      expandable: output !== undefined && output !== "",
      body: (
        <span className="flex min-w-0 flex-col gap-2">
          <span className="flex flex-wrap items-center gap-2">
            {attempt === undefined ? null : <span className="font-semibold">Attempt {group(attempt)}</span>}
            {summary ? <span className="font-semibold">{summary}</span> : null}
            <ExitCodeChip code={exitCode} />
            <span className="inline-flex items-center gap-1 text-[12.5px] text-muted-500">
              <Icon name="shieldCheck" className="size-[13px] shrink-0 text-pass-deep" />
              read by kantan
            </span>
          </span>
          {open && output ? <Pre text={output} tone={exitCode === 0 ? undefined : "fail"} /> : null}
        </span>
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
            thought for <span className="font-mono text-[12.5px]">{group(event.length)}</span> characters
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
            <span className="font-mono text-[12.5px]">{group(event.tokens)}</span> thinking tokens
            <span className="font-mono text-[12.5px]"> (+{group(event.delta)})</span>
          </span>
        ),
      }

    case "tool_use": {
      const view = toolView(event.name, event.input)
      return {
        ...view,
        // Expandable whether or not there is a panel: the body names the field
        // that matters and the panel, or this fallback, keeps the rest.
        expandable: true,
        panel: view.panel ?? <ToolInput input={event.input} />,
      }
    }

    case "tool_result": {
      const content = event.content
      const head = firstLine(content)
      return {
        label: "result",
        icon: event.isError ? "warn" : "check",
        iconClass: event.isError ? "text-fail" : "text-pass-deep",
        rowClass: event.isError ? "bg-[#FFFBFB]" : undefined,
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

    case "rate_limit":
      return {
        label: "limit",
        icon: "clock",
        iconClass: "text-[#0369A1]",
        expandable: false,
        body: (
          <span className="block min-w-0 text-muted-900">
            <span className="font-medium text-account-ink">{event.status === "" ? "unnamed status" : event.status}</span>
            {event.utilization === undefined
              ? " · the window's utilisation was not reported"
              : ` · ${Math.round(event.utilization)}% of the window used`}
          </span>
        ),
      }

    case "result":
      return resultView(event, row.errors, open)

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
            <span className="font-mono text-[12.5px] wrap-anywhere">{discriminator(event.raw)}</span>
            <span className="text-muted-500"> · shown as it arrived</span>
          </span>
        ),
        panel: <Pre text={json(event.raw, 2)} />,
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
            <span className="font-mono text-[12.5px]"> {group(event.line.length)} characters</span>
          </span>
        ),
        panel: (
          <>
            <Pre text={event.line === "" ? "(the line was empty)" : event.line} />
            <span className="mt-1.5 block text-[12.5px] text-muted-500">The parser said: {event.error}</span>
          </>
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
  /** Entry delay in seconds, staggering a batch that arrived together. */
  delay: number
}

/**
 * The artboards' `kfade`: ten pixels up, out of a six-pixel blur.
 *
 * `main.tsx` wraps the app in `MotionConfig reducedMotion="user"`, and that is
 * not enough on its own — it drops transform animations and lets opacity and
 * filter keep running. So `Stream` reads the preference itself and passes
 * `enter: false`, which removes `initial` and `animate` entirely.
 */
const ENTER_FROM = { opacity: 0, y: 10, filter: "blur(6px)" } as const
const ENTER_TO = { opacity: 1, y: 0, filter: "blur(0px)" } as const
const ENTER_EASE = [0.2, 0.7, 0.2, 1] as const

export function Row({ row, index, top, measure, resize, open, onToggle, enter, delay }: RowProps) {
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
      <Icon name={view.icon} className={`mt-0.5 size-[15px] shrink-0 ${view.iconClass}`} />
      <span className="pt-0.5 font-mono text-[10.5px] tracking-[0.06em] uppercase text-muted-400 wrap-anywhere">
        {view.label}
      </span>
      {view.body}
      <span className="font-mono text-[11.5px] tabular-nums text-muted-400">{time}</span>
    </>
  )

  /* The artboards' row grid. `minmax(0,1fr)` on the body track is what lets a
   * long path wrap: a default `1fr` floors at `min-content` and overflows. */
  const grid =
    "grid w-full grid-cols-[22px_58px_minmax(0,1fr)_auto] items-start gap-2.5 border-t border-panel-2 px-4 py-[9px] text-left text-[13px] leading-[1.5] text-ink-deep"

  return (
    <motion.div
      data-index={index}
      data-row-id={row.id}
      data-enter={entering ? "true" : "false"}
      ref={attach}
      style={{ position: "absolute", top, left: 0, width: "100%" }}
      {...(entering
        ? {
            initial: ENTER_FROM,
            animate: ENTER_TO,
            transition: { duration: 0.7, delay, ease: ENTER_EASE },
          }
        : {})}
    >
      {view.expandable ? (
        <button type="button" aria-expanded={open} onClick={onToggle} className={`${grid} ${view.rowClass ?? ""} hover:bg-panel`}>
          {cells}
        </button>
      ) : (
        <div className={`${grid} ${view.rowClass ?? ""} hover:bg-panel`}>{cells}</div>
      )}
      {open && view.panel ? <div className="border-t border-panel-2 bg-white">{view.panel}</div> : null}
    </motion.div>
  )
}
