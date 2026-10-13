import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RunHeader, RunRecord } from "../src/runlog"
import { foldRunLog, indexRuns, taskKey, verificationOf } from "../src/runindex"

// --- Folding one log --------------------------------------------------------

test("a log parked at the gate folds to waiting(gate)", async () => {
  const path = await logFile([
    headerLine(),
    { kind: "phase", phase: "plan", state: "running", sessionId: PLAN_SESSION },
    { kind: "phase", phase: "gate", state: "waiting", reason: "gate", planPath: "docs/plans/p.md" },
  ])

  const { run, warnings } = await foldRunLog(path)

  expect(run?.state).toEqual({ kind: "waiting", reason: "gate" })
  expect(warnings).toEqual([])
})

test("a run the caller knows is live reads as running, carrying the phase", async () => {
  const path = await logFile([
    headerLine({ runId: "live-one" }),
    { kind: "phase", phase: "plan", state: "running" },
    { kind: "phase", phase: "gate", state: "waiting", reason: "gate" },
    { kind: "human", action: "approve" },
    { kind: "phase", phase: "implement", state: "running", sessionId: IMPL_SESSION },
  ])

  // Liveness is not in the log and cannot be: a live run and one whose server
  // died leave identical bytes. So the caller that owns the child process says
  // which runs are live, and everything else with no `end` record is
  // interrupted.
  const live = await foldRunLog(path, { liveRunIds: ["live-one"] })
  const unclaimed = await foldRunLog(path)

  expect(live.run?.state).toEqual({ kind: "running", phase: "implement" })
  expect(unclaimed.run?.state).toEqual({ kind: "interrupted", resumeFrom: "implement" })
})

test("a finished run the caller still thinks is live reads from its end record", async () => {
  const path = await logFile([
    headerLine({ runId: "live-one" }),
    { kind: "phase", phase: "implement", state: "running" },
    { kind: "end", state: "done", costUsd: 1 },
  ])

  // Showing a finished task as running parks the user in front of a spinner
  // for a run that will never move again.
  const { run } = await foldRunLog(path, { liveRunIds: ["live-one"] })

  expect(run?.state).toEqual({ kind: "done", merged: false })
})

test("a live run parked on a human still reads as waiting", async () => {
  const path = await logFile([
    headerLine({ runId: "live-one" }),
    { kind: "phase", phase: "gate", state: "waiting", reason: "gate" },
  ])

  const { run } = await foldRunLog(path, { liveRunIds: ["live-one"] })

  expect(run?.state).toEqual({ kind: "waiting", reason: "gate" })
})

test("an end record folds to its terminal state", async () => {
  const done = await logFile([
    headerLine(),
    { kind: "phase", phase: "implement", state: "running" },
    { kind: "end", state: "done", costUsd: 1.25 },
  ])
  const failed = await logFile([
    headerLine(),
    { kind: "phase", phase: "test", state: "running" },
    { kind: "end", state: "failed", why: "budget exhausted", costUsd: 3 },
  ])

  expect((await foldRunLog(done)).run?.state).toEqual({ kind: "done", merged: false })
  expect((await foldRunLog(failed)).run?.state).toEqual({
    kind: "failed",
    why: "budget exhausted",
  })
})

test("a failed end record with no reason still reports why, rather than an empty string", async () => {
  const path = await logFile([headerLine(), { kind: "end", state: "failed", costUsd: 0 }])

  const { run } = await foldRunLog(path)

  expect(run?.state.kind).toBe("failed")
  expect(run?.state).toMatchObject({ why: expect.stringMatching(/\S/) })
})

test("no end record folds to interrupted, resuming from the last phase record", async () => {
  const path = await logFile([
    headerLine(),
    { kind: "phase", phase: "plan", state: "running" },
    { kind: "phase", phase: "gate", state: "waiting", reason: "gate" },
    { kind: "human", action: "approve" },
    { kind: "phase", phase: "implement", state: "running" },
    { kind: "test", exitCode: 1, signature: "boom", attempt: 1 },
  ])

  const { run, warnings } = await foldRunLog(path)

  expect(run?.state).toEqual({ kind: "interrupted", resumeFrom: "implement" })
  expect(warnings).toEqual([])
})

test("a log whose only line is the header folds to interrupted at the first phase", async () => {
  const path = await logFile([headerLine()])

  const { run, warnings } = await foldRunLog(path)

  // The header is written before the plan phase starts, so a run with no phase
  // record has nowhere else to resume from.
  expect(run?.state).toEqual({ kind: "interrupted", resumeFrom: "plan" })
  expect(warnings).toEqual([])
})

test("an approve the crash caught leaves the run at the gate, not past it", async () => {
  const path = await logFile([
    headerLine(),
    { kind: "phase", phase: "gate", state: "waiting", reason: "gate" },
    { kind: "human", action: "approve" },
  ])

  // The state comes from the last `phase` record, never from the `human`
  // record: the implement phase never started, so the run is still parked at
  // the gate and the human approves again - one idempotent click. Folding the
  // approve would claim a phase had begun that has no session id anywhere.
  expect((await foldRunLog(path)).run?.state).toEqual({ kind: "waiting", reason: "gate" })
})

test("a wait reads the same whether or not the server is still alive", async () => {
  const path = await logFile([
    headerLine({ runId: "live-one" }),
    { kind: "phase", phase: "implement", state: "waiting", reason: "blocked" },
  ])

  // A wait is durable: the server wrote "parked on a human" and then has
  // nothing more to write until one acts, so a dead server leaves exactly the
  // bytes a live one does.
  const live = await foldRunLog(path, { liveRunIds: ["live-one"] })
  const dead = await foldRunLog(path)

  expect(live.run?.state).toEqual({ kind: "waiting", reason: "blocked" })
  expect(dead.run?.state).toEqual({ kind: "waiting", reason: "blocked" })
})

test("a truncated final line is ignored rather than throwing", async () => {
  const path = await logFile(
    [headerLine(), { kind: "phase", phase: "implement", state: "running" }],
    { trailing: '{"kind":"end","state":"do' },
  )

  const { run, warnings } = await foldRunLog(path)

  expect(run?.state).toEqual({ kind: "interrupted", resumeFrom: "implement" })
  expect(warnings).toEqual([])
})

test("an end record outranks a stray phase record written after it", async () => {
  const path = await logFile([
    headerLine(),
    { kind: "end", state: "done", costUsd: 2 },
    { kind: "phase", phase: "refine", state: "running" },
  ])

  expect((await foldRunLog(path)).run?.state).toEqual({ kind: "done", merged: false })
})

// --- How a run was verified -------------------------------------------------
// A project may have no test command, and then the agent verifies its own work
// (docs/HANDOFF.md, user decision 2026-10-12). The one thing that holds is that
// nothing claims a verification it did not observe, so the fold has to carry
// **how** - and the absence policy makes the wrong guess here unusually cheap
// to get wrong in the expensive direction: a log written before the field
// existed cannot have recorded one, and reading that silence as "the tests
// passed" would merge work nothing checked.

test("a done run records which kind of verification it had", async () => {
  const checked = await logFile([
    headerLine(),
    { kind: "end", state: "done", costUsd: 2, verifiedBy: "test-command" },
  ])
  const selfChecked = await logFile([
    headerLine(),
    { kind: "end", state: "done", costUsd: 2, verifiedBy: "self-check" },
  ])

  expect((await foldRunLog(checked)).run?.state).toEqual({
    kind: "done",
    merged: false,
    verifiedBy: "test-command",
  })
  expect((await foldRunLog(selfChecked)).run?.state).toEqual({
    kind: "done",
    merged: false,
    verifiedBy: "self-check",
  })
})

test("a done run whose log never said how reads as unknown, never as tested", async () => {
  // Every log on disk before this field existed is this case, and so is every
  // log a newer writer truncates. The reading has to be "nobody wrote it down",
  // because the alternative - inferring `test-command` from the fact that the
  // field was once mandatory - is precisely the claim this run cannot support.
  const path = await logFile([headerLine(), { kind: "end", state: "done", costUsd: 2 }])

  const { run } = await foldRunLog(path)

  expect(verificationOf(run?.state)).toBe("unknown")
  // And it is absent from the state rather than filled in, so the state mirrors
  // what the log actually said.
  expect(run?.state).toEqual({ kind: "done", merged: false })
})

test("a verifiedBy this version does not know reads as unknown, with a warning", async () => {
  // The open-dimension rule the rest of this fold follows: a newer writer can
  // name a kind of verification this build has no word for. Passing it through
  // would have the UI render a label it has no text for; reading it as tested
  // would be the silent escalation. So: unknown, and say so in the warnings.
  const path = await logFile([
    headerLine(),
    { kind: "end", state: "done", costUsd: 2, verifiedBy: "notarised-by-a-committee" },
  ])

  const { run, warnings } = await foldRunLog(path)

  expect(verificationOf(run?.state)).toBe("unknown")
  expect(warnings.join(" ")).toContain("notarised-by-a-committee")
  // Stripped, not passed through: a label the UI has no text for would render
  // as nothing at all, which looks exactly like a run that passed its tests.
  expect(run?.state).toEqual({ kind: "done", merged: false })
})

test("verificationOf answers unknown for every state that is not a finished run", async () => {
  // The guard the UI needs: a reader that only handles `done` would read a
  // running or failed run's missing field as a pass by the same mistake.
  for (const state of [
    { kind: "running", phase: "implement" },
    { kind: "waiting", reason: "gate" },
    { kind: "failed", why: "it failed" },
    { kind: "interrupted", resumeFrom: "test" },
    undefined,
  ] as const) {
    expect(verificationOf(state), JSON.stringify(state)).toBe("unknown")
  }
})

test("a failed run carries no verification, because nothing verified it", async () => {
  const path = await logFile([
    headerLine(),
    { kind: "end", state: "failed", why: "the suite never passed", costUsd: 2, verifiedBy: "test-command" },
  ])

  // Even when a writer puts one there: `failed` means the work was not
  // accepted, so a verification label on it could only mislead.
  expect(verificationOf((await foldRunLog(path)).run?.state)).toBe("unknown")
})

test("test and human records do not move the run's state", async () => {
  const path = await logFile([
    headerLine(),
    { kind: "phase", phase: "implement", state: "running" },
    { kind: "test", exitCode: 1, signature: "a", attempt: 1 },
    { kind: "test", exitCode: 1, signature: "a", attempt: 2 },
    { kind: "human", action: "feedback", text: "try again" },
  ])

  expect((await foldRunLog(path)).run?.state).toEqual({
    kind: "interrupted",
    resumeFrom: "implement",
  })
})

test("a record with an unknown kind is ignored, not treated as corruption", async () => {
  const path = await logFile([
    headerLine(),
    { kind: "phase", phase: "implement", state: "running" },
    { kind: "checkpoint", note: "a newer writer's record" },
  ])

  const { run, warnings } = await foldRunLog(path)

  expect(run?.state).toEqual({ kind: "interrupted", resumeFrom: "implement" })
  expect(warnings).toEqual([])
})

test("an unrecognised cli payload is not corruption", async () => {
  const path = await logFile([
    headerLine(),
    { kind: "phase", phase: "implement", state: "running" },
    { kind: "cli", event: { type: "system", subtype: "invented_future_thing" } },
    { kind: "cli", event: { type: "result", total_cost_usd: 0.5, session_id: PLAN_SESSION } },
  ])

  const { run, warnings } = await foldRunLog(path)

  expect(run?.state).toEqual({ kind: "interrupted", resumeFrom: "implement" })
  expect(warnings).toEqual([])
})

// --- The guards, as a matrix ------------------------------------------------

test("a waiting phase record with no reason reads as waiting, and says so", async () => {
  const path = await logFile([
    headerLine(),
    { kind: "phase", phase: "implement", state: "waiting" },
  ])

  const { run, warnings } = await foldRunLog(path)

  // Not gate: a gate renders an Approve button, and approving a run that is
  // actually blocked feeds gate feedback into a conversation with no gate.
  expect(run?.state).toEqual({ kind: "waiting", reason: "question" })
  expect(warnings.join("\n")).toMatch(/reason/)
})

test("a waiting phase record with an unknown reason reads as waiting, and says so", async () => {
  const path = await logFile([
    headerLine(),
    { kind: "phase", phase: "implement", state: "waiting", reason: "rate_limited" },
  ])

  const { run, warnings } = await foldRunLog(path)

  expect(run?.state).toEqual({ kind: "waiting", reason: "question" })
  expect(warnings.join("\n")).toMatch(/rate_limited/)
})

test("a phase record naming a phase this version cannot resume falls back to the last it knows", async () => {
  const path = await logFile([
    headerLine(),
    { kind: "phase", phase: "implement", state: "running" },
    { kind: "phase", phase: "review", state: "running" },
  ])

  const { run, warnings } = await foldRunLog(path)

  // Resuming a phase this version has no code for would fail at spawn; the
  // last phase it does know is the one it can act on.
  expect(run?.state).toEqual({ kind: "interrupted", resumeFrom: "implement" })
  expect(warnings.join("\n")).toMatch(/review/)
})

test("a phase record with an unknown state is ignored, and says so", async () => {
  const path = await logFile([
    headerLine(),
    { kind: "phase", phase: "implement", state: "running" },
    { kind: "phase", phase: "test", state: "paused" },
  ])

  const { run, warnings } = await foldRunLog(path)

  expect(run?.state).toEqual({ kind: "interrupted", resumeFrom: "implement" })
  expect(warnings.join("\n")).toMatch(/paused/)
})

test("an end record with a state this version does not know is terminal and loud", async () => {
  const path = await logFile([headerLine(), { kind: "end", state: "cancelled", costUsd: 1 }])

  const { run, warnings } = await foldRunLog(path)

  // Terminal, because the writer said the run ended; `failed` rather than
  // `interrupted`, because offering a resume would claim the server died.
  expect(run?.state).toMatchObject({ kind: "failed" })
  expect(run?.state).toMatchObject({ why: expect.stringMatching(/cancelled/) })
  expect(warnings.join("\n")).toMatch(/cancelled/)
})

test("a log whose first line is not a header is skipped with a warning", async () => {
  const path = await logFile([{ kind: "phase", phase: "plan", state: "running" }])

  const { run, warnings } = await foldRunLog(path)

  expect(run).toBeNull()
  expect(warnings.join("\n")).toMatch(/header/)
})

test("a header on line two is not a log that starts with a header", async () => {
  const dir = await scratchDir()
  const blankFirst = join(dir, "blank.jsonl")
  const junkFirst = join(dir, "junk.jsonl")
  await writeFile(blankFirst, `\n${JSON.stringify(headerLine())}\n`)
  await writeFile(junkFirst, `not json at all\n${JSON.stringify(headerLine())}\n`)

  // Line one is the header or the log is not one. Taking the first line that
  // merely parses would attribute a run to a task on the strength of a line
  // something else wrote.
  for (const path of [blankFirst, junkFirst]) {
    const { run, warnings } = await foldRunLog(path)
    expect({ path, run }).toEqual({ path, run: null })
    expect(warnings.join("\n")).toMatch(/header/)
  }
})

test("a first line with no terminator is not a record, and says which", async () => {
  const dir = await scratchDir()
  const path = join(dir, "cut.jsonl")
  // A writer killed between the header's bytes and its newline.
  await writeFile(path, JSON.stringify(headerLine()))

  const { run, warnings } = await foldRunLog(path)

  expect(run).toBeNull()
  expect(warnings.join("\n")).toMatch(/terminator/)
})

test("an empty log file is skipped with a warning", async () => {
  const path = await logFile([])

  const { run, warnings } = await foldRunLog(path)

  expect(run).toBeNull()
  expect(warnings.join("\n")).toMatch(/empty/)
})

test("a header missing the fields a task is addressed by is skipped with a warning", async () => {
  const { taskRef: _ref, ...noRef } = header()
  const path = await logFile([{ kind: "header", ...noRef }])

  const { run, warnings } = await foldRunLog(path)

  expect(run).toBeNull()
  expect(warnings.join("\n")).toMatch(/taskRef/)
})

test("a log that is not there is skipped with a warning rather than throwing", async () => {
  const dir = await scratchDir()

  const { run, warnings } = await foldRunLog(join(dir, "gone.jsonl"))

  expect(run).toBeNull()
  expect(warnings.join("\n")).toMatch(/gone\.jsonl/)
})

// --- Cost -------------------------------------------------------------------

test("a terminal run's cost is the total the end record carries", async () => {
  const path = await logFile([
    headerLine(),
    { kind: "cli", event: { type: "result", total_cost_usd: 0.4 } },
    { kind: "cli", event: { type: "result", total_cost_usd: 0.9 } },
    { kind: "end", state: "done", costUsd: 1.3 },
  ])

  expect((await foldRunLog(path)).run?.costUsd).toBe(1.3)
})

test("a run with no end record reports the largest cost its result events show", async () => {
  const path = await logFile([
    headerLine(),
    { kind: "cli", event: { type: "result", total_cost_usd: 0.4 } },
    { kind: "cli", event: { type: "result", total_cost_usd: 0.9 } },
    { kind: "phase", phase: "implement", state: "running" },
    { kind: "cli", event: { type: "result", total_cost_usd: 0.2 } },
  ])

  // Cost resets per process, so the largest single figure is a floor on the
  // run's spend: never more than it really cost, which is the direction a
  // budget ceiling can survive.
  expect((await foldRunLog(path)).run?.costUsd).toBe(0.9)
})

test("an end record with a cost that is not a number falls back to the floor, and says so", async () => {
  const path = await logFile([
    headerLine(),
    { kind: "cli", event: { type: "result", total_cost_usd: 0.7 } },
    { kind: "end", state: "done", costUsd: null },
  ])

  const { run, warnings } = await foldRunLog(path)

  expect(run?.costUsd).toBe(0.7)
  expect(warnings.join("\n")).toMatch(/cost/)
})

test("a run with no cost anywhere reports zero", async () => {
  const path = await logFile([headerLine(), { kind: "phase", phase: "plan", state: "running" }])

  expect((await foldRunLog(path)).run?.costUsd).toBe(0)
})

// --- Reading only what it needs ---------------------------------------------

test("a lifecycle record far behind the tail is still found", async () => {
  // The implement phase, then a megabyte of cli output and no end record. A
  // reader that only ever looked at the last window would call this
  // interrupted at `plan` and resume the wrong phase.
  const noise = Array.from({ length: 2000 }, (_, i) => ({
    kind: "cli" as const,
    event: { type: "assistant", seq: i, text: "x".repeat(500) },
  }))
  const path = await logFile([
    headerLine(),
    { kind: "phase", phase: "implement", state: "running" },
    ...noise,
  ])

  const { run } = await foldRunLog(path)

  expect(run?.state).toEqual({ kind: "interrupted", resumeFrom: "implement" })
})

test("with phase records spread across chunks, the last one in the file wins", async () => {
  const noise = (tag: string) =>
    Array.from({ length: 100 }, (_, i) => ({
      kind: "cli" as const,
      event: { type: "assistant", seq: i, text: tag.repeat(200) },
    }))
  const path = await logFile([
    headerLine(),
    { kind: "phase", phase: "plan", state: "running" },
    ...noise("a"),
    { kind: "phase", phase: "implement", state: "running" },
    ...noise("b"),
  ])

  // Reading the tail backwards delivers the phase records in the opposite
  // order to the file, so "the last one wins" is a rule the reader has to
  // restore rather than inherit.
  for (const windowBytes of [512, 4096, 1 << 20]) {
    const { run } = await foldRunLog(path, { windowBytes })
    expect({ windowBytes, state: run?.state }).toEqual({
      windowBytes,
      state: { kind: "interrupted", resumeFrom: "implement" },
    })
  }
})

test("a record straddling a chunk boundary is not lost at both ends", async () => {
  // One phase record, padded so that every small window boundary falls inside
  // some record: framing each chunk on its own would drop the straddler twice.
  const noise = Array.from({ length: 60 }, (_, i) => ({
    kind: "cli" as const,
    event: { type: "assistant", seq: i, text: "c".repeat(137) },
  }))
  const path = await logFile([
    headerLine(),
    ...noise,
    { kind: "phase", phase: "refine", state: "running", sessionId: IMPL_SESSION },
    ...noise,
  ])

  for (const windowBytes of [17, 64, 137, 1000]) {
    const { run } = await foldRunLog(path, { windowBytes })
    expect({ windowBytes, state: run?.state }).toEqual({
      windowBytes,
      state: { kind: "interrupted", resumeFrom: "refine" },
    })
  }
})

test("a tail chunk holding only a phase it cannot act on keeps the reader walking", async () => {
  const noise = Array.from({ length: 100 }, (_, i) => ({
    kind: "cli" as const,
    event: { type: "assistant", seq: i, text: "d".repeat(200) },
  }))
  const path = await logFile([
    headerLine(),
    { kind: "phase", phase: "implement", state: "running" },
    ...noise,
    { kind: "phase", phase: "review", state: "running" },
  ])

  // The last chunk holds a phase record, but not one this build can resume
  // from. Counting it as "found" would stop the walk and report the first
  // phase instead of the last one it knows.
  const { run } = await foldRunLog(path, { windowBytes: 200 })

  expect(run?.state).toEqual({ kind: "interrupted", resumeFrom: "implement" })
})

test("the only phase record is found when a chunk boundary falls inside it", async () => {
  const noise = Array.from({ length: 30 }, (_, i) =>
    JSON.stringify({ kind: "cli", event: { type: "assistant", seq: i, text: "e".repeat(200) } }),
  )
  const phaseLine = JSON.stringify({ kind: "phase", phase: "refine", state: "running" })
  const lines = [JSON.stringify(headerLine()), ...noise, phaseLine, ...noise]
  const text = `${lines.join("\n")}\n`
  const dir = await scratchDir()
  const path = join(dir, "straddle.jsonl")
  await writeFile(path, text)

  // Put the first chunk's boundary three bytes into the phase line. Framing
  // each chunk on its own drops that line twice - once as a leading fragment
  // and once as a trailing one - and the run then has no phase record at all.
  const phaseStart = Buffer.byteLength(lines.slice(0, 1 + noise.length).join("\n")) + 1
  const windowBytes = Buffer.byteLength(text) - (phaseStart + 3)

  const { run } = await foldRunLog(path, { windowBytes })

  expect(run?.state).toEqual({ kind: "interrupted", resumeFrom: "refine" })
})

test("a cost seen near the tail survives the chunks read after it", async () => {
  const noise = Array.from({ length: 300 }, (_, i) => ({
    kind: "cli" as const,
    event: { type: "assistant", seq: i, text: "f".repeat(200) },
  }))
  const path = await logFile([
    headerLine(),
    { kind: "phase", phase: "implement", state: "running" },
    ...noise,
    { kind: "cli", event: { type: "result", total_cost_usd: 0.8, session_id: PLAN_SESSION } },
    ...noise.slice(0, 2),
  ])

  // The walk stops on the chunk holding the phase record, which is tens of
  // kilobytes behind the one holding the cost. Keeping only the chunk it
  // stopped on would report a run that spent nothing.
  const { run } = await foldRunLog(path, { windowBytes: 4096 })

  expect(run?.costUsd).toBe(0.8)
  expect(run?.state).toEqual({ kind: "interrupted", resumeFrom: "implement" })
})

test("the window size changes what is read, never what is folded", async () => {
  const noise = Array.from({ length: 400 }, (_, i) => ({
    kind: "cli" as const,
    event: { type: "assistant", seq: i, text: "y".repeat(200) },
  }))
  const path = await logFile([
    headerLine(),
    { kind: "phase", phase: "gate", state: "waiting", reason: "gate" },
    ...noise,
    { kind: "end", state: "done", costUsd: 4 },
  ])

  for (const windowBytes of [64, 1024, 1 << 16, 1 << 24]) {
    const { run, warnings } = await foldRunLog(path, { windowBytes })
    expect({ windowBytes, state: run?.state, cost: run?.costUsd, warnings }).toEqual({
      windowBytes,
      state: { kind: "done", merged: false },
      cost: 4,
      warnings: [],
    })
  }
})

// --- The index over a runs directory ----------------------------------------

test("an empty runs directory yields an empty index", async () => {
  const dir = await scratchDir()

  const index = await indexRuns({ runsDir: dir, branchFor: fakeBranch })

  expect(index.tasks.size).toBe(0)
  expect(index.warnings).toEqual([])
})

test("a runs directory that does not exist yet yields an empty index", async () => {
  const dir = join(await scratchDir(), "never-run")

  const index = await indexRuns({ runsDir: dir, branchFor: fakeBranch })

  expect(index.tasks.size).toBe(0)
  expect(index.warnings).toEqual([])
})

test("only .jsonl files are read", async () => {
  const dir = await scratchDir()
  await writeFile(join(dir, "notes.txt"), "not a log at all\n")
  await writeFile(join(dir, "run-1.jsonl.tmp"), "half a log\n")
  await mkdir(join(dir, "run-2.jsonl"), { recursive: true })
  await logFile([headerLine({ runId: "r1" })], { dir, name: "r1.jsonl" })

  const index = await indexRuns({ runsDir: dir, branchFor: fakeBranch })

  expect([...index.tasks.values()].map((t) => t.runId)).toEqual(["r1"])
  expect(index.warnings).toEqual([])
})

test("a one-shot list of live runs is not spent on the first log", async () => {
  const dir = await scratchDir()
  for (const runId of ["a", "b"]) {
    await logFile(
      [
        headerLine({ runId, taskRef: `T-${runId}` }),
        { kind: "phase", phase: "implement", state: "running" },
      ],
      { dir, name: `${runId}.jsonl` },
    )
  }

  // `Iterable` admits a generator, and a server holding its live runs in a Map
  // will pass `keys()`. Consuming it per log would leave every run after the
  // first reading as interrupted - and inviting a second run against a live one.
  const index = await indexRuns({
    runsDir: dir,
    branchFor: fakeBranch,
    liveRunIds: (function* () {
      yield "a"
      yield "b"
    })(),
  })

  expect([...index.tasks.values()].map((t) => t.state)).toEqual([
    { kind: "running", phase: "implement" },
    { kind: "running", phase: "implement" },
  ])
})

test("several runs for one task: the newest wins and the older ones count as attempts", async () => {
  const dir = await scratchDir()
  await logFile(
    [
      headerLine({ runId: "old", startedAt: "2026-10-01T00:00:00.000Z" }),
      { kind: "end", state: "failed", why: "tests never passed", costUsd: 2 },
    ],
    { dir, name: "old.jsonl" },
  )
  await logFile(
    [
      headerLine({ runId: "new", startedAt: "2026-10-02T00:00:00.000Z" }),
      { kind: "end", state: "done", costUsd: 3 },
    ],
    { dir, name: "new.jsonl" },
  )

  const index = await indexRuns({ runsDir: dir, branchFor: fakeBranch })
  const status = index.tasks.get(taskKey(header()))

  expect(status).toMatchObject({
    runId: "new",
    state: { kind: "done", merged: false },
    costUsd: 3,
    attempts: 2,
  })
})

test("a tie on startedAt is broken by the run id, not by directory order", async () => {
  const dir = await scratchDir()
  // Filenames deliberately not the run ids, and the winner in the middle of
  // filename order: first-wins would give aaa, last-wins bbb, and only the run
  // id deciding gives ccc.
  for (const [file, runId] of [
    ["1", "aaa"],
    ["2", "ccc"],
    ["3", "bbb"],
  ]) {
    await logFile([headerLine({ runId, startedAt: "2026-10-02T00:00:00.000Z" })], {
      dir,
      name: `${file}.jsonl`,
    })
  }

  const index = await indexRuns({ runsDir: dir, branchFor: fakeBranch })

  // Two runs can start in the same millisecond. Which one the tree calls
  // current then has to come from the runs themselves, not from whatever order
  // the filesystem hands them over in.
  expect(index.tasks.get(taskKey(header()))).toMatchObject({ runId: "ccc", attempts: 3 })
})

test("a header whose startedAt is unreadable sorts oldest and still counts as an attempt", async () => {
  const dir = await scratchDir()
  await logFile([headerLine({ runId: "undated", startedAt: "whenever" })], {
    dir,
    name: "undated.jsonl",
  })
  await logFile([headerLine({ runId: "dated", startedAt: "2026-01-01T00:00:00.000Z" })], {
    dir,
    name: "dated.jsonl",
  })

  const index = await indexRuns({ runsDir: dir, branchFor: fakeBranch })

  expect(index.tasks.get(taskKey(header()))).toMatchObject({ runId: "dated", attempts: 2 })
  expect(index.warnings.join("\n")).toMatch(/startedAt|whenever/)
})

test("one task ref in two feature files is two tasks", async () => {
  const dir = await scratchDir()
  await logFile([headerLine({ runId: "a", featureFile: "docs/features/one.md" })], {
    dir,
    name: "a.jsonl",
  })
  await logFile([headerLine({ runId: "b", featureFile: "docs/features/two.md" })], {
    dir,
    name: "b.jsonl",
  })

  const index = await indexRuns({ runsDir: dir, branchFor: fakeBranch })

  // Every feature file in a repo has a T1.
  expect(index.tasks.size).toBe(2)
  expect([...index.tasks.values()].every((t) => t.attempts === 1)).toBe(true)
})

test("one task ref in two projects is two tasks", async () => {
  const dir = await scratchDir()
  await logFile([headerLine({ runId: "a", projectPath: "/repo-a" })], { dir, name: "a.jsonl" })
  await logFile([headerLine({ runId: "b", projectPath: "/repo-b" })], { dir, name: "b.jsonl" })

  const index = await indexRuns({
    runsDir: dir,
    branchFor: fakeBranch,
    projects: ["/repo-a", "/repo-b"],
  })

  expect(index.tasks.size).toBe(2)
})

test("a log naming a project that is no longer registered is skipped with a warning", async () => {
  const dir = await scratchDir()
  await logFile([headerLine({ runId: "gone", projectPath: "/deleted" })], {
    dir,
    name: "gone.jsonl",
  })
  await logFile([headerLine({ runId: "kept", projectPath: "/repo" })], { dir, name: "kept.jsonl" })

  const index = await indexRuns({ runsDir: dir, branchFor: fakeBranch, projects: ["/repo"] })

  expect([...index.tasks.values()].map((t) => t.runId)).toEqual(["kept"])
  expect(index.warnings.join("\n")).toMatch(/\/deleted/)
})

test("without a project list nothing is filtered out", async () => {
  const dir = await scratchDir()
  await logFile([headerLine({ runId: "gone", projectPath: "/deleted" })], {
    dir,
    name: "gone.jsonl",
  })

  const index = await indexRuns({ runsDir: dir, branchFor: fakeBranch })

  expect(index.tasks.size).toBe(1)
  expect(index.warnings).toEqual([])
})

test("one unreadable log does not stop the others being indexed", async () => {
  const dir = await scratchDir()
  await writeFile(join(dir, "bad.jsonl"), "not json at all\n")
  await logFile([headerLine({ runId: "good" })], { dir, name: "good.jsonl" })

  const index = await indexRuns({ runsDir: dir, branchFor: fakeBranch })

  expect([...index.tasks.values()].map((t) => t.runId)).toEqual(["good"])
  expect(index.warnings.join("\n")).toMatch(/bad\.jsonl/)
})

// --- The two git seams ------------------------------------------------------

test("the branch comes from the caller, built from the feature file and the ref", async () => {
  const dir = await scratchDir()
  await logFile([headerLine({ featureFile: "docs/features/importer.md", taskRef: "T3" })], {
    dir,
    name: "r.jsonl",
  })
  const asked: Array<{ feature: string; ref: string }> = []

  const index = await indexRuns({
    runsDir: dir,
    branchFor: (task) => {
      asked.push(task)
      return `orch/importer-t3-deadbeef`
    },
  })

  expect(asked).toEqual([{ feature: "docs/features/importer.md", ref: "T3" }])
  expect([...index.tasks.values()][0]?.branch).toBe("orch/importer-t3-deadbeef")
})

test("a branch name that cannot be computed costs one row's branch, not the tree", async () => {
  const dir = await scratchDir()
  await logFile(
    [headerLine({ runId: "ok", taskRef: "T1" }), { kind: "end", state: "done", costUsd: 1 }],
    { dir, name: "ok.jsonl" },
  )
  await logFile(
    [headerLine({ runId: "bad", taskRef: " " }), { kind: "end", state: "done", costUsd: 2 }],
    { dir, name: "bad.jsonl" },
  )
  const asked: string[] = []

  // git.ts's taskBranchName throws on a whitespace-only ref and on an absolute
  // feature path, and a header can carry either. Dropping the row would make a
  // done-but-unmerged task look never-run, and Task 12's guard would then let a
  // second run start against it - the same reasoning that makes `merged`
  // default to false.
  const index = await indexRuns({
    runsDir: dir,
    branchFor: ({ ref }) => {
      if (ref.trim() === "") throw new Error("a task with no ref cannot own a branch")
      return `orch/x-${ref}`
    },
    isMerged: (q) => {
      asked.push(q.taskRef)
      return true
    },
  })

  expect(index.tasks.size).toBe(2)
  expect(index.tasks.get(taskKey(header({ taskRef: " " })))).toMatchObject({
    branch: "",
    state: { kind: "done", merged: false },
    costUsd: 2,
  })
  expect(index.tasks.get(taskKey(header({ taskRef: "T1" })))).toMatchObject({
    branch: "orch/x-T1",
    state: { kind: "done", merged: true },
  })
  // Nothing to ask git about: there is no branch name to compare.
  expect(asked).toEqual(["T1"])
  expect(index.warnings.join("\n")).toMatch(/branch/)
})

test("a done run is merged only when the predicate says so", async () => {
  const dir = await scratchDir()
  await logFile([headerLine({ runId: "r" }), { kind: "end", state: "done", costUsd: 1 }], {
    dir,
    name: "r.jsonl",
  })

  const unasked = await indexRuns({ runsDir: dir, branchFor: fakeBranch })
  const merged = await indexRuns({ runsDir: dir, branchFor: fakeBranch, isMerged: () => true })

  // Unasked defaults to false: "done, unmerged" makes Task 12 refuse a second
  // run, which is visible and recoverable. Claiming merged would let a second
  // run start against work that is not integrated.
  expect(unasked.tasks.get(taskKey(header()))?.state).toEqual({ kind: "done", merged: false })
  expect(merged.tasks.get(taskKey(header()))?.state).toEqual({ kind: "done", merged: true })
})

test("the merge predicate is asked only about runs that finished", async () => {
  const dir = await scratchDir()
  await logFile(
    [headerLine({ runId: "live", taskRef: "T1" }), { kind: "phase", phase: "implement", state: "running" }],
    { dir, name: "live.jsonl" },
  )
  await logFile([headerLine({ runId: "dead", taskRef: "T2" }), { kind: "end", state: "failed", why: "x", costUsd: 0 }], {
    dir,
    name: "dead.jsonl",
  })
  await logFile([headerLine({ runId: "fine", taskRef: "T3" }), { kind: "end", state: "done", costUsd: 1 }], {
    dir,
    name: "fine.jsonl",
  })
  const asked: string[] = []

  await indexRuns({
    runsDir: dir,
    branchFor: fakeBranch,
    isMerged: (q) => {
      asked.push(q.taskRef)
      return false
    },
  })

  // A git call per row would make the tree's cost a git cost.
  expect(asked).toEqual(["T3"])
})

test("the predicate is given what the log knows about the run", async () => {
  const dir = await scratchDir()
  await logFile([headerLine({ runId: "r" }), { kind: "end", state: "done", costUsd: 1 }], {
    dir,
    name: "r.jsonl",
  })
  const asked: unknown[] = []

  await indexRuns({
    runsDir: dir,
    branchFor: () => "orch/run-log-t7-cafe1234",
    isMerged: (q) => {
      asked.push(q)
      return false
    },
  })

  expect(asked).toEqual([
    {
      projectPath: "/repo",
      featureFile: "docs/features/run-log.md",
      taskRef: "T7",
      runId: "r",
      branch: "orch/run-log-t7-cafe1234",
    },
  ])
})

test("verifiedBy survives the merge check, which is the layer the tree reads", async () => {
  // The fold is not the layer the UI consumes - `indexRuns` is, and it rebuilds
  // the done state to put `merged` in it. A literal there drops `verifiedBy`
  // after the fold has read it, and the failure is silent: the state is still
  // well-formed, still says `done`, and a self-checked run arrives at the tree
  // indistinguishable from one whose suite passed. Both branches of the merge
  // predicate, because only one of them rebuilds.
  const dir = await scratchDir()
  await logFile(
    [headerLine({ runId: "r" }), { kind: "end", state: "done", costUsd: 1, verifiedBy: "self-check" }],
    { dir, name: "r.jsonl" },
  )

  const merged = await indexRuns({ runsDir: dir, branchFor: fakeBranch, isMerged: () => true })
  const unmerged = await indexRuns({ runsDir: dir, branchFor: fakeBranch, isMerged: () => false })
  const unasked = await indexRuns({ runsDir: dir, branchFor: fakeBranch })

  for (const [name, index] of [
    ["merged", merged],
    ["unmerged", unmerged],
    ["no predicate", unasked],
  ] as const) {
    const state = index.tasks.get(taskKey(header()))?.state
    expect(verificationOf(state), name).toBe("self-check")
  }
  expect(merged.tasks.get(taskKey(header()))?.state).toEqual({
    kind: "done",
    merged: true,
    verifiedBy: "self-check",
  })
})

test("a merge check that throws leaves the task unmerged with a warning", async () => {
  const dir = await scratchDir()
  await logFile([headerLine({ runId: "r" }), { kind: "end", state: "done", costUsd: 1 }], {
    dir,
    name: "r.jsonl",
  })

  // Deleting the branch after a done run makes git.ts's check throw.
  const index = await indexRuns({
    runsDir: dir,
    branchFor: fakeBranch,
    isMerged: () => {
      throw new Error("/repo has no branch orch/run-log-t7")
    },
  })

  expect(index.tasks.get(taskKey(header()))?.state).toEqual({ kind: "done", merged: false })
  expect(index.warnings.join("\n")).toMatch(/no branch/)
})

test("a slow merge check is awaited, so a promise never lands in the state", async () => {
  const dir = await scratchDir()
  await logFile([headerLine({ runId: "r" }), { kind: "end", state: "done", costUsd: 1 }], {
    dir,
    name: "r.jsonl",
  })

  const index = await indexRuns({
    runsDir: dir,
    branchFor: fakeBranch,
    isMerged: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return true
    },
  })

  expect(index.tasks.get(taskKey(header()))?.state).toEqual({ kind: "done", merged: true })
})

// --- What the tree asks for, end to end -------------------------------------

test("a task status carries everything the tree and the git guard need", async () => {
  const dir = await scratchDir()
  await logFile(
    [
      headerLine({ runId: "r", startedAt: "2026-10-02T00:00:00.000Z" }),
      { kind: "phase", phase: "gate", state: "waiting", reason: "gate" },
      { kind: "end", state: "done", costUsd: 1.5 },
    ],
    { dir, name: "r.jsonl" },
  )

  const index = await indexRuns({ runsDir: dir, branchFor: fakeBranch })

  expect(index.tasks.get(taskKey(header()))).toEqual({
    taskRef: "T7",
    projectPath: "/repo",
    featureFile: "docs/features/run-log.md",
    state: { kind: "done", merged: false },
    runId: "r",
    branch: "orch/run-log-t7",
    costUsd: 1.5,
    attempts: 1,
  })
})

// Each log here is ~19 KiB, under the default window, so every one is in fact
// read whole: what this pins is that a directory of 500 folds to 500 correct
// rows, not what it costs. The cost evidence is the measurement over 500 logs
// of 1.4 MiB described in `foldRunLog`, which this suite is the wrong place
// for - it would put a 700 MiB write in every test run.
test("a directory of 500 logs folds to 500 task statuses", async () => {
  const dir = await scratchDir()
  const noise = Array.from({ length: 40 }, (_, i) => ({
    kind: "cli" as const,
    event: { type: "assistant", seq: i, text: "z".repeat(400) },
  }))
  for (let i = 0; i < 500; i++) {
    await logFile(
      [
        headerLine({ runId: `r${i}`, taskRef: `T${i}`, startedAt: "2026-10-02T00:00:00.000Z" }),
        { kind: "phase", phase: "implement", state: "running" },
        ...noise,
        { kind: "end", state: "done", costUsd: 0.5 },
      ],
      { dir, name: `r${i}.jsonl` },
    )
  }

  const index = await indexRuns({ runsDir: dir, branchFor: fakeBranch })

  expect(index.tasks.size).toBe(500)
  expect(index.warnings).toEqual([])
  expect([...index.tasks.values()].every((t) => t.costUsd === 0.5)).toBe(true)
})

// --- Helpers ----------------------------------------------------------------

const PLAN_SESSION = "22222222-2222-4222-8222-222222222222"
const IMPL_SESSION = "33333333-3333-4333-8333-333333333333"

function header(over: Partial<RunHeader> = {}): RunHeader {
  return {
    claudeVersion: "2.1.3",
    runId: "11111111-1111-4111-8111-111111111111",
    planSessionId: PLAN_SESSION,
    profile: null,
    planModel: "claude-opus-5-5",
    implementModel: "claude-sonnet-5-5",
    planEffort: "high",
    implementEffort: "medium",
    projectPath: "/repo",
    featureFile: "docs/features/run-log.md",
    taskRef: "T7",
    featureFileHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    budgetUsd: 50,
    startedAt: "2026-10-11T09:00:00.000Z",
    ...over,
  }
}

/** The header as a record, so a log is written as a list of records. */
function headerLine(over: Partial<RunHeader> = {}): Record<string, unknown> {
  return { kind: "header", ...header(over) }
}

/** The branch a test's task would own. Real branch names come from
 * `git.ts`'s `taskBranchName`, which this deliberately does not import. */
function fakeBranch({ ref }: { feature: string; ref: string }): string {
  return `orch/run-log-${ref.toLowerCase()}`
}

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kantan-runindex-"))
  return dir
}

/**
 * A log file holding exactly these records, one JSON object per line.
 * `trailing` is appended without a terminator, which is what a writer killed
 * mid-line leaves behind.
 */
async function logFile(
  records: Array<Record<string, unknown> | RunRecord>,
  opts: { dir?: string; name?: string; trailing?: string } = {},
): Promise<string> {
  const dir = opts.dir ?? (await scratchDir())
  const path = join(dir, opts.name ?? "run.jsonl")
  const lines = records.map((r) => `${JSON.stringify(r)}\n`).join("")
  await writeFile(path, `${lines}${opts.trailing ?? ""}`)
  return path
}
