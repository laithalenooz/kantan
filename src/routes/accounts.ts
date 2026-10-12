/**
 * `GET /api/accounts`: where each Claude account's rate-limit windows stood,
 * the last time kantan saw.
 *
 * Thin over `src/accounts.ts`, which holds the reading and the honesty rules.
 * This route's own job is the two things only the server knows: which profiles
 * the **store** has - so an account that has never run still appears, instead
 * of a page that cannot tell "nothing to report" from "no such account" - and
 * which profiles a run is driving **right now**, which is what lets a reading
 * be called `live` rather than merely recent.
 *
 * `liveRunIds` is asked at the moment of the request, not captured at launch,
 * for the reason `ServerOptions` gives: liveness is a fact about this instant.
 */

import { loadProjects } from "../projects"
import { accountUsage } from "../accounts"
import type { RouteContext } from "../http/context"
import { projectOfRun } from "./runs"

export async function readAccounts(ctx: RouteContext): Promise<Response> {
  /* The profiles the store knows. A launch without a store cannot say, and
     answers only what the logs hold rather than claiming the set is empty. */
  let profiles: Array<string | null> = []
  let byPath = new Map<string, string | null>()
  if (ctx.projectsFile !== null) {
    try {
      const registered = await loadProjects(ctx.projectsFile)
      byPath = new Map(registered.map((p) => [p.path, p.configDir ?? null]))
      profiles = [...new Set(registered.map((p) => p.configDir ?? null))]
    } catch {
      // A damaged store is not this route's business; the logs still answer.
    }
  }

  /* Which profiles are being driven. A live run names a project, and the store
     says which profile that project bills to - so the mapping goes through the
     store rather than through the run's own header, which records the profile
     it *started* with and would disagree after a switch. */
  const live: Array<string | null> = []
  if (ctx.liveRunIds !== null) {
    for (const id of ctx.liveRunIds()) {
      const path = await projectOfRun(id, ctx.runsDir)
      if (path !== null && byPath.has(path)) live.push(byPath.get(path) ?? null)
    }
  }

  const accounts = await accountUsage({ runsDir: ctx.runsDir, profiles, liveProfiles: live })
  return Response.json({ ok: true, accounts }, { headers: { "Cache-Control": "no-store" } })
}
