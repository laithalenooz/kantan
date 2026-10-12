/**
 * The data hooks.
 *
 * Every test here is a race, because that is the whole reason these hooks are
 * a separate module from `App.tsx`: none of them is visible in a screenshot,
 * and each one shows a plausible wrong answer rather than an error.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

// Type-only, so it is erased and does not load the module before the
// registrator has replaced the globals.
import type { RecordSource, RunView, TreePayload } from "../../src/ui/live.ts"

const registeredHere = !GlobalRegistrator.isRegistered
if (registeredHere) GlobalRegistrator.register()

/* Without this React runs the body of `act` but does not install the queue that
 * makes it flush effects, and warns on every call. The tests below passed with
 * the warning, which is the worse outcome: they would have kept passing while
 * checking a render that had not settled. */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const React = await import("react")
const { act } = React
const { createRoot } = await import("react-dom/client")
const { useAction, usePlan, useRun, useTree } = await import("../../src/ui/useRun.ts")

let host: HTMLElement
let root: ReturnType<typeof createRoot>

async function render(ui: React.ReactNode): Promise<void> {
  await act(async () => {
    root.render(ui)
  })
}

/** Lets a resolved promise's continuation run. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  host.remove()
})

afterAll(() => {
  if (registeredHere) void GlobalRegistrator.unregister()
})

/** A `fetch` that answers from a table and records what it was asked. */
function stub(answers: Record<string, () => Response>): { fetcher: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const fetcher = (async (url: string | URL | Request) => {
    const key = String(url)
    urls.push(key)
    const answer = answers[key]
    if (answer === undefined) return new Response("not stubbed", { status: 404 })
    return answer()
  }) as unknown as typeof fetch
  return { fetcher, urls }
}

const EMPTY_TREE: TreePayload = { projects: [], runs: {} }

describe("useTree", () => {
  test("gets the cookie before asking for the tree", async () => {
    // Not an ordering preference: in dev the cookie rides on the server's own
    // `GET /`, which Vite never serves, so a tree request that went first
    // would be refused for having no token.
    const { fetcher, urls } = stub({
      "/api/session": () => Response.json({ ok: true, dev: true }),
      "/api/projects": () => Response.json(EMPTY_TREE),
    })
    function Probe(): React.ReactNode {
      useTree(fetcher)
      return null
    }
    await render(<Probe />)
    await flush()
    expect(urls).toEqual(["/api/session", "/api/projects"])
  })

  test("a refusal becomes prose instead of an unhandled rejection", async () => {
    const { fetcher } = stub({
      "/api/session": () => Response.json({ ok: true, dev: true }),
      "/api/projects": () => new Response("refused: host not allowed", { status: 403 }),
    })
    const seen: { error: string | null } = { error: null }
    function Probe(): React.ReactNode {
      seen.error = useTree(fetcher).error
      return null
    }
    await render(<Probe />)
    await flush()
    expect(seen.error).toContain("host not allowed")
  })
})

describe("useRun", () => {
  class FakeSource {
    static made: FakeSource[] = []
    opens: (() => void)[] = []
    messages: ((e: { data: string }) => void)[] = []
    closed = false
    constructor(readonly url: string) {
      FakeSource.made.push(this)
    }
    addEventListener(type: "open" | "error", listener: () => void): void
    addEventListener(type: "message" | "record", listener: (event: { data: string }) => void): void
    addEventListener(type: string, listener: (event: { data: string }) => void): void {
      if (type === "open") this.opens.push(listener as () => void)
      if (type === "record") this.messages.push(listener)
    }
    close(): void {
      this.closed = true
    }
  }

  const open = (url: string): RecordSource => new FakeSource(url) as unknown as RecordSource

  beforeEach(() => {
    FakeSource.made = []
  })

  test("switching runs closes the old stream and clears the old view", async () => {
    // The clear is the point. Holding the previous run's rows until the new
    // stream's first record arrives shows one run's log under another run's
    // heading: briefly, plausibly, and wrongly.
    const seen: { view: RunView | null } = { view: null }
    function Probe({ id }: { id: string }): React.ReactNode {
      seen.view = useRun(id, open).view
      return null
    }
    await render(<Probe id="r-1" />)
    const first = FakeSource.made[0]
    await act(async () => {
      for (const l of first?.messages ?? []) l({ data: JSON.stringify({ kind: "test", exitCode: 0, attempt: 1 }) })
    })
    expect(seen.view?.rows).toHaveLength(1)

    await render(<Probe id="r-2" />)
    expect(first?.closed).toBe(true)
    expect(seen.view).toBeNull()
    expect(FakeSource.made.at(-1)?.url).toBe("/api/runs/r-2/stream")
  })

  test("a null run id opens no stream at all", async () => {
    function Probe(): React.ReactNode {
      useRun(null, open)
      return null
    }
    await render(<Probe />)
    expect(FakeSource.made).toHaveLength(0)
  })
})

/**
 * Every stub below answers `{ ok: true, plan }`, because that is what
 * `planAnswer` in `src/server.ts` writes.
 *
 * They used to answer the bare `PlanSource`, agreeing with `fetchPlan`'s cast
 * rather than with the server - so the suite was green while the gate told
 * every parked run it had recorded no plan. A transport stub that invents its
 * own envelope tests the caller against itself. `test/ui/live.test.ts` pins the
 * envelope directly; these pin what the hooks do with it.
 */
describe("usePlan", () => {
  test("asks for nothing until something is waiting at a gate", async () => {
    const { fetcher, urls } = stub({
      "/api/runs/r-1/plan": () => Response.json({ ok: true, plan: { status: "undictated" } }),
    })
    function Probe({ want }: { want: boolean }): React.ReactNode {
      usePlan("r-1", want, fetcher)
      return null
    }
    await render(<Probe want={false} />)
    await flush()
    expect(urls).toEqual([])

    await render(<Probe want />)
    await flush()
    expect(urls).toEqual(["/api/runs/r-1/plan"])
  })

  test("a slow plan for an abandoned run never lands", async () => {
    // The gate renders whatever this returns, so a late answer for the run the
    // user has already left would put the wrong plan in front of them and ask
    // them to approve it.
    const gate: { release: (() => void) | null } = { release: null }
    const slow = new Promise<void>((resolve) => {
      gate.release = resolve
    })
    const fetcher = (async (url: string | URL | Request) => {
      if (String(url).includes("r-slow")) {
        await slow
        return Response.json({ ok: true, plan: { status: "loaded", path: "slow.md", markdown: "# slow" } })
      }
      return Response.json({ ok: true, plan: { status: "loaded", path: "fast.md", markdown: "# fast" } })
    }) as unknown as typeof fetch

    const seen: { plan: unknown } = { plan: null }
    function Probe({ id }: { id: string }): React.ReactNode {
      seen.plan = usePlan(id, true, fetcher)
      return null
    }
    await render(<Probe id="r-slow" />)
    await render(<Probe id="r-fast" />)
    await flush()
    expect(seen.plan).toEqual({ status: "loaded", path: "fast.md", markdown: "# fast" })

    gate.release?.()
    await flush()
    // Still the fast one: the slow effect was torn down, so its answer is
    // discarded rather than overwriting the current run's plan.
    expect(seen.plan).toEqual({ status: "loaded", path: "fast.md", markdown: "# fast" })
  })
})

describe("useAction", () => {
  test("a refusal is reported and does not leave the button stuck", async () => {
    const fetcher = (async () => new Response("refused: the run is not waiting", { status: 409 })) as unknown as typeof fetch
    const seen: { api: ReturnType<typeof useAction> | null } = { api: null }
    function Probe(): React.ReactNode {
      seen.api = useAction("r-1", fetcher)
      return null
    }
    await render(<Probe />)
    await act(async () => {
      await seen.api?.send({ kind: "approve" })
    })
    expect(seen.api?.error).toContain("not waiting")
    expect(seen.api?.pending).toBe(false)
  })

  test("an action with nothing selected is reported, not thrown", async () => {
    // A keyboard shortcut reaches this with an empty tree.
    const fetcher = (async () => new Response("", { status: 200 })) as unknown as typeof fetch
    const seen: { api: ReturnType<typeof useAction> | null } = { api: null }
    function Probe(): React.ReactNode {
      seen.api = useAction(null, fetcher)
      return null
    }
    await render(<Probe />)
    await act(async () => {
      await seen.api?.send({ kind: "approve" })
    })
    expect(seen.api?.error).toContain("no run selected")
  })
})

describe("a selection change must not leave the old run on screen", () => {
  /*
   * Reported by the Task 25 agent, about a hazard its own guard cannot close:
   *
   *   "Enter on T3 makes T3 aria-current, and if the shell keeps rendering T2's
   *    gate until the next fetch resolves, a bare `a` approves T2's plan. The
   *    gate must change or unmount at the moment the selection changes, not
   *    when the fetch lands."
   *
   * Clearing inside an effect is too late: effects run after the commit, so
   * there is one painted frame showing the previous run's plan under the new
   * run's heading. A keystroke in that frame approves the wrong plan and starts
   * a real implementation run. So the guarantee has to hold at render time.
   */
  class Src {
    static made: Src[] = []
    messages: ((e: { data: string }) => void)[] = []
    closed = false
    constructor(readonly url: string) {
      Src.made.push(this)
    }
    addEventListener(type: "open" | "error", listener: () => void): void
    addEventListener(type: "message" | "record", listener: (event: { data: string }) => void): void
    addEventListener(type: string, listener: (event: { data: string }) => void): void {
      if (type === "record") this.messages.push(listener)
    }
    close(): void {
      this.closed = true
    }
  }
  const open = (url: string): RecordSource => new Src(url) as unknown as RecordSource

  test("no render ever sees one run's rows under another run's id", async () => {
    Src.made = []
    // Every render records which run it was asked for and which run the rows it
    // was handed actually came from. Row ids are `runId#record:event`.
    const seen: { asked: string; rowsFrom: string | null }[] = []
    function Probe({ id }: { id: string }): React.ReactNode {
      const { view } = useRun(id, open)
      const first = view?.rows[0]?.id ?? null
      seen.push({ asked: id, rowsFrom: first === null ? null : (first.split("#")[0] ?? null) })
      return null
    }

    await render(<Probe id="r-1" />)
    await act(async () => {
      for (const l of Src.made[0]?.messages ?? []) l({ data: JSON.stringify({ kind: "test", exitCode: 0, attempt: 1 }) })
    })
    expect(seen.at(-1)).toEqual({ asked: "r-1", rowsFrom: "r-1" })

    await render(<Probe id="r-2" />)
    const mismatched = seen.filter((s) => s.rowsFrom !== null && s.rowsFrom !== s.asked)
    expect(mismatched).toEqual([])
  })

  test("the same holds for the plan the gate renders", async () => {
    const fetcher = (async (url: string | URL | Request) =>
      Response.json({ ok: true, plan: { status: "loaded", path: `${String(url).includes("r-1") ? "one" : "two"}.md`, markdown: "#" } })) as unknown as typeof fetch

    const seen: { asked: string; planFrom: string | null }[] = []
    function Probe({ id }: { id: string }): React.ReactNode {
      const plan = usePlan(id, true, fetcher)
      seen.push({ asked: id, planFrom: plan !== null && plan.status === "loaded" ? plan.path : null })
      return null
    }

    await render(<Probe id="r-1" />)
    await flush()
    expect(seen.at(-1)).toEqual({ asked: "r-1", planFrom: "one.md" })

    await render(<Probe id="r-2" />)
    const mismatched = seen.filter(
      (s) => s.planFrom !== null && !((s.asked === "r-1" && s.planFrom === "one.md") || (s.asked === "r-2" && s.planFrom === "two.md")),
    )
    expect(mismatched).toEqual([])
  })
})
