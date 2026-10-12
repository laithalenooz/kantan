/**
 * `POST /api/detect`: what kantan can learn about a folder before anyone
 * registers it.
 *
 * Moved from `src/server.ts` unchanged. Thin by design - `src/detect.ts` holds
 * the reading, and this is the one route whose whole job is to hand a path to
 * it and read the store so the answer can say "kantan already tracks this".
 *
 * **Read-only, and that is what makes an arbitrary path acceptable here.** It
 * is the one route that deliberately does not require a registered project,
 * because nothing can be registered before it is checked.
 */

import { detect } from "../detect"
import { loadProjects } from "../projects"
import type { RouteContext } from "../http/context"
import { badBody, parseBody, readBody } from "../http/body"

const DETECT_KEYS = ["path"] as const

/**
 * Looks at a folder and says what it is, without touching it.
 *
 * **Read-only, and that is what makes an arbitrary path acceptable here.** It
 * is the one route that takes a path from the client which is deliberately
 * *not* required to be registered - that is the whole point, since nothing can
 * be registered before it is checked - and it answers only what `git`, a
 * manifest and `docs/features` say. The same caller can already hand any path
 * to `POST /api/projects`, which registers it; this says less and changes
 * nothing.
 *
 * A `200` even for a folder that is not a repository: "this is not a usable
 * git repository" is the **answer**, carried in `checks` as a sentence someone
 * can read, not a refusal of the question. That is the difference `AddRepo`
 * draws between `phase: "done", usable: false` and `phase: "unknown"` - the
 * second is the probe itself failing, which must not block the button. A 4xx
 * here would be read as the second and would be the first.
 */
export async function detectRepoPath(req: Request, ctx: RouteContext): Promise<Response> {
  const body = await readBody(req)
  if ("refused" in body) return body.refused
  const parsed = parseBody(body.text, DETECT_KEYS)
  if ("refused" in parsed) return parsed.refused

  const path = parsed.fields["path"]
  if (typeof path !== "string") {
    return badBody(DETECT_KEYS, "a check names the folder to look at, which must be a string")
  }

  /* The store is read so the check can say "kantan already tracks this", which
     is the one thing that makes a perfectly good repository unregisterable.
     A launch without a store simply cannot say, and says nothing rather than
     claiming the path is free. */
  let registered: string[] = []
  if (ctx.projectsFile !== null) {
    try {
      registered = (await loadProjects(ctx.projectsFile)).map((p) => p.path)
    } catch {
      // A damaged store is not this route's business, and the rest of the
      // answer is still worth having.
    }
  }

  return Response.json(await detect(path, registered), { headers: { "Cache-Control": "no-store" } })
}
