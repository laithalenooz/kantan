/**
 * The one test that spends money.
 *
 * Everything else in this suite runs against `test/fake-claude.ts`, which
 * answers from fixtures. That proves the orchestrator reads the CLI's output
 * correctly; it cannot prove the CLI still writes what the fixtures captured,
 * and the fixtures are a snapshot of one version. This test closes that gap by
 * driving one trivial task end to end on the real binary: plan, approve,
 * implement, test, done - with the checkbox ticked, the branch created and the
 * cost recorded.
 *
 *     ORCH_LIVE=1 bun test test/live/smoke.test.ts
 *
 * Skipped otherwise, so `bun run check` stays free.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createRunner } from "../../src/run.ts"
import { foldRunLog } from "../../src/runindex.ts"
import { runLogPath } from "../../src/runlog.ts"
import { defaults } from "../../src/projects.ts"
import { taskBranchName } from "../../src/git.ts"
import { claudeVersion } from "../../src/version.ts"

const LIVE = process.env.ORCH_LIVE === "1"

/**
 * The ceiling, not the target.
 *
 * The plan said "a few cents". That is the right order of magnitude for the
 * task below, but a ceiling set at the expected cost is a test that fails when
 * the model takes one more turn than last time - and it fails as
 * `waiting(blocked)`, which looks exactly like a real budget bug. So the
 * ceiling is a bound that a correct run stays well under, and the assertion is
 * on what the run actually recorded.
 */
const CEILING_USD = 3

/** How long the whole pipeline gets. Two agent turns and a test run. */
const DEADLINE_MS = 10 * 60 * 1000
const POLL_MS = 2_000

let repo = ""
let home = ""

/** A git repo with one task, whose test command fails until the task is done. */
async function scratchRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orch-live-"))
  await mkdir(join(root, "docs", "features"), { recursive: true })

  // The test command is the product's core promise: kantan branches on this
  // exit code and never on what the agent says about its own work. It must
  // fail now and pass only once the task is really done.
  await writeFile(
    join(root, "check.sh"),
    '#!/bin/sh\ntest -f hello.txt && grep -qx hello hello.txt\n',
    { mode: 0o755 },
  )
  await writeFile(
    join(root, "docs", "features", "smoke.md"),
    "# Smoke\n\n- [ ] T1 Create a file `hello.txt` in the repository root containing exactly the word `hello` and nothing else\n",
  )
  await writeFile(join(root, "README.md"), "# scratch\n")

  const git = async (...args: string[]): Promise<void> => {
    const done = Bun.spawn(["git", ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_AUTHOR_NAME: "kantan", GIT_AUTHOR_EMAIL: "kantan@example.invalid", GIT_COMMITTER_NAME: "kantan", GIT_COMMITTER_EMAIL: "kantan@example.invalid" },
    })
    const code = await done.exited
    if (code !== 0) throw new Error(`git ${args.join(" ")} exited ${code}: ${await new Response(done.stderr).text()}`)
  }
  await git("init", "-b", "main")
  await git("add", "-A")
  await git("commit", "-m", "scratch")
  return root
}

async function stateOf(runId: string, runsDir: string): Promise<string> {
  const { run } = await foldRunLog(runLogPath(runId, runsDir))
  if (run === null) return "no-header"
  return run.state.kind === "waiting" ? `waiting:${run.state.reason}` : run.state.kind
}

/** Polls the log until `want` matches, because an action resolves at the
 * transition and the work goes on for minutes afterwards. */
async function waitFor(runId: string, runsDir: string, want: (state: string) => boolean): Promise<string> {
  const until = Date.now() + DEADLINE_MS
  let last = ""
  while (Date.now() < until) {
    last = await stateOf(runId, runsDir)
    if (want(last)) return last
    if (last === "failed") throw new Error(`the run failed while waiting; last state ${last}`)
    await Bun.sleep(POLL_MS)
  }
  throw new Error(`timed out after ${DEADLINE_MS}ms; last state was ${last}`)
}

beforeAll(async () => {
  if (!LIVE) return
  repo = await scratchRepo()
  home = await mkdtemp(join(tmpdir(), "orch-live-home-"))
})

afterAll(async () => {
  if (!LIVE) return
  if (process.env.ORCH_KEEP === "1") {
    // A failed live run is expensive to reproduce, and the evidence is on disk
    // in a branch nobody can inspect once this has run.
    console.log(`kept ${repo} and ${home}`)
    return
  }
  for (const dir of [repo, home]) if (dir !== "") await rm(dir, { recursive: true, force: true })
})

describe.skipIf(!LIVE)("live smoke", () => {
  test(
    "one task, end to end, on the real binary",
    async () => {
      // Recorded on the run header, and the reason the fixtures can go stale:
      // the stream-json envelope's shape depends on it.
      const version = await claudeVersion()
      console.log(`claude ${version}`)

      const projectsFile = join(home, "projects.json")
      const runsDir = join(home, "runs")
      await mkdir(runsDir, { recursive: true })
      await writeFile(
        projectsFile,
        JSON.stringify([defaults({ path: repo, testCmd: "./check.sh", budgetUsd: CEILING_USD })], null, 2),
      )

      const runner = createRunner({ projectsFile, runsDir })
      const started = await runner.start({ projectPath: repo, featureFile: "docs/features/smoke.md", taskRef: "T1" })
      expect(started.ok).toBe(true)
      if (!started.ok) return
      const { runId } = started

      // The gate. `AskUserQuestion` does not exist headless, so a question and
      // a finished plan both exit `result/success` - the park is what tells
      // them apart, and reaching it at all is half of what this test proves.
      const parked = await waitFor(runId, runsDir, (s) => s.startsWith("waiting:") || s === "done")
      expect(parked).toBe("waiting:gate")

      const planned = await foldRunLog(runLogPath(runId, runsDir))
      expect(planned.run?.costUsd).toBeGreaterThan(0)

      const approved = await runner.approve(runId)
      expect(approved.ok).toBe(true)

      const ended = await waitFor(runId, runsDir, (s) => s === "done" || s === "failed" || s.startsWith("waiting:"))
      expect(ended).toBe("done")

      const { run } = await foldRunLog(runLogPath(runId, runsDir))
      expect(run?.header.taskRef).toBe("T1")

      /*
       * **The work is on the task branch, and the checkout is back on base.**
       *
       * The first version of this test read the working tree and failed, which
       * is the test being wrong rather than the code: `tickCheckbox` commits
       * the tick on `orch/<slug>` and `goHome` then returns the checkout to the
       * branch the run started from, because design §3.6 makes merging the
       * human's decision. So after a successful run the working tree correctly
       * shows the task *unticked* - the tick is waiting on the branch - and a
       * test that asserted otherwise was encoding a wrong mental model of what
       * "done" leaves behind.
       */
      const branch = taskBranchName({ feature: "docs/features/smoke.md", ref: "T1" })
      const show = async (path: string): Promise<string> =>
        await new Response(Bun.spawn(["git", "show", `${branch}:${path}`], { cwd: repo, stdout: "pipe", stderr: "ignore" }).stdout).text()

      // The checkbox, ticked only after the test command exited 0 - on the branch.
      expect(await show("docs/features/smoke.md")).toContain("- [x] T1")

      // The agent's own file, which is the only proof the work really happened
      // rather than being described.
      expect((await show("hello.txt")).trim()).toBe("hello")

      // And the checkout came home, leaving base untouched.
      const head = await new Response(Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, stdout: "pipe" }).stdout).text()
      expect(head.trim()).toBe("main")
      expect(await readFile(join(repo, "docs", "features", "smoke.md"), "utf8")).toContain("- [ ] T1")

      // `merged` is false until the predicate says otherwise, so a done-but-
      // unmerged task refuses a second run visibly instead of starting against
      // work that is not integrated.
      expect(run?.state).toEqual({ kind: "done", merged: false })

      // The cost: really spent, and inside the ceiling it was given.
      expect(run?.costUsd).toBeGreaterThan(0)
      expect(run?.costUsd).toBeLessThan(CEILING_USD)
      console.log(`run ${runId} cost $${run?.costUsd.toFixed(4)} of its $${CEILING_USD} ceiling`)
    },
    DEADLINE_MS + 60_000,
  )
})
