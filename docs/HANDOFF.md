# Handoff

Facts a later task needs that no spec states and no agent can infer from the code.

**Discipline, or this file rots:** entries are added when a task ends, and **deleted when the
task that needed them consumes them**. An entry that no longer matches the code is worse than no
entry. If you find one that has drifted, fix or delete it in the same commit as the work.

Stable project-wide rules live in `CLAUDE.md`, not here. This file is only the moving parts.

---

## Open: things later tasks must handle

### `CLAUDE_BIN` binds at module load — anything spawning
`src/version.ts` resolves `process.env.ORCH_CLAUDE_BIN` **once, when the module is imported**.
Setting `process.env` inside a test body is a no-op. Any test that substitutes the binary must set
it in the environment of a **fresh process**. `test/version.test.ts` and
`test/fake-claude.test.ts`'s `claudeVersion()` test both do this; the pattern is worth copying.

### Adding a field to `Project` is a three-file change — every later task
`src/projects.ts` **rejects unknown fields**, on load and in `defaults()`. Any task adding a field
must extend `Project`, `FIELDS` and `validateProject` **together**, or every load throws on the
tool's own writes. Per-project permission settings are the likely first case.

The strictness is deliberate: a misspelled *optional* key (`configdir`) reads as absent and is
dropped on the next write, which a missing-field check cannot catch because the field is optional.
Verified: it throws naming the file, record index, bad key and the full allowed set.

### `defaults()` throws on unknown keys — Task 18 (HTTP actions)
It will receive parsed request bodies. The HTTP layer must turn that throw into a **4xx, not a
500**: it is the caller's typo, not a server fault.

### `projects.json` has no cross-process lock — nobody, unless kantan grows a second process
Writes are serialised in-process only, which is sound for one local server. A second process can
still lose an update, though `rename` means the file is never left truncated. Also: no directory
`fsync` after the rename, so a power loss can lose the newest write but never corrupt the file.
Crash-left `.tmp` files are ignored on read and never cleaned up.

### `project.path` is only lexically normalised — Task 12 (git guards)
`/repo/` and `/repo` collapse to one record, but **two symlinked spellings of one repo remain two
records**, and nothing checks that the path exists or is a git repository. Task 12 owns the "is
this a usable git repo" question, and should expect to be handed a path that is neither.

`reportPath` may contain `..`; refusing it would mean guessing at monorepo layouts, so the code
that joins it owns that check.

### Driving the fake binary — Tasks 8 through 14
`test/fake-claude.ts` is executable with a `bun` shebang, so `ORCH_CLAUDE_BIN=<abs>/test/fake-claude.ts`
is all a spawner needs. It answers `--version` with `2.1.296 (Claude Code)` before validating
anything else, so installing it suite-wide leaves `test/version.test.ts` passing.

- **`ORCH_FAKE_SCRIPT`** names a `{"turns":[{"fixture":"...","cost":0.01}]}` file. The turn list is
  consumed **across processes** through `<script>.cursor`, because a run spawns the binary once per
  phase plus once per escalation and they all inherit one environment. **Give every test its own
  script path**, or it inherits the previous test's cursor.
- **`ORCH_FAKE_ARGV_LOG`** appends a `kind:"spawn"` record per invocation (`argv`, `cwd`, `pid`,
  `env`, `envKeys`) and a `kind:"turn"` record per turn (`index`, `fixture`, `session`, raw
  `stdin`). Env **values** are recorded only for `CLAUDE_*`/`ORCH_*` names that do not look like
  credentials; every name appears in `envKeys`, so an absence assertion is still meaningful.
- **`CLAUDE_CONFIG_DIR` leaks in from the developer's own shell** through `{...process.env}`. A test
  asserting it is unset must delete it explicitly, or it passes for the wrong reason on one machine
  and fails on another.
- **Exit 1 is the CLI's, exit 2 is the double's.** 1 means a refusal the real CLI also makes
  (probed: unknown flag, missing `--verbose`, non-UUID session id, `--max-budget-usd` ≤ 0,
  unknown `--resume` id) or a replayed error result. 2 means the harness is wrong (bad script,
  missing fixture, more stdin turns than scripted, a non-`user` stdin message).
- **Unknown flags are refused.** A task that adds a flag must add it to the enumeration in
  `test/fake-claude.ts` in the same change; the refusal lists what the double knows.
- **`result_index` and every `uuid` replay as captured.** Two turns in one process both report
  `result_index: 0` and repeat the capture's event uuids. Do not key dedup on them.
- A `cost` override rewrites `total_cost_usd` only. The per-model `modelUsage[*].costUSD` figures
  stay as captured, so cost arithmetic must not read those.
- Replaying a full fixture on turn 2 re-emits the `SessionStart` hook prefix, which the real CLI
  emits once per process. Harmless for a parser, confusing in a transcript.

### Fixtures are not byte-for-byte the CLI's output — Tasks 6 and 7
Task 4's redaction pass re-serialised every line through Python, so the committed fixtures carry
`"key": "value"` spacing and are **pure ASCII** with `\uXXXX` escapes, where the real CLI emits
compact JSON with raw UTF-8. Two consequences: no chunk boundary inside a fixture can ever split a
multi-byte character, so a parser that decoded each read independently would pass against them and
corrupt real output — use `ORCH_FAKE_CHUNK` against a UTF-8 fixture of your own, as
`test/fake-claude.test.ts` does; and never assert that re-serialising a parsed event reproduces the
fixture's bytes.

### Fixtures are redacted, and the redaction is not optional — anyone recapturing
`test/fixtures/` holds real captures with synthetic `rate_limit_info`. A recapture **must** rerun
both redaction passes; the telemetry pass is the one no grep will remind you about. See
`test/fixtures/README.md`.

### `tickTask` returns its input unchanged for an already-ticked task — Task 13 (phase machine)
Idempotent on purpose, so a retried run cannot disturb a finished file. **A caller that logs,
commits, or reports "ticked" must compare `out !== src`** rather than assume a write happened.

### `Task.line` is valid only for the string it came from — Task 6b (file I/O), Task 13
`tickTask` re-resolves by ref on purpose. No caller may splice by a cached line number.

### A run has TWO session ids and using the wrong one fails silently — Task 13
`runId` names the run. `planSessionId` and `implementSessionId` are separate conversations, and
`--session-id` takes a UUID so neither can be derived from `runId`. Gate feedback resumes the
**plan** session; effort escalation resumes the **implement** session.

Resuming the wrong one runs the implement prompt against the planning conversation and still
exits `success`. **There is no error to catch**, so the phase machine must carry which session
each phase belongs to rather than reconstructing it. `implementSessionId` is minted at gate
approval, so a run abandoned at the gate never has one. Design §3.1 has the table.

### Ref-less tasks cannot be ticked at all — Task 13 must decide
`tickTask(src, ref)` addresses by ref, so a `- [ ] just text` line is unreachable. Either assign
refs on ingestion (Task 26b's drafter is the natural place) or refuse ref-less tasks with a clear
message. Silently skipping them is the one option that is not acceptable.

### Fenced code blocks are not parsed — deliberately deferred
Inside the task-list region, a `#` comment in a fence ends the region and hides every task after
it, and a column-zero `- [ ] T7` in a fence parses as a real task and can be ticked. A feature
file is unlikely to fence a checkbox. Revisit only if it bites.

### Byte preservation ends at the string boundary — Task 6b (file I/O)
`src/backlog.ts` guarantees exact bytes in and out as **strings**. Carrying that to disk is
Task 6b's job: no newline normalization, no CRLF conversion, no BOM stripping, no trailing-newline
insertion, atomic write via temp-file-plus-rename, and a re-read compare immediately before
writing because the human may have edited the file mid-run.

### Known cosmetic gap in `parseFeature`, accepted — nobody
A document opening with `---` as a thematic break, whose title sits after the task list, reports
an empty title. Tasks are unaffected. Every candidate fix is another classification heuristic in
the exact spot where two heuristics already regressed, so the gap was chosen over a third guess.

### Captured fixtures carry account telemetry — Task 4
A real `rate_limit_event` holds the capturing account's window utilization, reset timestamps and
overage status. **No name-based grep will find it, because it contains no names.** Task 4 has the
replacement snippet; do not skip it. This repo is open source.

---

## Settled: decisions with non-obvious reasons

| Decision | Why it is not the obvious thing |
|---|---|
| Hook events are filtered for display but the run log stays **raw** | The log doubles as permanent history and replay source. Filtering on write would make it unreplayable against a future parser. |
| `system/thinking_tokens` exists and is **not** hook noise | Found only by inspecting real captures. Easy to lose to a `startsWith("hook")` filter, which is why Task 6 uses an allowlist. |
| `error_max_budget_usd` returns an **empty** `result` string | So the sentinel parser must tolerate empty text, and an error subtype outranks any sentinel. |
| Cost resets per process, not per run | `--max-budget-usd` bounds one process. A resumed process reports only its own spend, which includes re-reading history. Sum the **last result of each process**; summing every result inside one process double-counts. |
| The effort ladder stops at `xhigh`, not `max` | Anthropic's FrontierCode figures show Sonnet 5.5 scoring **lower at Max than at xhigh**. The top setting is worse, not just dearer. |
| Escalating effort requires a respawn | `--effort` is spawn-time. `--resume` accepts a different one and keeps context (probed). |
| The rate-limit banner keys on `status`, never `overageStatus` | Every normal probe event carried `overageStatus: "rejected"` with `org_level_disabled`, which only means overage cannot be bought. A banner on that field fires constantly. |
| One active run per project, one branch per task | Serialization is the collision guard. Per-run worktrees also work but proliferate, and a task maps to one branch. |
| A malformed `projects.json` throws rather than being replaced | It is the only state not reconstructible from the user's repos. |
