/**
 * One spawned `claude -p` process, and how its exit is read.
 *
 * The other half of what `src/run.ts` can give up without creating a cycle
 * (see `src/run/ladder.ts` for the measurement). `PhaseSession` owns a child
 * and the bytes it writes; nothing here knows what a run is.
 *
 * `judge`'s table is the reason this is worth finding on its own. The three
 * dimensions - did a result arrive, what exit code, what signal - have one
 * reading each, and the one that matters is that **a result followed by a
 * signal is `killed`, not clean**: a phase that was cut short while reporting
 * success would otherwise read as having finished, and `code === 0` would tick
 * a task nothing completed.
 */

import { spawnPhase } from "../spawn"
import type { PhaseExit, PhaseProcess, PhaseSpawn } from "../spawn"
import type { ResultEvent } from "../sentinel"
import { phaseOutcome } from "../sentinel"
import type { Outcome } from "../sentinel"
import type { RunLog } from "../runlog"

// ---------------------------------------------------------------------------
// Draining a phase without deadlocking it
// ---------------------------------------------------------------------------

/** A raw wire `result` event: what `phaseOutcome` reads, and the cost figure. */
export interface RawResult extends ResultEvent {
  total_cost_usd?: unknown
}

/**
 * Complete lines of `stream`, as the bytes they arrived as.
 *
 * **The caller must keep reading this to the end or the child wedges.**
 * `plan-success.jsonl` is 93 KB and a pipe buffer is 64 KB, so an unread stdout
 * stops the child mid-write and `exited` never resolves - a run that looks
 * exactly like a stalled agent.
 *
 * Raw lines rather than `src/stream.ts`'s `parseStream`, which is a deliberate
 * deviation from the seam note: the two consumers inside this file both need
 * something `Event` does not carry. `runlog.appendCli` takes the **untouched
 * bytes**, because the `cli` payloads are the replay source for a future
 * parser, and `phaseOutcome` takes the **raw wire result object**. `stream.ts`
 * remains the parser for the UI, which reads these same bytes back out of the
 * log.
 *
 * Split on `0x0A` over the bytes, and each line decoded whole: a newline cannot
 * occur inside a UTF-8 sequence, so no multi-byte character can straddle a line
 * boundary even when the reads do.
 */
async function* rawLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let pending = new Uint8Array(0)
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    const merged = new Uint8Array(pending.length + chunk.length)
    merged.set(pending)
    merged.set(chunk, pending.length)
    pending = merged
    for (;;) {
      const at = pending.indexOf(0x0a)
      if (at === -1) break
      yield decoder.decode(pending.subarray(0, at))
      pending = pending.subarray(at + 1)
    }
  }
  // A final line with no terminator: the process was killed mid-write, or the
  // writer simply did not end with one. Yielded rather than dropped, so a
  // truncated payload is reported by the log's own validation.
  if (pending.length > 0) yield decoder.decode(pending)
}

/** The raw result object a line carries, or `null` for any other line. */
export function resultOf(line: string): RawResult | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null
  const event = value as Record<string, unknown>
  if (event["type"] !== "result") return null
  // The three fields the sentinel reads, plus the cost. `subtype` and
  // `is_error` are taken as they are: a missing `is_error` must not read as
  // `false`, which would let an error event reach the sentinel.
  return {
    subtype: typeof event["subtype"] === "string" ? event["subtype"] : "",
    is_error: event["is_error"] !== false,
    ...(typeof event["result"] === "string" ? { result: event["result"] } : {}),
    total_cost_usd: event["total_cost_usd"],
    // Kept whole so `permissionDenials` can read the field it looks for.
    ...event,
  } as RawResult
}

/** What a turn ended with. */
export type TurnEnd =
  | { kind: "result"; raw: RawResult }
  /** The process ended without answering this turn. */
  | { kind: "ended"; exit: PhaseExit }

/**
 * One `claude -p` process, with its stdout drained concurrently.
 *
 * The drain runs from the moment the process starts, independently of what the
 * loop is awaiting, which is what stops the deadlock: a loop shaped
 * `await exited` *then* parse hangs forever on any real run.
 */
export class PhaseSession {
  private readonly queue: RawResult[] = []
  private last: RawResult | null = null
  private drained = false
  private wake: Promise<void> | null = null
  private wakeNow: (() => void) | null = null
  private readonly pump: Promise<void>
  /** Payload lines the log refused, so a dropped record is reported rather
   * than silent. */
  readonly dropped: string[] = []

  private constructor(
    private readonly proc: PhaseProcess,
    log: RunLog,
    /** What `--max-budget-usd` this process was given, for a message about it
     * after its spend has already been banked. */
    readonly budgetGiven: number,
  ) {
    this.pump = this.drain(log)
  }

  static start(spec: Parameters<typeof spawnPhase>[0], log: RunLog): PhaseSession {
    return new PhaseSession(spawnPhase(spec), log, spec.remainingUsd)
  }

  get argv(): readonly string[] {
    return this.proc.argv
  }

  /** This process's spend: the **last** result's total, which is cumulative
   * within one process and starts over in the next one (design §3.4). */
  get processSpend(): number {
    const figure = this.last?.total_cost_usd
    return typeof figure === "number" && Number.isFinite(figure) ? figure : 0
  }

  private async drain(log: RunLog): Promise<void> {
    try {
      for await (const line of rawLines(this.proc.stdout)) {
        try {
          await log.appendCli(line)
        } catch (e) {
          // Never rethrow: an unreadable line must not stop the drain, or the
          // deadlock is back. A truncated final line from a killed process is
          // the ordinary case.
          this.dropped.push(`${(e as Error).message}`)
        }
        const result = resultOf(line)
        if (result !== null) {
          this.last = result
          this.queue.push(result)
          this.notify()
        }
      }
    } finally {
      this.drained = true
      this.notify()
    }
  }

  private notify(): void {
    const resolve = this.wakeNow
    this.wake = null
    this.wakeNow = null
    resolve?.()
  }

  private settled(): Promise<void> {
    if (this.wake === null) {
      this.wake = new Promise<void>((resolve) => {
        this.wakeNow = resolve
      })
    }
    return this.wake
  }

  /**
   * Sends one turn and waits for its result, or for the process to end.
   *
   * A rejected `send` is **not** rethrown. `src/spawn.ts` refuses a write after
   * stdin closed, and a child that died between turns - killed, or out of
   * budget - is exactly that case: the honest answer is how the process ended,
   * which the loop below reads from `exited` and `judge` classifies. Throwing
   * instead would turn an ordinary ending into a fault.
   */
  async turn(prompt: string): Promise<TurnEnd> {
    await this.proc.send(prompt).catch(() => {})
    for (;;) {
      const next = this.queue.shift()
      if (next !== undefined) return { kind: "result", raw: next }
      if (this.drained) return { kind: "ended", exit: await this.proc.exited }
      await this.settled()
    }
  }

  /** Closes stdin, waits for every byte, and reports how the child ended. */
  async finish(): Promise<PhaseExit> {
    await this.proc.close()
    const exit = await this.proc.exited
    await this.pump
    return exit
  }

  /** The stop button: SIGTERM, then the exit. Stopping costs nothing, because
   * the session resumes from the same id. */
  async kill(): Promise<PhaseExit> {
    const exit = await this.proc.terminate()
    await this.pump
    return exit
  }
}

/**
 * How a phase ended, which is **not** `exit.code === 0`.
 *
 * The dimension is the triple (a last result event, the exit code, the signal),
 * and the two directions cost very differently: advancing a run that did not
 * finish loses work silently, while parking one that did costs a glance.
 *
 * | last result | `code` | `signal` | verdict | why |
 * |---|---|---|---|---|
 * | yes | 0 | `null` | `phaseOutcome(result)` | the ordinary turn |
 * | yes | non-zero | `null` | `phaseOutcome(result)` | budget exhaustion is exit 1 **with** `error_max_budget_usd`, a raisable stop rather than a crash |
 * | yes | `null` | a signal | **killed** | a result arrived and then something killed the process: the phase did not finish, and `code === 0` would have read as clean |
 * | no | any | `null` | **silent** | a CLI refusal: an unknown flag, a non-UUID session, `No conversation found`. stderr is the only evidence |
 * | no | `null` | a signal | **killed** | the stop button, or a crash |
 */
export type Verdict =
  | { kind: "outcome"; outcome: Outcome; raw: RawResult }
  | { kind: "killed"; exit: PhaseExit }
  | { kind: "silent"; exit: PhaseExit }

export function judge(raw: RawResult | null, exit: PhaseExit): Verdict {
  if (exit.signal !== null || exit.code === null) return { kind: "killed", exit }
  if (raw === null) return { kind: "silent", exit }
  return { kind: "outcome", outcome: phaseOutcome(raw), raw }
}
