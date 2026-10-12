import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { FILTERED_HOOK_SUBTYPES, StreamParser, classify, parseStream, type Event } from "../src/stream"

const fixture = (name: string) => join(import.meta.dir, "fixtures", name)

const FIXTURES = ["plan-success.jsonl", "ends-with-question.jsonl", "budget-exhausted.jsonl"] as const

/**
 * Event counts derived from the fixtures independently of the parser, with
 * python3: non-message lines that survive the hook filter, plus one event per
 * content block of every `assistant` and `user` line.
 *
 *   cat test/fixtures/*.jsonl | python3 -c ...   (the enumeration in Task 6)
 *
 * They are here so the chunk-equivalence tests cannot pass by comparing two
 * equally broken sequences.
 */
const EXPECTED = {
  "plan-success.jsonl": { lines: 43, hooks: 20, events: 23 },
  "ends-with-question.jsonl": { lines: 30, hooks: 20, events: 10 },
  "budget-exhausted.jsonl": { lines: 26, hooks: 19, events: 7 },
} as const

/** Parses a whole string in one push, flushing anything left over. */
function parseText(text: string): Event[] {
  const p = new StreamParser()
  return [...p.push(text), ...p.end()]
}

/** Parses one synthetic line, newline-terminated like the CLI writes it. */
function parseOne(message: unknown): Event[] {
  return parseText(JSON.stringify(message) + "\n")
}

/** Parses `bytes` fed `size` bytes at a time, as a slow pipe would deliver it. */
function parseChunks(bytes: Uint8Array, size: number): Event[] {
  const p = new StreamParser()
  const out: Event[] = []
  for (let i = 0; i < bytes.length; i += size) out.push(...p.push(bytes.subarray(i, i + size)))
  out.push(...p.end())
  return out
}

/** Parses `bytes` split into two chunks at exactly `offset`. */
function parseSplitAt(bytes: Uint8Array, offset: number): Event[] {
  const p = new StreamParser()
  return [...p.push(bytes.subarray(0, offset)), ...p.push(bytes.subarray(offset)), ...p.end()]
}

async function fixtureBytes(name: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(fixture(name)).arrayBuffer())
}

async function fixtureLines(name: string): Promise<Record<string, unknown>[]> {
  const text = await Bun.file(fixture(name)).text()
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

/**
 * True when `offset` falls inside a JSON string literal. Used to prove the
 * split boundary really lands mid-string, which is the case that breaks a
 * naive per-chunk `split("\n")`.
 */
function insideString(text: string, offset: number): boolean {
  let inString = false
  let escaped = false
  for (let i = 0; i < offset; i++) {
    const c = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (c === "\\") {
      if (inString) escaped = true
      continue
    }
    if (c === '"') inString = !inString
    else if (c === "\n") inString = false // a JSON string never spans a line
  }
  return inString
}

/** The first offset at or after the midpoint of the longest line that is inside a string. */
function midStringOffset(text: string): number {
  const lines = text.split("\n")
  let longest = 0
  let start = 0
  let bestStart = 0
  for (const line of lines) {
    if (line.length > longest) {
      longest = line.length
      bestStart = start
    }
    start += line.length + 1
  }
  for (let i = bestStart + Math.floor(longest / 2); i < bestStart + longest; i++) {
    if (insideString(text, i)) return i
  }
  throw new Error("no mid-string offset found")
}

// ---------------------------------------------------------------------------
// The filter is a skipping guard. Its dimension is (type, subtype), enumerated
// from the fixtures. Over-filtering is silent, so these tests pin both
// directions: what must go, and what must survive.
// ---------------------------------------------------------------------------

test("the hook allowlist is exactly the hook subtypes the fixtures contain", async () => {
  const found = new Set<string>()
  for (const name of FIXTURES) {
    for (const m of await fixtureLines(name)) {
      // A prefix is fine for *discovery* in a test. The parser must not use one.
      if (m.type === "system" && typeof m.subtype === "string" && m.subtype.startsWith("hook")) {
        found.add(m.subtype)
      }
    }
  }
  expect([...found].sort()).toEqual([...FILTERED_HOOK_SUBTYPES].sort())
})

test("every system/hook_* event in the fixtures is filtered out", async () => {
  for (const name of FIXTURES) {
    const lines = await fixtureLines(name)
    const hooks = lines.filter(
      (m) => m.type === "system" && typeof m.subtype === "string" && m.subtype.startsWith("hook"),
    )
    // Precondition: the fixture really does carry the flood this filter exists for.
    expect(hooks).toHaveLength(EXPECTED[name].hooks)
    expect(lines).toHaveLength(EXPECTED[name].lines)

    const events = parseChunks(await fixtureBytes(name), 1 << 20)
    expect(events).toHaveLength(EXPECTED[name].events)
  }
})

test("a filtered hook subtype produces no event at all", () => {
  for (const subtype of FILTERED_HOOK_SUBTYPES) {
    expect(parseOne({ type: "system", subtype, hook_name: "SessionStart:startup" })).toEqual([])
  }
})

test("system/thinking_tokens is not filtered", () => {
  const events = parseOne({
    type: "system",
    subtype: "thinking_tokens",
    estimated_tokens: 299,
    estimated_tokens_delta: 249,
  })
  expect(events).toEqual([{ kind: "thinking_tokens", tokens: 299, delta: 249 }])
})

test("every system/thinking_tokens line in the fixtures survives", async () => {
  for (const name of FIXTURES) {
    const expected = (await fixtureLines(name)).filter(
      (m) => m.type === "system" && m.subtype === "thinking_tokens",
    ).length
    const events = parseText(await Bun.file(fixture(name)).text())
    expect(events.filter((e) => e.kind === "thinking_tokens")).toHaveLength(expected)
  }
})

test("a hook subtype no fixture contains is not filtered: the allowlist is not a prefix", () => {
  // The whole suite passes with `subtype.startsWith("hook")`, because the
  // fixtures only contain the three known subtypes. This is the test that
  // distinguishes an allowlist from a prefix, and the reason the rule asks
  // for one: a future hook subtype carrying real content must show up.
  const raw = { type: "system", subtype: "hook_invented_future_thing", output: "something real" }
  expect(parseOne(raw)).toEqual([{ kind: "unknown", raw }])
})

test("a system subtype no fixture contains arrives as unknown rather than vanishing", () => {
  const raw = { type: "system", subtype: "invented_future_thing", detail: 7 }
  expect(parseOne(raw)).toEqual([{ kind: "unknown", raw }])
})

test("a system event with no subtype arrives as unknown", () => {
  const raw = { type: "system" }
  expect(parseOne(raw)).toEqual([{ kind: "unknown", raw }])
})

test("a hook subtype under another type is not filtered: the guard reads both fields", () => {
  const raw = { type: "hook_relay", subtype: "hook_started" }
  expect(parseOne(raw)).toEqual([{ kind: "unknown", raw }])
})

test("an unrecognised top-level type arrives as unknown", () => {
  const raw = { type: "compact_boundary", detail: "x" }
  expect(parseOne(raw)).toEqual([{ kind: "unknown", raw }])
})

test("no fixture produces an unknown or a parse_error", async () => {
  for (const name of FIXTURES) {
    const events = parseText(await Bun.file(fixture(name)).text())
    expect(events.filter((e) => e.kind === "unknown" || e.kind === "parse_error")).toEqual([])
  }
})

// ---------------------------------------------------------------------------
// The events
// ---------------------------------------------------------------------------

test("init carries cwd, the tool and skill counts and the session id", async () => {
  const events = parseText(await Bun.file(fixture("plan-success.jsonl")).text())
  const init = events.find((e) => e.kind === "init")
  expect(init).toEqual({
    kind: "init",
    cwd: "/tmp/kantan-capture/workspace/a-deliberately-long-directory-name-so-the-wrapping-test-has-something-to-wrap/scratch-repo",
    tools: 110,
    skills: 243,
    sessionId: "66360d76-873e-0266-513f-44a8dcd6470f",
  })
})

test("assistant text arrives as text", async () => {
  const events = parseText(await Bun.file(fixture("plan-success.jsonl")).text())
  const texts = events.filter((e) => e.kind === "text")
  expect(texts).toHaveLength(2)
  expect(texts[0]).toMatchObject({ kind: "text" })
  expect((texts[0] as { text: string }).text.length).toBe(68)
})

test("tool_use carries its id, name and input", async () => {
  const events = parseText(await Bun.file(fixture("plan-success.jsonl")).text())
  const uses = events.filter((e) => e.kind === "tool_use")
  expect(uses).toHaveLength(5)
  expect(uses[0]).toMatchObject({
    kind: "tool_use",
    id: "toolu_01Hi4J7dHpn2pXNzTN5tk7cp",
    name: "Bash",
  })
  expect((uses[0] as { input: { description: unknown } }).input.description).toBeString()
})

test("thinking reports the length of the thinking text", () => {
  const events = parseOne({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "thinking", thinking: "abcd", signature: "s" }] },
  })
  expect(events).toEqual([{ kind: "thinking", length: 4 }])
})

test("every tool_result pairs back to an earlier tool_use id", async () => {
  for (const name of FIXTURES) {
    const events = parseText(await Bun.file(fixture(name)).text())
    const seen = new Set<string>()
    let paired = 0
    for (const e of events) {
      if (e.kind === "tool_use") seen.add(e.id)
      if (e.kind === "tool_result") {
        expect(seen).toContain(e.toolUseId)
        paired++
      }
    }
    // Not a bijection: budget-exhausted ends on a tool_use with no result.
    expect(paired).toBe(events.filter((e) => e.kind === "tool_result").length)
  }
})

test("a tool_result whose content is a string is carried through", async () => {
  const events = parseText(await Bun.file(fixture("plan-success.jsonl")).text())
  const results = events.filter((e) => e.kind === "tool_result")
  expect(results).toHaveLength(5)
  expect(results[0]).toMatchObject({
    kind: "tool_result",
    toolUseId: "toolu_01Hi4J7dHpn2pXNzTN5tk7cp",
    isError: false,
  })
  expect((results[0] as { content: string }).content).toContain("docs/features/slugger.md")
})

test("a tool_result whose content is an array flattens to its text parts", () => {
  const events = parseOne({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_array",
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
      ],
    },
  })
  expect(events).toEqual([
    { kind: "tool_result", toolUseId: "toolu_array", content: "first\nsecond", isError: false },
  ])
})

test("a non-text part of an array tool_result stays visible instead of vanishing", () => {
  const events = parseOne({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_image",
          content: [{ type: "image", source: { type: "base64", media_type: "image/png" } }],
        },
      ],
    },
  })
  expect(events).toHaveLength(1)
  expect((events[0] as { content: string }).content).toContain("image")
})

test("tool_result isError defaults to false when is_error is absent", async () => {
  // Three of the fixtures' six tool_results omit the field entirely.
  const events = parseText(await Bun.file(fixture("plan-success.jsonl")).text())
  for (const e of events) if (e.kind === "tool_result") expect(e.isError).toBeBoolean()
  expect(events.filter((e) => e.kind === "tool_result" && e.isError)).toEqual([])
})

test("tool_result reports an error result as an error", () => {
  const events = parseOne({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true }],
    },
  })
  expect(events).toEqual([{ kind: "tool_result", toolUseId: "t1", content: "boom", isError: true }])
})

test("every block of a multi-block message arrives, in order", () => {
  // Every fixture message holds exactly one block, so a content[0] parser
  // would pass every other test in this file.
  const events = parseOne({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "doing it" },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
        { type: "text", text: "done" },
      ],
    },
  })
  expect(events).toEqual([
    { kind: "text", text: "doing it" },
    { kind: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
    { kind: "text", text: "done" },
  ])
})

test("two tool_results in one user message both arrive", () => {
  const events = parseOne({
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "a", content: "1" },
        { type: "tool_result", tool_use_id: "b", content: "2" },
      ],
    },
  })
  expect(events.map((e) => (e as { toolUseId: string }).toolUseId)).toEqual(["a", "b"])
})

test("a user-side text block is not reported as assistant text", () => {
  // The implement prompt contains the literal "ORCH: done". Echoing a user
  // block as text would feed the sentinel parser its own prompt.
  const events = parseOne({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "ORCH: done" }] },
  })
  expect(events.filter((e) => e.kind === "text")).toEqual([])
  expect(events).toEqual([{ kind: "unknown", raw: { type: "text", text: "ORCH: done" } }])
})

test("an unrecognised content block arrives as unknown", () => {
  const block = { type: "server_tool_use", id: "s1" }
  const events = parseOne({ type: "assistant", message: { role: "assistant", content: [block] } })
  expect(events).toEqual([{ kind: "unknown", raw: block }])
})

test("a message with no message object arrives as unknown", () => {
  const raw = { type: "assistant" }
  expect(parseOne(raw)).toEqual([{ kind: "unknown", raw }])
})

test("a message whose content is a string arrives as unknown", () => {
  const raw = { type: "user", message: { role: "user", content: "plain prompt" } }
  expect(parseOne(raw)).toEqual([{ kind: "unknown", raw }])
})

test("rate_limit surfaces the utilization of the window named by rateLimitType", async () => {
  const events = parseText(await Bun.file(fixture("plan-success.jsonl")).text())
  const limits = events.filter((e) => e.kind === "rate_limit")
  expect(limits).toEqual([{ kind: "rate_limit", status: "allowed", utilization: 0.41, resetsAt: 1_800_000_000 }])
})

test("rate_limit reads the named window, not a hardcoded one", () => {
  const events = parseOne({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed_warning",
      rateLimitType: "seven_day",
      unifiedWindows: { five_hour: { utilization: 0.41 }, seven_day: { utilization: 0.88 } },
    },
  })
  expect(events).toEqual([{ kind: "rate_limit", status: "allowed_warning", utilization: 0.88, resetsAt: undefined }])
})

test("rate_limit reports undefined utilization when the window is missing", () => {
  const events = parseOne({
    type: "rate_limit_event",
    rate_limit_info: { status: "rejected", rateLimitType: "five_hour", unifiedWindows: {} },
  })
  expect(events).toEqual([{ kind: "rate_limit", status: "rejected", utilization: undefined, resetsAt: undefined }])
})

test("rate_limit does not key on overageStatus", () => {
  // The real CLI reports overageStatus "rejected" on every normal event when
  // overage is disabled for an org, so nothing may branch on it.
  const info = {
    status: "allowed",
    rateLimitType: "five_hour",
    overageStatus: "rejected",
    overageDisabledReason: "org_level_disabled",
    unifiedWindows: { five_hour: { utilization: 0.12 } },
  }
  const events = parseOne({ type: "rate_limit_event", rate_limit_info: info })
  expect(events).toEqual([{ kind: "rate_limit", status: "allowed", utilization: 0.12, resetsAt: undefined }])
})

test("result carries subtype, isError, cost, turns and text", async () => {
  const events = parseText(await Bun.file(fixture("plan-success.jsonl")).text())
  const result = events.find((e) => e.kind === "result")
  expect(result).toMatchObject({
    kind: "result",
    subtype: "success",
    isError: false,
    costUsd: 0.18015684999999998,
    numTurns: 6,
  })
  expect((result as { text: string | undefined }).text).toContain("ORCH")
})

test("error_max_budget_usd arrives as a result with no text", async () => {
  const events = parseText(await Bun.file(fixture("budget-exhausted.jsonl")).text())
  const result = events.find((e) => e.kind === "result")
  // The line has no `result` key at all, so a shape check on it would demote
  // the terminal event to unknown.
  expect(result).toEqual({
    kind: "result",
    subtype: "error_max_budget_usd",
    isError: true,
    costUsd: 0.0046048600000000005,
    numTurns: 1,
    text: undefined,
    permissionDenials: [],
  })
})

test("an absent result key is distinguishable from an empty one", () => {
  const absent = parseOne({ type: "result", subtype: "error_max_budget_usd" })[0]
  const empty = parseOne({ type: "result", subtype: "success", result: "" })[0]
  expect((absent as { text: string | undefined }).text).toBeUndefined()
  expect((empty as { text: string | undefined }).text).toBe("")
})

test("result carries permission denials through by name", () => {
  // Task 8b needs the denied tool visible. The fixtures only ever show [], so
  // the payload is passed through rather than reshaped into a guess.
  const denial = { tool_name: "Bash", tool_use_id: "t1", message: "denied" }
  const events = parseOne({ type: "result", subtype: "success", permission_denials: [denial] })
  expect((events[0] as { permissionDenials: unknown[] }).permissionDenials).toEqual([denial])
})

test("a result subtype no fixture contains still arrives as a result", () => {
  const events = parseOne({
    type: "result",
    subtype: "error_max_turns",
    is_error: true,
    total_cost_usd: 1.5,
    num_turns: 40,
  })
  expect(events).toEqual([
    {
      kind: "result",
      subtype: "error_max_turns",
      isError: true,
      costUsd: 1.5,
      numTurns: 40,
      text: undefined,
      permissionDenials: [],
    },
  ])
})

test("two result events in one stream both arrive, in order", () => {
  // result_index and queued_turn_count imply a process can emit more than one.
  // The parser holds no state and does not dedupe; taking the last is the
  // consumer's job.
  const first = JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 1, result: "one" })
  const second = JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 2, result: "two" })
  const events = parseText(`${first}\n${second}\n`)
  expect(events.map((e) => (e as { text: string | undefined }).text)).toEqual(["one", "two"])
  expect(events.map((e) => (e as { costUsd: number }).costUsd)).toEqual([1, 2])
})

// ---------------------------------------------------------------------------
// Malformed and truncated input: the process may have been killed mid-write.
// ---------------------------------------------------------------------------

test("a malformed line is reported rather than thrown, and the stream continues", () => {
  const good = JSON.stringify({ type: "result", subtype: "success", num_turns: 1 })
  const events = parseText(`{"type": "assist\n${good}\n`)
  expect(events).toHaveLength(2)
  expect(events[0]).toMatchObject({ kind: "parse_error", line: '{"type": "assist' })
  expect((events[0] as { error: string }).error).not.toBe("")
  expect(events[1]).toMatchObject({ kind: "result", subtype: "success" })
})

test("a truncated final line does not emit a broken event", () => {
  const events = parseText('{"type": "assistant", "message": {"role": "assistant", "content": [{"ty')
  expect(events.map((e) => e.kind)).toEqual(["parse_error"])
})

test("a complete final line with no trailing newline still parses", () => {
  const events = parseText(JSON.stringify({ type: "result", subtype: "success", num_turns: 2 }))
  expect(events).toEqual([
    {
      kind: "result",
      subtype: "success",
      isError: false,
      costUsd: 0,
      numTurns: 2,
      text: undefined,
      permissionDenials: [],
    },
  ])
})

test("blank lines are skipped, not reported as parse errors", () => {
  const good = JSON.stringify({ type: "system", subtype: "thinking_tokens", estimated_tokens: 1 })
  const events = parseText(`\n\n${good}\n   \n`)
  expect(events.map((e) => e.kind)).toEqual(["thinking_tokens"])
})

test("non-object JSON arrives as unknown rather than throwing", () => {
  expect(parseText("null\n42\n[]\n")).toEqual([
    { kind: "unknown", raw: null },
    { kind: "unknown", raw: 42 },
    { kind: "unknown", raw: [] },
  ])
})

// ---------------------------------------------------------------------------
// Chunk boundaries. A single JSON line routinely straddles a read, because
// tool inputs carry file contents.
// ---------------------------------------------------------------------------

test("the fixtures are ASCII, so a character offset is a byte offset", async () => {
  for (const name of FIXTURES) {
    const bytes = await fixtureBytes(name)
    expect(bytes.every((b) => b < 128)).toBe(true)
  }
})

test("feeding a fixture in small chunks yields the identical event sequence", async () => {
  for (const name of FIXTURES) {
    const bytes = await fixtureBytes(name)
    const whole = parseChunks(bytes, bytes.length)
    expect(whole).toHaveLength(EXPECTED[name].events)

    expect(parseChunks(bytes, 7)).toEqual(whole)
    expect(parseChunks(bytes, 1)).toEqual(whole)
  }
})

test("a split inside a JSON string yields the identical event sequence", async () => {
  for (const name of FIXTURES) {
    const text = await Bun.file(fixture(name)).text()
    const offset = midStringOffset(text)
    expect(insideString(text, offset)).toBe(true)

    const bytes = await fixtureBytes(name)
    expect(parseSplitAt(bytes, offset)).toEqual(parseChunks(bytes, bytes.length))
  }
})

test("that mid-string split really does break a naive per-chunk split", async () => {
  // Without this, the equivalence test above could be comparing two equally
  // broken sequences.
  const text = await Bun.file(fixture("plan-success.jsonl")).text()
  const offset = midStringOffset(text)
  let failures = 0
  for (const piece of [text.slice(0, offset), text.slice(offset)]) {
    for (const line of piece.split("\n")) {
      if (line.trim() === "") continue
      try {
        JSON.parse(line)
      } catch {
        failures++
      }
    }
  }
  expect(failures).toBeGreaterThan(0)
})

test("a multi-byte character split across chunks is not corrupted", () => {
  const text = "héllo 🙂 done"
  const line = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n"
  const bytes = new TextEncoder().encode(line)
  expect(bytes.length).toBeGreaterThan(line.length) // there really are multi-byte sequences
  expect(parseChunks(bytes, 1)).toEqual([{ kind: "text", text }])
})

test("parseStream consumes an async byte source", async () => {
  const bytes = await fixtureBytes("ends-with-question.jsonl")
  async function* source(): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < bytes.length; i += 1024) yield bytes.subarray(i, i + 1024)
  }
  const events: Event[] = []
  for await (const e of parseStream(source())) events.push(e)
  expect(events).toEqual(parseChunks(bytes, bytes.length))
})

// --- classify: the seam the UI reads cli records through --------------------

describe("classify", () => {
  // `runlog.ts` stores a `cli` record as `{kind:"cli", event}` where `event` is
  // the already-parsed object. The UI folds those records into rows, so it needs
  // the classification without the line framing. `parseLine` is the same
  // function with `JSON.parse` in front of it.
  test("classifies an already-parsed event", () => {
    expect(classify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.25, num_turns: 1, result: "ok" })).toEqual([
      { kind: "result", subtype: "success", isError: false, costUsd: 0.25, numTurns: 1, text: "ok", permissionDenials: [] },
    ])
  })

  test("agrees with parseStream on the same event", async () => {
    const event = { type: "assistant", message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } }
    async function* line(): AsyncGenerator<string> {
      yield JSON.stringify(event) + "\n"
    }
    const viaLine: Event[] = []
    for await (const e of parseStream(line())) viaLine.push(e)
    expect(classify(event)).toEqual(viaLine)
  })

  // The id scheme the UI keys rows on has to survive this: one record in, two
  // rows out.
  test("one event can yield several", () => {
    const events = classify({ type: "assistant", message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } })
    expect(events).toHaveLength(2)
  })

  // A filtered hook subtype yields nothing, so a record index is not a row
  // index either.
  test("one event can yield none", () => {
    expect(classify({ type: "system", subtype: "hook_started" })).toEqual([])
  })

  test("a non-object is unknown, not a throw", () => {
    expect(classify(42)).toEqual([{ kind: "unknown", raw: 42 }])
    expect(classify(null)).toEqual([{ kind: "unknown", raw: null }])
    expect(classify([])).toEqual([{ kind: "unknown", raw: [] }])
  })

  // There is no `parse_error` from here: the record held parsed JSON already.
  // A caller seeing one would be looking at a different bug.
  test("never reports a parse error", () => {
    for (const raw of [42, null, [], {}, { type: "nope" }]) {
      expect(classify(raw).some((e) => e.kind === "parse_error")).toBe(false)
    }
  })
})
