import { expect, test } from "bun:test"
import { listFeatureFiles, readFeature, removeTaskFromFile, tickTaskInFile } from "../src/featurefile"
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, stat, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** A feature file in the house format: a BOM-free, LF, multibyte-carrying file
 * whose first task is already done, the way a half-run backlog looks. */
const FEATURE = `# Widget export

- [x] T1 Parse the manifest
      run: 2026-10-11T09:14 · passed
- [ ] T2 Map records to rows
- [ ] T3 Runtime shim (v1.2)
`

/** A scratch repo with an empty `docs/features`. Real files in a real
 * directory, never this repository's own `docs/`. */
async function repo(): Promise<{ root: string; features: string }> {
  const root = await mkdtemp(join(tmpdir(), "kantan-feature-"))
  const features = join(root, "docs", "features")
  await mkdir(features, { recursive: true })
  return { root, features }
}

// --- Discovery --------------------------------------------------------------
// Discovery is a skipping guard, and the dimension it reads is the directory
// entry: its name, and its type *after* following a symlink. The matrix below
// is the whole enumeration, in one directory, asserted as an exact list - an
// over-include shows a README as a feature, and an under-include makes a real
// backlog invisible, which is worse.

test("discovery lists exactly the markdown files directly under docs/features", async () => {
  const { root, features } = await repo()

  // Included: the documented convention, its long spelling, a shouted
  // extension (case is no signal on a case-insensitive filesystem), and a file
  // that parses to no tasks - a feature mid-draft is still the user's file.
  await writeFile(join(features, "widget-export.md"), FEATURE)
  await writeFile(join(features, "legacy.markdown"), FEATURE)
  await writeFile(join(features, "SHOUTED.MD"), FEATURE)
  await writeFile(join(features, "empty-backlog.md"), "# Drafted\n\nNo tasks yet.\n")

  // Excluded by name. The README is documentation *about* the folder, and
  // content cannot rescue it: the parser does not read fences, so a README
  // documenting the house format parses as having real tasks.
  await writeFile(join(features, "README.md"), "# About this folder\n\n- [ ] T1 like this\n")
  await writeFile(join(features, "readme.markdown"), "# also about the folder\n")
  // Excluded by extension: nothing the tool writes lacks one, and the drafter
  // only ever writes `<slug>.md`.
  await writeFile(join(features, "LICENSE"), "all rights reserved\n")
  await writeFile(join(features, "notes.txt"), "scratch\n")
  await writeFile(join(features, "widget-export.md~"), FEATURE)
  // Excluded as hidden: editors and tools write these, users do not.
  await writeFile(join(features, ".hidden.md"), FEATURE)
  await writeFile(join(features, ".widget-export.md.4242.tmp"), FEATURE)

  // Type dimension. A subdirectory is not recursed into: the layout is flat,
  // so a nested markdown file is an archive or a sub-organised copy, and
  // listing a retired feature as runnable is the expensive mistake.
  await mkdir(join(features, "archive"))
  await writeFile(join(features, "archive", "retired.md"), FEATURE)

  // A symlink to a file is included: it is how one backlog is shared between
  // repos, and reading it is identical to reading a regular file.
  const shared = join(root, "shared-backlog.md")
  await writeFile(shared, FEATURE)
  await symlink(shared, join(features, "linked.md"))
  // A symlink to a directory is a directory, and a broken one has nothing to
  // read - an emacs lock file (`.#name.md`) is exactly this shape.
  await symlink(join(features, "archive"), join(features, "linked-dir.md"))
  await symlink(join(root, "gone.md"), join(features, "broken.md"))

  expect(await listFeatureFiles(root)).toEqual([
    join(features, "SHOUTED.MD"),
    join(features, "empty-backlog.md"),
    join(features, "legacy.markdown"),
    join(features, "linked.md"),
    join(features, "widget-export.md"),
  ])
})

test("a repo with no docs/features has no features rather than an error", async () => {
  // The normal first state of a repo, and the same answer `loadProjects` gives
  // for an absent store.
  const root = await mkdtemp(join(tmpdir(), "kantan-feature-"))
  expect(await listFeatureFiles(root)).toEqual([])
})

test("a docs/features that is a file is an error, not an empty list", async () => {
  // Only "it is not there" reads as "no features yet". Anything else is a
  // fault the user has to see, because an empty list is indistinguishable from
  // a repo that never had a backlog.
  const root = await mkdtemp(join(tmpdir(), "kantan-feature-"))
  await mkdir(join(root, "docs"))
  await writeFile(join(root, "docs", "features"), "not a directory\n")
  await expect(listFeatureFiles(root)).rejects.toThrow()
})

// --- The disk round trip -----------------------------------------------------
// `src/backlog.ts` guarantees exact bytes in and out as strings. These tests
// carry that guarantee across the disk boundary, and they compare raw buffers
// rather than strings: a decode that normalised a line ending or dropped a BOM
// would compare equal as text and still have corrupted the user's file.

/** Every byte offset at which two buffers differ; empty when identical. */
function byteDiff(a: Uint8Array, b: Uint8Array): number[] {
  const diff: number[] = []
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) diff.push(i)
  }
  return diff
}

/** Asserts the file at `path` is `before` with a single 0x20 -> 0x78 flip. */
async function expectOneTickedByte(path: string, before: Uint8Array): Promise<void> {
  const after = await readFile(path)
  const diff = byteDiff(before, after)
  expect(diff).toHaveLength(1)
  const at = diff[0]!
  expect(before[at]).toBe(0x20)
  expect(after[at]).toBe(0x78)
}

/** Writes `src` as a feature file and returns its path with its exact bytes. */
async function feature(name: string, src: string): Promise<{ path: string; bytes: Buffer<ArrayBuffer> }> {
  const { features } = await repo()
  const path = join(features, name)
  await writeFile(path, src)
  return { path, bytes: await readFile(path) }
}

test("a CRLF file round-trips byte-identically through a tick", async () => {
  const crlf = FEATURE.replace(/\n/g, "\r\n")
  const { path, bytes } = await feature("crlf.md", crlf)

  const file = await readFeature(path)
  expect(file.src).toBe(crlf)
  expect(file.path).toBe(path)
  expect(file.title).toBe("Widget export")
  expect(file.tasks.map((t) => t.ref)).toEqual(["T1", "T2", "T3"])

  const result = await tickTaskInFile(file, "T2")
  expect(result.written).toBe(true)
  expect(result.warning).toBeNull()
  expect(result.src).toContain("- [x] T2 Map records to rows\r\n")
  await expectOneTickedByte(path, bytes)
})

test("a leading BOM survives the read and the write", async () => {
  // The BOM is the byte a decoder drops by default, and nothing downstream
  // would put it back: the file would lose it on the first tick.
  const { path, bytes } = await feature("bom.md", "﻿" + FEATURE.replace(/\n/g, "\r\n"))
  expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))

  const file = await readFeature(path)
  expect(file.src.startsWith("﻿")).toBe(true)
  expect(file.title).toBe("Widget export")

  expect((await tickTaskInFile(file, "T2")).written).toBe(true)
  const after = await readFile(path)
  expect(after.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
  await expectOneTickedByte(path, bytes)
})

test("a file with no trailing newline does not gain one", async () => {
  const { path, bytes } = await feature("nonewline.md", "# F\n\n- [ ] T1 one\n- [ ] T2 two")
  expect((await tickTaskInFile(await readFeature(path), "T2")).written).toBe(true)
  const after = await readFile(path)
  expect(after.at(-1)).toBe(0x6f) // "o" of "two"
  expect(after.length).toBe(bytes.length)
  await expectOneTickedByte(path, bytes)
})

test("a feature file that is not valid UTF-8 is refused rather than transcoded", async () => {
  // A lossy decode replaces the byte with U+FFFD, and writing the string back
  // would then rewrite a file the tool was only asked to tick one byte of.
  const { features } = await repo()
  const path = join(features, "latin1.md")
  const bytes = Buffer.concat([Buffer.from("# F\n\n- [ ] T1 caf"), Buffer.from([0xe9]), Buffer.from("\n")])
  await writeFile(path, bytes)

  await expect(readFeature(path)).rejects.toThrow(/latin1\.md/)
  expect(await readFile(path)).toEqual(bytes)
})

// --- Writing, and the window between parse and write ------------------------

const isRoot = (process.getuid?.() ?? -1) === 0

/** A fixed, long-past timestamp. Asserting this exact value is what separates
 * "no write happened" from "two writes landed in the same millisecond". */
const LONG_AGO = new Date("2020-01-02T03:04:05.000Z")

test.skipIf(isRoot)("a write that fails leaves the original file intact", async () => {
  // The crash requirement, tested with a real failure rather than a mock: a
  // read-only directory cannot take the temp file. An in-place write would
  // pass this test happily, because the file itself is still writable - which
  // is exactly the implementation this test exists to reject.
  const src = "# F\n\n- [ ] T1 one\n"
  const { path, bytes } = await feature("doomed.md", src)
  const dir = join(path, "..")
  const file = await readFeature(path)

  await chmod(dir, 0o555)
  try {
    await expect(tickTaskInFile(file, "T1")).rejects.toThrow()
    expect(await readFile(path)).toEqual(bytes)
  } finally {
    await chmod(dir, 0o755)
  }

  // No half-written temp file is left behind, and the failure did not wedge
  // the writer: the next tick still lands.
  expect(await readdir(dir)).toEqual(["doomed.md"])
  expect((await tickTaskInFile(file, "T1")).written).toBe(true)
  expect(await readFile(path, "utf8")).toBe("# F\n\n- [x] T1 one\n")
  expect(await readdir(dir)).toEqual(["doomed.md"])
})

test("a file edited between parse and write is re-resolved by ref, not by line", async () => {
  // The human inserts a task above the list, so every cached line number now
  // names a different line: line 3 was T2 and now holds T1. A splice by cached
  // line would tick T1 and report T2 done.
  const { path } = await feature("shifting.md", "# F\n\n- [ ] T1 one\n- [ ] T2 two\n")
  const file = await readFeature(path)
  expect(file.tasks[1]).toMatchObject({ ref: "T2", line: 3 })

  const edited = "# F\n\n- [ ] T0 urgent\n- [ ] T1 one\n- [ ] T2 two\n"
  await writeFile(path, edited)
  const editedBytes = await readFile(path)

  const result = await tickTaskInFile(file, "T2")
  expect(result.written).toBe(true)
  expect(result.warning).toContain("changed on disk")
  expect(result.warning).toContain("T2")
  expect(await readFile(path, "utf8")).toBe("# F\n\n- [ ] T0 urgent\n- [ ] T1 one\n- [x] T2 two\n")
  expect(result.src).toBe(await readFile(path, "utf8"))
  // The human's edit is kept, and only the box moved.
  await expectOneTickedByte(path, editedBytes)
})

test("a ref the human removed is refused rather than guessed at", async () => {
  const { path } = await feature("vanishing.md", "# F\n\n- [ ] T1 one\n- [ ] T2 two\n")
  const file = await readFeature(path)
  const edited = "# F\n\n- [ ] T1 one\n"
  await writeFile(path, edited)

  const error = await tickTaskInFile(file, "T2").then(
    () => null,
    (e: unknown) => e as Error,
  )
  // Both halves of the diagnosis, because either alone sends the reader the
  // wrong way: the ref is gone, and the reason is that the file changed.
  expect(error?.message).toContain("changed on disk")
  expect(error?.message).toContain("T2")
  expect(await readFile(path, "utf8")).toBe(edited)
})

test("ticking an already-ticked task writes nothing and leaves mtime untouched", async () => {
  const src = "# F\n\n- [x] T1 done\n"
  const { path, bytes } = await feature("finished.md", src)
  await utimes(path, LONG_AGO, LONG_AGO)
  const file = await readFeature(path)

  const result = await tickTaskInFile(file, "T1")
  expect(result.written).toBe(false)
  expect(result.warning).toBeNull()
  expect(result.src).toBe(src)
  expect(await readFile(path)).toEqual(bytes)
  expect((await stat(path)).mtimeMs).toBe(LONG_AGO.getTime())
})

test("a task the human ticked first reports no write and still warns", async () => {
  // The likeliest mid-run edit of all: the human ticks the task themselves.
  // Both facts have to survive - nothing was written, and the file moved.
  const { path } = await feature("raced.md", "# F\n\n- [ ] T1 one\n")
  const file = await readFeature(path)
  const edited = "# F\n\n- [x] T1 one\n"
  await writeFile(path, edited)
  await utimes(path, LONG_AGO, LONG_AGO)

  const result = await tickTaskInFile(file, "T1")
  expect(result.written).toBe(false)
  expect(result.warning).toContain("changed on disk")
  expect(result.src).toBe(edited)
  expect((await stat(path)).mtimeMs).toBe(LONG_AGO.getTime())
})

test("a tick through a symlink writes the target and keeps the link", async () => {
  // One backlog shared between repos, or a feature file linked in from a
  // checkout. Renaming over the link would replace it with a regular file:
  // later writes would stop reaching the real file, with nothing to show why.
  const { root, features } = await repo()
  const real = join(root, "shared-backlog.md")
  await writeFile(real, "# F\n\n- [ ] T1 one\n")
  const link = join(features, "shared-backlog.md")
  await symlink(real, link)

  const result = await tickTaskInFile(await readFeature(link), "T1")
  expect(result.written).toBe(true)
  expect((await lstat(link)).isSymbolicLink()).toBe(true)
  expect(await readFile(real, "utf8")).toBe("# F\n\n- [x] T1 one\n")
  expect(await readdir(features)).toEqual(["shared-backlog.md"])
})

test("a tick keeps the mode the file already had", async () => {
  // A rename takes the temp file's mode, so a writer that does not carry the
  // old one over changes a mode inside the user's git repo - and under the
  // usual umask it strips a bit they set deliberately. The umask is pinned,
  // because the bug this rejects - passing the mode to open() and trusting it -
  // only shows under a umask that strips one of the bits.
  const { path } = await feature("moded.md", "# F\n\n- [ ] T1 one\n")
  await chmod(path, 0o664)
  const previousUmask = process.umask(0o022)
  try {
    expect((await tickTaskInFile(await readFeature(path), "T1")).written).toBe(true)
  } finally {
    process.umask(previousUmask)
  }
  expect((await stat(path)).mode & 0o777).toBe(0o664)
})

test.skipIf(isRoot)("a write that fails after the temp file exists leaves no temp file", async () => {
  // The read-only directory above fails at the create, so it never exercises
  // the cleanup. A file size limit does: `ulimit -f 1` lets the create succeed
  // and makes the write fail with EFBIG. Without this the cleanup path never
  // runs in the suite at all, and a temp file left inside the user's own
  // repository is what turns up in their next `git status`.
  const { root, features } = await repo()
  const path = join(features, "big.md")
  await writeFile(path, `# F\n\n- [ ] T1 one\n${"x".repeat(4096)}\n`)

  const script = join(root, "tick.ts")
  const module = join(import.meta.dir, "..", "src", "featurefile.ts")
  await writeFile(
    script,
    `import { readFeature, tickTaskInFile } from ${JSON.stringify(module)}\n` +
      `await tickTaskInFile(await readFeature(process.argv[2]), "T1")\n`,
  )
  // The limit has to be set by the shell that spawns the process, because a
  // limit the test process set would also bind the test runner writing its
  // own output.
  const proc = Bun.spawnSync([
    "bash",
    "-c",
    'ulimit -f 1; exec "$0" run "$1" "$2"',
    process.execPath,
    script,
    path,
  ])
  expect(proc.exitCode).not.toBe(0)
  expect(new TextDecoder().decode(proc.stderr)).toContain("EFBIG")
  expect(await readdir(features)).toEqual(["big.md"])
  expect(await readFile(path, "utf8")).toContain("- [ ] T1 one")
})

// --- Removing a task --------------------------------------------------------
// `removeTask` in `src/backlog.ts` owns which bytes go; these own the disk:
// the atomic rename, the mode, the symlink, and the re-read that makes a
// concurrent human edit safe. They are the tick's own disk tests, asked of the
// one operation whose mistake is unrecoverable from the file alone.

test("removing a task takes its line and leaves the rest byte-identical", async () => {
  const { features } = await repo()
  const path = join(features, "widget.md")
  await writeFile(path, FEATURE)

  const result = await removeTaskFromFile(await readFeature(path), "T2")

  expect(result.removed).toBe("Map records to rows")
  expect(result.warning).toBeNull()
  const after = await readFile(path, "utf8")
  expect(after).toBe(`# Widget export

- [x] T1 Parse the manifest
      run: 2026-10-11T09:14 · passed
- [ ] T3 Runtime shim (v1.2)
`)
  // The continuation line under T1 is T1's, not a task, and it stays.
  expect(after).toContain("run: 2026-10-11T09:14")
})

test("a CRLF file round-trips byte-identically through a removal", async () => {
  const { features } = await repo()
  const path = join(features, "crlf.md")
  await writeFile(path, "# F\r\n\r\n- [ ] T1 a\r\n- [ ] T2 b\r\n")

  await removeTaskFromFile(await readFeature(path), "T1")
  expect(await readFile(path, "utf8")).toBe("# F\r\n\r\n- [ ] T2 b\r\n")
})

test("a leading BOM survives a removal", async () => {
  const { features } = await repo()
  const path = join(features, "bom.md")
  await writeFile(path, "﻿# F\n\n- [ ] T1 a\n- [ ] T2 b\n")

  await removeTaskFromFile(await readFeature(path), "T2")
  expect(await readFile(path, "utf8")).toBe("﻿# F\n\n- [ ] T1 a\n")
})

test("a file with no trailing newline does not gain one", async () => {
  const { features } = await repo()
  const path = join(features, "bare.md")
  await writeFile(path, "# F\n\n- [ ] T1 a\n- [ ] T2 b")

  await removeTaskFromFile(await readFeature(path), "T2")
  expect(await readFile(path, "utf8")).toBe("# F\n\n- [ ] T1 a")
})

test("the file's mode is the user's, not the temp file's", async () => {
  const { features } = await repo()
  const path = join(features, "mode.md")
  await writeFile(path, FEATURE)
  await chmod(path, 0o664)

  await removeTaskFromFile(await readFeature(path), "T2")
  expect((await stat(path)).mode & 0o777).toBe(0o664)
})

test("a symlinked feature file is written through, and stays a symlink", async () => {
  const { root, features } = await repo()
  const real = join(root, "elsewhere.md")
  await writeFile(real, FEATURE)
  const link = join(features, "linked.md")
  await symlink(real, link)

  await removeTaskFromFile(await readFeature(link), "T3")

  expect((await lstat(link)).isSymbolicLink()).toBe(true)
  expect(await readFile(real, "utf8")).not.toContain("T3")
})

test("no temp file is left beside the target", async () => {
  const { features } = await repo()
  const path = join(features, "clean.md")
  await writeFile(path, FEATURE)

  await removeTaskFromFile(await readFeature(path), "T2")
  expect(await readdir(features)).toEqual(["clean.md"])
})

test("a file edited between parse and write is re-resolved by ref, not by line", async () => {
  const { features } = await repo()
  const path = join(features, "moved.md")
  await writeFile(path, FEATURE)
  const parsed = await readFeature(path)

  // The human inserts a task above, so every cached line number is now wrong.
  await writeFile(path, `# Widget export

- [ ] T9 Something urgent
- [x] T1 Parse the manifest
      run: 2026-10-11T09:14 · passed
- [ ] T2 Map records to rows
- [ ] T3 Runtime shim (v1.2)
`)

  const result = await removeTaskFromFile(parsed, "T2")

  expect(result.warning).toContain("changed on disk")
  const after = await readFile(path, "utf8")
  // The line the stale number pointed at is T1's continuation; it is still here.
  expect(after).toContain("run: 2026-10-11T09:14")
  expect(after).toContain("T9 Something urgent")
  expect(after).not.toContain("T2 Map records to rows")
})

test("a ref the file no longer has is refused, and nothing is written", async () => {
  const { features } = await repo()
  const path = join(features, "gone.md")
  await writeFile(path, FEATURE)
  const parsed = await readFeature(path)
  await writeFile(path, "# Widget export\n\n- [ ] T1 Parse the manifest\n")
  const before = await readFile(path, "utf8")

  await expect(removeTaskFromFile(parsed, "T2")).rejects.toThrow("can no longer be removed")
  expect(await readFile(path, "utf8")).toBe(before)
})

/**
 * Not idempotent, deliberately, and this is the test that says so: a tick of a
 * ticked task is a no-op because both paths end in the same file, while a
 * second removal has no end state to reach. "It was already gone" must not
 * read as "I removed it".
 */
test("removing the same task twice refuses the second time", async () => {
  const { features } = await repo()
  const path = join(features, "twice.md")
  await writeFile(path, FEATURE)

  await removeTaskFromFile(await readFeature(path), "T2")
  await expect(removeTaskFromFile(await readFeature(path), "T2")).rejects.toThrow("no task T2")
})
