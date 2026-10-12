/**
 * The React side of `live.ts`: effects that talk to the server and hand their
 * results back as state.
 *
 * Kept apart from `live.ts` so the fold and the transport stay renderless and
 * testable without a DOM, and kept apart from `App.tsx` so the races below are
 * tested rather than eyeballed. Every hook takes its transport as an argument
 * with a real default, which is what lets a test drive it.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import {
  act,
  fetchPlan,
  fetchTree,
  foldRun,
  openSession,
  subscribeRun,
  type Action,
  type RecordSource,
  type RunView,
  type TreePayload,
} from "./live.ts"
import type { PlanSource } from "./Gate.tsx"

/** A failed load, as prose the UI can print. `null` while it is going well. */
export type Failure = string | null

function reason(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * The project tree, after getting a session cookie.
 *
 * The cookie comes first and is not optional in dev: it rides on the server's
 * `GET /`, Vite serves its own `index.html`, so the browser never loads that
 * route and would hold no token for this one.
 */
export function useTree(fetcher: typeof fetch = fetch): {
  tree: TreePayload | null
  error: Failure
  reload: () => void
} {
  const [tree, setTree] = useState<TreePayload | null>(null)
  const [error, setError] = useState<Failure>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    // Discards a response that arrives after this effect was torn down, which
    // React's StrictMode produces on every mount in dev and a reload produces
    // whenever the user is faster than the server.
    let live = true
    void (async () => {
      try {
        await openSession(fetcher)
        const payload = await fetchTree(fetcher)
        if (live) {
          setTree(payload)
          setError(null)
        }
      } catch (cause) {
        if (live) setError(reason(cause))
      }
    })()
    return () => {
      live = false
    }
  }, [fetcher, nonce])

  return { tree, error, reload: useCallback(() => setNonce((n) => n + 1), []) }
}

/**
 * Follows one run, or nothing when `runId` is `null`.
 *
 * The view is cleared the moment `runId` changes rather than when the new
 * stream's first record arrives. Holding the old run's rows until then would
 * show one run's log under another run's heading - briefly, plausibly, and
 * wrongly - and the gap it leaves instead is the empty state the design already
 * draws.
 */
export function useRun(
  runId: string | null,
  open?: (url: string) => RecordSource,
): { view: RunView | null } {
  // The run the state belongs to is stored *with* it, and the match is checked
  // during render. Clearing in the effect instead is too late by one painted
  // frame, and that frame is dangerous rather than untidy: the Task 25 agent
  // reported that `Enter` on another task moves `aria-current` immediately, so
  // a bare `a` in that frame approves the plan still on screen - a different
  // task's plan - and starts a real implementation run on it.
  const [held, setHeld] = useState<{ runId: string; view: RunView } | null>(null)

  useEffect(() => {
    if (runId === null) {
      setHeld(null)
      return
    }
    const sub = subscribeRun(runId, (view) => setHeld({ runId, view }), open)
    return () => sub.close()
  }, [runId, open])

  return { view: held !== null && held.runId === runId ? held.view : null }
}

/**
 * The plan for the gate, fetched only when something is actually waiting at one.
 *
 * `want` gates the request because the plan is a file read on the server and
 * every other phase has no use for it. The path is deliberately not derived
 * here: `GET /api/runs/:id/plan` answers from the path the plan phase
 * *recorded*, so the gate shows the file the prompt dictated instead of one
 * this reader guessed by convention.
 */
export function usePlan(runId: string | null, want: boolean, fetcher: typeof fetch = fetch): PlanSource | null {
  // Keyed on the run, and checked during render, for the same reason as
  // `useRun`: the gate renders whatever this returns, and a plan belonging to
  // the previously selected task is the exact thing the human is being asked to
  // approve.
  const [held, setHeld] = useState<{ runId: string; plan: PlanSource } | null>(null)

  useEffect(() => {
    if (runId === null || !want) return
    let live = true
    void (async () => {
      const answer = await fetchPlan(runId, fetcher)
      if (live) setHeld({ runId, plan: answer })
    })()
    return () => {
      live = false
    }
  }, [runId, want, fetcher])

  if (runId === null || !want) return null
  return held !== null && held.runId === runId ? held.plan : null
}

/**
 * Sends an action and reports what came back.
 *
 * `pending` is per-hook rather than per-action because the four actions it
 * covers are mutually exclusive in the UI: a run parked at a gate offers
 * approve and send-back, and taking either one ends the park. It also returns
 * a promise, which is what `Gate.tsx` needs to keep its own button disabled
 * until the server has answered.
 */
export function useAction(
  runId: string | null,
  fetcher: typeof fetch = fetch,
): { send: (action: Action) => Promise<void>; pending: boolean; error: Failure } {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<Failure>(null)
  // A component unmounted mid-request must not set state, but the request
  // itself must still finish: it is a POST the server has already begun.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const send = useCallback(
    async (action: Action): Promise<void> => {
      if (runId === null) {
        // Nothing is selected, so there is no run to address. Reported rather
        // than thrown: a keyboard shortcut can reach this with an empty tree.
        setError("there is no run selected for that action")
        return
      }
      setPending(true)
      setError(null)
      try {
        await act(runId, action, fetcher)
      } catch (cause) {
        if (mounted.current) setError(reason(cause))
      } finally {
        if (mounted.current) setPending(false)
      }
    },
    [runId, fetcher],
  )

  return { send, pending, error }
}

/** Re-exported so `App.tsx` has one import for the whole data layer. */
export { foldRun }
