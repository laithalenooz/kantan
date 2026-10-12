/**
 * Turns the raw bytes of `claude -p --output-format stream-json` into a narrow
 * typed union.
 *
 * Two hazards shape this file.
 *
 * **Lines straddle reads.** The CLI streams, and one JSON line routinely
 * arrives across several chunks because tool inputs carry file contents. A
 * `chunk.toString().split("\n")` corrupts events the moment that happens, so
 * partial lines — and partial multi-byte characters — are buffered.
 *
 * **The hook filter is a skipping guard, and over-filtering is silent.** The
 * dimension it reads is `(type, subtype)`, enumerated from `test/fixtures/`.
 * A dropped real message vanishes from the UI and the user cannot tell the run
 * from a stalled one; extra noise is visible and harmless. So the filter is an
 * explicit allowlist of exact hook subtypes, never a `startsWith("hook")`
 * prefix and never all of `system` — `system/thinking_tokens` lives there too.
 * Anything unrecognised, at the event level or the content-block level, becomes
 * a visible `unknown` rather than being dropped.
 */

export type Event =
  | { kind: "init"; cwd: string; tools: number; skills: number; sessionId: string }
  | { kind: "text"; text: string }
  | { kind: "thinking"; length: number }
  | { kind: "thinking_tokens"; tokens: number; delta: number }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; toolUseId: string; content: string; isError: boolean }
  | {
      kind: "rate_limit"
      status: string
      utilization: number | undefined
      /**
       * When the active window resets, in **epoch seconds** - the unit the CLI
       * sends. Taken from the active window, not from `rate_limit_info`'s own
       * copy: the two agree for `five_hour` in the fixtures, but the top-level
       * one is not scoped to the window `rateLimitType` names, so reading it
       * would silently report the wrong window's reset the moment they differ.
       *
       * `undefined` when absent. `overageStatus` is still deliberately not
       * surfaced - it reads "rejected" on every normal event when overage is
       * disabled for an org, and a rail that keyed on it would warn constantly.
       */
      resetsAt: number | undefined
    }
  | {
      kind: "result"
      subtype: string
      isError: boolean
      costUsd: number
      numTurns: number
      /**
       * `undefined` when the event carries no `result` key at all, which is
       * what `error_max_budget_usd` does — so a consumer can tell "the CLI said
       * nothing" from "the CLI said the empty string".
       */
      text: string | undefined
      /** Carried through verbatim: Task 8b needs denials by name, and the fixtures only ever show `[]`. */
      permissionDenials: unknown[]
    }
  | { kind: "unknown"; raw: unknown }
  | { kind: "parse_error"; line: string; error: string }

/**
 * The only events dropped. Exact subtypes, counted from the fixtures: ~20 of
 * these arrive before the first real message. A new hook subtype in a future
 * CLI version is deliberately *not* matched here, so it shows up as `unknown`
 * and someone decides.
 */
export const FILTERED_HOOK_SUBTYPES = ["hook_started", "hook_response", "hook_progress"] as const

const FILTERED = new Set<string>(FILTERED_HOOK_SUBTYPES)

/**
 * Feed it bytes, get events. Holds the partial trailing line between pushes,
 * so the caller can read the pipe in whatever sizes it delivers.
 */
export class StreamParser {
  private buffer = ""
  /** How far into `buffer` we have already looked for a newline. */
  private scanned = 0
  private decoder = new TextDecoder()

  push(chunk: Uint8Array | string): Event[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true })

    const out: Event[] = []
    for (;;) {
      const nl = this.buffer.indexOf("\n", this.scanned)
      if (nl === -1) break
      out.push(...parseLine(this.buffer.slice(0, nl)))
      this.buffer = this.buffer.slice(nl + 1)
      this.scanned = 0
    }
    this.scanned = this.buffer.length
    return out
  }

  /**
   * Flushes what is left. A complete final line without a trailing newline
   * parses normally; a truncated one becomes a `parse_error`, because the
   * process may have been killed mid-write and that is worth seeing.
   */
  end(): Event[] {
    this.buffer += this.decoder.decode()
    const rest = this.buffer
    this.buffer = ""
    this.scanned = 0
    return parseLine(rest)
  }
}

/** Parses an async source of chunks, as returned by `Bun.spawn().stdout`. */
export async function* parseStream(source: AsyncIterable<Uint8Array | string>): AsyncGenerator<Event> {
  const parser = new StreamParser()
  for await (const chunk of source) yield* parser.push(chunk)
  yield* parser.end()
}

function parseLine(line: string): Event[] {
  // A blank line carries nothing to lose, so skipping it drops no information.
  if (line.trim() === "") return []

  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch (cause) {
    return [{ kind: "parse_error", line, error: (cause as Error).message }]
  }

  return classify(raw)
}

/**
 * One already-parsed stream-json event, classified.
 *
 * `parseLine` is this with `JSON.parse` in front of it. The seam exists because
 * `runlog.ts` stores a `cli` record as `{ kind: "cli", event }` where `event` is
 * the **parsed object**, so a reader folding a log back into events has no line
 * to hand `parseLine` and should not manufacture one by re-serialising.
 *
 * Two properties of the return matter to such a reader, and both are
 * load-bearing for any scheme that gives rows stable ids:
 *
 * - **One event in can be several events out.** An assistant message carrying
 *   text and two tool calls is three events.
 * - **One event in can be none out.** The hook subtypes in
 *   `FILTERED_HOOK_SUBTYPES` yield nothing at all.
 *
 * So a record's index is neither a row's index nor a row's identity. A caller
 * keying on the record index alone collides on the first message that carries
 * two blocks.
 *
 * It never returns `parse_error`: the caller already holds parsed JSON. Only
 * `parseLine` can produce one, from a line that was not JSON.
 */
export function classify(raw: unknown): Event[] {
  // `null`, `42` and `[]` are all valid JSON, and reading `.type` off them throws.
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [{ kind: "unknown", raw }]
  const m = raw as Record<string, unknown>

  switch (m.type) {
    case "system":
      return system(m, raw)
    case "assistant":
    case "user":
      return message(m, raw)
    case "rate_limit_event":
      return [rateLimit(m)]
    case "result":
      // Keyed on `type` alone: a future `error_max_turns` must still be terminal.
      return [result(m)]
    default:
      return [{ kind: "unknown", raw }]
  }
}

function system(m: Record<string, unknown>, raw: unknown): Event[] {
  const subtype = m.subtype
  if (typeof subtype === "string" && FILTERED.has(subtype)) return []

  if (subtype === "init") {
    return [
      {
        kind: "init",
        cwd: str(m.cwd),
        tools: count(m.tools),
        skills: count(m.skills),
        sessionId: str(m.session_id),
      },
    ]
  }

  // Not hook noise. The assistant `thinking` blocks arrive with an empty
  // string and a signature, so this is the only real thinking signal in the
  // stream; routing a recognised, every-run event to `unknown` would make
  // `unknown` useless as a "the CLI changed" indicator.
  if (subtype === "thinking_tokens") {
    return [
      {
        kind: "thinking_tokens",
        tokens: num(m.estimated_tokens),
        delta: num(m.estimated_tokens_delta),
      },
    ]
  }

  return [{ kind: "unknown", raw }]
}

function message(m: Record<string, unknown>, raw: unknown): Event[] {
  const envelope = obj(m.message)
  const content = envelope?.content
  // A string `content` is a shape this code does not claim to understand.
  if (!Array.isArray(content)) return [{ kind: "unknown", raw }]

  const fromAssistant = m.type === "assistant"
  return content.map((block) => contentBlock(block, fromAssistant))
}

function contentBlock(block: unknown, fromAssistant: boolean): Event {
  const b = obj(block)
  if (!b) return { kind: "unknown", raw: block }

  switch (b.type) {
    // Role matters here and nowhere else: user-side text is an echoed prompt or
    // a system reminder, and the prompts contain the literal `ORCH: done`.
    // Reporting one as `text` would feed the sentinel parser its own prompt.
    case "text":
      return fromAssistant ? { kind: "text", text: str(b.text) } : { kind: "unknown", raw: block }
    case "thinking":
      return fromAssistant ? { kind: "thinking", length: str(b.thinking).length } : { kind: "unknown", raw: block }
    case "tool_use":
      return { kind: "tool_use", id: str(b.id), name: str(b.name), input: b.input }
    case "tool_result":
      return {
        kind: "tool_result",
        toolUseId: str(b.tool_use_id),
        content: resultContent(b.content),
        isError: b.is_error === true,
      }
    default:
      return { kind: "unknown", raw: block }
  }
}

/**
 * Flattens a `tool_result` content field. The fixtures only carry the string
 * shape, but the array shape is real; a non-text part such as an image stays
 * visible as JSON rather than vanishing, which would be the silent direction.
 */
function resultContent(content: unknown): string {
  if (typeof content === "string") return content
  if (content === null || content === undefined) return ""
  if (Array.isArray(content)) {
    return content.map((part) => partText(part)).join("\n")
  }
  return JSON.stringify(content)
}

function partText(part: unknown): string {
  const p = obj(part)
  if (p && typeof p.text === "string") return p.text
  return JSON.stringify(part) ?? String(part)
}

function rateLimit(m: Record<string, unknown>): Event {
  const info = obj(m.rate_limit_info)
  const windows = obj(info?.unifiedWindows)
  // The active window is the one `rateLimitType` names, so nothing is hardcoded
  // to `five_hour`. Nothing reads `overageStatus`: when overage is disabled for
  // an org it reads "rejected" on every normal event.
  const name = info?.rateLimitType
  const window = typeof name === "string" ? obj(windows?.[name]) : undefined
  const utilization = window?.utilization

  const resetsAt = window?.resetsAt

  return {
    kind: "rate_limit",
    status: str(info?.status),
    utilization: typeof utilization === "number" ? utilization : undefined,
    resetsAt: typeof resetsAt === "number" ? resetsAt : undefined,
  }
}

/**
 * One event per `result` line, in stream order, with no state: the parser does
 * not assume a process emits exactly one. `result_index` and
 * `queued_turn_count` say it need not, so a consumer summing cost must take the
 * **last** result of each process rather than the only one.
 *
 * Fields deliberately not surfaced, because the run log keeps every line raw
 * and a later task can add one with a test: `errors` (on an error result, the
 * only human-readable reason — `result` is absent there), `terminal_reason`,
 * `stop_reason`, `result_index`, `queued_turn_count`, `safety_stops`,
 * `subagent_stats`, `modelUsage` and the timing fields.
 */
function result(m: Record<string, unknown>): Event {
  return {
    kind: "result",
    subtype: str(m.subtype),
    isError: m.is_error === true,
    costUsd: num(m.total_cost_usd),
    numTurns: num(m.num_turns),
    // `error_max_budget_usd` has no `result` key at all, so absent is a normal
    // case rather than a malformed event — and it is not the same as empty.
    text: typeof m.result === "string" ? m.result : undefined,
    permissionDenials: Array.isArray(m.permission_denials) ? m.permission_denials : [],
  }
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0
}

function count(v: unknown): number {
  return Array.isArray(v) ? v.length : 0
}
