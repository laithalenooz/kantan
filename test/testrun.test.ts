import { expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaults } from "../src/projects"
import type { Project } from "../src/projects"
import { MAX_OUTPUT_BYTES, TIMEOUT_EXIT_CODE, runTests } from "../src/testrun"

/**
 * A throwaway project in /tmp whose `testCmd` is a script the project owns.
 *
 * The command is **relative** on purpose: `./run-tests.sh` only resolves if the
 * process really ran in `project.path`. Nothing here runs this repository's own
 * suite - a test runner that runs its own suite to see whether it runs suites
 * cannot distinguish its own failures from the ones it is reporting.
 */
async function throwaway(script: string): Promise<{ project: Project; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "kantan-testrun-"))
  const runner = join(dir, "run-tests.sh")
  await writeFile(runner, script)
  await chmod(runner, 0o755)
  await writeFile(join(dir, "marker.txt"), "ran in the project directory\n")
  return { project: defaults({ path: dir, testCmd: "./run-tests.sh" }), dir }
}

/** True once `pid` is gone. A kill is delivered asynchronously, and checking
 * once immediately after the run resolves would be a race. */
async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    if (Date.now() > deadline) return false
    await Bun.sleep(25)
  }
}

test("exit 0 is a pass, and output on stderr does not make it a failure", async () => {
  const { project } = await throwaway(
    "#!/bin/sh\n" +
      "cat marker.txt\n" +
      "echo 'Tests:  3 passed (7 assertions)'\n" +
      "echo 'Warning: --colors is deprecated' >&2\n" +
      "exit 0\n",
  )

  const r = await runTests(project)

  expect(r.exitCode).toBe(0)
  expect(r.timedOut).toBe(false)
  expect(r.stdout).toContain("3 passed")
  // Only readable from project.path, so this is the working-directory assertion.
  expect(r.stdout).toContain("ran in the project directory")
  // Runners write warnings, deprecations and progress to stderr while passing.
  // Treating stderr as evidence of failure would fail every such project.
  expect(r.stderr).toContain("--colors is deprecated")
})

test("a non-zero exit is a failure, with stderr captured too", async () => {
  const { project } = await throwaway(
    "#!/bin/sh\n" +
      "echo 'Tests:  1 failed, 2 passed'\n" +
      "echo 'FAILED  tests/ExampleTest.php::it_adds' >&2\n" +
      "exit 1\n",
  )

  const r = await runTests(project)

  expect(r.exitCode).toBe(1)
  expect(r.timedOut).toBe(false)
  expect(r.stdout).toContain("1 failed")
  // Many runners report the failures themselves on stderr, so a capture that
  // kept stdout alone would hand the stall detector an empty failure.
  expect(r.stderr).toContain("tests/ExampleTest.php::it_adds")
})

test("a testCmd that does not exist exits 127 and names the command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kantan-testrun-"))
  const project = defaults({ path: dir, testCmd: "kantan-no-such-runner --filter=Foo" })

  const r = await runTests(project)

  expect(r.exitCode).toBe(127)
  expect(r.timedOut).toBe(false)
  expect(r.stderr).toContain("kantan-no-such-runner")
})

test(
  "a hanging command is killed at the timeout and never reports a pass",
  async () => {
    // A watch-mode runner that handles SIGTERM politely and exits 0. Reporting
    // that 0 would read a run that never finished as a run that passed, which
    // is the one mistake this module exists to prevent.
    const { project } = await throwaway(
      "#!/bin/sh\ntrap 'exit 0' TERM\nwhile :; do sleep 0.2; done\n",
    )

    const r = await runTests(project, { timeoutMs: 500 })

    expect(r.timedOut).toBe(true)
    expect(r.exitCode).not.toBe(0)
    expect(r.exitCode).toBe(TIMEOUT_EXIT_CODE)
    expect(r.durationMs).toBeGreaterThanOrEqual(500)
  },
  20_000,
)

test(
  "the timeout kill reaches the whole process group, leaving no orphan",
  async () => {
    const { project, dir } = await throwaway(
      "#!/bin/sh\n" +
        "# A grandchild that ignores SIGTERM, as a dev server or file watcher can,\n" +
        "# and that inherits the stdout pipe. Killing only the direct child leaves\n" +
        "# it running and holding that pipe open.\n" +
        "( trap '' TERM; while :; do echo tick >> ticks; sleep 0.1; done ) &\n" +
        "echo $! > grandchild.pid\n" +
        "echo $$ > leader.pid\n" +
        "trap '' TERM\n" +
        "while :; do sleep 0.2; done\n",
    )

    const r = await runTests(project, { timeoutMs: 600 })
    expect(r.timedOut).toBe(true)

    // The pid runTests holds is not necessarily the pid running this script,
    // because `sh -c` may fork, and the group is what covers the difference.
    // Both pids below are ones runTests never saw.
    let leader = 0
    let grandchild = 0
    try {
      leader = Number((await readFile(join(dir, "leader.pid"), "utf8")).trim())
      grandchild = Number((await readFile(join(dir, "grandchild.pid"), "utf8")).trim())
      expect(leader).toBeGreaterThan(0)
      expect(grandchild).toBeGreaterThan(0)

      expect(await goneWithin(leader, 8_000)).toBe(true)
      expect(await goneWithin(grandchild, 8_000)).toBe(true)
      // A recycled pid could answer signal 0, so also check behaviour: the file
      // the grandchild appended to every 100ms must have stopped growing.
      const before = (await stat(join(dir, "ticks"))).size
      await Bun.sleep(400)
      expect((await stat(join(dir, "ticks"))).size).toBe(before)
    } finally {
      // Never leak a spinning shell or an endlessly appending loop out of a
      // failing test: that debris is the exact thing this test exists to
      // prevent. Each kill stands alone, so an ESRCH on one cannot skip the
      // other, and the reads above are inside the try for the same reason.
      for (const p of [leader, grandchild]) {
        if (p <= 0) continue
        try {
          process.kill(p, "SIGKILL")
        } catch {
          // Already gone, which is what the assertions above require.
        }
      }
    }
  },
  30_000,
)

test(
  "output past the cap keeps the tail and says what it dropped",
  async () => {
    const { project } = await throwaway(
      "#!/bin/sh\n" +
        "# 1.4 MiB of noise, which a failing suite full of stack traces really emits.\n" +
        "dd if=/dev/zero bs=1024 count=1400 2>/dev/null | tr '\\0' 'a'\n" +
        "echo\n" +
        "echo 'LAST LINE: 1 failed, 0 passed'\n" +
        "exit 1\n",
    )

    const r = await runTests(project)

    // The command still gets to finish and be judged on its exit code: killing
    // a verbose-but-legitimate suite would leave it unverifiable forever.
    expect(r.exitCode).toBe(1)
    // The tail is what survives. Design §3.4 hashes the tail of the output, and
    // every runner prints its summary last.
    expect(r.stdout).toContain("LAST LINE: 1 failed, 0 passed")
    const [marker = "", ...body] = r.stdout.split("\n")
    expect(marker).toContain("stdout")
    expect(marker).toContain("truncated")
    // The fixture is ASCII on purpose, so the kept tail is exactly the cap. On
    // other input the drop boundary can land inside a multi-byte character,
    // leaving orphaned continuation bytes at the head that each decode as their
    // own replacement character - a few bytes over the cap, at the one spot in
    // the output nothing reads.
    expect(Buffer.byteLength(body.join("\n"), "utf8")).toBe(MAX_OUTPUT_BYTES)
  },
  30_000,
)

test("a project.path that does not exist is refused, naming the path", async () => {
  const missing = join(tmpdir(), "kantan-testrun-definitely-not-here")
  const project = defaults({ path: missing, testCmd: "./run-tests.sh" })

  // The spawn failure the OS reports names /bin/sh, not the directory, so a
  // message that passed it through would point at the wrong thing entirely.
  await expect(runTests(project)).rejects.toThrow(/kantan-testrun-definitely-not-here/)
})

test("a project.path that is a file, not a directory, is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kantan-testrun-"))
  const file = join(dir, "not-a-directory")
  await writeFile(file, "")
  const project = defaults({ path: file, testCmd: "echo hi" })

  await expect(runTests(project)).rejects.toThrow(/not-a-directory/)
})

test("durationMs covers at least the time the command ran", async () => {
  const { project } = await throwaway("#!/bin/sh\nsleep 0.5\necho done\n")

  const r = await runTests(project)

  expect(r.exitCode).toBe(0)
  expect(r.durationMs).toBeGreaterThanOrEqual(500)
  expect(r.durationMs).toBeLessThan(10_000)
})

test("a command killed by a signal reports 128 plus the signal, never 0", async () => {
  const { project } = await throwaway("#!/bin/sh\necho 'about to be killed'\nkill -9 $$\n")

  const r = await runTests(project)

  // What a shell reports for the same death, and never 0: a suite that crashed
  // mid-run must not be indistinguishable from one that passed.
  expect(r.exitCode).toBe(137)
  expect(r.timedOut).toBe(false)
  expect(r.stdout).toContain("about to be killed")
})
