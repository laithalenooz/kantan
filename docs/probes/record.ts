/**
 * Records the whole flow — gate, approve, implement, a failing suite, a refine,
 * a passing suite, done — as a video and a GIF, without spending a penny.
 *
 *   bun run docs/probes/record.ts            # writes docs/media/flow.{mp4,gif}
 *   bun run docs/probes/record.ts --port 3192
 *
 * **What is real here and what is not**, because a launch asset that overstates
 * itself is the one thing this project cannot afford to ship.
 *
 * Real: the server, the run log, the SSE replay, the fold, every component, and
 * the click. Pressing **Approve plan** really does drive the transition — the
 * server is constructed with a `Runner`, the route really calls it, and the
 * phase records really land in a real JSONL that the page is really tailing.
 * Nothing is mocked inside the app.
 *
 * Not real: the agent. That `Runner` writes the records a `claude` child would
 * have written, on a timer, instead of spawning one. So the recording is a
 * **re-enactment of a run that did happen** — the events are copied from the
 * shape of real logs in `~/.kantan/runs` — rather than a staged mock of a UI.
 * The alternative was one billed run per take, and a take is never right first
 * time.
 *
 * Timing is captured per frame and handed to ffmpeg as explicit durations, so
 * the result plays at the speed it was recorded at rather than at whatever
 * rate the screenshot loop managed.
 */

import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { taskBranchName } from "../../src/git"
import { createRunLog } from "../../src/runlog"
import type { RunHeader, RunLog } from "../../src/runlog"
import { addProject, defaults } from "../../src/projects"
import { createServer } from "../../src/server"
import type { Acted, Runner, Started } from "../../src/http/context"

const args = process.argv.slice(2)
const at = (flag: string, fallback: number): number => {
  const i = args.indexOf(flag)
  return i === -1 ? fallback : Number(args[i + 1] ?? fallback)
}
const PORT = at("--port", 3192)
const CDP = at("--cdp", 9360)
const FPS = at("--fps", 10)

const HOME = join(tmpdir(), `kantan-record-${process.pid}`)
const RUNS = join(HOME, ".kantan", "runs")
const FRAMES = join(HOME, "frames")
const OUT = join(import.meta.dir, "..", "media")
const RUN_ID = "33333333-3333-4333-8333-333333333333"

async function git(cwd: string, ...a: string[]): Promise<void> {
  const p = Bun.spawn(["git", ...a], {
    cwd,
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, GIT_AUTHOR_NAME: "kantan", GIT_AUTHOR_EMAIL: "k@example.invalid", GIT_COMMITTER_NAME: "kantan", GIT_COMMITTER_EMAIL: "k@example.invalid" },
  })
  if ((await p.exited) !== 0) throw new Error(`git ${a.join(" ")} failed`)
}

const PLAN = `# Map records to rows

The importer reads \`manifest.json\` and maps each record onto a row. Today it
drops a record whose \`version\` field is missing, silently, which is why the
2024-Q3 export loses 41 rows and nobody noticed for a month.

## What I will change

1. **\`src/importer/rows.ts\`** — map records in one pass and warn once per
   dropped field, naming the field, instead of skipping in silence.
2. **\`src/importer/manifest.ts\`** — read the envelope rather than casting it,
   so a missing \`version\` is an error with a line number.
3. **\`test/importer.test.ts\`** — the 2024-Q3 export as a fixture, plus the
   four field combinations it contains.

## What I will not change

The CSV writer. It already handles a missing column, and widening it for this
would couple two formats that have no reason to agree.
`

function header(): RunHeader {
  return {
    claudeVersion: "2.1.296",
    runId: RUN_ID,
    planSessionId: `plan-${RUN_ID}`,
    profile: null,
    planModel: "claude-opus-5-5",
    implementModel: "claude-sonnet-5-5",
    planEffort: "high",
    implementEffort: "medium",
    featureFileHash: "0".repeat(64),
    baseBranch: "main",
    startedAt: new Date(Date.now() - 7 * 60_000).toISOString(),
    budgetUsd: 50,
    projectPath: join(HOME, "code", "importer"),
    featureFile: "docs/features/importer.md",
    taskRef: "T2",
  } as RunHeader
}

/** One stream-json line, in the shapes a real log holds. */
const says = (text: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } })
const tool = (name: string, input: unknown) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${Math.random()}`, name, input }] } })
const result = (costUsd: number) =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: costUsd, num_turns: 6, result: "ORCH: done" })

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * The agent, as a `Runner`.
 *
 * Writes what a `claude` child would have written. The *route* is real, so the
 * Approve button in the recording is doing the thing it says it does.
 */
function reenactment(log: RunLog, repo: string): { runner: Runner; done: Promise<void> } {
  let settle: () => void = () => {}
  const done = new Promise<void>((r) => { settle = r })

  const refuse = (): Acted => ({ ok: false, refusal: "wrong-state", message: "the recording drives only approve" })

  const runner = {
    start: (): Promise<Started> => Promise.resolve({ ok: false, refusal: "busy", message: "a run is already in flight" }),
    feedback: () => Promise.resolve(refuse()),
    answer: () => Promise.resolve(refuse()),
    raise: () => Promise.resolve(refuse()),
    resume: () => Promise.resolve(refuse()),
    stop: () => Promise.resolve(refuse()),
    async approve(): Promise<Acted> {
      void (async () => {
        await log.append({ kind: "human", action: "approve" })
        await log.append({ kind: "phase", phase: "implement", state: "running", sessionId: `impl-${RUN_ID}`, at: Date.now() })
        await wait(2200)
        await log.appendCli(says("Reading the importer and the failing export."))
        await wait(2000)
        await log.appendCli(tool("Read", { file_path: `${repo}/src/importer/rows.ts` }))
        await wait(1900)
        await log.appendCli(tool("Edit", { file_path: `${repo}/src/importer/rows.ts` }))
        await wait(1900)
        await log.appendCli(tool("Edit", { file_path: `${repo}/test/importer.test.ts` }))
        await wait(1800)
        await log.appendCli(says("Warning once per dropped field, and the 2024-Q3 fixture is in."))
        await wait(1800)
        await log.appendCli(result(0.41))

        // The suite, run by the server. It fails the first time, which is the
        // point: the next records show what kantan does about that.
        await log.append({ kind: "phase", phase: "test", state: "running", at: Date.now() })
        await wait(2800)
        await log.append({ kind: "test", exitCode: 1, signature: "a1b2c3d4", attempt: 1 })
        await wait(2600)

        await log.append({ kind: "phase", phase: "refine", state: "running", sessionId: `impl-${RUN_ID}`, at: Date.now() })
        await wait(1900)
        await log.appendCli(says("One case warns twice. Moving the warning out of the loop."))
        await wait(2000)
        await log.appendCli(tool("Edit", { file_path: `${repo}/src/importer/rows.ts` }))
        await wait(1900)
        await log.appendCli(result(0.22))

        await log.append({ kind: "phase", phase: "test", state: "running", at: Date.now() })
        await wait(2900)
        await log.append({ kind: "test", exitCode: 0, attempt: 2 })
        await wait(1800)
        await log.append({ kind: "end", state: "done", verifiedBy: "test-command", costUsd: 0.63, warnings: [] })
        await wait(4000)
        settle()
      })().catch((cause) => {
        console.error("the re-enactment failed:", cause)
        settle()
      })
      return { ok: true }
    },
  }
  return { runner, done }
}

// --- CDP ---------------------------------------------------------------------

async function chrome(): Promise<{ send: (m: string, p?: Record<string, unknown>) => Promise<Record<string, unknown>>; kill: () => void }> {
  const proc = Bun.spawn(
    [
      "google-chrome", "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
      `--remote-debugging-port=${CDP}`, "--window-size=1280,800",
      `--user-data-dir=${join(HOME, "chrome")}`, "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  )
  let socket = ""
  for (let i = 0; i < 80; i++) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl !== undefined)
      if (page?.webSocketDebuggerUrl !== undefined) { socket = page.webSocketDebuggerUrl; break }
    } catch { /* not listening yet */ }
    await wait(250)
  }
  if (socket === "") throw new Error("chrome never opened a debugging port")

  const ws = new WebSocket(socket)
  await new Promise<void>((ok, bad) => {
    ws.addEventListener("open", () => ok())
    ws.addEventListener("error", () => bad(new Error("cdp socket failed")))
  })
  let id = 0
  const waiting = new Map<number, (v: Record<string, unknown>) => void>()
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data)) as { id?: number; result?: Record<string, unknown> }
    if (m.id !== undefined) waiting.get(m.id)?.(m.result ?? {})
  })
  const send = (method: string, params: Record<string, unknown> = {}) => {
    const mine = ++id
    ws.send(JSON.stringify({ id: mine, method, params }))
    return new Promise<Record<string, unknown>>((ok) => waiting.set(mine, ok))
  }
  /* Both halves. An open WebSocket keeps Bun's event loop alive on its own, so
     killing only the process leaves this probe hanging after it has written its
     output - which it did, until `timeout` SIGKILLed it at 300s and reported a
     failure for a recording that had already succeeded. */
  return {
    send,
    kill: () => {
      ws.close()
      proc.kill()
    },
  }
}

// --- the recording -----------------------------------------------------------

async function main(): Promise<void> {
  await rm(HOME, { recursive: true, force: true })
  await mkdir(FRAMES, { recursive: true })
  await mkdir(OUT, { recursive: true })

  const repo = join(HOME, "code", "importer")
  await mkdir(join(repo, "docs", "features"), { recursive: true })
  await mkdir(join(repo, "docs", "plans"), { recursive: true })
  await writeFile(
    join(repo, "docs", "features", "importer.md"),
    "# importer\n\n- [x] T1 Parse the manifest\n- [ ] T2 Map records to rows\n- [ ] T3 Runtime shim for v1.2 exports\n",
  )
  await writeFile(join(repo, "package.json"), '{"name":"importer","scripts":{"test":"bun test"}}\n')
  await git(repo, "init", "-q", "-b", "main", ".")
  await git(repo, "add", "-A")
  await git(repo, "commit", "-q", "-m", "the work so far")

  /* The plan, committed on `main` **before** the task branch exists.
   *
   * Order is load-bearing and was not obvious. Written and left uncommitted, it
   * rides onto the task branch at `switch -c`, gets committed there by the
   * `add -A` below, and then disappears from the working tree the moment the
   * checkout returns to base - so the gate fetches it, gets a 404, leaves
   * **Approve plan** disabled on `loaded`, and the recorder has nothing to
   * press. An earlier version of this probe merged the branch back into `main`,
   * which hid that by accident. */
  const planPath = "docs/plans/2026-10-13-importer-t2-9f3a1c08.md"
  await writeFile(join(repo, planPath), PLAN)
  await git(repo, "add", "-A")
  await git(repo, "commit", "-q", "-m", "docs: the plan for T2")

  /* The task branch, as a finished run leaves it: created, holding the work,
   * and **not merged**.
   *
   * I first merged it into `main`, to make the last frame read "Passed" rather
   * than "Done - unmerged". Both halves of that were wrong.
   *
   * It changes nothing, because `readProjects` in `src/tree.ts` passes
   * `indexRuns` **no merge predicate at all** - deliberately, and it says why at
   * length: `isMergedIntoBase` needs a base branch, nothing resolves a
   * project's base outside a run that was started from it, and a 5ms-a-row
   * predicate takes the fold from 89-180ms to 2733ms over 500 logs. So `merged`
   * is false for every finished task and "Done - unmerged" is what the product
   * shows, not an artefact of this fixture.
   *
   * And it would be less faithful if it did work. kantan returns the checkout
   * to base on `done` and leaves the tick on the task branch for a human to
   * merge, so unmerged *is* the state of a run that has just finished. Merging
   * it here would have dressed the fixture as something no real run produces.
   *
   * The branch is still created, because a real run leaves one and a probe that
   * someone extends with a merge predicate needs it to exist. */
  const branch = taskBranchName({ feature: "docs/features/importer.md", ref: "T2" })
  await git(repo, "switch", "-q", "-c", branch)
  await writeFile(join(repo, "rows.ts"), "// the mapped rows\n")
  await git(repo, "add", "-A")
  await git(repo, "commit", "-q", "-m", "feat: map records to rows\n\nT2")
  await git(repo, "switch", "-q", "main")

  const store = join(HOME, ".kantan", "projects.json")
  await addProject(store, defaults({ path: repo, testCmd: "bun run check", account: "personal" }))

  const log = await createRunLog(join(RUNS, `${RUN_ID}.jsonl`), header())
  await log.append({ kind: "phase", phase: "plan", state: "running", at: Date.now() - 420_000 })
  await log.appendCli(says("Reading the importer and the 2024-Q3 export."))
  await log.appendCli(tool("Grep", { pattern: "version", path: "src/importer" }))
  await log.appendCli(says("The records are dropped by a guard, not by the parser. Writing the plan."))
  await log.append({
    kind: "phase",
    phase: "plan",
    state: "waiting",
    reason: "gate",
    planPath,
    // Both fields, because both are in a real log - checked against the two in
    // `~/.orch/runs` on the machine this was written on.
    detail: planPath,
    sessionId: `plan-${RUN_ID}`,
    at: Date.now() - 95_000,
  })

  const { runner, done } = reenactment(log, repo)
  const launch = createServer({
    port: PORT,
    runsDir: RUNS,
    projectsFile: store,
    homeDir: HOME,
    runner,
    liveRunIds: () => [RUN_ID],
    ask: () => Promise.reject(new Error("the recorder reaches no model")),
  })
  console.log(`recording against http://127.0.0.1:${launch.port}`)

  const { send, kill } = await chrome()
  /**
   * Evaluates and returns the value, so a selector that matched nothing fails
   * here.
   *
   * Earned: the first run of this probe recorded 40 seconds of a static page,
   * because a click that finds no element is indistinguishable over CDP from a
   * click that worked. Every interaction below therefore reports what it found
   * and the recorder refuses rather than filming nothing.
   */
  const evaluate = async (expression: string): Promise<unknown> => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true })
    const value = r["result"]
    return typeof value === "object" && value !== null ? (value as { value?: unknown }).value : undefined
  }

  await send("Page.navigate", { url: `http://127.0.0.1:${launch.port}/` })
  await wait(3200)

  // Open the parked task, so the first frame is the gate.
  const opened = await evaluate(
    `(() => {
       const row = [...document.querySelectorAll("button[data-task-row]")]
         .find(b => (b.textContent ?? "").includes("Map records to rows"))
       if (!row) return "no row: " + document.querySelectorAll("button[data-task-row]").length + " rows on the page"
       row.click()
       return "ok"
     })()`,
  )
  if (opened !== "ok") throw new Error(`could not open the task: ${String(opened)}`)
  await wait(2200)

  const gate = await evaluate(`document.querySelector('[data-testid="kg-plan-path"]')?.textContent ?? null`)
  if (typeof gate !== "string") throw new Error("the task opened but no gate rendered - nothing to record")
  console.log(`gate is up, showing ${gate}`)

  /** Frame, and when it was taken, so ffmpeg can play it back at real speed. */
  const frames: Array<{ file: string; at: number }> = []
  let shooting = true
  const camera = (async () => {
    let n = 0
    while (shooting) {
      const started = Date.now()
      const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 82 })
      const data = (shot["data"] as string | undefined) ?? ""
      if (data !== "") {
        const file = join(FRAMES, `f${String(n++).padStart(5, "0")}.jpg`)
        await Bun.write(file, Buffer.from(data, "base64"))
        frames.push({ file, at: started })
      }
      const spent = Date.now() - started
      await wait(Math.max(0, Math.floor(1000 / FPS) - spent))
    }
  })()

  // Two seconds of the gate before anything moves, then the click that starts it.
  await wait(2000)
  /* `button.kg-approve`, not the label. The button's text is "Approve plan" plus
     the chord's chip, which is a child of it, so an exact-label match finds
     nothing - and a substring match would also reach the title attribute's
     "Approve plan - press A". The class is the element's own identity and
     `Gate.tsx` renders exactly one. Polled because `disabled={!loaded}` is true
     until the plan file arrives over its own fetch. */
  let pressed: unknown = "never tried"
  for (let i = 0; i < 40 && pressed !== "ok"; i++) {
    pressed = await evaluate(
      `(() => {
         const b = document.querySelector("button.kg-approve")
         if (!b) return "no button"
         if (b.disabled) return "disabled"
         b.click()
         return "ok"
       })()`,
    )
    if (pressed !== "ok") await wait(250)
  }
  if (pressed !== "ok") throw new Error(`could not press Approve plan: ${String(pressed)}`)
  console.log("approved; recording the run")

  await Promise.race([
    done,
    new Promise<never>((_, bad) =>
      setTimeout(() => bad(new Error("the re-enactment did not reach `end` within 120s")), 120_000),
    ),
  ])
  shooting = false
  /* Bounded, because the camera's last `captureScreenshot` is a CDP round trip
     and a round trip to a browser that has stopped answering never settles. The
     frames already captured are on disk and are what the clip is made of, so
     waiting past a few seconds for one more can only turn a finished recording
     into a hang. */
  await Promise.race([camera, wait(8000)])
  kill()
  launch.stop()
  await log.close()

  console.log(`${frames.length} frames over ${((frames.at(-1)!.at - frames[0]!.at) / 1000).toFixed(1)}s`)

  /* Explicit per-frame durations, so the result plays at the speed it was
     recorded at. A fixed -framerate would drift with the capture loop. */
  const list = frames
    .map((f, i) => {
      const next = frames[i + 1]
      const seconds = ((next === undefined ? 120 : next.at - f.at) / 1000).toFixed(3)
      return `file '${f.file}'\nduration ${seconds}`
    })
    .join("\n")
  const concat = join(HOME, "frames.txt")
  await writeFile(concat, `${list}\nfile '${frames.at(-1)!.file}'\n`)

  const run = async (label: string, argv: string[]): Promise<void> => {
    const p = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" })
    const said = await new Response(p.stderr).text()
    if ((await p.exited) !== 0) throw new Error(`${label} failed:\n${said.slice(-800)}`)
  }

  const mp4 = join(OUT, "flow.mp4")
  await run("mp4", [
    "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", concat,
    "-vf", "scale=1280:-2:flags=lanczos", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-preset", "slow", "-crf", "24", "-movflags", "+faststart", mp4,
  ])

  /* The GIF is for the places that will not take a video. 960 wide and 10fps
     keeps it under a few megabytes; a palette built from the whole clip stops
     the orange banding that a per-frame palette produces. */
  const palette = join(HOME, "palette.png")
  await run("palette", ["ffmpeg", "-y", "-i", mp4, "-vf", "fps=10,scale=960:-1:flags=lanczos,palettegen=max_colors=192", palette])
  const gif = join(OUT, "flow.gif")
  await run("gif", [
    "ffmpeg", "-y", "-i", mp4, "-i", palette,
    "-lavfi", "fps=10,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3",
    gif,
  ])

  const size = (p: string) => `${(Bun.file(p).size / 1_000_000).toFixed(2)} MB`
  console.log(`wrote ${mp4} (${size(mp4)})`)
  console.log(`wrote ${gif} (${size(gif)})`)
  await rm(HOME, { recursive: true, force: true })
}

await main()

/* Explicit, and last.
 *
 * `launch.stop()` stops accepting connections but the listener's teardown is
 * not synchronous, and this probe has nothing left to do either way: the files
 * are on disk and their sizes are printed. Without this the process sat idle
 * until the wrapper's `timeout` killed it, so a run that had produced both
 * assets reported exit 137. */
process.exit(0)
