import { expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"

const repoRoot = join(import.meta.dir, "..")
const FAKE = join(import.meta.dir, "fake-claude.ts")

/** A scratch directory per test, so no script, cursor or log is shared. */
async function workspace(name: string): Promise<string> {
  const dir = join(repoRoot, ".kantan-test", "fake-claude", name)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  return dir
}

type Run = { out: string; err: string; code: number }

/**
 * The child's environment: the ambient one with every `KANTAN_FAKE_*` stripped,
 * plus what the test asks for.
 *
 * Without the strip, a test that deliberately configures no script would pick
 * one up from the developer's shell, and the refusal it asserts on would
 * depend on who ran the suite.
 */
function childEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("KANTAN_FAKE_")) env[k] = v
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  return env
}

/** Spawns the fake by bare path, the way a spawner holding KANTAN_CLAUDE_BIN does. */
async function runFake(opts: {
  args: string[]
  stdin?: string
  env?: Record<string, string | undefined>
}): Promise<Run> {
  const p = Bun.spawn([FAKE, ...opts.args], {
    stdin: new TextEncoder().encode(opts.stdin ?? ""),
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv(opts.env),
  })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  return { out, err, code }
}

const FIXTURES = join(import.meta.dir, "fixtures")
const PLAN = join(FIXTURES, "plan-success.jsonl")
const QUESTION = join(FIXTURES, "ends-with-question.jsonl")
const BUDGET = join(FIXTURES, "budget-exhausted.jsonl")

type Turn = { fixture?: string; cost?: number } & Record<string, unknown>

/** Writes a turn script and returns its path. */
async function writeScript(dir: string, turns: Turn[], extra: Record<string, unknown> = {}) {
  const path = join(dir, "script.json")
  await writeFile(path, JSON.stringify({ turns, ...extra }))
  return path
}

/** One newline-delimited stream-json user message, as src/spawn.ts will write them. */
function userTurn(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n"
}

function events(out: string): Record<string, unknown>[] {
  return out
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

function results(out: string): Record<string, unknown>[] {
  return events(out).filter((e) => e["type"] === "result")
}

/** The flag set src/spawn.ts will pass, per design §3.1. */
function baseArgs(sessionFlag: string[], extra: string[] = []): string[] {
  return [
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
    ...sessionFlag,
    ...extra,
  ]
}

// ---------------------------------------------------------------------------
// Requirement 1: --version answers with an X.Y.Z string.
//
// test/version.test.ts's first test calls the configured binary and asserts a
// version. If a later task points KANTAN_CLAUDE_BIN at this fake suite-wide,
// that test must still pass.
// ---------------------------------------------------------------------------

test("--version prints an X.Y.Z version and exits 0", async () => {
  const { out, code } = await runFake({ args: ["--version"] })
  expect(code).toBe(0)
  expect(out).toMatch(/\d+\.\d+\.\d+/)
})

test("--version wins over every other flag, as the real CLI lets it", async () => {
  // Probed: `claude --version -p --verbose` prints the version and exits 0, so
  // --version must not be subject to the replay invocation's guards.
  const { out, code } = await runFake({ args: ["--version", "-p", "--verbose"] })
  expect(code).toBe(0)
  expect(out).toMatch(/\d+\.\d+\.\d+/)
})

test("--version wins from anywhere in argv, even after a flag the double rejects", async () => {
  // Probed: `claude --bogus --version` prints the version and exits 0, so the
  // version answer is not reached through the argv guards. A later task that
  // installs the fake suite-wide gets a working --version whatever else it
  // happens to pass.
  const { out, code } = await runFake({ args: ["--bogus", "--version"] })
  expect(code).toBe(0)
  expect(out).toMatch(/\d+\.\d+\.\d+/)
})

test("a positional argument is refused as unemulatable, not as an unknown option", async () => {
  // `claude -p "prompt text"` is a real invocation, so reporting a positional
  // as an unknown option would be a lie about the real CLI. With stream-json
  // input the prompt arrives on stdin, so a positional means the caller is
  // confused about which mode it is driving.
  const { err, code } = await runFake({
    args: baseArgs(["--session-id", randomUUID()], ["write me a haiku"]),
  })
  expect(code).toBe(2)
  // The refusal has to name the token. Asserting only on the exit code would
  // pass against a parser that ignored the positional and then exited 2 for the
  // unrelated reason that no script is configured.
  expect(err).toContain("write me a haiku")
  expect(err).not.toContain("KANTAN_FAKE_SCRIPT")
  expect(err).not.toContain("unknown option")
})

test("claudeVersion() reads a version from the fake through KANTAN_CLAUDE_BIN", async () => {
  // The real proof of requirement 1: the production code path, not a bare
  // spawn. CLAUDE_BIN binds at module load, so the override needs a fresh
  // process (docs/HANDOFF.md).
  const dir = await workspace("version-seam")
  const probe = join(dir, "probe.ts")
  await writeFile(
    probe,
    `import { claudeVersion } from ${JSON.stringify(join(repoRoot, "src/version.ts"))}\n` +
      `try { process.stdout.write(await claudeVersion()) }\n` +
      `catch (e) { process.stderr.write((e as Error).message); process.exit(1) }\n`,
  )
  const p = Bun.spawn([process.execPath, "run", probe], {
    env: { ...process.env, KANTAN_CLAUDE_BIN: FAKE },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  if (code !== 0) throw new Error(`probe exited ${code}: ${err}`)
  expect(out).toMatch(/^\d+\.\d+\.\d+$/)
})

// ---------------------------------------------------------------------------
// The argv parser is a guard, so every branch of it is enumerated here.
//
// Unknown flags fail loudly because the real CLI fails loudly: probed,
// `claude -p --flibbertigibbet` prints "error: unknown option
// '--flibbertigibbet'" and exits 1.
//
// Each refusal test asserts the distinctive wording of its own message, never
// just a flag name, because the unknown-option hint line lists every flag the
// double knows: asserting "--verbose" alone would pass on the wrong refusal.
// ---------------------------------------------------------------------------

test("the flag set src/spawn.ts passes is accepted by the parser", async () => {
  // The positive control for every refusal test below. Without it they could
  // all pass against a parser that refuses everything. Replay is not
  // configured here, so the complaint must be about the missing script.
  const { err, code } = await runFake({ args: baseArgs(["--session-id", randomUUID()]) })
  expect(err).not.toContain("unknown option")
  expect(err).toContain("KANTAN_FAKE_SCRIPT")
  expect(code).toBe(2)
})

test("an unrecognised flag is refused, as the real CLI refuses it", async () => {
  const { err, code } = await runFake({
    args: baseArgs(["--session-id", randomUUID()], ["--flibbertigibbet"]),
  })
  expect(code).toBe(1)
  expect(err).toContain("unknown option '--flibbertigibbet'")
})

test("a misspelled flag is refused rather than ignored", async () => {
  // The case that decided the policy. Silently ignoring unknown flags would
  // let this invocation pass forever while production rejected it.
  const { err, code } = await runFake({
    args: ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--sesion-id", randomUUID()],
  })
  expect(code).toBe(1)
  expect(err).toContain("unknown option '--sesion-id'")
})

test("the refusal names the flags this double recognises", async () => {
  // A later task adding a flag has to teach the double about it. Listing the
  // recognised flags turns that from a puzzle into a one-line edit.
  const { err } = await runFake({
    args: baseArgs(["--session-id", randomUUID()], ["--sesion-id", randomUUID()]),
  })
  expect(err).toContain("--max-budget-usd")
  expect(err).toContain("--resume")
})

test("--flag=value binds the value, since the real CLI accepts that form", async () => {
  // Probed: `claude -p --input-format=stream-json --output-format=stream-json
  // --verbose` runs. Refusing the form would make the double stricter than
  // production. A mis-split would leave "=<uuid>" as the session id, so the
  // absence of the UUID complaint is what proves the value bound.
  const { err, code } = await runFake({
    args: [
      "-p",
      "--input-format=stream-json",
      "--output-format=stream-json",
      "--verbose",
      `--session-id=${randomUUID()}`,
      "--max-budget-usd=5",
    ],
  })
  expect(err).not.toContain("unknown option")
  expect(err).not.toContain("Invalid session ID")
  expect(err).not.toContain("--max-budget-usd")
  expect(code).toBe(2) // reached replay, which has no script configured
})

test("stream-json output without --verbose is refused, as the real CLI refuses it", async () => {
  // Probed: "Error: When using --print, --output-format=stream-json requires
  // --verbose", exit 1. A double that replayed anyway would let a later task
  // drop --verbose and keep passing, while production emitted nothing at all.
  const { err, code } = await runFake({
    args: [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--session-id",
      randomUUID(),
    ],
  })
  expect(code).toBe(1)
  expect(err).toContain("requires --verbose")
})

test("--session-id together with --resume is refused, as the real CLI refuses it", async () => {
  // Probed: "Error: --session-id can only be used with --continue or --resume
  // if --fork-session is also specified.", exit 1. This makes Task 8's "a
  // resumed phase never passes --session-id" true of the invocation itself,
  // not merely of the argv log.
  const { err, code } = await runFake({
    args: baseArgs(["--session-id", randomUUID(), "--resume", randomUUID()]),
  })
  expect(code).toBe(1)
  expect(err).toContain("can only be used with --continue or --resume")
})

test("a session id that is not a UUID is refused, as the real CLI refuses it", async () => {
  // Probed: "Error: Invalid session ID. Must be a valid UUID.", exit 1.
  // Without this a run id that is not a UUID passes every test and fails in
  // production.
  const { err, code } = await runFake({ args: baseArgs(["--session-id", "run-17"]) })
  expect(code).toBe(1)
  expect(err).toContain("Invalid session ID")
})

test("a non-positive or non-numeric --max-budget-usd is refused, as the real CLI refuses it", async () => {
  // Probed for every value below: "argument '<v>' is invalid.
  // --max-budget-usd must be a positive number greater than 0", exit 1. This
  // is what gives Task 14's "a ceiling already spent passes a positive floor,
  // never zero or negative" test teeth.
  for (const v of ["0", "-1", "abc", "0.0", "", " "]) {
    const { err, code } = await runFake({
      args: baseArgs(["--session-id", randomUUID()]).map((a) => (a === "5" ? v : a)),
    })
    expect({ v, code }).toEqual({ v, code: 1 })
    expect(err).toContain("must be a positive number greater than 0")
  }
})

test("a tiny positive --max-budget-usd is accepted, as the real CLI accepts it", async () => {
  // Probed: `--max-budget-usd 1e-9` runs. The guard is "greater than zero",
  // not "looks like a sensible amount": a run whose ceiling is nearly spent
  // legitimately passes a very small floor.
  const { err, code } = await runFake({
    args: baseArgs(["--session-id", randomUUID()]).map((a) => (a === "5" ? "1e-9" : a)),
  })
  expect(err).not.toContain("--max-budget-usd")
  expect(code).toBe(2)
})

test("an unrecognised --permission-mode is refused, as the real CLI refuses it", async () => {
  // Probed: exit 1, "Allowed choices are acceptEdits, auto, bypassPermissions,
  // manual, dontAsk, plan."
  const { err, code } = await runFake({
    args: baseArgs(["--session-id", randomUUID()]).map((a) =>
      a === "bypassPermissions" ? "wombat" : a,
    ),
  })
  expect(code).toBe(1)
  expect(err).toContain("Allowed choices are")
})

// ---------------------------------------------------------------------------
// Invocations the double cannot emulate exit 2, a code the real CLI returns
// for none of these, so "the double refused" is never read as a CLI result.
// ---------------------------------------------------------------------------

test("an invocation without -p is refused as unemulatable", async () => {
  const { err, code } = await runFake({
    args: ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
  })
  expect(code).toBe(2)
  expect(err).toContain("fake-claude")
  expect(err).toContain("-p")
})

test("an output format other than stream-json is refused as unemulatable", async () => {
  const { err, code } = await runFake({
    args: ["-p", "--input-format", "stream-json", "--output-format", "text", "--verbose"],
  })
  expect(code).toBe(2)
  expect(err).toContain("fake-claude")
  expect(err).toContain("stream-json")
})

// ---------------------------------------------------------------------------
// Replay: one scripted fixture per stdin turn.
// ---------------------------------------------------------------------------

test("replays one fixture per stdin turn, in script order", async () => {
  const dir = await workspace("replay-two-turns")
  const script = await writeScript(dir, [{ fixture: PLAN }, { fixture: QUESTION }])
  const { out, code } = await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("plan this") + userTurn("and now ask me something"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  expect(code).toBe(0)
  const rs = results(out)
  expect(rs.length).toBe(2)
  expect(String(rs[0]?.["result"])).toContain("I wrote the plan")
  expect(String(rs[1]?.["result"])).toContain("AskUserQuestion")
})

test("replays every line of the fixture, hook noise included", async () => {
  // Task 6 exists to filter the hook flood, so the double must emit it.
  const dir = await workspace("replay-all-lines")
  const script = await writeScript(dir, [{ fixture: PLAN }])
  const { out } = await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("plan this"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  const fixture = (await Bun.file(PLAN).text()).split("\n").filter((l) => l.trim() !== "")
  expect(events(out).length).toBe(fixture.length)
  expect(events(out).filter((e) => e["subtype"] === "hook_started").length).toBeGreaterThan(5)
  expect(events(out).some((e) => e["subtype"] === "thinking_tokens")).toBe(true)
})

test("the turn cursor advances across processes, not just within one", async () => {
  // The keystone. A run spawns the binary once per phase plus once per
  // escalation (design §3.1), and every spawn inherits the same environment, so
  // a test cannot swap KANTAN_FAKE_SCRIPT between them. A per-process cursor
  // would replay turn 1 to every process and silently defeat Tasks 13 and 14.
  const dir = await workspace("cursor-across-processes")
  const script = await writeScript(dir, [{ fixture: PLAN }, { fixture: QUESTION }])
  const first = await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("plan this"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  const second = await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("now implement"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  expect(String(results(first.out)[0]?.["result"])).toContain("I wrote the plan")
  expect(String(results(second.out)[0]?.["result"])).toContain("AskUserQuestion")
})

test("a fixture path is resolved relative to the script, and absolute paths pass through", async () => {
  const dir = await workspace("fixture-relative")
  const line = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "local fixture",
    total_cost_usd: 0.01,
    session_id: "11111111-1111-1111-1111-111111111111",
  })
  await writeFile(join(dir, "tiny.jsonl"), line + "\n")
  const script = await writeScript(dir, [{ fixture: "tiny.jsonl" }])
  const { out, code } = await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("hi"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  expect(code).toBe(0)
  expect(String(results(out)[0]?.["result"])).toBe("local fixture")
})

test("exits 0 at stdin EOF with turns still unspent", async () => {
  const dir = await workspace("eof-early")
  const script = await writeScript(dir, [{ fixture: PLAN }, { fixture: QUESTION }])
  const { out, code } = await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("just the one"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  expect(code).toBe(0)
  expect(results(out).length).toBe(1)
})

test("an unknown --effort value warns but still replays the turn", async () => {
  // Probed: the real CLI warns, ignores the value and carries on, so refusing
  // would make the double stricter than production.
  const dir = await workspace("effort-warning")
  const script = await writeScript(dir, [{ fixture: PLAN }])
  const { out, err, code } = await runFake({
    args: baseArgs(["--session-id", randomUUID()]).map((a) => (a === "medium" ? "hgih" : a)),
    stdin: userTurn("plan this"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  expect(code).toBe(0)
  expect(err).toContain("Unknown --effort value 'hgih'")
  expect(results(out).length).toBe(1)
})

// ---------------------------------------------------------------------------
// Requirement 2: session_id is rewritten to match the invocation.
//
// The fixtures carry their own captured ids. Replaying them verbatim would make
// a resume test an assertion about the fixture rather than about the code.
// ---------------------------------------------------------------------------

test("every event carries the --session-id from the invocation", async () => {
  const dir = await workspace("session-rewrite")
  const script = await writeScript(dir, [{ fixture: PLAN }])
  const sid = randomUUID()
  const { out } = await runFake({
    args: baseArgs(["--session-id", sid]),
    stdin: userTurn("plan this"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  const ids = new Set(events(out).map((e) => e["session_id"]))
  expect([...ids]).toEqual([sid])
})

test("the fixture's own captured session id never reaches stdout", async () => {
  const dir = await workspace("session-not-captured")
  const script = await writeScript(dir, [{ fixture: PLAN }])
  const captured = JSON.parse((await Bun.file(PLAN).text()).split("\n")[0] ?? "{}") as {
    session_id?: string
  }
  expect(typeof captured.session_id).toBe("string")
  const { out } = await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("plan this"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  // Without this the assertion would also hold for an empty stdout.
  expect(events(out).length).toBeGreaterThan(40)
  expect(out).not.toContain(String(captured.session_id))
})

test("a resumed process reports the session id it resumed", async () => {
  const dir = await workspace("session-resume")
  const script = await writeScript(dir, [{ fixture: PLAN }, { fixture: QUESTION }])
  const sid = randomUUID()
  await runFake({
    args: baseArgs(["--session-id", sid]),
    stdin: userTurn("plan this"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  const { out } = await runFake({
    args: baseArgs(["--resume", sid]),
    stdin: userTurn("more please"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  const ids = new Set(events(out).map((e) => e["session_id"]))
  expect([...ids]).toEqual([sid])
})

test("with neither session flag it invents an id, as the real CLI does", async () => {
  // Never the fixture's: falling back to the capture would fake session
  // continuity between two processes, which is what requirement 2 exists to
  // prevent. Two invocations must disagree.
  const dir = await workspace("session-invented")
  const script = await writeScript(dir, [{ fixture: PLAN }, { fixture: PLAN }])
  const a = await runFake({
    args: baseArgs([]),
    stdin: userTurn("plan this"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  const b = await runFake({
    args: baseArgs([]),
    stdin: userTurn("plan this"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  const idA = events(a.out)[0]?.["session_id"]
  const idB = events(b.out)[0]?.["session_id"]
  expect(String(idA)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  expect(idA).not.toBe(idB)
})

test("resuming a session no earlier process ran is refused, as the real CLI refuses it", async () => {
  // Probed: "No conversation found with session ID: <id>", exit 1. Without
  // this, Task 13 could resume an id that was never started and still pass,
  // while production failed on exactly that.
  const dir = await workspace("resume-unknown")
  const script = await writeScript(dir, [{ fixture: PLAN }])
  const { err, code } = await runFake({
    args: baseArgs(["--resume", randomUUID()]),
    stdin: userTurn("where were we"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  expect(code).toBe(1)
  expect(err).toContain("No conversation found with session ID")
})

test("a session that ran no turn is not resumable, as the real CLI has it", async () => {
  // Probed: --session-id with no turn, then --resume on that id, still gives
  // "No conversation found". A session becomes resumable by processing a turn,
  // not by being named.
  const dir = await workspace("resume-turnless")
  const script = await writeScript(dir, [{ fixture: PLAN }])
  const sid = randomUUID()
  const first = await runFake({
    args: baseArgs(["--session-id", sid]),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  expect(first.code).toBe(0)
  const { err, code } = await runFake({
    args: baseArgs(["--resume", sid]),
    stdin: userTurn("where were we"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  expect(code).toBe(1)
  expect(err).toContain("No conversation found with session ID")
})

// ---------------------------------------------------------------------------
// Stdin is the second guard. Every value the dimension takes is enumerated.
// ---------------------------------------------------------------------------

test("a blank stdin line is skipped without spending a turn", async () => {
  const dir = await workspace("stdin-blank")
  const script = await writeScript(dir, [{ fixture: PLAN }, { fixture: QUESTION }])
  const { out, code } = await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: "\n" + userTurn("plan this") + "\n",
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  expect(code).toBe(0)
  expect(results(out).length).toBe(1)
  expect(String(results(out)[0]?.["result"])).toContain("I wrote the plan")
})

test("a stdin line that is not JSON is refused, as the real CLI refuses it", async () => {
  // Probed: "Error parsing streaming input line (type=unknown, 15 chars):
  // SyntaxError", exit 1.
  const dir = await workspace("stdin-not-json")
  const script = await writeScript(dir, [{ fixture: PLAN }])
  const { err, code } = await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: "not json at all\n",
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  expect(code).toBe(1)
  expect(err).toContain("Error parsing streaming input line")
})

test("a stdin line that is JSON but not a user message is refused loudly", async () => {
  // A deliberate divergence, documented in the script's header. Probed: the
  // real CLI ignores such a line silently and then waits forever. Our spawner
  // writes only {"type":"user",...}, so this is an orchestrator bug, and the
  // real behaviour turns it into a production hang. Refusing catches it here.
  const dir = await workspace("stdin-not-user")
  const script = await writeScript(dir, [{ fixture: PLAN }])
  const { err, code } = await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: JSON.stringify({ type: "banana" }) + "\n",
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  expect(code).toBe(2)
  expect(err).toContain("fake-claude")
  expect(err).toContain("banana")
})

test("more stdin turns than the script has is refused loudly", async () => {
  // Silently ignoring the extra turn would leave the caller waiting for a
  // result that never comes, which reads as a stall rather than a bug.
  const dir = await workspace("stdin-overrun")
  const script = await writeScript(dir, [{ fixture: PLAN }])
  const { err, code } = await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("plan this") + userTurn("one too many"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  expect(code).toBe(2)
  expect(err).toContain("fake-claude")
  expect(err).toContain("turn")
})

// ---------------------------------------------------------------------------
// Requirement 3: record the argv and environment of every invocation.
//
// Tasks 8, 13 and 14 assert on --resume vs --session-id, on --model, on
// --effort changing between escalation steps, on --max-budget-usd being
// ceiling - spent, and on CLAUDE_CONFIG_DIR. Without this log they can only
// check outcomes, not the actual invocation.
// ---------------------------------------------------------------------------

/** The invocation log, one JSON record per line. */
async function readLog(path: string): Promise<Record<string, unknown>[]> {
  return (await Bun.file(path).text())
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

test("appends one record per spawn rather than overwriting", async () => {
  // One run spawns the binary several times, so an overwriting log would show
  // only the last phase.
  const dir = await workspace("log-appends")
  const script = await writeScript(dir, [{ fixture: PLAN }, { fixture: QUESTION }])
  const log = join(dir, "argv.jsonl")
  const sid = randomUUID()
  await runFake({
    args: baseArgs(["--session-id", sid]),
    stdin: userTurn("plan this"),
    env: { KANTAN_FAKE_SCRIPT: script, KANTAN_FAKE_ARGV_LOG: log },
  })
  await runFake({
    args: baseArgs(["--resume", sid], ["--effort", "high"]),
    stdin: userTurn("again, harder"),
    env: { KANTAN_FAKE_SCRIPT: script, KANTAN_FAKE_ARGV_LOG: log },
  })
  const spawns = (await readLog(log)).filter((r) => r["kind"] === "spawn")
  expect(spawns.length).toBe(2)
})

test("the log shows which session flag each spawn passed", async () => {
  // Task 8: a fresh phase passes --session-id, a resumed one passes --resume
  // and never both.
  const dir = await workspace("log-session-flags")
  const script = await writeScript(dir, [{ fixture: PLAN }, { fixture: QUESTION }])
  const log = join(dir, "argv.jsonl")
  const sid = randomUUID()
  await runFake({
    args: baseArgs(["--session-id", sid]),
    stdin: userTurn("plan this"),
    env: { KANTAN_FAKE_SCRIPT: script, KANTAN_FAKE_ARGV_LOG: log },
  })
  await runFake({
    args: baseArgs(["--resume", sid]),
    stdin: userTurn("carry on"),
    env: { KANTAN_FAKE_SCRIPT: script, KANTAN_FAKE_ARGV_LOG: log },
  })
  const [first, second] = (await readLog(log)).filter((r) => r["kind"] === "spawn")
  expect(first?.["argv"]).toContain("--session-id")
  expect(second?.["argv"]).toContain("--resume")
  expect(second?.["argv"]).not.toContain("--session-id")
})

test("the log carries the model, effort and budget each spawn asked for", async () => {
  // Task 13 asserts effort escalated; Task 14 asserts the budget was
  // ceiling - spent. Both read the value out of this record.
  const dir = await workspace("log-flag-values")
  const script = await writeScript(dir, [{ fixture: PLAN }])
  const log = join(dir, "argv.jsonl")
  await runFake({
    args: baseArgs(["--session-id", randomUUID()]).map((a) => (a === "5" ? "4.75" : a)),
    stdin: userTurn("plan this"),
    env: { KANTAN_FAKE_SCRIPT: script, KANTAN_FAKE_ARGV_LOG: log },
  })
  const argv = (await readLog(log))[0]?.["argv"] as string[]
  expect(argv[argv.indexOf("--model") + 1]).toBe("claude-sonnet-5-5")
  expect(argv[argv.indexOf("--effort") + 1]).toBe("medium")
  expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("4.75")
})

test("the log records CLAUDE_CONFIG_DIR, which selects the account", async () => {
  const dir = await workspace("log-config-dir")
  const script = await writeScript(dir, [{ fixture: PLAN }])
  const log = join(dir, "argv.jsonl")
  await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("plan this"),
    env: { KANTAN_FAKE_SCRIPT: script, KANTAN_FAKE_ARGV_LOG: log, CLAUDE_CONFIG_DIR: "/tmp/acct-b" },
  })
  const env = (await readLog(log))[0]?.["env"] as Record<string, string>
  expect(env["CLAUDE_CONFIG_DIR"]).toBe("/tmp/acct-b")
})

test("an unset CLAUDE_CONFIG_DIR is absent from the record, not blank", async () => {
  // Task 8 asserts it is set only when the project names one, which is an
  // assertion about absence. For that to mean anything, absence in the record
  // has to mean absence in the environment.
  const dir = await workspace("log-config-dir-absent")
  const script = await writeScript(dir, [{ fixture: PLAN }])
  const log = join(dir, "argv.jsonl")
  await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("plan this"),
    env: { KANTAN_FAKE_SCRIPT: script, KANTAN_FAKE_ARGV_LOG: log, CLAUDE_CONFIG_DIR: undefined },
  })
  const record = (await readLog(log))[0]
  const env = record?.["env"] as Record<string, string>
  expect("CLAUDE_CONFIG_DIR" in env).toBe(false)
  // ...and the record still proves the variable was looked for, by listing the
  // names it saw. Otherwise an absent record would be indistinguishable from a
  // double that logs no environment at all.
  expect(record?.["envKeys"]).toBeArray()
  expect(record?.["envKeys"]).toContain("KANTAN_FAKE_SCRIPT")
})

test("an unrelated variable is recorded by name but not by value", async () => {
  // The log is a file on disk in an open-source repo, and the environment of a
  // developer running this suite holds credentials. Names keep absence
  // assertions honest without copying secrets into the tree.
  const dir = await workspace("log-env-redaction")
  const script = await writeScript(dir, [{ fixture: PLAN }])
  const log = join(dir, "argv.jsonl")
  await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("plan this"),
    env: { KANTAN_FAKE_SCRIPT: script, KANTAN_FAKE_ARGV_LOG: log, ANTHROPIC_API_KEY: "sk-ant-secret" },
  })
  const record = (await readLog(log))[0]
  expect(record?.["envKeys"]).toContain("ANTHROPIC_API_KEY")
  expect(JSON.stringify(record)).not.toContain("sk-ant-secret")
})

test("the log records the working directory the binary ran in", async () => {
  const dir = await workspace("log-cwd")
  const script = await writeScript(dir, [{ fixture: PLAN }])
  const log = join(dir, "argv.jsonl")
  await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("plan this"),
    env: { KANTAN_FAKE_SCRIPT: script, KANTAN_FAKE_ARGV_LOG: log },
  })
  expect((await readLog(log))[0]?.["cwd"]).toBe(process.cwd())
})

test("the log records each turn's stdin line and the session it ran under", async () => {
  // Task 13's "the implement prompt carries the plan file path" has nowhere
  // else to look: the prompt reaches the binary on stdin, not in argv.
  const dir = await workspace("log-turns")
  const script = await writeScript(dir, [{ fixture: PLAN }, { fixture: QUESTION }])
  const log = join(dir, "argv.jsonl")
  const sid = randomUUID()
  await runFake({
    args: baseArgs(["--session-id", sid]),
    stdin: userTurn("read docs/plans/2026-10-11-t1-slugger.md") + userTurn("second turn"),
    env: { KANTAN_FAKE_SCRIPT: script, KANTAN_FAKE_ARGV_LOG: log },
  })
  const turnRecords = (await readLog(log)).filter((r) => r["kind"] === "turn")
  expect(turnRecords.length).toBe(2)
  expect(String(turnRecords[0]?.["stdin"])).toContain("docs/plans/2026-10-11-t1-slugger.md")
  expect(turnRecords[0]?.["session"]).toBe(sid)
  expect(turnRecords[0]?.["fixture"]).toBe(PLAN)
})

test("a refused invocation is logged too, so the argv that failed is visible", async () => {
  const dir = await workspace("log-refusal")
  const log = join(dir, "argv.jsonl")
  const { code } = await runFake({
    args: ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--nope"],
    env: { KANTAN_FAKE_ARGV_LOG: log },
  })
  expect(code).toBe(1)
  expect((await readLog(log))[0]?.["argv"]).toContain("--nope")
})

test("no log is written when KANTAN_FAKE_ARGV_LOG is unset", async () => {
  const dir = await workspace("log-absent")
  const script = await writeScript(dir, [{ fixture: PLAN }])
  const { code, out } = await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("plan this"),
    env: { KANTAN_FAKE_SCRIPT: script, KANTAN_FAKE_ARGV_LOG: undefined },
  })
  expect(code).toBe(0)
  expect(results(out).length).toBe(1)
})

// ---------------------------------------------------------------------------
// Requirement 4: the cost in the result event can be overridden.
//
// Task 14 tests that the server sums the last result of each process. If every
// process reported the fixture's cost, the test could not tell a correct sum
// from several wrong ones.
// ---------------------------------------------------------------------------

test("a turn's cost override replaces total_cost_usd in the result", async () => {
  const dir = await workspace("cost-override")
  const script = await writeScript(dir, [{ fixture: PLAN, cost: 0.25 }])
  const { out } = await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("plan this"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  expect(results(out)[0]?.["total_cost_usd"]).toBe(0.25)
})

test("without an override a turn reports the capture's own cost", async () => {
  const dir = await workspace("cost-fixture")
  const script = await writeScript(dir, [{ fixture: PLAN }])
  const { out } = await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("plan this"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  expect(results(out)[0]?.["total_cost_usd"]).toBe(0.18015684999999998)
})

test("within one process total_cost_usd accumulates across turns", async () => {
  // Design §3.4, probed: "Within a single process it does accumulate." If the
  // double replayed each fixture's own figure instead, Task 14's test would be
  // inverted: summing every result would give the real CLI's answer and taking
  // the last result of the process would look wrong.
  const dir = await workspace("cost-accumulates")
  const script = await writeScript(dir, [
    { fixture: PLAN, cost: 0.1 },
    { fixture: QUESTION, cost: 0.02 },
  ])
  const { out } = await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("plan this") + userTurn("and again"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  const rs = results(out)
  expect(rs[0]?.["total_cost_usd"]).toBe(0.1)
  expect(rs[1]?.["total_cost_usd"]).toBeCloseTo(0.12, 10)
})

test("a new process starts its cost total over, as the real CLI does", async () => {
  // Probed, design §3.4: --max-budget-usd bounds one process and a resumed
  // process reports only its own spend. This is what makes "sum the last
  // result of each process" the correct reduction and testable.
  const dir = await workspace("cost-resets")
  const script = await writeScript(dir, [
    { fixture: PLAN, cost: 0.1 },
    { fixture: QUESTION, cost: 0.02 },
  ])
  const sid = randomUUID()
  const first = await runFake({
    args: baseArgs(["--session-id", sid]),
    stdin: userTurn("plan this"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  const second = await runFake({
    args: baseArgs(["--resume", sid]),
    stdin: userTurn("and again"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  expect(results(first.out)[0]?.["total_cost_usd"]).toBe(0.1)
  expect(results(second.out)[0]?.["total_cost_usd"]).toBe(0.02)
})

test("a cost override on a fixture with no result line is refused", async () => {
  // Otherwise the override silently does nothing and Task 14's budget test
  // quietly asserts against the capture.
  const dir = await workspace("cost-no-result")
  await writeFile(
    join(dir, "no-result.jsonl"),
    JSON.stringify({
      type: "assistant",
      session_id: "11111111-1111-1111-1111-111111111111",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    }) + "\n",
  )
  const script = await writeScript(dir, [{ fixture: "no-result.jsonl", cost: 0.25 }])
  const { err, code } = await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("hi"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  expect(code).toBe(2)
  expect(err).toContain("cost")
})

test("a misspelled key in the script is refused, not ignored", async () => {
  // src/projects.ts's lesson, which docs/HANDOFF.md records: a misspelled
  // *optional* key reads as absent. {"costs": 0.25} would replay the fixture's
  // own cost and look like a correct run.
  const dir = await workspace("script-typo")
  const script = await writeScript(dir, [{ fixture: PLAN, costs: 0.25 }])
  const { err, code } = await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("plan this"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  expect(code).toBe(2)
  expect(err).toContain("costs")
})

// ---------------------------------------------------------------------------
// Requirement 6: exit non-zero when the replayed turn is an error result.
// ---------------------------------------------------------------------------

test("exits 1 when the turn's fixture is an error result", async () => {
  const dir = await workspace("error-exit")
  const script = await writeScript(dir, [{ fixture: BUDGET }])
  const { out, code } = await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("write an essay"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  expect(code).toBe(1)
  expect(results(out)[0]?.["subtype"]).toBe("error_max_budget_usd")
  expect(results(out)[0]?.["is_error"]).toBe(true)
})

test("the error result arrives whole, not truncated by the exit", async () => {
  // budget-exhausted.jsonl is 52KB, close enough to a pipe buffer that exiting
  // without flushing can cut the final result line in half. A truncated last
  // line would make Task 6's "a malformed line is reported, not thrown" test
  // pass for the wrong reason.
  const dir = await workspace("error-flush")
  const script = await writeScript(dir, [{ fixture: BUDGET }])
  const { out } = await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("write an essay"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  const lines = out.split("\n").filter((l) => l.trim() !== "")
  const fixtureLines = (await Bun.file(BUDGET).text()).split("\n").filter((l) => l.trim() !== "")
  expect(lines.length).toBe(fixtureLines.length)
  expect(() => JSON.parse(lines.at(-1) ?? "")).not.toThrow()
})

test("an error result stops the process from serving a further turn", async () => {
  // The real CLI exits on budget exhaustion, so a queued turn is never
  // answered. A double that carried on would hide a phase machine that kept
  // pushing turns at a dead process.
  const dir = await workspace("error-terminal")
  const script = await writeScript(dir, [{ fixture: BUDGET }, { fixture: QUESTION }])
  const log = join(dir, "argv.jsonl")
  const { out, code } = await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("write an essay") + userTurn("are you still there"),
    env: { KANTAN_FAKE_SCRIPT: script, KANTAN_FAKE_ARGV_LOG: log },
  })
  expect(code).toBe(1)
  expect(results(out).length).toBe(1)
  expect((await readLog(log)).filter((r) => r["kind"] === "turn").length).toBe(1)

  // ...and exactly one turn was spent, so the next process gets turn 2.
  const next = await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("fresh process"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  expect(String(results(next.out)[0]?.["subtype"])).toBe("success")
})

test("a result line whose shape the double cannot read is refused loudly", async () => {
  // The exit code keys on is_error and the budget arithmetic on
  // total_cost_usd. A recapture that renamed or dropped either must not
  // quietly become a successful, free turn. The matrix covers every way the
  // two fields can go wrong, since a recapture changes them together.
  const dir = await workspace("result-shape")
  const sid = "11111111-1111-1111-1111-111111111111"
  const cases: { name: string; result: Record<string, unknown>; expect: string }[] = [
    {
      name: "no-is-error",
      result: { type: "result", subtype: "success", total_cost_usd: 0.01, session_id: sid },
      expect: "is_error",
    },
    {
      name: "is-error-not-boolean",
      result: { type: "result", subtype: "success", is_error: "no", total_cost_usd: 0.01, session_id: sid },
      expect: "is_error",
    },
    {
      name: "no-cost",
      result: { type: "result", subtype: "success", is_error: false, session_id: sid },
      expect: "total_cost_usd",
    },
    {
      name: "error-subtype-claiming-success",
      result: { type: "result", subtype: "error_max_budget_usd", is_error: false, total_cost_usd: 0.01, session_id: sid },
      expect: "is_error",
    },
  ]
  for (const c of cases) {
    const fixture = join(dir, `${c.name}.jsonl`)
    await writeFile(fixture, JSON.stringify(c.result) + "\n")
    const script = await writeScript(dir, [{ fixture }])
    await rm(`${script}.cursor`, { force: true })
    const { err, code } = await runFake({
      args: baseArgs(["--session-id", randomUUID()]),
      stdin: userTurn("hi"),
      env: { KANTAN_FAKE_SCRIPT: script },
    })
    expect({ case: c.name, code }).toEqual({ case: c.name, code: 2 })
    expect(err).toContain(c.expect)
  }
})

// ---------------------------------------------------------------------------
// Requirement 7: none of the real binary's SessionEnd stderr noise.
// ---------------------------------------------------------------------------

test("writes nothing to stderr on a successful turn", async () => {
  // The real binary prints "SessionEnd hook [...] failed: Hook cancelled"
  // whenever stdin closes promptly (probed, design §5). Reproducing it here
  // would make every stderr assertion in the suite about the CLI's noise
  // instead of about the orchestrator.
  const dir = await workspace("stderr-clean")
  const script = await writeScript(dir, [{ fixture: PLAN }])
  const { err } = await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("plan this"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  expect(err).toBe("")
})

test("replays the capture's own bytes, changing only the session id", async () => {
  // Task 7 appends the raw stream to the run log and Task 6 parses it, so any
  // reformatting here would be a difference between the test and production.
  const dir = await workspace("byte-fidelity")
  const script = await writeScript(dir, [{ fixture: QUESTION }])
  const sid = randomUUID()
  const { out } = await runFake({
    args: baseArgs(["--session-id", sid]),
    stdin: userTurn("ask me something"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  const fixture = await Bun.file(QUESTION).text()
  const captured = (JSON.parse(fixture.split("\n")[0] ?? "{}") as { session_id?: string }).session_id
  expect(out).toBe(fixture.replaceAll(String(captured), sid))
})

test("a negative cost override is refused", async () => {
  // No result the real CLI emits reports a negative spend, so a negative
  // override is a harness slip, and it would make a budget total shrink.
  const dir = await workspace("cost-negative")
  const script = await writeScript(dir, [{ fixture: PLAN, cost: -0.5 }])
  const { err, code } = await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("plan this"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  expect(code).toBe(2)
  expect(err).toContain("cost")
})

test("an ambiguous total_cost_usd is refused rather than guessed at", async () => {
  // Today's captures carry the field once per line, with per-model figures
  // under costUSD. If a recapture nests a second total_cost_usd, rewriting the
  // first match would be a coin flip, and the loser is a wrong budget total in
  // a passing test.
  const dir = await workspace("cost-ambiguous")
  const fixture = join(dir, "nested.jsonl")
  await writeFile(
    fixture,
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0.01,
      modelUsage: { "claude-sonnet-5-5": { total_cost_usd: 0.004 } },
      session_id: "11111111-1111-1111-1111-111111111111",
    }) + "\n",
  )
  const script = await writeScript(dir, [{ fixture, cost: 0.25 }])
  const { err, code } = await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("hi"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  expect(code).toBe(2)
  expect(err).toContain("total_cost_usd")
})

test("a credential-shaped CLAUDE_ variable is recorded by name but not by value", async () => {
  // The prefix allowlist admits CLAUDE_*, and a real Claude Code environment
  // carries CLAUDE_CODE_MESSAGING_TOKEN, so the allowlist alone would log the
  // very thing it was written to keep out of the tree.
  const dir = await workspace("log-env-token")
  const script = await writeScript(dir, [{ fixture: PLAN }])
  const log = join(dir, "argv.jsonl")
  await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("plan this"),
    env: {
      KANTAN_FAKE_SCRIPT: script,
      KANTAN_FAKE_ARGV_LOG: log,
      CLAUDE_CODE_MESSAGING_TOKEN: "tok-do-not-log",
      CLAUDE_CONFIG_DIR: "/tmp/acct-b",
    },
  })
  const record = (await readLog(log))[0]
  const env = record?.["env"] as Record<string, string>
  expect(record?.["envKeys"]).toContain("CLAUDE_CODE_MESSAGING_TOKEN")
  expect(JSON.stringify(record)).not.toContain("tok-do-not-log")
  // ...while the variable the orchestrator actually sets is still readable.
  expect(env["CLAUDE_CONFIG_DIR"]).toBe("/tmp/acct-b")
})

test("a corrupt cursor file is refused loudly rather than crashing", async () => {
  const dir = await workspace("cursor-corrupt")
  const script = await writeScript(dir, [{ fixture: PLAN }])
  await writeFile(`${script}.cursor`, "{not json")
  const { err, code } = await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("plan this"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  expect(code).toBe(2)
  expect(err).toContain("cursor")
})

// ---------------------------------------------------------------------------
// Requirement 5: output can be emitted at arbitrary chunk boundaries.
//
// Task 6 tests that the parser reassembles a JSON line split across reads. A
// double that always wrote whole lines could not exercise that.
// ---------------------------------------------------------------------------

/** Spawns the fake and returns stdout as the sequence of reads it produced. */
async function runFakeReads(opts: {
  args: string[]
  stdin?: string
  env?: Record<string, string | undefined>
}): Promise<{ chunks: Uint8Array[]; code: number }> {
  const p = Bun.spawn([FAKE, ...opts.args], {
    stdin: new TextEncoder().encode(opts.stdin ?? ""),
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv(opts.env),
  })
  const chunks: Uint8Array[] = []
  for await (const chunk of p.stdout) chunks.push(chunk as Uint8Array)
  return { chunks, code: await p.exited }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const all = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.length
  }
  return all
}

/** A one-line fixture carrying a multi-byte character at a known offset. */
async function sparkleFixture(dir: string): Promise<{ path: string; line: string }> {
  const line = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done ✨ sparkle",
    total_cost_usd: 0.01,
    session_id: "11111111-1111-1111-1111-111111111111",
  })
  const path = join(dir, "sparkle.jsonl")
  await writeFile(path, line + "\n")
  return { path, line }
}

test("KANTAN_FAKE_CHUNK splits a JSON line across reads", async () => {
  // Deliberately a one-line fixture: replaying a 93KB capture produces reads
  // that end mid-line anyway, because the OS splits a write larger than the
  // pipe buffer. This test would then pass with the knob unimplemented.
  const dir = await workspace("chunk-splits-line")
  const { path } = await sparkleFixture(dir)
  const script = await writeScript(dir, [{ fixture: path }])
  const { chunks } = await runFakeReads({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("hi"),
    env: { KANTAN_FAKE_SCRIPT: script, KANTAN_FAKE_CHUNK: "10", KANTAN_FAKE_CHUNK_DELAY_MS: "5" },
  })
  expect(chunks.length).toBeGreaterThan(1)
  // At least one read ends somewhere other than a line boundary, which is the
  // condition Task 6's reassembly test needs to be meaningful.
  expect(chunks.some((c) => c.at(-1) !== 0x0a)).toBe(true)
})

test("a chunk boundary can fall inside a multi-byte character", async () => {
  // The captured fixtures are pure ASCII, because Task 4's redaction pass
  // re-serialised them with ensure_ascii. No boundary inside them can ever
  // split a code point, so a parser that decoded each read on its own would
  // pass against them and corrupt real CLI output. This fixture makes that
  // boundary reachable.
  const dir = await workspace("chunk-splits-codepoint")
  const { path, line } = await sparkleFixture(dir)
  const script = await writeScript(dir, [{ fixture: path }])
  const sid = randomUUID()
  const expected = new TextEncoder().encode(
    line.replaceAll("11111111-1111-1111-1111-111111111111", sid) + "\n",
  )
  const lead = expected.indexOf(0xe2) // the first byte of "✨"
  expect(lead).toBeGreaterThan(0)

  const { chunks } = await runFakeReads({
    args: baseArgs(["--session-id", sid]),
    stdin: userTurn("hi"),
    env: {
      KANTAN_FAKE_SCRIPT: script,
      KANTAN_FAKE_CHUNK: String(lead + 1),
      // Generous on purpose: the assertion below is about where the boundary
      // falls, and a short gap on a loaded machine lets two writes arrive as
      // one read. If this ever flakes, raise the delay rather than weakening
      // the assertion.
      KANTAN_FAKE_CHUNK_DELAY_MS: "40",
    },
  })

  const first = chunks[0]
  expect(first?.length).toBe(lead + 1)
  expect(first?.at(-1)).toBe(0xe2)
  // Decoded on its own, the read is already corrupt...
  expect(new TextDecoder().decode(first)).toContain("�")
  // ...while the reassembled stream is byte-exact.
  expect(new TextDecoder().decode(concat(chunks))).toBe(new TextDecoder().decode(expected))
})

test("without KANTAN_FAKE_CHUNK the output arrives as whole lines", async () => {
  const dir = await workspace("chunk-default")
  const { path, line } = await sparkleFixture(dir)
  const script = await writeScript(dir, [{ fixture: path }])
  const sid = randomUUID()
  const { chunks } = await runFakeReads({
    args: baseArgs(["--session-id", sid]),
    stdin: userTurn("hi"),
    env: { KANTAN_FAKE_SCRIPT: script, KANTAN_FAKE_CHUNK: undefined },
  })
  expect(chunks.every((c) => c.at(-1) === 0x0a)).toBe(true)
  expect(new TextDecoder().decode(concat(chunks))).toBe(
    line.replaceAll("11111111-1111-1111-1111-111111111111", sid) + "\n",
  )
})

test("a chunking knob that is not a positive integer is refused", async () => {
  // Silently falling back to whole lines would make Task 6's reassembly test
  // pass without ever seeing a split line, which is the fiction this knob
  // exists to prevent.
  const dir = await workspace("chunk-bad-knob")
  const script = await writeScript(dir, [{ fixture: PLAN }])
  for (const env of [
    { KANTAN_FAKE_CHUNK: "0" },
    { KANTAN_FAKE_CHUNK: "-5" },
    { KANTAN_FAKE_CHUNK: "lots" },
    { KANTAN_FAKE_CHUNK: "1.5" },
    { KANTAN_FAKE_CHUNK: "10", KANTAN_FAKE_CHUNK_DELAY_MS: "soon" },
  ]) {
    await rm(`${script}.cursor`, { force: true })
    const { err, code } = await runFake({
      args: baseArgs(["--session-id", randomUUID()]),
      stdin: userTurn("plan this"),
      env: { KANTAN_FAKE_SCRIPT: script, ...env },
    })
    expect({ env, code }).toEqual({ env, code: 2 })
    expect(err).toContain("KANTAN_FAKE_CHUNK")
  }
})

// ---------------------------------------------------------------------------
// Harness misconfiguration. Every one of these exits 2 and names the file, so a
// broken script is never mistaken for a CLI result.
// ---------------------------------------------------------------------------

test("a script path that does not exist is refused", async () => {
  const dir = await workspace("script-missing")
  const { err, code } = await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("hi"),
    env: { KANTAN_FAKE_SCRIPT: join(dir, "nope.json") },
  })
  expect(code).toBe(2)
  expect(err).toContain("nope.json")
})

test("a script that is not valid JSON is refused", async () => {
  const dir = await workspace("script-not-json")
  const script = join(dir, "script.json")
  await writeFile(script, "{turns: [}")
  const { err, code } = await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("hi"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  expect(code).toBe(2)
  expect(err).toContain("not valid JSON")
})

test("a script with an unknown top-level key is refused", async () => {
  const dir = await workspace("script-unknown-key")
  const script = await writeScript(dir, [{ fixture: PLAN }], { turn: [] })
  const { err, code } = await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("hi"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  expect(code).toBe(2)
  expect(err).toContain("unknown key 'turn'")
})

test("a script whose turns are not an array is refused", async () => {
  const dir = await workspace("script-turns-shape")
  const script = join(dir, "script.json")
  await writeFile(script, JSON.stringify({ turns: { first: PLAN } }))
  const { err, code } = await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("hi"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  expect(code).toBe(2)
  expect(err).toContain("turns")
})

test("a turn with no fixture is refused", async () => {
  const dir = await workspace("turn-no-fixture")
  const script = await writeScript(dir, [{ cost: 0.1 }])
  const { err, code } = await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("hi"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  expect(code).toBe(2)
  expect(err).toContain("fixture")
})

test("a fixture file that does not exist is refused", async () => {
  const dir = await workspace("fixture-missing")
  const script = await writeScript(dir, [{ fixture: "ghost.jsonl" }])
  const { err, code } = await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("hi"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  expect(code).toBe(2)
  expect(err).toContain("ghost.jsonl")
})

test("a fixture line carrying no session_id is refused rather than passed through", async () => {
  // With no captured id to substitute, a nested copy of the real session id
  // could survive into the output, and a continuity assertion would then be
  // about the fixture rather than about the code.
  const dir = await workspace("fixture-no-session")
  const fixture = join(dir, "no-session.jsonl")
  await writeFile(fixture, JSON.stringify({ type: "system", subtype: "init" }) + "\n")
  const script = await writeScript(dir, [{ fixture }])
  const { err, code } = await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("hi"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  expect(code).toBe(2)
  expect(err).toContain("session_id")
})

test("a fixture line that is not JSON is refused", async () => {
  const dir = await workspace("fixture-not-json")
  const fixture = join(dir, "broken.jsonl")
  await writeFile(fixture, '{"type":"system","session_id":"x"\n')
  const script = await writeScript(dir, [{ fixture }])
  const { err, code } = await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("hi"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  expect(code).toBe(2)
  expect(err).toContain("line 1")
})

// ---------------------------------------------------------------------------
// The half-duplex pattern Tasks 8 and 13 will actually use: stdin stays open,
// a turn goes in, its result comes back, the next turn follows.
//
// Every other test here hands stdin over as one closed buffer, which would
// hide a double that only replayed after EOF. That failure would surface in
// Task 8 as a hang, and the spawner would get the blame.
// ---------------------------------------------------------------------------

test("serves each turn while stdin is still open", async () => {
  const dir = await workspace("stdin-half-duplex")
  const script = await writeScript(dir, [{ fixture: PLAN }, { fixture: QUESTION }])
  const p = Bun.spawn([FAKE, ...baseArgs(["--session-id", randomUUID()])], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv({ KANTAN_FAKE_SCRIPT: script }),
  })

  const reader = p.stdout.getReader()
  const decoder = new TextDecoder()
  let pending = ""

  /** Reads until a result event completes, leaving stdin open throughout. */
  async function nextResult(): Promise<Record<string, unknown>> {
    for (;;) {
      for (const line of pending.split("\n")) {
        if (line.trim() === "" || !line.endsWith("}")) continue
        const event = JSON.parse(line) as Record<string, unknown>
        if (event["type"] === "result") {
          pending = ""
          return event
        }
      }
      const { value, done } = await reader.read()
      if (done) throw new Error("stdout closed before a result arrived")
      pending += decoder.decode(value, { stream: true })
    }
  }

  p.stdin.write(userTurn("plan this"))
  p.stdin.flush()
  expect(String((await nextResult())["result"])).toContain("I wrote the plan")

  p.stdin.write(userTurn("now ask me something"))
  p.stdin.flush()
  expect(String((await nextResult())["result"])).toContain("AskUserQuestion")

  p.stdin.end()
  expect(await p.exited).toBe(0)
}, 15000)

// ---------------------------------------------------------------------------
// --allowedTools, which the permissions task in the plan says Task 8 will pass
// "when the mode is acceptEdits".
// ---------------------------------------------------------------------------

test("--allowedTools is accepted, in both spellings the real CLI offers", async () => {
  const dir = await workspace("allowed-tools")
  const script = await writeScript(dir, [{ fixture: PLAN }, { fixture: PLAN }])
  const log = join(dir, "argv.jsonl")
  for (const flag of ["--allowedTools", "--allowed-tools"]) {
    const { err, code } = await runFake({
      args: baseArgs(["--session-id", randomUUID()], [flag, "Edit Write Bash(git *)"]),
      stdin: userTurn("plan this"),
      env: { KANTAN_FAKE_SCRIPT: script, KANTAN_FAKE_ARGV_LOG: log },
    })
    expect({ flag, code, err }).toEqual({ flag, code: 0, err: "" })
  }
  const first = (await readLog(log))[0]?.["argv"] as string[]
  expect(first[first.indexOf("--allowedTools") + 1]).toBe("Edit Write Bash(git *)")
})

test("--allowedTools spread over several tokens is refused, naming the token", async () => {
  // The real CLI declares it variadic (<tools...>) as well as accepting one
  // comma or space separated value. The double takes one value, so the
  // variadic form stops here with the stray token named rather than being
  // silently dropped from the allowlist, which would be a permissions change
  // nobody asked for.
  const dir = await workspace("allowed-tools-variadic")
  const script = await writeScript(dir, [{ fixture: PLAN }])
  const { err, code } = await runFake({
    args: baseArgs(["--session-id", randomUUID()], ["--allowedTools", "Edit", "Write"]),
    stdin: userTurn("plan this"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  expect(code).toBe(2)
  expect(err).toContain("Write")
})

test("a fixture with two result events is refused, override or not", async () => {
  // test/fixtures/README.md notes that result_index and queued_turn_count
  // imply a process can emit more than one result. Within one process those
  // figures are cumulative, so adding them up double-counts, which is the
  // exact error docs/HANDOFF.md warns about for the real arithmetic. The
  // double's model is one turn, one result: anything else stops here instead
  // of quietly inflating the running total.
  const dir = await workspace("two-results")
  const fixture = join(dir, "two-results.jsonl")
  const result = (cost: number) =>
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: cost,
      session_id: "11111111-1111-1111-1111-111111111111",
    })
  await writeFile(fixture, `${result(0.01)}\n${result(0.03)}\n`)
  const script = await writeScript(dir, [{ fixture }])
  const { err, code } = await runFake({
    args: baseArgs(["--session-id", randomUUID()]),
    stdin: userTurn("hi"),
    env: { KANTAN_FAKE_SCRIPT: script },
  })
  expect(code).toBe(2)
  expect(err).toContain("result")
})
