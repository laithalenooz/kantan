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

### A run's ceiling lives in its log, and nothing over HTTP can raise it yet — the UI, whoever routes

Task 14's answer to "how does a raise reach a parked run": a `human` record,
`{"kind":"human","action":"raise","budgetUsd":<new ceiling in full>}`. Each raise carries the whole
new ceiling rather than a delta, so `foldForResume` takes the **last** usable one and falls back to
the header's figure when there is none — and ignores a figure that is not finite and positive,
leaving the previous ceiling standing. That is what makes a raise survive the restart the park
exists to outlive. Three consequences nobody can see from the types:

- **`project.budgetUsd` is the *next* run's default, not a live control.** A run can be started
  with a per-run ceiling (design §3.4 allows one), so a resumed run that re-read the store would
  hand the next process a remainder nobody granted — and one edit to the store would raise every
  unfinished run of that project at once. The park's prose now says "raise **this run's** ceiling"
  for exactly this reason. So `src/ui/Sidebar.tsx`'s `ceilingUsd={project.budgetUsd}` and
  `src/runindex.ts`'s `header.budgetUsd` are both **stale after a raise**: the ceiling a run is
  actually spending against is the folded one.
- **`createRunner` exposes `raise(runId, budgetUsd)`; the server's port and routes do not.** The
  figure is the only action argument that is a number, so a route owns the 400 for a missing or
  non-numeric one. The machine refuses a figure that is not finite, or not above **both** the
  ceiling and the spend, as `wrong-state` — a raise that lands at or under either one would
  re-park the run on arrival or lower the ceiling while claiming to raise it.
- **Feedback and an answer are refused while the ceiling is spent**, with `wrong-state`, *before*
  the text is taken. A raise resumes a run by re-sending the phase's own prompt, which cannot
  carry a sentence somebody typed an hour ago, so recording it would put words in the log that no
  agent ever reads. The UI must therefore **keep the draft in the box on that refusal** rather
  than clearing it. Approve is deliberately *not* refused: it carries no text, and
  "approve → told the ceiling is short → raise → the implement phase starts" is the designed path.

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

### `POST /api/projects` is how a repo is registered, and it takes three keys — Task 21's empty state

Consumed: `defaults()`'s throw now has a consumer, and it is a **400** that forwards the message.
The contract, so the dialog does not learn it by trial:

```
POST /api/projects  {"path", "testCmd", "configDir"?}   -> 201 {"ok":true,"project":<the stored record>}
```

- **`path` and `testCmd` are required non-empty strings; `configDir` is optional and absolute.**
  The dialog's "personal" / "work" account label is a `configDir` — a CLI profile directory, which
  carries a CLAUDE.md, skills and settings as well as credentials — and the **UI owns that
  mapping**. Sending `{"account":"personal"}` is a 400 naming the keys the route takes.
- **The task file the dialog also asks for is not a project field.** It names a run, and it reaches
  `POST /api/runs` as `featureFile`. Sending it here is a 400.
- **Everything else takes the design's default** (`budgetUsd` 50, the two models, the two efforts,
  `allowedTools: null`, no `reportPath`) and is edited in `projects.json`. The route's key list is
  deliberately **not** a copy of `src/projects.ts`'s `FIELDS`: adding a field to `Project` is
  already a four-place change and copying it would make it five.
- **`path` comes back as git's resolved root**, which is why the 201 returns the whole stored
  record: a trailing slash is gone and a symlinked spelling is resolved, and that path is the
  identity every start request and every run log keys on.
- **400** for a body `defaults()` refuses (its message is forwarded: "configDir must be an absolute
  path - the CLI expands no `~`" is the only thing that fixes the mistake) and for a path
  `requireUsableRepo` refuses, with git's own reason. **409** for a repo already registered —
  `addProject` replaces a record wholesale, so a second trip through a three-field dialog would
  reset a hand-tuned `budgetUsd` or `allowedTools`, and the store is the one state no repository can
  rebuild; the message names the file to edit instead. **500 forwarding its message** for a damaged
  store, which is the one 5xx that does: it names the file and the field, and the user owns that
  file. **503** when the launch named no store at all.
- `ServerOptions.projectsFile` has **no default**, unlike `runsDir`: the entry point passes
  `defaultProjectsFile()` to the server *and* to `createRunner`, so the two provably read one file,
  and a test that forgets to inject one gets a 503 rather than writing the developer's own store.

### `projects.json` has no cross-process lock — nobody, unless kantan grows a second process
Writes are serialised in-process only, which is sound for one local server. A second process can
still lose an update, though `rename` means the file is never left truncated. Also: no directory
`fsync` after the rename, so a power loss can lose the newest write but never corrupt the file.
Crash-left `.tmp` files are ignored on read and never cleaned up.

### Two spellings of one repo: closed over HTTP, still open for a hand-edited store — anyone writing one
Task 12 consumed the git half: the guards resolve to the real root and the lock lives in
`$GIT_COMMON_DIR`, so **two symlinked spellings cannot run at once**. `POST /api/projects` consumed
the store half: it registers **git's resolved root**, not the spelling that was typed, so a second
spelling meets the "already registered" 409 instead of forking the project's runs, logs and task
tree. `projects.json`, the run logs and the index are all still keyed on `project.path`, so a store
**hand-edited** to hold two spellings of one repo is still two records with two histories —
`loadProjects` only refuses two records with the *same* path.

`reportPath` may contain `..`; refusing it would mean guessing at monorepo layouts, so the code
that joins it owns that check. A recorded **`planPath` may not**: `GET /api/runs/:id/plan` refuses
one by construction, because the machine dictates `docs/plans/<date>-<slug>.md` and nothing
legitimate there contains a `..`.

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

### The plan the gate renders has its own route, with three states — the gate UI

`GET /api/runs/:id/plan` answers **200** with `{"ok":true,"plan":<PlanSource>}`, where `plan` is
`PlanSource` from `src/ui/Gate.tsx` **field for field**, so `App.tsx` passes it straight to the card
instead of keeping a translation table:

```
{"ok":true,"plan":{"status":"loaded","path":"docs/plans/2026-10-11-x-t7.md","markdown":"# The plan\n…"}}
{"ok":true,"plan":{"status":"unreadable","path":"docs/plans/…","why":"…"}}
{"ok":true,"plan":{"status":"undictated"}}
```

- **All three are a 200, because all three are states of a run** rather than failed requests. A run
  can legitimately sit at a gate with no plan behind it: `ORCH: done` without a file written is
  `unreadable`, and a log that never carried a path at all - an older log, or a run resumed from
  one, where `src/run.ts` rehydrates `folded.planPath ?? ""` - is `undictated`. **Switch on
  `status`, and render `why` as written**: it is prose for a person, which is what the card needs.
  `undictated` deliberately carries no text, as the component declares it - the gate owns that
  sentence, and a copy on the server would be a second place for it to drift.
- **A 4xx means the request cannot be answered**: 400 for an unusable run id, 404 for a run with no
  log, and 400 for a recorded path that does not sit inside the repo. That last one never quotes
  the path back, so do not expect to render it.
- **The path is read from the log's `phase` record and never re-derived.** `planPathFor` builds it
  from the branch name and the date the run *started*, so a convention-derived path would point at
  a file nothing wrote the moment either moved. The plan path is **repo-relative**, resolved against
  git's own root for `header.projectPath`; a project whose repo has moved is `unreadable` carrying
  git's reason. `path` in the answer is always the path **the log recorded**, never the resolved
  one: that is what the human would look for, and a resolved path would say where a symlink inside
  their repo points.
- **Symlinks are resolved before the read, and a link out of the repo is a 400.** `stat` and
  `readFile` follow links, so a `docs/plans/x.md` - or a `docs/plans` - that points at
  `~/.ssh/id_rsa` would otherwise be rendered in the gate, and the agent writing plans has shell
  access in that repo. The file is then opened `O_NOFOLLOW` and read through that one handle, so a
  final-component swap after the check is refused rather than read. A link to a file **inside** the
  repo is served normally.
- **A plan over 1 MiB is `unreadable` rather than served**, with its size in the message. The file
  is still on disk; nothing truncates it.
- Invalid UTF-8 is `unreadable` too, rather than decoded with U+FFFD: a mangled plan is one someone
  could approve.

### `GET` must have no side effects — every UI task
`SameSite=Strict` ignores **ports**, so a page on any other localhost port is same-site. Its
no-cors GETs (`img`, `script`, navigation) carry the auth cookie and send no `Origin`. Actions
must be `POST`. A convenience GET that starts a run is reachable from any other local page.

Task 18 consumed its half: every action is a `POST`, and a loop in `test/server.test.ts` tries
`GET` and `HEAD` on every action path with no `Origin` and asserts both a 404 and that the phase
machine recorded no call. Adding a `GET` spelling of an action therefore fails a test first.

### What the run actions accept, so the UI does not learn it by trial — Tasks 21 to 25
`POST /api/runs` takes `{"projectPath","featureFile","taskRef"}`, all three required non-empty
strings, and answers **201** `{"ok":true,"runId"}`. `POST /api/runs/:id/approve` and `/stop` take
**no body and no keys**; `/feedback` and `/answer` each take `{"text"}`. All four answer 200
`{"ok":true}`.

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
- Feedback and answer text are forwarded **byte for byte**. Emptiness is judged on a trimmed copy;
  nothing trimmed is ever sent on.
- **`/answer` is not `/feedback`, and the UI needs two controls on one reply box rather than one
  route that guesses.** `/feedback` revises a plan a human read at the gate; `/answer` replies to a
  run parked at `waiting(question)` **or `waiting(blocked)`**, as the next turn on the session that
  asked. Sending a reply to `/feedback` would put it into `feedbackPrompt`, which opens with "a
  human read that plan at the gate and did not approve it".
- **No action takes a `waitId`, and none will.** The gate's `${runId}#${phaseRecordIndex}` stays
  entirely client-side: which states accept which action is the machine's rule, and a server that
  re-read the log to check an id would encode run state a second time and race between the check
  and the doing — the exact race the `Runner` port exists to avoid. `Gate.tsx` treats it as an
  opaque string ("anything that changes every time the run stops for the human"), so the shell is
  free to count what it is already reading: every stream connection replays from byte 0, so a
  client counting `record` events has an index of the log's own records. Sending `waitId` to an
  action is a 400, like any unknown key.
- **503** on every action from a server launched without a phase machine. `bun run src/server.ts`
  is **no longer** one: `import.meta.main` constructs `createRunner({ projectsFile, runsDir })` and
  passes the same two paths to `createServer`, so the store the registration route writes is the
  store the machine reads.

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

It is wired: `import.meta.main` in `src/server.ts` constructs one and shares `projectsFile` and
`runsDir` with it. Three things to know, the first of them settled rather than open:

- **`answer` is on the port now, and has a route.** A run that ends a turn in prose, or with
  `ORCH: blocked <reason>`, parks as `waiting(question)` / `waiting(blocked)`, which approve and
  feedback both refuse (`wrong-state`) and stop/resume only re-park. `POST /api/runs/:id/answer`
  takes `{"text"}` and calls `Runner.answer`, which `createRunner` already had.

  The reason it is its own action also settles the question `docs/SEAMS.md` left open - whether `feedback` should accept
  `waiting(question)` as well as `waiting(gate)`. It should not. `feedbackPrompt` opens with "a
  human read that plan at the gate and did not approve it", which is false for an agent that asked
  something and is waiting for the answer, and it is the wrong instruction for a question raised
  mid-implement: the gate's feedback revises a plan, while an answer continues work. So a question
  gets its own action and its own prompt, `answerPrompt`, which carries the reply verbatim plus the
  one clause that differs by phase. The UI needs two controls on one reply box, not one route that
  guesses which conversation it is talking to.
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

- **Nothing checks that the plan file exists at the gate**, and nothing will: the machine still
  parks a run whose agent answered `ORCH: done` without writing one. What changed is that the gate
  no longer renders nothing for it - `GET /api/runs/:id/plan` reports that as `unreadable` with the
  path it looked at, so the failure is named where a human sees it rather than checked where
  `test/fake-claude.ts` (which cannot create files) could not have tested it.
- **A plan phase killed mid-first-turn cannot be resumed.** The session never completed a turn, so
  `--resume` meets `No conversation found` and the run fails with that message. Recovering means
  `git branch -D orch/<task>` and starting over. The same kill *after* the first turn resumes fine.
- **A stop during a test run waits for the suite.** `runTests` has no cancel, only its timeout, so
  `stopRun` kills the agent child at once and the test command runs to its end; the run then parks
  interrupted without ticking or committing. Bounded by `DEFAULT_TIMEOUT_MS`, which is ten minutes.
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

### The tree joins on `featureFile` by exact string — whoever wires `App.tsx`
`TreeFeature.path` must be the **exact repo-relative string the run header records** as
`featureFile`. If the join misses, a `done, unmerged` task reads as `open` and `canStart` returns
true — a silent re-run of finished work, which the tree has no way to detect.

Related: `Account.kind` is `"personal" | "work" | "unknown"` and required on every project.
`unknown` renders a neutral chip saying neither, because a silent default of "personal" is the
exact failure the chip exists to prevent. `Project` carries a `configDir`, not a word, so the
reading is the caller's.

### `StateGlyph` carries its own keyframes via the tree root — whoever reuses it
`MOTION_CSS` is rendered once by `Tree`'s root, so a `StateGlyph` used outside a tree needs those
two keyframes in scope or it silently stops animating.

### `happy-dom`'s `register()` throws on a second call — any new DOM suite
`bun test` runs every file in one process. Register only if the slot is free and `unregister()`
only if you took it, or your suite pulls the document out from under the others depending on file
order. `test/ui/Tree.test.tsx` has the pattern.


### Stream row ids must be deterministic per log line — whoever wires `App.tsx`
`run id + record index`, never a counter or a generated id. **The SSE replays from byte 0 on
every connect and carries no replay-versus-live marker**, so on a reconnect a non-deterministic id
re-animates the entire log, collapses every expanded row, and discards the measurement cache.
Tested both ways in `test/ui/Stream.test.tsx`.

The missing marker is the underlying gap: nothing in the protocol distinguishes a replayed record
from a live one. Deterministic ids make the UI correct without it, but a later task may want the
marker for its own reasons.

Also: key `<Stream>` by run id when the run changes, or `following` and the expanded set carry
over to the next run.

### `errors` must be copied from the raw result line — whoever feeds the UI
`src/stream.ts` drops it, and on `error_max_budget_usd` **it is the only prose explanation there
is** (the `result` text is absent, not empty). A failure row fed only the parsed event shows
nothing.

Two related absences: `CliRecord` has no timestamp, so the clock column stays blank unless arrival
time is stamped on write; and `TestRecord` carries no output or summary, so test rows cannot
expand unless the server ships `TestOutcome`'s stdout and stderr.


### `waitId` is required on both gate shapes — whoever wires `App.tsx`
`${runId}#${phaseRecordIndex}`. **Content alone cannot tell a re-asked question from a poll of the
same one**, and without the id a re-asked question renders with no composer at all.

Gate handlers may return a promise, and **rejecting is how a refusal is reported**: the card
restores its controls, keeps the human's draft, and shows the message in `role="alert"`. So a
refusal that reaches the UI needs a message worth showing a person, not only a code.

`blocked` and `stalled` waits are deliberately **not** gate shapes.

### The gate uses a scoped stylesheet, unlike the other three components — worth knowing
Colours, keyframes, the beam and the prose rules were forced there: the contrast proof needs
computed colours, `@property` is not a utility, and `@tailwindcss/typography` would have to be
registered in `tokens.css`, which that agent did not own. Putting layout there too was its choice,
for one source of truth per region against the artboard. It reaches the token layer through
`var(--color-*)` with the artboard's literal as a fallback.

If this is unified later, the fallbacks are load-bearing: happy-dom resolves a bare
`var(--color-x)` to nothing, which would make a ring on an orange plate measure as 19:1 and pass
a contrast test it should fail.


### The tree cannot address a single route (open)

`Tree.tsx` hands its caller a `TaskId` — `{projectPath, featureFile, taskRef}`.
Every route in `src/server.ts` is keyed by **`runId`**: the stream, the plan,
approve, feedback, answer, stop. And `TreeTaskRun` carries no run id, so a
selection in the tree resolves to nothing the HTTP port will accept.

Do **not** close this by adding `runId` to `TreeTaskRun`. The Tree is
presentational and four agents hold its file; `runindex.ts` already owns the
task-to-run mapping and already exports the key function for it. `GET
/api/projects` returns the mapping beside the tree:

    { projects: TreeProject[],
      runs: Record<ReturnType<typeof taskKey>, { runId, costUsd, attempts }> }

The shell joins them. `taskKey` separates with `NUL`, which survives JSON as
`\u0000` and is the one byte a path cannot contain, so the key stays unambiguous
over the wire.

### `raise` has no route (open)

`createRunner` exposes `raise(runId, budgetUsd)`; nothing serves it. It is the
only action carrying a numeric argument, so it owns a 400 no other route has:
a body that parses but whose number is absent, negative, zero, `NaN`, or a
string. The CLI itself rejects a non-positive `--max-budget-usd` (probed,
2026-10-11), so the route must not pass one through and let the spawn fail
later, where the UI cannot attribute it.

### `pkill -f "bun run src/server.ts"` is not yours alone

An agent ran that pattern while probing on 2026-10-11 and it matches every
agent's dev server on this machine, not just its own. If a real-browser check
died unexplained around then, that was the cause, not a crash. Kill by pid
from the port (`lsof -ti:PORT`), never by command pattern, while other agents
are running.

### `bun run server` and `bun run ui` cannot talk to each other

Vite proxies `/api` to 3100 and **deliberately does not set `changeOrigin`**
(see the comment in `vite.config.ts`: rewriting `Host` would hide the browser's
real one from the rebinding check). So the server receives `Host:
localhost:5173`, which `allowedHosts` refuses with a 403 reading *"the Host
header must be exactly 127.0.0.1:3100 or localhost:3100"* unless `dev` is on.
`ORCH_DEV=1` is the switch and nothing in `package.json` set it, so the obvious
two-terminal dev workflow failed at the first request with a message that
sounds like a misconfigured reverse proxy.

Use **`bun run server:dev`** (added 2026-10-11) beside `bun run ui`. Observed
in a real browser, not reasoned about: the first screenshot of the wired shell
showed that 403 and nothing else.

### The UI's read of a run lives in `src/ui/live.ts`, and it is a fold

Not an accumulator. `GET /api/runs/:id/stream` replays from byte 0 on every
connect with no replay-versus-live marker, so the client must be able to throw
its state away, re-read and arrive at the same answer. Three consequences
anyone touching it should not relearn the hard way:

- A row's id is `runId#recordIndex:eventIndex`. One `cli` record classifies to
  zero, one or several events, so the record index alone collides; a running
  row counter is worse, because a filtered hook subtype yields no row and would
  renumber everything after it on reconnect.
- `subscribeRun` empties its buffer on every `open`. Appending across a
  reconnect doubles every row **and** the cost total - the silent direction,
  since the figures stay plausible and the ceiling is compared against twice
  the truth.
- `park` is called with the phase that **ran**, not the phase that waits, so
  `run.ts:864` records `{phase:"plan", state:"waiting", reason:"gate"}`. `gate`
  is the only `WaitReason` naming a phase in the ladder; reading the other
  three the same way finishes a phase still outstanding.

### A `let x: T | null = null` assigned only inside a closure narrows to `null`

`tsc` narrows the declaration, not the closure's assignment, so `x?.foo` is an
access on `never` and `x?.()` is "not callable". It cost four rounds of
typecheck in `test/ui/useRun.test.tsx`. Use a holder - `const seen: { x: T |
null } = { x: null }` - which keeps the declared type.

### `GET /` serves a placeholder, so there is no single-process kantan (open)

`INDEX_STUB` in `src/server.ts` still answers *"kantan is running. The UI
arrives in a later task."* The UI has arrived; `vite build` writes `dist/` and
nothing serves it. So the only way to run kantan is the two-terminal dev setup,
which the README now says plainly rather than implying otherwise.

Closing it means serving `dist/` from `GET /` with the cookie it already sets,
and falling back to the stub when `dist/` is absent - a clone that has not been
built must still start and say why, rather than 404ing on its own index. Note
the asset routes have to sit **inside** `ROUTES`, not in `Bun.serve({routes})`:
the module header explains that a route registered there is matched before the
guard chain runs and would never meet it.

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
