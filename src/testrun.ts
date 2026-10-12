import { spawn } from "node:child_process"
import { Buffer } from "node:buffer"
import { constants } from "node:os"
import type { Project } from "./projects"

/**
 * Running the project's own test command, which is how design §3.3 keeps
 * verification outside the agent: the server runs the tests and branches on the
 * exit code, and never on the agent reporting success.
 *
 * This module returns the raw outcome and nothing else. The failure signature
 * lives in `src/stall.ts` and the loop that combines them is Task 13's.
 */

/** The outcome of one test run. `exitCode` is the only field the loop branches on. */
export interface TestOutcome {
  /**
   * The command's status, **never 0 unless the command itself exited 0**:
   *
   * - a normal exit reports its own code, including the shell's 127 for a
   *   `testCmd` that does not exist;
   * - a death by signal reports `128 + signal`, the way a shell does, so a
   *   suite that segfaulted (139) cannot read as a pass;
   * - a timeout reports `TIMEOUT_EXIT_CODE` whatever the command returned,
   *   because a watch-mode runner that traps SIGTERM exits 0 when killed and
   *   that 0 would turn a run that never finished into a run that passed.
   */
  exitCode: number
  /** stdout, truncated to the last `MAX_OUTPUT_BYTES` with a marker line prepended. */
  stdout: string
  /** stderr, truncated the same way. Many runners report failures here. */
  stderr: string
  /** Monotonic wall time from spawn to the last byte collected. */
  durationMs: number
  /** True when the command was killed for exceeding the timeout. The output is
   * whatever it had written by then. */
  timedOut: boolean
}

/**
 * How much of each stream is kept, per stream.
 *
 * The **tail** is kept, not the head: design §3.4 hashes the tail of the output
 * for the stall signature, and every runner prints its summary last. A head cap
 * would give every failure the same opening banner to hash, and false stalls
 * would follow.
 *
 * The cap bounds memory; it does not stop the command. A suite that emits more
 * than this still runs to completion and is still judged on its exit code,
 * because the two directions are not symmetric: killing a verbose-but-legitimate
 * failing suite would leave it permanently unverifiable, while reading past the
 * cap costs nothing but the time the timeout already bounds.
 */
export const MAX_OUTPUT_BYTES = 1024 * 1024

/**
 * How long a test command may run before it is killed.
 *
 * Generous on purpose: real Pest, PHPUnit and `flutter test` suites take
 * minutes, and killing a slow suite looks exactly like a failing one to the
 * loop. It exists for the runner that never exits at all - `vitest` without
 * `--run`, `jest --watch`, `bun test --watch` - which without a bound would
 * hold the project's run lock forever.
 */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/** Reported for a run killed by the timeout: coreutils `timeout`'s own code. */
export const TIMEOUT_EXIT_CODE = 124

/** Reported when a status cannot be established at all. Deliberately non-zero. */
const UNKNOWN_EXIT_CODE = 128

/** Between SIGTERM and SIGKILL. Long enough for a runner to flush
 * `project.reportPath`, which the stall signature prefers to parsed output. */
const KILL_GRACE_MS = 2000

/** How long to wait for EOF after the command has exited. A background process
 * the command started inherits these pipes and can hold them open afterwards. */
const DRAIN_GRACE_MS = 2000

/** How long to wait for EOF after the group has been SIGKILLed, before giving
 * up on it. Nothing in the group can still be writing; this only bounds the
 * wait on a writer that escaped the group entirely. */
const ABANDON_MS = 1000

/**
 * `testCmd` is a shell string, not an argv array: `vendor/bin/pest
 * --filter=Foo` and `npm test -- --ci` both need shell semantics, and the
 * project store already refuses a blank command because `sh -c ""` exits 0.
 *
 * The consequence, which is the reason to state the choice: the user's command
 * works exactly as typed, and **nothing untrusted may ever be concatenated into
 * it**. `testCmd` comes from the project record, which a human typed; no model
 * output reaches this string.
 *
 * `/bin/sh`, not `$SHELL`: the POSIX shell is what a `testCmd` is written
 * against. Borrowing an interactive shell would run it under fish or zsh,
 * where `npm test -- --ci` is not the same command.
 */
const SHELL = "/bin/sh"

/**
 * Runs `project.testCmd` in `project.path` and reports what happened.
 *
 * Resolves for anything the command did, including failing to exist - that is a
 * test result, and exit 127 is what the loop should see. Rejects only when the
 * command could not be started at all, which means the project is
 * misconfigured rather than failing: handing a missing repo path to the agent
 * as a test failure would spend the budget fixing tests in a directory that
 * does not exist.
 */
export function runTests(project: Project, opts?: { timeoutMs?: number }): Promise<TestOutcome> {
  const testCmd = project.testCmd
  // `null` means the project has no suite and the agent verifies instead (the
  // user's 2026-10-12 decision), which is `src/run.ts`'s branch to take before
  // it ever gets here. Rejecting rather than resolving, because this is the
  // misconfigured-project door and not a test result - and the two silent
  // alternatives are both worse than a throw. `spawn` coerces its argv, so
  // passing it through would run the literal word `null` and exit 127, which
  // the loop reads as a failing suite: the budget would then be spent asking an
  // agent to fix a test command that was never supposed to exist. Reporting a
  // bare 0 would be the catastrophe instead, ticking the task untested.
  if (testCmd === null) {
    return Promise.reject(
      new Error(
        `the project at ${project.path} has no test command, so there is nothing for kantan to run. ` +
          `A project with testCmd null is verified by the agent itself; that path does not come through here. ` +
          `Set testCmd in projects.json if this project does have a suite.`,
      ),
    )
  }
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const startedAt = performance.now()
  const stdout = new Tail("stdout")
  const stderr = new Tail("stderr")

  return new Promise<TestOutcome>((resolve, reject) => {
    let child
    try {
      child = spawn(SHELL, ["-c", testCmd], {
        cwd: project.path,
        // The child gets its own process group, so the timeout can kill
        // everything the command started rather than just the shell.
        detached: true,
        // stdin is /dev/null: a runner that prompts reads EOF and gives up,
        // instead of blocking the run on input nobody is there to type.
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (cause) {
      // Bun throws here for ENOTDIR but reports ENOENT through the "error"
      // event, so both doors have to be closed.
      reject(cannotStart(project, cause))
      return
    }

    let settled = false
    let timedOut = false
    let status: number | undefined
    const timers = new Set<ReturnType<typeof setTimeout>>()

    const later = (ms: number, fn: () => void): void => {
      const t = setTimeout(() => {
        timers.delete(t)
        fn()
      }, ms)
      timers.add(t)
    }

    const clearTimers = (): void => {
      for (const t of timers) clearTimeout(t)
      timers.clear()
    }

    /**
     * Signals the process **group**, not the child.
     *
     * The child is a `sh -c` wrapper, so killing it alone leaves whatever it
     * started running - and still holding these pipes, which means the run
     * would never see EOF either. `detached` made the child a session leader,
     * so its pid is its process-group id. A negative pid can therefore only
     * name the child's own group; it cannot reach the server's group even if
     * `setsid` had somehow not happened.
     */
    const killGroup = (signal: "SIGTERM" | "SIGKILL"): void => {
      const pid = child.pid
      if (pid === undefined) return
      try {
        process.kill(-pid, signal)
      } catch {
        // ESRCH: the group is already gone, which is the point of the call.
      }
    }

    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimers()
      resolve({
        exitCode: timedOut ? TIMEOUT_EXIT_CODE : (status ?? UNKNOWN_EXIT_CODE),
        stdout: stdout.text(),
        stderr: stderr.text(),
        durationMs: Math.round(performance.now() - startedAt),
        timedOut,
      })
    }

    child.on("error", (cause) => {
      if (settled) return
      settled = true
      clearTimers()
      reject(cannotStart(project, cause))
    })

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk))

    child.on("exit", (code, signal) => {
      status = statusOf(code, signal)
      later(DRAIN_GRACE_MS, () => {
        killGroup("SIGKILL")
        later(ABANDON_MS, finish)
      })
    })

    // Both pipes at EOF and the child reaped: everything was collected.
    child.on("close", () => {
      if (status !== undefined) {
        finish()
        return
      }
      // A "close" with no "exit" before it means the spawn failed, and the
      // "error" handler above rejects for that. Settle on a timer rather than
      // hang, in case some runtime ever emits one of the two and not the other.
      later(ABANDON_MS, finish)
    })

    later(timeoutMs, () => {
      if (settled) return
      timedOut = true
      // SIGTERM first, so a runner gets the chance to flush its report, then
      // SIGKILL unconditionally: the shell can be dead while a member of its
      // group that ignores SIGTERM lives on.
      killGroup("SIGTERM")
      later(KILL_GRACE_MS, () => {
        killGroup("SIGKILL")
        later(ABANDON_MS, finish)
      })
    })
  })
}

/** What a shell would report for the same death. */
function statusOf(code: number | null, signal: string | null): number {
  if (code !== null) return code
  const signals: Record<string, number | undefined> = constants.signals
  const n = signal === null ? undefined : signals[signal]
  // 128 + n, and 128 even for a signal this platform cannot name: an
  // unidentifiable death must not be reported as a pass.
  return 128 + (n ?? 0)
}

/**
 * The run could not start.
 *
 * The OS error names the shell - `ENOENT: no such file or directory,
 * posix_spawn '/bin/sh'` is what a missing `cwd` reports - so passing it
 * through would point at the wrong thing entirely. `project.path` is only
 * lexically normalised and nothing has checked that it exists, so this is the
 * likely message and it has to name the path.
 */
function cannotStart(project: Project, cause: unknown): Error {
  const e = cause as (Error & { code?: string }) | undefined
  const detail = e?.code ?? e?.message ?? String(cause)
  return new Error(
    `cannot run tests in ${project.path}: ${detail}. The project path must be an existing ` +
      `directory and ${SHELL} must be present. (testCmd: ${project.testCmd})`,
    { cause },
  )
}

/**
 * The last `MAX_OUTPUT_BYTES` of one stream, with a count of what was dropped.
 *
 * Bytes, not characters, and decoded once at the end: decoding each chunk as it
 * arrives would mangle any multi-byte character that straddles a read boundary,
 * and a byte cap is the one that actually bounds memory.
 *
 * The drop boundary itself can still land inside a character. Its orphaned
 * continuation bytes then decode as a replacement character each, putting the
 * result a few bytes over the cap at the head of a stream that was already
 * being truncated. Trimming to the next character boundary would be one more
 * guess about input for no gain.
 */
class Tail {
  private readonly chunks: Buffer[] = []
  private bytes = 0
  private dropped = 0

  constructor(private readonly name: "stdout" | "stderr") {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk)
    this.bytes += chunk.length
    while (this.bytes > MAX_OUTPUT_BYTES) {
      const head = this.chunks[0]
      if (head === undefined) break
      const excess = this.bytes - MAX_OUTPUT_BYTES
      if (head.length <= excess) {
        this.chunks.shift()
        this.bytes -= head.length
        this.dropped += head.length
      } else {
        this.chunks[0] = head.subarray(excess)
        this.bytes -= excess
        this.dropped += excess
      }
    }
  }

  text(): string {
    const body = Buffer.concat(this.chunks).toString("utf8")
    if (this.dropped === 0) return body
    // At the head, where it is out of the way of the tail the stall signature
    // reads, and in band because `TestOutcome` has nowhere else to say it.
    return (
      `[kantan: ${this.name} truncated - dropped the first ${this.dropped} bytes, ` +
      `kept the last ${MAX_OUTPUT_BYTES}]\n${body}`
    )
  }
}
