/**
 * `POST /api/test`: runs a project's test command once, without starting a run.
 *
 * Moved from `src/server.ts` unchanged. The decision worth keeping in view is
 * that it takes the command **from the body**, not the store: the control it
 * serves exists to prove a command works *before* it is trusted, so it has to
 * run the string in the field. Running the stored one instead would answer a
 * question nobody asked and label it with the command on screen, which is the
 * one reading that could get a bad command saved.
 *
 * It grants no privilege the caller did not have: anything holding the token
 * can PATCH any `testCmd` and start a run, through the same `sh -c`.
 *
 * Since `AddRepo`'s "Run it once" was wired, the project need not be
 * registered - but an unregistered path has to pass `requireUsableRepo`, the
 * same gate registration uses. See `runTestCommand` for why that is the whole
 * of the widening.
 */

import { defaults, loadProjects } from "../projects"
import type { Project } from "../projects"
import { requireUsableRepo } from "../git"
import { runTests } from "../testrun"
import type { RouteContext } from "../http/context"
import { badBody, nonEmptyString, parseBody, readBody } from "../http/body"
import { noStore, refuse } from "../http/guards"
import { liveRunIdFor } from "./runs"

const TEST_KEYS = ["projectPath", "testCmd"] as const

/** A trial run is bounded tighter than a run's own verification: somebody is
 * watching it, and a suite that takes ten minutes is not what this control is
 * for. The command keeps running to completion either way - `runTests` caps
 * what it *keeps*, not what the command does - so the bound here is only on
 * how long the request waits. */
const TRIAL_TIMEOUT_MS = 3 * 60 * 1000

/**
 * Runs a test command once and answers what it did. No run, no branch, no tick.
 *
 * **It takes the command from the body rather than the store**, and that is the
 * one decision here worth defending. The control it serves exists to prove a
 * command works *before* it is trusted, so it has to run the string in the
 * field - which may not be the saved one yet. Running the stored command
 * instead would answer a question nobody asked and label it with the command on
 * screen, which is the one reading that could get a bad command saved.
 *
 * It grants no privilege the caller did not already have: anything holding the
 * token can `PATCH /api/projects` with any `testCmd` and then start a run,
 * which runs it through the same `sh -c`. The guard that matters is the one on
 * every acting route - same-origin, token, `SameSite=Strict` - not a filter on
 * the string, and a filter is exactly what would give the wrong impression that
 * this is a sandbox.
 *
 * Refused while a run is in flight in the repository, like the task routes: the
 * live run may be mid-verification in that same working tree, and two suites
 * writing one tree produces a failure neither of them caused.
 */
export async function runTestCommand(req: Request, ctx: RouteContext): Promise<Response> {
  const projectsFile = ctx.projectsFile
  if (projectsFile === null) return noStore("run a test command")

  const body = await readBody(req)
  if ("refused" in body) return body.refused
  const parsed = parseBody(body.text, TEST_KEYS)
  if ("refused" in parsed) return parsed.refused

  const projectPath = nonEmptyString(parsed.fields["projectPath"])
  const testCmd = nonEmptyString(parsed.fields["testCmd"])
  if (projectPath === null || testCmd === null) {
    return badBody(TEST_KEYS, "running a test needs the project and the command, each a non-empty string")
  }
  // A blank is refused above by `nonEmptyString`, and this catches the rest of
  // it: `sh -c "   "` exits 0, and a pass from nothing is the one answer no
  // reader could tell from a real one.
  if (testCmd.trim() === "") {
    return refuse(400, 'refused: that command is only whitespace, and `sh -c "  "` exits 0 - which would read as a pass')
  }

  const registered = await loadProjects(projectsFile)
  const known = registered.find((p) => p.path === projectPath)

  /**
   * An unregistered path is allowed, **and `requireUsableRepo` is the only
   * thing that allows it** - the same gate registration uses, so the set of
   * directories a trial can run in is exactly the set a project can be
   * registered at and not one path more.
   *
   * This is what makes `AddRepo`'s "Run it once" work: that button exists to
   * prove a command before the project is saved, so by construction there is
   * no record to find. It grants no capability the caller lacked - anything
   * holding the token can register a usable repo and then run a command in it,
   * through this same `sh -c` - so what it removes is a round trip, not a
   * boundary. `POST /api/detect`'s precedent is deliberately *not* the
   * argument here: detect is read-only and running a command is not.
   *
   * Its refusals are forwarded as written, because they are the whole reason
   * this is not a `stat`: `src/git.ts` names the deepest ancestor that does
   * exist, and that sentence is what locates a typo. The failure `AddRepo` was
   * built for was four characters wrong in a home directory, answered with a
   * sentence about git.
   */
  let project: Project
  if (known !== undefined) {
    project = known
  } else {
    try {
      /**
       * **Both gates, in registration's order**, and the order is the
       * load-bearing part rather than a style choice.
       *
       * `defaults` first, because it owns the rule that a path must be
       * absolute - and `requireUsableRepo` does not. Probed: it *accepts*
       * `"."`, resolving it to whatever directory the server was launched
       * from, so validating with it alone would let `{projectPath: "."}` run a
       * command in kantan's own checkout. `registerProject` refuses that, and
       * a trial that accepted what registration refuses would have widened
       * where a command can run - which is the one thing this route may not do.
       *
       * Then `repo.root` rather than the string that arrived, for the reason
       * registration keeps it: the store is keyed on `path` and normalises
       * lexically only, so two symlinked spellings of one repo are one
       * project, and the live-run check below compares against the canonical
       * spelling a run's log records.
       */
      const candidate = defaults({ path: projectPath, testCmd })
      const repo = await requireUsableRepo(candidate.path)
      project = { ...candidate, path: repo.root }
    } catch (cause) {
      return refuse(400, `refused: ${(cause as Error).message}`)
    }
  }

  const live = await liveRunIdFor(ctx, project.path)
  if (live !== null) {
    return refuse(
      409,
      `refused: run ${live} is in flight in this repository, so nothing was run. It may be verifying its own work in this same working tree right now, and two suites writing one tree produce a failure neither of them caused. Wait for it, or stop it.`,
    )
  }

  let outcome
  try {
    // The command from the body, on this project's path. `runTests` reads
    // `testCmd` off what it is handed, so the trial command is passed as a
    // record of its own rather than by writing to the store first - nothing is
    // saved by pressing a button that says "run it".
    outcome = await runTests({ ...project, testCmd }, { timeoutMs: TRIAL_TIMEOUT_MS })
  } catch (cause) {
    // `runTests` rejects only when the command could not be started at all,
    // which is a misconfigured project rather than a test result.
    return refuse(400, `refused: ${(cause as Error).message}`)
  }

  return Response.json(
    {
      ok: true,
      testCmd,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      timedOut: outcome.timedOut,
      // The tail of each stream, which is where every runner puts its summary.
      // Sent so the panel can show what happened rather than only a number.
      stdout: outcome.stdout,
      stderr: outcome.stderr,
    },
    { headers: { "Cache-Control": "no-store" } },
  )
}
