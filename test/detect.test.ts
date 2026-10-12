import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { detect, detectTestCommand } from "../src/detect"

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "kantan test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "kantan test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
}

async function git(dir: string, ...args: string[]): Promise<void> {
  const p = Bun.spawn(["git", "-C", dir, ...args], { env: GIT_ENV, stdout: "pipe", stderr: "pipe" })
  if ((await p.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(p.stderr).text()}`)
}

/** A scratch directory of its own, keyed on the pid per CLAUDE.md. */
async function scratch(): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), `orch-detect-${process.pid}-`)))
}

/** A real repo with one commit. */
async function repo(): Promise<string> {
  const dir = await scratch()
  await git(dir, "init", "-q", "-b", "main")
  await writeFile(join(dir, "README.md"), "# scratch\n")
  await git(dir, "add", "README.md")
  await git(dir, "commit", "-q", "-m", "first")
  return dir
}

/** Every sentence a detection said, flattened for matching. */
function said(checks: ReadonlyArray<{ says: ReadonlyArray<string | { mono: string }> }>): string {
  return checks.map((c) => c.says.map((p) => (typeof p === "string" ? p : p.mono)).join("")).join(" | ")
}

/* ========================================================================== */
/* detectTestCommand                                                          */
/* ========================================================================== */

/**
 * A skipping guard, so the enumeration is the test. Its dimension is **which
 * manifest exists and what it says**, and the costs are not symmetric: a wrong
 * command fails every run of that project until a human notices, while no
 * command leaves a field empty that they were going to fill anyway. So nothing
 * is inferred from a dependency, a framework or a folder name - only from a
 * declaration, or from an ecosystem that has exactly one answer.
 */
describe("detectTestCommand", () => {
  test("reads a declared npm script, and the lockfile picks the runner", async () => {
    const ROWS: ReadonlyArray<{ lock: string | null; want: string }> = [
      { lock: null, want: "npm run test" },
      { lock: "bun.lock", want: "bun run test" },
      { lock: "bun.lockb", want: "bun run test" },
      { lock: "pnpm-lock.yaml", want: "pnpm test" },
      { lock: "yarn.lock", want: "yarn test" },
    ]
    for (const { lock, want } of ROWS) {
      const dir = await scratch()
      await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }))
      if (lock !== null) await writeFile(join(dir, lock), "")
      expect(await detectTestCommand(dir), lock ?? "no lockfile").toEqual({
        testCmd: want,
        source: "package.json",
      })
    }
  })

  test("a package.json with no test script declares nothing", async () => {
    const dir = await scratch()
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }))
    expect(await detectTestCommand(dir)).toBeNull()
  })

  test("a blank test script is not a declaration", async () => {
    const dir = await scratch()
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "   " } }))
    expect(await detectTestCommand(dir)).toBeNull()
  })

  /** A broken manifest is a repo to register and fix, not a folder to refuse. */
  test("a package.json that is not valid JSON declares nothing and does not throw", async () => {
    const dir = await scratch()
    await writeFile(join(dir, "package.json"), "{ not json")
    expect(await detectTestCommand(dir)).toBeNull()
  })

  test("reads a declared composer script", async () => {
    const dir = await scratch()
    await writeFile(join(dir, "composer.json"), JSON.stringify({ scripts: { test: "pest" } }))
    expect(await detectTestCommand(dir)).toEqual({ testCmd: "composer test", source: "composer.json" })
  })

  /** The real `lms-solutions` case: a composer.json with no test script. */
  test("a composer.json with no test script declares nothing", async () => {
    const dir = await scratch()
    await writeFile(join(dir, "composer.json"), JSON.stringify({ require: { php: "^8.4" } }))
    expect(await detectTestCommand(dir)).toBeNull()
  })

  test("a Makefile target at column zero counts; an indented one does not", async () => {
    const yes = await scratch()
    await writeFile(join(yes, "Makefile"), "all:\n\techo hi\ntest:\n\techo t\n")
    expect(await detectTestCommand(yes)).toEqual({ testCmd: "make test", source: "Makefile" })

    const no = await scratch()
    // Indented, so it is a recipe line and `make test` would not reach it.
    await writeFile(join(no, "Makefile"), "all:\n\ttest: echo hi\n")
    expect(await detectTestCommand(no)).toBeNull()
  })

  /** Two ecosystems with exactly one answer, which is why the file existing
   *  is enough for these and for nothing else. */
  test("Cargo and Go are their own answer", async () => {
    const rust = await scratch()
    await writeFile(join(rust, "Cargo.toml"), "[package]\nname = \"x\"\n")
    expect(await detectTestCommand(rust)).toEqual({ testCmd: "cargo test", source: "Cargo.toml" })

    const go = await scratch()
    await writeFile(join(go, "go.mod"), "module x\n")
    expect(await detectTestCommand(go)).toEqual({ testCmd: "go test ./...", source: "go.mod" })
  })

  /** A dependency says a library is installed, not that the suite runs that
   *  way. Nothing here reads one. */
  test("a test framework in the dependencies is not a declaration", async () => {
    const dir = await scratch()
    await writeFile(join(dir, "package.json"), JSON.stringify({ devDependencies: { jest: "^29" } }))
    expect(await detectTestCommand(dir)).toBeNull()
  })

  test("manifest order decides, so a polyglot repo gets its most specific one", async () => {
    const dir = await scratch()
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }))
    await writeFile(join(dir, "Cargo.toml"), "[package]\nname = \"x\"\n")
    expect((await detectTestCommand(dir))?.source).toBe("package.json")
  })

  test("an empty folder declares nothing", async () => {
    expect(await detectTestCommand(await scratch())).toBeNull()
  })
})

/* ========================================================================== */
/* detect                                                                     */
/* ========================================================================== */

describe("detect", () => {
  test("a real repo is usable, and says what it found", async () => {
    const dir = await repo()
    await mkdir(join(dir, "docs", "features"), { recursive: true })
    await writeFile(join(dir, "docs", "features", "importer.md"), "# Importer\n\n- [ ] T1 Read the CSV\n- [x] T2 Write\n")
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }))

    const got = await detect(dir)
    expect(got.phase).toBe("done")
    expect(got.usable).toBe(true)
    expect(got.root).toBe(dir)
    expect(got.testCmd).toBe("npm run test")
    expect(got.testCmdSource).toBe("package.json")
    expect(got.taskFiles).toEqual([
      { path: "docs/features/importer.md", tasks: [{ ref: "T1", text: "Read the CSV" }, { ref: "T2", text: "Write" }] },
    ])
    expect(said(got.checks)).toContain("1 task file")
  })

  /**
   * `usable` is `requireUsableRepo`'s answer, never a count of ticks -
   * `AddRepo`'s own docstring insists, because reading the list is a second
   * implementation of the same rule. This is the case that would catch a
   * drift: every check passes except the one that decides.
   */
  test("an already-registered repo is not usable, and that is the only failing check", async () => {
    const dir = await repo()
    const got = await detect(dir, [dir])
    expect(got.usable).toBe(false)
    expect(got.checks.filter((c) => c.status === "fail")).toHaveLength(1)
    expect(said(got.checks)).toContain("already tracks this repository")
    // And it still reports what it learned: the screen is not blanked.
    expect(got.root).toBe(dir)
  })

  test("a relative path is refused before anything touches the disk", async () => {
    const got = await detect("relative/path")
    expect(got.usable).toBe(false)
    expect(got.checks).toHaveLength(1)
    expect(said(got.checks)).toContain("not an absolute path")
  })

  test("an empty path asks for one rather than checking nothing", async () => {
    for (const path of ["", "   "]) {
      const got = await detect(path)
      expect(got.usable).toBe(false)
      expect(said(got.checks)).toContain("full path to a git repository")
    }
  })

  /**
   * The sentence is git's, passed through. `src/git.ts` throws plain `Error`s,
   * and matching their prose to derive a `code` is the guess `AddRepo` refuses
   * - which is why `DetectionCheck.code` is optional.
   */
  test("a folder that is not a repository answers with git's own sentence", async () => {
    const dir = await scratch()
    const got = await detect(dir)
    expect(got.usable).toBe(false)
    expect(said(got.checks)).toContain("not a usable git repository")
    expect(got.root).toBeUndefined()
  })

  test("a path that does not exist says so, rather than talking about git", async () => {
    const got = await detect(join(await scratch(), "nope", "deeper"))
    expect(got.usable).toBe(false)
    expect(said(got.checks)).toContain("no directory at")
  })

  test("a repo with no task files is usable and says what to do next", async () => {
    const got = await detect(await repo())
    expect(got.usable).toBe(true)
    expect(got.taskFiles).toBeUndefined()
    expect(said(got.checks)).toContain("No ")
    expect(said(got.checks)).toContain("docs/features")
  })

  test("a repo with no declared command is usable and offers the opt-out", async () => {
    const got = await detect(await repo())
    expect(got.usable).toBe(true)
    expect(got.testCmd).toBeUndefined()
    expect(said(got.checks)).toContain("this project has none")
  })

  /**
   * A subdirectory is **refused**, by `requireUsableRepo` and not by this
   * module: kantan commits at the root, so a run started in a subdirectory
   * would commit somewhere the human did not point at. The sentence git.ts
   * throws already explains that and names the root to register instead, which
   * is why it is passed through verbatim.
   *
   * This is also why the `root` check in `detect` only ever fires for a
   * *symlinked* spelling: those are the one case where the root differs from
   * the path and the path is still accepted.
   */
  test("a subdirectory is refused, with the root to register named in the refusal", async () => {
    const dir = await repo()
    const sub = join(dir, "src", "deep")
    await mkdir(sub, { recursive: true })

    const got = await detect(sub)
    expect(got.usable).toBe(false)
    expect(said(got.checks)).toContain("is not the root of a git repository")
    expect(said(got.checks)).toContain(dir)
  })

  test("a repo with no commits is refused, because a task has no base to branch from", async () => {
    const dir = await scratch()
    await git(dir, "init", "-q", "-b", "main")
    const got = await detect(dir)
    expect(got.usable).toBe(false)
    expect(said(got.checks)).toContain("no commits yet")
  })

  /** A dirty tree and a detached HEAD refuse a *run*, not a registration. */
  test("uncommitted work does not stop a registration", async () => {
    const dir = await repo()
    await writeFile(join(dir, "scratch.txt"), "work in progress\n")
    const got = await detect(dir)
    expect(got.usable).toBe(true)
  })

  test("the preview is bounded, so a huge backlog is not all sent", async () => {
    const dir = await repo()
    await mkdir(join(dir, "docs", "features"), { recursive: true })
    for (let i = 0; i < 12; i++) {
      const lines = Array.from({ length: 30 }, (_, n) => `- [ ] T${n + 1} task ${n}`).join("\n")
      await writeFile(join(dir, "docs", "features", `f${i}.md`), `# F${i}\n\n${lines}\n`)
    }
    const got = await detect(dir)
    expect(got.taskFiles?.length).toBe(8)
    expect(got.taskFiles?.[0]?.tasks.length).toBe(12)
  })

  test("a line with no ref previews with a null ref rather than being dropped", async () => {
    const dir = await repo()
    await mkdir(join(dir, "docs", "features"), { recursive: true })
    await writeFile(join(dir, "docs", "features", "x.md"), "# X\n\n- [ ] T1 a\n- [ ] a line with no ref\n")
    const got = await detect(dir)
    expect(got.taskFiles?.[0]?.tasks).toEqual([
      { ref: "T1", text: "a" },
      { ref: null, text: "a line with no ref" },
    ])
  })
})
