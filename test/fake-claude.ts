#!/usr/bin/env bun
/**
 * A test double for `claude -p --input-format stream-json --output-format stream-json`.
 *
 * It replays the captured fixtures in `test/fixtures/` so the spawner, the
 * phase machine, the stall detector and the budget arithmetic can be tested at
 * zero API cost. Tasks 8 through 14 are tested against this file, which means
 * **if it diverges from the real CLI, those tasks pass against a fiction.**
 * Faithfulness, not convenience, is the design goal.
 *
 * Test infrastructure: nothing in `src/` may import it.
 *
 * ## Invocation
 *
 *   ORCH_FAKE_SCRIPT=<path>  a JSON file: { "turns": [{ "fixture": "...", "cost": 0.01 }] }
 *                            `fixture` resolves relative to the script's own directory.
 *                            `cost` overrides that turn's own spend in the result event.
 *   ORCH_FAKE_ARGV_LOG=<path>  append-only JSONL of every invocation and every turn.
 *   ORCH_FAKE_CHUNK=<bytes>    split stdout writes at this many bytes. Default: whole lines.
 *   ORCH_FAKE_CHUNK_DELAY_MS   milliseconds between chunked writes. Default: 1, so the
 *                              reader sees separate reads rather than one coalesced buffer.
 *
 * The turn list is consumed **across processes**, through a cursor file beside
 * the script, because a run spawns the binary once per phase plus once per
 * escalation and every spawn inherits the same environment. A per-process
 * cursor would replay turn 1 to every process.
 *
 * ## Behaviour probed against the real CLI 2.1.296, not guessed
 *
 * | Invocation | Real CLI | Here |
 * |---|---|---|
 * | `--version` | `2.1.296 (Claude Code)`, exit 0, other flags ignored | same |
 * | unknown flag | `error: unknown option '--x'`, exit 1 | same, plus a line naming the recognised flags |
 * | `--flag=value` | accepted | accepted |
 * | stream-json output without `--verbose` | `Error: When using --print, --output-format=stream-json requires --verbose`, exit 1 | same |
 * | `--session-id` not a UUID | `Error: Invalid session ID. Must be a valid UUID.`, exit 1 | same |
 * | `--session-id` with `--resume` | refused, exit 1 | same |
 * | `--max-budget-usd` 0, negative, non-numeric, empty | `error: option '--max-budget-usd <amount>' argument '<v>' is invalid...`, exit 1 | same |
 * | `--max-budget-usd 1e-9` | accepted | accepted |
 * | `--permission-mode` outside the choice list | refused, exit 1, choices listed | same |
 * | `--effort` outside low/medium/high/xhigh/max | **warning on stderr, ignored, exit 0** | same |
 * | `--resume` an id no session ever used | `No conversation found with session ID: <id>`, exit 1 | same, keyed on the cursor file |
 * | `--session-id` reused by a later process | accepted | accepted |
 * | stdin line that is not JSON | `Error parsing streaming input line (...): SyntaxError`, exit 1 | same |
 *
 * **The real binary writes `SessionEnd hook [...] failed: Hook cancelled` to
 * stderr** whenever stdin closes promptly, which is every one of the probes
 * above. That is the real CLI's noise, not a defect in this orchestrator: see
 * design §5, which handles it by draining before closing stdin. This double
 * deliberately does not emit it, so a test asserting on stderr is asserting on
 * the orchestrator.
 *
 * ## Deliberate divergences, each with its reason
 *
 * - **A stdin line that parses as JSON but is not a user message exits 2**,
 *   where the real CLI ignores it silently and then waits forever (probed).
 *   Our orchestrator writes only `{"type":"user",...}`, so such a line is a bug
 *   in the orchestrator, and the real behaviour turns that bug into a hang in
 *   production. Refusing catches it in a test instead.
 * - **Exit 2 means this double refused**, a code the real CLI returns for none
 *   of these cases, so a harness misconfiguration is never read as a CLI
 *   result. Exit 1 is reserved for refusals the real CLI also makes and for a
 *   replayed error result.
 * - **`result_index` is replayed exactly as captured**, so it is 0 on every
 *   turn. Its real semantics were never probed, and inventing them would be a
 *   guess a later task could build on. Do not key anything on it.
 */

/** The version the fixtures in test/fixtures/ were captured against. */
const VERSION = "2.1.296"

const PERMISSION_MODES = ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]
const EFFORTS = ["low", "medium", "high", "xhigh", "max"]
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Every flag this project passes, from design §3.1 and the Task 8 flag set.
 *
 * This enumeration is the guard. A token outside it is refused rather than
 * ignored, because the real CLI refuses it too (probed), and because silently
 * ignoring one would let a later task pass a misspelled flag forever with its
 * test still green. Teaching the double a new flag is a one-line edit here.
 */
const BOOLEAN_FLAGS = new Map<string, string>([
  ["-p", "--print"],
  ["--print", "--print"],
  ["--verbose", "--verbose"],
  ["--version", "--version"],
])

const VALUE_FLAGS = new Set([
  "--input-format",
  "--output-format",
  "--permission-mode",
  "--model",
  "--effort",
  "--max-budget-usd",
  "--session-id",
  "--resume",
])

function recognised(): string {
  return [...new Set([...BOOLEAN_FLAGS.values(), ...VALUE_FLAGS])].sort().join(" ")
}

/** Exits with `code`, after writing each line to stderr. */
function die(code: number, ...lines: string[]): never {
  for (const line of lines) process.stderr.write(line + "\n")
  process.exit(code)
}

type Invocation = { flags: Set<string>; values: Map<string, string> }

function parseArgv(argv: string[]): Invocation {
  const flags = new Set<string>()
  const values = new Map<string, string>()

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === undefined) continue

    // The real CLI accepts --flag=value as well as two tokens (probed).
    let name = token
    let inline: string | undefined
    const eq = token.startsWith("--") ? token.indexOf("=") : -1
    if (eq !== -1) {
      name = token.slice(0, eq)
      inline = token.slice(eq + 1)
    }

    const canonical = BOOLEAN_FLAGS.get(name)
    if (canonical !== undefined && inline === undefined) {
      flags.add(canonical)
      continue
    }

    if (VALUE_FLAGS.has(name)) {
      const value = inline ?? argv[++i]
      if (value === undefined) die(1, `error: option '${name} <value>' argument missing`)
      values.set(name, value)
      continue
    }

    die(
      1,
      `error: unknown option '${name}'`,
      `fake-claude: recognises only ${recognised()}`,
    )
  }

  return { flags, values }
}

/** Mirrors the real CLI's own value checks, in the order commander applies them. */
function validateValues(inv: Invocation): void {
  const mode = inv.values.get("--permission-mode")
  if (mode !== undefined && !PERMISSION_MODES.includes(mode)) {
    die(
      1,
      `error: option '--permission-mode <mode>' argument '${mode}' is invalid. ` +
        `Allowed choices are ${PERMISSION_MODES.join(", ")}.`,
    )
  }

  const budget = inv.values.get("--max-budget-usd")
  if (budget !== undefined) {
    const n = Number(budget)
    if (!Number.isFinite(n) || n <= 0) {
      die(
        1,
        `error: option '--max-budget-usd <amount>' argument '${budget}' is invalid. ` +
          `--max-budget-usd must be a positive number greater than 0`,
      )
    }
  }
}

async function main(): Promise<void> {
  const inv = parseArgv(Bun.argv.slice(2))

  // Probed: the real CLI answers --version and ignores everything else, so this
  // must come before any guard. test/version.test.ts calls the configured
  // binary this way.
  if (inv.flags.has("--version")) {
    process.stdout.write(`${VERSION} (Claude Code)\n`)
    process.exit(0)
  }

  validateValues(inv)

  // Invocations this double cannot emulate. Exit 2: the real CLI accepts these
  // and does something else entirely, so there is no exit code to be faithful
  // to, and "the double refused" must not look like a CLI error.
  if (!inv.flags.has("--print")) {
    die(2, "fake-claude: refusing an invocation without -p; this double replays -p stream-json only")
  }
  for (const flag of ["--input-format", "--output-format"]) {
    const format = inv.values.get(flag)
    if (format !== "stream-json") {
      die(2, `fake-claude: ${flag} must be stream-json here, got ${format ?? "nothing"}`)
    }
  }

  // Probed: exit 1 without --verbose. A double that replayed anyway would let a
  // later task drop the flag while production emitted nothing at all.
  if (!inv.flags.has("--verbose")) {
    die(1, "Error: When using --print, --output-format=stream-json requires --verbose")
  }

  const sessionId = inv.values.get("--session-id")
  const resume = inv.values.get("--resume")
  if (sessionId !== undefined && resume !== undefined) {
    die(
      1,
      "Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.",
    )
  }
  for (const id of [sessionId, resume]) {
    if (id !== undefined && !UUID.test(id)) {
      die(1, "Error: Invalid session ID. Must be a valid UUID.")
    }
  }

  // Probed: an unknown --effort value is a warning the real CLI ignores, not an
  // error. Being stricter here would diverge from production.
  const effort = inv.values.get("--effort")
  if (effort !== undefined && !EFFORTS.includes(effort)) {
    process.stderr.write(
      `Warning: Unknown --effort value '${effort}' — ignoring it and using the default effort. ` +
        `Valid values: ${EFFORTS.join(", ")}.\n`,
    )
  }

  const scriptPath = process.env.ORCH_FAKE_SCRIPT
  if (scriptPath === undefined || scriptPath === "") {
    die(
      2,
      "fake-claude: ORCH_FAKE_SCRIPT is not set; this double replays a scripted turn list " +
        "and has nothing to say without one",
    )
  }
}

if (import.meta.main) await main()
