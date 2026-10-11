# Handoff

Facts a later task needs that no spec states and no agent can infer from the code.

**Discipline, or this file rots:** entries are added when a task ends, and **deleted when the
task that needed them consumes them**. An entry that no longer matches the code is worse than no
entry. If you find one that has drifted, fix or delete it in the same commit as the work.

Stable project-wide rules live in `CLAUDE.md`, not here. This file is only the moving parts.

---

## Open: things later tasks must handle

### `failureSignature`'s window must stay well under `MAX_OUTPUT_BYTES` — anyone tuning either
`src/testrun.ts` keeps the last 1 MiB of each stream; `src/stall.ts` hashes the last 256 Ki
**UTF-16 code units** of that, so up to about 768 KB of UTF-8 in the worst case. If the two ever
meet, the signature reaches bytes that a chatty run had already dropped and a quiet one still
had, and one failure hashes two ways depending on how much the suite printed. The marker
`testrun.ts` prepends is normalized in `stall.ts` as well, so the byte counts in it cannot reach
the digest even if the windows do change.

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

### A user-side `text` block must never map to `text` — the UI tasks
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

### `defaults()` throws on unknown keys — whoever adds project registration
Reassigned from Task 18, which turned out not to be the consumer: `POST /api/runs` names a project
by path and hands no request body to `defaults()`, so the throw is unreachable from the actions.
The real consumer is the endpoint that *registers* a project from a form, which **no task in the
plan builds** — Task 21's empty state ("point at a repo") needs one. When it is written: the throw
is a **4xx, not a 500**, because it is the caller's typo rather than a server fault, and the same
holds for `loadProjects` on a damaged store, which is a 5xx that forwards its message (it names the
file and the field, and the user owns the file).

`src/server.ts` already has the shape to copy: body validation returns a refusal rather than
throwing, and every handler's throw is caught and logged as a 500, so a validator that throws can
never become an unhandled rejection.

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
- **A session becomes resumable only once a turn's replay finishes**, and the cursor that records
  that is written **after** the turn's bytes are out. So a kill timed off the orchestrator's own
  output can still land in the window where the result has arrived but the session is not
  resumable yet, and the resumed run then meets `No conversation found`. `test/run.test.ts` polls
  `<script>.cursor` for the session id before killing, which closes it. What the real CLI does
  when killed mid-turn is unprobed: probing it costs an API call.
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

### `TextDecoder` strips the BOM by default — anyone decoding a user's file
`ignoreBOM` defaults to `false`, which **removes** the BOM rather than ignoring it. `featurefile.ts`
passes `{ fatal: true, ignoreBOM: true }`; flipping it back made the BOM test fail, so the default
would have silently deleted a BOM on the first tick. `fatal: true` also refuses a non-UTF-8 file
rather than decoding a byte to U+FFFD and writing the replacement back.

### `src/sentinel.ts` now exports `DONE` and `BLOCKED` — anyone emitting a sentinel
`src/prompts.ts` builds its sentinel lines from those exports, so the emitting and parsing sides
cannot drift. `BLOCKED_RE` stays a regex literal and its parsing logic is untouched; the
`BLOCKED` ↔ `BLOCKED_RE` agreement is pinned from outside by `test/prompts.test.ts`, where a
one-character drift fails three tests.

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

### `GET` must have no side effects — every UI task
`SameSite=Strict` ignores **ports**, so a page on any other localhost port is same-site. Its
no-cors GETs (`img`, `script`, navigation) carry the auth cookie and send no `Origin`. Actions
must be `POST`. A convenience GET that starts a run is reachable from any other local page.

Task 18 consumed its half: all four actions are `POST`, and a loop in `test/server.test.ts` tries
`GET` and `HEAD` on every action path with no `Origin` and asserts both a 404 and that the phase
machine recorded no call. Adding a `GET` spelling of an action therefore fails a test first.

### What the four actions accept, so the UI does not learn it by trial — Tasks 21 to 25
`POST /api/runs` takes `{"projectPath","featureFile","taskRef"}`, all three required non-empty
strings, and answers **201** `{"ok":true,"runId"}`. `POST /api/runs/:id/approve` and `/stop` take
**no body and no keys**; `/feedback` takes `{"text"}`. All three answer 200 `{"ok":true}`.

- **An unknown key is a 400**, as in `projects.json`, because a near-miss spelling is a value
  somebody typed and silence would drop it. The message names the keys the route *takes* and never
  the key that was sent.
- **A body on `approve` or `stop` is a 400, not ignored.** A client that put feedback text on the
  approve route would otherwise silently approve a plan the human wanted revised.
- **A refusal body is `{"error","refusal"}`**, where `refusal` is one of `unknown-project`,
  `unknown-feature`, `unknown-task`, `unknown-run` (all 404), `busy`, `dirty`, `wrong-state` (all
  409). Switch on the code, not the prose: `dirty` wants `git stash` advice shown, `busy` wants a
  link to the run already going, and both are 409.
- `error` is the phase machine's own sentence and is meant to be rendered as written — `src/git.ts`
  names the dirty files and the stash that clears them. Nothing from the request is quoted back.
- **413 over 64 KiB**, read with a running cap rather than from `Content-Length`, which a chunked
  request does not send at all. Invalid UTF-8 is a 400 rather than U+FFFD, since the big field is
  the human's own words.
- Feedback text is forwarded **byte for byte**. Emptiness is judged on a trimmed copy; nothing
  trimmed is ever sent on.
- **503** on every action from a server launched without a phase machine, which is what
  `bun run src/server.ts` still is: `createRunner()` in `src/run.ts` is the implementation of
  `Runner`, and **nothing constructs one yet**. Wiring it is a two-line change in
  `import.meta.main` (`runner: createRunner()`), left to whoever owns that file.

### Four security claims are spec-level, not observed — whoever tests with a real browser
No real browser was involved in Task 16's suite. These are taken from the spec: browsers always
send `Origin` on non-GET/HEAD; browsers lowercase the host; `SameSite=Strict` semantics;
`EventSource` cannot send custom headers. **If any is wrong, the GET/HEAD Origin exemption is the
row that bites.** Worth one real-browser check during Task 25 or 26.

### A SIGKILLed server can leave a `claude` child still writing — whoever adds supervision
The run lock judges only the server process, so reclaiming a stale lock can admit a second run
into a tree where an orphaned child is still writing files. Task 11's process-group kill covers
the test command; the agent child is not covered. `src/run.ts` SIGTERMs its own child on every
path where it gives up, which covers a crash *inside* the machine - but nothing inside a process
can clean up after `kill -9` of that process.

### Two readers of `permission_denials` now exist — Task 24, whoever logs
`src/stream.ts` passes the field through as a raw `unknown[]`. `src/permissions.ts` exports
`permissionDenials(event)` and `describeDenials(...)`, which name the refused tool. **Call those
rather than re-reading the array**, or the "named, not swallowed" guarantee lives only in Task 8b's
tests and the UI shows a generic failure for what is actually a one-line config fix.

### Bun cuts an idle SSE stream at 10s — settled by Task 18, keep the number in sight
Task 17's open question is answered. Probed (`bun 1.4.3`): `Bun.serve` defaults to
`idleTimeout: 10`, cuts at about twelve seconds, and warns *"Bun.serve() timed out a request after
10 seconds. Pass `idleTimeout` to configure."* **An outgoing write does reset the timer**: a stream
writing a comment every 8s survived 26s, while one writing every 15s died at 12s with ECONNRESET.
So the keep-alive mechanism works and needs no replacement — it just has to beat the window.

`DEFAULT_STREAM_KEEP_ALIVE_MS` was 15s, which never fires, so **every production run waiting at the
gate dropped its stream every twelve seconds** — the plan gate's exact failure case. Now 5s. No
test pins it: the shortest honest one waits the window out and costs the suite twelve seconds for a
constant, and the suite's own tests pass an interval in milliseconds, so they prove the mechanism
and are blind to the default. That blindness is how the 15s survived Task 17. If anyone raises it,
or passes `idleTimeout` to `Bun.serve`, the two numbers have to move together.

### `runindex` reads a window, so `costUsd` is a floor — Task 24 and the UI
Except for `done` and `failed`, where an `end` record gives the authoritative total. Do not render
a floor as an exact figure.

`running` is reachable **only** when the caller passes `liveRunIds`; without it a live run reads as
`interrupted`. `branch: ""` means the name could not be derived. A truncated tail is
indistinguishable from a missing `end` record — both fold to `interrupted`, and `resumeFrom` is the
last **complete** `phase` record, which may be one step behind what the server was doing.

### The merge predicate is the cost, not the reading — whoever passes one
Measured over 500 logs: `indexRuns` reads **4.6% of 718 MiB in 89-180ms**. Adding a 5ms-per-row
merge predicate (roughly a warm `git merge-base --is-ancestor`) takes it to **2733ms**, awaited one
row at a time. `runindex` deliberately does not cache that: only the caller knows when a branch can
have moved, and a stale cache would feed wrong merge state to the guard whose job is refusing a
second run against finished work.

`src/run.ts` passes **no** merge predicate and never calls `isMergedIntoBase`: its only guard
against re-running a finished task is `createTaskBranch` refusing a branch that already exists, so
it pays none of this cost. The caching question therefore belongs to whoever renders the tree.
`liveRunIds()` in `src/run.ts` is the other half of that call - without it every active run folds
to `interrupted`.

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

### The phase machine is `src/run.ts`, and `createRunner()` is its port — whoever launches the server

`Runner` in `src/server.ts` is satisfied by `createRunner({ projectsFile, runsDir })`, which is a
**structural** match rather than an import: the machine does not import the server, so the port's
types and the machine's stay independent and a drift shows up as an assignability error at the one
line that wires them.

Three things to know before wiring it:

- **The port has no `answer`.** A run that ends a turn in prose, or with `ORCH: blocked <reason>`,
  parks as `waiting(question)` / `waiting(blocked)`, and **no HTTP route can move it**: approve and
  feedback both refuse (`wrong-state`), and stop/resume only re-park it. `createRunner` exposes
  `answer(runId, text)` already, so the gap is a route and a `Runner` method, not machine work.
- **Two refusal codes collapse.** The machine refuses with nine codes (`RefusalCode`); the HTTP
  vocabulary has seven. `no-base` (a detached HEAD, or a checkout an earlier run left on `orch/*`)
  and `branch-exists` (the task has run before) both arrive as `wrong-state`, because `dirty` would
  be a lie and the UI hangs `git stash` advice off it. **The vocabulary is missing a "the repo is
  not in a state a run can start from" code**; the messages carry the explanation meanwhile.
- **Every action resolves at the transition, never at the rest point.** `ActionOptions.accepted` is
  the hook: it fires once the run is registered, its branch taken and its child spawned, and a
  refusal rejects before it ever fires. `createRunner` races the two. A caller that awaited the
  returned promise instead would hold the request open for the length of a phase.

### `featureFileHash` is SHA-256, hex, over the file's raw bytes — anyone comparing one

The field was specified with no algorithm and no stated input, and `tickTaskInFile` takes a
`FeatureFile` rather than a hash, so the comparison it exists for lives in `src/run.ts`:
`featureFileHash(file.src)`, compared on rehydration against `header.featureFileHash`.

It is computed from the **decoded string**, and that is the raw bytes: `readFeature` decodes with
`{ fatal: true, ignoreBOM: true }`, so every file it accepts is valid UTF-8 decoded without
substitution or BOM stripping, and re-encoding valid UTF-8 reproduces the input byte for byte. One
read, and a hash that provably describes the bytes the run parsed rather than bytes read a moment
later. A hash over a *normalised* form would have been the bug worth avoiding: `featurefile.ts`
keeps a BOM and whatever line endings the file had, which are exactly the differences that prove a
human edited it.

### The run log gained three optional fields, each for a reader that had nothing — anyone reading a log

| Field | Why it had to exist |
|---|---|
| `RunHeader.baseBranch` | a resumed run has nothing to `returnToBase` to otherwise. The branch can be recomputed from `featureFile` + `taskRef`; the base cannot be recomputed from anything, and `recordBaseBranch` both refuses on an `orch/` checkout and is the stacking bug |
| `PhaseRecord.detail` | nothing else holds *why* a run is waiting. A `question` has the agent's text in the `cli` records before it, but a `blocked` the orchestrator decided (an exhausted budget) and a `stalled` one have no agent text at all, so a restarted server rendered the previous turn's prose as the reason |
| `EndRecord.warnings` | a `done` run can still have things a human must see - a feature file edited mid-run, a task already ticked, a checkout that could not return to base. `why` is documented as why a run *failed*, and the log is the only place such a note survives the server that wrote it |

All three are optional, per the absence policy: they are younger than the logs already on disk, and
a field that did not exist cannot have been recorded. A log without `baseBranch` finishes on its
task branch and says so rather than guessing.

### Nothing records the effort a run escalated to — anyone touching the stall rule

`PhaseRecord` has no effort field and the header holds only the starting value, so a resumed run
recovers the current level by **replaying the escalation rule over the logged test signatures**.
`stepLadder` in `src/run.ts` is that rule and is called from both places for exactly this reason: a
second implementation would disagree silently, drop a resumed run back to `medium`, pay a cold
cache getting back up, and report the wrong level in the UI. If you add a field for it, delete the
replay in the same change - two sources will drift.

### Five things Task 13 left undone deliberately — their owners are named

- **Nothing checks that the plan file exists at the gate.** An agent that answers `ORCH: done`
  without writing one parks the run at a gate rendering nothing. Untestable against
  `test/fake-claude.ts`, which cannot create files, so the check was left rather than written
  blind - **the gate UI task** will see the empty render first.
- **A plan phase killed mid-first-turn cannot be resumed.** The session never completed a turn, so
  `--resume` meets `No conversation found` and the run fails with that message. Recovering means
  `git branch -D orch/<task>` and starting over. The same kill *after* the first turn resumes fine.
- **A stop during a test run waits for the suite.** `runTests` has no cancel, only its timeout, so
  `stopRun` kills the agent child at once and the test command runs to its end; the run then parks
  interrupted without ticking or committing. Bounded by `DEFAULT_TIMEOUT_MS`, which is ten minutes.
- **The budget park promises a raise nothing implements.** An exhausted ceiling parks
  `waiting(blocked)` with "raise the ceiling and the run continues", and **Task 14** owns the
  action that raises it. Until then the only way on is a new run.
- **`turn()` takes the first result event of a turn**, not the last. Within a turn the double emits
  exactly one, and `result_index` is replayed as captured so nothing may key on it; if a real CLI
  ever emits several per turn, the cost arithmetic (which uses the last result of the *process*) is
  already right and only the per-turn outcome needs revisiting.

### Task 13's three open decisions, as made

- **Ref-less tasks are refused, not assigned refs.** The message quotes the line and shows the
  shape to type. Assigning one would mean writing to the user's backlog at run start, when the
  server's only write to a feature file is a tick *after* the test command passed - and the ref it
  invented would become the identity every future branch name keys on. `src/draft.ts` writes refs
  when it drafts a file; that is where authoring belongs.
- **`isMergedIntoBase` reporting ancestry is accepted.** `src/run.ts` does not consult it at all:
  its only guard against re-running a finished task is `createTaskBranch` refusing an existing
  branch, whose message already names `git branch -D <branch>` as the way out. So a squash-merged
  task is one explicit command from being startable again, and that command is the human saying
  "that work is integrated" - which ancestry cannot tell them. Note that the **tree** still reads
  "done, unmerged" from `src/runindex.ts` until the branch is gone, because a throwing predicate
  folds to `merged: false`.
- **A `waiting(question)` run is answered on the session that asked.** It parks with no live child,
  like the gate, and the reply goes in as the next turn on the conversation named by the phase
  record - plan session for a plan question, implement session for an implement one. `answerPrompt`
  carries the human's words verbatim and the phase's own "what to do next" clause, so an answer
  into the plan session cannot start the implementation.

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
