// Hermetic git: the user's ~/.gitconfig can set init.defaultBranch, core.hooksPath,
// commit.gpgsign, status.showUntrackedFiles or diff.ignoreSubmodules, and every one of
// those would change what these tests measure. The vars are read by git at spawn time,
// not at module load, so setting them here reaches both our own calls and src/git.ts's.
process.env.GIT_CONFIG_GLOBAL = "/dev/null"
process.env.GIT_CONFIG_SYSTEM = "/dev/null"
process.env.GIT_CONFIG_NOSYSTEM = "1"
process.env.GIT_AUTHOR_NAME = "kantan test"
process.env.GIT_AUTHOR_EMAIL = "test@example.invalid"
process.env.GIT_COMMITTER_NAME = "kantan test"
process.env.GIT_COMMITTER_EMAIL = "test@example.invalid"

import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import { realpath } from "node:fs/promises"
import {
  acquireRunLock,
  createTaskBranch,
  isMergedIntoBase,
  recordBaseBranch,
  releaseRunLock,
  requireCleanTreeForNewRun,
  requireUsableRepo,
  resumeTaskBranch,
  returnToBase,
  runLockPath,
  taskBranchName,
} from "../src/git"
import type { LockRecord, Repo } from "../src/git"

// --- The lock, first: a lock that cannot be reclaimed locks a repo forever ---

test("a stale lock whose owning process is gone is reclaimed, and names what it reclaimed", async () => {
  const { repo } = await repoWithCommit()
  await forgeLock(repo, { pid: await deadPid(), nonce: "a-server-that-died" })

  const lock = await acquireRunLock(repo, { runId: "run-2", branch: "orch/t2-aaaaaaaa" })

  expect(lock.reclaimed?.nonce).toBe("a-server-that-died")
  expect(lock.record.runId).toBe("run-2")
})

test("a live lock is refused, and the error names the pid, the run and the lock file", async () => {
  const { repo } = await repoWithCommit()
  await acquireRunLock(repo, { runId: "run-1", branch: "orch/t1-aaaaaaaa" })

  const second = acquireRunLock(repo, { runId: "run-2", branch: "orch/t2-bbbbbbbb" })

  const message = await messageOf(second)
  expect(message).toContain(String(process.pid))
  expect(message).toContain("run-1")
  expect(message).toContain(runLockPath(repo))
})

test("a lock whose pid has since been reused by another process is reclaimed", async () => {
  // The pid is alive - it is ours - but it is not the process that took the lock.
  const { repo } = await repoWithCommit()
  await forgeLock(repo, { processStart: "1" })

  const lock = await acquireRunLock(repo, { runId: "run-2", branch: "orch/t2-aaaaaaaa" })

  expect(lock.reclaimed).not.toBeNull()
})

// The boot id comes from /proc, so the check it feeds does not exist off Linux.
const HAS_BOOT_ID = await Bun.file("/proc/sys/kernel/random/boot_id").exists()

test.skipIf(!HAS_BOOT_ID)("a lock written before the last reboot is reclaimed", async () => {
  // After a reboot the pid may be live and its start time may even match, because
  // start time is measured from boot. The boot id is what breaks the tie.
  const { repo } = await repoWithCommit()
  await forgeLock(repo, { bootId: "00000000-0000-0000-0000-000000000000" })

  const lock = await acquireRunLock(repo, { runId: "run-2", branch: "orch/t2-aaaaaaaa" })

  expect(lock.reclaimed).not.toBeNull()
})

test("a lock left by an earlier incarnation of this very process is reclaimed", async () => {
  // Probed: `bun --watch` reloads in the same pid with the same start time, so pid
  // plus start time would read the restarted server's own lock as live forever.
  const { repo } = await repoWithCommit()
  await forgeLock(repo, { nonce: "before-the-watch-reload" })

  const lock = await acquireRunLock(repo, { runId: "run-2", branch: "orch/t2-aaaaaaaa" })

  expect(lock.reclaimed?.nonce).toBe("before-the-watch-reload")
})

test("a lock from another host is refused, naming the file to remove by hand", async () => {
  const { repo } = await repoWithCommit()
  await forgeLock(repo, { host: "someone-elses-laptop" })

  const message = await messageOf(acquireRunLock(repo, { runId: "r", branch: "orch/t-aaaaaaaa" }))
  expect(message).toContain("someone-elses-laptop")
  expect(message).toContain(runLockPath(repo))
  expect(message).toMatch(/rm /)
})

// A live process this user may not signal, if the environment has one. Running
// as root, or as pid 1 in a container, there is none, and the branch it covers
// cannot be reached at all - so the test is skipped rather than made vacuous.
const UNSIGNALLABLE_PID = [1, 2, 3].find((pid) => {
  if (pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (e) {
    return (e as { code?: unknown }).code === "EPERM"
  }
})

test.skipIf(UNSIGNALLABLE_PID === undefined)(
  "a lock held by a process this user cannot signal counts as alive",
  async () => {
    // `kill(pid, 0)` raises EPERM for a process owned by someone else. A liveness
    // check that read any error as "gone" would reclaim a lock that is still held.
    const { repo } = await repoWithCommit()
    await forgeLock(repo, {
      pid: UNSIGNALLABLE_PID,
      processStart: null,
      nonce: "owned-by-another-user",
    })

    const message = await messageOf(acquireRunLock(repo, { runId: "r", branch: "orch/t-aaaaaaaa" }))
    expect(message).toContain(runLockPath(repo))
    expect(message).toContain(`by pid ${UNSIGNALLABLE_PID} on `)
  },
)

test("a live lock whose start time cannot be read is refused rather than reclaimed", async () => {
  // Reading a live lock as stale puts two agents in one checkout; reading a stale
  // lock as live costs one `rm`, and the message spells the path out.
  const { repo } = await repoWithCommit()
  await forgeLock(repo, { processStart: null })

  const message = await messageOf(acquireRunLock(repo, { runId: "r", branch: "orch/t-aaaaaaaa" }))
  expect(message).toContain(runLockPath(repo))
})

test("a corrupt lock file is refused by path rather than silently reclaimed", async () => {
  const { repo } = await repoWithCommit()
  await writeFile(runLockPath(repo), "{ half a write")

  const message = await messageOf(acquireRunLock(repo, { runId: "r", branch: "orch/t-aaaaaaaa" }))
  expect(message).toContain(runLockPath(repo))
})

test("releasing removes the lock, so the next run can take it", async () => {
  const { repo } = await repoWithCommit()
  const lock = await acquireRunLock(repo, { runId: "run-1", branch: "orch/t1-aaaaaaaa" })

  expect(await releaseRunLock(lock)).toBe("released")
  const next = await acquireRunLock(repo, { runId: "run-2", branch: "orch/t2-bbbbbbbb" })
  expect(next.reclaimed).toBeNull()
})

test("releasing a lock another run has since taken leaves it alone", async () => {
  // The run was declared stale and reclaimed while its own process limped on. If
  // release unlinked by path, it would drop the live run's lock.
  const { repo } = await repoWithCommit()
  const lock = await acquireRunLock(repo, { runId: "run-1", branch: "orch/t1-aaaaaaaa" })
  await patchLock(repo, { runId: "run-2" })

  expect(await releaseRunLock(lock)).toBe("not ours")
  expect(await readLock(repo)).not.toBeNull()
})

test("releasing a lock retaken by a later incarnation of this run leaves it alone", async () => {
  // Same runId, different nonce: a reload reclaimed the lock and took it again
  // under the same run. Only the nonce tells the two holders apart.
  const { repo } = await repoWithCommit()
  const lock = await acquireRunLock(repo, { runId: "run-1", branch: "orch/t1-aaaaaaaa" })
  await patchLock(repo, { nonce: "a-later-incarnation" })

  expect(await releaseRunLock(lock)).toBe("not ours")
  expect(await readLock(repo)).not.toBeNull()
})

test("releasing an already-removed lock is not an error", async () => {
  const { repo } = await repoWithCommit()
  const lock = await acquireRunLock(repo, { runId: "run-1", branch: "orch/t1-aaaaaaaa" })
  await rm(runLockPath(repo))

  expect(await releaseRunLock(lock)).toBe("already gone")
})

test("the lock lives in the git dir, so no status shows it and no agent can commit it", async () => {
  const { dir, repo } = await repoWithCommit()
  await acquireRunLock(repo, { runId: "run-1", branch: "orch/t1-aaaaaaaa" })

  expect(runLockPath(repo).startsWith(repo.gitDir + sep)).toBe(true)
  expect(await git(dir, "status", "--porcelain")).toBe("")
  await expect(requireCleanTreeForNewRun(repo)).resolves.toBeUndefined()
})

test("two symlinked spellings of one repo contend for the same lock", async () => {
  // src/projects.ts normalises `path` lexically only, so one repo can be two
  // records. One active run per project has to mean per repository.
  const { dir, repo } = await repoWithCommit()
  const link = join(await mkdtemp(join(tmpdir(), "orch-git-")), "same-repo")
  await symlink(dir, link)

  await acquireRunLock(repo, { runId: "run-1", branch: "orch/t1-aaaaaaaa" })
  const viaLink = await requireUsableRepo(link)

  expect(runLockPath(viaLink)).toBe(runLockPath(repo))
  await expect(acquireRunLock(viaLink, { runId: "r2", branch: "orch/t2-b" })).rejects.toThrow()
})

// --- Is this path a usable git repository at all? ---

test("a path that does not exist is refused, naming the path", async () => {
  const message = await messageOf(requireUsableRepo("/tmp/kantan-no-such-directory-9e3f"))
  expect(message).toContain("/tmp/kantan-no-such-directory-9e3f")
})

test("a path that exists but is not a repo is refused, naming the path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orch-git-"))
  const message = await messageOf(requireUsableRepo(dir))
  expect(message).toContain(dir)
})

test("a non-repo directory nested inside a repo does not resolve to the parent repo", async () => {
  // A dotfiles repo at $HOME makes every untracked directory under it look like a
  // repo to `git rev-parse`. Operating on the parent would be operating on $HOME.
  const { dir } = await repoWithCommit()
  const inner = join(dir, "not-a-repo")
  await mkdir(inner)

  const message = await messageOf(requireUsableRepo(inner))
  expect(message).toContain(inner)
  expect(message).toContain(await realpath(dir))
})

test("a subdirectory of a repo is refused, and the error names the root", async () => {
  const { dir } = await repoWithCommit()
  await mkdir(join(dir, "app"))
  await writeFile(join(dir, "app", "f.txt"), "x")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-m", "app")

  const message = await messageOf(requireUsableRepo(join(dir, "app")))
  expect(message).toContain(await realpath(dir))
})

test("a bare repo is refused: there is no working tree for an agent to edit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orch-git-"))
  const bare = join(dir, "x.git")
  await git(dir, "init", "--bare", "-b", "main", bare)

  const message = await messageOf(requireUsableRepo(bare))
  expect(message).toContain("bare")
})

test("a repo with no commits yet is refused, because a task branch needs a base commit", async () => {
  // `git branch --show-current` answers "main" on an unborn HEAD, so a base
  // recorder that trusts it gets a name that cannot be branched from.
  const dir = await mkdtemp(join(tmpdir(), "orch-git-"))
  await git(dir, "init", "-b", "main", ".")

  const message = await messageOf(requireUsableRepo(dir))
  expect(message).toMatch(/no commits/i)
})

test("a repo reached through a symlink reports its real root, so it is one repo", async () => {
  const { dir, repo } = await repoWithCommit()
  const link = join(await mkdtemp(join(tmpdir(), "orch-git-")), "same-repo")
  await symlink(dir, link)

  expect((await requireUsableRepo(link)).root).toBe(repo.root)
})

// --- What is the base branch, recorded at run start? ---

test("records the base branch at run start", async () => {
  const { dir, repo } = await repoWithCommit()
  await git(dir, "switch", "-c", "develop")

  expect(await recordBaseBranch(repo)).toBe("develop")
})

test("a detached HEAD is refused as a base, naming the commit and the fix", async () => {
  // `git branch --show-current` exits 0 and prints nothing here, so the string is
  // what has to be tested. Refusing also covers a stopped rebase or bisect.
  const { dir, repo } = await repoWithCommit()
  await git(dir, "switch", "--detach", "HEAD")

  const message = await messageOf(recordBaseBranch(repo))
  expect(message).toMatch(/detached/i)
  expect(message).toContain("git switch")
})

test("a checkout left on an orch/ branch is refused as a base, so tasks cannot stack", async () => {
  // This is the crash case: a run that never returned to base. Recording orch/T1
  // as the base is how run 2 silently branches off run 1.
  const { dir, repo } = await repoWithCommit()
  await git(dir, "switch", "-c", "orch/t1-aaaaaaaa")

  const message = await messageOf(recordBaseBranch(repo))
  expect(message).toContain("orch/t1-aaaaaaaa")
})

// --- Is the working tree clean enough to start a NEW run? ---

test("a clean repo is clean enough to start a run", async () => {
  const { repo } = await repoWithCommit()
  await expect(requireCleanTreeForNewRun(repo)).resolves.toBeUndefined()
})

test("a modified tracked file blocks a new run, and the error names the file", async () => {
  const { dir, repo } = await repoWithCommit()
  await writeFile(join(dir, "a.txt"), "someone's unsaved refactor")

  const message = await messageOf(requireCleanTreeForNewRun(repo))
  expect(message).toContain("a.txt")
  expect(message).toContain("git stash")
})

test("a staged change blocks a new run, and the error names the file", async () => {
  const { dir, repo } = await repoWithCommit()
  await writeFile(join(dir, "staged.txt"), "new")
  await git(dir, "add", "staged.txt")

  expect(await messageOf(requireCleanTreeForNewRun(repo))).toContain("staged.txt")
})

test("a deleted tracked file blocks a new run, and the error names the file", async () => {
  const { dir, repo } = await repoWithCommit()
  await git(dir, "rm", "a.txt")

  expect(await messageOf(requireCleanTreeForNewRun(repo))).toContain("a.txt")
})

test("a rename blocks a new run, naming both paths and no phantom third entry", async () => {
  // `--porcelain -z` sends a rename as two NUL-separated fields. A parser that
  // reads every field as an entry invents a path with a garbled status code.
  const { dir, repo } = await repoWithCommit()
  await git(dir, "mv", "a.txt", "b.txt")

  const message = await messageOf(requireCleanTreeForNewRun(repo))
  expect(message).toContain("a.txt")
  expect(message).toContain("b.txt")
  expect(message).toMatch(/1 file|1 path/)
})

test("an untracked file blocks a new run, and the error says stash -u", async () => {
  // The mechanism: the agent commits it on orch/<slug>, returning to base then
  // takes it out of the working tree, and `git branch -D` as a rollback loses it.
  // A plain `git stash` leaves it, so the user would retry into the same refusal.
  const { dir, repo } = await repoWithCommit()
  await writeFile(join(dir, "notes.md"), "a person's scratch file")

  const message = await messageOf(requireCleanTreeForNewRun(repo))
  expect(message).toContain("notes.md")
  expect(message).toContain("git stash -u")
})

test("ignored build artefacts do not block a new run", async () => {
  const { dir, repo } = await repoWithCommit()
  await mkdir(join(dir, "build"))
  await writeFile(join(dir, "build", "out.o"), "artefact")
  await writeFile(join(dir, "node_modules.txt"), "x")

  await expect(requireCleanTreeForNewRun(repo)).resolves.toBeUndefined()
})

test("an unmerged conflict blocks a new run with its own message, not advice to stash", async () => {
  const { dir, repo } = await repoWithCommit()
  await conflict(dir)

  const message = await messageOf(requireCleanTreeForNewRun(repo))
  expect(message).toContain("a.txt")
  expect(message).toMatch(/conflict/i)
})

test("a resolved merge with a clean index still blocks: MERGE_HEAD is still set", async () => {
  // Resolved back to HEAD's own content, `git status --porcelain` prints
  // nothing at all (probed), and the agent's next commit would silently become
  // a merge commit carrying the user's MERGE_HEAD as a second parent.
  const { dir, repo } = await repoWithCommit()
  await conflict(dir)
  await writeFile(join(dir, "a.txt"), "ours\n")
  await git(dir, "add", "a.txt")

  expect(await git(dir, "status", "--porcelain")).toBe("")
  const message = await messageOf(requireCleanTreeForNewRun(repo))
  expect(message).toMatch(/merge/i)
  expect(message).toContain("git merge --abort")
})

test("status.showUntrackedFiles=no cannot blind the dirty check", async () => {
  const { dir, repo } = await repoWithCommit()
  await git(dir, "config", "status.showUntrackedFiles", "no")
  await writeFile(join(dir, "notes.md"), "scratch")

  expect(await git(dir, "status", "--porcelain")).toBe("")
  expect(await messageOf(requireCleanTreeForNewRun(repo))).toContain("notes.md")
})

test("a submodule with modified content blocks, and no config can blind the check", async () => {
  // Probed: diff.ignoreSubmodules=all and .gitmodules submodule.<n>.ignore=all
  // each make a plain `git status --porcelain` print nothing for the submodule.
  const { dir, repo } = await repoWithSubmodule()
  await git(dir, "config", "diff.ignoreSubmodules", "all")
  await git(dir, "config", "-f", ".gitmodules", "submodule.sub.ignore", "all")
  await git(dir, "commit", "-am", "ignore the submodule")
  await writeFile(join(dir, "sub", "i.txt"), "somebody's edit inside the submodule")

  expect(await git(dir, "status", "--porcelain")).toBe("")
  expect(await messageOf(requireCleanTreeForNewRun(repo))).toContain("sub")
})

test("a submodule holding only untracked content does not block", async () => {
  // Build output inside a vendored repo. The superproject cannot commit it, so
  // none of the mechanism that makes an untracked file dangerous applies.
  const { dir, repo } = await repoWithSubmodule()
  await writeFile(join(dir, "sub", "build.log"), "artefact")

  expect(await git(dir, "status", "--porcelain")).toContain("sub")
  await expect(requireCleanTreeForNewRun(repo)).resolves.toBeUndefined()
})

test("the dirty-file list is capped rather than printing a whole repo", async () => {
  const { dir, repo } = await repoWithCommit()
  for (let i = 0; i < 30; i++) await writeFile(join(dir, `f${i}.txt`), "x")

  const message = await messageOf(requireCleanTreeForNewRun(repo))
  expect(message).toMatch(/more/)
  expect(message.split("\n").length).toBeLessThan(20)
})

// --- Slugifying a task into a branch name ---

test("every branch name git could refuse is one git accepts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orch-git-"))
  await git(dir, "init", "-b", "main", ".")
  const refused: string[] = []
  for (const [feature, ref] of NASTY) {
    const from = `${JSON.stringify(feature)} + ${JSON.stringify(ref)}`
    const name = taskBranchName({ feature, ref })
    // git check-ref-format is the oracle: it is the rule, not a copy of it.
    if ((await gitExit(dir, "check-ref-format", `refs/heads/${name}`)) !== 0) {
      refused.push(`${from} -> ${name}: check-ref-format refused it`)
    }
    if (!name.startsWith("orch/")) refused.push(`${from} -> ${name}: not under orch/`)
    // One component under orch/, or orch/t1 and orch/t1/sub become a D/F conflict.
    if (name.slice("orch/".length).includes("/")) {
      refused.push(`${from} -> ${name}: more than one component`)
    }
    // Lowercase only: a loose ref is a file, and macOS and /mnt/c fold case.
    if (name !== name.toLowerCase()) refused.push(`${from} -> ${name}: not lowercase`)
    // A branch name that is also usable as an argument and a filename.
    if (!/^orch\/[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
      refused.push(`${from} -> ${name}: outside the allowlist`)
    }
  }
  expect(refused).toEqual([])
})

test("two tasks whose prose collapses to the same slug get different branches", async () => {
  const collide: [string, string][] = [
    ["docs/importer.md", "T1"],
    ["docs/importer.md", "T2"],
    ["docs/importer!!.md", "T1"],
    ["docs/importer--.md", "T1"],
    ["other/importer.md", "T1"],
    ["docs/مستورد.md", "T1"],
    ["docs/🎉.md", "T1"],
    ["docs/importer.md", "T1x"],
  ]
  const names = collide.map(([feature, ref]) => taskBranchName({ feature, ref }))
  expect(new Set(names).size).toBe(collide.length)
})

test("the same task always gets the same branch, and the task's prose is not in it", async () => {
  // A typo fix in the task text must not rename the branch: the next run would
  // create a second one and orphan the first one's commits.
  const a = taskBranchName({ feature: "docs/importer.md", ref: "T2" })
  const b = taskBranchName({ feature: "./docs/./importer.md", ref: "T2" })
  expect(a).toBe(b)
  expect(a).toMatch(/^orch\/importer-t2-[0-9a-f]{8}$/)
})

test("a task with no ref is refused rather than sharing a branch with its neighbours", async () => {
  expect(() => taskBranchName({ feature: "docs/importer.md", ref: "  " })).toThrow(/ref/)
})

test("an absolute feature path is refused, or moving the repo would rename every branch", async () => {
  expect(() => taskBranchName({ feature: "/home/me/repo/docs/f.md", ref: "T1" })).toThrow()
})

// --- Create or resume orch/<task-slug> from the recorded base ---

test("a clean repo creates orch/<task-slug> and checks it out", async () => {
  const { dir, repo } = await repoWithCommit()
  const base = await recordBaseBranch(repo)
  const branch = taskBranchName({ feature: "docs/f.md", ref: "T1" })

  await createTaskBranch(repo, branch, base)

  expect(await git(dir, "branch", "--show-current")).toBe(branch)
})

test("task 2 branches from base, not from orch/T1", async () => {
  const { dir, repo } = await repoWithCommit()
  const base = await recordBaseBranch(repo)
  const t1 = taskBranchName({ feature: "docs/f.md", ref: "T1" })
  const t2 = taskBranchName({ feature: "docs/f.md", ref: "T2" })

  await createTaskBranch(repo, t1, base)
  await writeFile(join(dir, "t1.txt"), "t1 work")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-m", "t1")
  // The run crashed before returning to base, so the checkout is still on orch/T1.
  await createTaskBranch(repo, t2, base)

  expect(await git(dir, "merge-base", t2, t1)).toBe(await git(dir, "rev-parse", base))
  expect(await git(dir, "rev-parse", t2)).toBe(await git(dir, "rev-parse", base))
})

test("a new run refuses a task branch that already has commits ahead of base", async () => {
  // This is "done, unmerged": the tick lives on orch/<slug>, so the working-tree
  // markdown reads the task as open and the tree would offer to start it again.
  const { dir, repo } = await repoWithCommit()
  const base = await recordBaseBranch(repo)
  const branch = taskBranchName({ feature: "docs/f.md", ref: "T1" })
  await createTaskBranch(repo, branch, base)
  await writeFile(join(dir, "t1.txt"), "t1 work")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-m", "t1")
  const tip = await git(dir, "rev-parse", branch)
  await returnToBase(repo, base)

  const message = await messageOf(createTaskBranch(repo, branch, base))
  expect(message).toContain(branch)
  expect(message).toContain("git branch -D")
  expect(await git(dir, "rev-parse", branch)).toBe(tip)
})

test("two tasks whose slugs collide get two branches, and the first one's tip is untouched", async () => {
  // The pure-function injectivity test above says the names differ; this says
  // the repo agrees, which is what stops two tasks overwriting each other.
  const { dir, repo } = await repoWithCommit()
  const base = await recordBaseBranch(repo)
  const a = taskBranchName({ feature: "docs/importer!!.md", ref: "T1" })
  const b = taskBranchName({ feature: "docs/importer--.md", ref: "T1" })
  expect(a).not.toBe(b)

  await createTaskBranch(repo, a, base)
  await writeFile(join(dir, "t1.txt"), "task A's work")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-m", "a")
  const tipOfA = await git(dir, "rev-parse", a)
  await returnToBase(repo, base)

  await createTaskBranch(repo, b, base)

  expect(await git(dir, "rev-parse", a)).toBe(tipOfA)
  expect(await git(dir, "rev-parse", b)).toBe(await git(dir, "rev-parse", base))
})

test("a new run refuses an existing task branch even when it is merged into base", async () => {
  // Its tip can be an ancestor of base, so checking it out would hand the agent a
  // stale tree. Deleting the branch is the documented way to start the task over.
  const { dir, repo } = await repoWithCommit()
  const base = await recordBaseBranch(repo)
  const branch = taskBranchName({ feature: "docs/f.md", ref: "T1" })
  await createTaskBranch(repo, branch, base)
  await returnToBase(repo, base)
  await writeFile(join(dir, "later.txt"), "base moved on")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-m", "later")

  expect(await messageOf(createTaskBranch(repo, branch, base))).toContain("git branch -D")
})

test("a branch that is not a task branch is refused, so a base can never be the target", async () => {
  const { repo } = await repoWithCommit()
  await expect(createTaskBranch(repo, "main", "main")).rejects.toThrow(/orch\//)
  await expect(resumeTaskBranch(repo, "main")).rejects.toThrow(/orch\//)
})

test("resuming a run switches to its recorded branch", async () => {
  const { dir, repo } = await repoWithCommit()
  const base = await recordBaseBranch(repo)
  const branch = taskBranchName({ feature: "docs/f.md", ref: "T1" })
  await createTaskBranch(repo, branch, base)
  await returnToBase(repo, base)

  await resumeTaskBranch(repo, branch)

  expect(await git(dir, "branch", "--show-current")).toBe(branch)
})

test("the dirty check applies to new runs but never to resuming a run on its own branch", async () => {
  // A SIGTERM leaves half-written files. Resuming must not be blocked by them.
  const { dir, repo } = await repoWithCommit()
  const base = await recordBaseBranch(repo)
  const branch = taskBranchName({ feature: "docs/f.md", ref: "T1" })
  await createTaskBranch(repo, branch, base)
  await writeFile(join(dir, "a.txt"), "half-written when the server was killed")
  await writeFile(join(dir, "scratch.txt"), "untracked, also half-written")

  await resumeTaskBranch(repo, branch)

  expect(await git(dir, "branch", "--show-current")).toBe(branch)
  await expect(requireCleanTreeForNewRun(repo)).rejects.toThrow()
})

test("resuming from a different branch IS blocked by a dirty tree", async () => {
  // The exemption above is for a run's own branch. Here the dirty files are
  // somebody else's, and `git switch` would carry them onto the task branch for
  // the agent to commit.
  const { dir, repo } = await repoWithCommit()
  const base = await recordBaseBranch(repo)
  const branch = taskBranchName({ feature: "docs/f.md", ref: "T1" })
  await createTaskBranch(repo, branch, base)
  await returnToBase(repo, base)
  await writeFile(join(dir, "a.txt"), "somebody's unrelated edit")

  const message = await messageOf(resumeTaskBranch(repo, branch))
  expect(message).toContain("a.txt")
  expect(await git(dir, "branch", "--show-current")).toBe(base)
})

test("an operation left in progress blocks a resume even on the run's own branch", async () => {
  // A merge resolved back to HEAD's content leaves the tree looking clean, and
  // the own-branch exemption must not wave that through.
  const { dir, repo } = await repoWithCommit()
  const base = await recordBaseBranch(repo)
  const branch = taskBranchName({ feature: "docs/f.md", ref: "T1" })
  await createTaskBranch(repo, branch, base)
  await git(dir, "switch", "-c", "theirs")
  await writeFile(join(dir, "a.txt"), "theirs\n")
  await git(dir, "commit", "-am", "theirs")
  await git(dir, "switch", branch)
  await writeFile(join(dir, "a.txt"), "ours\n")
  await git(dir, "commit", "-am", "ours")
  await gitExit(dir, "merge", "theirs")
  await writeFile(join(dir, "a.txt"), "ours\n")
  await git(dir, "add", "a.txt")

  expect(await git(dir, "status", "--porcelain")).toBe("")
  expect(await messageOf(resumeTaskBranch(repo, branch))).toMatch(/merge/i)
})

test("a tag sharing a branch's name does not defeat the branch comparisons", async () => {
  // Probed: `symbolic-ref --short HEAD` prints `heads/orch/...` when a tag of
  // the same name exists, which would silently unmatch every comparison here -
  // including the one that refuses an orch/ branch as a base.
  const { dir, repo } = await repoWithCommit()
  const base = await recordBaseBranch(repo)
  const branch = taskBranchName({ feature: "docs/f.md", ref: "T1" })
  await createTaskBranch(repo, branch, base)
  await git(dir, "tag", branch, "HEAD")
  await writeFile(join(dir, "a.txt"), "half-written when the server was killed")

  expect(await messageOf(recordBaseBranch(repo))).toContain(branch)
  await resumeTaskBranch(repo, branch) // still the run's own branch: exempt
  expect(await git(dir, "branch", "--show-current")).toBe(branch)
})

test("resuming a run whose branch was deleted says so rather than creating one", async () => {
  const { repo } = await repoWithCommit()
  const message = await messageOf(resumeTaskBranch(repo, "orch/t9-deadbeef"))
  expect(message).toContain("orch/t9-deadbeef")
})

test("resuming never invents a branch from a remote-tracking one", async () => {
  // `git switch <name>` DWIMs a missing branch into existence from origin/<name>.
  // A resume that did that would start a run on somebody else's code.
  const { dir, repo } = await repoWithCommit()
  // Probed: the DWIM only fires when the remote is configured, so a test with a
  // bare remote-tracking ref and no `remote.origin` proves nothing.
  await git(dir, "remote", "add", "origin", "https://example.invalid/repo.git")
  await git(dir, "update-ref", "refs/remotes/origin/orch/t9-deadbeef", "HEAD")

  await expect(resumeTaskBranch(repo, "orch/t9-deadbeef")).rejects.toThrow()
  expect(await git(dir, "branch", "--show-current")).toBe("main")
  expect(await gitExit(dir, "rev-parse", "--verify", "refs/heads/orch/t9-deadbeef")).not.toBe(0)
})

// --- Return the checkout to base ---

test("returns the checkout to base when a run completes", async () => {
  const { dir, repo } = await repoWithCommit()
  const base = await recordBaseBranch(repo)
  await createTaskBranch(repo, taskBranchName({ feature: "docs/f.md", ref: "T1" }), base)

  await returnToBase(repo, base)

  expect(await git(dir, "branch", "--show-current")).toBe(base)
})

test("the task's tick lives on the branch until merged, so base still reads it as open", async () => {
  const { dir, repo } = await repoWithCommit()
  const base = await recordBaseBranch(repo)
  const branch = taskBranchName({ feature: "docs/f.md", ref: "T1" })
  await createTaskBranch(repo, branch, base)
  await writeFile(join(dir, "a.txt"), "- [x] T1 done\n")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-m", "tick T1")

  await returnToBase(repo, base)

  expect(await readFile(join(dir, "a.txt"), "utf8")).not.toContain("[x]")
  expect(await isMergedIntoBase(repo, branch, base)).toBe(false)
})

test("returning to base with a dirty tree is refused, and stays on the branch", async () => {
  // `git switch` carries uncommitted modifications and untracked files across, so
  // a silent return would move the agent's half-finished work onto base.
  const { dir, repo } = await repoWithCommit()
  const base = await recordBaseBranch(repo)
  const branch = taskBranchName({ feature: "docs/f.md", ref: "T1" })
  await createTaskBranch(repo, branch, base)
  await writeFile(join(dir, "a.txt"), "uncommitted")

  await expect(returnToBase(repo, base)).rejects.toThrow()
  expect(await git(dir, "branch", "--show-current")).toBe(branch)
})

// --- Is a branch merged into base? ---

test("a branch merged into base reports merged", async () => {
  const { dir, repo } = await repoWithCommit()
  const base = await recordBaseBranch(repo)
  const branch = taskBranchName({ feature: "docs/f.md", ref: "T1" })
  await createTaskBranch(repo, branch, base)
  await writeFile(join(dir, "t1.txt"), "work")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-m", "t1")
  await returnToBase(repo, base)
  await git(dir, "merge", "--no-ff", "-m", "merge t1", branch)

  expect(await isMergedIntoBase(repo, branch, base)).toBe(true)
})

test("an unmerged branch reports unmerged", async () => {
  const { dir, repo } = await repoWithCommit()
  const base = await recordBaseBranch(repo)
  const branch = taskBranchName({ feature: "docs/f.md", ref: "T1" })
  await createTaskBranch(repo, branch, base)
  await writeFile(join(dir, "t1.txt"), "work")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-m", "t1")

  expect(await isMergedIntoBase(repo, branch, base)).toBe(false)
})

test("a missing branch throws rather than reading as unmerged", async () => {
  // merge-base exits non-zero for both "not an ancestor" and "no such ref", and
  // reporting a deleted branch as unmerged would wedge the task forever.
  const { repo } = await repoWithCommit()
  const base = await recordBaseBranch(repo)

  expect(await messageOf(isMergedIntoBase(repo, "orch/gone-deadbeef", base))).toContain(
    "orch/gone-deadbeef",
  )
})

// --- Helpers -----------------------------------------------------------------

/** Task identities whose slug has to survive git's refname rules. The feature
 * path carries the nasty bytes because a filename can hold almost any of them. */
const NASTY: [string, string][] = [
  ["", "T1"],
  [".", "T1"],
  ["..", "T1"],
  ["...", "T1"],
  ["a..b.md", "T1"],
  ["~^:?*[\\.md", "T1"],
  ["a b c.md", "T1"],
  ["a\tb.md", "T1"],
  ["a\u0000b.md", "T1"],
  ["a\u0001\u001f\u007fb.md", "T1"],
  ["a@{b}.md", "T1"],
  ["@", "T1"],
  ["@@@.md", "T1"],
  ["x.lock", "T1"],
  [".lock", "T1"],
  ["a.lock.md", "T1"],
  ["./leading.md", "T1"],
  ["a//b.md", "T1"],
  ["a/./b.md", "T1"],
  [".hidden.md", "T1"],
  ["trailing.", "T1"],
  ["-leading-dash.md", "T1"],
  ["UPPER/MiXeD.md", "T1"],
  ["مستورد الفواتير.md", "T1"],
  ["🎉🎊 ship it.md", "T1"],
  ["a‍b.md", "T1"],
  ["a‏b.md", "T1"],
  ["café.md", "T1"],
  ["café.md", "T1"],
  ["!@#$%^&*()_+=|;'\",<>/?.md", "T1"],
  ["x".repeat(400) + ".md", "T1"],
  ["ok.md", "T999999"],
  ["ok.md", "~^:?*[\\"],
  ["ok.md", "@{"],
  ["ok.md", "x".repeat(200)],
  ["ok.md", "🎉"],
  ["ok.md", "T1/sub"],
  ["ok.md", "a/b/c"],
  ["ok.md", "/T1"],
  ["ok.md", "T1.lock"],
  ["ok.md", ".T1"],
]

/** A repo with one commit on `main`, a .gitignore, and no global config in play. */
async function repoWithCommit(): Promise<{ dir: string; repo: Repo }> {
  const dir = await mkdtemp(join(tmpdir(), "orch-git-"))
  await git(dir, "init", "-b", "main", ".")
  await writeFile(join(dir, "a.txt"), "- [ ] T1 do the thing\n")
  await writeFile(join(dir, ".gitignore"), "build/\nnode_modules.txt\n")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-m", "init")
  return { dir, repo: await requireUsableRepo(dir) }
}

/** A clean repo with one commit and a submodule at `sub`. */
async function repoWithSubmodule(): Promise<{ dir: string; repo: Repo }> {
  const inner = await mkdtemp(join(tmpdir(), "orch-git-inner-"))
  await git(inner, "init", "-b", "main", ".")
  await writeFile(join(inner, "i.txt"), "inner\n")
  await git(inner, "add", "-A")
  await git(inner, "commit", "-m", "inner")

  const { dir, repo } = await repoWithCommit()
  // A file:// submodule needs this since the CVE-2022-39253 fix.
  await git(dir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "sub")
  await git(dir, "commit", "-m", "add sub")
  return { dir, repo }
}

/** Leaves `dir` mid-merge with a conflict in a.txt. */
async function conflict(dir: string): Promise<void> {
  await git(dir, "switch", "-c", "other")
  await writeFile(join(dir, "a.txt"), "theirs\n")
  await git(dir, "commit", "-am", "theirs")
  await git(dir, "switch", "main")
  await writeFile(join(dir, "a.txt"), "ours\n")
  await git(dir, "commit", "-am", "ours")
  await gitExit(dir, "merge", "other")
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  if (code !== 0) throw new Error(`git ${args.join(" ")} in ${cwd} exited ${code}: ${err}`)
  return out.trim()
}

async function gitExit(cwd: string, ...args: string[]): Promise<number> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" })
  return await p.exited
}

/** The message of a rejected promise, so a test can assert on what it says
 * rather than only that it threw. */
async function messageOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
  throw new Error("expected a rejection, got none")
}

/** A pid that is certainly gone: a child that has already exited. The kernel
 * will not reuse it for a long while, and the fingerprint covers it if it does. */
async function deadPid(): Promise<number> {
  const p = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" })
  const pid = p.pid
  await p.exited
  return pid
}

/** Writes a lock file the way a crashed server would have left one, by taking a
 * real lock and then overriding fields. Using the real writer keeps the forged
 * record in step with the record shape. */
async function forgeLock(repo: Repo, patch: Partial<LockRecord>): Promise<void> {
  const lock = await acquireRunLock(repo, { runId: "run-1", branch: "orch/t1-aaaaaaaa" })
  void lock
  await patchLock(repo, patch)
}

async function patchLock(repo: Repo, patch: Partial<LockRecord>): Promise<void> {
  const record = await readLock(repo)
  if (record === null) throw new Error("no lock to patch")
  await writeFile(runLockPath(repo), JSON.stringify({ ...record, ...patch }, null, 2))
}

async function readLock(repo: Repo): Promise<LockRecord | null> {
  try {
    return JSON.parse(await readFile(runLockPath(repo), "utf8")) as LockRecord
  } catch {
    return null
  }
}
