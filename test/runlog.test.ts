import { expect, test } from "bun:test"
import { mkdtemp, open, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRunLog, openRunLog, replay, runLogPath } from "../src/runlog"
import type { OwnRecord, RunHeader, RunRecord } from "../src/runlog"

const FIXTURE = join(import.meta.dir, "fixtures", "plan-success.jsonl")

// --- The header -------------------------------------------------------------

test("the header is the first line of a new log", async () => {
  const { path } = await scratch()
  const log = await createRunLog(path, header())
  await log.close()

  const lines = await logLines(path)
  expect(lines).toHaveLength(1)
  expect(JSON.parse(lines[0]!)).toEqual({ kind: "header", ...header() })
})

test("the header carries every field needed to interpret and resume the run", async () => {
  const { path } = await scratch()
  const log = await createRunLog(path, header())
  await log.close()

  const [first] = await collect(path)
  expect(first).toMatchObject({
    kind: "header",
    claudeVersion: "2.1.3",
    runId: "11111111-1111-4111-8111-111111111111",
    planSessionId: "22222222-2222-4222-8222-222222222222",
    profile: null,
    planModel: "claude-opus-5-5",
    implementModel: "claude-sonnet-5-5",
    planEffort: "high",
    implementEffort: "medium",
    projectPath: "/repo",
    featureFile: "docs/features/run-log.md",
    taskRef: "T7",
    budgetUsd: 50,
    startedAt: "2026-10-11T09:00:00.000Z",
  })
})

test("the header does not carry implementSessionId, which does not exist yet", async () => {
  const { path } = await scratch()
  const log = await createRunLog(path, header())
  await log.close()

  const lines = await logLines(path)
  expect(lines[0]).not.toContain("implementSessionId")
})

test("the implement phase record carries the session id minted at the gate", async () => {
  const { path } = await scratch()
  const log = await createRunLog(path, header())
  await log.append({ kind: "human", action: "approve" })
  await log.append({
    kind: "phase",
    phase: "implement",
    state: "running",
    sessionId: "33333333-3333-4333-8333-333333333333",
  })
  await log.close()

  const records = await collect(path)
  expect(records[2]).toEqual({
    kind: "phase",
    phase: "implement",
    state: "running",
    sessionId: "33333333-3333-4333-8333-333333333333",
  })
})

test("a second header is refused rather than appended", async () => {
  const { path } = await scratch()
  const log = await createRunLog(path, header())
  // @ts-expect-error append() takes the orchestrator's own records, never a header.
  await expect(log.append({ kind: "header", ...header() })).rejects.toThrow(/header/)
  await log.close()

  expect(await logLines(path)).toHaveLength(1)
})

test("creating a log over an existing one is refused, so two runs cannot interleave", async () => {
  const { path } = await scratch()
  const log = await createRunLog(path, header())
  await log.close()

  await expect(createRunLog(path, header())).rejects.toThrow(/already exists/)
  expect(await logLines(path)).toHaveLength(1)
})

test("the runs directory is created on the first run ever", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orch-runlog-"))
  const path = runLogPath("11111111-1111-4111-8111-111111111111", join(dir, "nothing", "here", "runs"))
  const log = await createRunLog(path, header())
  await log.close()

  expect(await logLines(path)).toHaveLength(1)
})

test("runLogPath names the file after the run id", () => {
  expect(runLogPath("abc", "/runs")).toBe("/runs/abc.jsonl")
})

test("runLogPath refuses a run id that would escape the runs directory", () => {
  expect(() => runLogPath("../../etc/passwd", "/runs")).toThrow(/run id/)
  expect(() => runLogPath("a/b", "/runs")).toThrow(/run id/)
  expect(() => runLogPath("..", "/runs")).toThrow(/run id/)
  expect(() => runLogPath("", "/runs")).toThrow(/run id/)
})

// --- cli records nest the event untouched -----------------------------------

test("every real event in plan-success.jsonl nests byte-identically", async () => {
  const raws = await fixtureLines()
  const { path } = await scratch()
  const log = await createRunLog(path, header())
  for (const raw of raws) await log.appendCli(raw)
  await log.close()

  const lines = await logLines(path)
  expect(lines).toHaveLength(raws.length + 1)
  for (const [i, raw] of raws.entries()) {
    // The payload is the fixture's own bytes, spliced in, not a re-serialisation
    // of them: the fixture writes `"type": "system"` with a space the writer
    // would drop.
    expect(lines[i + 1]).toBe(`{"kind":"cli","event":${raw}}`)
  }
})

test("a replayed event re-serialises to the same bytes as the original", async () => {
  const raws = await fixtureLines()
  const { path } = await scratch()
  const log = await createRunLog(path, header())
  for (const raw of raws) await log.appendCli(raw)
  await log.close()

  const records = await collect(path)
  const events = records.slice(1)
  expect(events).toHaveLength(raws.length)
  for (const [i, raw] of raws.entries()) {
    const record = events[i]!
    expect(record.kind).toBe("cli")
    const event = (record as { event: unknown }).event
    expect(JSON.stringify(event)).toBe(JSON.stringify(JSON.parse(raw)))
  }
})

test("a cli payload split over newlines is refused, because it would break the framing", async () => {
  const { path } = await scratch()
  const log = await createRunLog(path, header())
  const pretty = JSON.stringify({ type: "system", subtype: "init" }, null, 2)

  await expect(log.appendCli(pretty)).rejects.toThrow(/newline/)
  // A line read from stdout with its terminator still attached is the same bug.
  await expect(log.appendCli('{"type":"system"}\n')).rejects.toThrow(/newline/)
  await log.close()

  expect(await logLines(path)).toHaveLength(1)
})

test("a cli payload that is not a JSON object is refused rather than written", async () => {
  const { path } = await scratch()
  const log = await createRunLog(path, header())

  await expect(log.appendCli('{"type":"sys')).rejects.toThrow(/JSON/)
  await expect(log.appendCli("")).rejects.toThrow(/JSON/)
  await expect(log.appendCli("[1,2]")).rejects.toThrow(/object/)
  await expect(log.appendCli("null")).rejects.toThrow(/object/)
  await expect(log.appendCli("42")).rejects.toThrow(/object/)
  await log.close()

  expect(await logLines(path)).toHaveLength(1)
})

// --- The orchestrator's own records -----------------------------------------

test("phase, test, human and end records round-trip", async () => {
  const { path } = await scratch()
  const log = await createRunLog(path, header())
  const own: OwnRecord[] = [
    {
      kind: "phase",
      phase: "plan",
      state: "running",
      planPath: "docs/plans/2026-10-11-run-log.md",
      sessionId: "22222222-2222-4222-8222-222222222222",
    },
    { kind: "phase", phase: "gate", state: "waiting", reason: "gate" },
    { kind: "human", action: "feedback", text: "split the guard out" },
    { kind: "human", action: "approve" },
    { kind: "test", exitCode: 1, signature: "3 failed: parses a split line", attempt: 1 },
    { kind: "test", exitCode: 0, attempt: 2 },
    { kind: "end", state: "done", costUsd: 1.37 },
  ]
  for (const record of own) await log.append(record)
  await log.close()

  expect((await collect(path)).slice(1)).toEqual(own)
})

test("an end record is not required: a killed server leaves none and the log still reads", async () => {
  const { path } = await scratch()
  const log = await createRunLog(path, header())
  await log.append({ kind: "phase", phase: "implement", state: "running" })
  await log.append({ kind: "test", exitCode: 1, signature: "1 failed", attempt: 1 })
  await log.close()

  const records = await collect(path)
  expect(records).toHaveLength(3)
  expect(records.some((r) => r.kind === "end")).toBe(false)
})

// --- replay(): from byte 0, then tail ---------------------------------------

test("replay yields every record already in the file, in order", async () => {
  const { path } = await scratch()
  const log = await createRunLog(path, header())
  for (let i = 1; i <= 5; i++) await log.append({ kind: "test", exitCode: i, attempt: i })
  await log.close()

  expect((await collect(path)).map(kindOf)).toEqual(["header", "test", "test", "test", "test", "test"])
})

test("replay follows records appended after it attached", async () => {
  const { path } = await scratch()
  const log = await createRunLog(path, header())

  const reader = follow(path, 4)
  await log.append({ kind: "test", exitCode: 1, attempt: 1 })
  await log.append({ kind: "test", exitCode: 0, attempt: 2 })
  await log.append({ kind: "end", state: "done", costUsd: 0.5 })

  expect((await reader).map(kindOf)).toEqual(["header", "test", "test", "end"])
  await log.close()
})

test("replay does not stop at the end record: framing is not interpretation", async () => {
  const { path } = await scratch()
  const log = await createRunLog(path, header())
  await log.append({ kind: "end", state: "failed", why: "budget", costUsd: 50 })
  await log.append({ kind: "test", exitCode: 0, attempt: 9 })
  await log.close()

  expect((await collect(path)).map(kindOf)).toEqual(["header", "end", "test"])
})

test("two concurrent readers both see every line", async () => {
  const { path } = await scratch()
  const log = await createRunLog(path, header())

  const a = follow(path, 4)
  const b = follow(path, 4)
  for (let i = 1; i <= 3; i++) await log.append({ kind: "test", exitCode: 0, attempt: i })

  const [first, second] = await Promise.all([a, b])
  expect(first.map(kindOf)).toEqual(["header", "test", "test", "test"])
  expect(second).toEqual(first)
  await log.close()
})

test("a reader attached while the writer appends loses and duplicates nothing", async () => {
  const { path } = await scratch()
  const log = await createRunLog(path, header())
  const total = 200

  const reader = follow(path, total + 1)
  for (let i = 1; i <= total; i++) {
    await log.append({ kind: "test", exitCode: 0, attempt: i })
  }

  const records = await reader
  expect(records).toHaveLength(total + 1)
  expect(records.slice(1).map((r) => (r as { attempt: number }).attempt)).toEqual(
    Array.from({ length: total }, (_, i) => i + 1),
  )
  await log.close()
})

test("appends made without awaiting land whole and in the order they were made", async () => {
  const { path } = await scratch()
  const log = await createRunLog(path, header())
  const total = 200
  // Long enough that a short write would have somewhere to interleave.
  const filler = "x".repeat(4096)

  const writes = []
  for (let i = 1; i <= total; i++) {
    writes.push(log.append({ kind: "test", exitCode: 0, signature: filler, attempt: i }))
  }
  await Promise.all(writes)
  await log.close()

  const records = await collect(path)
  // A spliced line would fail to parse and be skipped, so a short count is an
  // interleaved write just as much as a reordered attempt is.
  expect(records).toHaveLength(total + 1)
  expect(records.slice(1).map((r) => (r as { attempt: number }).attempt)).toEqual(
    Array.from({ length: total }, (_, i) => i + 1),
  )
})

test("replay closes its handle when the consumer breaks out", async () => {
  const { path } = await scratch()
  const log = await createRunLog(path, header())
  await log.close()

  const before = await openHandles()
  for (let i = 0; i < 50; i++) {
    for await (const _ of replay(path)) break
  }
  // Fifty leaked handles would be unmistakable; a couple of unrelated fds
  // opening during the loop would not.
  expect(await openHandles()).toBeLessThan(before + 10)
})

test("aborting while following returns without waiting out the poll interval", async () => {
  const { path } = await scratch()
  const log = await createRunLog(path, header())
  await log.close()

  const ac = new AbortController()
  const started = Date.now()
  const reader = (async () => {
    const seen: RunRecord[] = []
    for await (const r of replay(path, { follow: true, signal: ac.signal, pollMs: 10_000 })) {
      seen.push(r)
    }
    return seen
  })()
  await Bun.sleep(20)
  ac.abort()

  expect(await reader).toHaveLength(1)
  expect(Date.now() - started).toBeLessThan(2_000)
})

// --- The mid-write tail, every shape it can take ----------------------------

const WHOLE = '{"kind":"test","exitCode":0,"attempt":1}'
const SECOND = '{"kind":"test","exitCode":0,"attempt":2}'

test("tail: a complete line with its newline is emitted", async () => {
  const path = await rawLog(`${WHOLE}\n`)
  expect(await collect(path)).toEqual([JSON.parse(WHOLE)])
})

test("tail: a complete line without its newline yet is held, not emitted", async () => {
  const path = await rawLog(`${WHOLE}\n${SECOND}`)
  expect(await collect(path)).toEqual([JSON.parse(WHOLE)])
})

test("tail: a held line is emitted once its newline arrives", async () => {
  const path = await rawLog(`${WHOLE}\n${SECOND}`)
  const reader = follow(path, 2)
  await appendRaw(path, "\n")
  expect(await reader).toEqual([JSON.parse(WHOLE), JSON.parse(SECOND)])
})

test("tail: a partial JSON object is held and never parsed", async () => {
  const path = await rawLog(`${WHOLE}\n{"kind":"cli","event":{"type":"sys`)
  expect(await collect(path)).toEqual([JSON.parse(WHOLE)])
})

test("tail: a partial object completed by a later append is emitted whole", async () => {
  const path = await rawLog(`{"kind":"cli","event":{"type":"sys`)
  const reader = follow(path, 1)
  await appendRaw(path, 'tem"}}\n')
  expect(await reader).toEqual([{ kind: "cli", event: { type: "system" } }])
})

test("tail: a multi-byte character split across writes is never decoded in halves", async () => {
  const path = await rawLog("")
  const text = "مسار/مشروع 🚀"
  const line = `${JSON.stringify({ kind: "human", action: "feedback", text })}\n`
  const bytes = new TextEncoder().encode(line)

  const reader = follow(path, 1, { pollMs: 1 })
  const fh = await open(path, "a")
  try {
    for (const byte of bytes) {
      await fh.write(new Uint8Array([byte]))
      await Bun.sleep(1)
    }
  } finally {
    await fh.close()
  }

  const [record] = await reader
  expect(record).toEqual({ kind: "human", action: "feedback", text })
  expect(JSON.stringify(record)).not.toContain("�")
})

test("tail: a blank line carries no record and is skipped", async () => {
  const path = await rawLog(`${WHOLE}\n\n   \n${SECOND}\n`)
  expect(await collect(path)).toEqual([JSON.parse(WHOLE), JSON.parse(SECOND)])
})

test("tail: an orphan fragment left by a killed writer is skipped, and later records still read", async () => {
  const path = await rawLog(`${WHOLE}\n{"kind":"cli","even`)
  const log = await openRunLog(path)
  await log.append({ kind: "end", state: "failed", why: "interrupted", costUsd: 0.1 })
  await log.close()

  expect(await collect(path)).toEqual([
    JSON.parse(WHOLE),
    { kind: "end", state: "failed", why: "interrupted", costUsd: 0.1 },
  ])
})

test("openRunLog terminates a truncated tail instead of splicing into it", async () => {
  const path = await rawLog(`${WHOLE}\n{"kind":"cli","even`)
  const log = await openRunLog(path)
  await log.append({ kind: "test", exitCode: 0, attempt: 1 })
  await log.close()

  const lines = await logLines(path)
  expect(lines).toEqual([WHOLE, '{"kind":"cli","even', '{"kind":"test","exitCode":0,"attempt":1}'])
})

test("openRunLog appends straight on when the tail is already terminated", async () => {
  const path = await rawLog(`${WHOLE}\n`)
  const log = await openRunLog(path)
  await log.append({ kind: "test", exitCode: 0, attempt: 1 })
  await log.close()

  expect(await logLines(path)).toEqual([WHOLE, '{"kind":"test","exitCode":0,"attempt":1}'])
})

test("openRunLog refuses a log that is missing or has no header", async () => {
  const { path } = await scratch()
  await expect(openRunLog(path)).rejects.toThrow(/no such file|ENOENT/i)

  const empty = await rawLog("")
  await expect(openRunLog(empty)).rejects.toThrow(/empty/)
})

test("tail: a record with an unknown kind passes through for a newer reader", async () => {
  const path = await rawLog(`{"kind":"snapshot","at":"later"}\n`)
  expect(await collect(path)).toEqual([{ kind: "snapshot", at: "later" } as unknown as RunRecord])
})

test("tail: a complete line that is not a JSON object carries no record", async () => {
  const path = await rawLog(`42\n"text"\nnull\n[1,2]\n${WHOLE}\n`)
  expect(await collect(path)).toEqual([JSON.parse(WHOLE)])
})

test("an append arriving while the log is closing is refused, not half-written", async () => {
  const { path } = await scratch()
  const log = await createRunLog(path, header())

  // The stdout pump can still be appending when the phase machine closes.
  const closing = log.close()
  await expect(log.append({ kind: "test", exitCode: 0, attempt: 1 })).rejects.toThrow(/closed/)
  await closing

  expect(await logLines(path)).toHaveLength(1)
})

test("appending to a closed log fails loudly", async () => {
  const { path } = await scratch()
  const log = await createRunLog(path, header())
  await log.close()
  await expect(log.append({ kind: "test", exitCode: 0, attempt: 1 })).rejects.toThrow(/closed/)
})

// --- Helpers ----------------------------------------------------------------

function header(over: Partial<RunHeader> = {}): RunHeader {
  return {
    claudeVersion: "2.1.3",
    runId: "11111111-1111-4111-8111-111111111111",
    planSessionId: "22222222-2222-4222-8222-222222222222",
    profile: null,
    planModel: "claude-opus-5-5",
    implementModel: "claude-sonnet-5-5",
    planEffort: "high",
    implementEffort: "medium",
    projectPath: "/repo",
    featureFile: "docs/features/run-log.md",
    taskRef: "T7",
    budgetUsd: 50,
    startedAt: "2026-10-11T09:00:00.000Z",
    ...over,
  }
}

/** A directory of its own, and a log path inside it that does not exist yet. */
async function scratch(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "orch-runlog-"))
  return { dir, path: join(dir, "run.jsonl") }
}

/** A log file holding exactly these bytes, however malformed. */
async function rawLog(bytes: string): Promise<string> {
  const { path } = await scratch()
  await writeFile(path, bytes)
  return path
}

async function appendRaw(path: string, bytes: string): Promise<void> {
  const fh = await open(path, "a")
  try {
    await fh.write(bytes)
  } finally {
    await fh.close()
  }
}

/** The log's lines, without the terminator, as bytes on disk. */
async function logLines(path: string): Promise<string[]> {
  const text = await readFile(path, "utf8")
  const lines = text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
}

async function fixtureLines(): Promise<string[]> {
  return await logLines(FIXTURE)
}

async function collect(path: string): Promise<RunRecord[]> {
  const out: RunRecord[] = []
  for await (const record of replay(path)) out.push(record)
  return out
}

/** Follows until `want` records have arrived, then stops. Times out rather
 * than hanging the suite if a record never comes. */
async function follow(path: string, want: number, opts: { pollMs?: number } = {}): Promise<RunRecord[]> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 10_000)
  const out: RunRecord[] = []
  try {
    for await (const record of replay(path, { follow: true, signal: ac.signal, pollMs: opts.pollMs ?? 2 })) {
      out.push(record)
      if (out.length >= want) break
    }
  } finally {
    clearTimeout(timer)
  }
  return out
}

function kindOf(record: RunRecord): string {
  return record.kind
}

/** How many file descriptors this process holds. `/dev/fd` rather than
 * `/proc/self/fd`, so the suite runs on macOS too. */
async function openHandles(): Promise<number> {
  return (await readdir("/dev/fd")).length
}
