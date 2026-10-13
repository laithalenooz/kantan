# Orchestrator Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a localhost UI that drives the real `claude` binary through one task at a time: plan, one human gate, then implement and test with effort escalation on stall.

**Architecture:** A Bun server owns child `claude -p` processes and appends their raw stream-json to a JSONL file per run. The backlog is markdown in each target repo. A Vite/React single page renders the run over SSE and posts actions back. The server, not the agent, runs the project's tests and branches on the exit code.

**Tech Stack:** Bun (server, test runner), Vite + React + Tailwind v4 + Motion + shadcn/ui + selected Magic UI, TanStack Virtual. No ORM, no database.

**Design doc:** `docs/plans/2026-10-11-orchestrator-design.md`. Read it before Task 1. Every `(probed)` claim in it is verified; `docs/probes/` holds the scripts.

**Standing rules for every task:**

- TDD. Write the failing test, run it, see it fail for the right reason, then implement.
- Never call the real API in a test. Task 5 builds a fake binary; everything after it uses that.
- Commit after each task.
- `ORCH: done` is a literal string this codebase emits in prompts and parses in output. Do not "improve" it.
- Finish on `bun run check`: typecheck, then tests, both clean.

### The skipping-guard rule

Task 2 produced fourteen defects in roughly a hundred lines. Every one came from a rule that
decided to **skip** input, and none came from the byte-preservation logic everyone was worried
about. The difference: byte preservation was a closed-form problem that could be reasoned about
completely, while deciding where a task list stops is an open-ended classification of someone
else's markdown.

Three rounds of fixes each introduced the next defect, because each fix was aimed at the case
that motivated it rather than at the worst case it could hit.

**So: a guard that skips, filters, or normalizes input is a guess, and its risk is its worst
case, not its motivating case.** Before writing one:

1. **Name the input dimension the guard reads.** Not the input in general: the specific thing it
   inspects.
2. **Enumerate every value that dimension can take**, including values no existing test produces
   and no sane file contains.
3. **Say what a wrong guess costs in each direction.** Over-skipping and under-skipping usually
   have wildly different costs, and the cheap direction is the one to fail toward.
4. **Test the whole enumeration**, as a matrix if it has more than one dimension.

A corollary that cost three rounds to learn: **replaying an existing suite after a change proves
nothing about a rule that reads something the suite never varied.** A regression check inherits
the blind spots of the suite it replays, so report the method together with what it cannot see.

Tasks 6, 9, 10 and 12 are built almost entirely out of such guards and each names its own
enumeration below.

---

## Task 0: Verify versions before anything else

The design records versions as of 2026-10-11 and explicitly says not to trust them.

**Step 1: Check installed against published**

```bash
claude --version
bun --version
node --version
npm view @anthropic-ai/claude-code version
npm view bun version
npm view node version
```

**Step 2: Update what is behind**

```bash
npm i -g bun@latest
claude install latest   # only if claude --version is behind
```

**Step 3: Record the result**

Append a line to `docs/plans/2026-10-11-orchestrator-design.md` under §1.2 stating the versions this build was made against and the date. If the CLI major/minor changed from 2.1.296, re-run `docs/probes/probe.mjs` and `docs/probes/probeC.mjs` before continuing: the stream-json envelope shape is version-dependent, and Tasks 5 and 6 encode its shape.

**Step 4: Commit**

```bash
git add -A && git commit -m "chore: record toolchain versions for this build"
```

---

## Task 1: Scaffold and a passing test run

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`
- Create: `src/version.ts`
- Test: `test/version.test.ts`

**Step 1: Write the failing test**

```ts
// test/version.test.ts
import { expect, test } from "bun:test"
import { claudeVersion } from "../src/version"

test("reads the claude CLI version", async () => {
  const v = await claudeVersion()
  expect(v).toMatch(/^\d+\.\d+\.\d+$/)
})
```

**Step 2: Run it and watch it fail**

```bash
bun test test/version.test.ts
```
Expected: fails, cannot resolve `../src/version`.

**Step 3: Create the project files**

```json
// package.json
{
  "name": "orchestrator",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "bun test",
    "server": "bun run src/server.ts",
    "ui": "vite"
  }
}
```

```
# .gitignore
node_modules/
dist/
.kantan-test/
```

```ts
// src/version.ts
const CLAUDE_BIN = process.env.KANTAN_CLAUDE_BIN ?? "claude"

/** The CLI version string, recorded in every run log header. */
export async function claudeVersion(): Promise<string> {
  const p = Bun.spawn([CLAUDE_BIN, "--version"], { stdout: "pipe" })
  const out = await new Response(p.stdout).text()
  const m = out.match(/(\d+\.\d+\.\d+)/)
  if (!m) throw new Error(`cannot parse version from: ${out.trim()}`)
  return m[1]!   // non-null: noUncheckedIndexedAccess types m[1] as string|undefined
}

export { CLAUDE_BIN }
```

`KANTAN_CLAUDE_BIN` is the seam the fake binary uses in Task 5. Every spawn in this codebase goes through `CLAUDE_BIN`.

**Step 4: Run the test and watch it pass**

```bash
bun test test/version.test.ts
```
Expected: 2 pass (the spec test plus the seam test below).

Also add `@types/bun` and `typescript` as devDependencies and a `typecheck` script. `tsconfig.json` declares `types: ["bun"]`, which has nothing to resolve without the first, and a project with `strict` plus `noUncheckedIndexedAccess` that never runs `tsc` accumulates type errors invisibly. `bun run check` runs typecheck then tests, and is the command every later task should finish on.

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: scaffold project with claude version probe"
```

---

## Task 2: Parse the feature markdown

The backlog is markdown in the target repo. This parser is the only thing that reads it, and a round-trip must preserve the file byte-for-byte apart from the checkbox it ticks. Formatting loss here silently mangles someone's repo.

**Files:**
- Create: `src/backlog.ts`
- Test: `test/backlog.test.ts`

**Step 1: Write the failing tests**

```ts
// test/backlog.test.ts
import { expect, test } from "bun:test"
import { parseFeature, tickTask } from "../src/backlog"

const SAMPLE = `---
status: active
---
# Widget export

- [x] T1 Parse the manifest
      run: 2026-10-11T09:14 · passed
- [ ] T2 Map records to rows
- [ ] T3 Runtime shim (v1.2)

## Notes
Fixtures live in test-fixtures/.
`

test("extracts the feature title", () => {
  expect(parseFeature(SAMPLE).title).toBe("Widget export")
})

test("extracts tasks with ref, text and done state", () => {
  const { tasks } = parseFeature(SAMPLE)
  expect(tasks).toHaveLength(3)
  expect(tasks[0]).toMatchObject({ ref: "T1", done: true })
  expect(tasks[1]).toMatchObject({ ref: "T2", text: "Map records to rows", done: false })
})

test("records each task's line number for a targeted edit", () => {
  const { tasks } = parseFeature(SAMPLE)
  expect(SAMPLE.split("\n")[tasks[1].line]).toContain("T2")
})

test("ignores checkboxes outside the task list", () => {
  const withNote = SAMPLE + "\n- [ ] not a task, it is under Notes\n"
  // Tasks stop at the first heading after the list.
  expect(parseFeature(withNote).tasks).toHaveLength(3)
})

test("ticking a task changes only that checkbox", () => {
  const out = tickTask(SAMPLE, "T2")
  expect(out.split("\n").length).toBe(SAMPLE.split("\n").length)
  expect(out).toContain("- [x] T2 Map records to rows")
  expect(out).toContain("- [ ] T3")
  expect(out).toContain("Fixtures live in test-fixtures/.")
  // Every other line is untouched.
  const a = SAMPLE.split("\n"), b = out.split("\n")
  const changed = a.map((l, i) => (l === b[i] ? null : i)).filter((i) => i !== null)
  expect(changed).toHaveLength(1)
})

test("ticking an unknown ref throws rather than corrupting the file", () => {
  expect(() => tickTask(SAMPLE, "T9")).toThrow(/T9/)
})

test("a task with no ref still parses", () => {
  const { tasks } = parseFeature("# F\n\n- [ ] just text\n")
  expect(tasks[0]).toMatchObject({ ref: null, text: "just text", done: false })
})
```

**Step 2: Run them and watch them fail**

```bash
bun test test/backlog.test.ts
```
Expected: all fail, cannot resolve `../src/backlog`.

**Step 3: Implement**

```ts
// src/backlog.ts
export interface Task {
  ref: string | null
  text: string
  done: boolean
  line: number
}

export interface Feature {
  title: string
  tasks: Task[]
}

const TASK_RE = /^- \[( |x)\] (?:(T\d+)\s+)?(.*)$/

/**
 * Tasks are the checkbox lines in the first contiguous list region, which ends
 * at the first heading after the list starts. Checkboxes under later headings
 * (Notes, etc.) are prose, not backlog.
 */
export function parseFeature(src: string): Feature {
  const lines = src.split("\n")
  let title = ""
  const tasks: Task[] = []
  let started = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!title && line.startsWith("# ")) { title = line.slice(2).trim(); continue }
    if (started && line.startsWith("#")) break
    const m = line.match(TASK_RE)
    if (!m) continue
    started = true
    tasks.push({ ref: m[2] ?? null, text: m[3].trim(), done: m[1] === "x", line: i })
  }
  return { title, tasks }
}

/** Returns src with one checkbox ticked. Every other byte is preserved. */
export function tickTask(src: string, ref: string): string {
  const { tasks } = parseFeature(src)
  const task = tasks.find((t) => t.ref === ref)
  if (!task) throw new Error(`no task ${ref} in this feature file`)
  const lines = src.split("\n")
  lines[task.line] = lines[task.line].replace("- [ ]", "- [x]")
  return lines.join("\n")
}
```

**Step 4: Run and watch them pass**

```bash
bun test test/backlog.test.ts
```
Expected: 7 pass.

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: parse and tick tasks in feature markdown"
```

---

## Task 3: The project store — DONE

**Files:**
- Create: `src/projects.ts`
- Test: `test/projects.test.ts`

A project record, per design §2 and §3.5:

```ts
export interface Project {
  path: string              // repo root
  testCmd: string           // e.g. "bun test", "vendor/bin/pest", "flutter test"
  reportPath?: string       // JUnit XML, for the stall signature
  configDir?: string        // CLAUDE_CONFIG_DIR; undefined means the personal default
  budgetUsd: number
  planModel: string         // "claude-opus-5-5"
  implementModel: string    // "claude-sonnet-5-5"
  planEffort: Effort        // "high"
  implementEffort: Effort   // "medium"
}
export type Effort = "low" | "medium" | "high" | "xhigh" | "max"
```

**Step 1: Write the failing tests**

```ts
import { expect, test } from "bun:test"
import { loadProjects, addProject, defaults } from "../src/projects"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("an absent store reads as empty rather than throwing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orch-"))
  expect(await loadProjects(join(dir, "nope.json"))).toEqual([])
})

test("a new project gets sonnet, high plan effort and medium implement effort", () => {
  const p = defaults({ path: "/repo", testCmd: "bun test" })
  expect(p.planModel).toBe("claude-opus-5-5")
  expect(p.implementModel).toBe("claude-sonnet-5-5")
  expect(p.planEffort).toBe("high")
  expect(p.implementEffort).toBe("medium")
  expect(p.configDir).toBeUndefined()
})

test("adding the same path twice updates rather than duplicates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orch-"))
  const f = join(dir, "projects.json")
  await addProject(f, defaults({ path: "/repo", testCmd: "bun test" }))
  await addProject(f, defaults({ path: "/repo", testCmd: "flutter test" }))
  const all = await loadProjects(f)
  expect(all).toHaveLength(1)
  expect(all[0].testCmd).toBe("flutter test")
})

test("a malformed store throws with the path in the message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orch-"))
  const f = join(dir, "projects.json")
  await writeFile(f, "{ not json")
  await expect(loadProjects(f)).rejects.toThrow(/projects\.json/)
})
```

**Step 2: Run and watch fail. Step 3: implement `src/projects.ts`** with `loadProjects`, `addProject`, `defaults`, reading and writing pretty-printed JSON, creating parent directories as needed. A malformed file throws rather than being silently replaced: this file is the only non-repo state and overwriting it loses the user's configuration.

**Step 4: Run and watch pass. Step 5: Commit**

```bash
git add -A && git commit -m "feat: project store with sonnet and per-phase effort defaults"
```

---

## Task 4: Capture stream-json fixtures — DONE

> Captured 2026-10-11 against CLI 2.1.296. Three fixtures in `test/fixtures/`, both redaction
> passes run, and all twelve of their documented claims verified by assertion. See
> `test/fixtures/README.md`. The capture also validated Task 15's whole contract end to end: the
> agent emitted `ORCH: done` as its final line, wrote the plan to the dictated path, implemented
> nothing, and did not stall asking which execution mode to use. $0.18 on Sonnet at effort high.

Everything downstream is tested against these. They come from real output, not from imagination.

**Files:**
- Create: `test/fixtures/plan-success.jsonl`
- Create: `test/fixtures/ends-with-question.jsonl`
- Create: `test/fixtures/budget-exhausted.jsonl`
- Create: `test/fixtures/README.md`

**The probe scripts cannot produce these.** `probe.mjs`, `probeAB.mjs` and `probeCost.mjs` all print human summaries, skip hook events and truncate lines. Capture raw stream-json directly instead, redirecting the CLI's own stdout:

```bash
# one user turn per line, stream-json shape
printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<PROMPT>"}]}}' > turn.jsonl

claude -p --input-format stream-json --output-format stream-json --verbose \
  --permission-mode bypassPermissions --model claude-sonnet-5-5 --effort medium \
  < turn.jsonl > test/fixtures/<name>.jsonl
```

Keep every line, including the `system/hook_*` flood and the `rate_limit_event` blocks. Task 6 exists to filter those, so the fixtures must contain them.

**Capture all three from real runs. Do not hand-edit.**

| Fixture | How to produce it |
|---|---|
| `plan-success.jsonl` | The Task 15 plan prompt against a scratch repo with a one-task feature file. |
| `ends-with-question.jsonl` | Probe B's prompt: ask it to call `AskUserQuestion`. It cannot, so it asks in prose and exits `success` with no sentinel. |
| `budget-exhausted.jsonl` | Any prompt with `--max-budget-usd 0.0001`, which returns `subtype: error_max_budget_usd`. |

**Step 3: Redact before committing**

Two passes, because they catch different things.

**Identifiers**, which a grep can find:

```bash
grep -riE "$(whoami)|@|sk-ant|/home/|/Users/" test/fixtures/ && echo "REDACT THESE"
```

Replace absolute home paths with `/tmp/scratch`. Keep the long paths long: design §4.3 depends on them for the wrapping test.

**Account telemetry, which no name-based grep will find.** A real `rate_limit_event` carries the
capturing account's window utilization, reset timestamps, overage status and the reason overage
is unavailable. That is private information about a person's plan, and it survives every
identifier scrub because it contains no identifiers. Replace the whole `rate_limit_info` payload
with synthetic values, keeping the shape so the parser and the §4.2 meter still exercise it:

```bash
python3 - <<'EOF'
import json, pathlib
for f in pathlib.Path("test/fixtures").glob("*.jsonl"):
    out = []
    for line in f.read_text().splitlines():
        if not line.strip(): continue
        m = json.loads(line)
        if m.get("type") == "rate_limit_event":
            m["rate_limit_info"] = {
                "status": "allowed", "rateLimitType": "five_hour",
                "resetsAt": 1800000000, "overageStatus": "not_configured",
                "unifiedWindows": {"five_hour": {"utilization": 0.41}},
            }
        out.append(json.dumps(m))
    f.write_text("\n".join(out) + "\n")
EOF
```

Do the same for any `session_id`, and for the `cost` figures if you would rather not publish what
a capture cost.

**Step 4: Write `test/fixtures/README.md`** naming each fixture, what it proves, which CLI version produced it and when.

**Step 5: Commit**

```bash
git add -A && git commit -m "test: capture real stream-json fixtures"
```

---

## Task 5: The fake claude binary

This is the keystone of the test suite. It makes the phase machine, the gate, resume, the stall detector and the budget arithmetic all testable at zero API cost.

**Files:**
- Create: `test/fake-claude.ts`
- Test: `test/fake-claude.test.ts`

Behaviour: read `KANTAN_FAKE_SCRIPT`, a JSON file listing one fixture per turn. Accept the same flags the real binary does and ignore most. Read newline-delimited user messages on stdin and, for each, emit the next fixture's lines to stdout. Exit 0, or exit 1 when that turn's fixture is an error result.

**Step 1: Write the failing tests**

```ts
test("replays one fixture per stdin turn", async () => { /* two turns, two results */ })
test("records the flags it was invoked with for assertions", async () => {
  // writes argv to KANTAN_FAKE_ARGV_LOG so tests can assert on
  // --session-id, --resume, --model, --effort, --max-budget-usd
})
test("exits 1 when the turn's fixture is an error result", async () => { /* budget-exhausted */ })
test("honours CLAUDE_CONFIG_DIR by logging it", async () => { /* account selection */ })
```

The argv log is what lets Task 14 assert that `--max-budget-usd` was `ceiling - spent` and Task 13 assert that effort escalated. Without it those tests can only check outcomes, not the actual invocation.

**Step 2-4: run, implement, run.**

**Step 5: Commit**

```bash
git add -A && git commit -m "test: fake claude binary replaying fixtures"
```

---

## Task 6: Parse the stream

**Files:**
- Create: `src/stream.ts`
- Test: `test/stream.test.ts`

**Step 1: Write the failing tests**

```ts
import { parseStream } from "../src/stream"

test("drops every system/hook_* event", async () => {
  const events = await collect("test/fixtures/plan-success.jsonl")
  expect(events.some((e) => e.kind === "hook")).toBe(false)
})

test("keeps the init event and its tool and skill counts", async () => { /* ... */ })
test("surfaces assistant text", async () => { /* ... */ })
test("surfaces tool_use with name and input", async () => { /* ... */ })
test("pairs tool_result back to its tool_use id", async () => { /* ... */ })
test("surfaces rate_limit_event with window utilization", async () => { /* ... */ })
test("surfaces the result with cost, turns, subtype and is_error", async () => { /* ... */ })
test("a malformed line is reported, not thrown", async () => {
  // A truncated final line must not kill the run. Emit kind:"parse-error".
})
test("a line split across two chunks reassembles", async () => {
  // Feed the file in 7-byte chunks. Same event count as whole-file.
})
```

The chunk-splitting test matters: `probe.mjs` buffers partial lines by hand and so must this. A naive `data.toString().split("\n")` corrupts events the moment a message straddles a chunk boundary, which happens constantly with large tool inputs.

**Step 3: Implement** a transform over the raw byte stream that buffers partial lines, JSON-parses each complete one, filters the hook noise, and maps the rest to a narrow discriminated union: `init | text | tool_use | tool_result | thinking | rate_limit | result | parse-error`.

**The filter is a skipping guard. Apply the rule above before writing it.**

The dimension it reads is `(type, subtype)`. Enumerate it from the fixtures rather than from imagination:

```bash
cat test/fixtures/*.jsonl | python3 -c "
import json,sys,collections
c=collections.Counter()
for l in sys.stdin:
    if l.strip():
        m=json.loads(l); c[(m.get('type'), m.get('subtype'))]+=1
for k,v in sorted(c.items(), key=str): print(v, k)
"
```

Captured fixtures contain at least `system/init`, `system/hook_started`, `system/hook_response`, `system/hook_progress`, **`system/thinking_tokens`**, `assistant`, `user`, `rate_limit_event`, `result/success` and `result/error_max_budget_usd`. That `thinking_tokens` subtype is easy to miss and is **not** hook noise.

Cost of a wrong guess, which is asymmetric:

| Direction | Cost |
|---|---|
| Over-filtering (`subtype.startsWith("hook")` catching too much, or filtering all of `system`) | A real message vanishes from the run log and the UI. Silent, and the user cannot tell the run from a stalled one. |
| Under-filtering | Noise in the stream. Visible, harmless, fixable later. |

So fail toward under-filtering: match an explicit allowlist of hook subtypes, never a prefix, and route anything unrecognised to a `parse-error`-style passthrough that is visible rather than dropped. A new CLI version adding `system/something_new` must show up, not disappear.

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: parse stream-json into typed events, filtering hook noise"
```

---

## Task 6b: Feature file I/O

**Files:** `src/featurefile.ts`; tests alongside

Task 2 guarantees byte preservation only up to the string boundary. This task carries it to disk, and the guarantees are easy to break by accident:

- **Write the bytes back exactly.** No newline normalization, no CRLF conversion, no BOM stripping, no trailing-newline insertion. Bun's `write` does this already; a careless `JSON`/`toString` round-trip does not.
- **Write atomically**, via a temp file in the same directory plus a rename, so a crash mid-write cannot truncate the user's file.
- **Re-read and compare immediately before writing.** The human may have edited the file since it was parsed (design §5 lists this). If the bytes changed, re-resolve the task by ref rather than by cached line number and warn.
- **`Task.line` is valid only for the exact string it came from.** No caller may splice by a cached line number. `tickTask` re-resolves by ref on purpose.
- **`tickTask` returns its input unchanged for an already-ticked task.** A caller that logs or commits only on change must compare `out !== src`, not assume a write happened.

**Known hazard, deliberately deferred:** fenced code blocks are not recognised by the parser. Inside the list region, a `#` comment in a fence ends the list and hides every task after it, and a column-zero `- [ ] T7` in a fence parses as a real task and can be ticked. A feature file is unlikely to fence a checkbox, so this is documented rather than fixed. Revisit if it ever bites.

**Also deferred:** ref-less tasks can never be ticked, since `tickTask` addresses by ref. The runner must either assign refs on ingestion (Task 26b's Haiku drafter is the natural place) or refuse ref-less tasks with a clear message. Decide in Task 13.

```bash
git add -A && git commit -m "feat: atomic, byte-preserving feature file io"
```

---

## Task 7: The run log

**Files:**
- Create: `src/runlog.ts`
- Test: `test/runlog.test.ts`

Per design §2, the raw stream-json appended verbatim is both the live feed and the permanent history.

A header line goes first. It carries everything needed to interpret the rest **and** to resume after a crash:

| Field | Why |
|---|---|
| `claudeVersion` | the stream-json envelope shape depends on it |
| `runId` | names the run |
| `planSessionId` | gate feedback resumes this one |
| `implementSessionId` | minted at gate approval, so absent on a run abandoned at the gate |
| `profile` | which `configDir`, so you can tell which account paid |
| `planModel`, `implementModel`, `planEffort`, `implementEffort` | effort changes during a run; record the starting values and let the stream show escalations |
| `projectPath`, `featureFile`, `taskRef` | what was being worked on |
| `featureFileHash` | the feature file's bytes at parse time. **Without it the mid-run-edit warning is unreachable after a restart**, because a resumed run re-reads immediately before writing and has nothing to compare against |
| `budgetUsd` | the ceiling this run was given |
| `startedAt` | absolute, ISO 8601 |

Reading the profile is not uniform: the default profile's identity lives in `~/.claude.json`, **not** `~/.claude/.claude.json`, and only a non-default `CLAUDE_CONFIG_DIR` keeps it inside the directory.

Every line is one `kind`-tagged JSON object per design §2: `header`, `cli` (one untouched stream-json event nested under `event`), `phase`, `test`, `human`, `end`.

Tests: a header is written once and is the first line; a `cli` record nests its event **byte-identically**, so a future parser can replay it; `phase`, `test` and `human` records round-trip; `replay()` yields the whole file then tails appended lines; `replay()` on a partially written final line does not emit a broken event; two concurrent readers both see every line; a log with no `end` record is readable (that is the crash case Task 7b folds).

```bash
git add -A && git commit -m "feat: append-only run log with replay and tail"
```

---

## Task 7b: The run index

**Files:** `src/runindex.ts`; tests alongside

Nothing yet answers the question both the UI and the git guard need: **what state is this task in?**

Design §3.6 requires the tree to read task state from the run logs rather than only from the
working tree, because a task's tick lives on `kantan/<task-slug>` until merged, so the checked-out
markdown reads it as open. Task 12 needs "a task done-but-unmerged cannot be started again", and
that guard has nothing to consult without this.

**A run's state is the fold of its log** (design §2). Reduce the `kind`-tagged records:

```ts
export type RunState =
  | { kind: "running"; phase: string }
  | { kind: "waiting"; reason: "gate" | "question" | "blocked" | "stalled" }
  | { kind: "done"; merged: boolean }
  | { kind: "failed"; why: string }
  | { kind: "interrupted"; resumeFrom: string }   // no `end` record: the server died

export interface TaskStatus {
  taskRef: string
  state: RunState
  runId: string
  branch: string
  costUsd: number
  attempts: number
}
```

Tests:

- A log with `header` then `phase: waiting(gate)` folds to `waiting(gate)`.
- A log with an `end` record folds to that terminal state.
- **A log with no `end` record folds to `interrupted`, carrying where to resume.** This is the
  crashed-server case and the reason the fold exists.
- A truncated final line is ignored rather than throwing: the server may have died mid-write.
- Several runs for one task ref: the **newest** wins, and earlier ones are still listed as
  attempts.
- A `done` run whose branch is unmerged reports `merged: false`, and Task 12's guard can refuse it.
- An empty `~/.kantan/runs` yields an empty index rather than throwing.
- A log whose `header` names a project that is no longer registered is skipped with a warning, not
  a crash. Someone will delete a project from `projects.json`.

**Cost matters here.** The tree re-renders often. Read what you need and no more: the `header` is
line one and the terminal records are at the tail, so a full parse of every log on every render is
the wrong shape. Measure it against 500 synthetic logs and say what it costs.

```bash
git add -A && git commit -m "feat: fold run logs into per-task state"
```

---

## Task 8: Spawn a phase

**Files:**
- Create: `src/spawn.ts`
- Test: `test/spawn.test.ts`

The flag set, from design §3.1:

```ts
/**
 * One phase invocation. `sessionId` is the PHASE's session, never the run id:
 * design §3.1 gives a run a planSessionId and an implementSessionId, and
 * `--session-id` takes a UUID so neither can be derived from the run id.
 */
export interface PhaseSpawn {
  project: Project
  sessionId: string      // planSessionId or implementSessionId
  resume: boolean        // --resume vs --session-id
  model: string          // project.planModel or project.implementModel
  effort: Effort         // project.planEffort or project.implementEffort, raised on escalation
  remainingUsd: number   // ceiling - spent, per design §3.4: the flag bounds one PROCESS
}

const args = [
  "-p",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",                       // required, or stream-json emits nothing
  "--permission-mode", "bypassPermissions",
  "--model", spec.model,
  "--effort", spec.effort,
  "--max-budget-usd", String(spec.remainingUsd),
  ...(spec.resume ? ["--resume", spec.sessionId] : ["--session-id", spec.sessionId]),
]
const env = { ...process.env, ...(project.configDir ? { CLAUDE_CONFIG_DIR: project.configDir } : {}) }
```

**`spawn.ts` must not choose the model, the effort or the session.** It takes them. Task 13 owns
the mapping from phase to session and model, because choosing the wrong session fails *silently*
(`HANDOFF.md` has the entry). A spawn layer that reached into `project` for "the model" would
make that mistake unrepresentable in a test.

A non-default profile accepts this exact flag set **(probed)**: with `bypassPermissions`, `claude-sonnet-5-5` and effort `medium`, a `Bash` call and an `Edit` both ran, `permission_denials` came back empty, and the file changed. Note that a managed or enterprise profile may carry policy that refuses some of these; treat that as a supported case and surface it, per design §2.1.

Tests, asserted against the fake binary's argv log: a fresh phase passes `--session-id`; a resumed phase passes `--resume` and never `--session-id`; `CLAUDE_CONFIG_DIR` is set only when the project names one; `--effort` carries the phase's level; a resumed phase may carry a **different** `--effort` than the one that started the session (probed: context survives); **the caller's session id is passed through verbatim and never substituted with the run id**; **stdin is drained before closing** (design §5: closing it on `result` produced `SessionEnd hook failed: Hook cancelled` in both probes); SIGTERM resolves without throwing.

```bash
git add -A && git commit -m "feat: spawn a phase with session, account, model and effort"
```

---

## Task 8b: Permissions per project

**Files:** `src/permissions.ts`; tests alongside. Extends `Project` (see below).

Per design §2.2. This is the safety story for anyone who is not the author, and today the design
hardcodes `bypassPermissions`.

Two new fields: `permissionMode` (`"acceptEdits" | "bypassPermissions"`, default `acceptEdits`)
and `allowedTools` (`string[] | null`, default `null` meaning derive).

`deriveAllowedTools(project)` returns:
`Edit`, `Write`, `Read`, `Glob`, `Grep`, `Bash(git *)`, and `Bash(<first word of testCmd> *)`.

**Adding these fields is the three-file change `HANDOFF.md` warns about:** `Project`, `FIELDS` and
`validateProject` must move together or every existing store throws on load. This task is the
first case, so do it properly and leave the pattern visible.

Tests:

- The default derives from `testCmd`: `"npm test"` yields `Bash(npm *)`, `"vendor/bin/pest"`
  yields `Bash(vendor/bin/pest *)`, `"flutter test"` yields `Bash(flutter *)`.
- An explicit `allowedTools` is passed through untouched, not merged with the derived set.
  Merging would mean nobody can express "only these".
- `bypassPermissions` omits `--allowedTools` entirely, since the flag is meaningless with it.
- A `testCmd` of only whitespace is rejected by the store already; assert the derivation never
  produces a bare `Bash(*)` from a blank first word, because that is blanket shell access arriving
  by accident.
- **`permission_denials` on the result event is surfaced, not swallowed.** A denied run must report
  which tool was refused. Add a fixture or a fake-binary script that produces a non-empty
  `permission_denials` and assert it reaches the caller. A denial that looks like a generic
  failure is the confusing-failure case §2.2 exists to avoid.

Then update Task 8's flag set to pass `--permission-mode` from the project and
`--allowedTools` when the mode is `acceptEdits`.

```bash
git add -A && git commit -m "feat: per-project permission mode with a derived allowlist"
```

---

## Task 9: Sentinel detection

**Files:**
- Create: `src/sentinel.ts`
- Test: `test/sentinel.test.ts`

Per design §3.2. `AskUserQuestion` does not exist in `-p` mode, so a question and a completion both exit `success`. Completion is never inferred from exit status.

```ts
export type Outcome =
  | { state: "done" }
  | { state: "blocked"; reason: string }
  | { state: "question"; text: string }
```

Tests:

```ts
test("ORCH: done is done", () => { /* trailing newline and whitespace tolerated */ })
test("ORCH: blocked carries its reason", () => { /* ... */ })
test("no sentinel means question, carrying the text", () => {
  // the ends-with-question fixture
})
test("a sentinel mid-text does not count", () => {
  // Only the final line. Otherwise the agent quoting the prompt would end the phase.
})
test("an error subtype outranks any sentinel", () => {
  // error_max_budget_usd is not "done" even if the text ends with ORCH: done
})
```

That mid-text test is the one that matters. The prompt tells the agent to emit `ORCH: done`, so the string appears in the conversation; matching anywhere would end the phase the moment the agent echoed its instructions.

```bash
git add -A && git commit -m "feat: detect phase outcome from the final sentinel line"
```

---

## Task 10: Stall signature

**Files:**
- Create: `src/stall.ts`
- Test: `test/stall.test.ts`, `test/fixtures/junit-*.xml`

Per design §3.4. These repos run Pest, PHPUnit and `flutter test`, so parsing `bun test` output is not enough.

**The normalizer is a skipping guard, and its two failure directions are both bad.** Apply the rule above.

The dimension it reads is "which substrings of test output are incidental". Enumerate what varies between two runs of the *same* failure: elapsed times (`0.40ms`, `1.2s`, `in 31ms`), timestamps, absolute paths, temp directories, PIDs, ports, ANSI colour codes, random seeds, worker or shard ids, memory figures, and the order of concurrent output.

| Direction | Cost |
|---|---|
| Over-stripping | Every failure hashes alike, so a stall fires on genuine progress and interrupts a run that was converging. |
| Under-stripping | No two runs ever hash alike, so a real loop never trips the detector and grinds until the budget stops it. |

Neither is safe, so this one cannot fail in a cheap direction. Test both ends explicitly: two runs of an identical failure differing only in timing must hash **equal**, and two genuinely different failures must hash **differently**. Build the fixtures from real output of at least two runners with different formats, since a normalizer tuned to one runner's output is a normalizer that does not work.

Prefer `project.reportPath` wherever it exists: a JUnit XML gives the failing test names directly and needs no normalization at all, which is why it is the first branch rather than a nicety.

Tests: a JUnit XML yields the set of failing test names, order-independent; two runs failing the same tests in a different order hash equal; two runs failing different tests hash differently; with no `reportPath`, the normalized stdout tail is used; two runs differing only in elapsed time hash equal; exit code is part of the signature.

```bash
git add -A && git commit -m "feat: failure signature from junit xml or normalized output"
```

---

## Task 11: Test runner

**Files:**
- Create: `src/testrun.ts`
- Test: `test/testrun.test.ts`

Per design §3.3, verification belongs to the server. Run `project.testCmd` in `project.path`, capture stdout, stderr and the exit code, and return them with the signature from Task 10. Never read the agent's claim.

Tests: exit 0 is a pass; non-zero is a fail with output captured; a command that does not exist fails cleanly rather than throwing; a hanging command is killed by a timeout and reported as a failure.

```bash
git add -A && git commit -m "feat: run the project test command and branch on exit code"
```

---

## Task 12: Git guards

**Files:**
- Create: `src/git.ts`
- Test: `test/git.test.ts`

Per design §3.6 and §5. One branch per task in the main checkout, one active run per project.

Tests: a dirty repo refuses to start, and the error names the dirty files; a clean repo creates `kantan/<task-slug>` and checks it out; a run whose branch already exists resumes it rather than failing; a second run on a busy project refuses; the lock releases on normal completion **and** on crash (a stale lock whose pid is gone is reclaimed, or a run is unlockable by hand).

That last one is easy to miss and locks a repo permanently. Write the test first.

**Base branch tests, per design §3.6.** Without these, run 2 branches off run 1 and tasks stack:

```ts
test("records the base branch at run start", async () => { /* ... */ })
test("task 2 branches from base, not from orch/T1", async () => {
  // Run T1, leave its branch, start T2. T2's merge-base is base, not T1.
})
test("returns the checkout to base when a run completes", async () => { /* ... */ })
test("the dirty check applies to new runs but never to resuming a run on its own branch", async () => {
  // A SIGTERM leaves half-written files. Resuming must not be blocked by them.
})
test("a task done-but-unmerged cannot be started again", async () => {
  // The tick lives on orch/T1 until merged, so the working-tree markdown reads
  // it as open. Task state therefore comes from the run logs too, not the tree alone.
})
```

```bash
git add -A && git commit -m "feat: dirty-repo refusal, task branch and per-project run lock"
```

---

## Task 13: The phase machine

**Files:**
- Create: `src/run.ts`
- Test: `test/run.test.ts`

This is where the design's state machine becomes code. States: `running`, `waiting(gate | question | blocked | stalled)`, `done`, `failed`.

Tests, all against the fake binary:

```ts
test("the plan phase ends at the gate, holding no process", async () => {
  // After the plan result, no child process is alive. Design §3.1: the gate can
  // sit for hours, and an idle child dies on a server restart or a dev reload.
})
test("approval starts a FRESH implement session, not a resume of the plan session", async () => {
  // Design §3.1: two conversations, so the implement phase can run a different
  // model. Assert via the argv log that it passed --session-id (a new id) and
  // --model claude-sonnet-5-5, where the plan phase passed claude-opus-5-5.
})
test("gate feedback DOES resume the plan session on the plan model", async () => {
  // Only the plan-to-implement boundary is a new conversation.
})
test("the implement prompt carries the plan file path, since it inherits no context", async () => { /* ... */ })
test("feedback re-runs the plan phase rather than advancing", async () => { /* ... */ })
test("a plan turn ending in a question becomes waiting(question), not done", async () => { /* ... */ })
test("implement then a passing test reaches done and ticks the checkbox", async () => { /* ... */ })
test("a changing failure signature keeps running without interruption", async () => {
  // 9 failing, then 4, then 1, then pass. Never interrupted. No escalation.
})
test("three identical signatures escalate medium to high, not to the human", async () => {
  // Assert via the fake binary's argv log that --effort went to "high".
})
test("escalation walks medium, high, xhigh then stops for the human", async () => { /* ... */ })
test("a run killed mid-implement is resumable from its session id", async () => { /* ... */ })
```

Note the escalation ladder is `medium -> high -> xhigh`, stopping at `xhigh`. `max` is deliberately not in it: the cost guidance reports the highest settings buy little for a large multiple of the cost, and at that point the human is the cheaper next step.

```bash
git add -A && git commit -m "feat: phase machine with gate, sentinels and effort escalation"
```

---

## Task 14: Budget arithmetic

**Files:**
- Modify: `src/run.ts`
- Test: `test/budget.test.ts`

Per design §3.4, probed: `--max-budget-usd` bounds one process, not the run, and a resumed process reports only its own spend. A fresh process reported `$0.004574` and the resumed one `$0.005097`.

Tests:

```ts
test("the running total sums one figure per process, never per turn", async () => {
  // Within one process total_cost_usd is cumulative. Summing every result
  // inside a single process double-counts. Sum the last result per process.
})
test("each respawn passes ceiling minus spent", async () => { /* argv log */ })
test("error_max_budget_usd surfaces as a raisable stop, not a crash", async () => { /* ... */ })
test("a ceiling already spent passes a positive floor, never zero or negative", async () => {
  // --max-budget-usd 0 or negative is not a sane invocation. Stop instead.
})
```

The first test is the trap. Inside one process the figure accumulates, across processes it resets, so the correct reduction is "last result of each process, summed".

A resumed process's own spend includes re-reading the conversation, so later phases legitimately cost more than one turn's worth. Probed figures across three processes on one session: `$0.004409`, `$0.008711`, `$0.009252`. They grow with history but do not carry the prior process's total, which is what rules out a cumulative reading: a cumulative third figure would have been near `$0.013`.

```bash
git add -A && git commit -m "feat: track run cost across respawns and bound each process"
```

---

## Task 15: Phase prompts

**Files:**
- Create: `src/prompts.ts`
- Test: `test/prompts.test.ts`

Per design §3.2, prompts must suppress the interactive checkpoints and require the sentinel as the agent's **final message**, not as part of the prompt.

The plan prompt invokes `superpowers:writing-plans`, which runs headless without stalling (probed), names the exact plan path so the gate knows what to render, and instructs: do not implement, do not run tests, do not ask which execution mode.

The implement prompt invokes `superpowers:executing-plans` and `superpowers:test-driven-development`, and instructs: execute inline, do not pause between batches, do not run `finishing-a-development-branch`, commit on the current branch.

**The prompt must not tell the agent to tick the checkbox.** The server owns that, and only after the test command passes by exit code. An agent that ticks does so before verification, which contradicts §3.3 and would mark a task done on a failing build. One owner: `tickTask` from Task 2, called by the server. Add a test asserting the implement prompt contains no tick instruction.

Do not use `superpowers:brainstorming` in any phase: it is question-and-answer by design and would stall every run.

Tests: the plan prompt contains the exact dictated plan path; both prompts require the sentinel on the final line; both name the suppressions; a snapshot test so prompt edits are deliberate and reviewed.

```bash
git add -A && git commit -m "feat: phase prompts with sentinel contract and checkpoint suppression"
```

---

## Task 16: The server, with its local security

**Files:**
- Create: `src/server.ts`
- Test: `test/server.test.ts`

Per design §4.4. These endpoints feed arbitrary text to an agent running under `bypassPermissions`, so "it only listens on localhost" is not sufficient: any page the user visits can POST to a localhost port, and DNS rebinding defeats the naive assumption.

**Step 1: Write the security tests first, before any route**

```ts
test("binds 127.0.0.1, never 0.0.0.0", () => { /* ... */ })
test("rejects a request whose Host header is an outside domain", async () => {
  // Host: evil.example.com -> 403. This is the DNS rebinding guard.
})
test("accepts 127.0.0.1:<port> and localhost:<port>", async () => { /* ... */ })
test("rejects a POST whose Origin is not the app's own", async () => { /* 403 */ })
test("rejects any request without the per-launch token", async () => { /* 401 */ })
test("mints a different token each launch", () => { /* ... */ })
test("an EventSource connection authenticates via the cookie", async () => {
  // EventSource cannot send custom headers, so a header-only token breaks the
  // run stream. The token is a SameSite=Strict cookie set on page load.
})
test("the vite dev origin is allowed in dev mode only", async () => { /* ... */ })
```

Writing these first is the point. Added afterwards, the middleware gets bolted on and a route slips past it.

**Step 2-4:** run, implement the middleware chain ahead of every route, run.

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: http server with host, origin and token guards"
```

---

## Task 17: SSE and replay

**Files:**
- Modify: `src/server.ts`
- Test: `test/sse.test.ts`

Per design §4.4, the server owns the child process, so closing the browser does not touch the run. That is what makes background runs work.

Tests: a connecting client receives the whole log from byte 0, then live lines; a client connecting mid-run misses nothing; two clients both receive every event; a disconnecting client does not kill the run; reconnecting after a disconnect replays from the start again.

```bash
git add -A && git commit -m "feat: sse run stream with full replay on connect"
```

---

## Task 18: Actions

**Files:**
- Modify: `src/server.ts`
- Test: `test/actions.test.ts`

`POST /api/runs` starts a run. `POST /api/runs/:id/approve`, `/feedback`, `/stop`.

Tests: start refuses on a dirty repo with the reason in the body; start refuses when the project already has an active run; approve on a run that is not at the gate is a 409; feedback re-plans; stop SIGTERMs and leaves the run resumable; an unknown run id is a 404, not a 500.

```bash
git add -A && git commit -m "feat: start, approve, feedback and stop actions"
```

---

## Task 19: Establish the visual world before writing UI

**This task writes no UI code, and the UI tasks are blocked on it.**

**Run it in the main session with the user present.** `init` is a human interview; a subagent cannot answer for them.

Design §4.1 marks the palette provisional. It is the ui-ux-pro-max database default, and its values are Tailwind slate-900, slate-800 and slate-400 with a pure-white focus ring, which is the templated default the project should move past.

**Step 1: Run init**

```bash
sh ~/.claude/skills/impeccable/scripts/impeccable context
```

Then follow `reference/init.md` to interview and write `PRODUCT.md`.

**Step 2: Run new-work** per `reference/new-work.md` to establish the visual world and write `DESIGN.md`. Mode is **Operate**: the visitor completes a task, so scanability and the real usage scene outrank expression.

Inputs that are already settled and must survive: the state vocabulary (running, pass, failed, waiting, done), mono for every number and path, density 8, OLED dark locked for the whole app, one accent used everywhere.

**Step 3: Replace design §4.1** with the real tokens and drop the provisional marker.

**Step 4: Commit**

```bash
git add -A && git commit -m "design: establish product context and visual world"
```

---

## Task 20: UI scaffold and tokens

**Files:**
- Create: `vite.config.ts`, `index.html`, `src/ui/main.tsx`, `src/ui/tokens.css`

Install, checking `package.json` first per the dependency-verification rule:

```bash
bun add -d vite @vitejs/plugin-react
bun add react react-dom
bun add -d tailwindcss @tailwindcss/vite
bun add motion
bun add @tanstack/react-virtual
```

Fonts: **Public Sans and Commit Mono** (both SIL OFL 1.1), self-hosted. The earlier JetBrains Mono / IBM Plex pairing is superseded by the direction contract, and IBM Plex is on the banned-defaults list.

**No radius scale exists, and its absence is the constraint** — the earlier 6px/4px shape lock is superseded. A standards document has rules and reversed plates, not cards. `rounded-*`, `shadow-*` and the stock type and colour scales emit no CSS at all; `--*: initial` wipes Tailwind's theme so `tokens.css` is the whole vocabulary.

```bash
git add -A && git commit -m "feat: vite scaffold with design tokens and self-hosted fonts"
```

---

## Task 21: Three-column shell and the project tree

**Files:** `src/ui/App.tsx`, `src/ui/Tree.tsx`

Project, then feature, then task, from the parsed markdown. The account label sits on every project row: design §5 lists a wrong account as a defect, because mis-billing a client because the UI stayed quiet is a real outcome.

**There are no status dots, and no theme colours to build one from.** `src/ui/tokens.css` exposes the four pigments *only* as `plate-*` utilities carrying background, reversal, tinted muted text and ring together, so colour can commit at region scale and nowhere else. There is no `text-danger`. A coloured dot is accent-scale and would need an arbitrary value, which breaks the encoding.

Carry state in the row itself: weight, case, a reversed cell, or a rule. Reach for a plate only where a whole region is the state — which on the tree means the row for a run that needs the human, not a bullet beside it.

The empty state carries weight, since zero registered projects is the first screen anyone sees. One clear action: point at a repo.

```bash
git add -A && git commit -m "feat: three-column shell with project tree and account labels"
```

---

## Task 22: The virtualized stream

**Files:** `src/ui/Stream.tsx`, `src/ui/Row.tsx`

Per design §4.2 and §4.3. **The virtualizer owns the list.** Magic UI's `AnimatedList` is excluded: verified against its registry source, it reveals children on a `setTimeout` (default 1000ms), slices `children.slice(0, index + 1)`, reverses the result and keeps everything mounted. On a live log it would drip one line per second, in reverse, with no virtualization.

`AnimatedListItem` is separable and is just a spring-transitioned `motion.div`, so that is the per-row animation.

Row animations are keyed by event id and fire **only on first arrival**. Without that, every row re-animates when scrolled back into view.

Long-token wrapping, severity High: `min-inline-size: 0; overflow-wrap: anywhere` on paths. Never `white-space: nowrap`, never `break-all` on prose. The fixtures contain paths over 100 characters, so this is visible immediately.

Tool-call rows clamp to one line and expand on click. `Edit` calls render as diffs via Magic UI Code Comparison.

Test with 10,000 synthetic events and confirm the DOM node count stays bounded.

```bash
git add -A && git commit -m "feat: virtualized run stream with per-row spring on first arrival"
```

---

## Task 23: The gate

**Files:** `src/ui/Gate.tsx`

Renders the plan markdown from the path the server dictated, plus a collapsed list of any other files the plan phase touched. Approve, or a feedback box that re-plans.

A `waiting(question)` run renders the agent's question text with the same reply box, since design §3.2 routes an unanswered question to exactly this surface.

**Border Beam is removed** (design §4.2): running has no colour, and nothing is softened. Liveness is carried by the record visibly growing, which is what an appended document does.

The gate's own signature move is the **full-bleed reversed plate**, and it arrives as a hard cut or a single fast wipe — a standards document does not fade its normative callouts in. `--wipe-duration` is the token; it is zeroed under `prefers-reduced-motion`.

```bash
git add -A && git commit -m "feat: gate panel rendering the plan with approve and feedback"
```

---

## Task 24: Phases, cost and rate limit

**Files:** `src/ui/Sidebar.tsx`

Per-phase durations. Cost as a Number Ticker against the ceiling, in mono numerals.

**Superseded by the adopted design** (`DESIGN.md`, `docs/design/Main.dc.html`): the windows are two `Animated Circular Progress Bar` rings, one per account. The segmented-bar instruction and the `plate-*` utilities this section referenced belonged to the printed-document direction and are gone. Read the artboard.

**Key the rate-limit meter by account, never globally** (design §2.1): limits are per account, and a single global meter would read the wrong window for half the projects.

**Key the banner on `status != "allowed"` and on utilization, not on `overageStatus`.** Every normal event in the probes carried `overageStatus: "rejected"` with `org_level_disabled`, which only means overage cannot be purchased on this plan. A banner keyed on that field fires on every run and trains you to ignore it.

A run grinding past roughly five attempts is flagged with its cost to date. A notification, not a gate.

```bash
git add -A && git commit -m "feat: phase, cost and per-account rate limit meters"
```

---

## Task 25: Keyboard and accessibility

**Files:** modify the UI components

`j` and `k` move through tasks, `Enter` opens, `a` approves. Visible focus rings throughout. Everything collapses to static under `prefers-reduced-motion`: Border Beam, the ticker, the per-row spring, the progress ring.

Test reduced motion by setting the media feature, not by reading the code.

```bash
git add -A && git commit -m "feat: keyboard navigation, focus rings and reduced-motion fallbacks"
```

---

## Task 26: Run the design detector

Per the Impeccable setup output, no automatic hook is active this session, so run it by hand once the UI is finished, not during concept selection:

```bash
~/.claude/skills/impeccable/scripts/impeccable detect --json src/ui
```

Fix everything the batched round shows in one pass. Confirm with at most one more round, then stop. Open-ended self-QA burns money doing worse what a real review does better.

```bash
git add -A && git commit -m "fix: resolve design detector findings"
```

---

## Task 26b: Haiku's two jobs

**Files:** `src/draft.ts`, `src/summarize.ts`; tests alongside

Per design §3.5.1. Both are single-turn `claude -p` calls on `claude-haiku-5-5`, and both are additive: the system works without them.

`draftFeature(text)` turns a rough description into `docs/features/<slug>.md` in the house format, which Task 2's parser must then round-trip. Test that: generate, parse, assert the task list came back intact. A draft the parser cannot read is a failed draft.

`summarizeStall(outputs)` collapses three identical failure outputs into one line. Test that it is never called with fewer than three, and that the UI still shows the raw outputs beside it.

Neither is on the critical path. If either misbehaves, delete the call rather than debugging it under time pressure.

```bash
git add -A && git commit -m "feat: haiku-backed feature drafting and stall summaries"
```

---

## Task 27: The live smoke test

**Files:** `test/live/smoke.test.ts`, skipped unless `KANTAN_LIVE=1`

Everything up to here ran against the fake binary. This is the one test that spends money.

One task, in a scratch git repo, end to end on the real binary: plan, approve, implement, test, done, checkbox ticked, branch created, cost recorded. Keep the task trivial. Budget it at a few cents with `--max-budget-usd`.

```bash
KANTAN_LIVE=1 bun test test/live/smoke.test.ts
```

```bash
git add -A && git commit -m "test: live end-to-end smoke test behind a flag"
```

---

## Verification before claiming completion

REQUIRED SUB-SKILL: Use superpowers:verification-before-completion. Evidence before assertions.

```bash
bun run check                               # typecheck then every suite, paste the output
KANTAN_LIVE=1 bun test test/live/smoke.test.ts
bun run server                              # confirm it binds 127.0.0.1 only
```

Then confirm by hand, because no unit test covers them:

- Close the browser mid-run. The run continues. Reopening replays the whole stream.
- Restart the server mid-run. The run is offered as resumable.
- Start a run on a repo with uncommitted changes. It refuses and names the files.
- Switch a project to a second `configDir`. The profile label changes and the run uses that profile.

Design §5 lists thirteen failure modes. Walk the table and confirm each is handled or deliberately deferred. A deferred one goes in the README, not in silence.

---

## Not in scope

Stated so they do not creep in: no agent personas, no heartbeats or routines, no tracker database, no worktree per run, no provisioned config directories, no multi-agent anything. One task, one session, one human.

Model roles are settled in design §3.5: Opus 5.5 plans, Sonnet 5.5 implements, and that split is only sound because §3.1 makes the two phases two separate conversations. Haiku 5.5 has two jobs outside the loop (design §3.5.1) and none inside it. Never switch models inside one conversation.
