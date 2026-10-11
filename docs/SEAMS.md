# Seams

**Temporary. Delete this file when Task 13 lands.**

Twelve modules were built in parallel, each tested in isolation against inputs it chose itself.
Task 13 is the first code that makes them talk to each other. Interfaces agreed on paper rarely
fit on the first try, so this file is where the fit gets checked **as each piece lands**, rather
than all at once when Task 13 starts.

That matters because a mismatch found at review time costs a message to a live agent, and the
same mismatch found at Task 13 costs reopening finished work.

## Already found and resolved

| Seam | Mismatch | Resolution |
|---|---|---|
| `sentinel` ↔ `prompts` | Both carry the `ORCH: done` literal; nothing made them agree. A one-character drift makes every completed phase read as a question, silently. | `sentinel` exports the literals, `prompts` imports them, with a test built from the imported constant. |
| `stream` ↔ the fixtures | `stream` typed the result's text as `string`; the field is **absent** on `error_max_budget_usd`. | Typed optional. The original error was mine: I verified with `.get("result", "")`, which cannot distinguish absent from empty. |
| `sentinel` ↔ `stream` | Two shapes for one thing: `ResultEvent` is `{subtype, is_error, result?}`, `Event` is `{kind:"result", subtype, isError, costUsd, numTurns, text}`. | **No change needed.** `sentinel` reads the **raw wire event**; `stream` produces the **domain event**. Task 13 holds both, so it passes the raw `result` object to `phaseOutcome` and the parsed `Event` to the log and UI. Recorded here because it is invisible from either side. |

## What Task 13 calls, and what it must know

| Module | Surface | The seam fact |
|---|---|---|
| `sentinel` | `phaseOutcome(raw): Outcome` | Takes the **raw** wire result object, not `stream`'s `Event`. Reads **one** event and does not choose which — pass the **last** result of each process, since `result_index` implies there can be several. `blocked.reason` may be `""`. `failed.subtype` may literally be `"success"` when `is_error` is true, so show `is_error` alongside it rather than inventing a label. |
| `stream` | `parseStream(source): AsyncGenerator<Event>` | Emits `unknown` for unrecognised events rather than dropping them, so the UI must render that kind rather than assume exhaustiveness. `parse_error` is normal input, not a throw. |
| `prompts` | `planPrompt`, `implementPrompt`, `feedbackPrompt` | `planPrompt` needs the dictated `planPath`; the same path goes into the `phase` log record so the gate can render it. `implementPrompt` needs `planPath` because implement is a **separate conversation** and inherits no context. `feedbackPrompt` resumes the **plan** session. |
| `backlog` / `featurefile` | `parseFeature`, `tickTask`, `listFeatureFiles` | `tickTask` is idempotent: compare `out !== src` to know whether a write happened. Ref-less tasks **cannot be ticked** — Task 13 must decide to assign refs or refuse them. `Task.line` is valid only for the string it came from. |
| `projects` | `loadProjects`, `addProject`, `defaults` | Rejects unknown fields. Adding one is a three-file change. `defaults()` throws on unknown keys, so the HTTP layer maps that to 4xx, not 500. |
| `permissions` | `deriveAllowedTools` | `bypassPermissions` omits the flag entirely. Denials arrive in `permission_denials` on the result event and must be surfaced by name. |
| `testrun` | `runTests(project)` | Returns the raw outcome only; deliberately computes no signature. **Rejects** for a misconfigured path, resolves for a failing command. Timeout is exit `124`, signal death `128 + signal`, so `exitCode` is never 0 unless the command exited 0. Output is the **tail**, capped 1 MiB, with a truncation marker prepended at the head whose byte count varies run to run. |
| `stall` | `failureSignature(outcome)` | Task 13 combines it with `testrun`. Three identical consecutive signatures mean escalate effort, not interrupt. |
| `git` | repo guards, branch, lock | Branches from a **recorded base**, never from whatever is checked out. The dirty check applies to **new** runs only, never to resuming a run on its own branch. |
| `runlog` | append, replay | `cli` payloads nest **byte-identically**, by splicing the raw stdout line — so `appendCli` takes the line **without** its terminator and refuses a trailing newline rather than trimming it. `implementSessionId` is **not** in the header; it rides `PhaseRecord.sessionId`, which must be written on every spawning phase. `replay({follow:true})` ends **only on abort**, never at `end`. |

## The resource leak, closed by Task 17

`replay({ follow: true })` never ends on its own, not even at the `end` record, so the SSE handler
had to abort on client disconnect or every closed tab would leave a poller and an open file
descriptor behind — including on runs that have already finished. Nothing in the type signature
hints at this.

**Done in `src/server.ts`.** `runLogBody` wires one `AbortController` to both `req.signal` and the
stream's `cancel` (Bun fires both on disconnect, probed), and the stream also stops at the `end`
record so a tab on a finished run leaves nothing polling. Proven rather than assumed: removing the
abort wiring fails `test/server.test.ts`'s descriptor test, and forcing `isTerminal` to `false`
fails three more. Anything else that follows a run log — a future log viewer — owes the same abort.
**Task 18's actions do not**: none of them reads a run log at all, which is the same reason the
server appends no `human` record.

## The run-log header is load-bearing in ways its type does not show

`src/runindex.ts` reads it to build the task tree, and three fields have constraints nothing
enforces:

| Field | Constraint | What breaks |
|---|---|---|
| `projectPath` | the path **as registered in `projects.json`**, never git's resolved `Repo.root` | `requireUsableRepo` resolves symlinks; `projects.json` stores what the user typed. Write the resolved root and **every log for a symlinked project is skipped as unregistered**, so the project silently vanishes from the tree |
| `featureFile` | repo-relative | `taskBranchName` throws and the row has no branch |
| `taskRef` | non-blank | same |

`TaskStatus` is keyed on **`(projectPath, featureFile, taskRef)`**. Keying on the ref alone merges
two different tasks, because every feature file has a `T1`, and newest-wins then hides one.

**`featureFileHash` is underspecified and Task 13 owns it.** No algorithm, no stated input, and
`tickTaskInFile` takes a `FeatureFile` rather than a hash — so the comparison the field exists for
does not exist yet. Hash the **raw bytes**: `src/featurefile.ts` preserves a BOM and CRLF on
purpose, and decoding normalises exactly the differences that prove a human edited the file.

## The two ids that fail silently

A run owns `planSessionId` and `implementSessionId`. Passing the wrong one runs the implement
prompt inside the planning conversation and still exits `success`. **There is no error to catch.**
Task 13 must carry which session each phase belongs to rather than reconstructing it.

## Expectation

Task 13 will take several rounds, and that is the design working rather than failing. Going wide
trades late seam discovery for parallel progress; the trade was made deliberately and the cost
lands here.

## Task 18 ↔ Task 13: the `Runner` seam, and three mismatches already visible

`src/run.ts` did not exist when the actions were written, so `src/server.ts` declares what it needs
and takes it as a constructor dependency (`ServerOptions.runner`, `RouteContext.runner`), with the
tests injecting a double. Absent means a server that serves pages and streams logs but answers
**503** on every action — which is what `bun run src/server.ts` is until someone wires a machine in
`import.meta.main`.

```ts
interface Runner {
  start(request: { projectPath: string; featureFile: string; taskRef: string }): Promise<Started>
  approve(runId: string): Promise<Acted>
  feedback(runId: string, text: string): Promise<Acted>
  stop(runId: string): Promise<Acted>
}
type Started = { ok: true; runId: string } | Refused
type Acted = { ok: true } | Refused
interface Refused { ok: false; refusal: Refusal; message: string }
type Refusal =
  | "unknown-project" | "unknown-feature" | "unknown-task" | "unknown-run"  // 404
  | "busy" | "dirty" | "wrong-state"                                        // 409
```

Four promises the interface makes, which the server depends on: an expected refusal is a **tagged
result and not a throw** (a throw is a fault, logged, 500); each call resolves **once the
transition is accepted**, not when the phase finishes; the machine owns the state rule, so the
server never reads the log or the index to decide a 409; and the machine is the **only writer** of
a run log, so the server appends no `human` record.

`src/run.ts` as it stands exports `startRun(StartRunOptions)`, `approveGate(ActionOptions)` and
`sendFeedback(ActionOptions & {feedback})`. Three gaps between that and the above — none of them a
defect in either side, and all three cheaper to resolve now than at the wiring:

| Mismatch | Why it matters | Where it is cheapest to fix |
|---|---|---|
| **Entry points resolve only when the run parks.** `run.ts`'s own header says so: "every entry point here returns only once the run is parked at a human, finished, or interrupted". | A plan phase runs for minutes and an HTTP request cannot wait for one — probed, Bun cuts a connection idle for 10s, and everything after the transition reaches the client on the run stream anyway. So the adapter must **not** await the promise before answering. But "accepted" is not observable from it: `dirty` and `busy` are decided inside, after the request would have been answered. | `run.ts`, by reporting acceptance separately from completion — e.g. resolving to `{runId, finished}` or taking an `onStarted`. `StartRunOptions.runId` already lets the caller mint the id, which is half of it. |
| **Refusals are thrown, not tagged.** `requireRest` throws for the wrong rest state, `requireRef` for a ref-less task, `requireUsableRepo` and `requireCleanTreeForNewRun` for the repo, `rehydrate` for an unknown run. | The server needs `dirty` and `busy` to be different 409s and `unknown-run` to be a 404. Classifying by reading an `Error` message breaks the day a sentence is reworded, and that is the one failure a test written against the current wording cannot see. | `run.ts`, with one error class carrying a `Refusal` code. The messages are already the right prose; only the tag is missing. |
| **`ActionOptions` wants a `Project` for every action**, not just for `start`. | `Runner` passes `runId` alone. Someone must map `runId → Project`, which means the run log header's `projectPath` and then `projects.json`. | The adapter, not the server: a server that read the run log to find a project would be the second place the state rule lives, and `server.ts` deliberately imports nothing from `projects.ts`. This is also where `loadProjects`' and `defaults()`' throws become a 4xx/5xx. |

Four things already agree, worth recording because they were reached from opposite ends:

- `RunState.interrupted` says "The child was killed. No `end` record, so the run stays resumable" —
  exactly what the stream needs, since `isTerminal` stops **every** connection at `end`, reconnects
  included, so an `end` written for a stop would make a resumed run's later records unreachable for
  ever.
- `test/run.test.ts` has "stopping at the gate releases the lock and leaves the run resumable",
  which answers the one question `Runner.stop`'s doc comment left open: what stopping means for a
  run that holds no process. The project stops being `busy` because the lock goes.
- `sendFeedback` resumes the plan session, as `feedbackPrompt` requires.
- **The `featureFile` escape is checked where the seam says it must be.** `StartRequest` is a path
  from a request body that `tickTask` later writes through, and the server deliberately does not
  judge it. `repoRelative` in `src/run.ts` resolves it against `project.path` and refuses `""`, a
  `..` escape and an absolute path outside the repo, naming the file. It **throws**, so it needs the
  tag from mismatch two above or an escaping path is a 500 rather than the 404 it should be.

One open question neither side owns yet: `requireRest(run, ["gate"], …)` accepts **only**
`waiting(gate)`, but design §3.2 and Task 23 route an unanswered `waiting(question)` to the same
reply box. Either feedback accepts both rest states or the UI needs a second route; `feedbackPrompt`
says "a human read that plan at the gate", so it is a prompt question as much as a routing one.
