import { permissionArgs } from "./permissions"
import type { Effort, Project } from "./projects"
import { CLAUDE_BIN } from "./version"

/**
 * One phase invocation of `claude -p`, per design §3.1.
 *
 * **This module does not choose the model, the effort or the session. It takes
 * them.** Task 13 owns the mapping from phase to session and model, because
 * choosing the wrong session fails *silently*: resuming the plan session for an
 * implement turn runs the implement prompt inside the planning conversation and
 * still exits `success` (docs/HANDOFF.md). There is no error to catch. A spawn
 * layer that reached into `project` for "the model" or derived a session id
 * from a run id would make that mistake unrepresentable in a test, which is
 * exactly why they are arguments here.
 *
 * `sessionId` is the **phase's** session - `planSessionId` or
 * `implementSessionId` - and never the run id. `--session-id` takes a UUID, so
 * neither can be derived from the run id by suffixing, and there is
 * deliberately nowhere in this interface to put one.
 */
export interface PhaseSpawn {
  project: Project
  /** `planSessionId` or `implementSessionId`. Never the run id. */
  sessionId: string
  /** `--resume <sessionId>` rather than `--session-id <sessionId>`. */
  resume: boolean
  /** `project.planModel` or `project.implementModel`, as the caller decides. */
  model: string
  /** The phase's level, raised a step on each stall escalation. */
  effort: Effort
  /** `ceiling - spent`. The flag bounds one **process**, not the run (probed,
   * design §3.4), so every respawn passes a fresh remainder. */
  remainingUsd: number
}

/**
 * How the child ended.
 *
 * It resolves for every ending, including a non-zero exit: budget exhaustion
 * is `exit 1` with `subtype=error_max_budget_usd` (probed) and is a normal,
 * raisable stop rather than a crash, so a rejection here would dress it up as
 * one. `code` is `null` exactly when a signal ended it, which is what the stop
 * button produces.
 */
export interface PhaseExit {
  code: number | null
  signal: string | null
  /**
   * Everything the child wrote to stderr.
   *
   * Collected by this module rather than handed over as a stream for two
   * reasons. Design §5 wants it kept in the run log on a non-zero exit, and
   * nobody wants it incrementally; and an unread stderr pipe can fill and wedge
   * the child, which would turn a diagnostic into a hang.
   *
   * The real CLI writes `SessionEnd hook [...] failed: Hook cancelled` here
   * whenever stdin closes abruptly, which is what `close()` drains to avoid.
   */
  stderr: string
}

/**
 * A running phase.
 *
 * `stdout` is handed over raw, for `parseStream` in `src/stream.ts`. **The
 * caller must consume it.** A fixture is larger than a pipe buffer, so an
 * unread stdout stops the child mid-write and `exited` never resolves.
 */
export interface PhaseProcess {
  /** The flags the child was invoked with, for the run log header. The binary
   * is not among them: `CLAUDE_BIN` names it, and the header records the
   * version it reported rather than its path. */
  readonly argv: readonly string[]
  readonly stdout: ReadableStream<Uint8Array>
  readonly exited: Promise<PhaseExit>
  /** Queues one user turn. Resolves once its bytes have reached the child. */
  send(prompt: string): Promise<void>
  /** Drains stdin, then closes it. */
  close(): Promise<void>
  /** SIGTERM, then the exit. Resolves; never throws. */
  terminate(): Promise<PhaseExit>
}

/**
 * The budget passed when the ceiling is already spent: small enough that the
 * first turn must exceed it, and still accepted.
 *
 * Probed: `--max-budget-usd 1e-9` is accepted, and `<= 0` is refused with a
 * commander error and exit 1. See `budgetFlag` for why a floor beats passing
 * the real remainder through.
 */
const MIN_BUDGET_USD = 1e-9

/**
 * `--max-budget-usd`'s value for a remainder of `remainingUsd` dollars.
 *
 * A normalising guard, so CLAUDE.md's rule applies. The dimension is the
 * remainder itself, and it takes four kinds of value:
 *
 * - **Positive**, integer or not: passed through. `String` keeps `12.34` and
 *   renders a tiny figure in exponent form, which the CLI accepts (probed).
 * - **Zero, or negative zero**: the ceiling is exactly spent.
 * - **Negative**: the last process overshot, which it can, because the flag
 *   bounds a process and the overshoot is only known afterwards.
 * - **Non-finite**: `NaN` or `±Infinity`.
 *
 * The first three are real run states and the fourth never is, so they fail in
 * opposite directions. Passing a non-positive remainder through would be
 * refused by the CLI as an invalid option, on stderr, with exit 1 - the shape
 * of a misconfigured orchestrator rather than of an exhausted budget, and a
 * message nothing in the UI knows how to explain. A floor instead reaches the
 * designed stop: the process starts, the first turn exceeds the budget, and the
 * run gets `subtype=error_max_budget_usd`, which §3.4 already handles by
 * offering a raise. The floor is tiny on purpose, so it cannot be mistaken for
 * a budget that could fund anything.
 *
 * **The floor is a backstop, not a policy.** The CLI checks the budget after
 * the turn, not before: `test/fixtures/budget-exhausted.jsonl` was captured at
 * `--max-budget-usd 0.0001` and reports `num_turns: 1` having spent $0.0046.
 * So a spawn on an exhausted ceiling still costs about one turn, and the layer
 * that tracks the total should refuse to spawn rather than lean on this.
 *
 * A non-finite remainder means the cost arithmetic upstream broke, and
 * flooring it would hide that for the rest of the run while every later
 * process got the floor too. So it throws, naming the field.
 */
function budgetFlag(remainingUsd: number): string {
  if (!Number.isFinite(remainingUsd)) {
    throw new Error(
      `remainingUsd must be a finite number of dollars, got ${String(remainingUsd)}. ` +
        "It is ceiling minus spent, so a NaN means the running total is broken upstream.",
    )
  }
  return String(remainingUsd > 0 ? remainingUsd : MIN_BUDGET_USD)
}

/**
 * The flag set, from design §3.1.
 *
 * `--verbose` is not optional: without it the CLI refuses the invocation and
 * stream-json emits nothing at all (probed), so dropping it breaks every run
 * with no obvious cause.
 *
 * The permission half comes from `src/permissions.ts` rather than being built
 * here. Which mode a project runs in, and whether an allowlist accompanies it,
 * is a fact about the project, not about spawning a process - and a second
 * copy of that rule in this file could drift from the one that is tested
 * against the derivation.
 */
function phaseArgs(spec: PhaseSpawn): string[] {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    ...permissionArgs(spec.project),
    "--model",
    spec.model,
    "--effort",
    spec.effort,
    "--max-budget-usd",
    budgetFlag(spec.remainingUsd),
    // One or the other, never both: the CLI refuses the pair unless
    // --fork-session is also given (probed), and forking is not what either
    // phase wants.
    ...(spec.resume ? ["--resume", spec.sessionId] : ["--session-id", spec.sessionId]),
  ]
}

/**
 * The child's environment.
 *
 * `CLAUDE_CONFIG_DIR` is **deleted** when the project names none, rather than
 * left to the ambient value. A profile carries the account, its credentials,
 * its CLAUDE.md, its skills and its plugins, and the design says an absent
 * `configDir` means the default profile (§2.1). Inheriting whatever the shell
 * that launched the server happened to export would make "absent" mean "some
 * other profile" on one machine and "the default" on another, and the only
 * trace would be a line in the run log header. Deleting it fails the loud way
 * instead: a profile that is wrong for the project is a login error, not a run
 * quietly charged to another account.
 *
 * Everything else is inherited, `PATH` above all: a curated environment without
 * it cannot even start the binary.
 */
function phaseEnv(project: Project): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  if (project.configDir === undefined) delete env["CLAUDE_CONFIG_DIR"]
  else env["CLAUDE_CONFIG_DIR"] = project.configDir
  return env
}

/**
 * The child, or an error naming what could not be started.
 *
 * Its own function so the handle below can hold a `const` with Bun's inferred
 * stream types: a `let` assigned inside a `try` and then captured by closures
 * is an implicit `any` under `strict`.
 */
function startChild(argv: string[], project: Project) {
  const cwd = project.path
  try {
    return Bun.spawn([CLAUDE_BIN, ...argv], {
      // §3.6: a run works in the project's own checkout, on the task branch.
      cwd,
      env: phaseEnv(project),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch (cause) {
    // Bun throws synchronously for both a missing binary and a missing cwd,
    // and probed, the ENOENT names the **binary** either way - so a repo that
    // has moved reads as a broken ORCH_CLAUDE_BIN. Naming the directory too is
    // what tells the two apart.
    throw new Error(`cannot spawn ${CLAUDE_BIN} in ${cwd}: ${(cause as Error).message}`, { cause })
  }
}

/** One newline-delimited stream-json user message. */
function userMessage(prompt: string): string {
  return (
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: prompt }] },
    }) + "\n"
  )
}

/**
 * Starts one phase of a run.
 *
 * The binary comes from `CLAUDE_BIN`, which is the seam the fake double in
 * `test/fake-claude.ts` stands in on. Nothing here may name `claude` directly.
 */
export function spawnPhase(spec: PhaseSpawn): PhaseProcess {
  // Built before the spawn, so a budget or a permission set this invocation
  // cannot express refuses before a process exists rather than after.
  const argv = phaseArgs(spec)
  const child = startChild(argv, spec.project)

  // Read from the start, because a full stderr pipe stops the child.
  const stderr = new Response(child.stderr)
    .text()
    .catch((cause: Error) => `<stderr could not be read: ${cause.message}>`)

  const exited: Promise<PhaseExit> = child.exited.then(async () => ({
    code: child.exitCode,
    signal: child.signalCode ?? null,
    stderr: await stderr,
  }))

  /**
   * Turns queue, and each one is flushed before the next is written.
   *
   * Serialising them is what makes `close()` able to drain: there is a single
   * promise to await, and it settles only once every byte has been handed to
   * the child. Two concurrent writes could also interleave two JSON lines,
   * which the CLI reports as a parse error and exits on.
   */
  let queue: Promise<void> = Promise.resolve()
  let closed = false

  function send(prompt: string): Promise<void> {
    const line = userMessage(prompt)
    // A write after the close is **silently dropped**: the sink reports success
    // and the bytes never arrive (probed on Bun 1.4.3). The phase would then
    // wait for a result the CLI was never asked for, which reads as a stall
    // rather than as the mistake it is. So it is refused instead.
    const written = closed
      ? Promise.reject(
          new Error("stdin is closed, so this phase cannot take another turn; spawn a new one"),
        )
      : queue.then(async () => {
          child.stdin.write(line)
          await child.stdin.flush()
        })
    // Attaching a handler is what stops a rejection the caller ignored from
    // becoming an unhandled one, and what stops one failed write from wedging
    // every turn after it: the queue carries on either way.
    queue = written.then(
      () => {},
      () => {},
    )
    return written
  }

  /**
   * Drains stdin, then closes it.
   *
   * The drain is design §5: closing stdin the moment a `result` arrived
   * produced `SessionEnd hook [...] failed: Hook cancelled` on stderr in every
   * probe. That is the real CLI's behaviour and the fake double deliberately
   * does not reproduce it, so no test in this repo can see the message - only
   * that every queued turn reached the child first.
   */
  async function close(): Promise<void> {
    closed = true
    await queue
    child.stdin.end()
  }

  /**
   * The stop button, design §3.4. Stopping costs nothing: the session resumes
   * from the same id, so this does not close stdin or clean up - it ends the
   * process and reports how it ended.
   */
  async function terminate(): Promise<PhaseExit> {
    child.kill("SIGTERM")
    return exited
  }

  return { argv, stdout: child.stdout, exited, send, close, terminate }
}
