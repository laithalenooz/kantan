import { describe, expect, test } from "bun:test"
import { act, fetchPlan, fetchTree, foldRun, removeProject, startRun, subscribeRun, taskKeyOf, type RunView } from "../../src/ui/live"
import { sumProcessCost } from "../../src/ui/Sidebar"
import type { RunRecord } from "../../src/runlog"
import type { PlanSource } from "../../src/ui/Gate"

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
    expect(view.waiting).toEqual({ reason: "question", detail: "which table?", sinceMs: null })
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

  eofs: (() => void)[] = []
  addEventListener(type: "open" | "error", listener: () => void): void
  addEventListener(type: "message" | "record" | "eof", listener: (event: { data: string }) => void): void
  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    if (type === "open") this.opens.push(listener as () => void)
    if (type === "record") this.messages.push(listener)
    if (type === "eof") this.eofs.push(listener as () => void)
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
  eof(): void {
    for (const l of this.eofs) l()
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

/**
 * The envelope, which is the thing that was wrong.
 *
 * `fetchPlan` cast `res.json()` straight to `PlanSource` while `planAnswer` in
 * `src/server.ts` answers `{ ok: true, plan }`. Nothing failed loudly: the cast
 * is a compile-time assertion and the wire is not checked, so `status` was
 * `undefined` and `Gate.tsx` - whose only test for the missing case is
 * `status === "undictated"` - fell through to printing "This run recorded no
 * plan file" with nothing to approve.
 *
 * Measured on a real parked run before the fix: `GET /api/runs/:id/plan`
 * answered `status:"loaded"` with 14 kB of markdown, the log carried the path
 * on both its plan record and its park record, the file was on disk - and the
 * gate said there was no plan. A whole feature was unreachable because of the
 * one word between the response and the type.
 *
 * So these tests assert the shape of the **envelope**, not only the happy
 * field, and the first one is deliberately written from `planAnswer`'s own
 * spelling rather than from what `fetchPlan` happens to want.
 */
describe("fetchPlan reads what the server actually sends", () => {
  const answering = (body: unknown, status = 200): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

  test("unwraps `plan` from the `{ ok, plan }` envelope `planAnswer` writes", async () => {
    const plan: PlanSource = { status: "loaded", path: "docs/plans/p.md", markdown: "# Plan" }
    expect(await fetchPlan(RUN, answering({ ok: true, plan }))).toEqual(plan)
  })

  /* Every variant the server can send, because the defect was not in one of
     them: it was in the unwrapping, which every variant goes through. */
  const VARIANTS: readonly PlanSource[] = [
    { status: "loaded", path: "docs/plans/p.md", markdown: "# Plan" },
    { status: "unreadable", path: "docs/plans/p.md", why: "it is not there" },
    { status: "undictated" },
  ]
  for (const plan of VARIANTS) {
    test(`carries a \`${plan.status}\` plan through unchanged`, async () => {
      expect(await fetchPlan(RUN, answering({ ok: true, plan }))).toEqual(plan)
    })
  }

  /**
   * The cost of a wrong guess, in the direction that matters: a page talking to
   * a server that answers a shape it does not know must not render that as
   * "there is no plan". `undictated` is a claim about the run; this is a claim
   * about the two of them disagreeing, and only one of those is true.
   */
  test("an answer with no plan at all is unreadable, never `undictated`", async () => {
    for (const body of [{ ok: true }, { ok: true, plan: null }, { ok: true, plan: "nope" }, {}]) {
      const got = await fetchPlan(RUN, answering(body))
      expect(got.status).toBe("unreadable")
      expect(got.status).not.toBe("undictated")
    }
  })

  test("a refusal keeps the server's own words", async () => {
    const fetcher = (async () =>
      new Response("refused: that is not a usable run id", { status: 400 })) as unknown as typeof fetch
    const got = await fetchPlan(RUN, fetcher)
    expect(got.status).toBe("unreadable")
    expect(got.status === "unreadable" ? got.why : "").toContain("not a usable run id")
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

describe("when the run parked", () => {
  test("is carried from the waiting record, for the clock to count from", () => {
    const view = fold([
      header(),
      { kind: "phase", phase: "plan", state: "waiting", reason: "gate", at: 1_760_000_000_000 } as RunRecord,
    ])
    expect(view.waiting?.sinceMs).toBe(1_760_000_000_000)
  })

  test("a log written before the field existed says null, never a substitute", () => {
    // Falling back to the run's start reads "waiting 47m" for a gate parked two
    // minutes ago; falling back to now resets on every reload. Both are worse
    // than printing no clock.
    const view = fold([header(), { kind: "phase", phase: "plan", state: "waiting", reason: "gate" } as RunRecord])
    expect(view.waiting?.sinceMs).toBeNull()
  })
})

describe("how long each phase took", () => {
  test("is the gap between a phase record and the next one", () => {
    const t = 1_760_000_000_000
    const view = fold([
      header(),
      { kind: "phase", phase: "plan", state: "running", sessionId: "s", at: t } as RunRecord,
      { kind: "phase", phase: "plan", state: "waiting", reason: "gate", at: t + 8_000 } as RunRecord,
      { kind: "human", action: "approve" } as RunRecord,
      { kind: "phase", phase: "implement", state: "running", sessionId: "s2", at: t + 100_000 } as RunRecord,
      { kind: "end", state: "done", costUsd: 0.5 } as RunRecord,
    ])
    expect(view.phases.find((p) => p.phase === "plan")?.elapsedMs).toBe(8_000)
    // The gate is behind the human by then, so it reports how long they took
    // and keeps no ticking start.
    expect(view.phases.find((p) => p.phase === "gate")?.elapsedMs).toBe(92_000)
    expect(view.phases.find((p) => p.phase === "gate")?.startedAtMs).toBeUndefined()
  })

  test("a gate still waiting carries the instant the rail ticks from", () => {
    const t = 1_760_000_000_000
    const view = fold([
      header(),
      { kind: "phase", phase: "plan", state: "running", sessionId: "s", at: t } as RunRecord,
      { kind: "phase", phase: "plan", state: "waiting", reason: "gate", at: t + 8_000 } as RunRecord,
    ])
    const gate = view.phases.find((p) => p.phase === "gate")
    expect(gate?.state).toBe("waiting")
    expect(gate?.startedAtMs).toBe(t + 8_000)
    // No duration yet: it is still running, and the rail owns that clock.
    expect(gate?.elapsedMs).toBeUndefined()
  })

  test("a phase whose start is unknown gets no duration rather than a guess", () => {
    // Logs written before PhaseRecord.at. The rail's em dash is the honest
    // answer; any substitute is a fabricated measurement.
    const view = fold([
      header(),
      { kind: "phase", phase: "plan", state: "running", sessionId: "s" } as RunRecord,
      { kind: "phase", phase: "implement", state: "running", sessionId: "s2", at: 1_760_000_000_000 } as RunRecord,
    ])
    expect(view.phases.find((p) => p.phase === "plan")?.elapsedMs).toBeUndefined()
  })

  test("a clock that went backwards yields no duration, never a negative one", () => {
    const t = 1_760_000_000_000
    const view = fold([
      header(),
      { kind: "phase", phase: "plan", state: "running", sessionId: "s", at: t } as RunRecord,
      { kind: "phase", phase: "implement", state: "running", sessionId: "s2", at: t - 120_000 } as RunRecord,
    ])
    expect(view.phases.find((p) => p.phase === "plan")?.elapsedMs).toBeUndefined()
  })

  test("a finished phase keeps no startedAtMs, so no clock ticks beside its duration", () => {
    const t = 1_760_000_000_000
    const view = fold([
      header(),
      { kind: "phase", phase: "plan", state: "running", sessionId: "s", at: t } as RunRecord,
      { kind: "phase", phase: "implement", state: "running", sessionId: "s2", at: t + 5_000 } as RunRecord,
    ])
    expect(view.phases.find((p) => p.phase === "plan")?.startedAtMs).toBeUndefined()
  })
})

describe("the end of a stream", () => {
  const drive2 = (): { source: FakeSource; views: RunView[] } => {
    const source = new FakeSource()
    const views: RunView[] = []
    subscribeRun(RUN, (v) => views.push(v), () => source)
    return { source, views }
  }

  test("an eof frame closes the source, so EventSource stops reconnecting", () => {
    /*
     * The bug this pins: the server closes a stream once it has replayed the
     * `end` record, rather than holding a poller open for every finished run
     * someone browses to. EventSource reconnects on any closed connection. So
     * without honouring `eof`, every finished run became an infinite loop —
     * replay the whole log, close, reconnect — which is what the user saw as
     * the page refreshing over and over.
     */
    const { source } = drive2()
    source.open()
    source.emit(header())
    source.emit({ kind: "end", state: "done", costUsd: 0.5 })
    expect(source.closed).toBe(false)
    source.eof()
    expect(source.closed).toBe(true)
  })

  test("a stream that merely drops is NOT closed, because that one must retry", () => {
    // The server sends no `eof` when a read fails mid-stream: the client
    // cannot act on the reason, and a dropped connection is exactly what
    // EventSource's retry is for. Closing on the disconnect instead of on the
    // frame would strand a live run.
    const { source } = drive2()
    source.open()
    source.emit(header())
    source.emit({ kind: "phase", phase: "implement", state: "running", sessionId: "s" })
    expect(source.closed).toBe(false)
  })
})

describe("a server restart must not strand the open tab", () => {
  test("a 401 re-opens the session and retries once", async () => {
    /*
     * The token is minted per launch, so restarting the server invalidates
     * every tab holding the old cookie — and a developer tool gets restarted
     * constantly. The refusal even tells the user to load 127.0.0.1:3100,
     * which in dev is the wrong port.
     */
    const calls: string[] = []
    let authed = false
    const fetcher = (async (url: string | URL | Request) => {
      const u = String(url)
      calls.push(u)
      if (u.endsWith("/session")) {
        authed = true
        return Response.json({ ok: true, dev: true, origin: "http://127.0.0.1:3100" })
      }
      if (!authed) return new Response(JSON.stringify({ error: "refused: no valid kantan_token cookie" }), { status: 401 })
      return Response.json({ ok: true, projects: [], runs: {}, warnings: [] })
    }) as unknown as typeof fetch

    const tree = await fetchTree(fetcher)
    expect(tree.projects).toEqual([])
    expect(calls).toEqual(["/api/projects", "/api/session", "/api/projects"])
  })

  test("it retries exactly once, so a real 401 does not loop", async () => {
    let n = 0
    const fetcher = (async (url: string | URL | Request) => {
      const u = String(url)
      if (u.endsWith("/session")) return Response.json({ ok: true })
      n += 1
      return new Response("refused", { status: 401 })
    }) as unknown as typeof fetch
    await expect(fetchTree(fetcher)).rejects.toThrow("401")
    expect(n).toBe(2)
  })

  test("a non-401 failure is not retried, because a POST may already have acted", async () => {
    let n = 0
    const fetcher = (async (url: string | URL | Request) => {
      if (String(url).endsWith("/session")) return Response.json({ ok: true })
      n += 1
      return new Response("refused: dirty", { status: 409 })
    }) as unknown as typeof fetch
    await expect(act("r-1", { kind: "approve" }, fetcher)).rejects.toThrow("409")
    expect(n).toBe(1)
  })
})

describe("removing a project", () => {
  test("a 404 is success, because a double submit is the reachable case", async () => {
    // The route answers 404 for a path that is not registered, and is right to:
    // nothing can recover that distinction from a 200 answered to a
    // misspelling. But by the time this runs, "not registered" is what the
    // caller wanted, and "that project could not be removed" for a project
    // that is gone is the confusing direction.
    const fetcher = (async (url: string | URL | Request) => {
      if (String(url).endsWith("/session")) return Response.json({ ok: true })
      return new Response(JSON.stringify({ error: "not registered" }), { status: 404 })
    }) as unknown as typeof fetch
    await expect(removeProject("/gone", fetcher)).resolves.toBeUndefined()
  })

  test("a refusal that is not 404 still throws", async () => {
    // 409 while a run is in flight: removing then would leave the run
    // unreachable, since every action resolves its project first.
    const fetcher = (async (url: string | URL | Request) => {
      if (String(url).endsWith("/session")) return Response.json({ ok: true })
      return new Response("run r-1 is in flight", { status: 409 })
    }) as unknown as typeof fetch
    await expect(removeProject("/busy", fetcher)).rejects.toThrow("in flight")
  })
})

/**
 * A stop closes the phase it interrupted.
 *
 * Without this the ladder kept spinning on the phase the run was in, with its
 * clock ticking, and `costStatus` in `Sidebar.tsx` reads the same steps - so
 * the cost card went on saying "live" beside a run nobody was driving.
 * Reported from use as "why is this still grayed out and says test running".
 */
describe("a run that was stopped", () => {
  const stopped = (): RunView =>
    foldRun(RUN, [
      { kind: "phase", phase: "implement", state: "running", at: 1000, sessionId: "s1" },
      { kind: "phase", phase: "test", state: "running", at: 2000 },
      { kind: "human", action: "stop" },
    ] as RunRecord[])

  test("says so, and is not ended - a stopped run is resumable", () => {
    const view = stopped()
    expect(view.stopped).toBe(true)
    expect(view.ended).toBeNull()
  })

  test("leaves no phase running, so nothing reads as live", () => {
    const steps = stopped().phases
    expect(steps.some((s) => s.state === "running")).toBe(false)
    const test = steps.find((s) => s.phase === "test")
    expect(test?.state).toBe("pending")
    // The note carries the meaning; `pending`'s hollow mark only says "not
    // running". `flagged` is the amber retry glyph, and a human pressing stop
    // is not a fault.
    expect(test?.note).toBe("stopped")
    // And no clock to tick: `startedAtMs` would run a timer on a dead phase.
    expect(test?.startedAtMs).toBeUndefined()
  })

  test("offers no gate, because nothing is listening for an approval", () => {
    const view = foldRun(RUN, [
      { kind: "phase", phase: "plan", state: "running", at: 1000, sessionId: "s1", planPath: "p.md" },
      { kind: "phase", phase: "plan", state: "waiting", reason: "gate", at: 2000, detail: "p.md" },
      { kind: "human", action: "stop" },
    ] as RunRecord[])
    expect(view.stopped).toBe(true)
    expect(view.waiting).toBeNull()
    expect(view.waitId).toBeNull()
  })

  /** A phase record after the stop is a resume: the run is moving again. */
  test("a resume clears it", () => {
    const view = foldRun(RUN, [
      { kind: "phase", phase: "test", state: "running", at: 2000 },
      { kind: "human", action: "stop" },
      { kind: "phase", phase: "test", state: "running", at: 3000 },
    ] as RunRecord[])
    expect(view.stopped).toBe(false)
    expect(view.phases.some((s) => s.state === "running")).toBe(true)
  })
})
