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
| `testrun` | `runTests(project)` | Returns the raw outcome only. It deliberately does **not** compute a signature. |
| `stall` | `failureSignature(outcome)` | Task 13 combines it with `testrun`. Three identical consecutive signatures mean escalate effort, not interrupt. |
| `git` | repo guards, branch, lock | Branches from a **recorded base**, never from whatever is checked out. The dirty check applies to **new** runs only, never to resuming a run on its own branch. |
| `runlog` | append, replay | `cli` payloads nest **byte-identically**. The header is written before `implementSessionId` exists. |

## The two ids that fail silently

A run owns `planSessionId` and `implementSessionId`. Passing the wrong one runs the implement
prompt inside the planning conversation and still exits `success`. **There is no error to catch.**
Task 13 must carry which session each phase belongs to rather than reconstructing it.

## Expectation

Task 13 will take several rounds, and that is the design working rather than failing. Going wide
trades late seam discovery for parallel progress; the trade was made deliberately and the cost
lands here.
