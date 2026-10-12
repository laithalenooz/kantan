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
 */

import { loadProjects } from "../projects"
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
  const project = registered.find((p) => p.path === projectPath)
  if (project === undefined) return refuse(404, "refused: that project is not registered")

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
