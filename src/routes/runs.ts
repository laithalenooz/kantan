/**
 * The run routes: starting one, and the six things a human can do to it.
 *
 * Moved from `src/server.ts` unchanged. Everything here goes through the
 * `Runner` port rather than `src/run.ts` directly, which is what keeps the
 * phase machine out of this module graph - see `Runner` in
 * `src/http/context.ts` for why that seam is the one interface-with-one-
 * implementation this project allows.
 *
 * `ACTION_STATUS` is the rule worth finding here: `unknown-*` is "no such
 * thing" and a 404, while the rest are "the thing exists and its state says
 * no" - a dirty repo, a busy project, an approval on a run that is not at the
 * gate - which are 409s and not 500s, because the request was well-formed
 * enough to reach a real answer.
 *
 * `liveRunIdFor`, `liveRunFor` and `projectOfRun` are exported: the feature and
 * test routes all refuse while a run is in flight in the same repository, and
 * each needs to ask the same question.
 */

import { requireUsableRepo } from "../git"
import { loadProjects } from "../projects"
import type { Project } from "../projects"
import { replay } from "../runlog"
import type { Acted, Refusal, Refused, RouteContext, Runner, Started } from "../http/context"
import { badBody, nonEmptyString, parseBody, readBody } from "../http/body"
import { noStore, refuse } from "../http/guards"
import { NO_SUCH_RUN, UNUSABLE_RUN_ID, runLogPathFor } from "../http/sse"

// --- The actions ------------------------------------------------------------

/**
 * How a refusal from the machine becomes a status.
 *
 * `unknown-*` is "no such thing", which is a 404. The rest are "the thing
 * exists and its state says no", which is a 409 and not a 500: a dirty repo, a
 * busy project and an approval on a run that is not at the gate are all normal
 * answers that the request itself was well-formed enough to reach. The code
 * travels in the body beside the message, because the three 409s need
 * different UI.
 */
const ACTION_STATUS: Record<Refusal, number> = {
  "unknown-project": 404,
  "unknown-feature": 404,
  "unknown-task": 404,
  "unknown-run": 404,
  busy: 409,
  dirty: 409,
  "wrong-state": 409,
}

export function refuseRun(result: Refused): Response {
  return Response.json({ error: result.message, refusal: result.refusal }, { status: ACTION_STATUS[result.refusal] })
}

export function acted(result: Acted): Response {
  return result.ok ? Response.json({ ok: true }) : refuseRun(result)
}

function noRunner(): Response {
  return refuse(503, "refused: this server was launched without a phase machine, so it cannot drive a run")
}

const START_KEYS = ["projectPath", "featureFile", "taskRef", "allowDirty"] as const

const FEEDBACK_KEYS = ["text"] as const

/** The same single key as feedback, and a separate constant on purpose: the two
 * routes are different actions on different conversations, and sharing the
 * literal would invite sharing the handler. */
const ANSWER_KEYS = ["text"] as const

/** The whole new ceiling, in dollars. One key, and a number rather than a
 * string: see `raiseRun`. */
const RAISE_KEYS = ["budgetUsd"] as const

export const NO_KEYS: readonly string[] = []

export async function startRun(req: Request, ctx: RouteContext): Promise<Response> {
  const runner = ctx.runner
  if (runner === null) return noRunner()

  const body = await readBody(req)
  if ("refused" in body) return body.refused
  const parsed = parseBody(body.text, START_KEYS)
  if ("refused" in parsed) return parsed.refused

  const projectPath = nonEmptyString(parsed.fields["projectPath"])
  const featureFile = nonEmptyString(parsed.fields["featureFile"])
  const taskRef = nonEmptyString(parsed.fields["taskRef"])
  if (projectPath === null || featureFile === null || taskRef === null) {
    return badBody(START_KEYS, "a run is named by a project, a feature file and a task ref, each a non-empty string")
  }

  // **A boolean, strictly.** The one key on this route that is not a string, so
  // it owns a 400 no other start key has. `"true"`, `1` and `"yes"` are all
  // refused rather than coerced: this waives the guard that stops an agent
  // committing over work nobody asked it to touch, and a truthiness check would
  // let `"false"` - which a form serialises readily - waive it. Absent is the
  // ordinary start, which is the only value that may be inferred.
  const rawAllowDirty = parsed.fields["allowDirty"]
  if (rawAllowDirty !== undefined && typeof rawAllowDirty !== "boolean") {
    return badBody(
      START_KEYS,
      "allowDirty is true or false, and says this one run may start even though the repo has uncommitted work; omit it for an ordinary start",
    )
  }
  const allowDirty = rawAllowDirty === true

  const started = await runner.start({
    projectPath,
    featureFile,
    taskRef,
    ...(allowDirty ? { allowDirty: true } : {}),
  })
  if (!started.ok) return refuseRun(started)
  // 201: the run now exists and `runId` is how everything else addresses it,
  // the stream above included.
  return Response.json({ ok: true, runId: started.runId }, { status: 201 })
}

/**
 * The three checks every `:id` action makes before it can act, in the order
 * their answers do not depend on each other: whether this server can drive a
 * run at all, whether the id could name a log, then the body.
 */
type Gate = { runner: Runner; fields: Record<string, unknown> } | { refused: Response }

async function actionGate(req: Request, ctx: RouteContext, id: string, allowed: readonly string[]): Promise<Gate> {
  const runner = ctx.runner
  if (runner === null) return { refused: noRunner() }
  if (runLogPathFor(id, ctx.runsDir) === null) return { refused: refuse(400, UNUSABLE_RUN_ID) }

  const body = await readBody(req)
  if ("refused" in body) return { refused: body.refused }
  const parsed = parseBody(body.text, allowed)
  if ("refused" in parsed) return { refused: parsed.refused }
  return { runner, fields: parsed.fields }
}

export async function approveRun(req: Request, ctx: RouteContext, id: string): Promise<Response> {
  // No keys: a body on this route is refused rather than ignored. Ignoring is
  // the expensive direction - a client that put the human's feedback text on
  // the approve route would silently approve a plan they wanted revised.
  const gate = await actionGate(req, ctx, id, NO_KEYS)
  if ("refused" in gate) return gate.refused
  return acted(await gate.runner.approve(id))
}

export async function feedbackOnRun(req: Request, ctx: RouteContext, id: string): Promise<Response> {
  const gate = await actionGate(req, ctx, id, FEEDBACK_KEYS)
  if ("refused" in gate) return gate.refused

  const text = nonEmptyString(gate.fields["text"])
  if (text === null) return badBody(FEEDBACK_KEYS, "feedback is the human's own text, and must be a non-empty string")

  // Forwarded exactly as sent. It is the user's own words, on their own
  // machine, so this is not an injection boundary in the usual sense; what
  // matters is that nothing interpolates it unsafely, and nothing does.
  // `src/prompts.ts` puts it in a template and `src/spawn.ts` sends that in a
  // stream-json user message on the child's stdin, where `JSON.stringify`
  // escapes every byte - so a newline cannot end the line that frames it, and
  // no shell and no argv is involved anywhere.
  return acted(await gate.runner.feedback(id, text))
}

/**
 * The reply to a run that asked a question, or that parked `blocked`.
 *
 * The same shape as feedback and a different action: `feedback` revises a plan
 * a human read at the gate, this continues work the agent stopped to ask about,
 * and the two go into different prompts. See `Runner.answer` for why one route
 * cannot serve both. The text is forwarded exactly as sent, for the reasons
 * spelled out on `feedbackOnRun`.
 */
export async function answerRun(req: Request, ctx: RouteContext, id: string): Promise<Response> {
  const gate = await actionGate(req, ctx, id, ANSWER_KEYS)
  if ("refused" in gate) return gate.refused

  const text = nonEmptyString(gate.fields["text"])
  if (text === null) {
    return badBody(ANSWER_KEYS, "an answer is the human's own text, and must be a non-empty string")
  }
  return acted(await gate.runner.answer(id, text))
}

/**
 * The new ceiling for a run parked at a human.
 *
 * The one action whose argument is a number, so it owns a 400 no other route
 * has. Accepting input, so CLAUDE.md's rule applies: the dimension is **the
 * value of `budgetUsd` as JSON delivers it**, enumerated rather than sampled -
 *
 * - **Absent**, which includes an absent body and an empty one (probed: Bun
 *   declares `Content-Length: 0` for both, so they are indistinguishable).
 * - **`null`**, which is what `JSON.stringify({ budgetUsd: NaN })` sends, and
 *   the literal `NaN`, which is not JSON at all and is refused one layer up.
 * - **A string**, including a numeric one: that is the shape a text input
 *   produces, and `Number("")` is 0, so coercing would turn a blank field into
 *   a ceiling of zero.
 * - **A boolean, an array or an object**, for the same reason.
 * - **Both infinities**, which arrive as `1e999`: `src/spawn.ts` throws rather
 *   than flooring a non-finite remainder, precisely so a broken total cannot be
 *   hidden.
 * - **Zero, negative zero and any negative figure.** The CLI rejects a
 *   non-positive `--max-budget-usd` (probed, 2026-10-11).
 * - **A finite figure above zero.** Forwarded, however large: an upper bound
 *   here would be a cap nobody asked for, over a figure the human typed.
 *
 * What is **not** checked is whether the figure is a raise. `requireRaise`
 * demands one above both the current ceiling and the spend, and neither is
 * known here - after a raise the ceiling lives in the run's own log, not in
 * `projects.json`. So "not above the ceiling" is the machine's `wrong-state`,
 * which `acted` turns into a 409 carrying its own prose, and this 400 is only
 * for a figure that could never fund anything. Both costs were weighed:
 * over-accepting means the spawn fails later, where the UI cannot attribute the
 * failure to the input that caused it; over-rejecting means a ceiling the
 * machine would have taken is refused, which is why the bound here is only
 * "finite and above zero" and not a guess at the run's state.
 *
 * Neither message echoes the figure, as no refusal in this file echoes caller
 * text, and they are two messages rather than one: "that is not a number" and
 * "that number cannot fund a turn" are different mistakes with different fixes.
 */
export async function raiseRun(req: Request, ctx: RouteContext, id: string): Promise<Response> {
  const gate = await actionGate(req, ctx, id, RAISE_KEYS)
  if ("refused" in gate) return gate.refused

  const figure = gate.fields["budgetUsd"]
  if (typeof figure !== "number") {
    return badBody(RAISE_KEYS, "a raise is the run's whole new ceiling and must be a number of dollars, never a string")
  }
  if (!Number.isFinite(figure) || figure <= 0) {
    return badBody(RAISE_KEYS, "a ceiling must be a finite figure above zero, or it funds no turn at all and the CLI refuses it")
  }
  return acted(await gate.runner.raise(id, figure))
}

/**
 * Picks a killed run back up, which until now nothing could ask for.
 *
 * No keys, like approve and stop, and for the sharper of the two reasons those
 * give: a client that put the human's reply on this route would resume the run
 * **without** it, and the question the agent asked would still be unanswered -
 * so the text would be lost rather than merely ignored. Which phase to continue
 * from is the log's answer, not a client's.
 *
 * Every refusal is the machine's: `unknown-run` for a log that is not there,
 * `wrong-state` for a run that has already finished or is working right now,
 * `busy` for one whose lock another run holds, and `dirty` for a checkout that
 * has moved away from the task's branch with uncommitted work on it. Each
 * carries the guard's own sentence, which is the only guidance available at
 * that moment.
 */
export async function resumeRun(req: Request, ctx: RouteContext, id: string): Promise<Response> {
  const gate = await actionGate(req, ctx, id, NO_KEYS)
  if ("refused" in gate) return gate.refused
  return acted(await gate.runner.resume(id))
}

export async function stopRun(req: Request, ctx: RouteContext, id: string): Promise<Response> {
  const gate = await actionGate(req, ctx, id, NO_KEYS)
  if ("refused" in gate) return gate.refused
  return acted(await gate.runner.stop(id))
}

/**
 * The sentence that refuses a removal because a run of `projectPath` is in
 * flight, or `null` when none is.
 *
 * A skipping guard, so CLAUDE.md's rule applies. The dimension is **what one
 * live run id's log can be read as**, and every value it takes:
 *
 * - **A header naming this project.** Refuse, naming the run.
 * - **A header naming another project.** Ignored: the lock is per repository,
 *   so two projects can be busy at once, and a guard keyed on "anything is
 *   running" would make a removal wait on an unrelated task.
 * - **An id `runLogPath` refuses**, a log that is not there, one whose first
 *   record is not a header, or a read that fails for any other reason. The run
 *   cannot be attributed, so it is refused - see the asymmetry below.
 * - **`liveRunIds` is null**, meaning the launch was given no machine to ask.
 *   Such a server drives no run at all, so there is nothing to orphan and
 *   nothing to refuse; refusing here would make the route unusable on exactly
 *   the launches that cannot be driving anything.
 *
 * The costs are not symmetric. Refusing a removal that would have been safe
 * costs a stop or a restart, both of which the message can ask for. Allowing
 * one that is not costs a run that keeps spending with no route left to stop
 * it, which no later request can undo. So an id this cannot attribute fails
 * toward refusing.
 *
 * "First record, and it must be a header" is `createRunner`'s own rule for
 * attributing a run to a project, deliberately: this check has to refuse
 * exactly when that lookup would resolve the run to this record.
 *
 * It is a read of a file another process is writing, so there is a window
 * between this answer and the removal. It cannot be closed from here - the run
 * registry is the machine's - and it is one request wide against a human
 * clicking two things at once, where the worst case is the case this refuses.
 */
/**
 * The id of a live run in `projectPath`, or `null` when there is none.
 *
 * Split out of `liveRunFor` because two rules now read it and they answer
 * differently: a removal is refused outright, while a draft is written and left
 * uncommitted. Sharing the *lookup* and not the prose is the point - one of
 * these messages is about an unreachable run and the other about a file that
 * would vanish on a branch switch.
 */
export async function liveRunIdFor(ctx: RouteContext, projectPath: string): Promise<string | null> {
  const live = ctx.liveRunIds
  if (live === null) return null
  for (const id of live()) {
    if ((await projectOfRun(id, ctx.runsDir)) === projectPath) return id
  }
  return null
}

export async function liveRunFor(ctx: RouteContext, projectPath: string): Promise<string | null> {
  const live = ctx.liveRunIds
  if (live === null) return null

  for (const id of live()) {
    const owner = await projectOfRun(id, ctx.runsDir)
    if (owner === null) {
      return `kantan is driving run ${id} right now and cannot tell which project it belongs to, so it will not remove one: every action on a run - stop included - finds its project in ${ctx.projectsFile ?? "the project store"} first, and a removed record would leave that run spending with no way to reach it. Stop it, or restart kantan, then remove the project.`
    }
    if (owner === projectPath) {
      return `run ${id} is in flight for ${projectPath}, so removing it now would leave that run unreachable: every action on it - stop included - finds its project in ${ctx.projectsFile ?? "the project store"} first. Stop the run, then remove the project.`
    }
  }
  return null
}

/** The project a run log is attributed to, or `null` where it cannot be read as
 * naming one. The **first** record, and only if it is a header: a header
 * anywhere later is not a log that starts with one, and `src/runindex.ts` and
 * `createRunner` both read it that way. */
export async function projectOfRun(id: string, runsDir: string): Promise<string | null> {
  const path = runLogPathFor(id, runsDir)
  if (path === null) return null
  try {
    for await (const record of replay(path)) {
      return record.kind === "header" ? record.projectPath : null
    }
  } catch {
    // Missing, unreadable, a directory: all "cannot be attributed", which is
    // the refusing direction above. Not logged: this runs on a request, and a
    // log that is gone is not a server fault.
    return null
  }
  return null
}
