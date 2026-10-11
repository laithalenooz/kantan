import { expect, test } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { deriveAllowedTools, permissionArgs } from "../src/permissions"
import type { Project } from "../src/projects"
import type { PhaseSpawn } from "../src/spawn"

/**
 * Every assertion here reads the **fake binary's own invocation log**, not a
 * value this file handed to the spawner. That is the point: the flag set is a
 * contract with another process, and a test that re-read its own input would
 * pass against a module that built argv and then threw it away.
 *
 * `CLAUDE_BIN` binds when `src/version.ts` loads (docs/HANDOFF.md), so setting
 * `process.env.ORCH_CLAUDE_BIN` in a test body is a no-op. Every case therefore
 * runs `spawnPhase` in a **fresh process**, through a generated driver script,
 * following the pattern in `test/version.test.ts`.
 */

const repoRoot = join(import.meta.dir, "..")
const FAKE = join(import.meta.dir, "fake-claude.ts")
const SPAWN = join(repoRoot, "src/spawn.ts")
const FIXTURES = join(import.meta.dir, "fixtures")
const PLAN = join(FIXTURES, "plan-success.jsonl")
const QUESTION = join(FIXTURES, "ends-with-question.jsonl")
const BUDGET = join(FIXTURES, "budget-exhausted.jsonl")

/**
 * The driver, generated because it must be a separate process and
 * `.orch-test/` is gitignored. It is typechecked along with everything else,
 * since `tsconfig.json` has no `exclude`.
 *
 * It consumes stdout unconditionally: `plan-success.jsonl` is 93 KB, larger
 * than a pipe buffer, so an unread stdout wedges the child and `exited` never
 * resolves. A case that forgot would time out rather than fail, which is the
 * hardest kind of failure to read.
 */
const DRIVER = `import { spawnPhase } from ${JSON.stringify(SPAWN)}

type Spec = Parameters<typeof spawnPhase>[0]

const specPath = Bun.argv[2]
const outPath = Bun.argv[3]
if (specPath === undefined || outPath === undefined) throw new Error("usage: driver <spec> <out>")

const job = JSON.parse(await Bun.file(specPath).text()) as {
  spec: Record<string, unknown>
  prompts?: string[]
  stop?: string
  cursor?: string
}

// JSON cannot carry NaN or Infinity, so the suite spells them "@@NaN" and the
// number is restored here rather than being invented by src/spawn.ts.
const budget = job.spec["remainingUsd"]
if (typeof budget === "string" && budget.startsWith("@@")) {
  job.spec["remainingUsd"] = Number(budget.slice(2))
}

const out: Record<string, unknown> = {}

/** Waits until the double records the session as resumable, which it does only
 * once a turn's replay has finished (docs/HANDOFF.md): a SIGTERM mid-turn
 * leaves the session unresumable, so a kill timed off stdout alone is racy. */
async function resumable(cursorPath: string, session: string): Promise<boolean> {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const file = Bun.file(cursorPath)
    if (await file.exists()) {
      const cursor = JSON.parse(await file.text()) as { sessions?: unknown }
      if (Array.isArray(cursor.sessions) && cursor.sessions.includes(session)) return true
    }
    await Bun.sleep(10)
  }
  return false
}

function countResults(text: string): number {
  return text.split(String.fromCharCode(10)).filter((line) => {
    try {
      return (JSON.parse(line) as { type?: unknown }).type === "result"
    } catch {
      return false
    }
  }).length
}

try {
  const phase = spawnPhase(job.spec as unknown as Spec)
  out["argv"] = phase.argv
  const stdout = new Response(phase.stdout).text()
  const prompts = job.prompts ?? []
  const first = prompts[0] ?? "go"

  if (job.stop === "race") {
    // close() in the same tick as send(), without awaiting it. The drain is
    // what has to make this safe.
    let settled = false
    const sent = phase.send(first).then(() => {
      settled = true
    })
    await phase.close()
    out["sendSettledBeforeClose"] = settled
    await sent
    out["exit"] = await phase.exited
  } else if (job.stop === "sigterm") {
    for (const prompt of prompts) await phase.send(prompt)
    out["resumableBeforeKill"] = await resumable(job.cursor ?? "", String(job.spec["sessionId"]))
    out["exit"] = await phase.terminate()
  } else if (job.stop === "after-close") {
    await phase.send(first)
    await phase.close()
    try {
      await phase.send("too late")
      out["afterClose"] = "resolved"
    } catch (e) {
      out["afterClose"] = (e as Error).message
    }
    out["exit"] = await phase.exited
  } else {
    for (const prompt of prompts) await phase.send(prompt)
    await phase.close()
    out["exit"] = await phase.exited
  }

  const text = await stdout
  out["results"] = countResults(text)
} catch (e) {
  out["error"] = (e as Error).message
}

await Bun.write(outPath, JSON.stringify(out))
`

interface Ws {
  dir: string
  script: string
  cursor: string
  log: string
  driver: string
  runs: number
}

type Turn = { fixture: string; cost?: number }

/** A scratch directory per test, so no script, cursor or argv log is shared. */
async function workspace(name: string, turns: Turn[] = [{ fixture: PLAN }]): Promise<Ws> {
  const dir = join(repoRoot, ".orch-test", "spawn", name)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  const script = join(dir, "script.json")
  await writeFile(script, JSON.stringify({ turns }))
  const driver = join(dir, "driver.ts")
  await writeFile(driver, DRIVER)
  return { dir, script, cursor: `${script}.cursor`, log: join(dir, "argv.jsonl"), driver, runs: 0 }
}

/**
 * A project record.
 *
 * A plain record rather than a typed literal, because `permissionMode` and
 * `allowedTools` belong to Task 8b: before it lands they are not fields of
 * `Project` and an excess-property check rejects them, after it lands they are
 * required. A record typechecks either way, which is the same reason
 * `src/spawn.ts` reads both fields defensively.
 */
function project(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: repoRoot,
    testCmd: "bun test",
    // bypassPermissions everywhere except the permission cases themselves, so
    // nothing else depends on an allowlist Task 8b owns.
    permissionMode: "bypassPermissions",
    allowedTools: null,
    budgetUsd: 50,
    planModel: "claude-opus-5-5",
    implementModel: "claude-sonnet-5-5",
    planEffort: "high",
    implementEffort: "medium",
    resumePlanSession: false,
    ...over,
  }
}

/** A `PhaseSpawn`, as JSON for the driver. */
function spec(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project: project(),
    sessionId: randomUUID(),
    resume: false,
    model: "claude-sonnet-5-5",
    effort: "medium",
    remainingUsd: 5,
    ...over,
  }
}

interface Out {
  argv?: string[]
  error?: string
  exit?: { code: number | null; signal: string | null; stderr: string }
  results?: number
  sendSettledBeforeClose?: boolean
  resumableBeforeKill?: boolean
  afterClose?: string
}

interface Job {
  spec: Record<string, unknown>
  prompts?: string[]
  stop?: "close" | "race" | "sigterm" | "after-close"
  /** Environment of the driver, which `spawnPhase` passes on to the child. */
  env?: Record<string, string | undefined>
}

/**
 * The driver's environment: the ambient one with every `ORCH_FAKE_*` stripped
 * and `CLAUDE_CONFIG_DIR` deleted, plus what the case asks for.
 *
 * Both scrubs matter. A script inherited from the developer's shell would make
 * a refusal depend on who ran the suite, and an ambient `CLAUDE_CONFIG_DIR`
 * would let "set only when the project names one" pass for the wrong reason on
 * one machine and fail on another (docs/HANDOFF.md).
 */
function driverEnv(ws: Ws, over: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("ORCH_FAKE_")) env[key] = value
  }
  delete env["CLAUDE_CONFIG_DIR"]
  env["ORCH_CLAUDE_BIN"] = FAKE
  env["ORCH_FAKE_SCRIPT"] = ws.script
  env["ORCH_FAKE_ARGV_LOG"] = ws.log
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

/** Runs one `spawnPhase` call in a fresh process and reports what it saw. */
async function drive(ws: Ws, job: Job): Promise<Out> {
  const n = ws.runs++
  const specPath = join(ws.dir, `spec-${n}.json`)
  const outPath = join(ws.dir, `out-${n}.json`)
  await writeFile(specPath, JSON.stringify({ ...job, cursor: ws.cursor }))

  const p = Bun.spawn([process.execPath, "run", ws.driver, specPath, outPath], {
    env: driverEnv(ws, job.env),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  if (code !== 0) throw new Error(`driver exited ${code}\nstdout: ${out}\nstderr: ${err}`)
  return JSON.parse(await readFile(outPath, "utf8")) as Out
}

type LogRecord = Record<string, unknown>

async function readLog(path: string): Promise<LogRecord[]> {
  const text = await readFile(path, "utf8").catch(() => "")
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as LogRecord)
}

/** Every invocation the double logged, in order. */
async function spawns(ws: Ws): Promise<LogRecord[]> {
  return (await readLog(ws.log)).filter((r) => r["kind"] === "spawn")
}

/** Every turn the double served, in order. */
async function turns(ws: Ws): Promise<LogRecord[]> {
  return (await readLog(ws.log)).filter((r) => r["kind"] === "turn")
}

/** Invocation `i`, failing loudly rather than asserting against undefined. */
async function spawnAt(ws: Ws, i: number): Promise<LogRecord> {
  const all = await spawns(ws)
  const record = all[i]
  if (record === undefined) throw new Error(`wanted invocation ${i}, the double logged ${all.length}`)
  return record
}

/** The single invocation, failing loudly when there was not exactly one. */
async function onlySpawn(ws: Ws): Promise<LogRecord> {
  expect((await spawns(ws)).length).toBe(1)
  return spawnAt(ws, 0)
}

function argvOf(record: LogRecord): string[] {
  const argv = record["argv"]
  if (!Array.isArray(argv)) throw new Error(`no argv in ${JSON.stringify(record)}`)
  return argv as string[]
}

/** The token after `flag`, or undefined when the flag is absent. */
function flagValue(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag)
  return at === -1 ? undefined : argv[at + 1]
}

function envKeysOf(record: LogRecord): string[] {
  return record["envKeys"] as string[]
}

function envOf(record: LogRecord): Record<string, string> {
  return record["env"] as Record<string, string>
}

/** The prompt text out of a turn's raw stdin line. */
function promptOf(record: LogRecord): string {
  const message = JSON.parse(String(record["stdin"])) as {
    message?: { content?: { text?: unknown }[] }
  }
  return String(message.message?.content?.[0]?.text)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ---------------------------------------------------------------------------
// Which session flag, and whose session id.
//
// docs/HANDOFF.md: a run owns planSessionId and implementSessionId, and using
// the wrong one runs the implement prompt inside the planning conversation and
// still exits success. There is no error to catch, so the only defence is that
// this module cannot choose, substitute or derive a session id at all.
// ---------------------------------------------------------------------------

test("a fresh phase passes --session-id and never --resume", async () => {
  const ws = await workspace("fresh")
  const sessionId = randomUUID()
  const out = await drive(ws, { spec: spec({ sessionId, resume: false }), prompts: ["plan this"] })

  expect(out.error).toBeUndefined()
  const argv = argvOf(await onlySpawn(ws))
  expect(flagValue(argv, "--session-id")).toBe(sessionId)
  expect(argv).not.toContain("--resume")
}, 20000)

test("a resumed phase passes --resume and never --session-id", async () => {
  // The double refuses both together the way the real CLI does, so a module
  // passing both would exit 1 here rather than quietly preferring one.
  const ws = await workspace("resumed", [{ fixture: PLAN }, { fixture: QUESTION }])
  const sessionId = randomUUID()
  await drive(ws, { spec: spec({ sessionId, resume: false }), prompts: ["plan this"] })
  const out = await drive(ws, { spec: spec({ sessionId, resume: true }), prompts: ["and again"] })

  expect(out.error).toBeUndefined()
  expect(out.exit?.code).toBe(0)
  const argv = argvOf(await spawnAt(ws, 1))
  expect(flagValue(argv, "--resume")).toBe(sessionId)
  expect(argv).not.toContain("--session-id")
}, 25000)

test("the caller's session id reaches argv verbatim, and no other uuid does", async () => {
  // Verbatim, and alone. The second half is what rules out a substitution:
  // every uuid-shaped token in argv must be the one the caller passed, so a
  // run id reaching the CLI under any flag would show up here.
  const ws = await workspace("verbatim")
  const sessionId = randomUUID()
  const out = await drive(ws, { spec: spec({ sessionId }), prompts: ["plan this"] })

  expect(out.error).toBeUndefined()
  const argv = argvOf(await onlySpawn(ws))
  expect(argv).toContain(sessionId)
  expect(argv.filter((t) => UUID.test(t))).toEqual([sessionId])
}, 20000)

test("a run id handed in alongside the session id never reaches the child", async () => {
  // PhaseSpawn has no runId field - the compile-time half of this is below -
  // but a JSON body from the HTTP layer can carry one anyway, and the cost of
  // it winning is a phase run in the wrong conversation, silently.
  const ws = await workspace("no-run-id")
  const sessionId = randomUUID()
  const runId = randomUUID()
  const out = await drive(ws, { spec: spec({ sessionId, runId }), prompts: ["plan this"] })

  expect(out.error).toBeUndefined()
  const argv = argvOf(await onlySpawn(ws))
  expect(argv).not.toContain(runId)
  expect(argv).toContain(sessionId)
}, 20000)

test("PhaseSpawn has nowhere to put a run id", () => {
  // A compile-time assertion, enforced by `bun run typecheck` rather than by
  // this body: if PhaseSpawn ever grows a field a run id fits in, the expected
  // error below stops happening and tsc fails on the unused directive.
  const phaseSpec: PhaseSpawn = {
    project: undefined as unknown as Project,
    sessionId: randomUUID(),
    resume: false,
    model: "claude-sonnet-5-5",
    effort: "medium",
    remainingUsd: 1,
    // A run id is not a session id, and confusing the two still exits
    // `success` (docs/HANDOFF.md), so there must be nowhere to put one. The
    // directive has to be the last comment line: a comment after it consumes
    // it, and the assertion silently stops asserting.
    // @ts-expect-error - PhaseSpawn must not accept a run id
    runId: randomUUID(),
  }
  expect(phaseSpec.resume).toBe(false)
})

// ---------------------------------------------------------------------------
// Model and effort are the caller's, never the project's.
//
// Task 13 owns the phase-to-model mapping. A spawn layer that read
// project.planModel for "the model" would make the wrong-phase mistake
// impossible to write a test for, which is why they are arguments.
// ---------------------------------------------------------------------------

test("--model and --effort are the caller's values, not the project's defaults", async () => {
  const ws = await workspace("caller-model")
  const out = await drive(ws, {
    spec: spec({
      // Neither of the project's two models, and neither of its two efforts.
      model: "claude-haiku-5-5",
      effort: "xhigh",
      project: project({
        planModel: "claude-opus-5-5",
        implementModel: "claude-sonnet-5-5",
        planEffort: "high",
        implementEffort: "medium",
      }),
    }),
    prompts: ["plan this"],
  })

  expect(out.error).toBeUndefined()
  const argv = argvOf(await onlySpawn(ws))
  expect(flagValue(argv, "--model")).toBe("claude-haiku-5-5")
  expect(flagValue(argv, "--effort")).toBe("xhigh")
  expect(argv).not.toContain("claude-opus-5-5")
  expect(argv).not.toContain("claude-sonnet-5-5")
  expect(argv).not.toContain("high")
  expect(argv).not.toContain("medium")
}, 20000)

test("a resumed spawn carries a different effort than the one that started the session", async () => {
  // This is what makes escalation possible: --effort is spawn-time, and
  // --resume accepts a different one while keeping context (probed, §3.4).
  // Without it a stall could only be escalated by starting over.
  const ws = await workspace("escalate", [{ fixture: PLAN }, { fixture: QUESTION }])
  const sessionId = randomUUID()
  await drive(ws, { spec: spec({ sessionId, effort: "medium" }), prompts: ["implement"] })
  const out = await drive(ws, {
    spec: spec({ sessionId, resume: true, effort: "high" }),
    prompts: ["carry on"],
  })

  expect(out.error).toBeUndefined()
  expect(out.exit?.code).toBe(0)
  expect(flagValue(argvOf(await spawnAt(ws, 0)), "--effort")).toBe("medium")
  const second = argvOf(await spawnAt(ws, 1))
  expect(flagValue(second, "--effort")).toBe("high")
  expect(flagValue(second, "--resume")).toBe(sessionId)
  // Both turns in one session: the escalation resumed rather than restarted.
  expect((await turns(ws)).map((t) => t["session"])).toEqual([sessionId, sessionId])
}, 25000)

// ---------------------------------------------------------------------------
// --max-budget-usd, which bounds one PROCESS, not the run (probed, §3.4).
//
// The value is normalised, so CLAUDE.md's skipping-guard rule applies. The
// dimension is `remainingUsd` and every value it can take is enumerated here:
// positive, non-integer, zero, negative zero, negative, and non-finite. The
// directions are not symmetric. Zero or negative is a real run state - the
// ceiling is spent - and both the double and the real CLI refuse the flag at
// <= 0 (probed), so passing it through turns a budget stop into an unexplained
// commander error on stderr; a tiny positive floor instead reaches the
// designed `error_max_budget_usd` path. Non-finite is never a run state: it
// means the arithmetic upstream broke, and flooring it would hide that for the
// rest of the run.
// ---------------------------------------------------------------------------

test("--max-budget-usd is the caller's remainder, non-integer and verbatim", async () => {
  const ws = await workspace("budget-remainder")
  const out = await drive(ws, { spec: spec({ remainingUsd: 12.34 }), prompts: ["plan this"] })

  expect(out.error).toBeUndefined()
  expect(flagValue(argvOf(await onlySpawn(ws)), "--max-budget-usd")).toBe("12.34")
}, 20000)

test("a ceiling already spent passes a positive floor, never zero or negative", async () => {
  for (const [name, remainingUsd] of [
    ["zero", 0],
    ["negative-zero", -0],
    ["overspent", -12.5],
  ] as const) {
    const ws = await workspace(`budget-floor-${name}`)
    const out = await drive(ws, { spec: spec({ remainingUsd }), prompts: ["plan this"] })

    expect({ name, error: out.error }).toEqual({ name, error: undefined })
    const value = Number(flagValue(argvOf(await onlySpawn(ws)), "--max-budget-usd"))
    expect({ name, positive: value > 0 }).toEqual({ name, positive: true })
    // Small enough that it can never be mistaken for a budget: the next turn
    // must exhaust it, which is the designed stop.
    expect({ name, tiny: value < 0.001 }).toEqual({ name, tiny: true })
    // And the CLI accepted it, rather than refusing the flag with exit 1.
    expect({ name, code: out.exit?.code }).toEqual({ name, code: 0 })
  }
}, 45000)

test("a non-finite remainder is refused before the child is spawned", async () => {
  for (const bad of ["NaN", "Infinity", "-Infinity"]) {
    const ws = await workspace(`budget-${bad}`)
    const out = await drive(ws, { spec: spec({ remainingUsd: `@@${bad}` }), prompts: ["plan this"] })

    expect({ bad, named: (out.error ?? "").includes("remainingUsd") }).toEqual({ bad, named: true })
    // Nothing was spawned: a refusal after the fact would still have started a
    // process against an unknown budget.
    expect({ bad, spawned: (await spawns(ws)).length }).toEqual({ bad, spawned: 0 })
  }
}, 45000)

// ---------------------------------------------------------------------------
// The flags that are the same every time, and break everything when dropped.
// ---------------------------------------------------------------------------

test("--verbose is always present, fresh or resumed", async () => {
  // Without it the real CLI exits 1 and stream-json emits nothing at all
  // (probed), so a regression here breaks every run with no obvious cause.
  const ws = await workspace("verbose", [{ fixture: PLAN }, { fixture: QUESTION }])
  const sessionId = randomUUID()
  await drive(ws, { spec: spec({ sessionId }), prompts: ["plan this"] })
  await drive(ws, { spec: spec({ sessionId, resume: true }), prompts: ["again"] })

  const all = await spawns(ws)
  expect(all.length).toBe(2)
  for (const record of all) expect(argvOf(record)).toContain("--verbose")
}, 25000)

test("the whole invocation is the one design §3.1 dictates", async () => {
  // The flag set as a unit, so a reordering or a dropped pair reads as one
  // diff rather than as a mystery refusal later.
  const ws = await workspace("flag-set")
  const sessionId = randomUUID()
  const out = await drive(ws, {
    spec: spec({ sessionId, model: "claude-sonnet-5-5", effort: "medium", remainingUsd: 5 }),
    prompts: ["plan this"],
  })

  expect(out.error).toBeUndefined()
  const record = await onlySpawn(ws)
  expect(argvOf(record)).toEqual([
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--model",
    "claude-sonnet-5-5",
    "--effort",
    "medium",
    "--max-budget-usd",
    "5",
    "--session-id",
    sessionId,
  ])
  // The handle reports what was actually passed, for the run log header.
  expect(out.argv).toEqual(argvOf(record))
}, 20000)

test("the child runs in the project's checkout", async () => {
  const ws = await workspace("cwd")
  const out = await drive(ws, { spec: spec({ project: project({ path: ws.dir }) }), prompts: ["x"] })

  expect(out.error).toBeUndefined()
  expect((await onlySpawn(ws))["cwd"]).toBe(ws.dir)
}, 20000)

// ---------------------------------------------------------------------------
// CLAUDE_CONFIG_DIR: which account, which CLAUDE.md, which skills.
// ---------------------------------------------------------------------------

test("CLAUDE_CONFIG_DIR is set when the project names one", async () => {
  const ws = await workspace("config-dir")
  const configDir = join(ws.dir, "profile")
  await mkdir(configDir, { recursive: true })
  const out = await drive(ws, {
    spec: spec({ project: project({ configDir }) }),
    prompts: ["plan this"],
  })

  expect(out.error).toBeUndefined()
  expect(envOf(await onlySpawn(ws))["CLAUDE_CONFIG_DIR"]).toBe(configDir)
}, 20000)

test("CLAUDE_CONFIG_DIR is absent, not empty, when the project names none", async () => {
  // Absent from the child's environment, not merely absent from the log, which
  // is what envKeys is for. An empty string would name the directory "" rather
  // than meaning "the default profile".
  const ws = await workspace("no-config-dir")
  const out = await drive(ws, { spec: spec(), prompts: ["plan this"] })

  expect(out.error).toBeUndefined()
  expect(envKeysOf(await onlySpawn(ws))).not.toContain("CLAUDE_CONFIG_DIR")
}, 20000)

test("an ambient CLAUDE_CONFIG_DIR does not leak into a project that names none", async () => {
  // The decision this asserts: absent means the default profile, always. A
  // server launched from a shell that exports CLAUDE_CONFIG_DIR would
  // otherwise run such a project against that profile - a different account,
  // CLAUDE.md and skill set - with nothing to show why.
  const ws = await workspace("ambient-config-dir")
  const ambient = join(ws.dir, "ambient-profile")
  await mkdir(ambient, { recursive: true })
  const out = await drive(ws, {
    spec: spec(),
    prompts: ["plan this"],
    env: { CLAUDE_CONFIG_DIR: ambient },
  })

  expect(out.error).toBeUndefined()
  expect(envKeysOf(await onlySpawn(ws))).not.toContain("CLAUDE_CONFIG_DIR")
}, 20000)

test("the child inherits PATH, which its own shebang needs", async () => {
  // docs/HANDOFF.md: a curated environment without PATH gets exit 127 from
  // env, which looks like neither a CLI error nor a refusal by the double.
  const ws = await workspace("path")
  const out = await drive(ws, { spec: spec(), prompts: ["plan this"] })

  expect(out.error).toBeUndefined()
  expect(out.exit?.code).toBe(0)
  expect(envKeysOf(await onlySpawn(ws))).toContain("PATH")
}, 20000)

// ---------------------------------------------------------------------------
// Permissions. Task 8b owns project.permissionMode and project.allowedTools;
// this module only forwards them.
// ---------------------------------------------------------------------------

test("--permission-mode comes from the project", async () => {
  const ws = await workspace("permission-mode")
  const out = await drive(ws, {
    spec: spec({
      project: project({ permissionMode: "acceptEdits", allowedTools: ["Edit", "Bash(git *)"] }),
    }),
    prompts: ["plan this"],
  })

  expect(out.error).toBeUndefined()
  expect(flagValue(argvOf(await onlySpawn(ws)), "--permission-mode")).toBe("acceptEdits")
}, 20000)

test("acceptEdits passes the project's allowlist as one argv token", async () => {
  // One token, because the double takes one value and a rule contains a space:
  // `Bash(git *)` split over two tokens would be dropped from the allowlist,
  // which is a permissions change nobody asked for (docs/HANDOFF.md).
  const ws = await workspace("allowed-tools")
  const allowedTools = ["Edit", "Write", "Bash(git *)", "Bash(bun *)"]
  const out = await drive(ws, {
    spec: spec({ project: project({ permissionMode: "acceptEdits", allowedTools }) }),
    prompts: ["plan this"],
  })

  expect(out.error).toBeUndefined()
  const argv = argvOf(await onlySpawn(ws))
  expect(flagValue(argv, "--allowedTools")?.split(",")).toEqual(allowedTools)
  expect(argv.filter((t) => t === "--allowedTools").length).toBe(1)
}, 20000)

test("bypassPermissions omits --allowedTools entirely", async () => {
  // The flag is meaningless with it, and passing one anyway would suggest a
  // bound that is not there.
  const ws = await workspace("bypass-no-allowlist")
  const out = await drive(ws, {
    spec: spec({
      project: project({ permissionMode: "bypassPermissions", allowedTools: ["Edit"] }),
    }),
    prompts: ["plan this"],
  })

  expect(out.error).toBeUndefined()
  expect(argvOf(await onlySpawn(ws))).not.toContain("--allowedTools")
}, 20000)

test("acceptEdits with a null allowlist passes the derived set", async () => {
  // `null` is the design's spelling of "derive it" (§2.2), and the derivation
  // is src/permissions.ts's. What this asserts is that the derived rules reach
  // argv rather than the flag being quietly omitted: acceptEdits without
  // `Bash` cannot run the project's own suite, and in headless mode anything
  // that would prompt is auto-denied, so such a run fails several minutes
  // later for a reason nothing connects back to one missing flag.
  const ws = await workspace("derived-allowlist")
  const record = project({ permissionMode: "acceptEdits", allowedTools: null })
  const out = await drive(ws, { spec: spec({ project: record }), prompts: ["plan this"] })

  expect(out.error).toBeUndefined()
  const derived = deriveAllowedTools(record as unknown as Project)
  expect(flagValue(argvOf(await onlySpawn(ws)), "--allowedTools")?.split(",")).toEqual(derived)
  // A rule for the project's own test runner, beyond the git one, so the suite
  // the agent writes against is actually runnable.
  expect(derived.some((rule) => rule.startsWith("Bash(") && rule !== "Bash(git *)")).toBe(true)
}, 20000)

test("the permission flags are the permissions module's, spliced in unchanged", async () => {
  // One owner. A second copy of "which mode, and does an allowlist come with
  // it" in src/spawn.ts could drift from the copy that is tested against the
  // derivation, and the drift would read as a permissions change nobody made.
  const ws = await workspace("permission-seam")
  const record = project({ permissionMode: "acceptEdits", allowedTools: ["Edit", "Bash(git *)"] })
  const out = await drive(ws, { spec: spec({ project: record }), prompts: ["plan this"] })

  expect(out.error).toBeUndefined()
  const argv = argvOf(await onlySpawn(ws))
  const expected = permissionArgs(record as unknown as Project)
  const at = argv.indexOf("--permission-mode")
  // Checked, because slicing from -1 would compare a tail against a tail and
  // pass while the flags were missing altogether.
  expect(at).toBeGreaterThanOrEqual(0)
  expect(argv.slice(at, at + expected.length)).toEqual(expected)
}, 20000)

// ---------------------------------------------------------------------------
// Stdin: the prompt goes in, and the close does not cut it off.
//
// Design §5: closing stdin the moment a result arrived produced
// `SessionEnd hook [...] failed: Hook cancelled` on stderr in every probe. The
// double deliberately does not reproduce that message, so these cases assert
// the drain itself - that every byte written reached the child before the
// close - and cannot see the hook failure. Only the real binary can.
// ---------------------------------------------------------------------------

test("the prompt reaches the child as one stream-json user message", async () => {
  const ws = await workspace("prompt-shape")
  const prompt = "write the plan to docs/plans/x.md\n\nORCH: done when finished"
  const out = await drive(ws, { spec: spec(), prompts: [prompt] })

  expect(out.error).toBeUndefined()
  const turn = (await turns(ws))[0]
  if (turn === undefined) throw new Error("the double served no turn")
  expect(JSON.parse(String(turn["stdin"]))).toEqual({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: prompt }] },
  })
}, 20000)

test("stdin is drained before it is closed", async () => {
  // close() called in the same tick as send(), without awaiting it. The
  // observable is twofold: the write has settled by the time close() resolves,
  // and the child got the whole turn and answered it. An end() that did not
  // await the queued write would leave the first false and the child at EOF
  // with nothing to replay.
  const ws = await workspace("drain")
  const out = await drive(ws, { spec: spec(), prompts: ["plan this"], stop: "race" })

  expect(out.error).toBeUndefined()
  expect(out.sendSettledBeforeClose).toBe(true)
  expect(out.results).toBe(1)
  expect(out.exit?.code).toBe(0)
  expect((await turns(ws)).length).toBe(1)
}, 20000)

test("a prompt larger than a pipe buffer survives the close whole", async () => {
  // 64 KB is the usual pipe buffer, so this write cannot be handed over in one
  // go and the close has to wait for it.
  const ws = await workspace("drain-big")
  const prompt = "x".repeat(300_000)
  const out = await drive(ws, { spec: spec(), prompts: [prompt], stop: "race" })

  expect(out.error).toBeUndefined()
  const turn = (await turns(ws))[0]
  if (turn === undefined) throw new Error("the double served no turn")
  expect(promptOf(turn).length).toBe(prompt.length)
  expect(out.exit?.code).toBe(0)
}, 25000)

test("a turn sent after the close is refused, not silently dropped", async () => {
  // Probed on Bun 1.4.3: a write after end() reports success and the bytes
  // never reach the child. A phase that then waited for the result of a turn
  // the CLI was never asked for would read as a stall, so the second send has
  // to fail instead.
  const ws = await workspace("after-close", [{ fixture: PLAN }, { fixture: QUESTION }])
  const out = await drive(ws, { spec: spec(), prompts: ["plan this"], stop: "after-close" })

  expect(out.error).toBeUndefined()
  expect(out.afterClose ?? "").toContain("closed")
  expect((await turns(ws)).length).toBe(1)
}, 20000)

test("two turns arrive in the order they were sent", async () => {
  const ws = await workspace("ordering", [{ fixture: PLAN }, { fixture: QUESTION }])
  const out = await drive(ws, { spec: spec(), prompts: ["first", "second"] })

  expect(out.error).toBeUndefined()
  expect((await turns(ws)).map(promptOf)).toEqual(["first", "second"])
  expect(out.results).toBe(2)
}, 25000)

// ---------------------------------------------------------------------------
// Stopping, and what is left behind.
// ---------------------------------------------------------------------------

test("SIGTERM resolves without throwing", async () => {
  // Design §3.4's stop button. The kill lands between turns, because the
  // double marks a session resumable only once a turn's replay finished
  // (docs/HANDOFF.md), which is also what the next case needs.
  const ws = await workspace("sigterm", [{ fixture: PLAN }, { fixture: QUESTION }])
  const sessionId = randomUUID()
  const out = await drive(ws, {
    spec: spec({ sessionId }),
    prompts: ["plan this"],
    stop: "sigterm",
  })

  expect(out.error).toBeUndefined()
  expect(out.resumableBeforeKill).toBe(true)
  expect(out.exit?.signal).toBe("SIGTERM")
}, 25000)

test("the session is still resumable after a SIGTERM", async () => {
  // "The session resumes from the same id, so stopping costs nothing" (§3.4).
  // The double keys resumability on a turn having been served, exactly as the
  // real CLI refuses an id no session ever used (probed).
  const ws = await workspace("sigterm-resume", [{ fixture: PLAN }, { fixture: QUESTION }])
  const sessionId = randomUUID()
  await drive(ws, { spec: spec({ sessionId }), prompts: ["plan this"], stop: "sigterm" })
  const out = await drive(ws, {
    spec: spec({ sessionId, resume: true, effort: "high" }),
    prompts: ["carry on"],
  })

  expect(out.error).toBeUndefined()
  expect(out.exit?.code).toBe(0)
  expect(out.results).toBe(1)
  expect((await turns(ws)).map((t) => t["session"])).toEqual([sessionId, sessionId])
}, 30000)

test("a non-zero exit surfaces rather than hanging", async () => {
  // The double exits 1 on a replayed error result, as the real CLI does on
  // budget exhaustion (probed). The code is the caller's to read: a rejection
  // here would make a normal, raisable stop look like a crash.
  const ws = await workspace("non-zero", [{ fixture: BUDGET }])
  const out = await drive(ws, { spec: spec(), prompts: ["plan this"] })

  expect(out.error).toBeUndefined()
  expect(out.exit?.code).toBe(1)
  expect(out.exit?.signal).toBeNull()
  expect(out.results).toBe(1)
}, 20000)

test("stderr from a refused invocation is kept, not discarded", async () => {
  // Design §5: "claude exits non-zero -> mark failed, keep stderr in the log."
  // An invalid permission mode is a refusal the double and the real CLI share,
  // so it stands in for any stderr-only failure. What this module may never do
  // is exit non-zero with the reason thrown away.
  const ws = await workspace("stderr")
  const out = await drive(ws, {
    spec: spec({ project: project({ permissionMode: "nonsense" }) }),
    prompts: ["plan this"],
  })

  expect(out.error).toBeUndefined()
  expect(out.exit?.code).toBe(1)
  expect(out.exit?.stderr).toContain("--permission-mode")
}, 20000)
