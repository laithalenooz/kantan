/**
 * A kantan with one run in every state, for looking at.
 *
 * Why this exists: every interesting screen in this app is a **state of a
 * run**, and the only way to reach one used to be to drive a real agent -
 * which costs money, takes minutes, and cannot be put into the state you
 * wanted on purpose. So the gate, the stall, the failure and the grind were
 * all unviewable without spending, and the README had no screenshots.
 *
 * **It adds nothing to the product.** There is no fixture mode, no `?states=`
 * flag, no dev-only branch in a route. It builds a scratch home - a
 * `projects.json`, two real git repositories with real feature files, and run
 * logs written through `createRunLog` and `append` - and then boots the
 * ordinary server against it. Every screen you see is the real UI reading the
 * real readers; the only thing faked is the agent that would have written the
 * logs.
 *
 * That is deliberately the cheaper and the *stronger* option: a fixture mode
 * would prove the components render, while this proves `indexRuns`,
 * `foldForResume`, the tree and the SSE replay all agree about what a log
 * means - which is where every state bug in this project has actually been.
 *
 *   bun run docs/probes/states.ts            # boots and prints the URL
 *   bun run docs/probes/states.ts --port 3190
 *
 * It writes only under `/tmp`, never to your own `~/.kantan`.
 */

import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createRunLog } from "../../src/runlog"
import type { RunHeader } from "../../src/runlog"
import { addProject, defaults } from "../../src/projects"
import { createServer } from "../../src/server"

const args = process.argv.slice(2)
const portAt = args.indexOf("--port")
const PORT = portAt === -1 ? 3190 : Number(args[portAt + 1] ?? 3190)

/** Keyed on the pid, like every scratch path in this repo. */
const HOME = join(tmpdir(), `kantan-states-${process.pid}`)
const RUNS = join(HOME, ".kantan", "runs")

async function git(cwd: string, ...a: string[]): Promise<void> {
  const p = Bun.spawn(["git", ...a], {
    cwd,
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, GIT_AUTHOR_NAME: "kantan", GIT_AUTHOR_EMAIL: "k@example.com", GIT_COMMITTER_NAME: "kantan", GIT_COMMITTER_EMAIL: "k@example.com" },
  })
  if ((await p.exited) !== 0) throw new Error(`git ${a.join(" ")} failed in ${cwd}`)
}

/** A real repository with a real feature file, because the tree parses both. */
async function repo(name: string, feature: string, tasks: string[]): Promise<string> {
  const dir = join(HOME, "code", name)
  await mkdir(join(dir, "docs", "features"), { recursive: true })
  await mkdir(join(dir, "docs", "plans"), { recursive: true })
  await writeFile(join(dir, "docs", "features", feature), `# ${name}\n\n${tasks.join("\n")}\n`)
  await writeFile(join(dir, "package.json"), `{"name":"${name}","scripts":{"test":"echo ok"}}\n`)
  await git(dir, "init", "-q", "-b", "main", ".")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "the work so far")
  return dir
}

function header(over: Partial<RunHeader> & Pick<RunHeader, "runId" | "projectPath" | "featureFile" | "taskRef">): RunHeader {
  return {
    claudeVersion: "2.1.296",
    planSessionId: `plan-${over.runId}`,
    profile: null,
    planModel: "claude-opus-5-5",
    implementModel: "claude-sonnet-5-5",
    planEffort: "high",
    implementEffort: "medium",
    featureFileHash: "0".repeat(64),
    baseBranch: "main",
    startedAt: new Date(Date.now() - 9 * 60_000).toISOString(),
    budgetUsd: 50,
    ...over,
  } as RunHeader
}

/** One stream-json assistant line, as the CLI would have emitted it. */
function says(text: string): string {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } })
}

function tool(name: string, input: unknown): string {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name, input }] } })
}

const PLAN = `# Parse the manifest

The importer reads \`manifest.json\` and maps each record onto a row. Today it
assumes every field is present, which is why the 2024-Q3 export crashes it.

## What I will change

1. **\`src/importer/manifest.ts\`** — read the envelope rather than casting it,
   so a missing \`version\` is an error with a line number instead of
   \`undefined\` three functions later.
2. **\`src/importer/rows.ts\`** — map records in one pass, skipping nothing
   silently: a record this version cannot read becomes a warning that names
   the field.
3. **\`test/importer.test.ts\`** — the 2024-Q3 export as a fixture, plus the
   four field combinations it contains.

## What I will not change

The CSV writer. It already handles a missing column, and widening its
behaviour for this would couple two formats that have no reason to agree.
`

async function main(): Promise<void> {
  await rm(HOME, { recursive: true, force: true })
  await mkdir(RUNS, { recursive: true })

  const importer = await repo("importer", "importer.md", [
    "- [ ] T1 Parse the manifest",
    "- [ ] T2 Map records to rows",
    "- [ ] T3 Runtime shim for v1.2 exports",
    "- [x] T4 Read the envelope before casting it",
  ])
  const web = await repo("web-app", "checkout.md", [
    "- [ ] T1 Validate the discount code server-side",
    "- [ ] T2 Show the tax line before payment",
  ])

  const store = join(HOME, ".kantan", "projects.json")
  await addProject(store, defaults({ path: importer, testCmd: "bun run check", account: "personal" }))
  await addProject(store, defaults({ path: web, testCmd: "npm test", account: "work" }))

  // --- waiting at the gate: the screen the whole design is arranged around ---
  const planPath = "docs/plans/2026-10-13-importer-t1-1a2b3c4d.md"
  await writeFile(join(importer, planPath), PLAN)
  {
    const id = "11111111-1111-4111-8111-111111111111"
    const log = await createRunLog(join(RUNS, `${id}.jsonl`), header({ runId: id, projectPath: importer, featureFile: "docs/features/importer.md", taskRef: "T1" }))
    await log.append({ kind: "phase", phase: "plan", state: "running", at: Date.now() - 540_000 })
    await log.appendCli(says("Reading the importer and the failing export."))
    await log.appendCli(tool("Read", { file_path: `${importer}/src/importer/manifest.ts` }))
    await log.appendCli(tool("Grep", { pattern: "manifest", path: "src" }))
    await log.appendCli(says("The crash is a cast, not a parse. Writing the plan."))
    await log.append({ kind: "phase", phase: "plan", state: "waiting", reason: "gate", planPath, sessionId: `plan-${id}`, at: Date.now() - 120_000 })
    await log.close()
  }

  // --- running: an implement phase mid-flight -------------------------------
  {
    const id = "22222222-2222-4222-8222-222222222222"
    const log = await createRunLog(join(RUNS, `${id}.jsonl`), header({ runId: id, projectPath: web, featureFile: "docs/features/checkout.md", taskRef: "T1" }))
    await log.append({ kind: "phase", phase: "plan", state: "running", at: Date.now() - 480_000 })
    await log.appendCli(says("The discount code is only checked in the browser."))
    await log.append({ kind: "phase", phase: "gate", state: "waiting", reason: "gate", at: Date.now() - 400_000 })
    await log.append({ kind: "human", action: "approve" })
    await log.append({ kind: "phase", phase: "implement", state: "running", at: Date.now() - 300_000 })
    await log.appendCli(tool("Edit", { file_path: `${web}/src/checkout/discount.ts` }))
    await log.appendCli(says("Moving the check to the server and keeping the client hint."))
    await log.appendCli(tool("Bash", { command: "npm test" }))
    await log.close()
  }

  const launch = createServer({
    port: PORT,
    runsDir: RUNS,
    projectsFile: store,
    homeDir: HOME,
    /**
     * The running fixture is only *running* because this says so.
     *
     * Liveness is not in a log and cannot be - a log with no `end` record is
     * indistinguishable from one the server died in the middle of - so without
     * this the mid-flight run reads as `interrupted`, which is the correct
     * answer to the wrong question. Naming it here is the same thing
     * `liveRunIds()` does for the real machine.
     */
    liveRunIds: () => ["22222222-2222-4222-8222-222222222222"],
    ask: () => Promise.reject(new Error("the states probe reaches no model")),
  })

  console.log(`kantan with fixture states on http://127.0.0.1:${launch.port}`)
  console.log(`  scratch home: ${HOME}`)
  console.log(`  gate:    importer / T1 Parse the manifest`)
  console.log(`  running: web-app / T1 Validate the discount code`)
  console.log(`  ctrl-c to stop; the scratch home is left for inspection`)
}

await main()
