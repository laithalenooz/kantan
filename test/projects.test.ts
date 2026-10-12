import { expect, test } from "bun:test"
import {
  loadProjects,
  addProject,
  defaults,
  projectIdentity,
  removeProject,
  updateProject,
} from "../src/projects"
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

/**
 * The message `loadProjects` throws for a store holding `records`, or `""`
 * when it loaded.
 *
 * Used where a field name alone cannot tell two failures apart: the unknown-
 * field message lists every known field, so `rejects.toThrow(/allowedTools/)`
 * also passes for a version that does not model `allowedTools` at all. These
 * assertions name the rule that fired.
 */
async function loadError(records: unknown[]): Promise<string> {
  const { file } = await handWritten(records)
  try {
    await loadProjects(file)
    return ""
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

const SAMPLE: Project = {
  path: "/repo",
  testCmd: "npm test",
  reportPath: "build/junit.xml",
  configDir: "/home/me/.claude-work",
  // Explicit rather than null on purpose: "a null configDir reads as the
  // default profile" asserts the written file holds no `null` at all, and a
  // derived (null) allowedTools is written as null by design. Keeping this
  // record's list explicit leaves that assertion meaning what it says.
  permissionMode: "acceptEdits",
  allowedTools: ["Read", "Bash(git *)"],
  budgetUsd: 12.5,
  planModel: "claude-opus-5-5",
  implementModel: "claude-sonnet-5-5",
  planEffort: "high",
  implementEffort: "medium",
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

  const { planModel: _drop4, ...noModel } = SAMPLE
  const d = await handWritten([noModel])
  await expect(loadProjects(d.file)).rejects.toThrow(/planModel/)
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

// --- Permissions (design §2.2) ----------------------------------------------
// Two fields a stranger's safety depends on: the mode the run spawns with, and
// the allowlist that makes the restrictive mode usable. The store's job is to
// keep both unambiguous; src/permissions.ts derives and spends them.

test("a new project gets the restrictive permission default", () => {
  // bypassPermissions is right on the author's machine and wrong as a shipped
  // default for someone pointing this at a repo they care about. null means
  // "derive the allowlist", which is what makes acceptEdits usable at all.
  const p = defaults({ path: "/repo", testCmd: "npm test" })
  expect(p.permissionMode).toBe("acceptEdits")
  expect(p.allowedTools).toBeNull()
})

test("an unknown permissionMode throws and lists what is allowed", async () => {
  // The CLI has six modes; the design supports two. A mode this tool does not
  // model is refused rather than forwarded to the flag, because "plan" and
  // "dontAsk" would both run a phase that cannot do its job, and the run would
  // fail for a reason no message connects to this line of config.
  for (const permissionMode of ["yolo", "plan", "dontAsk", "default", "auto", "manual", ""]) {
    const message = await loadError([{ ...SAMPLE, permissionMode }])
    expect(message).toMatch(/permissionMode must be one of/)
    expect(message).toMatch(/acceptEdits, bypassPermissions/)
    expect(() => defaults({ ...SAMPLE, permissionMode } as never)).toThrow(/permissionMode/)
  }
})

test("both permission modes the design supports round-trip", async () => {
  for (const permissionMode of ["acceptEdits", "bypassPermissions"] as const) {
    const { file } = await store()
    await addProject(file, defaults({ ...SAMPLE, permissionMode }))
    expect((await loadProjects(file))[0]!.permissionMode).toBe(permissionMode)
  }
})

test("an explicit allowedTools round-trips exactly, order included", async () => {
  // "only these" is the whole point of the field, so the store must not sort,
  // dedupe or merge it with anything.
  const list = ["Bash(git *)", "Read", "Edit", "Read"]
  const { file } = await store()
  await addProject(file, defaults({ ...SAMPLE, allowedTools: list }))
  expect((await loadProjects(file))[0]!.allowedTools).toEqual(list)
})

test("allowedTools is copied, so a form object reused for the next save cannot mutate the record", () => {
  const list = ["Read"]
  const p = defaults({ ...SAMPLE, allowedTools: list })
  list.push("Bash(rm -rf *)")
  expect(p.allowedTools).toEqual(["Read"])
})

test("an allowedTools that is not a list of tool rules throws", async () => {
  // A single string is the likely hand edit ("Bash(git *)" instead of a list),
  // and it would reach the CLI as a list of its characters.
  for (const allowedTools of ["Bash(git *)", 42, true, {}, [1], ["Read", ""], ["  "], [null]]) {
    expect(await loadError([{ ...SAMPLE, allowedTools }])).toMatch(/allowedTools.* must be/)
    expect(() => defaults({ ...SAMPLE, allowedTools } as never)).toThrow(/allowedTools/)
  }
})

test("an empty allowedTools throws rather than reading as derive", async () => {
  // [] is an unfinished edit, not a choice: under acceptEdits a run with no
  // tools can neither edit nor run the suite, and in headless mode every
  // prompt is auto-denied, so the task fails at verification with nothing to
  // point at. null is how "derive" is spelled, and the message says so.
  const message = await loadError([{ ...SAMPLE, allowedTools: [] }])
  expect(message).toMatch(/allowedTools/)
  expect(message).toMatch(/null/)
  expect(() => defaults({ ...SAMPLE, allowedTools: [] })).toThrow(/allowedTools/)
})

test("a null allowedTools is written as null, not dropped like configDir", async () => {
  // configDir spells "the default profile" as null or absent, so the store
  // settles on absent. null here is the design's own spelling of "compute it",
  // and writing it keeps the knob visible in a file people hand-edit: it is
  // how someone discovers they can narrow the allowlist at all.
  const { file } = await store()
  await addProject(file, defaults({ path: "/repo", testCmd: "npm test" }))
  const raw = await readFile(file, "utf8")
  expect(raw).toContain('"allowedTools": null')
  expect(raw).toContain('"permissionMode": "acceptEdits"')
  expect((await loadProjects(file))[0]!.allowedTools).toBeNull()
})

test("a store written before these fields existed still loads", async () => {
  // The decision, stated so the next field-adder can copy or reject it: a
  // field younger than the store defaults on absence, and the default is the
  // restrictive direction. Guessing wrong here can only produce a denial named
  // in permission_denials - one line of config - never a silent escalation to
  // bypassPermissions. The strictness that protects a typed value is unknown-
  // field rejection, and a field the user never knew about cannot have been
  // typed. Throwing instead would brick every store the tool wrote itself, to
  // ask for the value it was going to pick anyway.
  const { permissionMode: _mode, allowedTools: _tools, ...older } = SAMPLE
  const { file } = await handWritten([older])
  const all = await loadProjects(file)
  expect(all[0]!.permissionMode).toBe("acceptEdits")
  expect(all[0]!.allowedTools).toBeNull()

  // And one save makes the store self-describing, so this is a migration that
  // happens once rather than a default that stays invisible.
  await addProject(file, all[0]!)
  expect(await readFile(file, "utf8")).toContain('"permissionMode": "acceptEdits"')
})

test("a store still naming a retired field loads, and the next write drops it", async () => {
  // The mirror image of the question above, and the answer has to be
  // consistent with it. `resumePlanSession` was removed once Task 15 showed it
  // would make two lines of the implement prompt false. A key this version no
  // longer honours is not a typo: there is no setting left to lose, and
  // refusing to start would punish the user for our change. So it loads, and
  // it evaporates from the file on the next write - visible in the diff of a
  // file that is hand-edited and read in diffs.
  const { file } = await handWritten([{ ...SAMPLE, resumePlanSession: true }])
  const all = await loadProjects(file)
  expect(all).toHaveLength(1)
  expect(all[0]).toEqual(SAMPLE)
  expect(Object.keys(all[0]!)).not.toContain("resumePlanSession")

  await addProject(file, all[0]!)
  expect(await readFile(file, "utf8")).not.toContain("resumePlanSession")

  // And the same record still goes through the write path that validates.
  expect(() => defaults({ ...SAMPLE, resumePlanSession: false } as never)).not.toThrow()
})

test("a misspelling of a retired field is still refused", async () => {
  // Retiring a name forgives that exact name, nothing near it. "resumeplan"
  // is a key this tool has never had, so it is the same lost line as any
  // other typo and is named and refused.
  const { file } = await handWritten([{ ...SAMPLE, resumeplan: true }])
  await expect(loadProjects(file)).rejects.toThrow(/resumeplan/)
})

test("a misspelled permission key throws instead of falling back to the default", async () => {
  // This is what keeps the defaulting above honest. Absent is unambiguous;
  // misspelled is not, and a dropped "permissionmode": "bypassPermissions"
  // would quietly run the restrictive mode - or, worse the other way, a
  // dropped allowlist would read as "derive" while the user believed they had
  // narrowed it. Both are named and refused.
  const { permissionMode: _mode, ...noMode } = SAMPLE
  const a = await handWritten([{ ...noMode, permissionmode: "bypassPermissions" }])
  await expect(loadProjects(a.file)).rejects.toThrow(/permissionmode/)

  const { allowedTools: _tools, ...noTools } = SAMPLE
  const b = await handWritten([{ ...noTools, allowed_tools: ["Read"] }])
  await expect(loadProjects(b.file)).rejects.toThrow(/allowed_tools/)
  await expect(loadProjects(b.file)).rejects.toThrow(/allowedTools/) // the allowed set is listed
})

test("a field of the wrong JSON type throws rather than being coerced", async () => {
  // A single string where a list belongs is the one that matters now: it is
  // what a hand edit of allowedTools looks like, and a coercing reader would
  // forward it to the CLI as a list of its own characters.
  const a = await handWritten([{ ...SAMPLE, allowedTools: "Bash(git *)" }])
  await expect(loadProjects(a.file)).rejects.toThrow(/allowedTools/)

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
  const p = defaults({ ...SAMPLE, planEffort: "max", permissionMode: "bypassPermissions" })
  expect(p).toEqual({ ...SAMPLE, planEffort: "max", permissionMode: "bypassPermissions" })
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
    permissionMode: undefined,
    allowedTools: undefined,
    configDir: undefined,
  })
  expect(p.planModel).toBe("claude-opus-5-5")
  expect(p.planEffort).toBe("high")
  expect(p.permissionMode).toBe("acceptEdits")
  expect(p.allowedTools).toBeNull()
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

// --- Removing and editing a record -----------------------------------------
// Both are writes to the one piece of state no repository can rebuild, so each
// case below is a shape that could cost someone configuration they typed. The
// rule is the same as everywhere else in this file: anything that cannot be
// read with certainty throws with the field in the message, and nothing is
// skipped, defaulted over or quietly replaced.

test("removing a project drops its record and leaves the others untouched", async () => {
  const { file } = await store()
  await addProject(file, { ...SAMPLE, path: "/a" })
  await addProject(file, { ...SAMPLE, path: "/b" })

  expect(await removeProject(file, "/a")).toBe(true)
  const left = await loadProjects(file)
  expect(left.map((p) => p.path)).toEqual(["/b"])
  // Field for field: a removal must not be a rewrite that drops a tuned value
  // from a record it was not asked about.
  expect(left[0]).toEqual({ ...SAMPLE, path: "/b" })
})

test("removing a path that is not registered removes nothing and says so", async () => {
  // The answer the HTTP layer turns into a 404. A silent `true` would tell
  // someone their project is gone when a misspelling means it is still there.
  const { file } = await store()
  await addProject(file, SAMPLE)
  expect(await removeProject(file, "/not-registered")).toBe(false)
  expect(await loadProjects(file)).toHaveLength(1)
})

test("a removal that matched nothing does not rewrite the store", async () => {
  // This file is hand-edited, read in diffs and often symlinked into a
  // dotfiles repo. A write that changed nothing would still touch its mtime
  // and could still reorder a hand edit's keys.
  const { file } = await store()
  await writeFile(file, JSON.stringify([SAMPLE], null, 2) + "\n")
  const before = await stat(file)
  await Bun.sleep(10)
  expect(await removeProject(file, "/elsewhere")).toBe(false)
  expect((await stat(file)).mtimeMs).toBe(before.mtimeMs)
})

test("removing from a store that does not exist yet is not an error", async () => {
  // An absent store is "no projects", as `loadProjects` reads it, so there is
  // nothing registered to remove - and nothing is created saying so.
  const { dir, file } = await store()
  expect(await removeProject(file, "/repo")).toBe(false)
  expect(await readdir(dir)).toEqual([])
})

test("a trailing slash removes the same record a trailing slash registered", async () => {
  const { file } = await store()
  await addProject(file, { ...SAMPLE, path: "/repo" })
  expect(await removeProject(file, "/repo/")).toBe(true)
  expect(await loadProjects(file)).toEqual([])
})

test("a removal refuses a relative path rather than resolving it against the cwd", async () => {
  // The same rule as registration: resolving would name a different record
  // depending on where the server was launched from.
  const { file } = await store()
  await addProject(file, SAMPLE)
  await expect(removeProject(file, "repo")).rejects.toThrow(/absolute repo path/)
  expect(await loadProjects(file)).toHaveLength(1)
})

test("a removal is serialised against an add, so neither loses the other", async () => {
  // Both are read-modify-write. Run together without the queue and whichever
  // renamed last would drop the other's work entirely.
  const { file } = await store()
  await addProject(file, { ...SAMPLE, path: "/a" })
  await Promise.all([
    removeProject(file, "/a"),
    addProject(file, { ...SAMPLE, path: "/b" }),
  ])
  expect((await loadProjects(file)).map((p) => p.path)).toEqual(["/b"])
})

test("removing a project leaves a store the store itself still accepts", async () => {
  const { file } = await store()
  await addProject(file, { ...SAMPLE, path: "/a" })
  await addProject(file, { ...SAMPLE, path: "/b", account: "work" })
  await removeProject(file, "/b")
  expect(await readFile(file, "utf8")).toBe(JSON.stringify([{ ...SAMPLE, path: "/a" }], null, 2) + "\n")
})

test("an edit changes the keys it names and leaves everything else alone", async () => {
  // The whole reason this is a partial update. `registerProject` refuses a
  // re-register with a 409 because `addProject` replaces a record wholesale,
  // and a second trip through a three-field dialog would reset a budget or an
  // allowlist tuned by hand. An edit that rebuilt the record through
  // `defaults()` would reintroduce exactly that.
  const { file } = await store()
  const tuned: Project = {
    ...SAMPLE,
    allowedTools: ["Read", "Edit", "Bash(flutter test)"],
    planModel: "claude-opus-5-5-thinking",
    planEffort: "max",
    implementEffort: "xhigh",
    budgetUsd: 93.5,
    reportPath: "build/reports/junit.xml",
  }
  await addProject(file, tuned)

  const edited = await updateProject(file, "/repo", { testCmd: "flutter test" })
  expect(edited).toMatchObject({ ok: true })
  if (!edited.ok) throw new Error("unreachable")
  expect(edited.project).toEqual({ ...tuned, testCmd: "flutter test" })
  expect(await loadProjects(file)).toEqual([{ ...tuned, testCmd: "flutter test" }])
})

test("an edit to a path that is not registered writes nothing", async () => {
  // Never an insert: an edit names a record that exists, and creating one here
  // would register a repository nobody checked was a repository at all.
  const { file } = await store()
  await addProject(file, SAMPLE)
  expect(await updateProject(file, "/elsewhere", { testCmd: "npm test" })).toEqual({
    ok: false,
    why: "not-registered",
  })
  expect(await loadProjects(file)).toEqual([SAMPLE])
})

test("an edit that names no change answers the stored record without writing", async () => {
  const { file } = await store()
  await writeFile(file, JSON.stringify([SAMPLE], null, 2) + "\n")
  const before = await stat(file)
  await Bun.sleep(10)
  const edited = await updateProject(file, "/repo", {})
  expect(edited).toEqual({ ok: true, project: SAMPLE })
  expect((await stat(file)).mtimeMs).toBe(before.mtimeMs)
})

test("an edit cannot change the record's identity", async () => {
  // `path` is what the run logs reference and what every start request keys
  // on, so moving it is a remove plus an add rather than an edit.
  const { file } = await store()
  await addProject(file, SAMPLE)
  expect(await updateProject(file, "/repo", { path: "/moved" })).toMatchObject({
    ok: false,
    why: "invalid",
  })
  expect(await loadProjects(file)).toEqual([SAMPLE])
})

test("an unknown field in an edit is refused by name, not dropped", async () => {
  const { file } = await store()
  await addProject(file, SAMPLE)
  const edited = await updateProject(file, "/repo", { configdir: "/home/me/.claude" })
  expect(edited).toMatchObject({ ok: false, why: "invalid" })
  if (edited.ok || edited.why !== "invalid") throw new Error("unreachable")
  expect(edited.message).toContain("configdir")
  expect(await loadProjects(file)).toEqual([SAMPLE])
})

/**
 * Every value each editable field can arrive as, against what it does.
 *
 * Accepting input, so CLAUDE.md's rule applies and this is a matrix rather
 * than a sample: the dimensions are **which field** and **what JSON delivered
 * for it**, and the costs are not symmetric. Over-accepting writes a record
 * the store will refuse to load again - bricked by its own tool - or silently
 * changes which account a project bills to. Over-rejecting means a setting
 * cannot be changed from the UI, which costs an edit in a file the user owns.
 */
interface EditRow {
  changes: Record<string, unknown>
  /** The field's value in the stored record afterwards, or `"refused"`. */
  then: unknown | "refused"
  why: string
}

const editRows: EditRow[] = [
  { changes: { testCmd: "flutter test" }, then: "flutter test", why: "the ordinary case" },
  { changes: { testCmd: "" }, then: "refused", why: "an empty test command runs as `sh -c \"\"`, which exits 0, and every task would pass without being run" },
  { changes: { testCmd: "   " }, then: "refused", why: "whitespace is the same mistake" },
  { changes: { testCmd: null }, then: "refused", why: "a required field has no spelling for absent, so null is an unfinished edit" },
  { changes: { testCmd: 7 }, then: "refused", why: "a number is not a command" },
  { changes: { account: "work" }, then: "work", why: "the edit the user asked for: the account was unsayable after registering" },
  { changes: { account: "personal" }, then: "personal", why: "and back again" },
  { changes: { account: "billing" }, then: "refused", why: "two words or nothing: a third spelling renders as neither chip colour" },
  { changes: { account: null }, then: "refused", why: "the store has no second spelling for an unsaid account; clearing one is a hand edit" },
  { changes: { configDir: "/home/me/.claude-personal" }, then: "/home/me/.claude-personal", why: "which profile the runs use, and so which credentials" },
  { changes: { configDir: null }, then: undefined, why: "null is the store's own spelling of the default profile, so it clears" },
  { changes: { configDir: "~/.claude-work" }, then: "refused", why: "the CLI expands no tilde, so a relative profile would be created next to the server's cwd" },
  { changes: { configDir: "" }, then: "refused", why: "blank is an unfinished edit, not a third spelling of absent" },
  { changes: { budgetUsd: 120 }, then: 120, why: "the next run's ceiling" },
  { changes: { budgetUsd: 0 }, then: "refused", why: "a ceiling that funds nothing is indistinguishable from a project that never runs" },
  { changes: { budgetUsd: -5 }, then: "refused", why: "nor can a negative one" },
  { changes: { budgetUsd: "120" }, then: "refused", why: "the shape a text input produces, and `Number(\"\")` is 0" },
]

for (const row of editRows) {
  const [field = "", sent] = Object.entries(row.changes)[0] ?? []
  test(`editing ${field} to ${JSON.stringify(sent) ?? "undefined"} -> ${JSON.stringify(row.then)} (${row.why})`, async () => {
    const { file } = await store()
    await addProject(file, SAMPLE)
    const edited = await updateProject(file, "/repo", row.changes)

    if (row.then === "refused") {
      expect(edited).toMatchObject({ ok: false, why: "invalid" })
      if (edited.ok || edited.why !== "invalid") throw new Error("unreachable")
      // The store's own prose, which names the field someone has to fix.
      expect(edited.message).toContain(field)
      // Refused before anything was written: a rejected edit must not be able
      // to leave a record every later load refuses.
      expect(await loadProjects(file)).toEqual([SAMPLE])
      return
    }
    expect(edited).toMatchObject({ ok: true })
    const stored = (await loadProjects(file))[0] as unknown as Record<string, unknown>
    expect(stored[field]).toEqual(row.then)
    // Nothing else moved.
    for (const [key, value] of Object.entries(SAMPLE)) {
      if (key === field) continue
      expect(stored[key], key).toEqual(value)
    }
  })
}

test("two edits of one project both land", async () => {
  // Read-modify-write again: without the queue both would read the same
  // snapshot and the second rename would drop the first one's change. Two
  // different fields, because that is the shape a lost update hides in - the
  // store still loads and only one of the two settings someone changed is in
  // it.
  const { file } = await store()
  await addProject(file, SAMPLE)
  await Promise.all([
    updateProject(file, "/repo", { testCmd: "first" }),
    updateProject(file, "/repo", { budgetUsd: 31 }),
  ])
  const stored = (await loadProjects(file))[0]
  expect(stored?.testCmd).toBe("first")
  expect(stored?.budgetUsd).toBe(31)
})

test("two edits of one field apply in the order they were called", async () => {
  // Length and field count cannot see this: both edits apply, but the wrong
  // one can end up last, so the user's newest change silently loses to the one
  // before it. Two **names for one store**, as the sibling case above uses,
  // because that is what makes the two calls take different numbers of
  // filesystem hops: a queue joined after the store's path had been resolved
  // would run in the order the filesystem answered rather than the order the
  // edits were made.
  const real = await store()
  const target = join(real.dir, "store.json")
  const { dir: linkDir } = await store()
  const link = join(linkDir, "projects.json")
  await symlink(target, link)
  await addProject(target, SAMPLE)

  const first = updateProject(link, "/repo", { testCmd: "first" })
  const second = updateProject(target, "/repo", { testCmd: "second" })
  await Promise.all([first, second])
  expect((await loadProjects(target))[0]?.testCmd).toBe("second")
})

test("an edit through a damaged store throws rather than answering not-registered", async () => {
  // The asymmetry addProject has: reading a damaged store as "no projects"
  // would answer 404 for a project that is still in the file, and the next
  // write would replace what was lost with one record.
  const { file } = await store()
  await writeFile(file, '[{ "path": "/repo", oops }]')
  await expect(updateProject(file, "/repo", { testCmd: "npm test" })).rejects.toThrow(/projects\.json/)
  await expect(removeProject(file, "/repo")).rejects.toThrow(/projects\.json/)
})

test("projectIdentity is the one rule for which record a path names", async () => {
  // Exported because the server has to answer the same question before it
  // touches the store - a live run is matched by project path - and a second
  // copy of "absolute, then normalise" is how two spellings become one record
  // here and two somewhere else.
  expect(projectIdentity("/repo/")).toBe("/repo")
  expect(projectIdentity("/repo/sub/..")).toBe("/repo")
  expect(() => projectIdentity("repo")).toThrow(/absolute repo path/)
  expect(() => projectIdentity("")).toThrow(/non-empty string/)
  expect(() => projectIdentity(null)).toThrow(/non-empty string/)
  // No realpath: a project is most often removed because its repo is gone, and
  // a rule that needed the directory to exist could not remove it.
  expect(projectIdentity("/definitely/not/here")).toBe("/definitely/not/here")
})
