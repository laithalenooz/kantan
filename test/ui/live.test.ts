import { describe, expect, test } from "bun:test"
import { act, foldRun, startRun, subscribeRun, taskKeyOf, type RunView } from "../../src/ui/live"
import { sumProcessCost } from "../../src/ui/Sidebar"
import type { RunRecord } from "../../src/runlog"

const RUN = "r-1"

const header = (over: Partial<Record<string, unknown>> = {}): RunRecord =>
  ({
    kind: "header",
    claudeVersion: "2.1.0",
    runId: RUN,
    planSessionId: "s-plan",
    profile: null,
    planModel: "claude-opus-5-5",
    implementModel: "claude-sonnet-5-5",
    planEffort: "high",
    implementEffort: "medium",
    projectPath: "/repo",
    featureFile: "docs/features/x.md",
    taskRef: "T1",
    featureFileHash: "abc",
    budgetUsd: 50,
    startedAt: "2026-10-11T00:00:00.000Z",
    ...over,
  }) as RunRecord

/** A `cli` record holding an already-parsed assistant message. */
const assistant = (...blocks: unknown[]): RunRecord => ({
  kind: "cli",
  event: { type: "assistant", message: { content: blocks } },
})

const resultEvent = (costUsd: number, over: Record<string, unknown> = {}): RunRecord => ({
  kind: "cli",
  event: { type: "result", subtype: "success", is_error: false, total_cost_usd: costUsd, num_turns: 1, result: "ok", ...over },
})

const fold = (records: RunRecord[]): RunView => foldRun(RUN, records)

describe("row identity", () => {
  test("one record carrying two blocks yields two rows with distinct ids", () => {
    const view = fold([header(), assistant({ type: "text", text: "a" }, { type: "text", text: "b" })])
    expect(view.rows).toHaveLength(2)
    expect(view.rows[0]?.id).not.toBe(view.rows[1]?.id)
  })

  test("ids are identical when the same log is folded again", () => {
    // The SSE replays from byte 0 on every connect and carries no
    // replay-versus-live marker. A generated id would re-animate the whole log.
    const records = [header(), assistant({ type: "text", text: "a" }), { kind: "test", exitCode: 0, attempt: 1 } as RunRecord]
    expect(fold(records).rows.map((r) => r.id)).toEqual(fold(records).rows.map((r) => r.id))
  })

  test("a reconnect that has more records keeps the earlier ids unchanged", () => {
    const first = [header(), assistant({ type: "text", text: "a" })]
    const later = [...first, assistant({ type: "text", text: "b" })]
    const a = fold(first).rows.map((r) => r.id)
    const b = fold(later).rows.map((r) => r.id)
    expect(b.slice(0, a.length)).toEqual(a)
  })

  test("a record that yields no event does not shift the ids after it", () => {
    const hook: RunRecord = { kind: "cli", event: { type: "system", subtype: "hook_started" } }
    const withHook = fold([header(), hook, assistant({ type: "text", text: "a" })])
    // The id encodes the record's own index, so inserting a silent record does
    // not renumber what follows: that is the property that makes it stable.
    expect(withHook.rows).toHaveLength(1)
    expect(withHook.rows[0]?.id).toBe(`${RUN}#2:0`)
  })
})

describe("cost", () => {
  test("a process begins at each phase record that spawned one", () => {
    const view = fold([
      header(),
      { kind: "phase", phase: "plan", state: "running", sessionId: "s-plan" } as RunRecord,
      resultEvent(0.1),
      resultEvent(0.25),
      { kind: "phase", phase: "implement", state: "running", sessionId: "s-impl" } as RunRecord,
      resultEvent(0.17),
    ])
    expect(view.processes).toHaveLength(2)
    // Cost accumulates within a process, so the total is the last of each.
    expect(sumProcessCost(view.processes)).toBeCloseTo(0.42, 10)
  })

  test("a refine turn on the live process carries no sessionId and opens no new process", () => {
    const view = fold([
      header(),
      { kind: "phase", phase: "implement", state: "running", sessionId: "s-impl" } as RunRecord,
      resultEvent(0.1),
      { kind: "phase", phase: "refine", state: "running" } as RunRecord,
      resultEvent(0.3),
    ])
    expect(view.processes).toHaveLength(1)
    expect(sumProcessCost(view.processes)).toBeCloseTo(0.3, 10)
  })

  test("a result before any spawning phase record is still counted", () => {
    // Dropping it would under-report the one number that gates spending.
    const view = fold([header(), resultEvent(0.4)])
    expect(sumProcessCost(view.processes)).toBeCloseTo(0.4, 10)
  })

  test("the result's errors are passed through, which stream.ts does not surface", () => {
    const view = fold([header(), resultEvent(0, { subtype: "error_max_budget_usd", errors: ["Reached maximum budget ($0.0001)"] })])
    const row = view.rows[0]
    expect(row && "errors" in row ? row.errors : null).toEqual(["Reached maximum budget ($0.0001)"])
  })
})

describe("ceiling", () => {
  test("the header's figure with no raise", () => {
    expect(fold([header()]).ceilingUsd).toBe(50)
  })

  test("the newest raise replaces rather than adding to it", () => {
    const view = fold([
      header(),
      { kind: "human", action: "raise", budgetUsd: 100 } as RunRecord,
      { kind: "human", action: "raise", budgetUsd: 150 } as RunRecord,
    ])
    expect(view.ceilingUsd).toBe(150)
  })

  test("an unusable figure leaves the previous ceiling standing", () => {
    for (const bad of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      const view = fold([header(), { kind: "human", action: "raise", budgetUsd: bad } as RunRecord])
      expect(view.ceilingUsd).toBe(50)
    }
  })
})

describe("phases and parks", () => {
  test("a superseded running phase reads done", () => {
    const view = fold([
      header(),
      { kind: "phase", phase: "plan", state: "running", sessionId: "s" } as RunRecord,
      { kind: "phase", phase: "implement", state: "running", sessionId: "s2" } as RunRecord,
    ])
    expect(view.phases.find((p) => p.phase === "plan")?.state).toBe("done")
    expect(view.phases.find((p) => p.phase === "implement")?.state).toBe("running")
  })

  // `park` is called with the phase that **ran**, not the phase that waits, and
  // design §2 writes the gate as `plan -> waiting(gate)`. So `src/run.ts:864`
  // appends `{phase:"plan", state:"waiting", reason:"gate"}` and the rail has to
  // read that as plan finished, gate waiting — which is what the artboard shows.
  // `gate` is the only `WaitReason` that names a phase of its own; all four are
  // enumerated below, against their real call sites in `src/run.ts`.
  test("waiting(gate) finishes the phase that ran and parks the gate", () => {
    const view = fold([
      header(),
      { kind: "phase", phase: "plan", state: "running", sessionId: "s" } as RunRecord,
      { kind: "phase", phase: "plan", state: "waiting", reason: "gate" } as RunRecord,
    ])
    expect(view.phases.find((p) => p.phase === "plan")?.state).toBe("done")
    expect(view.phases.find((p) => p.phase === "gate")?.state).toBe("waiting")
  })

  test("the resume path's own gate record parks the gate and finishes nothing", () => {
    // `src/run.ts:2407` — `park(run, "gate", "gate", ...)`.
    const view = fold([header(), { kind: "phase", phase: "gate", state: "waiting", reason: "gate" } as RunRecord])
    expect(view.phases.find((p) => p.phase === "gate")?.state).toBe("waiting")
    expect(view.phases.find((p) => p.phase === "plan")).toBeUndefined()
  })

  test.each([
    ["question", "plan"],
    ["blocked", "implement"],
    ["stalled", "refine"],
  ] as const)("waiting(%s) parks the phase named on the record", (reason, phase) => {
    // None of these name a ladder phase, so the phase that ran is the phase
    // that waits. Reading them the way `gate` is read would finish a phase that
    // is still outstanding and park one that never ran.
    const view = fold([header(), { kind: "phase", phase, state: "waiting", reason } as RunRecord])
    expect(view.phases.find((p) => p.phase === phase)?.state).toBe("waiting")
    expect(view.phases.find((p) => p.phase === "gate")).toBeUndefined()
  })

  test("waitId names the record, so a re-asked question differs from a poll", () => {
    const view = fold([
      header(),
      { kind: "phase", phase: "implement", state: "waiting", reason: "question", detail: "which table?" } as RunRecord,
    ])
    expect(view.waitId).toBe(`${RUN}#1`)
    expect(view.waiting).toEqual({ reason: "question", detail: "which table?" })
  })

  test("the plan phase's planPath is carried, not re-derived by convention", () => {
    const view = fold([header(), { kind: "phase", phase: "plan", state: "running", sessionId: "s", planPath: "docs/plans/p.md" } as RunRecord])
    expect(view.planPath).toBe("docs/plans/p.md")
  })

  test("an ended run is not waiting on anything", () => {
    const view = fold([
      header(),
      { kind: "phase", phase: "test", state: "waiting", reason: "gate" } as RunRecord,
      { kind: "end", state: "done", costUsd: 0.5 } as RunRecord,
    ])
    expect(view.waitId).toBeNull()
    expect(view.ended).toEqual({ state: "done", costUsd: 0.5, warnings: [] })
  })

  test("an end record's warnings survive, because nothing else holds them", () => {
    const view = fold([header(), { kind: "end", state: "done", costUsd: 0.1, warnings: ["feature file edited mid-run"] } as RunRecord])
    expect(view.ended?.warnings).toEqual(["feature file edited mid-run"])
  })
})

describe("tests", () => {
  test("exit code and attempt are carried and nothing is invented", () => {
    const view = fold([header(), { kind: "test", exitCode: 1, attempt: 2, signature: "deadbeef" } as RunRecord])
    const row = view.rows[0]
    expect(row && "tests" in row ? row.tests : null).toEqual({ exitCode: 1, attempt: 2 })
  })
})

describe("records this version does not know", () => {
  test("an unknown kind becomes a visible row rather than vanishing", () => {
    // The SSE contract names every record `record` precisely so an unknown kind
    // is visible instead of arriving with no listener.
    const odd = { kind: "verdict", score: 9 } as unknown as RunRecord
    const view = fold([header(), odd])
    expect(view.rows).toHaveLength(1)
    const row = view.rows[0]
    expect(row && "event" in row ? row.event : null).toEqual({ kind: "unknown", raw: odd })
    expect(view.unknownKinds).toEqual(["verdict"])
  })

  test("a second header is a warning, not a silent overwrite", () => {
    const view = fold([header(), header({ budgetUsd: 999 })])
    expect(view.ceilingUsd).toBe(50)
    expect(view.warnings.join(" ")).toContain("header")
  })
})

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

/** An `EventSource` a test drives by hand. */
class FakeSource {
  opens: (() => void)[] = []
  messages: ((e: { data: string }) => void)[] = []
  closed = false
  url = ""

  addEventListener(type: "open" | "error", listener: () => void): void
  addEventListener(type: "message" | "record", listener: (event: { data: string }) => void): void
  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    if (type === "open") this.opens.push(listener as () => void)
    if (type === "record") this.messages.push(listener)
  }
  close(): void {
    this.closed = true
  }
  open(): void {
    for (const l of this.opens) l()
  }
  emit(record: unknown): void {
    for (const l of this.messages) l({ data: JSON.stringify(record) })
  }
  emitRaw(data: string): void {
    for (const l of this.messages) l({ data })
  }
}

describe("subscribeRun", () => {
  const drive = (): { source: FakeSource; views: RunView[]; sub: { close(): void } } => {
    const source = new FakeSource()
    const views: RunView[] = []
    const sub = subscribeRun(RUN, (v) => views.push(v), (url) => {
      source.url = url
      return source
    })
    return { source, views, sub }
  }

  test("a reconnect replaying from byte 0 does not double the log", () => {
    // EventSource reconnects on its own and the server replays everything, with
    // no marker to tell a replayed record from a live one. Appending across the
    // reconnect would double every row *and* double the cost, which is the
    // silent direction: the ceiling gets compared against twice the truth.
    const { source, views } = drive()
    source.open()
    source.emit(header())
    source.emit({ kind: "phase", phase: "plan", state: "running", sessionId: "s" })
    source.emit(resultEvent(0.3))
    const before = views.at(-1)
    expect(sumProcessCost(before?.processes ?? [])).toBeCloseTo(0.3, 10)

    source.open() // the reconnect
    source.emit(header())
    source.emit({ kind: "phase", phase: "plan", state: "running", sessionId: "s" })
    source.emit(resultEvent(0.3))
    const after = views.at(-1)
    expect(sumProcessCost(after?.processes ?? [])).toBeCloseTo(0.3, 10)
    expect(after?.rows.map((r) => r.id)).toEqual(before?.rows.map((r) => r.id))
    expect(after?.warnings).toEqual([])
  })

  test("a frame that is not JSON becomes a visible row rather than a hole", () => {
    const { source, views } = drive()
    source.open()
    source.emitRaw("{ truncated")
    expect(views.at(-1)?.rows).toHaveLength(1)
    expect(views.at(-1)?.unknownKinds).toEqual(["parse_error"])
  })

  test("the url is the run's stream, with the id encoded", () => {
    const source = new FakeSource()
    subscribeRun("r /1", () => {}, (url) => {
      source.url = url
      return source
    })
    expect(source.url).toBe("/api/runs/r%20%2F1/stream")
  })

  test("close closes the source", () => {
    const { source, sub } = drive()
    sub.close()
    expect(source.closed).toBe(true)
  })
})

describe("act", () => {
  const record = (): { calls: { url: string; init: RequestInit | undefined }[]; fetcher: typeof fetch } => {
    const calls: { url: string; init: RequestInit | undefined }[] = []
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response("", { status: 200 })
    }) as unknown as typeof fetch
    return { calls, fetcher }
  }

  test("approve and stop send no body at all", async () => {
    // The route checks the body's keys against a fixed list and refuses one it
    // does not take, so `kind` must never reach it.
    for (const kind of ["approve", "stop"] as const) {
      const { calls, fetcher } = record()
      await act(RUN, { kind }, fetcher)
      expect(calls[0]?.url).toBe(`/api/runs/${RUN}/${kind}`)
      expect(calls[0]?.init?.method).toBe("POST")
      expect(calls[0]?.init?.body).toBeUndefined()
    }
  })

  test("feedback and answer send only text", async () => {
    for (const kind of ["feedback", "answer"] as const) {
      const { calls, fetcher } = record()
      await act(RUN, { kind, text: "  keep the leading spaces  " }, fetcher)
      // Verbatim: the server trims only to judge emptiness and forwards the
      // original, because collapsing whitespace changes what the human said.
      expect(calls[0]?.init?.body).toBe(JSON.stringify({ text: "  keep the leading spaces  " }))
    }
  })

  test("raise sends only budgetUsd", async () => {
    const { calls, fetcher } = record()
    await act(RUN, { kind: "raise", budgetUsd: 100 }, fetcher)
    expect(calls[0]?.url).toBe(`/api/runs/${RUN}/raise`)
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ budgetUsd: 100 }))
  })

  test("a refusal is thrown with the server's own message", async () => {
    const fetcher = (async () => new Response("refused: that is not a usable run id", { status: 400 })) as unknown as typeof fetch
    await expect(act(RUN, { kind: "approve" }, fetcher)).rejects.toThrow("not a usable run id")
  })
})

describe("taskKeyOf", () => {
  test("joins the three parts with NUL, as runindex does", () => {
    expect(taskKeyOf({ projectPath: "/repo", featureFile: "f.md", taskRef: "T1" })).toBe("/repo\u0000f.md\u0000T1")
  })

  test("a backlog line with no ref has no key", () => {
    // It cannot be run either: run.ts refuses a task without a ref rather than
    // inventing one, so a fabricated key would address a run that cannot exist.
    expect(taskKeyOf({ projectPath: "/repo", featureFile: "f.md", taskRef: null })).toBeNull()
  })
})

describe("startRun", () => {
  test("names the task and returns the id everything else is keyed by", async () => {
    const calls: { url: string; body: unknown }[] = []
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body })
      return Response.json({ ok: true, runId: "r-new" }, { status: 201 })
    }) as unknown as typeof fetch
    const id = await startRun({ projectPath: "/repo", featureFile: "f.md", taskRef: "T1" }, fetcher)
    expect(id).toBe("r-new")
    expect(calls[0]?.body).toBe(JSON.stringify({ projectPath: "/repo", featureFile: "f.md", taskRef: "T1" }))
  })

  test("a 201 with no usable id is a failure, not a run to follow", async () => {
    // Continuing would subscribe to `undefined` and show an empty log for a run
    // that is already spending money.
    for (const answer of [{ ok: true }, { ok: true, runId: "" }, { ok: true, runId: 7 }]) {
      const fetcher = (async () => Response.json(answer, { status: 201 })) as unknown as typeof fetch
      await expect(startRun({ projectPath: "/r", featureFile: "f.md", taskRef: "T1" }, fetcher)).rejects.toThrow("did not say what its id is")
    }
  })
})

describe("a park the run has moved past", () => {
  // Found by folding a real run log: the rail read
  // `plan:done gate:waiting implement:done test:done` on a run that had
  // finished, because nothing resolved the gate once the human approved it.
  // The human record does not name a phase, and `answer` is not even a record
  // kind, so the signal is the run moving on - not the decision itself.
  test("a later phase resolves the phase that was waiting", () => {
    const view = fold([
      header(),
      { kind: "phase", phase: "plan", state: "running", sessionId: "s" } as RunRecord,
      { kind: "phase", phase: "plan", state: "waiting", reason: "gate" } as RunRecord,
      { kind: "human", action: "approve" } as RunRecord,
      { kind: "phase", phase: "implement", state: "running", sessionId: "s2" } as RunRecord,
      { kind: "end", state: "done", costUsd: 0.5 } as RunRecord,
    ])
    expect(view.phases.map((p) => `${p.phase}:${p.state}`)).toEqual(["plan:done", "gate:done", "implement:done"])
    expect(view.waiting).toBeNull()
  })

  test("a question that resumes in the same phase is not resolved twice", () => {
    const view = fold([
      header(),
      { kind: "phase", phase: "implement", state: "running", sessionId: "s" } as RunRecord,
      { kind: "phase", phase: "implement", state: "waiting", reason: "question", detail: "which table?" } as RunRecord,
      { kind: "phase", phase: "implement", state: "running" } as RunRecord,
    ])
    expect(view.phases.map((p) => `${p.phase}:${p.state}`)).toEqual(["implement:running"])
  })

  test("an ended run has no phase left waiting", () => {
    const view = fold([
      header(),
      { kind: "phase", phase: "refine", state: "waiting", reason: "stalled", detail: "three times" } as RunRecord,
      { kind: "end", state: "failed", why: "gave up", costUsd: 0.2 } as RunRecord,
    ])
    expect(view.phases.find((p) => p.state === "waiting")).toBeUndefined()
  })
})

describe("the digest timeline", () => {
  test("mirrors the records a human cares about, oldest first", () => {
    const view = fold([
      header(),
      { kind: "phase", phase: "plan", state: "running", sessionId: "s" } as RunRecord,
      { kind: "phase", phase: "plan", state: "waiting", reason: "gate" } as RunRecord,
      { kind: "human", action: "approve" } as RunRecord,
      { kind: "phase", phase: "implement", state: "running", sessionId: "s2" } as RunRecord,
      { kind: "cli", event: { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "a.ts" } }] } } },
      { kind: "cli", event: { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Write", input: { file_path: "b.ts" } }] } } },
      { kind: "phase", phase: "test", state: "running" } as RunRecord,
      { kind: "test", exitCode: 1, attempt: 1, signature: "deadbeef" } as RunRecord,
      { kind: "test", exitCode: 0, attempt: 2 } as RunRecord,
      { kind: "end", state: "done", costUsd: 0.5, warnings: ["the feature file changed"] } as RunRecord,
    ])
    expect(view.digest.map((e) => e.kind)).toEqual(["approved", "implemented", "tests", "tests", "ended"])
    expect(view.digest.map((e) => e.id)).toEqual([...new Set(view.digest.map((e) => e.id))])
  })

  test("counts files written, and never files merely read", () => {
    // The number is a claim about what the agent did while the user was away,
    // so counting a Read would report work that never happened.
    const tool = (name: string, path: string): RunRecord => ({
      kind: "cli",
      event: { type: "assistant", message: { content: [{ type: "tool_use", id: name + path, name, input: { file_path: path } }] } },
    })
    const view = fold([
      header(),
      { kind: "phase", phase: "implement", state: "running", sessionId: "s" } as RunRecord,
      tool("Read", "read-only.ts"),
      tool("Edit", "a.ts"),
      tool("Edit", "a.ts"), // the same file twice is one file
      tool("Write", "b.ts"),
      { kind: "end", state: "done", costUsd: 0.1 } as RunRecord,
    ])
    const implemented = view.digest.find((e) => e.kind === "implemented")
    expect(implemented).toEqual({ id: expect.any(String), kind: "implemented", files: 2 })
  })

  test("omits a count it does not have rather than reporting zero", () => {
    // `files` is optional in DigestEntry precisely so a caller without it says
    // nothing. Zero would be a claim that the implement phase wrote nothing.
    const view = fold([
      header(),
      { kind: "phase", phase: "implement", state: "running", sessionId: "s" } as RunRecord,
      { kind: "phase", phase: "test", state: "running" } as RunRecord,
    ])
    expect(view.digest.find((e) => e.kind === "implemented")).toEqual({ id: expect.any(String), kind: "implemented" })
  })

  test("carries an end record's warnings, which nothing else holds", () => {
    const view = fold([header(), { kind: "end", state: "failed", why: "gave up", costUsd: 0.2, warnings: ["left on its branch"] } as RunRecord])
    expect(view.digest.at(-1)).toEqual({ id: expect.any(String), kind: "ended", state: "failed", why: "gave up", warnings: ["left on its branch"] })
  })
})
