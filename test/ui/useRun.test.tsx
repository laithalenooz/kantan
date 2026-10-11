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

describe("usePlan", () => {
  test("asks for nothing until something is waiting at a gate", async () => {
    const { fetcher, urls } = stub({
      "/api/runs/r-1/plan": () => Response.json({ status: "undictated" }),
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
        return Response.json({ status: "loaded", path: "slow.md", markdown: "# slow" })
      }
      return Response.json({ status: "loaded", path: "fast.md", markdown: "# fast" })
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
