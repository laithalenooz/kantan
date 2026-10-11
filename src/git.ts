/**
 * The guards that stand between kantan and somebody's real repository.
 *
 * kantan drives an agent that edits and commits in a Laravel or Flutter project
 * with years of history. Every function here exists to stop it clobbering work
 * a person cares about, so each one is named for what it protects.
 *
 * Design §3.6: a task owns one branch, `orch/<task-slug>`, created in the
 * project's main checkout from the base branch recorded at run start; the server
 * allows one active run per project; on `done` the checkout returns to base.
 *
 * The order a new run must use, because the primitives cannot enforce it on each
 * other and getting it wrong leaks a lock or stacks a branch:
 *
 *   1. `requireUsableRepo`      - the path may be neither a path nor a repo
 *   2. `acquireRunLock`         - one active run per project
 *   3. `recordBaseBranch`       - every task branches from THIS, never from
 *                                 whatever the last run left checked out
 *   4. `requireCleanTreeForNewRun`
 *   5. `createTaskBranch`
 *   ... and `releaseRunLock` in a `finally`, or a refusal at 3, 4 or 5 leaves a
 *   lock holding a live pid, which nothing will ever reclaim.
 *
 * Resuming is the same list without step 4 and with `resumeTaskBranch` in place
 * of step 5: the dirty check must never block a run from re-entering its own
 * branch, because a SIGTERM leaves half-written files there by design.
 */

import { createHash, randomUUID } from "node:crypto"
import { link, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import { basename, isAbsolute, join, normalize } from "node:path"

export interface Repo {
  /** The repo root as git reports it, so two symlinked spellings of one repo
   * are one `Repo`. `src/projects.ts` normalises `path` lexically only, which
   * is why this matters: it is the first place the two spellings converge. */
  root: string
  /** `$GIT_COMMON_DIR`. The run lock lives here, so every worktree of one
   * repository contends for one lock - which is right, because `orch/<slug>`
   * is a single ref namespace shared by all of them. */
  gitDir: string
}

/** What identifies a task well enough to own a branch. */
export interface TaskId {
  /** The feature file, relative to the repo root. Part of the identity because
   * every feature file in a repo has a `T1`. */
  feature: string
  /** The `T<n>` label the runner addresses the task by. */
  ref: string
}

export const BRANCH_PREFIX = "orch/"

// --- Is this path a usable git repository at all? ---------------------------

/**
 * `path` as a repository kantan can run in, or a message naming what is wrong
 * with it.
 *
 * `project.path` arrives only lexically normalised: nothing upstream has
 * checked that it exists, that it is a repository, or that it is the root of
 * one. Each refusal below is a thing that silently does the wrong job instead:
 *
 * - **Not a repo at all**, or gone. Nothing else here can report this well,
 *   because every later git call would fail with the same message six times.
 * - **A subdirectory of a repo.** `git rev-parse` answers for the enclosing
 *   repository, so a plain directory under a dotfiles repo at `$HOME` reads as
 *   a usable repo and the agent would commit to `$HOME`.
 * - **Bare.** No working tree, so there is nothing for an agent to edit.
 * - **No commits yet.** `git branch --show-current` answers `main` on an unborn
 *   HEAD (probed), so a base recorder that trusts it hands `switch -c` a name
 *   with no commit behind it, and the run dies later with git's message rather
 *   than this one.
 */
export async function requireUsableRepo(path: string): Promise<Repo> {
  const probe = await runGit(path, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
    "--is-bare-repository",
  ])
  if (probe.code !== 0) {
    throw new Error(`${path} is not a usable git repository: ${gitSaid(probe)}`)
  }
  const [commonDir, bare] = probe.out.trim().split("\n")
  if (commonDir === undefined || bare === undefined) {
    throw new Error(`${path}: could not read the repository layout from git rev-parse`)
  }
  if (bare === "true") {
    throw new Error(
      `${path} is a bare git repository, so it has no working tree for an agent to edit. Register a checkout of it instead.`,
    )
  }

  const top = await runGit(path, ["rev-parse", "--show-toplevel"])
  if (top.code !== 0) throw new Error(`${path}: could not find the repository root: ${gitSaid(top)}`)
  const root = top.out.trim()
  if ((await realpath(path)) !== root) {
    throw new Error(
      `${path} is not the root of a git repository; it sits inside the one rooted at ${root}. Register that root, or make this directory a repository of its own - kantan commits at the root, and a run here would commit there.`,
    )
  }

  // `HEAD^{commit}` rather than `HEAD`: the latter verifies on a tag or a tree.
  if ((await runGit(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])).code !== 0) {
    throw new Error(
      `${root} has no commits yet, so ${BRANCH_PREFIX}<task> has no base commit to branch from. Make the first commit, then start the run.`,
    )
  }

  return { root, gitDir: await realpath(commonDir) }
}

// --- What is the base branch, recorded at run start? ------------------------

/**
 * The branch every task of this run must branch from and return to.
 *
 * Recording it is what stops run 2 branching off run 1 and tasks silently
 * stacking (design §3.6). Two states have no base and are refused:
 *
 * - **A detached HEAD.** `git branch --show-current` exits 0 and prints nothing
 *   (probed), so the string is what has to be tested, not the exit code. There
 *   is no branch to record and none to return to, and the state is usually a
 *   stopped rebase, bisect or cherry-pick whose anchor is not the project's
 *   mainline at all - branching a task from it is the stacking this prevents.
 *   The fix is one `git switch`, so refusing is the cheap direction.
 * - **A checkout left on an `orch/` branch.** This is the crash case: a run
 *   that never returned to base. Recording it would make the next task a child
 *   of the last one, which is exactly the failure base discipline exists for.
 */
export async function recordBaseBranch(repo: Repo): Promise<string> {
  const head = await runGit(repo.root, ["symbolic-ref", "--quiet", "--short", "HEAD"])
  if (head.code !== 0) {
    const at = (await runGit(repo.root, ["rev-parse", "--short", "HEAD"])).out.trim()
    throw new Error(
      `${repo.root} has a detached HEAD at ${at}, so there is no base branch to record and none to return to when the run finishes. An unfinished rebase, bisect or cherry-pick looks like this too. Run \`git switch <your base branch>\` first.`,
    )
  }
  const branch = head.out.trim()
  if (branch.startsWith(BRANCH_PREFIX)) {
    throw new Error(
      `${repo.root} is checked out on ${branch}, which is a kantan task branch rather than a base - an earlier run was interrupted before it returned to base. Recording ${branch} as the base would branch this task off that one. Run \`git switch <your base branch>\` first.`,
    )
  }
  return branch
}

// --- Is the working tree clean enough to start a NEW run? ------------------

/**
 * Nothing, or a message naming every file that stands in the way.
 *
 * This refusal does double duty (design §3.6): it guards against clobbering
 * uncommitted work, and against a second run entering an occupied repo. It
 * applies to **new** runs only - see the module header.
 *
 * ## What `git status --porcelain` can report, and the verdict for each
 *
 * The dimension read is the two-character `XY` code of each entry.
 *
 * | Code | What it is | Verdict |
 * |---|---|---|
 * | `??` | untracked, not ignored | **blocks** |
 * | `!!` | ignored | never seen: `--ignored` is not passed |
 * | ` M` ` T` ` D` | unstaged modify / typechange / delete | **blocks** |
 * | `M ` `A ` `D ` `T ` | staged modify / add / delete / typechange | **blocks** |
 * | `R ` `C ` and `RM` `RD` `CM` ... | rename or copy, with or without further edits | **blocks**, naming both paths |
 * | `MM` `AM` `MD` `AD` ... | staged and then edited again | **blocks** |
 * | `DD` `AU` `UD` `UA` `DU` `AA` `UU` | unmerged: a conflict | **blocks**, with its own message |
 * | ` M <submodule>` | submodule with modified content, or a moved gitlink | **blocks** |
 * | a submodule holding only untracked content | build output inside a vendored repo | **allowed** |
 *
 * **Why untracked blocks, concretely.** The agent commits its own work on
 * `orch/<slug>`. A `git add -A` sweeps an untracked file in with it; returning
 * to base then takes that file out of the working tree, and `git branch -D` as
 * a rollback loses it for good. A person's `notes.md` or un-ignored `.env`
 * vanishing is exactly the "never stash someone's work silently" failure. Build
 * artefacts are normally ignored, so they appear as `!!` and are never asked
 * for; what is left in `??` is overwhelmingly something a person made.
 *
 * **Why ignored never blocks.** `git add -A` cannot commit an ignored file, so
 * none of the mechanism above applies. Refusing on `node_modules` or `build/`
 * would mean refusing to work in every real repo.
 *
 * **Submodules.** Porcelain v1 flattens a submodule to one ` M sub` entry
 * whether its content is modified, its gitlink moved, or it merely holds
 * untracked files (probed), so the three cannot be told apart without parsing
 * v2. `--ignore-submodules=untracked` buys the one distinction worth having:
 * untracked content inside a vendored repo is build output the superproject
 * cannot commit anyway, while modified content and a moved gitlink are things a
 * person loses. The direction chosen is the cheap one either way - a refusal
 * costs one command, and the message names the submodule.
 *
 * **Why the flags are explicit and not left to config.** Probed: a repo with
 * `status.showUntrackedFiles = no` makes a plain `git status --porcelain` print
 * nothing at all for untracked files, and `diff.ignoreSubmodules = all` or
 * `.gitmodules` `submodule.<n>.ignore = all` does the same for submodules. A
 * guard whose blindness is configurable by the repo it is guarding is not a
 * guard. Command-line flags override all three.
 *
 * **What this cannot see, and no flag fixes:** a modification to a file marked
 * `assume-unchanged` or `skip-worktree` is invisible to `git status` by design.
 *
 * ## In-progress operations, which porcelain does not report at all
 *
 * A merge whose conflicts are all resolved back to HEAD's content leaves
 * `git status --porcelain` completely empty while `MERGE_HEAD` is still set
 * (probed). The agent's next commit would then silently become a merge commit
 * carrying the user's `MERGE_HEAD` as a second parent, which no later diff
 * explains. The same holds for a cherry-pick, a revert, a bisect and a rebase.
 */
export async function requireCleanTreeForNewRun(repo: Repo): Promise<void> {
  const dirty = await dirtyEntries(repo)
  const operation = await inProgressOperation(repo)
  if (operation !== null) {
    throw new Error(
      `${repo.root} is in the middle of ${operation.what}, so a new run cannot start there: the agent's next commit would silently inherit it.${listing(dirty)}\nFinish it, or abandon it with \`${operation.abort}\`.`,
    )
  }
  if (dirty.length === 0) return

  const kinds = new Set(dirty.map((e) => e.kind))
  const advice = kinds.has("conflicted")
    ? "Resolve the conflicts, or abandon the operation that caused them, before starting a run."
    : kinds.has("untracked")
      ? "Commit or stash them first: `git stash -u`. A plain `git stash` leaves untracked files behind, and you would hit this again."
      : "Commit or stash them first: `git stash`."
  throw new Error(
    `${repo.root}: ${count(dirty.length, "file")} ${dirty.length === 1 ? "has" : "have"} uncommitted changes, so starting a new run there could commit over work nobody asked kantan to touch.${listing(dirty)}\n${advice}`,
  )
}

// --- Slugifying a task into a branch name ----------------------------------

/**
 * The branch this task owns: `orch/<feature>-<ref>-<hash>`.
 *
 * ## What git refuses in a branch name, and how each is handled
 *
 * A refname may not contain a space or any ASCII control character; may not
 * contain `~ ^ : ? * [ \` or `..` or `@{`; may not be the single character `@`;
 * may not have a component starting with `.` or ending with `.lock`; may not
 * start or end with `/`, contain `//`, or end with `.`. A task's text is
 * arbitrary human prose and a feature path is an arbitrary filename, so every
 * one of those is reachable.
 *
 * Rather than enumerate the forbidden set - a denylist that a future git
 * version or a future caller can walk around - the readable part is reduced to
 * an **allowlist** of `[a-z0-9]` with `-` as the only separator, collapsed,
 * trimmed and truncated. That is inside every rule above at once.
 *
 * Two further rules come from the filesystem rather than from git:
 *
 * - **Lowercase only.** A loose ref is a file. macOS and a `/mnt/c` mount fold
 *   case, so `orch/Fix` and `orch/fix` would be one ref there and two here.
 * - **One component under `orch/`.** `orch/t1` and `orch/t1/sub` cannot both
 *   exist in a ref store; a slug containing `/` would make that collision
 *   reachable from two ordinary task names.
 *
 * Non-ASCII is dropped for the same filesystem reason: macOS stores filenames
 * decomposed, so an Arabic or accented ref can read back as a different string
 * than it was written as, and nothing in kantan would be able to find it again.
 *
 * ## Injectivity
 *
 * Every step above is lossy, so the readable part alone collides: `importer!!`
 * and `importer--` reduce to `importer`, and an all-emoji name reduces to
 * nothing. Two tasks sharing one branch would overwrite each other, so the name
 * carries an 8-hex-digit SHA-256 of the task's full identity. The hash is taken
 * over the identity, never over the reduced slug.
 *
 * **The identity is the feature path plus the ref, and deliberately not the
 * task's text.** The ref alone collides because every feature file has a `T1`;
 * the text alone collides because many features contain "fix the tests". The
 * text is left out because a typo fix in the prose would otherwise rename the
 * branch, and the next run would create a second one and orphan the first one's
 * commits. The path is normalised first, so `./docs/./f.md` and `docs/f.md` are
 * one task rather than two branches.
 */
export function taskBranchName(task: TaskId): string {
  const ref = task.ref.trim()
  if (ref === "") {
    throw new Error(
      `a task with no ref cannot own a branch: ${BRANCH_PREFIX}<slug> is keyed on the ref, so every ref-less task in one feature file would collapse onto one branch and overwrite the others. Give the task a T<n> ref first.`,
    )
  }
  if (isAbsolute(task.feature)) {
    throw new Error(
      `a task's feature path must be relative to the repo root, got ${JSON.stringify(task.feature)}: an absolute path puts the checkout's location in the branch name, so moving the repo would rename every branch and orphan the commits on them.`,
    )
  }
  const hash = createHash("sha256")
    .update(`${normalize(task.feature)}\u0000${ref}`, "utf8")
    .digest("hex")
    .slice(0, 8)
  const stem = [asciiSlug(fileStem(task.feature), 24), asciiSlug(ref, 12)]
    .filter((part) => part !== "")
    .join("-")
  return `${BRANCH_PREFIX}${stem === "" ? "task" : stem}-${hash}`
}

/** The readable part: an allowlist of `[a-z0-9]`, `-` as the only separator,
 * collapsed, trimmed and truncated. NFKD first so `é` contributes its `e`
 * rather than nothing. */
function asciiSlug(text: string, cap: number): string {
  return text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, cap)
    .replace(/-+$/, "")
}

/** `docs/importer.md` -> `importer`. A leading dot is not an extension, so a
 * dotfile keeps its name. */
function fileStem(path: string): string {
  const name = basename(path)
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(0, dot) : name
}

// --- Create or resume orch/<task-slug> from the recorded base --------------

/**
 * Creates `branch` at `base` and checks it out, for a **new** run.
 *
 * An existing branch is refused rather than entered, in both of its shapes:
 *
 * - **Commits ahead of base.** That task has run before and its work is
 *   unmerged - design §3.6's "done, unmerged". The tick lives on the branch
 *   until it is merged, so the working-tree markdown reads the task as open and
 *   the tree would offer to start it again. Entering it would run a second
 *   attempt on top of the first; `switch -c` would refuse outright with a
 *   message about branches rather than about the task.
 * - **No commits ahead.** Its tip can be a strict ancestor of base, so checking
 *   it out would hand the agent a tree from before base moved on, and the run
 *   would implement against stale code.
 *
 * Resuming is `resumeTaskBranch`; deleting the branch is the design's rollback,
 * and both messages say so.
 */
export async function createTaskBranch(repo: Repo, branch: string, base: string): Promise<void> {
  requireTaskBranch(branch)
  const tip = await resolveCommit(repo, `refs/heads/${branch}`)
  if (tip !== null) {
    const merged = await isMergedIntoBase(repo, branch, base)
    throw new Error(
      merged
        ? `${branch} already exists in ${repo.root}, at ${tip.slice(0, 8)}. That task has run before, and its tip may be behind ${base}, so checking it out would hand the agent a stale tree. Delete it with \`git branch -D ${branch}\` to start the task over.`
        : `${branch} already exists in ${repo.root}, at ${tip.slice(0, 8)}, with commits that are not in ${base}: that task has run before and its work is unmerged. Resume that run, or roll it back with \`git branch -D ${branch}\`.`,
    )
  }
  // `--no-guess` so a name that happens to match a remote-tracking branch
  // cannot quietly start the task on somebody else's code.
  const made = await runGit(repo.root, ["switch", "--no-guess", "-c", branch, base])
  if (made.code !== 0) {
    throw new Error(`could not create ${branch} from ${base} in ${repo.root}: ${gitSaid(made)}`)
  }
}

/**
 * Checks out the branch a run recorded, to resume it.
 *
 * No dirty check: a SIGTERM leaves half-written files on the task's own branch
 * by design, and refusing them would make an interrupted run unresumable.
 *
 * The branch must already exist. `git switch <name>` would otherwise invent one
 * from a remote-tracking ref of the same name, which would resume the run on
 * code nobody here wrote; `--no-guess` is belt to that braces.
 */
export async function resumeTaskBranch(repo: Repo, branch: string): Promise<void> {
  requireTaskBranch(branch)
  if ((await resolveCommit(repo, `refs/heads/${branch}`)) === null) {
    throw new Error(
      `the run recorded ${branch}, but ${repo.root} has no such branch any more - it was deleted, so there is nothing to resume. Start the task again.`,
    )
  }
  const moved = await runGit(repo.root, ["switch", "--no-guess", branch])
  if (moved.code !== 0) {
    throw new Error(`could not switch ${repo.root} to ${branch} to resume the run: ${gitSaid(moved)}`)
  }
}

/**
 * Returns the checkout to `base`, as design §3.6 requires on `done`.
 *
 * Refused while the tree is dirty, staying on the task branch: `git switch`
 * carries uncommitted modifications and untracked files across silently, so a
 * quiet return would move the agent's half-finished work onto base - the
 * opposite of what this function is for.
 */
export async function returnToBase(repo: Repo, base: string): Promise<void> {
  const head = await runGit(repo.root, ["symbolic-ref", "--quiet", "--short", "HEAD"])
  const where = head.code === 0 ? head.out.trim() : "a detached HEAD"
  const dirty = await dirtyEntries(repo)
  if (dirty.length > 0) {
    throw new Error(
      `${repo.root} still has uncommitted changes on ${where}, and \`git switch\` would carry them onto ${base} rather than leave them behind.${listing(dirty)}\nCommit them on ${where}, or stash them, then return to ${base}.`,
    )
  }
  if (where === base) return
  const moved = await runGit(repo.root, ["switch", "--no-guess", base])
  if (moved.code !== 0) {
    throw new Error(`could not return ${repo.root} to ${base}: ${gitSaid(moved)}`)
  }
}

// --- Is a branch merged into base? -----------------------------------------

/**
 * Whether every commit on `branch` is already in `base`. Task 7b's index needs
 * this to report `done, unmerged`, and a task in that state cannot be started
 * again.
 *
 * A missing branch throws rather than reading as unmerged: `merge-base
 * --is-ancestor` exits non-zero for "not an ancestor" and for "no such ref"
 * alike, and reporting a deleted branch as unmerged would wedge its task
 * forever behind a guard that can never clear.
 *
 * **Known limitation.** This reports ancestry, which is what "cannot be started
 * again" needs. A squash merge and a merge made only on the remote both leave
 * the branch's commits out of the local base, so both read as unmerged.
 */
export async function isMergedIntoBase(
  repo: Repo,
  branch: string,
  base: string,
): Promise<boolean> {
  if ((await resolveCommit(repo, `refs/heads/${branch}`)) === null) {
    throw new Error(
      `cannot say whether ${branch} is merged into ${base}: ${repo.root} has no branch ${branch}.`,
    )
  }
  if ((await resolveCommit(repo, base)) === null) {
    throw new Error(
      `cannot say whether ${branch} is merged into ${base}: ${repo.root} has no ${base}.`,
    )
  }
  const asked = await runGit(repo.root, ["merge-base", "--is-ancestor", branch, base])
  if (asked.code === 0) return true
  if (asked.code === 1) return false
  throw new Error(`could not compare ${branch} with ${base} in ${repo.root}: ${gitSaid(asked)}`)
}

// --- The per-project run lock ----------------------------------------------

export interface LockHolder {
  runId: string
  branch: string
}

/** What a lock file holds. Plain JSON, because the one person who will ever
 * read it by hand is reading it to find out why their repo is refusing. */
export interface LockRecord {
  runId: string
  branch: string
  pid: number
  /** An opaque fingerprint of when `pid` started, compared only against
   * another reading of itself. `null` when the platform will not say. */
  processStart: string | null
  /** This boot of this machine. `null` when unavailable. */
  bootId: string | null
  host: string
  /** Fresh per module load. Probed: `bun --watch` reloads in the **same pid
   * with the same start time**, so without this a reloaded server reads its own
   * abandoned lock as live and locks the repo until it is restarted. */
  nonce: string
  acquiredAt: string
}

export interface RunLock {
  file: string
  record: LockRecord
  /** The stale record this acquisition cleared, so the caller can report that
   * it happened rather than leave the user wondering. */
  reclaimed: LockRecord | null
}

/** One per module load. See `LockRecord.nonce`. */
const NONCE = randomUUID()

const LOCK_NAME = "kantan-run.lock"

/** Where the lock lives. In the git dir on purpose: `git status` cannot see it,
 * so no agent can commit it, nothing has to be added to `.gitignore`, and it
 * goes away with the repository. */
export function runLockPath(repo: Repo): string {
  return join(repo.gitDir, LOCK_NAME)
}

/**
 * Takes the project's run lock, or refuses with a message that says how to get
 * out of it.
 *
 * ## A lock that cannot be reclaimed locks a repo permanently
 *
 * The server will be killed mid-run: a crash, a `bun --watch` reload, a laptop
 * sleep, a `kill -9`. If the lock survived that with no way out, the user's only
 * recourse would be deleting a file they do not know exists. So a lock whose
 * owner is demonstrably gone is reclaimed automatically, and every refusal
 * prints the absolute path with an `rm` next to it.
 *
 * ## Why a pid alone is not enough
 *
 * Pids are reused. A lock naming pid 4812 can outlive its server and then
 * collide with an unrelated process, which would read as live forever. Three
 * things are recorded alongside it:
 *
 * - **A start-time fingerprint.** The pair (pid, start time) is unique while the
 *   machine is up, so a reused pid shows a different start time and the lock is
 *   stale. On Linux this is field 22 of `/proc/<pid>/stat`, parsed from after
 *   the last `)` because `comm` can itself contain spaces and parentheses.
 *   Elsewhere it is whatever `ps -o lstart=` prints, under a pinned `LC_ALL`
 *   and `TZ` so a timezone change between writing and reading cannot look like
 *   a reused pid.
 * - **The boot id.** Start time is measured from boot, so after a reboot a live
 *   pid can carry a matching start time. A different boot id is stale outright.
 * - **A per-module-load nonce.** `bun --watch` reloads in the same pid with the
 *   same start time (probed), and so does any `exec` in place, so pid and start
 *   time together still cannot tell this server from the incarnation of itself
 *   that died. The nonce can.
 *
 * ## Which way each uncertainty falls
 *
 * Reading a stale lock as live costs one `rm`, spelled out in the message.
 * Reading a live lock as stale puts two agents in one checkout, committing over
 * each other. So anything indeterminate - another host, or a live pid whose
 * start time cannot be read - refuses rather than reclaims, and so does a lock
 * file that cannot be parsed.
 */
export async function acquireRunLock(repo: Repo, holder: LockHolder): Promise<RunLock> {
  const file = runLockPath(repo)
  let reclaimed: LockRecord | null = null

  // Bounded: every retry is a race lost to another acquirer or releaser, and a
  // loop that could spin forever here is worse than a message.
  for (let attempt = 0; attempt < 4; attempt++) {
    const record = await ourRecord(holder)
    if (await createExclusively(file, record)) return { file, record, reclaimed }

    const raw = await readIfPresent(file)
    if (raw === null) continue // released between our create and our read

    const held = parseLockRecord(raw)
    if (held === null) {
      throw new Error(
        `${file} is not a readable run lock, so kantan cannot tell whether a run is active in ${repo.root}. An interrupted write looks like this. If no run is going, remove it: rm ${file}`,
      )
    }

    const verdict = await judgeLock(held)
    if (verdict.kind === "live") {
      throw new Error(
        `${repo.root} already has an active run: ${held.runId} on ${held.branch}, taken ${held.acquiredAt} by pid ${held.pid}, which ${verdict.why}. kantan allows one active run per project. Wait for it or stop it - or, if you are certain it is gone, remove the lock by hand: rm ${file}`,
      )
    }
    if (verdict.kind === "unknown") {
      throw new Error(
        `${repo.root} may already have an active run: ${held.runId} on ${held.branch}, taken ${held.acquiredAt} by pid ${held.pid} on ${held.host}. ${verdict.why}, and kantan will not reclaim a lock it cannot prove is dead - two agents in one checkout would commit over each other. If you know that run is over, remove the lock by hand: rm ${file}`,
      )
    }
    if (await reclaimLock(file, raw)) reclaimed = held
  }

  throw new Error(
    `gave up taking the run lock ${file} after four attempts: something is creating and removing it faster than kantan can claim it. Remove it by hand if no run is going: rm ${file}`,
  )
}

/**
 * Releases a lock, but only while it is still ours.
 *
 * A run declared stale and reclaimed while its own process limped on would
 * otherwise unlink the lock of whoever took it next, so the runId and the nonce
 * are checked before the unlink. An already-missing lock is reported rather
 * than thrown: the caller's `finally` runs on paths where the run died badly,
 * and a throw there would replace the real error.
 */
export async function releaseRunLock(lock: RunLock): Promise<"released" | "already gone" | "not ours"> {
  const raw = await readIfPresent(lock.file)
  if (raw === null) return "already gone"
  const held = parseLockRecord(raw)
  if (held === null || held.runId !== lock.record.runId || held.nonce !== lock.record.nonce) {
    return "not ours"
  }
  try {
    await unlink(lock.file)
  } catch (e) {
    if (!isErrno(e, "ENOENT")) throw e
    return "already gone"
  }
  return "released"
}

type Verdict =
  | { kind: "live"; why: string }
  | { kind: "stale"; why: string }
  | { kind: "unknown"; why: string }

/** The order matters: the nonce check has to come before the start-time check,
 * because a `--watch` reload keeps both the pid and the start time. */
async function judgeLock(held: LockRecord): Promise<Verdict> {
  const here = hostname()
  if (held.host !== here) {
    return {
      kind: "unknown",
      why: `It was taken on ${held.host} and this is ${here}, so this machine cannot see whether that process is still alive`,
    }
  }
  const boot = await thisBootId()
  if (held.bootId !== null && boot !== null && held.bootId !== boot) {
    return { kind: "stale", why: "it predates this machine's last boot" }
  }
  if (!isAlive(held.pid)) {
    return { kind: "stale", why: `its process ${held.pid} is gone` }
  }
  if (held.pid === process.pid && held.nonce !== NONCE) {
    return {
      kind: "stale",
      why: `it was taken by an earlier incarnation of this very server process (pid ${held.pid}), which a reload replaced in place`,
    }
  }
  const now = await startFingerprint(held.pid)
  if (held.processStart === null || now === null) {
    return {
      kind: "unknown",
      why: `Pid ${held.pid} is alive, but this machine will not say when it started, so there is no telling it apart from a different process that reused the pid`,
    }
  }
  if (held.processStart !== now) {
    return {
      kind: "stale",
      why: `pid ${held.pid} is alive but started at a different time, so it is a different process that reused the pid`,
    }
  }
  return { kind: "live", why: "is still running" }
}

async function ourRecord(holder: LockHolder): Promise<LockRecord> {
  return {
    runId: holder.runId,
    branch: holder.branch,
    pid: process.pid,
    processStart: await startFingerprint(process.pid),
    bootId: await thisBootId(),
    host: hostname(),
    nonce: NONCE,
    acquiredAt: new Date().toISOString(),
  }
}

/**
 * Creates the lock file atomically, or reports that it already existed.
 *
 * Written whole to a temp file and then `link`ed into place: `link` fails with
 * EEXIST rather than replacing, and no reader can ever see a half-written lock,
 * which is what makes an unparseable lock mean corruption rather than a race.
 */
async function createExclusively(file: string, record: LockRecord): Promise<boolean> {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o600 })
  try {
    await link(tmp, file)
    return true
  } catch (e) {
    if (isErrno(e, "EEXIST")) return false
    throw e
  } finally {
    await unlink(tmp).catch(() => {})
  }
}

/**
 * Clears a lock judged stale, reporting whether it really cleared that one.
 *
 * Renamed aside rather than read-then-unlinked: two reclaimers racing on an
 * unlink would each delete the other's fresh lock. The rename is atomic, so
 * only one of them gets the file; the loser sees ENOENT. The content is then
 * re-checked, because the lock could have been released and retaken between
 * the read that judged it and this rename - in which case a live lock is being
 * held hostage, and it is put straight back.
 */
async function reclaimLock(file: string, judged: string): Promise<boolean> {
  const aside = `${file}.stale.${process.pid}.${randomUUID()}`
  try {
    await rename(file, aside)
  } catch (e) {
    if (isErrno(e, "ENOENT")) return false
    throw e
  }
  if ((await readIfPresent(aside)) !== judged) {
    // Put it back with `link`, not `rename`: a rename would clobber a lock
    // taken in the meantime.
    await link(aside, file).catch(() => {})
    await unlink(aside).catch(() => {})
    return false
  }
  await unlink(aside).catch(() => {})
  return true
}

function parseLockRecord(raw: string): LockRecord | null {
  let data: unknown
  try {
    data = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null
  const r = data as Record<string, unknown>
  if (typeof r.runId !== "string" || typeof r.branch !== "string") return null
  if (typeof r.pid !== "number" || !Number.isInteger(r.pid)) return null
  if (typeof r.host !== "string" || typeof r.nonce !== "string") return null
  if (typeof r.acquiredAt !== "string") return null
  if (r.processStart !== null && typeof r.processStart !== "string") return null
  if (r.bootId !== null && typeof r.bootId !== "string") return null
  return {
    runId: r.runId,
    branch: r.branch,
    pid: r.pid,
    processStart: r.processStart,
    bootId: r.bootId,
    host: r.host,
    nonce: r.nonce,
    acquiredAt: r.acquiredAt,
  }
}

/** EPERM counts as alive: the process exists, it just belongs to another user,
 * and treating it as dead is the expensive direction. */
function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return !isErrno(e, "ESRCH")
  }
}

/** See `acquireRunLock`. The value is opaque: it is only ever compared with
 * another reading of itself. */
async function startFingerprint(pid: number): Promise<string | null> {
  const stat = await readIfPresent(`/proc/${pid}/stat`)
  if (stat !== null) {
    // Fields are counted from after the LAST ")", because field 2 is `comm` in
    // parentheses and a process can be called "my (odd) name".
    const close = stat.lastIndexOf(")")
    const fields = close === -1 ? [] : stat.slice(close + 1).trim().split(/\s+/)
    const starttime = fields[19] // field 22 overall; `state` is field 3
    if (starttime !== undefined && /^\d+$/.test(starttime)) return `ticks:${starttime}`
    return null
  }

  // Not Linux. `ps` prints a start time on macOS and the BSDs. LC_ALL and TZ
  // are pinned so a locale or timezone change cannot look like a reused pid.
  const ps = Bun.spawn(["ps", "-o", "lstart=", "-p", String(pid)], {
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    stdout: "pipe",
    stderr: "ignore",
  })
  const [out, code] = await Promise.all([new Response(ps.stdout).text(), ps.exited])
  if (code !== 0) return null
  const printed = out.trim()
  return printed === "" ? null : `lstart:${printed}`
}

let bootIdOnce: Promise<string | null> | undefined

async function thisBootId(): Promise<string | null> {
  bootIdOnce ??= readIfPresent("/proc/sys/kernel/random/boot_id").then((raw) =>
    raw === null ? null : raw.trim() || null,
  )
  return await bootIdOnce
}

// --- Shared plumbing -------------------------------------------------------

/**
 * Environment variables a git hook exports (githooks(5)). Left in place they
 * would point every call below at whatever repository invoked the server - so
 * `bun run check` run from a pre-commit hook would have these tests operating
 * on kantan's own index.
 */
const GIT_ENV_TO_DROP = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
])

interface GitResult {
  out: string
  err: string
  code: number
}

/**
 * Runs git in `dir`, never through a shell: a branch name may legally contain
 * `$(...)`, and `--no-optional-locks` keeps a read from taking `index.lock` out
 * from under the agent that is working in the same checkout.
 *
 * `-C dir` rather than a spawn cwd, because `dir` is sometimes a path that does
 * not exist and git's own message for that is better than a spawn failure.
 */
async function runGit(dir: string, args: string[]): Promise<GitResult> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !GIT_ENV_TO_DROP.has(key)) env[key] = value
  }
  const p = Bun.spawn(["git", "--no-optional-locks", "-C", dir, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  return { out, err, code }
}

/** git's own complaint, first line only, for embedding in a sentence. */
function gitSaid(r: GitResult): string {
  const [first] = r.err.trim().split("\n")
  return first === undefined || first === "" ? `git exited ${r.code}` : first
}

/** The commit `rev` names, or null when there is no such thing. */
async function resolveCommit(repo: Repo, rev: string): Promise<string | null> {
  const r = await runGit(repo.root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`])
  if (r.code !== 0) return null
  const sha = r.out.trim()
  return sha === "" ? null : sha
}

function requireTaskBranch(branch: string): void {
  if (!branch.startsWith(BRANCH_PREFIX)) {
    throw new Error(
      `${JSON.stringify(branch)} is not a kantan task branch: a run only ever creates or enters ${BRANCH_PREFIX}<task-slug>, so that a base branch can never be the target. Use taskBranchName().`,
    )
  }
}

type DirtyKind = "tracked" | "untracked" | "conflicted"

interface DirtyEntry {
  code: string
  /** The path, plus the path it came from for a rename or a copy. */
  paths: string[]
  kind: DirtyKind
}

async function dirtyEntries(repo: Repo): Promise<DirtyEntry[]> {
  // Every flag is explicit because repo config can otherwise blind the check:
  // see requireCleanTreeForNewRun.
  const r = await runGit(repo.root, [
    "status",
    "--porcelain",
    "-z",
    "--untracked-files=normal",
    "--ignore-submodules=untracked",
  ])
  if (r.code !== 0) {
    throw new Error(`could not read the state of ${repo.root}: ${gitSaid(r)}`)
  }
  return parsePorcelainZ(r.out)
}

/**
 * `XY<space>path` records, NUL-separated.
 *
 * A rename or a copy sends its original path as a **second** record with no
 * status code of its own (probed), so it is consumed here. A parser that read
 * every record as an entry would invent a path whose first two bytes had been
 * eaten as a status code.
 */
function parsePorcelainZ(raw: string): DirtyEntry[] {
  const records = raw.split("\0")
  const entries: DirtyEntry[] = []
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (record === undefined || record === "") continue
    const code = record.slice(0, 2)
    const paths = [record.slice(3)]
    if (code.includes("R") || code.includes("C")) {
      const from = records[i + 1]
      if (from !== undefined && from !== "") {
        paths.push(from)
        i++
      }
    }
    entries.push({ code, paths, kind: classify(code) })
  }
  return entries
}

function classify(code: string): DirtyKind {
  if (code === "??") return "untracked"
  // Unmerged, per git-status(1): either side `U`, or both-added, or both-deleted.
  if (code.includes("U") || code === "AA" || code === "DD") return "conflicted"
  return "tracked"
}

const LABELS: Record<DirtyKind, string> = {
  tracked: "modified or staged",
  untracked: "untracked",
  conflicted: "unresolved conflicts",
}

/** The dirty files, grouped and capped. "repo is dirty" with no detail is a bad
 * experience when the fix is one `git stash`; a thousand paths is a worse one. */
function listing(entries: readonly DirtyEntry[]): string {
  if (entries.length === 0) return ""
  const CAP = 10
  const lines: string[] = []
  let shown = 0
  for (const kind of ["conflicted", "tracked", "untracked"] as const) {
    const named: string[] = []
    for (const entry of entries) {
      if (entry.kind !== kind) continue
      if (shown >= CAP) break
      const [to, from] = entry.paths
      named.push(from === undefined ? (to ?? "") : `${to} (was ${from})`)
      shown++
    }
    if (named.length > 0) lines.push(`  ${LABELS[kind]}: ${named.join(", ")}`)
  }
  if (entries.length > shown) lines.push(`  ... and ${entries.length - shown} more`)
  return `\n\n${lines.join("\n")}\n`
}

/**
 * The operation this repo is in the middle of, if any.
 *
 * Located through `rev-parse --git-path` rather than by joining `.git`, because
 * these live in the **worktree's** git dir, which is not the common dir when
 * the project is a linked worktree.
 */
const OPERATIONS: readonly { file: string; what: string; abort: string }[] = [
  { file: "MERGE_HEAD", what: "a merge", abort: "git merge --abort" },
  { file: "CHERRY_PICK_HEAD", what: "a cherry-pick", abort: "git cherry-pick --abort" },
  { file: "REVERT_HEAD", what: "a revert", abort: "git revert --abort" },
  { file: "rebase-merge", what: "a rebase", abort: "git rebase --abort" },
  { file: "rebase-apply", what: "a rebase", abort: "git rebase --abort" },
  { file: "BISECT_LOG", what: "a bisect", abort: "git bisect reset" },
]

async function inProgressOperation(
  repo: Repo,
): Promise<{ what: string; abort: string } | null> {
  const args = ["rev-parse", "--path-format=absolute"]
  for (const op of OPERATIONS) args.push("--git-path", op.file)
  const r = await runGit(repo.root, args)
  // Not "assume nothing is in progress": this guard going quiet is how a merge
  // gets inherited by the agent's next commit.
  if (r.code !== 0) {
    throw new Error(`could not read the state of ${repo.root}: ${gitSaid(r)}`)
  }
  const paths = r.out.trim().split("\n")
  for (const [i, op] of OPERATIONS.entries()) {
    const path = paths[i]
    if (path === undefined || path === "") continue
    if (await exists(path)) return { what: op.what, abort: op.abort }
  }
  return null
}

async function exists(path: string): Promise<boolean> {
  try {
    await realpath(path)
    return true
  } catch {
    return false
  }
}

/** A file's contents, or null when it is not there. Used for the lock and for
 * `/proc`, where "absent" is an ordinary answer rather than an error. */
async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8")
  } catch {
    return null
  }
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`
}

function isErrno(e: unknown, code: string): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === code
}
