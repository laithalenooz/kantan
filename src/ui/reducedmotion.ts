/**
 * Whether to hold everything still.
 *
 * Its own module because every animated component needs it and it has a trap
 * in it that `CLAUDE.md` records: Motion's `useReducedMotion()` caches the
 * query in a **module-level global on its first call anywhere in the process**
 * and captures that in `useState`, so it answers whatever the first component
 * to call it saw, forever. Probed under happy-dom with the media feature set
 * to `reduce`: it returned `false`.
 *
 * So the media feature is read live as well, through `useSyncExternalStore`,
 * and either answer saying "reduce" is enough. A component that trusts Motion
 * alone keeps animating for someone who asked it not to.
 */

import { useSyncExternalStore } from "react"
import { useReducedMotion } from "motion/react"

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export const REDUCE_QUERY = "(prefers-reduced-motion: reduce)"

export function subscribeToReduceQuery(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {}
  const query = window.matchMedia(REDUCE_QUERY)
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

export function readReduceQuery(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false
  return window.matchMedia(REDUCE_QUERY).matches
}

export function readReduceQueryOnServer(): boolean {
  return false
}

/**
 * Whether to hold everything still.
 *
 * Motion's own hook is asked first, because it is the project's sanctioned
 * answer and it covers an environment with no `matchMedia` at all. It is not
 * trusted alone: it caches the query result in a module global on its first
 * call anywhere in the app and captures that in `useState`, so it answers
 * whatever the first component to call it saw, forever. Probed under happy-dom
 * with the media feature set to `reduce`: it returned `false`.
 *
 * So the media feature is also read live, through `useSyncExternalStore`, which
 * re-reads on mount and subscribes to changes. Either saying "reduce" is enough.
 */
export function usePrefersReducedMotion(): boolean {
  const cached = useReducedMotion()
  const live = useSyncExternalStore(subscribeToReduceQuery, readReduceQuery, readReduceQueryOnServer)
  return cached === true || live
}
