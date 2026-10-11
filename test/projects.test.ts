import { expect, test } from "bun:test"
import { loadProjects, addProject, defaults } from "../src/projects"
import type { Project } from "../src/projects"
import { chmod, lstat, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("an absent store reads as empty rather than throwing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orch-"))
  expect(await loadProjects(join(dir, "nope.json"))).toEqual([])
})

test("a new project gets the design's model and effort defaults", () => {
  const p = defaults({ path: "/repo", testCmd: "npm test" })
  expect(p.planModel).toBe("claude-opus-5-5")
  expect(p.implementModel).toBe("claude-sonnet-5-5")
  expect(p.planEffort).toBe("high")
  expect(p.implementEffort).toBe("medium")
  expect(p.resumePlanSession).toBe(false)
  expect(p.configDir).toBeUndefined()
})

test("adding the same path twice updates rather than duplicates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orch-"))
  const f = join(dir, "projects.json")
  await addProject(f, defaults({ path: "/repo", testCmd: "npm test" }))
  await addProject(f, defaults({ path: "/repo", testCmd: "flutter test" }))
  const all = await loadProjects(f)
  expect(all).toHaveLength(1)
  expect(all[0]!.testCmd).toBe("flutter test")
})

test("a malformed store throws with the path in the message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orch-"))
  const f = join(dir, "projects.json")
  await writeFile(f, "{ not json")
  await expect(loadProjects(f)).rejects.toThrow(/projects\.json/)
})

// --- Helpers ----------------------------------------------------------------

/** A fresh empty directory; the store path inside it does not exist yet. */
async function store(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "orch-"))
  return { dir, file: join(dir, "projects.json") }
}

/** A store file holding exactly these records, written the way a hand edit
 * would write them rather than through `addProject`. */
async function handWritten(records: unknown[]): Promise<{ dir: string; file: string }> {
  const s = await store()
  await writeFile(s.file, JSON.stringify(records, null, 2) + "\n")
  return s
}

const SAMPLE: Project = {
  path: "/repo",
  testCmd: "npm test",
  reportPath: "build/junit.xml",
  configDir: "/home/me/.claude-work",
  budgetUsd: 12.5,
  planModel: "claude-opus-5-5",
  implementModel: "claude-sonnet-5-5",
  planEffort: "high",
  implementEffort: "medium",
  resumePlanSession: false,
}

/** Root ignores the permission bits these tests rely on, so the two
 * permission cases below would silently pass for the wrong reason. */
const isRoot = (process.getuid?.() ?? -1) === 0

// --- The store is the one piece of state no repo can rebuild ----------------
// Every case here is a shape that could cost someone configuration they typed
// by hand. The rule throughout: an input we cannot read with certainty throws
// with the path and the field in the message, so it can be fixed in an editor.
// Nothing is ever skipped, defaulted over, or overwritten.

test("addProject refuses to touch a malformed store", async () => {
  // The dangerous asymmetry: loadProjects throwing is useless if addProject
  // reads the same file as "no projects yet" and renames a fresh array over it.
  const { file } = await store()
  const original = '[{ "path": "/repo", oops }]'
  await writeFile(file, original)
  await expect(addProject(file, defaults({ path: "/other", testCmd: "npm test" }))).rejects.toThrow(
    /projects\.json/,
  )
  expect(await readFile(file, "utf8")).toBe(original)
})

test("only an absent file reads as empty; an unreadable one throws", async () => {
  // ENOENT is the single case that means "not configured yet". Treating any
  // other read failure as empty would hand addProject an empty array and
  // overwrite a store that was merely unreadable for a moment.
  const { dir, file } = await store()
  await expect(loadProjects(dir)).rejects.toThrow() // EISDIR, not []
  await writeFile(file, JSON.stringify([SAMPLE], null, 2) + "\n")
  if (!isRoot) {
    await chmod(file, 0o000)
    try {
      await expect(loadProjects(file)).rejects.toThrow()
    } finally {
      await chmod(file, 0o600)
    }
  }
})

test("an empty store file throws rather than reading as no projects", async () => {
  // A zero-byte file is what a truncated write or a full disk leaves behind.
  // Reading it as [] would let the next addProject replace the lost records
  // with one, turning a recoverable accident into a permanent one.
  // The message is the point, and is asserted rather than just the throw: a
  // bare "Unexpected end of JSON input" tells a user nothing about what
  // happened to their file, or that nothing has been replaced.
  const { file } = await store()
  await writeFile(file, "")
  await expect(loadProjects(file)).rejects.toThrow(/projects\.json is empty/)
  await writeFile(file, "  \n")
  await expect(loadProjects(file)).rejects.toThrow(/projects\.json is empty/)
})

test("a store that is JSON but not an array of projects throws", async () => {
  const a = await store()
  await writeFile(a.file, JSON.stringify({ "/repo": SAMPLE }))
  await expect(loadProjects(a.file)).rejects.toThrow(/projects\.json/)

  const b = await store()
  await writeFile(b.file, "[1,2,3]")
  await expect(loadProjects(b.file)).rejects.toThrow(/projects\.json/)

  const c = await store()
  await writeFile(c.file, "null")
  await expect(loadProjects(c.file)).rejects.toThrow(/projects\.json/)
})

test("a record missing a required field throws naming the field", async () => {
  const { path: _drop, ...noPath } = SAMPLE
  const a = await handWritten([noPath])
  await expect(loadProjects(a.file)).rejects.toThrow(/path/)

  const { testCmd: _drop2, ...noCmd } = SAMPLE
  const b = await handWritten([noCmd])
  await expect(loadProjects(b.file)).rejects.toThrow(/testCmd/)

  const { budgetUsd: _drop3, ...noBudget } = SAMPLE
  const c = await handWritten([noBudget])
  await expect(loadProjects(c.file)).rejects.toThrow(/budgetUsd/)

  const { resumePlanSession: _drop4, ...noResume } = SAMPLE
  const d = await handWritten([noResume])
  await expect(loadProjects(d.file)).rejects.toThrow(/resumePlanSession/)
})

test("an unknown field throws instead of being quietly dropped", async () => {
  // The case a missing-field check can never catch. "configdir" is a known
  // field misspelled: ignoring it would silently run that project against the
  // default ~/.claude profile, which is the wrong account, and the next write
  // would drop the line the user typed. Named and refused.
  const { configDir: _drop, ...rest } = SAMPLE
  const a = await handWritten([{ ...rest, configdir: "/home/me/.claude-work" }])
  await expect(loadProjects(a.file)).rejects.toThrow(/configdir/)

  const b = await handWritten([{ ...SAMPLE, budgetUSD: 500 }])
  await expect(loadProjects(b.file)).rejects.toThrow(/budgetUSD/)
})

test("two records for the same path throw rather than one shadowing the other", async () => {
  // An upsert keyed on path updates the first match, so a duplicate means
  // edits land on one record while runs could read either. Ambiguous identity.
  const { file } = await handWritten([SAMPLE, { ...SAMPLE, testCmd: "vendor/bin/pest" }])
  await expect(loadProjects(file)).rejects.toThrow(/\/repo/)
})

test("an unknown effort throws and lists what is allowed", async () => {
  const { file } = await handWritten([{ ...SAMPLE, planEffort: "highest" }])
  await expect(loadProjects(file)).rejects.toThrow(/planEffort/)
  await expect(loadProjects(file)).rejects.toThrow(/xhigh/)
})

test("every effort the design allows round-trips", async () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
    const { file } = await store()
    await addProject(file, defaults({ ...SAMPLE, planEffort: effort, implementEffort: effort }))
    const all = await loadProjects(file)
    expect(all[0]!.planEffort).toBe(effort)
    expect(all[0]!.implementEffort).toBe(effort)
  }
})

test("a field of the wrong JSON type throws rather than being coerced", async () => {
  // "false" is the one that matters: as a string it is truthy, so a coercing
  // reader would run plan and implement in one conversation, cold-start the
  // cache and drop thinking blocks, with nothing in the log to explain it.
  const a = await handWritten([{ ...SAMPLE, resumePlanSession: "false" }])
  await expect(loadProjects(a.file)).rejects.toThrow(/resumePlanSession/)

  const b = await handWritten([{ ...SAMPLE, budgetUsd: "12.5" }])
  await expect(loadProjects(b.file)).rejects.toThrow(/budgetUsd/)

  const c = await handWritten([{ ...SAMPLE, testCmd: ["npm", "test"] }])
  await expect(loadProjects(c.file)).rejects.toThrow(/testCmd/)
})

test("a budget that cannot bound a run throws", async () => {
  // Zero is refused rather than honoured as a pause: it is far likelier to be
  // a typo or a half-finished edit than an intent, and the loud version of
  // being wrong is a message naming the field. Negative and non-finite are
  // nonsense, and NaN does not survive JSON at all - it writes back as null.
  for (const budgetUsd of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const { file } = await handWritten([{ ...SAMPLE, budgetUsd }])
    await expect(loadProjects(file)).rejects.toThrow(/budgetUsd/)
    expect(() => defaults({ ...SAMPLE, budgetUsd })).toThrow(/budgetUsd/)
  }
  // A small positive budget is a legitimate choice and is kept exactly.
  const { file } = await store()
  await addProject(file, defaults({ ...SAMPLE, budgetUsd: 0.25 }))
  expect((await loadProjects(file))[0]!.budgetUsd).toBe(0.25)
})

test("a test command that would pass by doing nothing throws", async () => {
  // The whole design branches on the test command's exit code, and `sh -c ""`
  // exits 0. An empty command would mark every task done without running a
  // thing, which is the most expensive silent failure in this tool.
  for (const testCmd of ["", "   ", "\t\n"]) {
    expect(() => defaults({ path: "/repo", testCmd })).toThrow(/testCmd/)
    const { file } = await handWritten([{ ...SAMPLE, testCmd }])
    await expect(loadProjects(file)).rejects.toThrow(/testCmd/)
  }
})

test("an empty model or effort-bearing string throws", async () => {
  expect(() => defaults({ path: "/repo", testCmd: "npm test", planModel: "" })).toThrow(/planModel/)
  expect(() => defaults({ path: "/repo", testCmd: "npm test", implementModel: " " })).toThrow(
    /implementModel/,
  )
})

test("a relative path is refused rather than resolved against the server's cwd", async () => {
  // The server's cwd is wherever it was started, so resolving "./repo" would
  // register a different repo depending on how it was launched - and could
  // register one that does not exist. The user names the repo root.
  expect(() => defaults({ path: "repo", testCmd: "npm test" })).toThrow(/path/)
  expect(() => defaults({ path: "./repo", testCmd: "npm test" })).toThrow(/path/)
  expect(() => defaults({ path: "~/repo", testCmd: "npm test" })).toThrow(/path/)
  expect(() => defaults({ path: "", testCmd: "npm test" })).toThrow(/path/)
  const { file } = await handWritten([{ ...SAMPLE, path: "repo" }])
  await expect(loadProjects(file)).rejects.toThrow(/path/)
})

test("a trailing slash is the same project, not a second one", async () => {
  // "/repo/" and "/repo" are one directory. Two records would mean edits land
  // on one while a run reads the other, so the stored path is normalised.
  const { file } = await store()
  await addProject(file, defaults({ path: "/repo", testCmd: "npm test" }))
  await addProject(file, defaults({ path: "/repo/", testCmd: "flutter test" }))
  const all = await loadProjects(file)
  expect(all).toHaveLength(1)
  expect(all[0]!.path).toBe("/repo")
  expect(all[0]!.testCmd).toBe("flutter test")
})

test("configDir must be absolute, because the CLI expands no tilde", async () => {
  // CLAUDE_CONFIG_DIR is handed to the child process verbatim. A literal
  // "~/.claude-work" directory would be created next to the cwd and the run
  // would start from an empty profile: no CLAUDE.md, no skills, no auth.
  expect(() => defaults({ ...SAMPLE, configDir: "~/.claude-work" })).toThrow(/configDir/)
  expect(() => defaults({ ...SAMPLE, configDir: ".claude-work" })).toThrow(/configDir/)
  expect(() => defaults({ ...SAMPLE, configDir: "" })).toThrow(/configDir/)
})

test("a null configDir reads as the default profile", async () => {
  // The design spells "default profile" two ways, null and absent. Both load;
  // the store then keeps the one spelling, so a round trip settles on absent.
  const { file } = await handWritten([{ ...SAMPLE, configDir: null, reportPath: null }])
  const all = await loadProjects(file)
  expect(all[0]!.configDir).toBeUndefined()
  expect(all[0]!.reportPath).toBeUndefined()
  await addProject(file, all[0]!)
  expect(await readFile(file, "utf8")).not.toContain("null")
})

test("reportPath is relative to the repo, so an absolute one throws", async () => {
  // It is joined onto the project path when the stall signature reads the
  // report. An absolute value would read a file in another project, or none.
  expect(() => defaults({ ...SAMPLE, reportPath: "/tmp/junit.xml" })).toThrow(/reportPath/)
  expect(() => defaults({ ...SAMPLE, reportPath: "" })).toThrow(/reportPath/)
  expect(() => defaults({ ...SAMPLE, reportPath: "  " })).toThrow(/reportPath/)
})

test("addProject validates its argument before touching the file", async () => {
  // A caller can build a record without going through defaults(). If only
  // loadProjects validated, one bad call would write a store that every later
  // load rejects: the file would be bricked by the tool that owns it.
  const { dir, file } = await store()
  const bad = { ...SAMPLE, planEffort: "turbo" } as unknown as Project
  await expect(addProject(file, bad)).rejects.toThrow(/planEffort/)
  expect(await readdir(dir)).toEqual([])
})

// --- defaults ---------------------------------------------------------------

test("defaults keeps every value it is given", () => {
  const p = defaults({ ...SAMPLE, resumePlanSession: true, planEffort: "max" })
  expect(p).toEqual({ ...SAMPLE, resumePlanSession: true, planEffort: "max" })
})

test("defaults is idempotent", () => {
  // It runs on a record the UI has already saved and reloaded, so a second
  // pass must not re-default a field the user set.
  const once = defaults({ path: "/repo", testCmd: "npm test" })
  expect(defaults(once)).toEqual(once)
  expect(defaults(defaults(SAMPLE))).toEqual(defaults(SAMPLE))
})

test("defaults treats an explicitly undefined field as unset", () => {
  // A form that sends every key, with the untouched ones undefined, must not
  // clobber the design's defaults with undefined - which a plain object spread
  // over a defaults literal would do.
  const p = defaults({
    path: "/repo",
    testCmd: "npm test",
    planModel: undefined,
    planEffort: undefined,
    resumePlanSession: undefined,
    configDir: undefined,
  })
  expect(p.planModel).toBe("claude-opus-5-5")
  expect(p.planEffort).toBe("high")
  expect(p.resumePlanSession).toBe(false)
  expect(p.configDir).toBeUndefined()
})

test("defaults refuses an unknown field as loudly as the store does", () => {
  // The HTTP layer will hand this function a parsed request body. A misspelled
  // key there is the same lost configuration as a misspelled key in the file.
  expect(() => defaults({ path: "/repo", testCmd: "npm test", budgetUSD: 5 } as never)).toThrow(
    /budgetUSD/,
  )
})

test("something that is not a project object is refused with a readable message", () => {
  // defaults() will be handed a parsed HTTP request body. null, a string and
  // an array are what a bad request looks like, and the TypeError that falls
  // out of reading keys off null names neither the field nor the function.
  expect(() => defaults(null as never)).toThrow(/project object/)
  expect(() => defaults("/repo" as never)).toThrow(/project object/)
  expect(() => defaults([] as never)).toThrow(/project object/)
})

test("a store an editor saved with a byte-order mark still loads", async () => {
  // A hand-edited file is whatever the user's editor writes, and some write a
  // BOM. JSON.parse refuses it, so it is stripped before parsing - the same
  // thing this project's backlog parser does with one. It frames the file
  // rather than belonging to it, so the store is not written back with one.
  const { file } = await store()
  await writeFile(file, "\uFEFF" + JSON.stringify([SAMPLE], null, 2) + "\n")
  expect(await loadProjects(file)).toEqual([SAMPLE])
})

test("a project gets a positive default budget", () => {
  const p = defaults({ path: "/repo", testCmd: "npm test" })
  expect(p.budgetUsd).toBeGreaterThan(0)
  expect(Number.isFinite(p.budgetUsd)).toBe(true)
})

// --- Writing ----------------------------------------------------------------

test("the store is pretty-printed, newline-terminated and stable to rewrite", async () => {
  // This file is hand-edited and lives in a shell where diffs are read. A
  // write that reordered keys or dropped the trailing newline would show up as
  // noise in every diff, so the same records always produce the same bytes.
  const { file } = await store()
  await addProject(file, defaults({ path: "/repo", testCmd: "npm test" }))
  const once = await readFile(file, "utf8")
  expect(once).toContain('\n  {\n    "path": "/repo",')
  expect(once.endsWith("]\n")).toBe(true)

  const all = await loadProjects(file)
  await addProject(file, all[0]!)
  expect(await readFile(file, "utf8")).toBe(once)
})

test("keys are written in one canonical order whatever order they arrive in", async () => {
  const { file } = await handWritten([Object.fromEntries(Object.entries(SAMPLE).reverse())])
  await addProject(file, defaults({ path: "/other", testCmd: "npm test" }))
  const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>[]
  expect(Object.keys(raw[0]!)).toEqual(Object.keys(SAMPLE))
})

test("optional fields survive a write and a read", async () => {
  const { file } = await store()
  await addProject(file, defaults(SAMPLE))
  expect((await loadProjects(file))[0]).toEqual(SAMPLE)
})

test("an update replaces the whole record rather than merging into it", async () => {
  // addProject takes a complete record, so a merge would resurrect a
  // reportPath or configDir the caller deliberately cleared, and the UI would
  // show a profile the user had just removed.
  const { file } = await store()
  await addProject(file, defaults(SAMPLE))
  await addProject(file, defaults({ path: SAMPLE.path, testCmd: "npm test" }))
  const all = await loadProjects(file)
  expect(all).toHaveLength(1)
  expect(all[0]!.configDir).toBeUndefined()
  expect(all[0]!.reportPath).toBeUndefined()
})

test("missing parent directories are created", async () => {
  const { dir } = await store()
  const file = join(dir, "nested", "deeper", "projects.json")
  await addProject(file, defaults({ path: "/repo", testCmd: "npm test" }))
  expect(await loadProjects(file)).toHaveLength(1)
})

test("a store is written by rename, so a failed write leaves the original", async () => {
  // The crash requirement, tested with a real failure rather than a mock: a
  // read-only directory cannot take the temp file. An in-place write would
  // pass this test happily, because the file itself is still writable - which
  // is exactly the implementation this test exists to reject.
  const { dir, file } = await store()
  await addProject(file, defaults({ path: "/repo", testCmd: "npm test" }))
  const before = await readFile(file, "utf8")
  if (isRoot) return

  await chmod(dir, 0o555)
  try {
    await expect(addProject(file, defaults({ path: "/other", testCmd: "npm test" }))).rejects.toThrow()
    expect(await readFile(file, "utf8")).toBe(before)
  } finally {
    await chmod(dir, 0o755)
  }
  // No half-written temp file is left behind, and the failure did not wedge
  // the writer: the next add still lands.
  expect(await readdir(dir)).toEqual(["projects.json"])
  await addProject(file, defaults({ path: "/other", testCmd: "npm test" }))
  expect(await loadProjects(file)).toHaveLength(2)
})

test.skipIf(isRoot)("a write keeps the mode the file already had", async () => {
  // A rename takes the temp file's mode, so a writer that does not carry the
  // old one over silently reopens a file the user had locked down - or, under
  // a umask, strips a bit they deliberately set.
  // The umask is pinned, because the bug this test exists to catch - passing
  // the mode to open() and trusting it - only shows under a umask that strips
  // one of the bits. On a umask-002 machine the unfixed writer would pass.
  const { file } = await store()
  await addProject(file, defaults({ path: "/repo", testCmd: "npm test" }))
  await chmod(file, 0o664)
  const previousUmask = process.umask(0o022)
  try {
    await addProject(file, defaults({ path: "/other", testCmd: "npm test" }))
  } finally {
    process.umask(previousUmask)
  }
  expect((await stat(file)).mode & 0o777).toBe(0o664)
})

test("a store reached through a symlink is written through it", async () => {
  // ~/.orch/projects.json symlinked into a dotfiles repo is a normal setup.
  // Renaming over the link would replace it with a regular file: the next
  // write would stop reaching the tracked copy, with nothing to show why.
  const real = await store()
  await addProject(real.file, defaults({ path: "/repo", testCmd: "npm test" }))
  const { dir: linkDir } = await store()
  const link = join(linkDir, "projects.json")
  await symlink(real.file, link)

  await addProject(link, defaults({ path: "/other", testCmd: "npm test" }))
  expect((await lstat(link)).isSymbolicLink()).toBe(true)
  expect(await loadProjects(real.file)).toHaveLength(2)
})

test("a symlink whose target does not exist yet is followed, not replaced", async () => {
  // The same dotfiles setup, wired up before the first project is added. The
  // link is the only record of where the store belongs, so a write that
  // replaced it would strand the tracked copy for good.
  const { dir: realDir } = await store()
  const target = join(realDir, "store.json")
  const { dir: linkDir } = await store()
  const link = join(linkDir, "projects.json")
  await symlink(target, link)

  await addProject(link, defaults({ path: "/repo", testCmd: "npm test" }))
  expect((await lstat(link)).isSymbolicLink()).toBe(true)
  expect(await loadProjects(target)).toHaveLength(1)
  expect(await loadProjects(link)).toHaveLength(1)
})

test("a temp file left by a crash is ignored", async () => {
  const { dir, file } = await store()
  await addProject(file, defaults({ path: "/repo", testCmd: "npm test" }))
  await writeFile(join(dir, "projects.json.12345.tmp"), "half a record")
  expect(await loadProjects(file)).toHaveLength(1)
  await addProject(file, defaults({ path: "/other", testCmd: "npm test" }))
  expect(await loadProjects(file)).toHaveLength(2)
})

test("parallel adds all land instead of overwriting each other", async () => {
  // Two awaited together is the shape the task asks about, and it is what the
  // UI does when a form posts twice. A plain read-modify-write loses one: both
  // read the same snapshot and the later rename wins. Writes to one file are
  // serialised in-process so every add is applied to the previous result.
  // Across processes they are not, which the report lists as left alone.
  const { file } = await store()
  const paths = Array.from({ length: 10 }, (_, i) => `/repo${i}`)
  await Promise.all(paths.map((path) => addProject(file, defaults({ path, testCmd: "npm test" }))))
  const all = await loadProjects(file)
  expect(all.map((p) => p.path).sort()).toEqual([...paths].sort())
})

test("two saves of one project land in the order they were called", async () => {
  // Length alone cannot see this: both saves are applied, but the wrong one
  // can end up last, so the user's newest edit silently loses to the one
  // before it. A queue entered after the store's path has been resolved does
  // exactly that, because resolving a symlinked store takes more filesystem
  // hops than resolving a plain one. The slot has to be taken when the call
  // is made, before any await.
  const real = await store()
  const target = join(real.dir, "store.json")
  const { dir: linkDir } = await store()
  const link = join(linkDir, "projects.json")
  await symlink(target, link)

  const first = addProject(link, defaults({ path: "/repo", testCmd: "first" }))
  const second = addProject(target, defaults({ path: "/repo", testCmd: "second" }))
  await Promise.all([first, second])
  const all = await loadProjects(target)
  expect(all).toHaveLength(1)
  expect(all[0]!.testCmd).toBe("second")
})

test("parallel adds of the same path leave one record", async () => {
  const { file } = await store()
  await Promise.all([
    addProject(file, defaults({ path: "/repo", testCmd: "npm test" })),
    addProject(file, defaults({ path: "/repo", testCmd: "flutter test" })),
  ])
  expect(await loadProjects(file)).toHaveLength(1)
})

test("a write that fails inside the lock does not wedge later writes", async () => {
  // The queue must survive a rejection. Chaining the next write onto a
  // rejected promise without handling it would make every later add reject
  // with the first add's error, for the life of the process.
  const { file } = await store()
  await writeFile(file, "{ not json")
  await expect(addProject(file, defaults({ path: "/a", testCmd: "npm test" }))).rejects.toThrow(
    /projects\.json/,
  )
  await writeFile(file, "[]")
  await addProject(file, defaults({ path: "/a", testCmd: "npm test" }))
  expect(await loadProjects(file)).toHaveLength(1)
})

test("a rejected add does not stop the valid ones beside it", async () => {
  const { file } = await store()
  const bad = { ...SAMPLE, budgetUsd: -1 } as unknown as Project
  const results = await Promise.allSettled([
    addProject(file, defaults({ path: "/a", testCmd: "npm test" })),
    addProject(file, bad),
    addProject(file, defaults({ path: "/b", testCmd: "npm test" })),
  ])
  expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"])
  expect((await loadProjects(file)).map((p) => p.path)).toEqual(["/a", "/b"])
})
