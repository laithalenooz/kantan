import { expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"

const repoRoot = join(import.meta.dir, "..")
const FAKE = join(import.meta.dir, "fake-claude.ts")

/** A scratch directory per test, so no script, cursor or log is shared. */
async function workspace(name: string): Promise<string> {
  const dir = join(repoRoot, ".orch-test", "fake-claude", name)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  return dir
}

type Run = { out: string; err: string; code: number }

/** Spawns the fake by bare path, the way a spawner holding ORCH_CLAUDE_BIN does. */
async function runFake(opts: {
  args: string[]
  stdin?: string
  env?: Record<string, string | undefined>
}): Promise<Run> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries({ ...process.env, ...opts.env })) {
    if (v !== undefined) env[k] = v
  }
  const p = Bun.spawn([FAKE, ...opts.args], {
    stdin: new TextEncoder().encode(opts.stdin ?? ""),
    stdout: "pipe",
    stderr: "pipe",
    env,
  })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  return { out, err, code }
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
// version. If a later task points ORCH_CLAUDE_BIN at this fake suite-wide,
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

test("claudeVersion() reads a version from the fake through ORCH_CLAUDE_BIN", async () => {
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
    env: { ...process.env, ORCH_CLAUDE_BIN: FAKE },
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
  expect(err).toContain("ORCH_FAKE_SCRIPT")
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
