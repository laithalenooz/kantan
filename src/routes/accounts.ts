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
import { accountsFile, addProfile, discoverProfiles, loadProfiles, profileDir } from "../profiles"
import type { AccountKind, Profile } from "../profiles"
import type { RouteContext } from "../http/context"
import { badBody, nonEmptyString, parseBody, readBody } from "../http/body"
import { noStore, refuse } from "../http/guards"
import { projectOfRun } from "./runs"

/** The registry, or `[]` when there is no store or it cannot be read. */
export async function registeredProfiles(ctx: RouteContext): Promise<Profile[]> {
  if (ctx.projectsFile === null) return []
  try {
    return await loadProfiles(accountsFile(ctx.projectsFile))
  } catch {
    /* A damaged registry must not take the tree down with it. The add route
       below answers the real error, where someone is looking at it. */
    return []
  }
}

const ACCOUNT_KEYS = ["kind", "label", "configDir"] as const

/**
 * `POST /api/accounts`: records an account kantan may run under.
 *
 * This is what "Add another account" needed. The control was written in two
 * panels and hidden in both, because `onAddAccount` was a prop nothing passed -
 * and nothing could pass it, since there was nowhere to put the answer.
 *
 * The store does the validating and its message is forwarded, because that
 * message is the useful part: it says why a relative folder cannot work rather
 * than that a field was wrong. This route's own 400 is only for a body that is
 * not three strings, which the store would describe less well.
 */
export async function addAccount(req: Request, ctx: RouteContext): Promise<Response> {
  if (ctx.projectsFile === null) return noStore("record an account")

  const body = await readBody(req)
  if ("refused" in body) return body.refused
  const parsed = parseBody(body.text, ACCOUNT_KEYS)
  if ("refused" in parsed) return parsed.refused

  const kind = parsed.fields["kind"]
  const label = nonEmptyString(parsed.fields["label"])
  if ((kind !== "personal" && kind !== "work") || label === null) {
    return badBody(
      ACCOUNT_KEYS,
      'an account needs a kind of "personal" or "work", a name, and the Claude config folder it bills to',
    )
  }

  let configDir: string
  try {
    // The store's own rule, asked here so the 400 arrives before the write and
    // carries its sentence rather than a generic one.
    configDir = profileDir(parsed.fields["configDir"], "that account")
  } catch (cause) {
    return refuse(400, `refused: ${(cause as Error).message}`)
  }

  try {
    await addProfile(accountsFile(ctx.projectsFile), { kind: kind satisfies AccountKind, label, configDir })
  } catch (cause) {
    return refuse(400, `refused: ${(cause as Error).message}`)
  }
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } })
}

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

  /* The registry too, or an account the user added but has never run with
     reports nothing - and a page cannot tell "nothing to report" from "no such
     account" unless the account is listed. That was half of "why are other
     accounts not detected". */
  for (const profile of await registeredProfiles(ctx)) {
    if (!profiles.includes(profile.configDir)) profiles.push(profile.configDir)
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
  return Response.json(
    { ok: true, accounts, found: await discoverProfiles(ctx.homeDir) },
    { headers: { "Cache-Control": "no-store" } },
  )
}
