/**
 * The task-file routes: draft a new one, propose for an existing one, add
 * tasks, remove one.
 *
 * Moved from `src/server.ts` unchanged. These four are together because they
 * share the thing that makes them delicate: each writes into a file inside the
 * user's own repository, and three of them commit it.
 *
 * The rule they share, and the one place it differs:
 *
 * - **A run in flight refuses the three writers**, because the checkout is on
 *   that run's own `orch/<task>` branch and `returnToBase` would take the
 *   change back out of the working tree when the run finished - after a
 *   surface had said it landed.
 * - **Proposing is allowed during a run**, because it writes nothing and
 *   commits nothing, so none of those reasons apply. Refusing would make the
 *   screen unusable for as long as a run takes, for a call whose whole output
 *   is text on a page.
 *
 * `draftFeatureFile` answers a *warning* where the others refuse, and that is
 * deliberate too: a draft that cannot be committed still exists, while a
 * removal that cannot be committed has already changed a file the user can see.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { draftFeature, proposeTasks } from "../draft"
import type { Draft } from "../draft"
import { appendTasksToFile, readFeature, removeTaskFromFile } from "../featurefile"
import type { AppendResult, RemoveResult } from "../featurefile"
import { commitPaths, requireUsableRepo } from "../git"
import type { Repo } from "../git"
import { loadProjects } from "../projects"
import type { RouteContext } from "../http/context"
import { badBody, nonEmptyString, parseBody, readBody } from "../http/body"
import { noStore, refuse } from "../http/guards"
import { inside } from "../http/readinside"
import { plannedPath } from "./plan"
import { liveRunIdFor } from "./runs"

const FEATURE_KEYS = ["projectPath", "text"] as const

const REMOVE_TASK_KEYS = ["projectPath", "featureFile", "taskRef"] as const

const APPEND_TASK_KEYS = ["projectPath", "featureFile", "texts"] as const

const PROPOSE_KEYS = ["projectPath", "featureFile", "text"] as const

/** How many tasks one call may add, and how long each may be. A bound rather
 * than a guess at intent: the body is JSON from a page, and `appendTasks`
 * writes a line per text into a file in someone's repository. */
const MAX_NEW_TASKS = 50

const MAX_TASK_CHARS = 2000

/**
 * Drafts `docs/features/<slug>.md` from a description, and writes it.
 *
 * This closes the only gap between registering a repository and having
 * something to run. kantan's whole input is a markdown task file, and until
 * now the UI could show you a project with no task file and offer nothing -
 * you had to leave, open an editor, and learn the format. `src/draft.ts` was
 * built for exactly this (design §3.5.1) and nothing called it.
 *
 * Three things this route owns, which the drafting module deliberately does
 * not:
 *
 * - **Where it goes.** `draftFeature` returns a repo-relative path from a
 *   regex slug of the title it generated, never from the model's own words, so
 *   the model cannot steer the write out of `docs/features/`. This resolves
 *   that against the registered project's root and refuses anything that
 *   escapes it anyway, because a defence that is only in the other file is one
 *   edit away from gone.
 * - **Not clobbering.** An existing file is a 409, not an overwrite. The whole
 *   point of the file is that a human curates it; a draft that silently
 *   replaced one would destroy the backlog it was asked to add to.
 * - **Spending money.** This calls the CLI on Haiku. It is one short
 *   single-turn call, and it is additive - design §3.5.1 says to delete the
 *   call rather than debug it under pressure - but it is still a spend the
 *   caller should know about, which is why the failure says which model it was.
 */
/**
 * Removes one task from one task file.
 *
 * The order of the guards is the whole design, because the last of them has to
 * run **before** any bytes move:
 *
 * 1. The body's keys, by the names this route takes.
 * 2. The project, by its stored spelling - a path not in the store is not a
 *    project this server writes into.
 * 3. The file, read through `plannedPath`'s rules: relative, no `..`, no NUL,
 *    and then checked for containment after joining. A task file is a path the
 *    *client* supplies, so this is the one input here that a traversal could
 *    ride in on.
 * 4. **No run in flight in this repository**, and this one is a 409 rather
 *    than the warning `draftFeatureFile` answers with. The two differ because
 *    what is at stake differs. A draft that cannot be committed still exists -
 *    the caller got the thing they asked for, untracked. A removal that cannot
 *    be committed has already changed a file the user can see, on a checkout
 *    that is on the run's own `orch/<task>` branch, and `returnToBase` at the
 *    end of that run would then restore the task as if nothing happened -
 *    after the UI had said it was gone. Worse, the run may be *working through
 *    that very file*: `tickCheckbox` commits a tick into it, and a removal
 *    landing between a tick and its commit is a conflict in the user's repo
 *    with no surface to explain it. So nothing is written at all.
 *
 * The write itself re-reads and re-resolves by ref - see `removeTaskFromFile` -
 * so a human editing the markdown in the same second loses nothing.
 */
export async function removeFeatureTask(req: Request, ctx: RouteContext): Promise<Response> {
  const projectsFile = ctx.projectsFile
  if (projectsFile === null) return noStore("remove a task")

  const body = await readBody(req)
  if ("refused" in body) return body.refused
  const parsed = parseBody(body.text, REMOVE_TASK_KEYS)
  if ("refused" in parsed) return parsed.refused

  const projectPath = nonEmptyString(parsed.fields["projectPath"])
  const featureFile = nonEmptyString(parsed.fields["featureFile"])
  const taskRef = nonEmptyString(parsed.fields["taskRef"])
  if (projectPath === null || featureFile === null || taskRef === null) {
    return badBody(
      REMOVE_TASK_KEYS,
      "removing a task needs the project, the task file it is in and the task's ref, each a non-empty string",
    )
  }

  const registered = await loadProjects(projectsFile)
  const project = registered.find((p) => p.path === projectPath)
  if (project === undefined) return refuse(404, "refused: that project is not registered")

  const relative = plannedPath(featureFile)
  if (relative === null) return refuse(400, TASK_FILE_OUTSIDE_REPO)
  const target = resolve(project.path, relative)
  if (!inside(target, project.path)) return refuse(400, TASK_FILE_OUTSIDE_REPO)

  // Before the read, let alone the write. See the docblock.
  const live = await liveRunIdFor(ctx, project.path)
  if (live !== null) {
    return refuse(
      409,
      `refused: run ${live} is in flight in this repository, so nothing was removed. The checkout is on that run's own branch, and a removal committed there would come back the moment the run returns to your base branch - after kantan had told you the task was gone. The run may also be working through this very file. Stop the run, or wait for it, then remove the task.`,
    )
  }

  let result: RemoveResult
  try {
    result = await removeTaskFromFile(await readFeature(target), taskRef)
  } catch (cause) {
    const why = (cause as NodeJS.ErrnoException).code === "ENOENT"
      ? `refused: ${relative} is not a file in this project`
      : `refused: ${(cause as Error).message}`
    // 404 for a file that is not there, 409 for a ref that is not in it: the
    // first is a request about nothing, the second is a request about a real
    // file whose contents disagree with the caller - most often because the
    // tree on screen is older than the markdown on disk.
    return refuse((cause as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 409, why)
  }

  // Committed for the same reason the draft is: kantan changed a file inside
  // someone's repository, and leaving that change loose in their working tree
  // is the inconsistency. A failed commit is a warning on the 200, not a 5xx -
  // the task is already gone from the file the caller asked about, and a
  // rejecting pre-commit hook must not turn that into an error that invites a
  // retry against a file the first call already changed.
  let repo: Repo
  try {
    repo = await requireUsableRepo(project.path)
  } catch (cause) {
    return refuse(400, (cause as Error).message)
  }
  const commitWarning = await commitPaths(repo, {
    subject: `chore: remove ${taskRef} from ${relative}`,
    body: `The task read "${result.removed}". Removed through kantan at a human's request; it had not been run.`,
    paths: [relative],
  })

  const warnings = [result.warning, commitWarning].filter((w): w is string => w !== null)
  return Response.json(
    {
      ok: true,
      featureFile: relative,
      taskRef,
      removed: result.removed,
      ...(warnings.length === 0 ? {} : { warnings }),
    },
    { headers: { "Cache-Control": "no-store" } },
  )
}

/**
 * Adds tasks to a task file that already exists.
 *
 * The guards are `removeFeatureTask`'s, in the same order and for the same
 * reasons, with one difference worth naming: **this is also refused while a run
 * is in flight**, even though adding a task takes nothing away. The reason is
 * the commit, not the edit. A run holds the checkout on its own `orch/<task>`
 * branch, so the commit would land there and `returnToBase` would take the new
 * tasks out of the working tree when the run finished - the user would watch
 * tasks they just added disappear. `POST /api/features` answers a warning
 * instead of refusing because a *drafted file* survives uncommitted; tasks
 * appended into a file the run may also be rewriting do not survive as
 * cleanly, and a conflict in someone's repo has no surface here to explain it.
 *
 * `texts` carry no refs. The server numbers them against the bytes on disk,
 * because the human may have edited the file since they were drafted - see
 * `appendTasksToFile`.
 */
export async function appendFeatureTasks(req: Request, ctx: RouteContext): Promise<Response> {
  const projectsFile = ctx.projectsFile
  if (projectsFile === null) return noStore("add tasks")

  const body = await readBody(req)
  if ("refused" in body) return body.refused
  const parsed = parseBody(body.text, APPEND_TASK_KEYS)
  if ("refused" in parsed) return parsed.refused

  const projectPath = nonEmptyString(parsed.fields["projectPath"])
  const featureFile = nonEmptyString(parsed.fields["featureFile"])
  const raw = parsed.fields["texts"]
  if (projectPath === null || featureFile === null || !Array.isArray(raw)) {
    return badBody(
      APPEND_TASK_KEYS,
      "adding tasks needs the project, the task file to add to, and `texts`: an array of what each task says",
    )
  }
  if (raw.length > MAX_NEW_TASKS) {
    return refuse(400, `refused: ${raw.length} tasks in one call is more than the ${MAX_NEW_TASKS} this route takes`)
  }
  // Every element, by its own type, before anything is trimmed: a number or a
  // nested object in this array is a caller bug, and silently stringifying it
  // would write `[object Object]` into someone's backlog.
  const texts: string[] = []
  for (const [at, one] of raw.entries()) {
    if (typeof one !== "string") {
      return refuse(400, `refused: texts[${at}] is ${describeValue(one)}; every task must be a string`)
    }
    if (one.length > MAX_TASK_CHARS) {
      return refuse(400, `refused: texts[${at}] is ${one.length} characters, over the ${MAX_TASK_CHARS} limit for one task`)
    }
    // A task is a line. A newline in one would split it into a task and some
    // prose, and the prose would read as a continuation of it.
    if (/[\r\n]/.test(one)) {
      return refuse(400, `refused: texts[${at}] contains a line break, and a task is one line`)
    }
    texts.push(one)
  }
  if (texts.every((t) => t.trim() === "")) {
    return refuse(400, "refused: every task was blank, so there was nothing to add")
  }

  const registered = await loadProjects(projectsFile)
  const project = registered.find((p) => p.path === projectPath)
  if (project === undefined) return refuse(404, "refused: that project is not registered")

  const relative = plannedPath(featureFile)
  if (relative === null) return refuse(400, TASK_FILE_OUTSIDE_REPO)
  const target = resolve(project.path, relative)
  if (!inside(target, project.path)) return refuse(400, TASK_FILE_OUTSIDE_REPO)

  const live = await liveRunIdFor(ctx, project.path)
  if (live !== null) {
    return refuse(
      409,
      `refused: run ${live} is in flight in this repository, so nothing was added. The checkout is on that run's own branch, and tasks committed there would come back out of your working tree when the run returns to your base branch. Stop the run, or wait for it, then add the tasks.`,
    )
  }

  let result: AppendResult
  try {
    result = await appendTasksToFile(await readFeature(target), texts)
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    return refuse(
      code === "ENOENT" ? 404 : 409,
      code === "ENOENT" ? `refused: ${relative} is not a file in this project` : `refused: ${(cause as Error).message}`,
    )
  }

  let repo: Repo
  try {
    repo = await requireUsableRepo(project.path)
  } catch (cause) {
    return refuse(400, (cause as Error).message)
  }
  const commitWarning = await commitPaths(repo, {
    subject: `chore: add ${result.refs.join(", ")} to ${relative}`,
    body: `${result.refs.length} task${result.refs.length === 1 ? "" : "s"} added through kantan at a human's request. None has been run or verified.`,
    paths: [relative],
  })

  const warnings = [result.warning, commitWarning].filter((w): w is string => w !== null)
  return Response.json(
    {
      ok: true,
      featureFile: relative,
      refs: result.refs,
      ...(warnings.length === 0 ? {} : { warnings }),
    },
    { headers: { "Cache-Control": "no-store" } },
  )
}

/** What a value is, for a refusal that names it without echoing it back. */
function describeValue(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "an array" : typeof value
}

/**
 * Proposes tasks for a file that already exists, and writes nothing.
 *
 * The guards are the task routes', minus one: **a run in flight is fine here.**
 * Nothing is written and nothing is committed, so the reasons the other three
 * refuse - a commit landing on the run's branch, two writers in one file, a
 * suite in the same working tree - do not apply. Refusing anyway would make the
 * screen unusable for exactly as long as a run takes, for a call whose whole
 * output is text on a page the human then chooses from.
 *
 * It reads the file so the proposals fit what is there. That read is why the
 * containment check still runs: the path comes from the client.
 */
export async function proposeFeatureTasks(req: Request, ctx: RouteContext): Promise<Response> {
  const projectsFile = ctx.projectsFile
  if (projectsFile === null) return noStore("propose tasks")

  const body = await readBody(req)
  if ("refused" in body) return body.refused
  const parsed = parseBody(body.text, PROPOSE_KEYS)
  if ("refused" in parsed) return parsed.refused

  const projectPath = nonEmptyString(parsed.fields["projectPath"])
  const featureFile = nonEmptyString(parsed.fields["featureFile"])
  const text = nonEmptyString(parsed.fields["text"])
  if (projectPath === null || featureFile === null || text === null) {
    return badBody(
      PROPOSE_KEYS,
      "proposing tasks needs the project, the task file they are for, and a description of the work",
    )
  }

  const registered = await loadProjects(projectsFile)
  const project = registered.find((p) => p.path === projectPath)
  if (project === undefined) return refuse(404, "refused: that project is not registered")

  const relative = plannedPath(featureFile)
  if (relative === null) return refuse(400, TASK_FILE_OUTSIDE_REPO)
  const target = resolve(project.path, relative)
  if (!inside(target, project.path)) return refuse(400, TASK_FILE_OUTSIDE_REPO)

  let existing: string
  try {
    existing = (await readFeature(target)).src
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    return refuse(code === "ENOENT" ? 404 : 400, `refused: ${(cause as Error).message}`)
  }

  let tasks: string[]
  try {
    tasks = await proposeTasks(existing, text, ctx.ask)
  } catch (cause) {
    // The model's failures are the caller's to read, as the drafter's are: an
    // empty reply, a reply with nothing task-shaped in it. 502, because the
    // request was fine and something upstream was not.
    return refuse(502, `the tasks could not be drafted: ${(cause as Error).message}`)
  }

  return Response.json(
    { ok: true, featureFile: relative, tasks },
    { headers: { "Cache-Control": "no-store" } },
  )
}

export const TASK_FILE_OUTSIDE_REPO = "refused: that task file does not sit inside the project"

export async function draftFeatureFile(req: Request, ctx: RouteContext): Promise<Response> {
  const projectsFile = ctx.projectsFile
  if (projectsFile === null) return noStore("draft a feature file")

  const body = await readBody(req)
  if ("refused" in body) return body.refused
  const parsed = parseBody(body.text, FEATURE_KEYS)
  if ("refused" in parsed) return parsed.refused

  const projectPath = nonEmptyString(parsed.fields["projectPath"])
  const text = nonEmptyString(parsed.fields["text"])
  if (projectPath === null || text === null) {
    return badBody(FEATURE_KEYS, "a draft needs the project it belongs to and a description of the work, each a non-empty string")
  }

  const registered = await loadProjects(projectsFile)
  const project = registered.find((p) => p.path === projectPath)
  // Keyed on the stored spelling, as every other lookup is: a path that is not
  // in the store is not a project this server will write into.
  if (project === undefined) return refuse(404, "refused: that project is not registered")

  let draft: Draft
  try {
    draft = await draftFeature(text, ctx.ask)
  } catch (cause) {
    // The model's failures are the caller's to read: an empty reply, a title
    // that slugs to nothing, a draft its own parser cannot round-trip.
    return refuse(502, `the draft could not be written: ${(cause as Error).message}`)
  }

  const target = resolve(project.path, draft.path)
  if (!inside(target, project.path)) {
    return refuse(500, "refused: the drafted path escaped the project, which should be impossible")
  }

  try {
    await mkdir(dirname(target), { recursive: true })
    // `wx`: create, and fail if it is already there. Not a stat-then-write,
    // which races against anything else writing the same slug.
    await writeFile(target, draft.markdown, { flag: "wx" })
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
      return refuse(409, `${draft.path} already exists in this project, so nothing was written. Open it and add the task by hand, or describe the work differently so it drafts under another name.`)
    }
    throw cause
  }

  // **Commit what we just wrote.** Leaving it untracked closed a loop the user
  // walked straight into: drafting a task file through the UI made the repo
  // dirty with kantan's own output, and `requireCleanTreeForNewRun` then
  // refused to start that very task - so the only route to creating tasks
  // blocked running them. Writing into someone's repo and leaving it untracked
  // is the inconsistency, not committing it: `tickCheckbox` in `src/run.ts`
  // already commits into the user's repo with an explicit pathspec and a
  // message saying what it did and why.
  //
  // A failed commit is a **warning on the 201**, not a 5xx, which is
  // `tickCheckbox`'s precedent: the draft is written and parsed, the result the
  // caller asked for exists, and the only thing missing is a commit a human can
  // make themselves. Turning that into an error would discard a good draft over
  // a rejecting pre-commit hook. `commitPaths` unstages on failure, so the
  // human finds an untracked file rather than a staged one their next commit
  // would sweep up.
  let warning: string | null = null

  // **Not while a run is in flight in this repo**, and this guard exists
  // *because* of the commit above rather than beside it. A live run has the
  // checkout on its own `orch/<task>` branch, so the commit would land there -
  // and `returnToBase` at the end of that run would then take the drafted file
  // out of the working tree entirely. The user would watch a file they just
  // created disappear, recoverable only from a branch nobody told them about.
  // `git add` also takes `.git/index.lock`, which can fail the agent's own
  // concurrent commit.
  //
  // So the file is still written and still answered - the draft is never lost,
  // which is why this is not a 409 like the removal route's version - it just
  // stays untracked, exactly as it did before this change. The user commits it
  // themselves, or drafts again once the run is done.
  const live = await liveRunIdFor(ctx, project.path)
  if (live !== null) {
    warning = `${draft.path} was written but not committed: run ${live} is in flight in this repository, so the checkout is on that run's own branch and committing there would take this file out of your working tree when the run finishes. It is untracked - commit it yourself, or leave it and it will be there when the run is done.`
  } else {
    // `requireUsableRepo` is the only call here that throws; `commitPaths`
    // reports git's complaint as a value. Narrow on purpose: a broad `try`
    // around both would launder a programming error into a cosmetic warning and
    // answer 201 on every request with the file still untracked - the exact
    // loop this change closes, hidden behind a green test that checked only the
    // status and the path.
    let repo: Repo
    try {
      repo = await requireUsableRepo(project.path)
    } catch (cause) {
      return refuse(400, (cause as Error).message)
    }
    warning = await commitPaths(repo, {
      subject: `chore: draft ${draft.path}`,
      body: `kantan drafted this feature file from a description the user typed. It holds ${draft.feature.tasks.length} task${draft.feature.tasks.length === 1 ? "" : "s"}, none of which has been run or verified.`,
      paths: [draft.path],
    })
  }

  return Response.json(
    {
      ok: true,
      path: draft.path,
      tasks: draft.feature.tasks.length,
      // Only when there is something to say, so a client can treat the key's
      // presence as "tell the human" rather than comparing against "".
      ...(warning === null ? {} : { warning }),
    },
    { status: 201 },
  )
}
