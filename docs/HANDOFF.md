# Handoff

Facts a later task needs that no spec states and no agent can infer from the code.

**Discipline, or this file rots:** entries are added when a task ends, and **deleted when the
task that needed them consumes them**. An entry that no longer matches the code is worse than no
entry. If you find one that has drifted, fix or delete it in the same commit as the work.

Stable project-wide rules live in `CLAUDE.md`, not here. This file is only the moving parts.

---

## Open: things later tasks must handle

### A stale `reportPath` makes `failureSignature` report a false stall — Task 13
`src/stall.ts` prefers `project.reportPath` and cannot tell a fresh report from the previous
attempt's. A run that crashed, or was killed by `runTests`' timeout before flushing, leaves the
old XML on disk, where it parses perfectly and names the **previous** attempt's failures. Two
attempts then hash equal, and the detector escalates effort — and finally interrupts a human —
against a run that may have been converging. This is the expensive direction.

`src/testrun.ts` does not touch the file. **Whoever spawns `testCmd` must delete the report
first**, because only that code knows when the run began; an mtime check inside
`failureSignature` would still need to be handed that moment. Nothing in `TestOutcome` dates the
file, so there is no way to catch this later. Delete the **joined** path, per the next two
entries: unlinking `project.reportPath` as stored would either miss the real file, leaving this
bug live, or unlink something of the same name beside the server.

### Two different `TestOutcome` types exist, and they are compatible by luck — Task 13
`src/testrun.ts` and `src/stall.ts` each export an interface of that name. `runTests`' result is
structurally assignable to the signature's, so `failureSignature(await runTests(p))` compiles —
excess property checks only bite on fresh object literals. But `reportPath` lives only on the
`stall.ts` one, so the report branch is **dead unless the caller passes it in**, joined as the
next entry requires: `failureSignature({ ...outcome, reportPath: join(project.path, rp) })`.
Forget it and every signature silently comes from the parsed output, which still works and is
simply weaker. There is no error to catch.

### `failureSignature`'s window must stay well under `MAX_OUTPUT_BYTES` — anyone tuning either
`src/testrun.ts` keeps the last 1 MiB of each stream; `src/stall.ts` hashes the last 256 Ki
**UTF-16 code units** of that, so up to about 768 KB of UTF-8 in the worst case. If the two ever
meet, the signature reaches bytes that a chatty run had already dropped and a quiet one still
had, and one failure hashes two ways depending on how much the suite printed. The marker
`testrun.ts` prepends is normalized in `stall.ts` as well, so the byte counts in it cannot reach
the digest even if the windows do change.

### `reportPath` must be joined with `project.path`, or the JUnit branch never runs — Task 13
`failureSignature` takes an **absolute** path and resolves nothing. `validateProject` **refuses
an absolute `reportPath`** — "reportPath is relative to the repo" — so every stored value is
relative by construction. Passed through as stored, it is read against the **server's** working
directory, missed, and the signature falls back to the parsed output **for every project, always**.
This is not an edge case; it is the whole branch, dead, with no error and no log line. The run
works and the signature is merely weaker, so nothing surfaces it.

The caller joins. It also owns the `..` check, per "Two spellings of one repo still split the
records" below.

### `CLAUDE_BIN` binds at module load — anything spawning
`src/version.ts` resolves `process.env.ORCH_CLAUDE_BIN` **once, when the module is imported**.
Setting `process.env` inside a test body is a no-op. Any test that substitutes the binary must set
it in the environment of a **fresh process**. `test/version.test.ts` and
`test/fake-claude.test.ts`'s `claudeVersion()` test both do this; the pattern is worth copying.

### The fixtures cannot exercise partial multi-byte reads — anyone testing a byte stream
Task 4's redaction re-serialised the fixtures through Python, so they are pure ASCII with
`\uXXXX` escapes where the CLI emits raw UTF-8. **No chunk boundary inside them can split a code
point**, so a parser decoding each read independently passes every fixture test and corrupts real
output. Supply raw-UTF-8 input for that case. Both Task 5 and Task 6 hit this independently.

### A prefix filter passes the entire fixture suite — proven, not theoretical
`src/stream.ts`'s mutation battery showed that `subtype.startsWith("hook")` passes **all 44**
fixture-driven tests, because the fixtures hold only the three known hook subtypes and
`thinking_tokens` does not match the prefix. Only a synthetic `system/hook_invented_future_thing`
test separates an allowlist from a prefix. This is `CLAUDE.md`'s corollary in the flesh: the suite
cannot see what the suite never varied.

### A user-side `text` block must never map to `text` — Task 13 and the UI
`src/stream.ts` routes it to `unknown` on purpose. Echoed prompts and system-reminders arrive as
user text, and **the implement prompt contains the literal `ORCH: done`** — so mapping user text
to `text` would feed the sentinel parser its own prompt and end a phase that never finished.

### `CLAUDE_CONFIG_DIR` leaks in from the developer's shell — Task 8
Spawning with `{...process.env}` inherits it. An "absent when the project names none" assertion
must delete it explicitly, or it passes for the wrong reason on a machine that has it set and
fails on one that does not.

### The fake double does not cover Task 26b's invocation shape — Task 26b
Its Haiku calls are a positional prompt with text or JSON output. The double refuses that by
design, so use the real CLI (Haiku is cheap and both jobs are off the critical path) or a separate
stub. Do not widen the double to a second invocation shape.

### The sentinel literals exist in two places and can drift — Task 13 or whoever notices
`src/sentinel.ts` keeps `ORCH: done` and `ORCH: blocked` module-private, correctly, since its
brief scoped it to one function. `src/prompts.ts` must emit the same literals. **Nothing currently
makes them agree.** Export a shared constant from one side and import it in the other, with a test
that the prompt contains exactly what the parser accepts. Until then a one-character edit to either
breaks every run silently: the agent emits a sentinel the parser does not recognise, so every
completed phase reads as a question.

### A process can emit more than one `result` event — Task 14 (budget)
The error event carries `result_index` and `queued_turn_count`. Cost accounting must take the
**last** result of each process, which is what the existing cost note already implies but did not
explain.

### Adding a field to `Project` is a FOUR-place change — every later task
`src/projects.ts` **rejects unknown fields**, on load and in `defaults()`. A new field must extend
`Project`, `FIELDS`, `validateProject` **and `DEFAULTS`** together, or every load throws on the
tool's own writes. `DEFAULTS` carries a `satisfies`, so forgetting *that* one is a compile error;
the other three are not.

**The absence policy, settled by Task 8b:** a field **younger than the store** loads and defaults,
because a field that did not exist cannot have been typed, so defaulting loses nothing — and the
default is the restrictive direction, where guessing wrong yields a named denial rather than a
silent escalation. A **retired** field is ignored via a documented `RETIRED` set and evaporates on
the next write, because a key the tool no longer honours names no setting anyone can lose. Only
the exact retired name is forgiven; a misspelling still throws. A **misspelled** key still throws
by name, since that is the one case where a value the user did type would be lost.

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

### Two spellings of one repo still split the records — whoever owns project registration
Task 12 consumed the git half of this: the guards resolve to the real root and the lock lives in
`$GIT_COMMON_DIR`, so **two symlinked spellings cannot run at once**. But `projects.json`, the run
logs and the index are still keyed on `project.path`, so the same repo registered twice is two
records with two histories.

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
- **`result_index`, every `uuid`, and every `system/init` field replay as captured.** Only
  `session_id` and `total_cost_usd` are rewritten. So `init` reports the capture's `model`, `cwd`,
  `permissionMode` and `claude_code_version` — `plan-success.jsonl` says sonnet even when the
  spawn passed `--model claude-opus-5-5`. **Assert on the argv log, never on `init`'s fields.**
  Rewriting them was rejected because matching the CLI's alias resolution would be a guess.
  Likewise two turns in one process both report `result_index: 0` and repeat the capture's event
  uuids, so nothing may key dedup on them.
- A `cost` override rewrites `total_cost_usd` only. The per-model `modelUsage[*].costUSD` figures
  stay as captured, so cost arithmetic must not read those. A fixture holding **two** result
  events is refused outright, because within a process those figures are cumulative and the
  double's model is one turn, one result.
- **A hand-written fixture needs a `session_id`, `is_error` and `total_cost_usd` on its result
  line**, and exactly one result event. The permissions task's planned `permission_denials`
  fixture is the first case; `test/fake-claude.test.ts` has several minimal examples to copy.
- **`--allowedTools` takes one value here**, though the real CLI also accepts it variadically. Pass
  the list as a single comma or space separated token; a second bare token stops at the positional
  guard rather than being dropped from the allowlist.
- **A session becomes resumable only once a turn's replay finishes.** A SIGTERM mid-turn leaves the
  turn unspent and the session unresumable, so Task 13's "killed mid-implement is resumable" test
  must kill **between** turns or it meets `No conversation found`. What the real CLI does when
  killed mid-turn is unprobed: probing it costs an API call.
- **The shebang needs `bun` on the child's PATH.** A spawner that passes a curated env without
  `PATH` gets exit 127 from `env`, which looks like neither a CLI error nor a refusal by the double.
- Replaying a full fixture on turn 2 re-emits the `SessionStart` hook prefix, which the real CLI
  emits once per process. Harmless for a parser, confusing in a transcript.

### The double does not emulate the Haiku calls — Task 26b
`draftFeature` and `summarizeStall` are single-turn `claude -p` calls (design §3.5.1), which means
a **positional prompt** and a text or JSON output format. `test/fake-claude.ts` refuses both: it
replays `-p --input-format stream-json --output-format stream-json` only, and exits 2 naming the
positional. Use the real CLI (Haiku is cheap and both jobs are off the critical path) or give those
two functions their own stub. Do not widen the double to cover a second invocation shape.

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

### The mid-run-edit warning is unreachable unless you hold the parse-time bytes — Task 13
`tickTaskInFile(file, ref)` returns `{ written, src, warning }`. `written: false` means the task
was already ticked, with **no disk access**, so mtime is untouched too — compare `written`, never
guess from bytes.

But `warning` only catches edits made since the `readFeature` whose `FeatureFile` you pass. **Call
`readFeature` immediately before ticking and the warning can never fire**, which is exactly what a
resumed run does after a restart. So Task 13 must hold the run's parse-time `FeatureFile`, and the
run log header carries `featureFileHash` so it survives a restart.

Also: an error on an **unchanged** file passes straight through from `tickTask` without the file's
path. Only the changed-file error names it, so Task 13 should add the path when it surfaces one.

### `TextDecoder` strips the BOM by default — anyone decoding a user's file
`ignoreBOM` defaults to `false`, which **removes** the BOM rather than ignoring it. `featurefile.ts`
passes `{ fatal: true, ignoreBOM: true }`; flipping it back made the BOM test fail, so the default
would have silently deleted a BOM on the first tick. `fatal: true` also refuses a non-UTF-8 file
rather than decoding a byte to U+FFFD and writing the replacement back.

### `runTests` rejects for a misconfigured project, resolves for a failing one — Task 13
A missing or non-directory `project.path` **rejects**, because that is a misconfigured project
rather than a failing test, and feeding it to the agent as a failure would spend the budget
fixing tests in a directory that does not exist. Everything else resolves, **including exit 127
for a missing command**. So Task 13 needs one try/catch around it, and Task 12's repo pre-flight
should normally catch that case first.

`exitCode` is never 0 unless the command exited 0: a timeout is `124` (exported as
`TIMEOUT_EXIT_CODE`), a signal death is `128 + signal`. Branch on `exitCode !== 0` alone and treat
`timedOut` as presentation.

### `reportPath` can be absent OR STALE after a timeout — Task 10, Task 13
The timeout kill is SIGTERM then SIGKILL two seconds later, so a runner gets a flush window but no
guarantee. A **leftover XML from the previous run parses fine and reports the wrong failures**,
which is worse than an absent one. The stall signature must fall back to output when the XML is
absent, empty, or stale.

### The plan itself can smuggle in a tick instruction — Task 13
`plan-success.jsonl`'s own final message records that the plan it wrote contained
"**Checkbox:** tick T1 in `docs/features/slugger.md`". So a silent implement prompt is not enough:
**the plan tells the implementer to tick**, and `tickTask`'s idempotence would then make the
server's own tick a no-op that looks like success. Closed from both ends now — the plan prompt
forbids including such a step, and the implement prompt forbids any edit to the feature file.
Probed: the implement phase left the feature file untouched.

### `src/sentinel.ts` now exports `DONE` and `BLOCKED` — anyone emitting a sentinel
`src/prompts.ts` builds its sentinel lines from those exports, so the emitting and parsing sides
cannot drift. `BLOCKED_RE` stays a regex literal and its parsing logic is untouched; the
`BLOCKED` ↔ `BLOCKED_RE` agreement is pinned from outside by `test/prompts.test.ts`, where a
one-character drift fails three tests.

### `TaskSpec.ref` is non-null on purpose — Task 13
Deliberately narrower than `backlog.Task`, so a ref-less task **cannot reach a prompt**. That
forces the open decision (assign refs, or refuse) rather than hiding it.

### `feedbackPrompt` needs the `planPath` from the `phase` record — Task 13
It resumes the plan session and re-dictates that path, so handing it a freshly derived path would
point the agent at a file the gate is not rendering.

### Register routes in `ROUTES`, never in `Bun.serve` — Tasks 17 and 18
`Bun.serve({ routes })` matches **before** the `fetch` fallback, so a route registered there never
meets the guard chain. `src/server.ts` uses one `fetch` handler: Host, then Origin, then token,
then dispatch. A loop over `ROUTES` asserts all three guards for every registered key, so your
routes are covered the moment you add an entry — and `TOKEN_EXEMPT` is asserted to be *exactly*
`["GET /", "GET /api/session"]`, so widening it fails a test first.

Dispatch is exact `METHOD /path` with no percent-decoding or trailing-slash normalisation.
`RouteHandler` and `RouteContext` are exported; do not invent your own.

Task 17 added the matcher, so **a `:name` route is already supported**: register the pattern as an
ordinary `ROUTES` key (`GET /api/runs/:id/stream`) and take the segments from `RouteHandler`'s third
argument, `params`. It is optional, so a static route still takes two. The matcher runs after the
guards and a pattern can never be token-exempt, because the token check keys on the request's own
literal `METHOD /path`, which no pattern is. A `:name` matches exactly one non-empty segment and is
handed over **as sent** — do not decode it: nothing else does, which is the only reason `%2F`
cannot put back the separator the URL parser already resolved away.

`RouteContext` also carries `runsDir`, `streamPollMs` and `streamKeepAliveMs`, resolved from
`ServerOptions` so a handler never consults a default. `runsDir` is what lets a test keep away from
the developer's own `~/.orch/runs`; Task 18's actions will want it for the same reason.

### The run stream's contract, and the two things the UI must do — the UI tasks
`GET /api/runs/:id/stream` sends **one SSE event per log record**, always named `record`, with the
record itself as `data`. Every frame is named, so **`onmessage` never fires**: listen with
`addEventListener("record", …)` and `addEventListener("eof", …)`, then switch on `data.kind` inside
the record handler. Switching on the *event name* instead is the trap — the log's rule is that a
kind this version does not know passes through rather than being dropped, and a listener per kind
would have none at all for a kind a newer writer invented. There is no `id:` field and no batching,
deliberately: design §4.4 replays from byte 0 every time, so there is no cursor, and batching would
add a second framing layer with its own boundary to lose or duplicate a record at.

**One: clear the record state on `open`.** Every connection replays the whole log from byte 0,
reconnects included, so a client that appends without resetting double-renders everything after any
reconnect — and reconnects happen on their own, with no user action to blame it on.

**Two: call `EventSource.close()` on `event: eof`.** The run's `end` record is forwarded first, then
an `eof` frame carrying `{"reason":"end"}`, and then the server closes the stream. A browser treats
a closed SSE connection as a dropped one and reconnects, so a client that ignores `eof` still
renders correctly — given the reset above — but re-reads the whole log every few seconds for as long
as the tab is open. `eof` means "the run is over, stop retrying"; a stream that drops *without* one
is a genuine disconnect and should be retried.

Idle streams carry `: keep-alive` SSE comments, which `EventSource` discards, so they can never
arrive as a record. A run waiting at the gate is idle for as long as the human takes.

One cost, recorded because it is invisible from the client: the stream **stops at the `end` record**,
while `replay` does not. A record appended after `end` therefore never reaches a client and never
will, since a reconnect replays from byte 0 and stops there again. Nothing writes past `end` today;
the alternative was a poller and a descriptor per tab on every finished run.

### `GET` must have no side effects — Tasks 17, 18 and every UI task
`SameSite=Strict` ignores **ports**, so a page on any other localhost port is same-site. Its
no-cors GETs (`img`, `script`, navigation) carry the auth cookie and send no `Origin`. Actions
must be `POST`. A convenience GET that starts a run is reachable from any other local page.

### Four security claims are spec-level, not observed — whoever tests with a real browser
No real browser was involved in Task 16's suite. These are taken from the spec: browsers always
send `Origin` on non-GET/HEAD; browsers lowercase the host; `SameSite=Strict` semantics;
`EventSource` cannot send custom headers. **If any is wrong, the GET/HEAD Origin exemption is the
row that bites.** Worth one real-browser check during Task 25 or 26.

### Call the git guards in `src/git.ts`'s documented order, and release in `finally` — Task 13
The module header gives the call order. **A refusal at steps 3 to 5 otherwise leaves a lock
holding a live pid that nothing reclaims until restart.** That ordering is documented but *not*
tested, deliberately, because building an orchestrator inside Task 12 would have been
over-building. So it is your responsibility, not the module's.

**Resume must NOT call `recordBaseBranch`.** The branch and base come from the run header.
Re-deriving them is both wrong — HEAD is on `orch/*`, which that function refuses — and is the
branch-stacking bug the base discipline exists to prevent.

`taskBranchName` needs `{ feature (repo-relative), ref }`. A ref-less task **throws**, so the open
ref-less decision is still yours.

### `isMergedIntoBase` reports ancestry, not intent — Task 7b, Task 13
So a **squash merge** and a merge made only on the remote both read as **unmerged**. A task
legitimately finished via squash will keep reporting `done, unmerged` and stay unstartable. Decide
whether that is acceptable or needs an override.

### A SIGKILLed server can leave a `claude` child still writing — Task 8 or 13
The run lock judges only the server process, so reclaiming a stale lock can admit a second run
into a tree where an orphaned child is still writing files. Task 11's process-group kill covers
the test command; the agent child is not covered.

### A clean `git status` does not mean a clean repo — Task 13
Probed: a merge resolved back to HEAD's own content leaves `git status --porcelain` **completely
empty** while `MERGE_HEAD` is still set, and the agent's next commit then silently becomes a merge
commit carrying the user's second parent. `src/git.ts` checks `MERGE_HEAD`, `CHERRY_PICK_HEAD`,
`REVERT_HEAD`, `rebase-merge`, `rebase-apply` and `BISECT_LOG` separately for this reason. Do not
add a second porcelain-only check anywhere and treat it as sufficient.

Also probed: **repo config can blind a porcelain check.** `status.showUntrackedFiles=no` hides
untracked files and `diff.ignoreSubmodules=all` hides submodules, so every flag is passed
explicitly. A guard whose blindness is configurable by the repo it guards is not a guard.

### Two readers of `permission_denials` now exist — Task 18, Task 24, whoever logs
`src/stream.ts` passes the field through as a raw `unknown[]`. `src/permissions.ts` exports
`permissionDenials(event)` and `describeDenials(...)`, which name the refused tool. **Call those
rather than re-reading the array**, or the "named, not swallowed" guarantee lives only in Task 8b's
tests and the UI shows a generic failure for what is actually a one-line config fix.

### A stale comment in `src/runlog.ts` mentions `resumePlanSession` — cleanup
Around line 109. The field is gone; the comment explains why a session id is recorded per phase,
and that reason still stands without it. Left alone because Task 7b was editing that file.

### Bun cuts an idle SSE stream at 10s — Task 17
Found by Task 17 before it was paused: **Bun closes an idle response stream after about 10
seconds**, so a keep-alive on a longer interval (15s was the first attempt) never fires and the
browser sees the run stream drop. Any keep-alive must beat that window, and whether an *outgoing*
write resets Bun's idle timer was the open question when the session paused — settle that first,
because if outgoing writes do not reset it, a keep-alive cannot work at all and the stream needs a
different mechanism.

This is the plan gate's exact failure case: a run waiting for a human sits idle for minutes.

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
| `error_max_budget_usd` carries **no `result` key at all** | Not an empty string: the field is absent. So `result` must be typed `string | undefined` (`src/stream.ts` keeps the key present and sets it `undefined`, so absent stays distinguishable from empty), the sentinel parser must never read text on an error event, and an error subtype outranks any sentinel. I originally recorded this as "empty string" because my check used `.get("result", "")`, which cannot distinguish absent from empty. Task 9 caught it. |
| Cost resets per process, not per run | `--max-budget-usd` bounds one process. A resumed process reports only its own spend, which includes re-reading history. Sum the **last result of each process**; summing every result inside one process double-counts. |
| The effort ladder stops at `xhigh`, not `max` | Anthropic's FrontierCode figures show Sonnet 5.5 scoring **lower at Max than at xhigh**. The top setting is worse, not just dearer. |
| Escalating effort requires a respawn | `--effort` is spawn-time. `--resume` accepts a different one and keeps context (probed). |
| The rate-limit banner keys on `status`, never `overageStatus` | Every normal probe event carried `overageStatus: "rejected"` with `org_level_disabled`, which only means overage cannot be bought. A banner on that field fires constantly. |
| One active run per project, one branch per task | Serialization is the collision guard. Per-run worktrees also work but proliferate, and a task maps to one branch. |
| A malformed `projects.json` throws rather than being replaced | It is the only state not reconstructible from the user's repos. |
