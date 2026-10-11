# stream-json fixtures

Real `claude -p --output-format stream-json` output, captured against **Claude Code 2.1.296**,
2026-10-11. Redacted (see below), which also re-serialised every line: these files carry
`"key": "value"` spacing and are pure ASCII with `\uXXXX` escapes, where the CLI itself emits
compact JSON with raw UTF-8. Every **value** is the capture's, but the bytes are not.

These exist so the phase machine, gate, resume logic, stall detector and budget arithmetic can be
tested at **zero API cost**. Task 5 builds a fake `claude` binary that replays them.

| Fixture | Events | Proves |
|---|---|---|
| `plan-success.jsonl` | 43 | A plan phase honouring the sentinel. Final line is exactly `ORCH: done`, the plan was written to the dictated path, and nothing was implemented. Captured on `claude-sonnet-5-5` at effort `high`. |
| `ends-with-question.jsonl` | 30 | A turn that ends in a **question** and still exits `result/success`. `AskUserQuestion` does not exist in `-p`, so the agent asked in prose. **No sentinel.** This is why completion is never inferred from exit status. |
| `budget-exhausted.jsonl` | 26 | `result/subtype = error_max_budget_usd`, `is_error: true`, and **no `result` key at all** (not an empty string: the field is absent). Captured with `--max-budget-usd 0.0001`. |

## What the parser must survive

Counted from these files, not imagined:

| `type` / `subtype` | Why it matters |
|---|---|
| `system/hook_started`, `system/hook_response`, `system/hook_progress` | ~20 per run, arriving **before** the first real message. Noise. |
| `system/thinking_tokens` | Easy to lose to a `startsWith("hook")` filter. **Not noise.** |
| `system/init` | Carries `cwd`, tool and skill counts. |
| `assistant` | `text`, `tool_use` and `thinking` blocks. |
| `user` | `tool_result` blocks, paired back by `tool_use_id`. |
| `rate_limit_event` | Window utilization. |
| `result/success`, `result/error_max_budget_usd` | Terminal. The error subtype outranks any sentinel. **`result` is optional** — absent on the error event, so do not type it as `string`. On `error_max_budget_usd` the only prose explanation of the failure is `errors`, e.g. `["Reached maximum budget ($0.0001)"]`; a UI failure banner needs that field, not the missing text. |

The error event also carries `errors`, `terminal_reason`, `stop_reason`, `permission_denials`,
`result_index` and `queued_turn_count`. `result_index` and `queued_turn_count` imply a process can
emit more than one result event, which matters for cost accounting.

Tool-call paths run to **158 characters**, kept deliberately long so the UI's long-token wrapping
has something real to wrap.

## Redaction

Two passes, because they catch different things. The script is in the implementation plan's Task 4.

**Identifiers**, which a grep finds: home paths became `/home/user`, the capture directory became
a generic long path, and every session UUID became a deterministic SHA-derived stand-in so a
re-run produces identical bytes.

**Account telemetry, which no name-based grep finds.** A real `rate_limit_event` carries the
capturing account's window utilization, reset timestamps, overage status and the reason overage is
unavailable. That is private information about someone's plan and it contains **no identifiers**,
so it survives every name scrub. The whole `rate_limit_info` payload is replaced with synthetic
values that keep the shape.

Cost figures are real and deliberately kept: Task 14 tests budget arithmetic against them, and
what one API call cost is not private.

## Recapturing

The CLI version determines the envelope shape. On a version bump, recapture rather than patch:
the commands are in the implementation plan's Task 4, and every claim in the design doc marked
`(probed)` has a rerunnable script in `docs/probes/`.
