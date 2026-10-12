import { expect, test } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
// Safe to import directly: `src/git.ts` spawns `git`, never `claude`, so it
// carries none of `CLAUDE_BIN`'s load-time binding.
import { taskBranchName } from "../src/git"

/**
 * The phase machine, driven end to end against `test/fake-claude.ts`.
 *
 * **No test here may reach the real API.** `CLAUDE_BIN` binds when
 * `src/version.ts` loads (docs/HANDOFF.md), so setting
 * `process.env.ORCH_CLAUDE_BIN` in a test body is a no-op: every case runs the
 * machine in a **fresh process**, through a generated driver, with
 * `ORCH_CLAUDE_BIN` in that process's environment. This is the pattern
 * `test/spawn.test.ts` and `test/version.test.ts` already use, and it is the
 * only one that cannot accidentally spawn the developer's real `claude`.
 *
 * Assertions read four artefacts, never a value the test handed in:
 *
 * - the double's **argv log**, for which session flag, model and effort each
 *   process was actually invoked with;
 * - the **run log**, for what the machine recorded;
 * - **git**, for the branch, the tick commit and where the checkout ended up;
 * - the **lock file**, for whether it was released.
 */

const repoRoot = join(import.meta.dir, "..")
const FAKE = join(import.meta.dir, "fake-claude.ts")
const RUN = join(repoRoot, "src/run.ts")
const PLAN_FIXTURE = join(import.meta.dir, "fixtures", "plan-success.jsonl")

const OPUS = "claude-opus-5-5"
const SONNET = "claude-sonnet-5-5"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The driver. A separate process per case, generated because `.orch-test/` is
 * gitignored and therefore **not typechecked**: a type error in here surfaces
 * as a driver that fails at runtime, which `drive` reports with its stderr.
 *
 * It executes a list of actions in order, so one case can start a run, approve
 * its gate and let the implement loop finish, the way the server will.
 */
const DRIVER = `import * as run from ${JSON.stringify(RUN)}
import { readdirSync, readFileSync } from "node:fs"

const jobPath = Bun.argv[2]
const outPath = Bun.argv[3]
if (jobPath === undefined || outPath === undefined) throw new Error("usage: driver <job> <out>")

type Call = { m: string; projectPath?: string; featureFile?: string; taskRef?: string; text?: string }
type Step = { action: string; text?: string; usd?: number; allowDirty?: boolean; calls?: Call[] }
const job = JSON.parse(await Bun.file(jobPath).text()) as {
  project: Record<string, unknown>
  featureFile: string
  task: { ref: string | null; text?: string }
  runsDir: string
  projectsFile: string
  runId?: string
  budgetUsd?: number
  steps: Step[]
  progress?: string
}

const results: unknown[] = []
let runId = job.runId ?? ""

/** What the run log held at the moment the transition was accepted. */
let atAccept: { records: number; kinds: string[] } | null = null
// The runner is constructed with this, so a case can see how far the run had
// got when the call came back.
const acceptHook = (): void => onAccepted()
/** The run log, found by listing the directory: during a start the run id is
 * not back from the call yet, and each case has a runs directory of its own. */
function logText(): string {
  try {
    const names = readdirSync(job.runsDir).filter((n) => n.endsWith(".jsonl"))
    const name = runId === "" ? names[0] : runId + ".jsonl"
    if (name === undefined) return ""
    return readFileSync(job.runsDir + "/" + name, "utf8")
  } catch {
    return ""
  }
}

function onAccepted(): void {
  if (atAccept !== null) return
  const text = logText()
  const lines = text.split(String.fromCharCode(10)).filter((l) => l.trim() !== "")
  atAccept = {
    records: lines.length,
    kinds: lines.map((l) => {
      try {
        const r = JSON.parse(l) as { kind?: unknown; state?: unknown; reason?: unknown }
        return String(r.kind) + ":" + String(r.state ?? "") + ":" + String(r.reason ?? "")
      } catch {
        return "unparsed"
      }
    }),
  }
}

/** The newest record that is not a cli payload: the run's lifecycle so far. */
function lastLifecycle(): string {
  const lines = logText().split(String.fromCharCode(10)).filter((l) => l.trim() !== "")
  let last = ""
  for (const line of lines) {
    try {
      const r = JSON.parse(line) as {
        kind?: unknown
        phase?: unknown
        state?: unknown
        reason?: unknown
        action?: unknown
      }
      if (r.kind === "cli") continue
      // The action stands in where there is no phase, so a human record says
      // which action it was. Only the stop needs telling apart: it is the one
      // human record that is not followed by a phase record.
      last = String(r.kind) + ":" + String(r.phase ?? r.action ?? "") + ":" + String(r.state ?? "")
    } catch {
      // A partial final line: not a record yet.
    }
  }
  return last
}

/**
 * Waits until the run has come to rest, the way a client watching the stream
 * would: the newest lifecycle record is a wait, the end, or a stop.
 *
 * The stop is the one added last and the reason this comment exists. Before
 * the interruption was recorded, a stopped run left whatever phase record it
 * had been in as the newest line - usually a waiting park - so this returned
 * by accident. With the record the newest line is human:stop, which is
 * neither, and the wait ran its full 120 seconds before throwing: a test
 * failed in a way that read as a hang inside resumeRun and was a harness that
 * did not know the state existed. A stopped run is at rest by definition -
 * nothing is driving it.
 */
async function untilRest(): Promise<void> {
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    const last = lastLifecycle()
    if (last.endsWith(":waiting") || last.startsWith("end:") || last.startsWith("human:stop")) return
    await Bun.sleep(20)
  }
  throw new Error("the run never came to rest, last record: " + lastLifecycle())
}

/** Waits until the run log satisfies the predicate, so a case can interleave actions. */
async function until(want: (kinds: string[]) => boolean): Promise<void> {
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    const kinds = logText()
      .split(String.fromCharCode(10))
      .filter((l) => l.trim() !== "")
      .map((l) => {
        try {
          const r = JSON.parse(l) as { kind?: unknown; phase?: unknown; state?: unknown }
          return String(r.kind) + ":" + String(r.phase ?? "") + ":" + String(r.state ?? "")
        } catch {
          return "unparsed"
        }
      })
    if (want(kinds)) return
    await Bun.sleep(20)
  }
  throw new Error("the run log never got there")
}

async function note(what: string): Promise<void> {
  if (job.progress !== undefined) await Bun.write(job.progress, what)
}

for (const step of job.steps) {
  const options = { runId, project: job.project as never, runsDir: job.runsDir }
  try {
    await note(step.action)
    if (step.action === "start") {
      const r = await run.startRun({
        accepted: onAccepted,
        project: job.project as never,
        featureFile: job.featureFile,
        task: job.task,
        runsDir: job.runsDir,
        ...(job.budgetUsd === undefined ? {} : { budgetUsd: job.budgetUsd }),
        ...(job.runId === undefined ? {} : { runId: job.runId }),
        ...(step.allowDirty === true ? { allowDirty: true } : {}),
      })
      runId = r.runId
      results.push(r)
    } else if (step.action === "approve") {
      results.push(await run.approveGate({ ...options, accepted: onAccepted }))
    } else if (step.action === "approve-twice") {
      // Both fired before either settles, the way two clicks arrive.
      const first = run.approveGate(options)
      const second = run.approveGate(options)
      const settled = await Promise.allSettled([first, second])
      results.push(
        settled.map((r) =>
          r.status === "fulfilled" ? r.value : { error: (r.reason as Error).message },
        ),
      )
    } else if (step.action === "approve-then-stop") {
      const driving = run.approveGate(options)
      await until((kinds) => kinds.includes("phase:test:running"))
      const stopped = await run.stopRun(options)
      const drove = await driving.catch((e: Error) => ({ error: e.message }))
      results.push({ stopped, drove })
    } else if (step.action === "feedback") {
      results.push(await run.sendFeedback({ ...options, feedback: step.text ?? "" }))
    } else if (step.action === "answer") {
      results.push(await run.answerQuestion({ ...options, answer: step.text ?? "" }))
    } else if (step.action === "raise") {
      // Caught here rather than by the loop's own handler, which stops: a case
      // needs to refuse one figure and then send a usable one.
      try {
        results.push(await run.raiseBudget({ ...options, budgetUsd: step.usd ?? 0 }))
      } catch (e) {
        results.push({ error: (e as Error).message, code: (e as { code?: unknown }).code })
      }
    } else if (step.action === "stop-absent") {
      // A stop on a run this process never drove, which is what the server
      // does after a restart.
      try {
        results.push(await run.stopRun(options))
      } catch (e) {
        results.push({ error: (e as Error).message, code: (e as { code?: unknown }).code })
      }
    } else if (step.action === "live") {
      results.push({ live: run.liveRunIds() })
    } else if (step.action === "runner") {
      // The port src/server.ts declares, driven exactly as the four routes do.
      const runner = run.createRunner({
        projectsFile: job.projectsFile,
        runsDir: job.runsDir,
        onAccepted: acceptHook,
      })
      const answers: unknown[] = []
      for (const call of step.calls ?? []) {
        if (call.m === "start") {
          const started = await runner.start({
            projectPath: call.projectPath ?? "",
            featureFile: call.featureFile ?? "",
            taskRef: call.taskRef ?? "",
          })
          const snapshot = atAccept
          atAccept = null
          answers.push({ started, atAccept: snapshot })
          if (started.ok) {
            runId = started.runId
            await untilRest()
          }
        } else if (call.m === "approve") {
          const acted = await runner.approve(runId)
          answers.push(acted)
          // Only an accepted action has a run to wait on; a refusal moved
          // nothing, and waiting for a rest point would wait forever.
          if (acted.ok) await untilRest()
        } else if (call.m === "feedback") {
          const acted = await runner.feedback(runId, call.text ?? "")
          answers.push(acted)
          // Only an accepted action has a run to wait on; a refusal moved
          // nothing, and waiting for a rest point would wait forever.
          if (acted.ok) await untilRest()
        } else if (call.m === "answer") {
          const acted = await runner.answer(runId, call.text ?? "")
          answers.push(acted)
          // Only an accepted action has a run to wait on; a refusal moved
          // nothing, and waiting for a rest point would wait forever.
          if (acted.ok) await untilRest()
        } else if (call.m === "resume") {
          const acted = await runner.resume(runId)
          answers.push(acted)
          // Only an accepted action has a run to wait on; a refusal moved
          // nothing, and waiting for a rest point would wait forever.
          if (acted.ok) await untilRest()
        } else if (call.m === "stop") {
          answers.push(await runner.stop(runId))
        } else {
          throw new Error("unknown runner call " + call.m)
        }
      }
      results.push(answers)
    } else if (step.action === "resume") {
      results.push(await run.resumeRun(options))
    } else if (step.action === "stop") {
      results.push(await run.stopRun(options))
    } else {
      throw new Error("unknown action " + step.action)
    }
  } catch (e) {
    // The code as well as the message: a refusal's code is what the UI
    // switches on - dirty is the only one it hangs stash advice off - so a
    // test checking the prose alone would pass for a run refused as
    // wrong-state with a message that happens to name a file.
    // (No backticks here: this whole driver is a template literal.)
    results.push({ error: (e as Error).message, code: (e as { code?: unknown }).code })
    break
  }
}

await Bun.write(outPath, JSON.stringify({ runId, results, atAccept }))
await note("finished")
`

interface Ws {
  dir: string
  repo: string
  runsDir: string
  script: string
  cursor: string
  log: string
  driver: string
  progress: string
  feature: string
  featurePath: string
  runs: number
}

type Turn = { fixture: string; cost?: number }

async function git(cwd: string, args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  if (code !== 0) throw new Error(`git ${args.join(" ")} in ${cwd} exited ${code}: ${err || out}`)
  return out
}

/** The house format, with one open task. */
function featureMarkdown(): string {
  return ["# Slugger", "", "- [ ] T1 Add a slug helper", "- [ ] T2 Something else", ""].join("\n")
}

/**
 * A scratch workspace per case: its own git repo, run log directory, turn
 * script, cursor and argv log, so nothing is shared between tests.
 */
async function workspace(
  name: string,
  opts: { turns?: Turn[]; feature?: string } = {},
): Promise<Ws> {
  // Keyed on the pid, not on the case name alone. This repo is developed with
  // several agents in one working tree and each of them runs `bun run check`,
  // so two processes **will** run this file at once - and with a shared
  // directory the second one's `rm -rf` deletes the first one's repo, cursor
  // and argv log mid-test. Reproduced: two concurrent runs failed 10 and 1
  // cases respectively; keyed per process, both pass.
  const dir = join(repoRoot, ".orch-test", "run", `${name}-${process.pid}`)
  await rm(dir, { recursive: true, force: true })
  const repo = join(dir, "repo")
  await mkdir(join(repo, "docs", "features"), { recursive: true })
  const featurePath = "docs/features/slugger.md"
  const feature = join(repo, featurePath)
  await writeFile(feature, opts.feature ?? featureMarkdown())
  await writeFile(join(repo, "README.md"), "# fixture repo\n")

  await git(repo, ["init", "--initial-branch=main"])
  // A tick is committed by the machine, so the repo needs an identity.
  await git(repo, ["config", "user.email", "kantan@example.invalid"])
  await git(repo, ["config", "user.name", "kantan tests"])
  await git(repo, ["add", "--", "README.md", featurePath])
  await git(repo, ["commit", "-m", "fixture"])

  const script = join(dir, "script.json")
  await writeFile(script, JSON.stringify({ turns: opts.turns ?? [{ fixture: PLAN_FIXTURE }] }))
  const driver = join(dir, "driver.ts")
  await writeFile(driver, DRIVER)
  return {
    dir,
    repo,
    runsDir: join(dir, "runs"),
    script,
    cursor: `${script}.cursor`,
    log: join(dir, "argv.jsonl"),
    driver,
    progress: join(dir, "progress.txt"),
    feature,
    featurePath,
    runs: 0,
  }
}

/**
 * A fixture the double will replay, written into the workspace.
 *
 * Hand-written fixtures need a `session_id` on every line and `is_error`,
 * `total_cost_usd` and exactly one result event on the result line
 * (docs/HANDOFF.md). The captured ones are 50-90 KB each; these are three
 * lines, which keeps a nine-turn escalation case fast. `plan-success.jsonl`
 * is still used where its **size** is the point.
 */
async function fixture(
  ws: Ws,
  name: string,
  final: string,
  opts: { subtype?: string; isError?: boolean; cost?: number; say?: string } = {},
): Promise<string> {
  const session = "00000000-0000-4000-8000-000000000000"
  const lines = [
    { type: "system", subtype: "init", session_id: session, cwd: ws.repo, tools: [], model: "x" },
    {
      type: "assistant",
      session_id: session,
      message: { role: "assistant", content: [{ type: "text", text: opts.say ?? final }] },
    },
    {
      type: "result",
      subtype: opts.subtype ?? "success",
      is_error: opts.isError ?? false,
      result: final,
      session_id: session,
      num_turns: 1,
      total_cost_usd: opts.cost ?? 0.01,
      permission_denials: [],
    },
  ]
  const path = join(ws.dir, `${name}.jsonl`)
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
  return path
}

/** Rewrites the turn script, for a case that scripts turns after the fixtures exist. */
async function script(ws: Ws, turns: Turn[]): Promise<void> {
  await writeFile(ws.script, JSON.stringify({ turns }))
}

function project(ws: Ws, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: ws.repo,
    testCmd: "true",
    // bypassPermissions throughout: the allowlist derivation is Task 8b's and
    // refuses several of the test commands these cases need.
    permissionMode: "bypassPermissions",
    allowedTools: null,
    budgetUsd: 50,
    planModel: OPUS,
    implementModel: SONNET,
    planEffort: "high",
    implementEffort: "medium",
    ...over,
  }
}

interface Job {
  /** Extra environment for the driver, which reaches the child too. */
  env?: Record<string, string>
  project?: Record<string, unknown>
  featureFile?: string
  task?: { ref: string | null; text?: string }
  runId?: string
  budgetUsd?: number
  steps: {
    action: string
    text?: string
    /** For the `raise` step: the new ceiling, in full. */
    usd?: number
    /** For the `start` step: begin even though the repo is dirty. */
    allowDirty?: boolean
    /** For the `runner` step: the port calls to make, in order. */
    calls?: {
      m: string
      projectPath?: string
      featureFile?: string
      taskRef?: string
      text?: string
    }[]
  }[]
}

interface Out {
  runId: string
  results: ({ error?: string } & Record<string, unknown>)[]
  atAccept: { records: number; kinds: string[] } | null
}

/**
 * The driver's environment: the ambient one with every `ORCH_FAKE_*` stripped
 * and `CLAUDE_CONFIG_DIR` deleted, plus this workspace's wiring. Both scrubs
 * matter: an inherited script would make a case depend on who ran the suite,
 * and an ambient `CLAUDE_CONFIG_DIR` would reach the child (docs/HANDOFF.md).
 */
function driverEnv(ws: Ws, over: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("ORCH_FAKE_")) env[key] = value
  }
  delete env["CLAUDE_CONFIG_DIR"]
  env["ORCH_CLAUDE_BIN"] = FAKE
  env["ORCH_FAKE_SCRIPT"] = ws.script
  env["ORCH_FAKE_ARGV_LOG"] = ws.log
  return { ...env, ...over }
}

function spawnDriver(ws: Ws, job: Job, jobPath: string, outPath: string) {
  return Bun.spawn([process.execPath, "run", ws.driver, jobPath, outPath], {
    env: driverEnv(ws, job.env ?? {}),
    stdout: "pipe",
    stderr: "pipe",
  })
}

async function writeJob(ws: Ws, job: Job, jobPath: string): Promise<void> {
  await writeFile(
    jobPath,
    JSON.stringify({
      project: job.project ?? project(ws),
      featureFile: job.featureFile ?? ws.featurePath,
      task: job.task ?? { ref: "T1", text: "Add a slug helper" },
      runsDir: ws.runsDir,
      projectsFile: join(ws.dir, "projects.json"),
      progress: ws.progress,
      ...(job.runId === undefined ? {} : { runId: job.runId }),
      ...(job.budgetUsd === undefined ? {} : { budgetUsd: job.budgetUsd }),
      steps: job.steps,
    }),
  )
}

/** Runs one driver to completion and reports what it saw. */
async function drive(ws: Ws, job: Job): Promise<Out> {
  const n = ws.runs++
  const jobPath = join(ws.dir, `job-${n}.json`)
  const outPath = join(ws.dir, `out-${n}.json`)
  await writeJob(ws, job, jobPath)
  const p = spawnDriver(ws, job, jobPath, outPath)
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  if (code !== 0) throw new Error(`driver exited ${code}\nstdout: ${out}\nstderr: ${err}`)
  return JSON.parse(await readFile(outPath, "utf8")) as Out
}

// --- Reading the artefacts --------------------------------------------------

type Record_ = Record<string, unknown>

async function readJsonl(path: string): Promise<Record_[]> {
  const text = await readFile(path, "utf8").catch(() => "")
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record_]
      } catch {
        return []
      }
    })
}

/**
 * Every phase invocation the double logged.
 *
 * `claudeVersion()` spawns the binary too, and the double logs that record
 * before it parses argv at all, so a `--version` call would otherwise count as
 * a phase and shift every index.
 */
async function spawns(ws: Ws): Promise<Record_[]> {
  return (await readJsonl(ws.log)).filter(
    (r) => r["kind"] === "spawn" && !(r["argv"] as string[]).includes("--version"),
  )
}

async function turns(ws: Ws): Promise<Record_[]> {
  return (await readJsonl(ws.log)).filter((r) => r["kind"] === "turn")
}

function argvOf(record: Record_): string[] {
  const argv = record["argv"]
  if (!Array.isArray(argv)) throw new Error(`no argv in ${JSON.stringify(record)}`)
  return argv as string[]
}

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name)
  return at === -1 ? undefined : argv[at + 1]
}

async function spawnAt(ws: Ws, i: number): Promise<string[]> {
  const all = await spawns(ws)
  const record = all[i]
  if (record === undefined) throw new Error(`wanted phase spawn ${i}, the double logged ${all.length}`)
  return argvOf(record)
}

/** The prompt text out of a turn's raw stdin line. */
function promptOf(record: Record_): string {
  const message = JSON.parse(String(record["stdin"])) as {
    message?: { content?: { text?: unknown }[] }
  }
  return String(message.message?.content?.[0]?.text)
}

async function runLog(ws: Ws, runId: string): Promise<Record_[]> {
  return readJsonl(join(ws.runsDir, `${runId}.jsonl`))
}

function header(records: Record_[]): Record_ {
  const first = records[0]
  if (first === undefined || first["kind"] !== "header") throw new Error("no header on line one")
  return first
}

function phases(records: Record_[]): Record_[] {
  return records.filter((r) => r["kind"] === "phase")
}

/**
 * Every `total_cost_usd` the log holds, in order - which is **not** the run's
 * spend.
 *
 * Within one process the figure is cumulative, so summing these double-counts
 * every turn but the last of each process. The helper exists so a case can
 * assert the wrong number as well as the right one: a suite that only asserts
 * the right one cannot show that it would notice the wrong one.
 */
function resultCosts(records: Record_[]): number[] {
  return records
    .filter((r) => r["kind"] === "cli")
    .map((r) => (r["event"] as Record_ | undefined) ?? {})
    .filter((e) => e["type"] === "result")
    .map((e) => Number(e["total_cost_usd"]))
}

/** Writes the project store the runner looks a start request up in. */
async function projectsFile(ws: Ws, records: Record<string, unknown>[]): Promise<string> {
  const path = join(ws.dir, "projects.json")
  await writeFile(path, JSON.stringify(records, null, 2))
  return path
}

async function lockExists(ws: Ws): Promise<boolean> {
  return Bun.file(join(ws.repo, ".git", "kantan-run.lock")).exists()
}

/** Whether a pid the double logged is still alive. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test("the plan phase ends at the gate, holding no live process", async () => {
  const ws = await workspace("gate")
  const out = await drive(ws, { steps: [{ action: "start" }] })

  expect(out.results[0]).toMatchObject({ state: { kind: "waiting", reason: "gate" } })

  const records = await runLog(ws, out.runId)
  const head = header(records)
  expect(head["runId"]).toBe(out.runId)
  expect(String(head["planSessionId"])).toMatch(UUID)

  const plan = phases(records)
  expect(plan[0]).toMatchObject({
    phase: "plan",
    state: "running",
    sessionId: String(head["planSessionId"]),
  })
  expect(plan.at(-1)).toMatchObject({ phase: "plan", state: "waiting", reason: "gate" })

  // One process for the plan phase, and it is gone: the gate can sit for hours.
  const all = await spawns(ws)
  expect(all.length).toBe(1)
  expect(alive(Number(all[0]?.["pid"]))).toBe(false)

  const argv = argvOf(all[0] ?? {})
  expect(flag(argv, "--model")).toBe(OPUS)
  expect(flag(argv, "--effort")).toBe("high")
  expect(flag(argv, "--session-id")).toBe(String(head["planSessionId"]))
}, 240_000)

test("a dirty repo refuses before anything spawns, and leaves no lock", async () => {
  const ws = await workspace("dirty")
  await writeFile(join(ws.repo, "half-written.ts"), "the human was editing this\n")

  const out = await drive(ws, { steps: [{ action: "start" }] })

  expect(String(out.results[0]?.["error"])).toContain("half-written.ts")
  // Not one invocation, not even `claude --version`: the refusal comes first.
  expect((await readJsonl(ws.log)).length).toBe(0)
  expect(await lockExists(ws)).toBe(false)
}, 30_000)

test("approval starts a FRESH implement session, not a resume of the plan session", async () => {
  const ws = await workspace("approve")
  const implement = await fixture(ws, "implement-done", "did it\n\nORCH: done")
  await script(ws, [{ fixture: PLAN_FIXTURE }, { fixture: implement }])

  const out = await drive(ws, { steps: [{ action: "start" }, { action: "approve" }] })
  expect(out.results[1]).toMatchObject({ state: { kind: "done" } })

  const records = await runLog(ws, out.runId)
  const head = header(records)
  // Design §3.1: the implement session id is NOT in the header. It is minted at
  // gate approval, which is long after line one is on disk.
  expect(head["implementSessionId"]).toBeUndefined()

  const implementPhase = phases(records).find(
    (r) => r["phase"] === "implement" && r["state"] === "running",
  )
  const implementSession = String(implementPhase?.["sessionId"])
  expect(implementSession).toMatch(UUID)
  expect(implementSession).not.toBe(String(head["planSessionId"]))

  const argv = await spawnAt(ws, 1)
  expect(flag(argv, "--session-id")).toBe(implementSession)
  expect(argv).not.toContain("--resume")
  expect(flag(argv, "--model")).toBe(SONNET)
  expect(flag(argv, "--effort")).toBe("medium")
  // And the plan phase ran on the other model, from the other id.
  expect(flag(await spawnAt(ws, 0), "--model")).toBe(OPUS)
  expect(flag(await spawnAt(ws, 0), "--session-id")).toBe(String(head["planSessionId"]))

  // The human's decision is recorded by the machine, the only writer.
  expect(records.some((r) => r["kind"] === "human" && r["action"] === "approve")).toBe(true)
}, 240_000)

test("the implement prompt carries the plan file path, since it inherits no context", async () => {
  const ws = await workspace("implement-brief")
  const implement = await fixture(ws, "implement-done", "ORCH: done")
  await script(ws, [{ fixture: PLAN_FIXTURE }, { fixture: implement }])

  const out = await drive(ws, { steps: [{ action: "start" }, { action: "approve" }] })
  const planPath = String(out.results[0]?.["planPath"])
  expect(planPath).toMatch(/^docs\/plans\/\d{4}-\d{2}-\d{2}-.+\.md$/)

  const all = await turns(ws)
  expect(promptOf(all[0] ?? {})).toContain(planPath)
  expect(promptOf(all[1] ?? {})).toContain(planPath)
  // The plan phase's record carries it too, so the gate renders the dictated
  // path rather than one derived by convention.
  const records = await runLog(ws, out.runId)
  expect(phases(records)[0]).toMatchObject({ planPath })
}, 240_000)

test("implement then a passing test reaches done and ticks the checkbox", async () => {
  const ws = await workspace("done")
  const implement = await fixture(ws, "implement-done", "ORCH: done")
  await script(ws, [{ fixture: PLAN_FIXTURE }, { fixture: implement }])

  const out = await drive(ws, { steps: [{ action: "start" }, { action: "approve" }] })
  expect(out.results[1]).toMatchObject({ state: { kind: "done" } })

  const records = await runLog(ws, out.runId)
  expect(records.filter((r) => r["kind"] === "test")).toMatchObject([
    { kind: "test", exitCode: 0, attempt: 1 },
  ])
  expect(records.at(-1)).toMatchObject({ kind: "end", state: "done" })

  // The tick lives on the task branch, committed, and base is untouched:
  // design §3.6, and the reason the tree reads task state from the run logs.
  const branch = String(out.results[0]?.["branch"])
  expect(await git(ws.repo, ["show", `${branch}:${ws.featurePath}`])).toContain("- [x] T1")
  expect(await git(ws.repo, ["show", `main:${ws.featurePath}`])).toContain("- [ ] T1")
  expect(await git(ws.repo, ["branch", "--show-current"])).toBe("main\n")
  expect(await git(ws.repo, ["status", "--porcelain"])).toBe("")
  expect(await lockExists(ws)).toBe(false)
}, 240_000)

test("gate feedback resumes the plan session and re-runs the plan phase", async () => {
  const ws = await workspace("feedback")
  await script(ws, [{ fixture: PLAN_FIXTURE }, { fixture: PLAN_FIXTURE }])

  const out = await drive(ws, {
    steps: [{ action: "start" }, { action: "feedback", text: "use a slug table instead" }],
  })
  // Feedback re-runs the plan phase rather than advancing: back at the gate.
  expect(out.results[1]).toMatchObject({ state: { kind: "waiting", reason: "gate" } })

  const records = await runLog(ws, out.runId)
  const planSession = String(header(records)["planSessionId"])
  const argv = await spawnAt(ws, 1)
  expect(flag(argv, "--resume")).toBe(planSession)
  expect(argv).not.toContain("--session-id")
  expect(flag(argv, "--model")).toBe(OPUS)
  expect(flag(argv, "--effort")).toBe("high")

  expect(promptOf((await turns(ws))[1] ?? {})).toContain("use a slug table instead")
  expect(
    records.some((r) => r["kind"] === "human" && r["action"] === "feedback"),
  ).toBe(true)
  // Nothing implemented, and the run is still at the gate holding the lock.
  expect(phases(records).every((r) => r["phase"] === "plan")).toBe(true)
  expect(await lockExists(ws)).toBe(true)
}, 240_000)

test("a plan turn ending in a question becomes waiting(question), not done", async () => {
  const ws = await workspace("question", {
    turns: [{ fixture: join(import.meta.dir, "fixtures", "ends-with-question.jsonl") }],
  })

  const out = await drive(ws, { steps: [{ action: "start" }] })
  expect(out.results[0]).toMatchObject({ state: { kind: "waiting", reason: "question" } })
  // The question's own text reaches the human, unmodified.
  const detail = String((out.results[0]?.["state"] as Record<string, unknown>)["detail"])
  expect(detail).toContain("tabs or spaces")

  const records = await runLog(ws, out.runId)
  expect(phases(records).at(-1)).toMatchObject({
    phase: "plan",
    state: "waiting",
    reason: "question",
  })
  // No end record: a question is a rest point, not a terminal state.
  expect(records.some((r) => r["kind"] === "end")).toBe(false)
  expect(await lockExists(ws)).toBe(true)
}, 120_000)

// ---------------------------------------------------------------------------
// Bounds: progress and money, never attempt counts
// ---------------------------------------------------------------------------

/**
 * A test command whose behaviour is scripted per attempt.
 *
 * The counter and the script live **outside** the repo on purpose: a counter
 * file inside it would make the tree dirty, and `returnToBase` refuses to move
 * a dirty checkout, so the done path would fail for a reason the case is not
 * about.
 */
async function testScript(ws: Ws, body: string): Promise<string> {
  const path = join(ws.dir, "testcmd.sh")
  const counter = join(ws.dir, "attempt")
  await writeFile(
    path,
    [
      "#!/bin/sh",
      `n=$(cat ${JSON.stringify(counter)} 2>/dev/null || echo 0)`,
      "n=$((n+1))",
      `echo "$n" > ${JSON.stringify(counter)}`,
      body,
    ].join("\n") + "\n",
  )
  return `sh ${path}`
}

/** `--effort` of every phase invocation, in order. */
async function efforts(ws: Ws): Promise<(string | undefined)[]> {
  return (await spawns(ws)).map((r) => flag(argvOf(r), "--effort"))
}

test("a changing failure signature keeps running without interruption", async () => {
  const ws = await workspace("changing")
  const done = await fixture(ws, "done", "ORCH: done")
  await script(ws, [{ fixture: PLAN_FIXTURE }, ...Array(4).fill({ fixture: done })])
  const testCmd = await testScript(
    ws,
    [
      'case "$n" in',
      '  1) echo "9 tests failed"; exit 1;;',
      '  2) echo "4 tests failed"; exit 1;;',
      '  3) echo "1 test failed"; exit 1;;',
      '  *) echo "all good"; exit 0;;',
      "esac",
    ].join("\n"),
  )

  const out = await drive(ws, {
    project: project(ws, { testCmd }),
    steps: [{ action: "start" }, { action: "approve" }],
  })
  expect(out.results[1]).toMatchObject({ state: { kind: "done" } })

  const records = await runLog(ws, out.runId)
  const tests = records.filter((r) => r["kind"] === "test")
  expect(tests.map((r) => r["exitCode"])).toEqual([1, 1, 1, 0])
  expect(tests.map((r) => r["attempt"])).toEqual([1, 2, 3, 4])
  // Nine down to four down to one is progress, so: no escalation, and no new
  // process - the refine turns go to the live implement conversation.
  expect(await efforts(ws)).toEqual(["high", "medium"])
}, 240_000)

test("three identical signatures escalate medium to high, not to the human", async () => {
  const ws = await workspace("escalate")
  const done = await fixture(ws, "done", "ORCH: done")
  await script(ws, [{ fixture: PLAN_FIXTURE }, ...Array(4).fill({ fixture: done })])
  const testCmd = await testScript(
    ws,
    [
      'if [ "$n" -ge 4 ]; then echo "all good"; exit 0; fi',
      'echo "FAIL tests/slug_test.php::it slugs"',
      "exit 1",
    ].join("\n"),
  )

  const out = await drive(ws, {
    project: project(ws, { testCmd }),
    steps: [{ action: "start" }, { action: "approve" }],
  })
  expect(out.results[1]).toMatchObject({ state: { kind: "done" } })

  const records = await runLog(ws, out.runId)
  const signatures = records
    .filter((r) => r["kind"] === "test" && r["signature"] !== undefined)
    .map((r) => r["signature"])
  expect(new Set(signatures).size).toBe(1)

  // Raised, not interrupted, and raising means a respawn because --effort is a
  // spawn-time flag.
  expect(await efforts(ws)).toEqual(["high", "medium", "high"])
  const raised = await spawnAt(ws, 2)
  const implementSession = String(
    phases(records).find((r) => r["phase"] === "implement")?.["sessionId"],
  )
  expect(flag(raised, "--resume")).toBe(implementSession)
  expect(raised).not.toContain("--session-id")
  expect(flag(raised, "--model")).toBe(SONNET)
}, 240_000)

test("escalation walks medium, high, xhigh then stops for the human", async () => {
  const ws = await workspace("ladder")
  const done = await fixture(ws, "done", "ORCH: done")
  await script(ws, [{ fixture: PLAN_FIXTURE }, ...Array(9).fill({ fixture: done })])
  const testCmd = await testScript(ws, ['echo "FAIL always the same"', "exit 1"].join("\n"))

  const out = await drive(ws, {
    project: project(ws, { testCmd }),
    steps: [{ action: "start" }, { action: "approve" }],
  })
  expect(out.results[1]).toMatchObject({ state: { kind: "waiting", reason: "stalled" } })

  // Three attempts per rung, and `max` is deliberately not a rung.
  expect(await efforts(ws)).toEqual(["high", "medium", "high", "xhigh"])
  const records = await runLog(ws, out.runId)
  expect(records.filter((r) => r["kind"] === "test").length).toBe(9)
  // A stall is a rest point, not a terminal state: no end record, lock held.
  expect(records.some((r) => r["kind"] === "end")).toBe(false)
  expect(await lockExists(ws)).toBe(true)
}, 180_000)

test("the JUnit report decides the signature, so identical failures escalate even when the output differs", async () => {
  const ws = await workspace("junit-signature")
  const done = await fixture(ws, "done", "ORCH: done")
  await script(ws, [{ fixture: PLAN_FIXTURE }, ...Array(4).fill({ fixture: done })])
  const report = "build/junit.xml"
  const testCmd = await testScript(
    ws,
    [
      'if [ "$n" -ge 4 ]; then echo "all good"; exit 0; fi',
      "mkdir -p build",
      `cat > ${report} <<'XML'`,
      '<?xml version="1.0"?>',
      '<testsuites><testsuite name="s"><testcase classname="SlugTest" name="it slugs">',
      '<failure message="nope">boom</failure>',
      "</testcase></testsuite></testsuites>",
      "XML",
      // A different tail every attempt: a duration, which is exactly what the
      // output branch normalizes away - but this proves the report is read.
      'echo "ran in 0.$n s, 1 failed"',
      "exit 1",
    ].join("\n"),
  )

  const out = await drive(ws, {
    project: project(ws, { testCmd, reportPath: report }),
    steps: [{ action: "start" }, { action: "approve" }],
  })
  expect(out.results[1]).toMatchObject({ state: { kind: "done" } })
  // The report named the same failing test three times, so this is a stall even
  // though stdout differed. Without the join, the path would be read against
  // the server's own working directory and this would never escalate.
  expect(await efforts(ws)).toEqual(["high", "medium", "high"])
}, 240_000)

test("a stale JUnit report cannot be hashed as this attempt's failures", async () => {
  const ws = await workspace("junit-stale")
  const done = await fixture(ws, "done", "ORCH: done")
  await script(ws, [{ fixture: PLAN_FIXTURE }, ...Array(4).fill({ fixture: done })])
  const report = "build/junit.xml"
  const testCmd = await testScript(
    ws,
    [
      'if [ "$n" -ge 4 ]; then echo "all good"; exit 0; fi',
      // Only the first attempt writes a report. A crash or a timeout before the
      // flush looks exactly like this, and the file left behind parses fine and
      // names the previous attempt's failures.
      'if [ "$n" = 1 ]; then',
      "  mkdir -p build",
      `  cat > ${report} <<'XML'`,
      '<?xml version="1.0"?>',
      '<testsuites><testsuite name="s"><testcase classname="SlugTest" name="it slugs">',
      '<failure message="nope">boom</failure>',
      "</testcase></testsuite></testsuites>",
      "XML",
      "fi",
      // Genuinely different failures, so the run is converging.
      'echo "FAIL case number $n"',
      "exit 1",
    ].join("\n"),
  )

  const out = await drive(ws, {
    project: project(ws, { testCmd, reportPath: report }),
    steps: [{ action: "start" }, { action: "approve" }],
  })
  expect(out.results[1]).toMatchObject({ state: { kind: "done" } })
  // Attempts 2 and 3 wrote no report, so the signature came from their own
  // output and changed every time: no false stall, no escalation.
  expect(await efforts(ws)).toEqual(["high", "medium"])
  // And the stale file really is gone rather than merely ignored.
  expect(await Bun.file(join(ws.repo, report)).exists()).toBe(false)
}, 240_000)

test("a reportPath that escapes the repo is refused rather than deleted", async () => {
  const ws = await workspace("junit-escape")
  const done = await fixture(ws, "done", "ORCH: done")
  await script(ws, [{ fixture: PLAN_FIXTURE }, { fixture: done }])
  const outside = join(ws.dir, "precious.xml")
  await writeFile(outside, "<testsuites/>\n")

  const out = await drive(ws, {
    project: project(ws, { reportPath: "../precious.xml" }),
    steps: [{ action: "start" }, { action: "approve" }],
  })
  const state = out.results[1]?.["state"] as Record<string, unknown>
  expect(state["kind"]).toBe("failed")
  expect(String(state["why"])).toContain("outside the project")
  expect(await Bun.file(outside).exists()).toBe(true)
  expect(await lockExists(ws)).toBe(false)
}, 120_000)

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

test("each process is given ceiling minus spent, summing the last result per process", async () => {
  const ws = await workspace("budget-arithmetic")
  const done = await fixture(ws, "done", "ORCH: done")
  await script(ws, [
    { fixture: PLAN_FIXTURE, cost: 0.25 },
    // Three turns in ONE process. Within a process `total_cost_usd` is
    // cumulative, so the double reports 0.10, 0.20, 0.30 and the process spent
    // 0.30 - not 0.60, which is what summing every result would give.
    { fixture: done, cost: 0.1 },
    { fixture: done, cost: 0.1 },
    { fixture: done, cost: 0.1 },
    { fixture: done, cost: 0.1 },
  ])
  const testCmd = await testScript(
    ws,
    ['if [ "$n" -ge 4 ]; then echo ok; exit 0; fi', 'echo "FAIL the same"', "exit 1"].join("\n"),
  )

  const out = await drive(ws, {
    project: project(ws, { testCmd }),
    budgetUsd: 1,
    steps: [{ action: "start" }, { action: "approve" }],
  })
  expect(out.results[1]).toMatchObject({ state: { kind: "done" } })

  const budgets = (await spawns(ws)).map((r) => Number(flag(argvOf(r), "--max-budget-usd")))
  expect(budgets[0]).toBeCloseTo(1, 6)
  expect(budgets[1]).toBeCloseTo(0.75, 6)
  // 1 - 0.25 - 0.30. Summing every result inside the implement process would
  // have left 0.15 here, and summing none of them 0.75.
  expect(budgets[2]).toBeCloseTo(0.45, 6)
  expect(Number(out.results[1]?.["costUsd"])).toBeCloseTo(0.65, 6)
}, 240_000)

test("the total is the last result of each process, and this fixture can tell that from the naive sum", async () => {
  const ws = await workspace("budget-naive")
  const done = await fixture(ws, "done", "ORCH: done")
  await script(ws, [
    { fixture: PLAN_FIXTURE, cost: 0.25 },
    // Two turns in ONE process - the implement turn and the refine turn after a
    // failing suite, which reuses the live child. Within a process
    // `total_cost_usd` is cumulative, so the double reports 0.10 and then 0.20.
    { fixture: done, cost: 0.1 },
    { fixture: done, cost: 0.1 },
  ])
  const testCmd = await testScript(
    ws,
    ['if [ "$n" -ge 2 ]; then echo ok; exit 0; fi', 'echo "FAIL once"', "exit 1"].join("\n"),
  )

  const out = await drive(ws, {
    project: project(ws, { testCmd }),
    budgetUsd: 1,
    steps: [{ action: "start" }, { action: "approve" }],
  })
  expect(out.results[1]).toMatchObject({ state: { kind: "done" } })

  // Two processes, which is what makes the two readings differ: the plan phase,
  // then one implement child that took both agent turns.
  expect((await spawns(ws)).length).toBe(2)
  const records = await runLog(ws, out.runId)
  expect(resultCosts(records)).toEqual([0.25, 0.1, 0.2])

  // The number a naive fold produces, asserted so the case fails if the two
  // ever agree - at which point it would be proving nothing.
  const naive = resultCosts(records).reduce((a, b) => a + b, 0)
  expect(naive).toBeCloseTo(0.55, 6)
  // The number the machine reports: 0.25 for the plan process plus the implement
  // process's **last** figure, 0.20.
  expect(Number(out.results[1]?.["costUsd"])).toBeCloseTo(0.45, 6)
  expect(Number(records.at(-1)?.["costUsd"])).toBeCloseTo(0.45, 6)
  expect(naive).not.toBeCloseTo(0.45, 6)
  // And the implement process was given the remainder after the plan process,
  // not after every logged figure.
  expect(Number(flag(await spawnAt(ws, 1), "--max-budget-usd"))).toBeCloseTo(0.75, 6)
}, 240_000)

test("an exhausted ceiling refuses to spawn at all, rather than paying for one more turn", async () => {
  const ws = await workspace("budget-exhausted")
  const done = await fixture(ws, "done", "ORCH: done")
  await script(ws, [{ fixture: PLAN_FIXTURE, cost: 0.3 }, { fixture: done }])

  const out = await drive(ws, {
    budgetUsd: 0.3,
    steps: [{ action: "start" }, { action: "approve" }],
  })
  const state = out.results[1]?.["state"] as Record<string, unknown>
  expect(state).toMatchObject({ kind: "waiting", reason: "blocked" })
  expect(String(state["detail"])).toContain("ceiling")
  // The whole point: no second process. `src/spawn.ts`'s floor would have
  // reached the designed stop, but only after paying for a turn - the CLI
  // checks the budget after the turn, not before.
  expect((await spawns(ws)).length).toBe(1)
  // Raisable, so no end record and the lock stays with the run.
  const records = await runLog(ws, out.runId)
  expect(records.some((r) => r["kind"] === "end")).toBe(false)
  expect(await lockExists(ws)).toBe(true)
}, 240_000)

test("the CLI's own error_max_budget_usd is a raisable stop, not a crash", async () => {
  const ws = await workspace("budget-cli")
  await script(ws, [
    { fixture: PLAN_FIXTURE },
    { fixture: join(import.meta.dir, "fixtures", "budget-exhausted.jsonl") },
  ])

  const out = await drive(ws, { steps: [{ action: "start" }, { action: "approve" }] })
  const state = out.results[1]?.["state"] as Record<string, unknown>
  expect(state).toMatchObject({ kind: "waiting", reason: "blocked" })
  expect(String(state["detail"])).toContain("budget")
  const records = await runLog(ws, out.runId)
  expect(records.some((r) => r["kind"] === "end")).toBe(false)
}, 120_000)

test("a raise continues the run, and starts the implement conversation the park never began", async () => {
  const ws = await workspace("budget-raise")
  const done = await fixture(ws, "done", "ORCH: done")
  // **The plan turn overshoots its ceiling**, which is the probed behaviour the
  // whole design follows from: the CLI checks `--max-budget-usd` after the turn,
  // not before, so `budget-exhausted.jsonl` was captured at 0.0001 having spent
  // 0.0046. So `spent` can exceed the ceiling and the remainder can be negative.
  await script(ws, [{ fixture: PLAN_FIXTURE, cost: 0.35 }, { fixture: done, cost: 0.2 }])

  const out = await drive(ws, {
    budgetUsd: 0.3,
    steps: [
      { action: "start" },
      { action: "approve" },
      // Not a raise: at or below the ceiling it already has.
      { action: "raise", usd: 0.2 },
      // Above the ceiling, but **below what the overshoot already spent**, so it
      // would be recorded and then park the run again on arrival. This is the
      // case a floor of `ceiling` alone cannot see.
      { action: "raise", usd: 0.32 },
      { action: "raise", usd: 1 },
    ],
  })
  // Approval is deliberately unguarded, so this is the designed sequence:
  // approve, be told the ceiling is short, raise it, and the phase begins.
  expect(out.results[1]).toMatchObject({ state: { kind: "waiting", reason: "blocked" } })
  expect(String(out.results[2]?.["error"])).toContain("not a usable ceiling")
  expect(out.results[2]?.["code"]).toBe("wrong-state")
  // The overshoot case: a figure above the ceiling is still not a raise if the
  // run has already spent past it. Its message names both figures.
  expect(String(out.results[3]?.["error"])).toContain("has spent $0.3500")
  expect(out.results[3]?.["code"]).toBe("wrong-state")
  expect(out.results[4]).toMatchObject({ state: { kind: "done" } })

  // Neither refused raise spawned anything; the accepted one spawned once.
  const all = await spawns(ws)
  expect(all.length).toBe(2)

  const records = await runLog(ws, out.runId)
  // In full rather than as a delta, so a reader needs no arithmetic and no
  // ordering to know the ceiling.
  expect(records.filter((r) => r["kind"] === "human" && r["action"] === "raise")).toMatchObject([
    { budgetUsd: 1 },
  ])
  const implementSession = String(
    phases(records).find((r) => r["phase"] === "implement" && r["state"] === "running")?.[
      "sessionId"
    ],
  )
  expect(implementSession).toMatch(UUID)

  const argv = argvOf(all[1] ?? {})
  // `--session-id`, never `--resume`: approval minted this id and the budget
  // refusal declined the spawn, so the CLI has never seen the conversation and
  // `--resume` would meet `No conversation found`.
  expect(flag(argv, "--session-id")).toBe(implementSession)
  expect(argv).not.toContain("--resume")
  // 1.00 minus the 0.35 the plan process overshot to, not minus the 0.30
  // ceiling it was given.
  expect(Number(flag(argv, "--max-budget-usd"))).toBeCloseTo(0.65, 6)
  // And it is the implement prompt, which carries the task and the plan - not
  // the resume prompt, which tells the agent its own work is still in context.
  const prompt = promptOf((await turns(ws))[1] ?? {})
  expect(prompt).toContain("superpowers:executing-plans")
  expect(prompt).not.toContain("was interrupted")
  expect(Number(records.at(-1)?.["costUsd"])).toBeCloseTo(0.55, 6)
}, 240_000)

test("a raised ceiling survives a restart, folded from the log rather than the header", async () => {
  const ws = await workspace("budget-raise-restart")
  const asks = await fixture(ws, "asks", "Should the slug keep accented characters?")
  const done = await fixture(ws, "done", "ORCH: done")
  await script(ws, [
    { fixture: PLAN_FIXTURE, cost: 0.3 },
    { fixture: asks, cost: 0.1 },
    { fixture: done, cost: 0.1 },
  ])

  const first = await drive(ws, {
    budgetUsd: 0.3,
    steps: [{ action: "start" }, { action: "approve" }],
  })
  expect(first.results[1]).toMatchObject({ state: { kind: "waiting", reason: "blocked" } })
  const runId = first.runId

  // A second process, with an empty registry. `budgetUsd` is **not** passed
  // again, so the only ceilings available are the header's 0.30, the project
  // record's 50, and the raise - and the remainder says which was used: 0.00
  // (no spawn at all), 49.70, or 0.70.
  const second = await drive(ws, { runId, steps: [{ action: "raise", usd: 1 }] })
  expect(second.results[0]).toMatchObject({ state: { kind: "waiting", reason: "question" } })
  expect(Number(flag(await spawnAt(ws, 1), "--max-budget-usd"))).toBeCloseTo(0.7, 6)

  // A third process answers the question the raised run asked. 1.00 minus 0.30
  // for the plan process and 0.10 for the implement one: on the header's
  // ceiling this remainder would be negative and nothing would spawn.
  const third = await drive(ws, { runId, steps: [{ action: "answer", text: "transliterate them" }] })
  expect(third.results[0]).toMatchObject({ state: { kind: "done" } })
  const argv = await spawnAt(ws, 2)
  expect(Number(flag(argv, "--max-budget-usd"))).toBeCloseTo(0.6, 6)

  const records = await runLog(ws, runId)
  const implementSession = String(
    phases(records).find((r) => r["phase"] === "implement" && r["state"] === "running")?.[
      "sessionId"
    ],
  )
  // The conversation the raise started is the one the answer resumed.
  expect(flag(argv, "--resume")).toBe(implementSession)
  expect(Number(records.at(-1)?.["costUsd"])).toBeCloseTo(0.5, 6)
  expect(await lockExists(ws)).toBe(false)
}, 240_000)

test("an exhausted run refuses feedback and an answer, rather than recording words no agent reads", async () => {
  const ws = await workspace("budget-text")
  await script(ws, [{ fixture: PLAN_FIXTURE, cost: 0.3 }, { fixture: PLAN_FIXTURE }])

  const out = await drive(ws, {
    budgetUsd: 0.3,
    steps: [
      { action: "start" },
      // At the gate, with the ceiling already gone. `continueFrom` re-sends the
      // phase's own prompt and cannot re-send a sentence from an hour ago, so
      // taking the text would record words no agent would ever read.
      { action: "feedback", text: "use a slug table instead" },
    ],
  })
  expect(out.results[0]).toMatchObject({ state: { kind: "waiting", reason: "gate" } })
  const why = String(out.results[1]?.["error"])
  expect(why).toContain("cannot take feedback")
  expect(why).toContain("Nothing has been recorded")
  // The ceiling is named as this run's, not as the project's: editing
  // projects.json would leave the human watching a run that never moves.
  expect(why).toContain("next run's default")

  // Nothing of the human's reached the log, which is the point of refusing
  // before taking it.
  expect((await runLog(ws, out.runId)).some((r) => r["kind"] === "human")).toBe(false)
  // One process: the plan phase. The refusal came before anything spawned.
  expect((await spawns(ws)).length).toBe(1)

  // A raise at the **gate** takes the money and stays put: the decision the run
  // is waiting for is still the human's. A fresh process, so this is also a
  // rehydrate at the gate followed by a raise.
  const second = await drive(ws, {
    runId: out.runId,
    steps: [
      { action: "raise", usd: 1 },
      { action: "feedback", text: "use a slug table instead" },
    ],
  })
  expect(second.results[0]).toMatchObject({ state: { kind: "waiting", reason: "gate" } })
  // The feedback the ceiling had refused now runs, and lands back at the gate.
  expect(second.results[1]).toMatchObject({ state: { kind: "waiting", reason: "gate" } })

  const records = await runLog(ws, out.runId)
  // The raise spawned nothing of its own; the feedback turn is the second
  // process, on the plan session, with the raised remainder.
  const all = await spawns(ws)
  expect(all.length).toBe(2)
  const argv = argvOf(all[1] ?? {})
  expect(flag(argv, "--resume")).toBe(String(header(records)["planSessionId"]))
  expect(Number(flag(argv, "--max-budget-usd"))).toBeCloseTo(0.7, 6)
  expect(
    records
      .filter((r) => r["kind"] === "human")
      .map((r) => `${String(r["action"])}:${String(r["budgetUsd"] ?? "")}`),
  ).toEqual(["raise:1", "feedback:"])
}, 240_000)

// ---------------------------------------------------------------------------
// The lock, on every exit path
// ---------------------------------------------------------------------------

test("a ref-less task is refused by name, before any lock or process", async () => {
  const ws = await workspace("refless", {
    feature: "# Slugger\n\n- [ ] just some prose with no ref\n",
  })

  const out = await drive(ws, {
    task: { ref: null, text: "just some prose with no ref" },
    steps: [{ action: "start" }],
  })
  const why = String(out.results[0]?.["error"])
  expect(why).toContain("no T<n> ref")
  expect(why).toContain("just some prose with no ref")
  expect(await lockExists(ws)).toBe(false)
  expect((await readJsonl(ws.log)).length).toBe(0)
}, 30_000)

test("a refusal at recordBaseBranch releases the lock it had already taken", async () => {
  const ws = await workspace("lock-detached")
  await git(ws.repo, ["checkout", "--detach"])

  const out = await drive(ws, { steps: [{ action: "start" }] })
  expect(String(out.results[0]?.["error"])).toContain("detached HEAD")
  // Step 2 took the lock and step 3 refused: without the `finally` this lock
  // would name a LIVE pid, which nothing reclaims until the server restarts.
  expect(await lockExists(ws)).toBe(false)
}, 30_000)

test("a refusal at createTaskBranch releases the lock too", async () => {
  const ws = await workspace("lock-branch")
  const branch = taskBranchName({ feature: ws.featurePath, ref: "T1" })
  await git(ws.repo, ["switch", "-c", branch])
  await writeFile(join(ws.repo, "earlier.ts"), "work from the run before\n")
  await git(ws.repo, ["add", "--", "earlier.ts"])
  await git(ws.repo, ["commit", "-m", "an earlier run's work"])
  await git(ws.repo, ["switch", "main"])

  const out = await drive(ws, { steps: [{ action: "start" }] })
  const why = String(out.results[0]?.["error"])
  expect(why).toContain(branch)
  // git.ts's own message names the one command that clears it, which is also
  // the answer for a task whose branch was squash-merged.
  expect(why).toContain(`git branch -D ${branch}`)
  expect(await lockExists(ws)).toBe(false)
}, 30_000)

test("the lock is released when a run fails", async () => {
  const ws = await workspace("lock-failed")
  const broke = await fixture(ws, "broke", "it went wrong", {
    subtype: "error_during_execution",
    isError: true,
  })
  await script(ws, [{ fixture: PLAN_FIXTURE }, { fixture: broke }])

  const out = await drive(ws, { steps: [{ action: "start" }, { action: "approve" }] })
  const state = out.results[1]?.["state"] as Record<string, unknown>
  expect(state["kind"]).toBe("failed")
  expect(String(state["why"])).toContain("error_during_execution")
  // is_error is shown beside the subtype rather than relabelled: a result can
  // carry subtype "success" with is_error true.
  expect(String(state["why"])).toContain("is_error: true")

  const records = await runLog(ws, out.runId)
  expect(records.at(-1)).toMatchObject({ kind: "end", state: "failed" })
  expect(await lockExists(ws)).toBe(false)
}, 120_000)

// ---------------------------------------------------------------------------
// Surviving a restart
// ---------------------------------------------------------------------------

/**
 * Whether the double has recorded `session` as resumable.
 *
 * It writes its cursor **after** replaying a turn, and the machine sees that
 * turn's result event - and writes its next phase record - during the replay.
 * So a kill timed off the run log alone can land in between, leaving the
 * session unresumable and the resumed run meeting `No conversation found`
 * (docs/HANDOFF.md). Polling the cursor closes that window.
 */
async function resumable(ws: Ws, session: string): Promise<boolean> {
  const file = Bun.file(ws.cursor)
  if (!(await file.exists())) return false
  const cursor = JSON.parse(await file.text()) as { sessions?: unknown }
  return Array.isArray(cursor.sessions) && cursor.sessions.includes(session)
}

/** Waits for `ready`, then SIGKILLs the driver the way a crash would. */
async function driveAndKill(ws: Ws, job: Job, ready: () => Promise<boolean>): Promise<void> {
  const n = ws.runs++
  const jobPath = join(ws.dir, `job-${n}.json`)
  const outPath = join(ws.dir, `out-${n}.json`)
  await writeJob(ws, job, jobPath)
  const p = spawnDriver(ws, job, jobPath, outPath)
  const stderr = new Response(p.stderr).text()
  const deadline = Date.now() + 120_000
  for (;;) {
    if (await ready()) break
    if (Date.now() > deadline) throw new Error(`driver never got there: ${await stderr}`)
    await Bun.sleep(25)
  }
  p.kill("SIGKILL")
  await p.exited
}

test("the gate survives a server restart: a second process approves from the log", async () => {
  const ws = await workspace("restart-approve")
  const done = await fixture(ws, "done", "ORCH: done")
  await script(ws, [{ fixture: PLAN_FIXTURE }, { fixture: done }])

  const first = await drive(ws, { steps: [{ action: "start" }] })
  expect(first.results[0]).toMatchObject({ state: { kind: "waiting", reason: "gate" } })

  // A different process, with an empty registry: everything it needs is on
  // disk, which is what design §3.1 means by the gate surviving a restart.
  const second = await drive(ws, { runId: first.runId, steps: [{ action: "approve" }] })
  expect(second.results[0]).toMatchObject({ state: { kind: "done" } })

  const records = await runLog(ws, first.runId)
  const argv = await spawnAt(ws, 1)
  const implementSession = String(
    phases(records).find((r) => r["phase"] === "implement")?.["sessionId"],
  )
  expect(flag(argv, "--session-id")).toBe(implementSession)
  expect(implementSession).not.toBe(String(header(records)["planSessionId"]))
  const branch = String(first.results[0]?.["branch"])
  expect(await git(ws.repo, ["show", `${branch}:${ws.featurePath}`])).toContain("- [x] T1")
  expect(await lockExists(ws)).toBe(false)
}, 180_000)

test("a run killed mid-implement is resumable from its implement session id", async () => {
  const ws = await workspace("resume-kill")
  const done = await fixture(ws, "done", "ORCH: done")
  await script(ws, [{ fixture: PLAN_FIXTURE }, { fixture: done }, { fixture: done }])
  // Attempt 1 is slow, so the kill lands while the implement process is alive
  // and idle - and **between turns**, which is the only point the double marks
  // a session resumable (docs/HANDOFF.md). It self-terminates, because
  // `runTests` detaches the process group and a SIGKILLed driver orphans it.
  const testCmd = await testScript(
    ws,
    [
      'case "$n" in',
      '  1) echo "FAIL first"; sleep 3; exit 1;;',
      '  2) echo "FAIL second, different"; exit 1;;',
      '  *) echo "all good"; exit 0;;',
      "esac",
    ].join("\n"),
  )

  const first = await drive(ws, { project: project(ws, { testCmd }), steps: [{ action: "start" }] })
  const runId = first.runId

  // Approve, then kill once the machine has reached the test phase.
  await driveAndKill(
    ws,
    { runId, project: project(ws, { testCmd }), steps: [{ action: "approve" }] },
    async () => {
      const log = await runLog(ws, runId)
      const session = phases(log).find((r) => r["phase"] === "implement")?.["sessionId"]
      if (typeof session !== "string") return false
      const inTest = log.some(
        (r) => r["kind"] === "phase" && r["phase"] === "test" && r["state"] === "running",
      )
      return inTest && (await resumable(ws, session))
    },
  )

  const killed = await runLog(ws, runId)
  // No end record: the fold reads that as interrupted, which is resumable.
  expect(killed.some((r) => r["kind"] === "end")).toBe(false)
  const implementSession = String(
    phases(killed).find((r) => r["phase"] === "implement")?.["sessionId"],
  )
  expect(implementSession).toMatch(UUID)

  const spawnsBefore = (await spawns(ws)).length
  const resumed = await drive(ws, {
    runId,
    project: project(ws, { testCmd }),
    steps: [{ action: "resume" }],
  })
  expect(resumed.results[0]).toMatchObject({ state: { kind: "done" } })

  // The respawn resumed the IMPLEMENT conversation, never the plan one.
  const argv = await spawnAt(ws, spawnsBefore)
  expect(flag(argv, "--resume")).toBe(implementSession)
  expect(argv).not.toContain("--session-id")
  expect(flag(argv, "--model")).toBe(SONNET)
  expect(flag(argv, "--resume")).not.toBe(String(header(killed)["planSessionId"]))
  // The lock the dead process left is reclaimed, then released at done.
  expect(await lockExists(ws)).toBe(false)
}, 240_000)

test("the port's resume is the same resumeRun the kill case drives, not a second path", async () => {
  // `resumeRun` was exported from this module and called by nothing, so the
  // kill case above drives it directly. The port method has to reach **that**
  // function: it owns the rules a reimplementation would get wrong - a run
  // parked at a human is reported rather than driven, a plan phase is
  // re-prompted while an implement phase is resumed, and a conversation that
  // never started gets the implement prompt instead of `--resume` on an id the
  // CLI has never seen. Driven through `createRunner` here, which is what the
  // HTTP route calls.
  const ws = await workspace("runner-resume")
  await projectsFile(ws, [project(ws)])
  const done = await fixture(ws, "done", "ORCH: done")
  await script(ws, [{ fixture: PLAN_FIXTURE }, { fixture: done }])

  const out = await drive(ws, {
    steps: [
      { action: "start" },
      // The lock goes, the branch and the log stay: the run is interrupted and
      // nothing is driving it, which is the state the tree offers resume for.
      { action: "stop" },
      { action: "runner", calls: [{ m: "resume" }] },
      // The discriminator. `ok: true` alone cannot tell a resume from a
      // no-op: the approve below rehydrates the run by itself, so it would
      // still reach `done` if `resume` had quietly done nothing. Only
      // `resumeRun` registers the run in this process and takes the project's
      // lock again, and `liveRunIds()` is where that is visible.
      { action: "live" },
      { action: "runner", calls: [{ m: "approve" }] },
    ],
  })
  expect(out.results[1]).toMatchObject({ state: { kind: "interrupted" } })
  // The transition is accepted, which is all an HTTP request can wait for.
  expect((out.results[2] as unknown as Record<string, unknown>[])[0]).toMatchObject({ ok: true })
  expect(out.results[3]).toMatchObject({ live: [out.runId] })
  // And the resumed run is reachable again: an approve on the same port now
  // finds it at the gate, where before the resume there was no route that
  // could put it back there.
  expect((out.results[4] as unknown as Record<string, unknown>[])[0]).toMatchObject({ ok: true })

  const records = await runLog(ws, out.runId)
  expect(records.filter((r) => r["kind"] === "end").length).toBe(1)
  expect(records.filter((r) => r["kind"] === "end")[0]).toMatchObject({ state: "done" })
  expect(await lockExists(ws)).toBe(false)
}, 180_000)

test("an escalated effort survives a restart rather than dropping back", async () => {
  const ws = await workspace("resume-effort")
  const done = await fixture(ws, "done", "ORCH: done")
  await script(ws, [{ fixture: PLAN_FIXTURE }, ...Array(6).fill({ fixture: done })])
  const testCmd = await testScript(
    ws,
    [
      'if [ "$n" -ge 6 ]; then echo ok; exit 0; fi',
      // Attempt 4 is slow, so the kill lands during it and never records a
      // signature; attempt 5, after the resume, fails differently, so the
      // resumed run needs one more agent turn - which is the spawn whose
      // --effort this case is about.
      'if [ "$n" = 5 ]; then echo "FAIL something else entirely"; exit 1; fi',
      'echo "FAIL the same every time"',
      'if [ "$n" = 4 ]; then sleep 3; fi',
      "exit 1",
    ].join("\n"),
  )

  const first = await drive(ws, { project: project(ws, { testCmd }), steps: [{ action: "start" }] })
  const runId = first.runId
  // Attempts 1-3 are identical, so the machine raises to `high` and respawns;
  // attempt 4 is slow, and the kill lands during it.
  await driveAndKill(
    ws,
    { runId, project: project(ws, { testCmd }), steps: [{ action: "approve" }] },
    // The phase record goes in **before** `runTests`, so this fires while the
    // slow fourth attempt is running. A `test` record would only appear after
    // it finished, which is too late to interrupt anything.
    async () =>
      (await runLog(ws, runId)).filter(
        (r) => r["kind"] === "phase" && r["phase"] === "test" && r["state"] === "running",
      ).length >= 4,
  )
  expect(await efforts(ws)).toEqual(["high", "medium", "high"])

  const spawnsBefore = (await spawns(ws)).length
  const resumed = await drive(ws, {
    runId,
    project: project(ws, { testCmd }),
    steps: [{ action: "resume" }],
  })
  expect(resumed.results[0]).toMatchObject({ state: { kind: "done" } })
  // `high`, not the header's starting `medium`: the ladder is replayed from the
  // logged signatures, because no record carries the current effort.
  expect(flag(await spawnAt(ws, spawnsBefore), "--effort")).toBe("high")
}, 180_000)

test("stopping at the gate releases the lock and leaves the run resumable", async () => {
  const ws = await workspace("stop-gate")
  const done = await fixture(ws, "done", "ORCH: done")
  await script(ws, [{ fixture: PLAN_FIXTURE }, { fixture: done }])

  const out = await drive(ws, {
    steps: [{ action: "start" }, { action: "stop" }, { action: "resume" }, { action: "approve" }],
  })
  expect(out.results[1]).toMatchObject({ state: { kind: "interrupted" } })
  // Stopping must at least free the project, or nothing could ever start again.
  expect(out.results[2]).toMatchObject({ state: { kind: "waiting", reason: "gate" } })
  expect(out.results[3]).toMatchObject({ state: { kind: "done" } })

  const records = await runLog(ws, out.runId)
  // One end record, from the run finishing - never one from the stop.
  expect(records.filter((r) => r["kind"] === "end").length).toBe(1)
  expect(await lockExists(ws)).toBe(false)
}, 180_000)

test("a question mid-implement is answered on the IMPLEMENT session", async () => {
  const ws = await workspace("answer")
  const asks = await fixture(ws, "asks", "Should the slug keep accented characters?")
  const done = await fixture(ws, "done", "ORCH: done")
  await script(ws, [{ fixture: PLAN_FIXTURE }, { fixture: asks }, { fixture: done }])

  const out = await drive(ws, {
    steps: [
      { action: "start" },
      { action: "approve" },
      { action: "answer", text: "transliterate them, and say so in the docblock" },
    ],
  })
  const asked = out.results[1]?.["state"] as Record<string, unknown>
  expect(asked).toMatchObject({ kind: "waiting", reason: "question" })
  expect(String(asked["detail"])).toContain("accented characters")
  expect(out.results[2]).toMatchObject({ state: { kind: "done" } })

  const records = await runLog(ws, out.runId)
  const implementSession = String(
    phases(records).find((r) => r["phase"] === "implement")?.["sessionId"],
  )
  const argv = await spawnAt(ws, 2)
  expect(flag(argv, "--resume")).toBe(implementSession)
  expect(flag(argv, "--resume")).not.toBe(String(header(records)["planSessionId"]))
  expect(flag(argv, "--model")).toBe(SONNET)
  expect(promptOf((await turns(ws))[2] ?? {})).toContain("transliterate them")
}, 180_000)

test("a question at the gate is answered on the PLAN session", async () => {
  const ws = await workspace("answer-plan")
  await script(ws, [
    { fixture: join(import.meta.dir, "fixtures", "ends-with-question.jsonl") },
    { fixture: PLAN_FIXTURE },
  ])

  const out = await drive(ws, {
    steps: [{ action: "start" }, { action: "answer", text: "spaces, four of them" }],
  })
  expect(out.results[0]).toMatchObject({ state: { kind: "waiting", reason: "question" } })
  // The plan turn answered, so the run is back at the gate rather than past it.
  expect(out.results[1]).toMatchObject({ state: { kind: "waiting", reason: "gate" } })

  const records = await runLog(ws, out.runId)
  const argv = await spawnAt(ws, 1)
  expect(flag(argv, "--resume")).toBe(String(header(records)["planSessionId"]))
  expect(flag(argv, "--model")).toBe(OPUS)
  expect(promptOf((await turns(ws))[1] ?? {})).toContain("spaces, four of them")
}, 240_000)

// ---------------------------------------------------------------------------
// The drain
// ---------------------------------------------------------------------------

test("a multi-byte character split across reads survives into the run log", async () => {
  const ws = await workspace("utf8")
  // Raw UTF-8, which the committed fixtures cannot be: Task 4's redaction pass
  // re-serialised them as pure ASCII with \uXXXX escapes, so **no chunk
  // boundary inside one can split a code point** and a reader that decoded each
  // read independently would pass against them and corrupt real output.
  const text = "Füße, 日本語, 🚀 — a plan with an em dash"
  const mixed = await fixture(ws, "utf8", `${text}\n\nORCH: done`, { say: text })
  await script(ws, [{ fixture: mixed }])

  const out = await drive(ws, {
    // Seven-byte writes, with the double's delay between them, so the reads
    // really do land mid-character.
    env: { ORCH_FAKE_CHUNK: "7", ORCH_FAKE_CHUNK_DELAY_MS: "1" },
    steps: [{ action: "start" }],
  })
  expect(out.results[0]).toMatchObject({ state: { kind: "waiting", reason: "gate" } })

  const records = await runLog(ws, out.runId)
  const result = records.find(
    (r) => r["kind"] === "cli" && (r["event"] as Record<string, unknown>)["type"] === "result",
  )
  const event = result?.["event"] as Record<string, unknown>
  expect(String(event["result"])).toContain(text)
  // And the sentinel on the last line was still read, which it would not be if
  // the tail had decoded to replacement characters.
  expect(String(event["result"]).endsWith("ORCH: done")).toBe(true)
}, 120_000)

// ---------------------------------------------------------------------------
// Faults, overlapping actions, and the stop button
// ---------------------------------------------------------------------------

test("a report path that cannot be removed fails the run instead of hanging it", async () => {
  const ws = await workspace("report-eisdir")
  const done = await fixture(ws, "done", "ORCH: done")
  await script(ws, [{ fixture: PLAN_FIXTURE }, { fixture: done }])
  // `reportPath` naming a committed directory: `unlink` gets EISDIR. The
  // implement child is live at that moment, so an uncaught throw here leaks it
  // and the process never exits - a hang, not a failure.
  await mkdir(join(ws.repo, "build"), { recursive: true })
  await writeFile(join(ws.repo, "build", ".gitkeep"), "")
  await git(ws.repo, ["add", "--", "build/.gitkeep"])
  await git(ws.repo, ["commit", "-m", "a build directory"])

  const out = await drive(ws, {
    project: project(ws, { reportPath: "build" }),
    steps: [{ action: "start" }, { action: "approve" }],
  })
  const state = out.results[1]?.["state"] as Record<string, unknown>
  expect(state["kind"]).toBe("failed")
  expect(String(state["why"])).toContain("previous test report")
  expect(await lockExists(ws)).toBe(false)
}, 240_000)

test("two approvals in flight mint one implement session, not two", async () => {
  const ws = await workspace("double-approve")
  const done = await fixture(ws, "done", "ORCH: done")
  await script(ws, [{ fixture: PLAN_FIXTURE }, { fixture: done }])

  const out = await drive(ws, { steps: [{ action: "start" }, { action: "approve-twice" }] })
  const both = out.results[1] as unknown as ({ error?: string } & Record<string, unknown>)[]
  const refused = both.filter((r) => r["error"] !== undefined)
  expect(refused.length).toBe(1)
  expect(String(refused[0]?.["error"])).toContain("working right now")

  // One implement spawn, one session id: two would be two loops on one log,
  // which is the two-session failure in its worst form.
  const records = await runLog(ws, out.runId)
  const sessions = phases(records)
    .filter((r) => r["phase"] === "implement")
    .map((r) => r["sessionId"])
  expect(new Set(sessions).size).toBe(1)
  expect((await spawns(ws)).length).toBe(2)
  expect(records.filter((r) => r["kind"] === "human" && r["action"] === "approve").length).toBe(1)
}, 180_000)

test("a stop during a test run does not tick, commit, or write an end record", async () => {
  const ws = await workspace("stop-mid-test")
  const done = await fixture(ws, "done", "ORCH: done")
  await script(ws, [{ fixture: PLAN_FIXTURE }, { fixture: done }, { fixture: done }])
  // Slow and passing: the stop lands while the suite runs, and the tests would
  // otherwise go on to tick the checkbox the human just stopped.
  const testCmd = await testScript(ws, ["sleep 3", 'echo "all good"', "exit 0"].join("\n"))

  const out = await drive(ws, {
    project: project(ws, { testCmd }),
    steps: [{ action: "start" }, { action: "approve-then-stop" }],
  })
  const both = out.results[1] as Record<string, unknown>
  expect(both["stopped"]).toMatchObject({ state: { kind: "interrupted" } })

  const records = await runLog(ws, out.runId)
  expect(records.some((r) => r["kind"] === "end")).toBe(false)
  // Nothing was written to the backlog and nothing committed on the branch.
  const branch = String(out.results[0]?.["branch"])
  expect(await git(ws.repo, ["show", `${branch}:${ws.featurePath}`])).toContain("- [ ] T1")
  expect(await git(ws.repo, ["log", "--oneline", branch])).not.toContain("tick T1")
  // And the project is free again, which is the least a stop has to mean.
  expect(await lockExists(ws)).toBe(false)
}, 180_000)

test("an action a rehydrated run cannot take releases the lock it just took", async () => {
  const ws = await workspace("rehydrate-refused")
  await script(ws, [
    { fixture: join(import.meta.dir, "fixtures", "ends-with-question.jsonl") },
    { fixture: PLAN_FIXTURE },
  ])

  const first = await drive(ws, { steps: [{ action: "start" }] })
  expect(first.results[0]).toMatchObject({ state: { kind: "waiting", reason: "question" } })

  // A second process approves a run that is waiting on a question, not at the
  // gate. Rehydrating took the lock and switched the branch before the refusal.
  const second = await drive(ws, { runId: first.runId, steps: [{ action: "approve" }] })
  expect(String(second.results[0]?.["error"])).toContain("waiting for question")
  expect(await lockExists(ws)).toBe(false)
  // And the run is still answerable afterwards.
  const third = await drive(ws, {
    runId: first.runId,
    steps: [{ action: "answer", text: "spaces" }],
  })
  expect(third.results[0]).toMatchObject({ state: { kind: "waiting", reason: "gate" } })
}, 180_000)

test("the transition is accepted before the phase finishes", async () => {
  const ws = await workspace("accepted")
  await script(ws, [{ fixture: PLAN_FIXTURE }])

  const out = await drive(ws, {
    // The plan turn is stretched over many small writes, so "accepted" lands a
    // long way before the gate record does.
    env: { ORCH_FAKE_CHUNK: "64", ORCH_FAKE_CHUNK_DELAY_MS: "2" },
    steps: [{ action: "start" }],
  })
  expect(out.results[0]).toMatchObject({ state: { kind: "waiting", reason: "gate" } })

  const at = out.atAccept
  expect(at).not.toBeNull()
  // The header and the running phase record were on disk; the gate was not.
  expect(at?.kinds).toContain("header::")
  expect(at?.kinds.some((k) => k.startsWith("phase:waiting"))).toBe(false)
  const records = await runLog(ws, out.runId)
  expect(at?.records).toBeLessThan(records.length)
}, 240_000)

test("a denied tool is named in the failure, not hidden behind a subtype", async () => {
  const ws = await workspace("denials")
  const denied = await fixture(ws, "denied", "I could not run the tests", {
    subtype: "error_during_execution",
    isError: true,
  })
  // The fixtures only ever show an empty denial list, so the entry is added by
  // hand - the shape `src/permissions.ts` reads.
  const text = await readFile(denied, "utf8")
  await writeFile(
    denied,
    text.replace(
      '"permission_denials":[]',
      '"permission_denials":[{"tool_name":"Bash","tool_use_id":"toolu_1","tool_input":{"command":"vendor/bin/pest --filter=Slug"}}]',
    ),
  )
  await script(ws, [{ fixture: PLAN_FIXTURE }, { fixture: denied }])

  const out = await drive(ws, { steps: [{ action: "start" }, { action: "approve" }] })
  const state = out.results[1]?.["state"] as Record<string, unknown>
  expect(state["kind"]).toBe("failed")
  expect(String(state["why"])).toContain("Bash")
  expect(String(state["why"])).toContain("vendor/bin/pest --filter=Slug")
}, 240_000)

test("a resumed run reconstructs the exact spend, per process and not per record", async () => {
  const ws = await workspace("resume-cost")
  const done = await fixture(ws, "done", "ORCH: done")
  await script(ws, [
    { fixture: PLAN_FIXTURE, cost: 0.25 },
    // One process, two turns: the double reports 0.10 then 0.20, cumulative.
    { fixture: done, cost: 0.1 },
    { fixture: done, cost: 0.1 },
    { fixture: done, cost: 0.1 },
  ])
  const testCmd = await testScript(
    ws,
    [
      'if [ "$n" -ge 4 ]; then echo ok; exit 0; fi',
      'echo "FAIL attempt $n"',
      'if [ "$n" = 2 ]; then sleep 3; fi',
      "exit 1",
    ].join("\n"),
  )

  const first = await drive(ws, {
    project: project(ws, { testCmd }),
    budgetUsd: 1,
    steps: [{ action: "start" }],
  })
  const runId = first.runId
  await driveAndKill(
    ws,
    { runId, project: project(ws, { testCmd }), budgetUsd: 1, steps: [{ action: "approve" }] },
    async () =>
      (await runLog(ws, runId)).filter(
        (r) => r["kind"] === "phase" && r["phase"] === "test" && r["state"] === "running",
      ).length >= 2,
  )

  const before = (await spawns(ws)).length
  const resumed = await drive(ws, {
    runId,
    project: project(ws, { testCmd }),
    budgetUsd: 1,
    steps: [{ action: "resume" }],
  })
  expect(resumed.results[0]).toMatchObject({ state: { kind: "done" } })

  // 1.00 - (0.25 for the plan process + 0.20 for the implement process). Both
  // of the plausible wrong folds - summing every result, and one window per
  // phase record rather than per spawn - give 0.45 here.
  expect(Number(flag(await spawnAt(ws, before), "--max-budget-usd"))).toBeCloseTo(0.55, 6)
}, 240_000)

// ---------------------------------------------------------------------------
// The port src/server.ts drives
// ---------------------------------------------------------------------------

test("the runner accepts a start before the plan phase finishes, and names the run", async () => {
  const ws = await workspace("runner-start")
  await projectsFile(ws, [project(ws)])
  await script(ws, [{ fixture: PLAN_FIXTURE }])

  const out = await drive(ws, {
    env: { ORCH_FAKE_CHUNK: "64", ORCH_FAKE_CHUNK_DELAY_MS: "2" },
    steps: [
      {
        action: "runner",
        calls: [
          { m: "start", projectPath: ws.repo, featureFile: ws.featurePath, taskRef: "T1" },
        ],
      },
    ],
  })
  const answers = out.results[0] as unknown as Record<string, unknown>[]
  const started = answers[0]?.["started"] as Record<string, unknown>
  expect(started["ok"]).toBe(true)
  expect(String(started["runId"])).toMatch(UUID)

  // An HTTP request cannot wait for a phase: the call came back with the run
  // registered and its child running, long before the gate record existed.
  const at = answers[0]?.["atAccept"] as { kinds: string[] } | null
  expect(at?.kinds).toContain("header::")
  expect(at?.kinds.some((k) => k.startsWith("phase:waiting"))).toBe(false)

  const records = await runLog(ws, String(started["runId"]))
  expect(phases(records).at(-1)).toMatchObject({ state: "waiting", reason: "gate" })
}, 180_000)

test("the runner answers a refusal with a code rather than throwing", async () => {
  const ws = await workspace("runner-refusals")
  await projectsFile(ws, [project(ws)])
  await script(ws, [{ fixture: PLAN_FIXTURE }])

  const out = await drive(ws, {
    steps: [
      {
        action: "runner",
        calls: [
          // Not in projects.json.
          { m: "start", projectPath: join(ws.dir, "elsewhere"), featureFile: ws.featurePath, taskRef: "T1" },
          // Registered project, no such feature file.
          { m: "start", projectPath: ws.repo, featureFile: "docs/features/nope.md", taskRef: "T1" },
          // Registered feature file, no such task.
          { m: "start", projectPath: ws.repo, featureFile: ws.featurePath, taskRef: "T99" },
          // A task with no ref at all cannot even be named over HTTP, so the
          // empty string is what a UI would send.
          { m: "start", projectPath: ws.repo, featureFile: ws.featurePath, taskRef: "" },
          // No such run.
          { m: "approve" },
          // Nor is there one to resume: `resumeRun` was unreachable until this
          // port had a method, so this is the first thing that asks it.
          { m: "resume" },
        ],
      },
    ],
  })
  const answers = out.results[0] as unknown as Record<string, unknown>[]
  const codes = answers.map((a) =>
    a["started"] === undefined ? a["refusal"] : (a["started"] as Record<string, unknown>)["refusal"],
  )
  expect(codes).toEqual([
    "unknown-project",
    "unknown-feature",
    "unknown-task",
    "unknown-task",
    "unknown-run",
    "unknown-run",
  ])
  // The machine's own prose, rendered as written: the ref-less message says what
  // to type, and nothing from the request is quoted back into it.
  const refless = answers[3]?.["started"] as Record<string, unknown>
  expect(String(refless["message"])).toContain("no T<n> ref")
  expect((await readJsonl(ws.log)).length).toBe(0)
}, 240_000)

test("a dirty repo reaches the caller as `dirty` with git's own words", async () => {
  const ws = await workspace("runner-dirty")
  await projectsFile(ws, [project(ws)])
  await script(ws, [{ fixture: PLAN_FIXTURE }])
  await writeFile(join(ws.repo, "half-written.ts"), "the human was editing this\n")

  const out = await drive(ws, {
    steps: [
      {
        action: "runner",
        calls: [{ m: "start", projectPath: ws.repo, featureFile: ws.featurePath, taskRef: "T1" }],
      },
    ],
  })
  const started = (out.results[0] as unknown as Record<string, unknown>[])[0]?.[
    "started"
  ] as Record<string, unknown>
  expect(started).toMatchObject({ ok: false, refusal: "dirty" })
  expect(String(started["message"])).toContain("half-written.ts")
  expect(await lockExists(ws)).toBe(false)
}, 240_000)

test("the runner drives a whole run: start, feedback, approve, done", async () => {
  const ws = await workspace("runner-whole")
  // A ceiling no default produces: `projects.json`'s own default is 50, so a
  // run that fell back to it would still look right at that figure.
  await projectsFile(ws, [project(ws, { budgetUsd: 7 })])
  const done = await fixture(ws, "done", "ORCH: done")
  await script(ws, [{ fixture: PLAN_FIXTURE }, { fixture: PLAN_FIXTURE }, { fixture: done }])

  const out = await drive(ws, {
    steps: [
      {
        action: "runner",
        calls: [
          { m: "start", projectPath: ws.repo, featureFile: ws.featurePath, taskRef: "T1" },
          { m: "feedback", text: "use a lookup table" },
          { m: "approve" },
        ],
      },
    ],
  })
  const answers = out.results[0] as unknown as Record<string, unknown>[]
  expect(answers[1]).toMatchObject({ ok: true })
  expect(answers[2]).toMatchObject({ ok: true })

  const runId = String((answers[0]?.["started"] as Record<string, unknown>)["runId"])
  const records = await runLog(ws, runId)
  expect(records.at(-1)).toMatchObject({ kind: "end", state: "done" })
  // Each action found the project itself, from the run log's header and the
  // store - the route only ever hands it a run id.
  const branch = String(header(records)["taskRef"])
  expect(branch).toBe("T1")
  // The ceiling came from `projects.json`: a start request names a project, a
  // feature file and a task, and nothing in it mentions money.
  expect(Number(flag(await spawnAt(ws, 0), "--max-budget-usd"))).toBe(7)
  expect(Number(header(records)["budgetUsd"])).toBe(7)
  expect(await git(ws.repo, ["show", `main:${ws.featurePath}`])).toContain("- [ ] T1")
  expect(await lockExists(ws)).toBe(false)
}, 240_000)

test("a start that fails after taking the branch puts the checkout back on base", async () => {
  const ws = await workspace("rollback")
  await script(ws, [{ fixture: PLAN_FIXTURE }])
  const branch = taskBranchName({ feature: ws.featurePath, ref: "T1" })

  // The binary is read for the log header, which happens **after** the branch
  // has been created and checked out. Anything that throws there used to leave
  // the repo on `orch/...`, and the next run then refused with "you are on a
  // kantan task branch" - a refusal about the wrong thing entirely.
  const out = await drive(ws, {
    env: { ORCH_CLAUDE_BIN: join(ws.dir, "no-such-binary") },
    steps: [{ action: "start" }],
  })
  expect(String(out.results[0]?.["error"])).toContain("no-such-binary")

  expect(await git(ws.repo, ["branch", "--show-current"])).toBe("main\n")
  expect(await git(ws.repo, ["branch", "--list", branch])).toBe("")
  expect(await lockExists(ws)).toBe(false)
  // And the task can simply be started again.
  const second = await drive(ws, { steps: [{ action: "start" }] })
  expect(second.results[0]).toMatchObject({ state: { kind: "waiting", reason: "gate" } })
}, 240_000)

test("a run parked at the gate is reported live, and stops being live when it ends", async () => {
  const ws = await workspace("live-ids")
  const done = await fixture(ws, "done", "ORCH: done")
  await script(ws, [{ fixture: PLAN_FIXTURE }, { fixture: done }])

  const out = await drive(ws, {
    steps: [{ action: "start" }, { action: "live" }, { action: "approve" }, { action: "live" }],
  })
  // `indexRuns` folds a `running` phase record to `interrupted` unless the
  // caller names the live runs, and only this process knows them: without this
  // the tree would call every active run interrupted and offer to resume it.
  expect(out.results[1]).toMatchObject({ live: [out.runId] })
  expect(out.results[3]).toMatchObject({ live: [] })
}, 180_000)

/**
 * The port in `src/server.ts` is satisfied **structurally**: the machine
 * imports nothing from the server, so nothing but this line checks that the
 * two shapes still agree. Both imports are types and are erased, so
 * `src/version.ts` never loads here and no binary is resolved.
 *
 * If this stops compiling, the port and the machine have drifted - which is
 * the whole failure this one line exists to catch, since nothing wires a real
 * runner yet.
 */
import type { Runner as ServerRunner } from "../src/server"
type MachineRunner = ReturnType<(typeof import("../src/run"))["createRunner"]>
const _satisfiesThePort: ServerRunner = null as unknown as MachineRunner
void _satisfiesThePort

test("stopping a finished run is a wrong-state refusal, not an unknown run", async () => {
  const ws = await workspace("stop-finished")
  const done = await fixture(ws, "done", "ORCH: done")
  await script(ws, [{ fixture: PLAN_FIXTURE }, { fixture: done }])

  const out = await drive(ws, {
    steps: [{ action: "start" }, { action: "approve" }, { action: "stop-absent" }],
  })
  expect(out.results[1]).toMatchObject({ state: { kind: "done" } })
  // The task tree still shows that row, so "no such run" would be a lie about
  // something the human is looking at.
  expect(out.results[2]?.["code"]).toBe("wrong-state")
  expect(String(out.results[2]?.["error"])).toContain("already finished")
}, 120_000)

test("stopping a run whose server died reports it already interrupted", async () => {
  const ws = await workspace("stop-dead")
  await script(ws, [{ fixture: PLAN_FIXTURE }])

  const first = await drive(ws, { steps: [{ action: "start" }] })
  // A second process: the registry is empty and the lock names a dead pid.
  const second = await drive(ws, { runId: first.runId, steps: [{ action: "stop-absent" }] })
  expect(second.results[0]).toMatchObject({ state: { kind: "interrupted", resumeFrom: "plan" } })
  expect(String((second.results[0]?.["warnings"] as string[])[0])).toContain("already interrupted")

  // And the run is still resumable, which is what makes the no-op honest.
  const third = await drive(ws, { runId: first.runId, steps: [{ action: "resume" }] })
  expect(third.results[0]).toMatchObject({ state: { kind: "waiting", reason: "gate" } })
}, 120_000)

// ---------------------------------------------------------------------------
// A project with no test command: the agent self-checks
// ---------------------------------------------------------------------------
// The user's decision, 2026-10-12. Exercised against the fake binary like
// everything else here, so it costs nothing to run.
//
// What must hold throughout: **nothing claims a verification it did not
// observe.** A self-checked run finishes, ticks and commits, and every durable
// trace of it says it was checked by the agent and by nothing else.

test("with no test command the agent is asked to self-check, and done finishes the run", async () => {
  const ws = await workspace("selfcheck-done")
  const implement = await fixture(ws, "implement-done", "built it\n\nORCH: done")
  const selfCheck = await fixture(ws, "selfcheck-done", "I read the diff and ran it\n\nORCH: done")
  // Three turns, and the third is the point: the self-check is its own turn,
  // not a relabelling of the implement turn's own `ORCH: done`. Those two
  // claims are different - "the work is finished" and "I checked it" - and
  // collapsing them would make "the agent verifies" a thing that never happens.
  await script(ws, [{ fixture: PLAN_FIXTURE }, { fixture: implement }, { fixture: selfCheck }])

  const out = await drive(ws, {
    project: project(ws, { testCmd: null }),
    steps: [{ action: "start" }, { action: "approve" }],
  })
  expect(out.results[1]).toMatchObject({ state: { kind: "done" } })

  const records = await runLog(ws, out.runId)
  // **No `test` record.** `TestRecord.exitCode` is a required number whose
  // whole meaning is "a command ran and exited N", and every reader draws a
  // green pass from a 0. Writing one here would be the over-claim this feature
  // is forbidden from making, so the absence is the assertion.
  expect(records.filter((r) => r["kind"] === "test")).toEqual([])
  expect(records.at(-1)).toMatchObject({
    kind: "end",
    state: "done",
    verifiedBy: "self-check",
  })

  // The self-check ran in the test phase, so the UI's phase rail still has a
  // step there rather than skipping from implement to done.
  const testPhases = phases(records).filter((r) => r["phase"] === "test")
  expect(testPhases.length).toBeGreaterThan(0)

  // The prompt it was actually sent, read off the fake binary's own stdin log.
  const prompt = promptOf((await turns(ws))[2] ?? {})
  expect(prompt).toContain("no test command")
  expect(prompt).toMatch(/how you checked/i)

  // It still ticks, still commits on the task branch, still comes home.
  const branch = String(out.results[0]?.["branch"])
  expect(await git(ws.repo, ["show", `${branch}:${ws.featurePath}`])).toContain("- [x] T1")
  expect(await git(ws.repo, ["branch", "--show-current"])).toBe("main\n")
  expect(await lockExists(ws)).toBe(false)
}, 240_000)

test("the tick commit for a self-checked run does not claim a command was run", async () => {
  const ws = await workspace("selfcheck-commit")
  const implement = await fixture(ws, "implement-done", "ORCH: done")
  const selfCheck = await fixture(ws, "selfcheck-done", "ORCH: done")
  await script(ws, [{ fixture: PLAN_FIXTURE }, { fixture: implement }, { fixture: selfCheck }])

  const out = await drive(ws, {
    project: project(ws, { testCmd: null }),
    steps: [{ action: "start" }, { action: "approve" }],
  })
  const branch = String(out.results[0]?.["branch"])
  const body = await git(ws.repo, ["log", "-1", "--format=%B", branch])

  // This sentence is durable in the user's git history, and the old one -
  // `kantan ran "<cmd>" and it exited 0` - cannot be written for a run where
  // nothing was run. The failure mode to avoid is literal: `JSON.stringify` of
  // a null command yields `kantan ran null and it exited 0`, which is both
  // false and absurd.
  expect(body).not.toContain("exited 0")
  expect(body).not.toContain("null")
  expect(body).toMatch(/no test command/i)
  // It names who did check, so someone reading `git log` in six months knows
  // what this tick rests on.
  expect(body).toMatch(/agent/i)
  expect(body).toContain(out.runId)

  // And the **subject** carries it, which `%B` above cannot prove: the body
  // holds the same words, so reverting `tickSubject` alone would leave every
  // assertion so far passing. `git log --oneline` shows the subject and
  // nothing else, and that is the line someone actually scans.
  const subject = await git(ws.repo, ["log", "-1", "--format=%s", branch])
  expect(subject).toContain("self-checked")
}, 240_000)

test("a self-check that cannot confirm parks the run for a human instead of finishing", async () => {
  const ws = await workspace("selfcheck-blocked")
  const implement = await fixture(ws, "implement-done", "ORCH: done")
  const blocked = await fixture(
    ws,
    "selfcheck-blocked",
    "ORCH: blocked the importer needs a fixture I cannot generate here",
  )
  await script(ws, [{ fixture: PLAN_FIXTURE }, { fixture: implement }, { fixture: blocked }])

  const out = await drive(ws, {
    project: project(ws, { testCmd: null }),
    steps: [{ action: "start" }, { action: "approve" }],
  })

  // The whole value of routing this through the existing sentinel: `blocked`
  // already means "a human reads this and replies", so a self-check that fails
  // needs no new machinery.
  expect(out.results[1]).toMatchObject({
    state: { kind: "waiting", reason: "blocked" },
  })
  const records = await runLog(ws, out.runId)
  expect(records.some((r) => r["kind"] === "end")).toBe(false)

  // And nothing was ticked or committed on a run that was never verified.
  const branch = String(out.results[0]?.["branch"])
  expect(await git(ws.repo, ["show", `${branch}:${ws.featurePath}`])).toContain("- [ ] T1")
  expect(await git(ws.repo, ["log", "--oneline", branch])).not.toContain("tick T1")
}, 240_000)

test("a project WITH a test command still records that the command verified it", async () => {
  // The other half of the absence policy: `verifiedBy` is written on every
  // `done` run, command runs included. If it were written only for self-checks,
  // absence could not keep meaning "a log older than this field" - it would
  // also mean "a run whose tests passed", and the two readings cannot share one
  // silence.
  const ws = await workspace("selfcheck-control")
  const implement = await fixture(ws, "implement-done", "ORCH: done")
  await script(ws, [{ fixture: PLAN_FIXTURE }, { fixture: implement }])

  const out = await drive(ws, { steps: [{ action: "start" }, { action: "approve" }] })
  expect(out.results[1]).toMatchObject({ state: { kind: "done" } })

  const records = await runLog(ws, out.runId)
  expect(records.at(-1)).toMatchObject({ kind: "end", state: "done", verifiedBy: "test-command" })
  // Unchanged: the test record and the exit code are still there.
  expect(records.filter((r) => r["kind"] === "test")).toMatchObject([
    { kind: "test", exitCode: 0, attempt: 1 },
  ])
  // And its commit message still quotes the command and the exit code.
  const branch = String(out.results[0]?.["branch"])
  const body = await git(ws.repo, ["log", "-1", "--format=%B", branch])
  expect(body).toContain("exited 0")
}, 240_000)

test("a self-check interrupted mid-turn resumes into the implement conversation", async () => {
  // The path `continueFrom`'s `test` case now reaches for a no-command project,
  // and the only one that puts `agentTurn`'s loud guard - `!implementStarted &&
  // spawn !== "fresh"` - on a **rehydrated** run. If rehydration gets
  // `implementStarted` wrong, the resume throws instead of resuming, and
  // nothing else in this file can see that.
  const ws = await workspace("selfcheck-resume")
  const implement = await fixture(ws, "implement-done", "ORCH: done")
  const selfCheck = await fixture(ws, "selfcheck-done", "I checked it\n\nORCH: done")
  await script(ws, [
    { fixture: PLAN_FIXTURE },
    { fixture: implement },
    { fixture: selfCheck },
    { fixture: selfCheck },
  ])

  const first = await drive(ws, {
    project: project(ws, { testCmd: null }),
    steps: [{ action: "start" }],
  })
  const runId = first.runId

  await driveAndKill(
    ws,
    {
      runId,
      project: project(ws, { testCmd: null }),
      steps: [{ action: "approve" }],
      // **The kill window, made deterministic.** With a test command the window
      // is the suite's own runtime, which the sibling case buys with `sleep 3`.
      // A self-check has no suite: the `test` phase record is written and the
      // turn is served by a double that replays instantly, so a 25ms poll
      // regularly arrives to find the run already finished and `end` written -
      // which failed this test about one run in five, looking exactly like a
      // rehydration bug. Chunking the double's output stretches the turn into a
      // window a poll can land in. Only on **this** job, so the plan phase in
      // the driver before it stays fast.
      env: { ORCH_FAKE_CHUNK: "40", ORCH_FAKE_CHUNK_DELAY_MS: "20" },
    },
    async () => {
      const log = await runLog(ws, runId)
      const session = phases(log).find((r) => r["phase"] === "implement")?.["sessionId"]
      if (typeof session !== "string") return false
      const inTest = log.some(
        (r) => r["kind"] === "phase" && r["phase"] === "test" && r["state"] === "running",
      )
      return inTest && (await resumable(ws, session))
    },
  )

  const killed = await runLog(ws, runId)
  expect(killed.some((r) => r["kind"] === "end")).toBe(false)
  const implementSession = String(
    phases(killed).find((r) => r["phase"] === "implement")?.["sessionId"],
  )
  expect(implementSession).toMatch(UUID)

  const spawnsBefore = (await spawns(ws)).length
  const resumed = await drive(ws, {
    runId,
    project: project(ws, { testCmd: null }),
    steps: [{ action: "resume" }],
  })
  expect(resumed.results[0]).toMatchObject({ state: { kind: "done" } })

  // It resumed the IMPLEMENT conversation, so the agent still has its own
  // implementation in context when it is asked to check it.
  const argv = await spawnAt(ws, spawnsBefore)
  expect(flag(argv, "--resume")).toBe(implementSession)
  expect(argv).not.toContain("--session-id")

  const records = await runLog(ws, runId)
  // Still no `test` record, and still recorded as a self-check: an interrupted
  // run must not finish by a different standard than an uninterrupted one.
  expect(records.filter((r) => r["kind"] === "test")).toEqual([])
  expect(records.at(-1)).toMatchObject({ kind: "end", state: "done", verifiedBy: "self-check" })
}, 240_000)

test("a blocked self-check is answered, and the check then runs again", async () => {
  // `answerQuestion` maps any phase that is not `plan` to the implement
  // session, so a run parked at `phase: "test"` has to land there too. The
  // answer does not itself finish the run: the self-check happens again, which
  // is the point - a human's reply is not a verification either.
  const ws = await workspace("selfcheck-answer")
  const implement = await fixture(ws, "implement-done", "ORCH: done")
  const blocked = await fixture(ws, "sc-blocked", "ORCH: blocked I cannot tell if the CSV parses")
  const done = await fixture(ws, "sc-done", "Checked with your fixture\n\nORCH: done")
  await script(ws, [
    { fixture: PLAN_FIXTURE },
    { fixture: implement },
    { fixture: blocked },
    { fixture: done },
    { fixture: done },
  ])

  const first = await drive(ws, {
    project: project(ws, { testCmd: null }),
    steps: [{ action: "start" }, { action: "approve" }],
  })
  expect(first.results[1]).toMatchObject({ state: { kind: "waiting", reason: "blocked" } })

  const answered = await drive(ws, {
    runId: first.runId,
    project: project(ws, { testCmd: null }),
    steps: [{ action: "answer", text: "there is a fixture at test/fixtures/sample.csv" }],
  })
  expect(answered.results[0]).toMatchObject({ state: { kind: "done" } })

  // The human's words reached the agent verbatim, in the implement session.
  const prompts = (await turns(ws)).map((t) => promptOf(t))
  expect(prompts.some((p) => p.includes("test/fixtures/sample.csv"))).toBe(true)

  const records = await runLog(ws, first.runId)
  expect(records.at(-1)).toMatchObject({ kind: "end", state: "done", verifiedBy: "self-check" })
}, 240_000)

// ---------------------------------------------------------------------------
// Starting on a dirty tree, on purpose
// ---------------------------------------------------------------------------

test("a dirty repo still refuses by default, and the refusal keeps its stash advice", async () => {
  // The half that must not regress. Every ordinary start is unaffected, and the
  // message is still the one that explains why a plain `git stash` leaves
  // untracked files behind and the user hitting this again.
  const ws = await workspace("dirty-default")
  await writeFile(join(ws.repo, "half-written.ts"), "the human was editing this\n")

  const out = await drive(ws, { steps: [{ action: "start" }] })

  expect(String(out.results[0]?.["error"])).toContain("half-written.ts")
  expect(String(out.results[0]?.["code"])).toBe("dirty")
  expect((await readJsonl(ws.log)).length).toBe(0)
  expect(await lockExists(ws)).toBe(false)
}, 30_000)

test("allowDirty starts the run, records the files in the header, and tells the agent", async () => {
  const ws = await workspace("dirty-allowed")
  await script(ws, [{ fixture: PLAN_FIXTURE }])
  await writeFile(join(ws.repo, "half-written.ts"), "the human was editing this\n")
  await writeFile(join(ws.repo, "a.txt"), "and this was already tracked\n")

  const out = await drive(ws, { steps: [{ action: "start", allowDirty: true }] })
  expect(out.results[0]).toMatchObject({ state: { kind: "waiting", reason: "gate" } })

  // **The log is the only channel that survives the server.** Someone looking
  // at a surprising diff weeks later cannot ask git which files the agent
  // inherited - they are committed or gone by then.
  const head = header(await runLog(ws, out.runId))
  expect((head["dirtyAtStart"] as string[]).sort()).toEqual(["a.txt", "half-written.ts"])

  // And the agent was told, by name, in the prompt it actually received.
  const prompt = promptOf((await turns(ws))[0] ?? {})
  expect(prompt).toContain("half-written.ts")
  expect(prompt).toContain("a.txt")
  expect(prompt).toContain("clean when this run started")
}, 240_000)

test("an ordinary run records no dirtyAtStart at all, so presence is a real claim", async () => {
  // Absence must never be readable as "it started clean" - every log written
  // before the field existed is absent too. An ordinary run has been proved
  // clean by the guard, and says nothing.
  const ws = await workspace("dirty-absent")
  await script(ws, [{ fixture: PLAN_FIXTURE }])

  const out = await drive(ws, { steps: [{ action: "start" }] })

  expect(header(await runLog(ws, out.runId))["dirtyAtStart"]).toBeUndefined()
}, 240_000)

test("allowDirty does not waive an in-progress merge, however explicit it was", async () => {
  // The asymmetry that makes this safe. An opt-in means "there is work I want
  // continued"; it cannot mean "inherit my unfinished merge", because the
  // agent's next commit would silently carry MERGE_HEAD as a second parent and
  // no later diff would explain it.
  const ws = await workspace("dirty-merge")
  // Self-contained: a file this workspace tracks, then two divergent edits to
  // it, so `git merge` leaves a real conflict and MERGE_HEAD set.
  const contested = join(ws.repo, "contested.txt")
  await writeFile(contested, "base\n")
  await git(ws.repo, ["add", "contested.txt"])
  await git(ws.repo, ["commit", "-m", "add contested.txt"])
  await git(ws.repo, ["switch", "-c", "other"])
  await writeFile(contested, "theirs\n")
  await git(ws.repo, ["commit", "-am", "theirs"])
  await git(ws.repo, ["switch", "main"])
  await writeFile(contested, "ours\n")
  await git(ws.repo, ["commit", "-am", "ours"])
  await git(ws.repo, ["merge", "other"]).catch(() => undefined)

  const out = await drive(ws, { steps: [{ action: "start", allowDirty: true }] })

  expect(String(out.results[0]?.["code"])).toBe("dirty")
  expect(String(out.results[0]?.["error"])).toMatch(/merge|conflict/i)
  expect((await readJsonl(ws.log)).length).toBe(0)
}, 30_000)
