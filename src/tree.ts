/**
 * The project tree: what `GET /api/projects` answers, and the readings behind
 * it.
 *
 * **This module is the point of the refactor.** The plan
 * (`docs/plans/2026-10-12-server-factoring.md`) says the real criticism of
 * `src/server.ts` was never its size: it was that `treeTask`, `featuresOf`,
 * `accountOf` and `whyUnread` - which decide what a task's state is, which
 * files count as a backlog, and which account a project bills to - lived
 * inside the HTTP module. That is not routing. Nothing else could reuse them,
 * and nothing could test them without standing up a server, which is why their
 * only coverage was through `call()` in `test/server.test.ts`.
 *
 * They are exported now, so a test can ask `featuresOf` about a directory and
 * `accountOf` about a record directly. The bodies are unchanged: the plan's
 * rule is extract first and improve later, against a green suite.
 *
 * `readProjects` stays with them rather than going to `src/routes/`. It is a
 * route handler, but it is a thin wrapper over these four and splitting the
 * two would put one import between a function and the only things it calls.
 */

import { realpath } from "node:fs/promises"
import { basename, isAbsolute, relative, resolve } from "node:path"

import { parseFeature } from "./backlog"
import type { Task } from "./backlog"
import { listFeatureFiles } from "./featurefile"
import { taskBranchName } from "./git"
import { loadProjects } from "./projects"
import type { Project } from "./projects"
import { accountsFile, discoverProfiles, loadProfiles } from "./profiles"
import type { Profile } from "./profiles"
import { indexRuns, taskKey } from "./runindex"
import type { TaskStatus } from "./runindex"
import { noStore, refuse } from "./http/guards"
import { readInside } from "./http/readinside"
import type { FileRead } from "./http/readinside"
import type { RouteContext } from "./http/context"
/* Type-only, for the reason `src/server.ts`'s own copy of this import states
   at length: a value import of the component module would put React in the
   server's module graph. */
import type { Account, TreeFeature, TreeProject, TreeTask } from "./ui/Tree.tsx"

// --- The project tree -------------------------------------------------------

/**
 * The most a feature file may be, in bytes.
 *
 * Its own constant rather than the plan's, because this route reads **every**
 * feature file of **every** registered project on each page load, so what is
 * bounded here is the aggregate rather than one document. A megabyte is already
 * far past a human-edited backlog - `src/backlog.ts` parses a task per line -
 * and both directions were weighed: a tighter cap would drop a long real
 * backlog, and no cap at all lets one file in one repo decide how much memory a
 * page load spends.
 */
const MAX_FEATURE_BYTES = 1024 * 1024

/**
 * Every project, its feature files, their tasks, and each task's newest run.
 *
 * **The run ids travel beside the tree, not inside it.** `Tree.tsx` hands its
 * caller a `TaskId` - the project, the feature file and the ref - while every
 * `:id` route here is keyed by run id, so a selection in the tree resolved to
 * nothing this port would accept (HANDOFF). The fix is not a `runId` on
 * `TreeTaskRun`: the component is presentational and `src/runindex.ts` already
 * owns the task-to-run mapping and already exports the key function for it. So
 * `runs` is keyed by `taskKey`, which separates with `NUL` - the one byte a path
 * cannot contain, and one that survives JSON as `\u0000` - and the shell joins
 * the two. There is deliberately no second key format.
 *
 * What this composes, rather than reimplements: `src/projects.ts` for the
 * registered repos, `src/featurefile.ts` for which files are a backlog,
 * `src/backlog.ts` for the parse, and `src/runindex.ts` for the fold of the run
 * logs.
 *
 * **No merge predicate is passed to `indexRuns`, and that is not only about
 * cost.** `isMergedIntoBase` needs a base branch, and nothing in `src/git.ts`
 * or `src/run.ts` resolves a project's base outside a run that was started from
 * it - so there is no base to ask about here, and inventing one would make
 * `merged` meaningless while looking right. The cost settles it the same way:
 * measured over 500 logs, `indexRuns` reads them in 89-180ms and a 5ms-a-row
 * predicate takes the same work to 2733ms, awaited one row at a time
 * (HANDOFF). So every finished task reads `done-unmerged`, which `Tree.tsx`
 * treats as its own calm end state and which keeps `canStart` false: the
 * recoverable direction. Caching those answers is deliberately not done here -
 * only a caller who knows when a branch can have moved can invalidate one, and
 * a stale cache would feed wrong merge state to the guard whose whole job is
 * refusing a second run against finished work.
 *
 * Nothing here throws on the user's own data. A project whose repo has been
 * deleted, or whose `path` names a file, is listed with no features, because one
 * unusable record must not blank the tree. A **damaged store** is the one
 * exception and is a 500 forwarding its message, as registration does: an empty
 * list there would read as a fresh install and invite registering everything
 * again.
 */
export async function readProjects(ctx: RouteContext): Promise<Response> {
  const projectsFile = ctx.projectsFile
  if (projectsFile === null) return noStore("list any projects")

  let registered: Project[]
  try {
    registered = await loadProjects(projectsFile)
  } catch (cause) {
    // The same answer, and the same reasoning, as `registerProject`'s: the
    // store is the only state no repository can rebuild, the message names the
    // file, the record and the field, and an editor fixes what it points at.
    console.error(`GET /api/projects: ${projectsFile} cannot be read:`, cause)
    return refuse(500, (cause as Error).message)
  }

  const index = await indexRuns({
    runsDir: ctx.runsDir,
    // Never a second implementation of the branch name: a plausible name
    // pointing at no branch would make `merged` meaningless while looking right.
    branchFor: taskBranchName,
    // A log naming a project that is no longer registered is skipped with a
    // warning: someone will delete a project, and its logs outlive it.
    projects: registered.map((project) => project.path),
    ...(ctx.liveRunIds === null ? {} : { liveRunIds: ctx.liveRunIds() }),
  })

  const warnings = [...index.warnings]
  const projects: TreeProject[] = []
  for (const project of registered) {
    const read = await featuresOf(project, index.tasks)
    warnings.push(...read.warnings)
    projects.push({
      path: project.path,
      account: accountOf(project),
      testCmd: project.testCmd,
      // The folder, not only the word. `account` is a label; `configDir` is
      // what `src/spawn.ts` turns into `CLAUDE_CONFIG_DIR`, so without it on
      // the wire the panel's account cards cannot tell two profiles of one
      // word apart - and `optionId` in `src/ui/ProjectPanel.tsx` exists
      // precisely to tell them apart.
      ...(project.configDir === undefined ? {} : { configDir: project.configDir }),
      // The stored ceiling. Absent from the wire meant the panel's whole
      // ceiling section was hidden, which read from use as "nowhere to set a
      // budget" - the store has had the field, and a default of $50, since
      // `projects.ts` was written.
      budgetUsd: project.budgetUsd,
      // What each phase runs as. On the wire for the same reason the ceiling
      // is: a panel cannot offer to change a setting it cannot read, and these
      // were hand-edit-only until now. Sent as one object rather than six keys
      // so the panel takes them or leaves them together - a half-read set
      // would draw a form with some fields blank and no way to tell "unset"
      // from "this wire is older than this page".
      advanced: {
        planModel: project.planModel,
        implementModel: project.implementModel,
        planEffort: project.planEffort,
        implementEffort: project.implementEffort,
        permissionMode: project.permissionMode,
        allowedTools: project.allowedTools,
      },
      features: read.features,
    })
  }

  /**
   * The accounts a project may be switched to, and the ones kantan merely
   * suspects. **Two keys, because they are two different claims.**
   *
   * `accounts` is what the user told kantan, from the registry.
   * `foundAccounts` is what a scan of the home directory suggests. Merging
   * them would make a guess look like a record - and the scan is deliberately
   * conservative, since typing a folder by hand is always available.
   *
   * Carried on the tree rather than fetched separately because this is where
   * the picker's data already comes from: `accountOptionsFor` builds its
   * options from this response, and a reload after an add refreshes them
   * without a second endpoint or a second poll.
   *
   * Neither can fail the tree. A damaged registry reads as empty here and the
   * add route answers the real error where somebody is looking at it, and
   * discovery never throws at all.
   */
  let accounts: Profile[] = []
  try {
    accounts = await loadProfiles(accountsFile(projectsFile))
  } catch (cause) {
    warnings.push(
      `${accountsFile(projectsFile)} could not be read, so no extra accounts are offered: ${(cause as Error).message}`,
    )
  }

  return Response.json(
    {
      ok: true,
      projects,
      accounts,
      foundAccounts: await discoverProfiles(ctx.homeDir),
      // Every task the logs know about, not only the ones a tree row joined: a
      // run whose feature file has since been renamed is still a run, and
      // filtering the mapping down to what happens to be on screen would make
      // it unaddressable the moment the tree and the logs disagree.
      runs: Object.fromEntries(
        [...index.tasks].map(([key, status]) => [
          key,
          { runId: status.runId, costUsd: status.costUsd, attempts: status.attempts },
        ]),
      ),
      // Everything that was skipped or guessed at, from the fold and from the
      // reads below. Dropping these would make a refused backlog a silent
      // absence, which reads as a parser bug; `indexRuns` collects its own for
      // the same reason and never throws them.
      warnings,
    },
    // Nothing here is cached: a run moves between page loads, and the design's
    // own rule is that the UI never owns truth.
    { headers: { "Cache-Control": "no-store" } },
  )
}

/**
 * Which Claude account a project's runs bill to.
 *
 * `Project.account` is the only source, because it is the only one the human
 * actually stated. Still never derived from `configDir`: that selects a CLI
 * profile, and no rule turning `/home/u/.claude-work` into "work" is anything
 * but a guess about how a stranger names their directories. Design §5 lists a
 * wrong account as a defect because people bill clients from one of these.
 *
 * What changed is the **unstated** case. It used to return bare `unknown`,
 * which the tree renders as "account unknown" on every row of every project -
 * true, and useless, and it reads like a bug. We cannot say personal or work
 * without being told, but we can say which profile the runs use, which is a
 * fact we hold: the default profile, or the directory `configDir` names. That
 * is strictly more informative and still claims nothing about whose money it
 * is.
 */
export function accountOf(project: Project): Account {
  if (project.account !== undefined) return { kind: project.account }
  return {
    kind: "unknown",
    label: project.configDir === undefined ? "default profile" : (basename(project.configDir) || project.configDir),
  }
}

/**
 * One project's feature files, with whatever could not be read said out loud.
 *
 * `readFeature` is deliberately **not** what reads these. It uses a plain
 * `readFile`, so it follows a symlink out of the repository and has no size
 * cap, and this route hands the parsed contents to a browser - the same
 * exposure the plan route has, answered by the same guard (`readInside`).
 *
 * That guard is a skipping rule, so CLAUDE.md's rule applies. The dimension is
 * **the outcome of trying to read one candidate**, and its values are: a plain
 * file; a symlink that stays inside the repo; a symlink out of it; a dangling
 * one, or a file deleted between the listing and the read; something that is
 * not a regular file; bytes that are not UTF-8; and a file past the cap. The
 * costs are not symmetric:
 *
 * - **Rendering a file from outside the repository** leaks whatever a line of
 *   it looks like a task bullet in, and there is no recovering a leaked key.
 *   So that direction refuses, even though `listFeatureFiles` documents a
 *   symlinked shared backlog as supported - which it still is for a run, since
 *   `src/run.ts` reads the file itself. The two disagree, and this is the side
 *   to be wrong on.
 * - **Dropping a file the user really has** makes a real backlog invisible,
 *   which `listFeatureFiles` itself calls the worse failure.
 *
 * So a file that cannot be read is **omitted and named in a warning**, never
 * listed with `tasks: []`: an empty task list is exactly what a feature
 * mid-draft looks like, and `listFeatureFiles` includes those on purpose, so the
 * two have to stay distinguishable. A silent omission would read as a parser
 * blind spot and send someone looking in the wrong file.
 */
export async function featuresOf(
  project: Project,
  tasks: ReadonlyMap<string, TaskStatus>,
): Promise<{ features: TreeFeature[]; warnings: string[] }> {
  const warnings: string[] = []

  // Canonical, because `readInside` compares two resolved paths: a project
  // registered through a symlink would otherwise have every file under it read
  // as pointing out of itself. Only for the containment check - the path the
  // tree prints and joins on stays the registered spelling, below.
  let root: string
  try {
    root = await realpath(project.path)
  } catch (cause) {
    warnings.push(`${project.path} cannot be resolved, so its backlog is not listed: ${(cause as Error).message}`)
    return { features: [], warnings }
  }

  // `listFeatureFiles` reads an absent `docs/features` as no features, which is
  // a repo's normal first state, and throws on anything else - a `path` that is
  // a file answers ENOTDIR. One throw must not become a 500 for every project.
  let candidates: string[]
  try {
    candidates = await listFeatureFiles(project.path)
  } catch (cause) {
    warnings.push(`${project.path} has no readable docs/features, so its backlog is not listed: ${(cause as Error).message}`)
    return { features: [], warnings }
  }

  const features: TreeFeature[] = []
  for (const path of candidates) {
    const rel = featurePath(project.path, path)
    if (rel === null) {
      warnings.push(`${path} is not inside ${project.path}, so it is not listed as one of its feature files`)
      continue
    }
    const read = await readInside(root, path, MAX_FEATURE_BYTES)
    if (!read.ok) {
      warnings.push(`${project.path}: ${rel} is in docs/features and was not read, so it is not in the tree: ${whyUnread(read)}`)
      continue
    }
    features.push({
      path: rel,
      tasks: parseFeature(read.text).tasks.map((task) => treeTask(task, project.path, rel, tasks)),
    })
  }
  return { features, warnings }
}

/**
 * Prose for a refused read.
 *
 * None of these quotes the path the file resolved **to**: where a link inside
 * the user's repo points is not this route's to publish, and the caller already
 * names the path the project lists. The one exception is `failed`, which
 * forwards an errno message, and `open`'s errno messages carry the resolved
 * path - which by then has passed the containment check, so it is a path inside
 * the repository either way.
 */
export function whyUnread(read: Extract<FileRead, { ok: false }>): string {
  switch (read.why) {
    case "missing":
      return "there is nothing at that path now; it was listed a moment ago, so it has been deleted or it is a dangling link"
    case "outside":
      return "it resolves to a file outside the repository, and this route does not render one - the backlog it links to is still there to read"
    case "not-a-file":
      return "it is not a regular file"
    case "too-large":
      return `it is past the ${MAX_FEATURE_BYTES} bytes a feature file may be`
    case "failed":
      return read.message
  }
}

/**
 * The feature file as the run log's header spells it, or `null`.
 *
 * **Relative to `project.path` as registered**, never to a resolved root, and
 * with separators normalised the way `src/run.ts`'s `repoRelative` normalises
 * them. HANDOFF: `TreeFeature.path` has to be the exact repo-relative string
 * the header records as `featureFile`, because that is a third of `taskKey`. If
 * the join misses, a `done, unmerged` task reads as `open` and `canStart`
 * returns true - a silent re-run of finished work the tree cannot detect.
 *
 * The guard is unreachable while the caller is `listFeatureFiles`, which joins
 * names from one `readdir` onto the project's own path; it is here because the
 * two things are separable and a path that escaped the project must not be
 * printed as one of its files.
 */
export function featurePath(projectPath: string, absolute: string): string | null {
  const rel = relative(resolve(projectPath), absolute)
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null
  return rel.split("\\").join("/")
}

/**
 * One backlog line, with its newest run when the index has one.
 *
 * `line` does not travel: it indexes a string the client does not have.
 *
 * `run` is **absent** rather than empty for a task that has never run, because
 * `taskStateOf` reads a missing `run` as open-or-passed from the checkbox and an
 * empty one would make it read the checkbox's opposite. A ref-less task is not
 * even looked up: it cannot be run, since a run is addressed by its ref.
 *
 * `testAttempts` and `exitCode` are **omitted**, not zeroed. `runindex.ts`
 * deliberately folds no `test` record - an exit code does not move a run - so
 * neither number is available here, and design §"what must survive" requires
 * exit codes printed and never paraphrased, which also forbids inventing one. A
 * zero would render as "exited 0": a pass nobody observed. A zero
 * `testAttempts` would be read by `isGrinding` as a count rather than an
 * absence.
 *
 * `branch` is forwarded as it comes, including `""` - which means `branchFor`
 * threw and the task was **not** checked for a merge. The run is never dropped
 * for it: a dropped run reads as a task that was never run, which is how a
 * second run gets started against work already written.
 */
export function treeTask(task: Task, projectPath: string, featureFile: string, tasks: ReadonlyMap<string, TaskStatus>): TreeTask {
  const line: TreeTask = { ref: task.ref, text: task.text, done: task.done }
  if (task.ref === null) return line
  const status = tasks.get(taskKey({ projectPath, featureFile, taskRef: task.ref }))
  return status === undefined ? line : { ...line, run: { state: status.state, branch: status.branch } }
}
