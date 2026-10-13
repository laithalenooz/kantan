/**
 * The run-log stream: Server-Sent Events, and the one route that serves them.
 *
 * Moved from `src/server.ts` unchanged. It is the only streaming route in the
 * app and it carries three facts that nothing else does - the explicit `eof`
 * frame, the abort wiring, and the liveness read - so keeping them together and
 * away from the request/response routes is most of the value of this split.
 *
 * **The abort is the load-bearing part**, and its comment says why at length:
 * `replay({ follow: true })` ends only on its signal, so without it every
 * closed tab leaves a poller and a file descriptor behind. Nothing in
 * `replay`'s signature hints at that, which is exactly why the explanation
 * travels with the code.
 */

import { stat } from "node:fs/promises"

import { replay, runLogPath } from "../runlog"
import type { RunRecord } from "../runlog"
import type { RouteContext } from "./context"
import { refuse } from "./guards"

// --- The run stream ---------------------------------------------------------

/**
 * `text/event-stream`, plus everything needed to stop something between us and
 * the browser from holding on to it. A reverse proxy is not part of this
 * design, but someone will put one there, and a buffered SSE stream looks like
 * a hung run rather than a misconfiguration - so `X-Accel-Buffering` is cheap
 * insurance against a bug report nobody can reproduce.
 */
const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  // A cached run stream would replay a finished run as though it were live.
  "Cache-Control": "no-store",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
}

/**
 * An SSE comment: a line every client must ignore, so it can never arrive as a
 * record. Sent on a timer because a run waiting at the gate is idle for as long
 * as the human takes, and an idle connection is what a proxy or a browser
 * reclaims.
 */
const SSE_KEEP_ALIVE = ": keep-alive\n\n"

/** One message for every way an existing-looking id turns out to name no log,
 * so a missing file and a file that is not one read the same. */
export const NO_SUCH_RUN = "no such run: there is no log for that run id"

/**
 * **One SSE event per log record**, named `record`, carrying the record itself.
 *
 * Not one event name per `kind`. The log's own rule is that a record whose kind
 * this version does not know passes through rather than being dropped, and an
 * `addEventListener` per kind has no listener at all for a kind a newer writer
 * invented - the record would arrive and vanish. So the name is constant and
 * the client switches on `data.kind`, where an unknown kind is visible.
 *
 * **Not batched**, though a run can emit thousands of records. Batching would
 * put a second framing layer on top of the one `runlog.ts` already does, with
 * its own boundary to lose or duplicate a record at - and that boundary is the
 * one place a stream like this actually breaks, which is why `replay` was left
 * owning partial lines alone. What batching buys is fewer client-side event
 * dispatches during the initial replay; what it costs is the invariant that one
 * record on disk is one event on the wire. The UI virtualises the list, so its
 * render cost is already independent of the record count, and coalescing state
 * updates is something it can do on its own side without the transport having
 * to guess a batch size.
 *
 * There is deliberately **no `id:` field**. An id invites `Last-Event-ID`,
 * which is the reconnect state machine design §4.4 rejects: replay is from byte
 * 0 every time, so there is no cursor to get wrong.
 */
export function sseFrame(event: string, data: unknown): string {
  // One `data:` line is always enough: JSON.stringify escapes U+000A and
  // U+000D, so a serialised record can hold neither the newline that would end
  // the line nor the blank line that would end the event.
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/**
 * Whether the stream should stop after this record.
 *
 * `replay` deliberately does not stop at `end` - deciding a record is terminal
 * is interpretation, and `runlog.ts` is framing - so this is where the
 * interpretation belongs. The dimension is `kind === "end"`, whose values are
 * the six kinds this version writes plus any a newer writer invents, and the
 * two directions are nowhere near symmetric:
 *
 * - **Stop when a record still follows on disk.** That record never reaches a
 *   client, and never will, since a reconnect replays from byte 0 and stops at
 *   `end` again. Nothing in kantan writes past `end`: the run is
 *   over and the log is closed. The cost is bounded and visible.
 * - **Never stop.** A poller and an open file descriptor per connection, for
 *   the life of the process, including on *finished* runs - which is the common
 *   case, because browsing history opens them. It accumulates silently in
 *   ordinary use, which is the worst shape a leak can have.
 *
 * So this fails toward stopping. Waiting a grace period after `end` to drain a
 * late append was rejected: it swaps a rule for a timing guess, against a case
 * that does not exist.
 */
export function isTerminal(record: RunRecord): boolean {
  return record.kind === "end"
}

/**
 * `runLogPath`'s answer for `id`, or `null` where it refuses the id.
 *
 * `runLogPath` throws for an id that could name anything but a file directly
 * inside the runs directory. Every `:id` route runs it, including the three
 * actions that never open the file themselves: the id reaches them from a URL,
 * so it is caller input, and the alternative to deciding here is handing the
 * machine an id it would pass to `runLogPath` itself - where the throw becomes
 * a rejected promise inside a route, which is a 500 saying nothing.
 */
export function runLogPathFor(id: string, runsDir: string): string | null {
  try {
    return runLogPath(id, runsDir)
  } catch {
    return null
  }
}

/** `runLogPath`'s own message is not forwarded: it quotes the id back and names
 * the runs directory, and `refuse` echoes neither caller-chosen text nor a
 * local path into a body a page may be able to read. */
export const UNUSABLE_RUN_ID = "refused: that is not a usable run id"

/**
 * The run stream: the whole log from byte 0, then the records appended after
 * that, as SSE.
 */
export async function streamRunLog(req: Request, ctx: RouteContext, id: string): Promise<Response> {
  const path = runLogPathFor(id, ctx.runsDir)
  if (path === null) return refuse(400, UNUSABLE_RUN_ID)

  // Before the stream opens, not inside it. Once a 200 and the SSE content
  // type are on the wire the status cannot be taken back, so a missing log
  // would become a stream that opened and immediately died - and a run id
  // arriving from a URL makes "no such run" a common case, not a rare one.
  // The gap between this and `replay`'s own open can only be closed by a
  // delete, which then shows up as the stream ending.
  // `isFile` and not merely "exists": a directory opens for reading on Linux
  // and only fails at the first read, which would be a 200 that dies. A run
  // log is always a regular file, so refusing anything else costs nothing.
  try {
    if (!(await stat(path)).isFile()) return refuse(404, NO_SUCH_RUN)
  } catch {
    // Never echoes the id: that is caller-chosen text.
    return refuse(404, NO_SUCH_RUN)
  }

  return new Response(runLogBody(path, req, ctx), { headers: SSE_HEADERS })
}

/**
 * **The abort is the load-bearing part of this function.**
 *
 * `replay({ follow: true })` ends only on its signal - never at the `end`
 * record - so without an abort every closed tab leaves a poller and an open
 * file descriptor behind, on runs that have already finished as well as live
 * ones. Nothing in `replay`'s type signature hints at it.
 *
 * Probed: Bun aborts `req.signal` *and* calls the stream's `cancel` when the
 * client goes, so both are wired to the same abort. One would do; neither is a
 * place to be clever, because the failure is invisible until descriptors run
 * out.
 */
function runLogBody(path: string, req: Request, ctx: RouteContext): ReadableStream<Uint8Array> {
  const abort = new AbortController()
  const stop = () => abort.abort()
  req.signal.addEventListener("abort", stop, { once: true })

  const bytes = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // Probed: Bun flushes the headers and every enqueued chunk while start()
      // is still pending, so the replay can live here rather than in `pull`.
      const keepAlive = setInterval(() => send(controller, bytes.encode(SSE_KEEP_ALIVE)), ctx.streamKeepAliveMs)
      try {
        for await (const record of replay(path, { follow: true, signal: abort.signal, pollMs: ctx.streamPollMs })) {
          send(controller, bytes.encode(sseFrame("record", record)))
          if (!isTerminal(record)) continue
          // The record itself went first, so nothing is withheld from the fold
          // of the log. This frame is how "the run is over, stop reconnecting"
          // is said out loud: a stream that merely drops is indistinguishable
          // from a dropped connection, which EventSource is right to retry.
          send(controller, bytes.encode(sseFrame("eof", { reason: "end" })))
          break
        }
      } catch (e) {
        // A read that fails mid-stream - the log deleted under us, most
        // likely. The client cannot act on the reason and gets no `eof`, so it
        // reconnects and meets either a working stream or a 404 that says so
        // plainly. Logged rather than swallowed, because this is a local
        // server and its terminal is where a surprise belongs.
        console.error(`run stream ${path} stopped early:`, e)
      } finally {
        // Leaving the loop any other way than by the signal still aborts it,
        // or `replay` would be left polling a file nobody reads.
        //
        // No test pins this line: `break` happens while the generator is
        // suspended at its `yield`, so the implicit `return()` runs replay's
        // own `finally` and closes the descriptor either way - removing this
        // leaves the suite green (proven). It stays because that argument
        // depends on where the generator happens to be suspended, and the
        // failure it would cause is a descriptor that nothing ever closes.
        stop()
        clearInterval(keepAlive)
        try {
          controller.close()
        } catch {
          // Already closed, because the client went away first.
        }
      }
    },
    cancel: stop,
  })
}

/** Enqueues unless the client has already gone, in which case there is nothing
 * to do and nothing to report: the disconnect arrives through `cancel` and
 * `req.signal` regardless. */
function send(controller: ReadableStreamDefaultController<Uint8Array>, chunk: Uint8Array): void {
  try {
    controller.enqueue(chunk)
  } catch {
    // The stream is closed or errored.
  }
}
