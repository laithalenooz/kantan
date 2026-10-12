/**
 * Matching one `METHOD /path` key against one route pattern.
 *
 * **Only the matchers.** The plan for this refactor
 * (`docs/plans/2026-10-12-server-factoring.md`) listed `matchRoute` and
 * `handle` here too, and that was written without checking what they read:
 * both reach for `ROUTES` and `TOKEN_EXEMPT`, so moving them would mean either
 * passing the tables in - a body rewrite, which the plan's own rule forbids in
 * the same change - or importing them back from `src/server.ts`, which makes
 * the module graph a ring. They are *about the table*, so they stay with it,
 * and the plan has been corrected to say so.
 *
 * What is here is the part worth isolating anyway: two pure string functions
 * with no state and a traversal argument to make, which can now be tested
 * without a server or a table.
 */

/** A key with a `:name` segment in it. `/:` and not `:`, so an id that merely
 * contains a colon is not mistaken for a pattern. */
export function isPattern(key: string): boolean {
  return key.includes("/:")
}

/**
 * The `:name` values if `key` matches `pattern`, otherwise `null`.
 *
 * A matcher is a guard that decides whether to skip a route, so what a `:name`
 * segment may hold is enumerated rather than sampled. The dimension is one
 * path segment of an already-parsed pathname, and the two directions cost
 * differently: over-accepting hands a string to `runLogPath`, over-rejecting
 * costs a 404 on a path nothing generates. Hence: exactly one segment, never
 * empty, never decoded.
 *
 * - `/a/b` cannot be one segment, so a two-segment id does not match.
 * - `..` and `.` never arrive: the URL parser resolves dot segments, and turns
 *   a backslash into a slash, before dispatch sees the pathname.
 * - `..%2F..%2Fetc%2Fpasswd` arrives whole and stays whole, because nothing
 *   decodes it. That is why `%2F` cannot put back the separator the parser
 *   just resolved away, and why `runLogPath` sees a filename rather than a
 *   path. Decoding here is the single edit that would turn this into a
 *   traversal.
 * - An empty segment (`//`) survives URL parsing and is refused, which spends
 *   a 404 rather than asking `runLogPath` to reject the empty id.
 */
export function matchPattern(pattern: string, key: string): Record<string, string> | null {
  // Splitting the whole key means segment 0 carries the method, so a method
  // mismatch fails as an ordinary segment mismatch.
  const want = pattern.split("/")
  const got = key.split("/")
  if (want.length !== got.length) return null

  const params: Record<string, string> = {}
  for (const [i, segment] of want.entries()) {
    const seen = got[i]
    if (seen === undefined) return null
    if (!segment.startsWith(":")) {
      if (segment !== seen) return null
      continue
    }
    if (seen === "") return null
    params[segment.slice(1)] = seen
  }
  return params
}
