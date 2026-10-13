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
 *   KANTAN_FAKE_SCRIPT=<path>  a JSON file: { "turns": [{ "fixture": "...", "cost": 0.01 }] }
 *                            `fixture` resolves relative to the script's own directory.
 *                            `cost` overrides that turn's own spend in the result event.
 *   KANTAN_FAKE_ARGV_LOG=<path>  append-only JSONL of every invocation and every turn.
 *   KANTAN_FAKE_CHUNK=<bytes>    split stdout writes at this many bytes. Default: whole lines.
 *   KANTAN_FAKE_CHUNK_DELAY_MS   milliseconds between chunked writes. Default: 1, so the
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

import { randomUUID } from "node:crypto"
import { appendFile } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"

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
  // The permissions task in the implementation plan passes this "when the mode
  // is acceptEdits". The real CLI offers both spellings and declares the value
  // variadic (`<tools...>`) as well as comma or space separated; the double
  // takes **one** value, so the variadic form stops at the positional guard
  // with the stray token named. Dropping it silently would be a permissions
  // change nobody asked for.
  "--allowedTools",
  "--allowed-tools",
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

    // `claude -p "prompt text"` is a real invocation, so a positional is not an
    // unknown option and must not be reported as one. With stream-json input
    // the prompt arrives on stdin, so a positional means the caller is confused
    // about which mode it is driving: exit 2, the double's own refusal.
    if (!token.startsWith("-")) {
      die(2, `fake-claude: refusing the positional argument '${token}'; the prompt arrives on stdin here`)
    }

    // Probed: the real CLI reports the whole token, not the stripped name, so
    // `--verbose=yes` comes back as `unknown option '--verbose=yes'`. Giving a
    // boolean flag a value therefore needs no branch of its own.
    die(
      1,
      `error: unknown option '${token}'`,
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

/**
 * Environment variables whose **values** go into the invocation log.
 *
 * Names outside this set are recorded without their values. The log is a file
 * in the tree of an open-source repo, and the environment of a developer
 * running this suite holds credentials; copying every value to disk as a side
 * effect of running tests is not worth the convenience. Recording all the
 * *names* keeps an absence assertion honest, which is the one thing a filtered
 * log could otherwise quietly break: "CLAUDE_CONFIG_DIR is absent" must mean
 * absent from the environment, not merely absent from the log.
 */
const LOGGED_ENV_PREFIXES = ["CLAUDE_", "KANTAN_"]

/**
 * Names whose values are never logged, whatever their prefix.
 *
 * A real Claude Code environment carries `CLAUDE_CODE_MESSAGING_TOKEN`, which
 * the prefix allowlist above would otherwise admit: the allowlist alone would
 * log the very kind of value it exists to keep out of the tree.
 */
const SECRET_ENV_NAME = /token|secret|key|password|credential|cookie|auth/i

/** Appends one record to KANTAN_FAKE_ARGV_LOG, if a path is configured. */
async function logRecord(record: Record<string, unknown>): Promise<void> {
  const path = process.env.KANTAN_FAKE_ARGV_LOG
  if (path === undefined || path === "") return
  try {
    await appendFile(path, JSON.stringify(record) + "\n")
  } catch (cause) {
    // Loudly: a silently dropped write leaves a later task asserting against an
    // empty log, which looks like the orchestrator never spawned anything.
    die(2, `fake-claude: cannot append to KANTAN_FAKE_ARGV_LOG ${path}: ${(cause as Error).message}`)
  }
}

function environmentForLog(): { env: Record<string, string>; envKeys: string[] } {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    const wanted = LOGGED_ENV_PREFIXES.some((p) => key.startsWith(p)) && !SECRET_ENV_NAME.test(key)
    if (value !== undefined && wanted) env[key] = value
  }
  return { env, envKeys: Object.keys(process.env).sort() }
}

type Turn = { fixture: string; cost?: number }

const SCRIPT_KEYS = new Set(["turns"])
const TURN_KEYS = new Set(["fixture", "cost"])

/**
 * Reads the turn script.
 *
 * Unknown keys are refused rather than ignored, for the reason
 * `src/projects.ts` refuses them: a misspelled *optional* key reads as absent.
 * A turn written `{"fixture": "...", "costs": 0.25}` would silently replay the
 * fixture's own cost, and Task 14's budget test would then assert against the
 * capture rather than against the code.
 */
async function loadScript(path: string): Promise<Turn[]> {
  const file = Bun.file(path)
  if (!(await file.exists())) die(2, `fake-claude: KANTAN_FAKE_SCRIPT ${path} does not exist`)

  let raw: unknown
  try {
    raw = JSON.parse(await file.text())
  } catch (cause) {
    die(2, `fake-claude: ${path} is not valid JSON: ${(cause as Error).message}`)
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    die(2, `fake-claude: ${path} must be an object like {"turns":[{"fixture":"..."}]}`)
  }

  const script = raw as Record<string, unknown>
  for (const key of Object.keys(script)) {
    if (!SCRIPT_KEYS.has(key)) {
      die(2, `fake-claude: ${path} has unknown key '${key}'; allowed: ${[...SCRIPT_KEYS].join(", ")}`)
    }
  }
  if (!Array.isArray(script["turns"])) die(2, `fake-claude: ${path} needs a "turns" array`)

  return script["turns"].map((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      die(2, `fake-claude: ${path} turn ${i + 1} must be an object`)
    }
    const turn = entry as Record<string, unknown>
    for (const key of Object.keys(turn)) {
      if (!TURN_KEYS.has(key)) {
        die(2, `fake-claude: ${path} turn ${i + 1} has unknown key '${key}'; allowed: ${[...TURN_KEYS].join(", ")}`)
      }
    }
    const fixture = turn["fixture"]
    if (typeof fixture !== "string" || fixture === "") {
      die(2, `fake-claude: ${path} turn ${i + 1} needs a "fixture" path`)
    }
    const cost = turn["cost"]
    if (cost !== undefined && (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)) {
      // No result the real CLI emits reports a negative spend, and a negative
      // override would make a running budget total shrink.
      die(2, `fake-claude: ${path} turn ${i + 1} needs a "cost" that is a number and not negative`)
    }
    return cost === undefined ? { fixture } : { fixture, cost }
  })
}

/**
 * The turn cursor and the set of sessions that have processed a turn.
 *
 * It lives in a file beside the script because the turn list is consumed across
 * processes: a run spawns the binary once per phase plus once per escalation,
 * and all of them inherit one KANTAN_FAKE_SCRIPT.
 */
type Cursor = { next: number; sessions: string[] }

async function readCursor(path: string): Promise<Cursor> {
  const file = Bun.file(path)
  if (!(await file.exists())) return { next: 0, sessions: [] }
  let raw: Partial<Cursor>
  try {
    raw = JSON.parse(await file.text()) as Partial<Cursor>
  } catch (cause) {
    // Exit 2, not the 1 an uncaught throw would give: a damaged cursor is a
    // broken harness, not a CLI refusal. Deleting it restarts the turn list.
    die(2, `fake-claude: cursor file ${path} is unreadable: ${(cause as Error).message}`)
  }
  return { next: raw.next ?? 0, sessions: raw.sessions ?? [] }
}

async function writeCursor(path: string, cursor: Cursor): Promise<void> {
  await Bun.write(path, JSON.stringify(cursor))
}

/** Yields stdin lines, buffering partial ones, as a stream-json reader must. */
async function* stdinLines(): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true })
    let nl = buffer.indexOf("\n")
    while (nl !== -1) {
      yield buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf("\n")
    }
  }
  if (buffer !== "") yield buffer
}

/** Reads an integer knob of at least `min` from the environment. */
function numericEnv(name: string, min: number, fallback?: number): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min) {
    // Loudly: falling back to whole lines on a typo'd knob would make Task 6's
    // reassembly test pass without ever seeing a split line, which is the
    // fiction the knob exists to prevent.
    die(2, `fake-claude: ${name} must be an integer of at least ${min}, got '${raw}'`)
  }
  return n
}

/**
 * Writes the turn's lines to stdout, awaiting every write so none is lost when
 * the process exits.
 *
 * With `KANTAN_FAKE_CHUNK` set, the turn is written in fixed-size slices of the
 * **encoded bytes**, never of the string, so a boundary can fall inside a
 * multi-byte character. That is the case the captured fixtures cannot produce:
 * Task 4's redaction pass re-serialised them as pure ASCII, so a parser that
 * decoded each read on its own would pass against them and corrupt real CLI
 * output. The delay between writes keeps them separate reads rather than one
 * coalesced buffer.
 */
async function emit(lines: string[]): Promise<void> {
  const chunk = numericEnv("KANTAN_FAKE_CHUNK", 1)
  if (chunk === undefined) {
    for (const line of lines) await Bun.write(Bun.stdout, line + "\n")
    return
  }

  const delay = numericEnv("KANTAN_FAKE_CHUNK_DELAY_MS", 0, 1) ?? 1
  const bytes = new TextEncoder().encode(lines.map((l) => l + "\n").join(""))
  for (let at = 0; at < bytes.length; at += chunk) {
    await Bun.write(Bun.stdout, bytes.subarray(at, at + chunk))
    if (delay > 0) await Bun.sleep(delay)
  }
}

/** Rewrites `total_cost_usd` in place, leaving every other byte of the line alone. */
function rewriteCost(line: string, cost: number, path: string, lineNumber: number): string {
  const field = /("total_cost_usd":\s*)(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/
  if (!field.test(line)) {
    die(2, `fake-claude: ${path} line ${lineNumber} has no numeric total_cost_usd to rewrite`)
  }
  return line.replace(field, (_match, prefix: string) => `${prefix}${cost}`)
}

/**
 * Replays one fixture, rewriting the session id and the running cost.
 *
 * Every byte that is not deliberately rewritten is the capture's own, so a test
 * comparing a run log against a fixture compares like with like. The session
 * rewrite substitutes the captured id wherever it appears in the line, which
 * also catches a nested copy that assigning to the top-level field would miss.
 *
 * `spentBefore` is this **process's** spend so far. Design §3.4, probed: within
 * one process `total_cost_usd` accumulates, and it starts over in the next
 * process. Replaying each fixture's own figure instead would inverse Task 14's
 * test, making "sum every result" look right and "last result per process"
 * look wrong.
 */
async function replayTurn(
  turn: Turn,
  scriptPath: string,
  sessionId: string,
  spentBefore: number,
): Promise<{ spent: number; isError: boolean }> {
  const path = isAbsolute(turn.fixture) ? turn.fixture : join(dirname(scriptPath), turn.fixture)
  const file = Bun.file(path)
  if (!(await file.exists())) die(2, `fake-claude: fixture ${path} does not exist`)

  const lines = (await file.text()).split("\n").filter((l) => l.trim() !== "")
  const emitted: string[] = []
  let spent = spentBefore
  let isError = false
  let results = 0

  for (const [i, line] of lines.entries()) {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch (cause) {
      die(2, `fake-claude: ${path} line ${i + 1} is not JSON: ${(cause as Error).message}`)
    }

    const captured = parsed["session_id"]
    if (typeof captured !== "string") {
      // Refused rather than passed through: with no captured id to substitute,
      // a nested copy of the real session id could survive into the output and
      // a continuity assertion would then be about the fixture.
      die(2, `fake-claude: ${path} line ${i + 1} has no string session_id to rewrite`)
    }
    let rewritten = line.replaceAll(captured, sessionId)

    if (parsed["type"] === "result") {
      results += 1

      // The exit code keys on is_error and the budget arithmetic on
      // total_cost_usd. A recapture that renames or drops either must not
      // quietly become a successful, free turn.
      const flag = parsed["is_error"]
      if (typeof flag !== "boolean") {
        die(2, `fake-claude: ${path} line ${i + 1} has no boolean is_error, which is what the exit code reads`)
      }
      if (parsed["subtype"] !== "success" && flag !== true) {
        die(
          2,
          `fake-claude: ${path} line ${i + 1} has subtype '${String(parsed["subtype"])}' with ` +
            "is_error false; the double cannot tell whether that turn failed",
        )
      }
      const capturedCost = parsed["total_cost_usd"]
      if (typeof capturedCost !== "number" || !Number.isFinite(capturedCost)) {
        die(2, `fake-claude: ${path} line ${i + 1} has no numeric total_cost_usd, which the budget arithmetic reads`)
      }
      // Today's captures carry the field once per line, with per-model figures
      // under `costUSD`. If a recapture nests a second one, a rewrite would be
      // a coin flip whose loser is a wrong budget total in a passing test.
      // Checked on every result line, not only on the ones being rewritten.
      const mentions = line.split('"total_cost_usd"').length - 1
      if (mentions !== 1) {
        die(
          2,
          `fake-claude: ${path} line ${i + 1} mentions total_cost_usd ${mentions} times; ` +
            "the double will not guess which one is the turn's cost",
        )
      }

      spent += turn.cost ?? capturedCost
      // Left untouched when it already matches, so a single-turn process
      // replays the capture byte for byte.
      if (spent !== capturedCost) rewritten = rewriteCost(rewritten, spent, path, i + 1)
      isError = flag
    }

    emitted.push(rewritten)
  }

  // One turn, one result. `result_index` and `queued_turn_count` show that a
  // real process can emit more than one, and within a process those figures
  // are cumulative, so the running total above would double-count them -- the
  // exact error docs/HANDOFF.md warns about for the real arithmetic. Refuse
  // rather than quietly inflate a budget a later test asserts on.
  if (results > 1) {
    die(
      2,
      `fake-claude: ${path} holds ${results} result events; this double replays one result per ` +
        "turn, and summing cumulative figures would double-count the turn's cost",
    )
  }
  if (turn.cost !== undefined && results === 0) {
    die(
      2,
      `fake-claude: ${path} has no result event, so the turn's cost override has nothing to ` +
        "apply to and would silently do nothing",
    )
  }

  await emit(emitted)
  return { spent, isError }
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2)

  // Logged before argv is so much as parsed, so the record is the invocation
  // itself with nothing interpreted, and so a refused spawn still shows the
  // argv that was refused.
  await logRecord({
    kind: "spawn",
    argv,
    cwd: process.cwd(),
    pid: process.pid,
    ...environmentForLog(),
  })

  // Probed: `claude --bogus --version` prints the version and exits 0, so the
  // version answer is reached before argv is validated at all, not merely
  // before the guards below. test/version.test.ts calls the configured binary
  // this way, so a later task can install this double suite-wide.
  if (argv.includes("--version")) {
    process.stdout.write(`${VERSION} (Claude Code)\n`)
    process.exit(0)
  }

  const inv = parseArgv(argv)
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

  const scriptPath = process.env.KANTAN_FAKE_SCRIPT
  if (scriptPath === undefined || scriptPath === "") {
    die(
      2,
      "fake-claude: KANTAN_FAKE_SCRIPT is not set; this double replays a scripted turn list " +
        "and has nothing to say without one",
    )
  }

  const turns = await loadScript(scriptPath)
  const cursorFile = `${scriptPath}.cursor`

  // Probed: resuming an id no session ever ran fails, and so does resuming one
  // that was named but processed no turn. A session becomes resumable by
  // handling a turn, which is what the cursor's session list records.
  if (resume !== undefined) {
    const cursor = await readCursor(cursorFile)
    if (!cursor.sessions.includes(resume)) {
      die(1, `No conversation found with session ID: ${resume}`)
    }
  }

  const session = sessionId ?? resume ?? randomUUID()

  // This process's own spend. Design §3.4, probed: the figure accumulates
  // within a process and starts over in the next one, which is what makes
  // "sum the last result of each process" the correct reduction.
  let spent = 0

  for await (const line of stdinLines()) {
    if (line.trim() === "") continue

    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      // Mirrors the real CLI, probed: it reports the length and the error kind
      // and exits 1.
      die(1, `Error parsing streaming input line (type=unknown, ${line.length} chars): SyntaxError`)
    }
    if (message["type"] !== "user") {
      die(
        2,
        `fake-claude: refusing a stdin message of type '${String(message["type"])}'; ` +
          "the real CLI ignores it and then waits forever, which reads as a stall rather than a bug",
      )
    }

    // Re-read per turn: the cursor is shared with every other process the run
    // spawns, and this one may have started after another advanced it.
    const cursor = await readCursor(cursorFile)
    const turn = turns[cursor.next]
    if (turn === undefined) {
      die(
        2,
        `fake-claude: the script has ${turns.length} turn(s) and this is turn ${cursor.next + 1}; ` +
          "add a turn to KANTAN_FAKE_SCRIPT or send fewer",
      )
    }
    // The prompt arrives on stdin, not in argv, so this record is the only
    // place Task 13 can read what the implement phase was actually told. The
    // line is stored raw, uninterpreted.
    await logRecord({
      kind: "turn",
      index: cursor.next,
      fixture: turn.fixture,
      session,
      stdin: line,
      pid: process.pid,
    })

    const replayed = await replayTurn(turn, scriptPath, session, spent)
    spent = replayed.spent

    // Recorded only once the turn actually replayed. Marking the session
    // resumable before that would let a --resume succeed after a replay that
    // died, which is precisely the turnless session the real CLI refuses.
    cursor.next += 1
    if (!cursor.sessions.includes(session)) cursor.sessions.push(session)
    await writeCursor(cursorFile, cursor)

    // An error result is terminal: the real CLI exits 1 on budget exhaustion
    // and never answers a queued turn. Every write above was awaited, so
    // exiting here cannot truncate the result event.
    if (replayed.isError) process.exit(1)
  }

  process.exit(0)
}

if (import.meta.main) await main()
