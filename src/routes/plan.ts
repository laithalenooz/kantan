/**
 * `GET /api/runs/:id/plan`: the plan a run dictated, for the gate to render.
 *
 * Moved from `src/server.ts` unchanged. `plannedPath` leaves with it and is
 * exported, because three other routes reuse its rule for a client-supplied
 * repo-relative path - relative, no `..`, no NUL - and a second copy of a
 * containment check is a second chance to get it wrong differently.
 *
 * The rule this module exists to hold: the plan is read from the path the log
 * **recorded**, never re-derived by convention. `planPathFor` in `src/run.ts`
 * builds it from a branch name and a date, so recomputing it here would mean a
 * second slugger and a date that can have moved on - and a gate pointed at a
 * file nothing wrote renders empty while the real plan sits beside it.
 */

import { stat } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"

import { requireUsableRepo } from "../git"
import { replay } from "../runlog"
import type { RouteContext } from "../http/context"
import { refuse } from "../http/guards"
import { inside, readInside } from "../http/readinside"
import { NO_SUCH_RUN, UNUSABLE_RUN_ID, runLogPathFor } from "../http/sse"

// --- The plan the gate renders ----------------------------------------------

/**
 * The most a plan file may be, read into memory and sent to a browser.
 *
 * The dimension is the file's size on disk, written by an agent in the user's
 * own repo, and the two directions are not symmetric. **No cap**: one `GET`
 * decides how much memory the server spends and how much the browser is asked
 * to render, and a plan is the one file in the repo an agent is told to create
 * from scratch - a loop that appended to it would be found this way.
 * **Capped**: a plan longer than this renders as `unreadable` with its size in
 * the message, which is a visible, correctable state rather than a lost one -
 * the file is still on disk and the path is in the answer.
 *
 * 1 MiB is roughly 150,000 words of markdown. Design §3.1's plan is a document
 * a human reads at a gate before approving it, so anything near this is already
 * a plan nobody will read.
 */
const MAX_PLAN_BYTES = 1024 * 1024

/**
 * What the gate needs to render, in the three shapes it already models.
 *
 * **Deliberately `PlanSource` from `src/ui/Gate.tsx`, field for field**, so the
 * shell passes this through instead of maintaining a translation table. Two
 * vocabularies for one three-state answer is how a card ends up stuck in a
 * state the server never meant - and this type is new, so there is nothing to
 * be compatible with except the component that consumes it.
 *
 * Why all three are a 200 and not a 404: a run can legitimately be parked at a
 * gate with no plan behind it. The plan prompt dictates a path, and an agent
 * that answers `ORCH: done` without writing one parks the run at a gate with
 * nothing to show (HANDOFF names the gate UI as where that surfaces). So "there
 * is no plan" is a **state of the run**, which the gate renders with Approve
 * disabled, rather than a request that failed. A 4xx here is reserved for a
 * request that cannot be answered at all: an unusable run id, a run with no
 * log, or a recorded path that does not sit inside the repo.
 *
 * `why` is prose for a human, because that is what the card renders. The
 * `undictated` shape carries none, exactly as the component declares it: the
 * gate owns that sentence, and a second copy here would be a second place for
 * it to drift.
 */
export type PlanSource =
  | { status: "loaded"; path: string; markdown: string }
  /** A path was dictated and its contents cannot be had: never written, since
   * deleted, not a file, not UTF-8, too large, outside the repo once its
   * symlinks are resolved, or a project whose repo has moved. */
  | { status: "unreadable"; path: string; why: string }
  /** No `phase` record carried a usable `planPath`, so the run never dictated
   * one - an older log, or a run that failed before its plan phase started. */
  | { status: "undictated" }

/**
 * The path a plan may be recorded at, or `null`.
 *
 * `planPath` arrives from a **log record**, which is a file on disk that a
 * person can edit and that an older or newer writer may have written
 * differently, so it is caller input in the same class as a run id - and the
 * check is `runLogPath`'s: refuse by construction rather than resolve and
 * compare. The dimension is the recorded string, enumerated:
 *
 * - **Empty.** Names nothing. The caller answers `undictated` for it before
 *   reaching here; refused again at this level so a future caller cannot join
 *   an empty path to the root and read the directory itself.
 * - **Absolute** (`/etc/passwd`, and on Windows a drive or a UNC path).
 *   Refused: the prompt dictates a path *relative to the repository root*, and
 *   `resolve(root, "/etc/passwd")` would discard the root entirely.
 * - **Containing a `..` segment** (`../../.ssh/id_rsa`, `docs/../../x`).
 *   Refused, which is cheap here: the machine dictates
 *   `docs/plans/<date>-<slug>.md`, so nothing legitimate contains one.
 *   `src/projects.ts`'s `reportPath` is the opposite case - there `..` is
 *   allowed because monorepo layouts need it - and this is why that decision
 *   belongs to each joiner rather than to a shared rule.
 * - **Containing a NUL.** Refused: it truncates a path at the syscall boundary,
 *   so what is checked and what is opened could differ.
 * - **A backslash.** Kept as an ordinary character on POSIX, where it is a
 *   legal filename byte, and rejected as a `..` segment on Windows by the
 *   normalisation `isAbsolute`/`resolve` do there. A blanket refusal would
 *   reject a legal POSIX path for a platform this tool is not running on.
 * - **Anything else.** Taken as written and joined to the repo root, with the
 *   containment check below as the second line of defence.
 */
export function plannedPath(recorded: string): string | null {
  if (recorded === "" || recorded.includes("\0")) return null
  if (isAbsolute(recorded)) return null
  // Split on both separators, so a Windows-style spelling cannot hide a `..`
  // segment from a POSIX split.
  if (recorded.split(/[/\\]/).includes("..")) return null
  return recorded
}

const PLAN_OUTSIDE_REPO = "refused: this run's log records a plan path that does not sit inside its repository"

/** What the log says about a run's plan: the project it belongs to and the last
 * `planPath` any `phase` record carried. One pass over the log, which is what
 * the stream route already costs per connection. The **last** one, because that
 * is how `src/run.ts` folds it when it rehydrates a run; they agree today
 * because every record that carries one carries the same value. */
async function plannedFor(path: string): Promise<{ projectPath: string | null; planPath: string | null }> {
  let projectPath: string | null = null
  let planPath: string | null = null
  for await (const record of replay(path)) {
    if (record.kind === "header") projectPath = record.projectPath
    if (record.kind === "phase" && record.planPath !== undefined) planPath = record.planPath
  }
  return { projectPath, planPath }
}

/**
 * The contents of the plan file the run dictated.
 *
 * Read from the path the **log** records and never re-derived by convention:
 * `planPathFor` builds it from the branch name and the date, so recomputing it
 * here would mean a second slugger and a date that can have moved on since the
 * run started - and a gate pointed at a file nothing wrote renders empty while
 * the real plan sits beside it.
 */
export async function readPlan(ctx: RouteContext, id: string): Promise<Response> {
  const log = runLogPathFor(id, ctx.runsDir)
  if (log === null) return refuse(400, UNUSABLE_RUN_ID)
  try {
    if (!(await stat(log)).isFile()) return refuse(404, NO_SUCH_RUN)
  } catch {
    return refuse(404, NO_SUCH_RUN)
  }

  const { projectPath, planPath } = await plannedFor(log)
  // An empty recorded path is undictated rather than refused, and it is a real
  // record rather than a hypothetical one: `src/run.ts` rehydrates a run with
  // `folded.planPath ?? ""`, so a run resumed from a log that never carried one
  // writes `planPath: ""` on its next phase record. It names no file either
  // way, and "the run never dictated a path" is what the gate shows for it.
  if (planPath === null || planPath === "") return planAnswer({ status: "undictated" })

  // Before anything touches the filesystem, so a traversal is refused rather
  // than attempted. Loud - a 400 - because a log recording a path outside its
  // own repository is either hand-edited or a bug, and neither should read as
  // "the plan is missing".
  const dictated = plannedPath(planPath)
  if (dictated === null || projectPath === null) return refuse(400, PLAN_OUTSIDE_REPO)

  // git's own answer for the root, so a project registered through a symlink
  // resolves to the directory the plan was actually written in, and so the
  // containment check below compares two canonical paths. A project whose repo
  // has moved or is no longer a repository is `unreadable` rather than a
  // refusal: the request was fine, and the gate's own state for "the plan
  // cannot be had" is exactly what that is.
  let root: string
  try {
    root = (await requireUsableRepo(projectPath)).root
  } catch (cause) {
    return planAnswer(unreadable(planPath, (cause as Error).message))
  }

  const joined = resolve(root, dictated)
  // Unreachable given `plannedPath`, and kept because the two read different
  // things: that one reads the recorded string, this one the result of joining
  // it. A future edit that loosened either alone would still meet this.
  if (!inside(joined, root)) return refuse(400, PLAN_OUTSIDE_REPO)

  const read = await readInside(root, joined, MAX_PLAN_BYTES)
  if (read.ok) return planAnswer({ status: "loaded", path: planPath, markdown: read.text })
  switch (read.why) {
    case "outside":
      // Loud, like the string check above: a log recording a path outside its
      // own repository is either hand-edited or a bug.
      return refuse(400, PLAN_OUTSIDE_REPO)
    case "missing":
      // The common case, and the one HANDOFF predicted: the agent answered
      // `ORCH: done` without writing the plan it was told to write.
      return planAnswer(
        unreadable(
          planPath,
          `${planPath} is the plan path this run dictated, and there is no file there. The agent ended its planning turn without writing one.`,
        ),
      )
    case "not-a-file":
      return planAnswer(unreadable(planPath, `${planPath} is not a file, so there is no plan to read.`))
    case "too-large":
      return planAnswer(
        unreadable(
          planPath,
          read.size === null
            ? `${planPath} is past the ${MAX_PLAN_BYTES} bytes a plan may be, so it is not rendered here.`
            : `${planPath} is ${read.size} bytes, past the ${MAX_PLAN_BYTES} a plan may be, so it is not rendered here. It is still on disk.`,
        ),
      )
    case "failed":
      return planAnswer(unreadable(planPath, read.message))
  }
}

/** The path the **log** recorded is what the gate prints, never the resolved
 * one: that is the path the prompt dictated and the one a human would look for,
 * and a resolved path would leak where a symlink inside their repo points. */
function unreadable(path: string, why: string): PlanSource {
  return { status: "unreadable", path, why }
}

/** No caching, as nothing else here is cached: a plan is rewritten when the
 * human sends feedback, and a cached one would show the previous round's. */
function planAnswer(plan: PlanSource): Response {
  return Response.json({ ok: true, plan }, { headers: { "Cache-Control": "no-store" } })
}
