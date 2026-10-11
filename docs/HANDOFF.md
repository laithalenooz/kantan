# Handoff

Facts a later task needs that no spec states and no agent can infer from the code.

**Discipline, or this file rots:** entries are added when a task ends, and **deleted when the
task that needed them consumes them**. An entry that no longer matches the code is worse than no
entry. If you find one that has drifted, fix or delete it in the same commit as the work.

Stable project-wide rules live in `CLAUDE.md`, not here. This file is only the moving parts.

---

## Open: things later tasks must handle

### `CLAUDE_BIN` binds at module load — Task 5 (fake binary), anything spawning
`src/version.ts` resolves `process.env.ORCH_CLAUDE_BIN` **once, when the module is imported**.
Setting `process.env` inside a test body is a no-op. Any test that substitutes the binary must set
it in the environment of a **fresh process**. `test/version.test.ts` does this and the pattern is
worth copying.

Also: `test/version.test.ts`'s first test calls the real binary and asserts an `X.Y.Z` version. If
a later task installs the fake CLI suite-wide (preload, `bunfig`, env), **the fake must answer
`--version` with a version string** or that test breaks for a confusing reason.

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

### The fake binary must answer `--version` — Task 5
`test/version.test.ts`'s first test calls the real binary and asserts an `X.Y.Z` string. If Task 5
installs the fake CLI suite-wide (preload, `bunfig`, env), **the fake must print a version** or
that test fails for a confusing reason. `claudeVersion()` now reports exit code and stderr, so a
fake that exits non-zero will at least say so.

### Fixtures are redacted, and the redaction is not optional — Task 5 and anyone recapturing
`test/fixtures/` holds real captures with synthetic `rate_limit_info`. A recapture **must** rerun
both redaction passes; the telemetry pass is the one no grep will remind you about. See
`test/fixtures/README.md`.

### `tickTask` returns its input unchanged for an already-ticked task — Task 13 (phase machine)
Idempotent on purpose, so a retried run cannot disturb a finished file. **A caller that logs,
commits, or reports "ticked" must compare `out !== src`** rather than assume a write happened.

### `Task.line` is valid only for the string it came from — Task 6b (file I/O), Task 13
`tickTask` re-resolves by ref on purpose. No caller may splice by a cached line number.

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
