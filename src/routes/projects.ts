/**
 * The project store's three writers: register, remove, edit.
 *
 * Moved from `src/server.ts` unchanged. `EDITABLE_KEYS` is the one thing here
 * worth going looking for - it is the list that decides which of the eleven
 * stored settings a page may change, and it was four of them for most of this
 * project's life while the store validated all eleven.
 *
 * `registerProject`'s three validators run in an order their answers depend on,
 * and the comment on it says why at length: the shape, then `defaults()` -
 * whose throw is a **4xx**, because a relative `configDir` is the caller's typo
 * and not a server fault - then `requireUsableRepo`, which is the check the
 * store cannot make and which has to come last because a relative path must
 * never reach a `git -C` whose answer depends on where the server was launched.
 */

import { requireUsableRepo } from "../git"
import {
  addProject,
  defaults,
  loadProjects,
  projectIdentity,
  removeProject,
  updateProject,
} from "../projects"
import type { Edited, Project } from "../projects"
import type { RouteContext } from "../http/context"
import { badBody, nonEmptyString, parseBody, readBody } from "../http/body"
import { noStore, refuse } from "../http/guards"
import { liveRunFor } from "./runs"

/**
 * What registering a project takes, which is **not** every field a `Project`
 * has.
 *
 * These three are what the design's "Add a repository" dialog asks for: the
 * repo path, the test command, and the Claude account - which is spelled
 * `configDir`, an absolute path to a CLI profile, because a profile carries a
 * CLAUDE.md, skills and settings as well as credentials. Everything else
 * (`budgetUsd`, the models, the efforts, `allowedTools`, `reportPath`) takes
 * the design's default and is edited in `projects.json`, which is a file people
 * hand-edit and read in diffs.
 *
 * Deliberately not a copy of `src/projects.ts`'s `FIELDS`: adding a field to
 * `Project` is already a four-place change, and copying the list here would
 * make it five. The cost of this list being short is that a setting the store
 * supports cannot be set over HTTP, which is a 400 naming the keys this route
 * does take rather than a silently dropped value.
 *
 * The task file the dialog also asks for is **not** a project field: it names a
 * run, and it reaches `POST /api/runs` as `featureFile`.
 */
const PROJECT_KEYS = ["path", "testCmd", "account", "configDir"] as const

/**
 * What removing a project takes: the repo path, and nothing else.
 *
 * Its **own** list rather than `PROJECT_KEYS`, which also carries `testCmd`
 * and `account`. `parseBody` refuses an unknown key by naming the keys *this
 * route* takes, so sharing the longer list would accept a body that reads as
 * "remove this much of the project" and then ignore the rest of it.
 */
const REMOVE_KEYS = ["path"] as const

/**
 * The fields an edit may change.
 *
 * Longer than `PROJECT_KEYS` by `budgetUsd`, and that is not an oversight: the
 * registration dialog offers three fields and takes the design's default for
 * the ceiling, while an edit is where a ceiling is changed - it is one of the
 * fields a second trip through that dialog used to reset, which is why
 * re-registering is refused at all.
 *
 * Still far short of every field a `Project` has. The models, the efforts,
 * `allowedTools`, `permissionMode` and `reportPath` are edited in
 * `projects.json`, a file people hand-edit and read in diffs, and a key this
 * list does not carry is a 400 naming the keys it does - never a silent drop.
 */
/**
 * `account` and `configDir` are **not** coupled here, and that is a decision.
 *
 * Only `configDir` controls anything: `src/spawn.ts`'s `phaseEnv` sets
 * `CLAUDE_CONFIG_DIR` from it and deletes it when there is none, and
 * `src/run.ts` keys the run header's `profile` on it. `account` is a label -
 * what the human called it - and nothing in `src/` outside `accountOf()` below
 * reads it. So a client that switches accounts by sending `{account}` alone
 * relabels the chip and bills the same credentials as before.
 *
 * This route does not refuse that, for two reasons. A project can legitimately
 * have an account and no `configDir` - a user whose *default* CLI profile is
 * their work account - so "account requires configDir" would reject a correct
 * configuration. And a rule the store does not have would put this route and a
 * hand-edited `projects.json` into disagreement about what is valid, which is
 * the divergence docs/HANDOFF.md warns about elsewhere.
 *
 * What makes leaving it to the caller safe is that this route answers with the
 * **whole stored record**, so a client can see that `configDir` did not move. A
 * UI offering an account switcher must send both keys in one call; that it can
 * is pinned by test, as is the trap.
 */
/**
 * What `PATCH /api/projects` may change.
 *
 * It was these four, and the store has held eleven since it was written - so
 * `planModel`, `implementModel`, `planEffort`, `implementEffort`,
 * `permissionMode` and `allowedTools` could only be changed by hand-editing
 * `~/.orch/projects.json`. Nothing was wrong with the write path: `editProject`
 * copies whichever of these keys the body carried and `updateProject` validates
 * the merged record, naming the field in its own refusal. The only thing
 * missing was the key being listed here, and a surface for it.
 *
 * `reportPath` stays out. It is the one field nothing in `src/run.ts` reads
 * today, so a control for it would store a value with no effect - which is
 * worse than no control, because it looks like it did something.
 */
const EDITABLE_KEYS = [
  "testCmd",
  "account",
  "configDir",
  "budgetUsd",
  "planModel",
  "implementModel",
  "planEffort",
  "implementEffort",
  "permissionMode",
  "allowedTools",
] as const

/** The identity, plus what may change. Derived rather than listed again, so the
 * body's allowlist and the set of keys the handler reads cannot drift: `path`
 * is taken as the record to edit and is never one of the changes. */
const EDIT_KEYS: readonly string[] = ["path", ...EDITABLE_KEYS]

/**
 * Registers a repository: `projects.json`'s first writer.
 *
 * Three validators run, in an order their answers depend on:
 *
 * 1. **The body's shape**, as every action does it - unknown keys refused by
 *    name of the keys this route *takes*, never by echoing what was sent.
 * 2. **`defaults()`**, which fills the design's defaults around what the dialog
 *    supplied and then validates the record the store will accept. It
 *    **throws**, and that throw is a **4xx**: it is the caller's typo - a
 *    relative `configDir`, a blank `testCmd` - and not a server fault. It also
 *    has to run before git, because a relative path must never reach a `git -C`
 *    whose answer would then depend on where the server was launched from.
 * 3. **`requireUsableRepo()`**, which is what the store cannot do.
 *    `projects.json` only checks that `path` is an absolute string, so without
 *    this a path that is not a repository, is a subdirectory of one, is bare,
 *    or has no commits yet all register happily and fail at the first run -
 *    where the message is about a run rather than about the registration that
 *    was wrong.
 *
 * Both of those messages are forwarded as written, which is not a breach of
 * `refuse`'s no-echo rule: that rule is about the *guards*, where the offending
 * value is attacker-chosen and tells a legitimate caller nothing. These are
 * `src/projects.ts`'s and `src/git.ts`'s own prose about a path the human typed
 * into their own dialog, and quoting it back is the entire diagnosis - "it sits
 * inside the repository rooted at X" is the sentence that fixes the mistake.
 * The machine already answers this way: `src/run.ts`'s `unknown-project`
 * refusal quotes the `projectPath` it was given.
 */
export async function registerProject(req: Request, ctx: RouteContext): Promise<Response> {
  const projectsFile = ctx.projectsFile
  if (projectsFile === null) return noStore("register a project")

  const body = await readBody(req)
  if ("refused" in body) return body.refused
  const parsed = parseBody(body.text, PROJECT_KEYS)
  if ("refused" in parsed) return parsed.refused

  const path = nonEmptyString(parsed.fields["path"])
  if (path === null) {
    return badBody(PROJECT_KEYS, "a project is named by the repo path it lives at, which must be a non-empty string")
  }
  // **Present, and not judged here.** `null` is the store's spelling of "this
  // repo has no test suite", which makes its runs verified by the agent itself
  // (the user's 2026-10-12 decision), and a blank string is an unfinished edit
  // that must never be read as either - `sh -c ""` exits 0, so it would tick
  // every task untested. Telling those three apart is `validateProject`'s one
  // job and its prose is the 400 below.
  //
  // `nonEmptyString` used to stand here and collapsed `null` into the blank
  // case, which is why this is an `in` check: the route has to distinguish a
  // key that was *omitted* - a damaged or half-built body, still a 400 - from
  // one explicitly set to `null`, and `nonEmptyString` cannot see the
  // difference. Over-judging here was the quiet failure: it would have made
  // the whole feature unreachable over HTTP while the store supported it.
  if (!("testCmd" in parsed.fields)) {
    return badBody(
      PROJECT_KEYS,
      "a project must say how it is tested: testCmd is the shell command kantan runs and branches on, or null if this repo has no test suite and the agent should verify its own work",
    )
  }
  const testCmd = parsed.fields["testCmd"]
  const configDir = parsed.fields["configDir"]
  const account = parsed.fields["account"]

  let project: Project
  try {
    project = defaults({
      path,
      // The same assertion-not-a-check as `configDir` and `account` below, and
      // for the same reason: `testCommand` in src/projects.ts owns the
      // three-way judgement - a command, `null` for a repo with no suite, or a
      // throw for a blank or a non-string - and that throw is the 400 below.
      testCmd: testCmd as string | null,
      // Whether it is absolute, blank or absent is `defaults()`'s judgement to
      // make - it owns the rule that the CLI expands no `~` - so the cast is
      // the one place the body's shape is asserted rather than checked, and the
      // throw it may produce is the 400 below. `null` reads as absent there,
      // which is the store's own spelling of "the default profile".
      ...(configDir === undefined ? {} : { configDir: configDir as string }),
      // Same reasoning as `configDir`: whether it is one of the two words is
      // `defaults()`'s judgement, and its throw is the 400 below.
      ...(account === undefined ? {} : { account: account as "personal" | "work" }),
    })
  } catch (cause) {
    return refuse(400, (cause as Error).message)
  }

  let repoRoot: string
  try {
    repoRoot = (await requireUsableRepo(project.path)).root
  } catch (cause) {
    return refuse(400, (cause as Error).message)
  }

  // The repository's real root, not the spelling that arrived. `projects.json`
  // is keyed on `path` and normalises lexically only, so two symlinked
  // spellings of one repo would otherwise be two records with two histories
  // (HANDOFF). `requireUsableRepo` has already refused anything that is not a
  // root, so this differs from what was sent only where a symlink was involved
  // - and registering the other spelling now meets the 409 below instead of
  // quietly forking the project's history.
  const record: Project = { ...project, path: repoRoot }

  let registered: Project[]
  try {
    registered = await loadProjects(projectsFile)
  } catch (cause) {
    // A damaged store is a 5xx, and the one 5xx that forwards its message: it
    // names the file, the record and the field, the user owns that file, and an
    // editor fixes what a message points at. `fault`'s generic body would send
    // them to a terminal they are not looking at. Logged there as well, because
    // this is still a server-side surprise.
    console.error(`POST /api/projects: ${projectsFile} cannot be read:`, cause)
    return refuse(500, (cause as Error).message)
  }

  // Registering a known repo again is refused rather than applied, because
  // `addProject` replaces a record **wholesale**: a second trip through a
  // dialog that offers three fields would reset a `budgetUsd` or an
  // `allowedTools` list that was tuned by hand, and the store is the one piece
  // of state no repository can rebuild. Refusing costs an edit in a file the
  // user already owns; accepting can cost settings nothing can recover.
  if (registered.some((p) => p.path === record.path)) {
    return refuse(
      409,
      `${record.path} is already registered in ${projectsFile}, so there is nothing to add. Edit that file to change its settings - registering it again would replace the whole record, including anything tuned there by hand.`,
    )
  }

  await addProject(projectsFile, record)
  // 201, and the stored record: `path` may differ from what was sent - a
  // symlinked spelling, a trailing slash - and it is the identity every start
  // request and every run log keys on, so the caller is told what it is.
  return Response.json({ ok: true, project: record }, { status: 201 })
}

/**
 * Stops tracking a repository. The repo itself is untouched, and so are its run
 * logs.
 *
 * Three questions this answers, each decided rather than assumed:
 *
 * 1. **The run logs stay.** They live in `~/.orch/runs` keyed by run id, they
 *    are the record of work that cost real money, and nothing can rebuild one.
 *    `indexRuns` already skips a log whose project is no longer registered and
 *    says so in a warning - the warning the person who asked for this route had
 *    already seen - so the whole cost of keeping them is that line of text,
 *    while deleting them answers an undoable question nobody asked.
 *    Re-registering the same path brings every run of it back into the tree.
 * 2. **A project with a run in flight is refused**, 409. Every method on the
 *    machine's port resolves the run's project through `projects.json` first -
 *    `stop` included - so a record removed mid-run turns approve, answer,
 *    resume and stop into `unknown-project`. The run would keep its child and
 *    keep spending, invisible in the tree and unreachable from the UI.
 *    Refusing costs one sentence: stop it first.
 * 3. **A path nobody registered is a 404**, not an idempotent 200. The usual
 *    argument for DELETE is idempotence, but a 200 tells someone their project
 *    is gone when a misspelling means it is still there - and a client that
 *    wants idempotence can treat this 404 as success, where nothing can recover
 *    the distinction from a 200. It is also what `POST /api/features` already
 *    answers for the same condition.
 *
 * No git, and no `realpath`: see `projectIdentity`. A project is most often
 * removed *because* its repo has been deleted or moved, so a route that
 * required a usable repository could not remove the records that most need
 * removing.
 */
export async function removeRegistration(req: Request, ctx: RouteContext): Promise<Response> {
  const projectsFile = ctx.projectsFile
  if (projectsFile === null) return noStore("remove a project")

  const body = await readBody(req)
  if ("refused" in body) return body.refused
  const parsed = parseBody(body.text, REMOVE_KEYS)
  if ("refused" in parsed) return parsed.refused

  const named = nonEmptyString(parsed.fields["path"])
  if (named === null) {
    return badBody(REMOVE_KEYS, "a removal names the project by the repo path it is registered under, which must be a non-empty string")
  }
  let path: string
  try {
    // The store's own rule for which record a path names, so this route and
    // the write it is about to make cannot disagree about that. Its throw is
    // the caller's typo - a relative path - and so a 400, exactly as
    // `defaults()`'s throw is on registration.
    path = projectIdentity(named)
  } catch (cause) {
    return refuse(400, (cause as Error).message)
  }

  const busy = await liveRunFor(ctx, path)
  if (busy !== null) return refuse(409, busy)

  let removed: boolean
  try {
    removed = await removeProject(projectsFile, path)
  } catch (cause) {
    // A damaged store, answered as registration answers it: a 500 that
    // forwards its own message, because it names the file, the record and the
    // field, the user owns that file, and an editor fixes what it points at.
    console.error(`DELETE /api/projects: ${projectsFile} cannot be read:`, cause)
    return refuse(500, (cause as Error).message)
  }
  if (!removed) {
    return refuse(404, `${path} is not registered in ${projectsFile}, so there was nothing to remove. Its run logs, if it has any, were not touched either.`)
  }
  return Response.json({ ok: true })
}

/**
 * Changes some of a project's settings, leaving the rest alone.
 *
 * **Partial, and that is the whole design of this route.** `registerProject`
 * refuses a re-register with a 409 because `addProject` replaces a record
 * wholesale: a second trip through a three-field dialog would reset a
 * `budgetUsd` or an `allowedTools` list that was tuned by hand, and the store
 * is the one piece of state no repository can rebuild. So only the keys the
 * body carries are forwarded, `src/projects.ts` merges them onto the stored
 * record, and nothing here rebuilds one through `defaults()` - which would
 * reintroduce precisely the loss that 409 exists to prevent.
 *
 * **`path` is the identity and is not editable here.** It is what every start
 * request and every run log keys on, so moving it is a remove plus an add: two
 * decisions, where a human can see both halves. The allowlist has no second key
 * that could name a new one.
 *
 * **No git, unlike registration**, and the asymmetry is the point.
 * `requireUsableRepo` decides whether a *new* path is a repository kantan can
 * run in; an edit names a record that already exists, and re-checking the repo
 * would make a project whose checkout has been deleted impossible to fix and
 * impossible to repoint - which is one of the two things a user asked for.
 *
 * **It is allowed while a run is in flight**, where a removal is refused. A
 * removal breaks the lookup every action on that run makes; an edit cannot,
 * because `path` cannot change and `held()` hands back the run the machine
 * already registered rather than re-reading the store for it. The one cost
 * worth naming is `configDir`: a run that is rehydrated after a restart takes
 * the edited record, and `--resume` would then look for its session in a
 * different CLI profile and meet "No conversation found". That is reversible
 * with one PATCH back, it is invisible to any liveness check - the run it bites
 * is an interrupted one, which is by definition not live - and refusing every
 * edit while a project has unfinished runs would block the ordinary case of
 * fixing a typo in `testCmd` while a plan waits at the gate.
 */
export async function editProject(req: Request, ctx: RouteContext): Promise<Response> {
  const projectsFile = ctx.projectsFile
  if (projectsFile === null) return noStore("edit a project")

  const body = await readBody(req)
  if ("refused" in body) return body.refused
  const parsed = parseBody(body.text, EDIT_KEYS)
  if ("refused" in parsed) return parsed.refused

  const named = nonEmptyString(parsed.fields["path"])
  if (named === null) {
    return badBody(EDIT_KEYS, "an edit names the project by the repo path it is registered under, which must be a non-empty string")
  }
  let path: string
  try {
    // The store's own rule for which record a path names, run here as well as
    // inside the write: it is what keeps this route's 404 quoting the spelling
    // the store uses, and what keeps it agreeing with the removal beside it.
    path = projectIdentity(named)
  } catch (cause) {
    return refuse(400, (cause as Error).message)
  }

  // The keys that were **sent**, not every key this route knows: an absent key
  // has to mean "leave it alone", and a `changes` object filled with
  // `undefined` for the rest would be a wholesale replacement wearing a
  // partial update's clothes. `in` rather than an undefined check, because the
  // question is which keys the body carried.
  const changes: Record<string, unknown> = {}
  for (const key of EDITABLE_KEYS) {
    if (key in parsed.fields) changes[key] = parsed.fields[key]
  }

  let edited: Edited
  try {
    edited = await updateProject(projectsFile, path, changes)
  } catch (cause) {
    // A damaged store, answered as registration and removal answer it.
    console.error(`PATCH /api/projects: ${projectsFile} cannot be read:`, cause)
    return refuse(500, (cause as Error).message)
  }
  if (!edited.ok) {
    // Two different mistakes with two different fixes, which is why the store
    // tags them rather than throwing one exception for both: a 404 means
    // register it first, a 400 means that value cannot be stored - and the
    // store's own prose names the field, as it does on registration.
    return edited.why === "not-registered"
      ? refuse(404, `${path} is not registered in ${projectsFile}, so there is nothing to edit. Register it first; kantan only stores settings for repos it was told about.`)
      : refuse(400, edited.message)
  }
  // The stored record, as registration answers one: the merge is what the
  // caller cannot predict, and `path` in it is the identity every later
  // request keys on.
  return Response.json({ ok: true, project: edited.project })
}
