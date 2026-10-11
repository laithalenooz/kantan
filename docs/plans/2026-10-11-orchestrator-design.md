# Orchestrator: design

A localhost UI that drives the real `claude` binary through one task at a time.

Written 2026-10-11 against Claude Code `2.1.296` and Bun `1.4.3`. Every claim marked
**(probed)** was verified on this machine; the scripts live in `docs/probes/`.

## 1. Why this exists

Agent-orchestration tools tend to drift the same way: an org chart of specialist agents,
autonomous heartbeats and routines, budgets as a headline feature, auto-provisioned credential
stores, and a setup document longer than the thing it configures. The ceremony grows faster than
the usefulness, and what you wanted was never a simulated company.

The workflow this tool wraps is narrower and faster: ask Claude, plan, execute, test, refine. It
adds a UI over that and nothing else.

### 1.1 Non-goals, stated so they can be enforced

- No agent personas, no CEO/CTO/CFO roles, no company metaphor.
- No autonomous behaviour. Nothing wakes itself up. No heartbeats, no routines.
- No tracker database.
- No multi-agent negotiation. One task, one session, one human.
- **No worktree sprawl.** A task owns one branch. Collisions are prevented by running one task
  at a time per project, not by multiplying checkouts.
- **No provisioned config directories.** The tool selects among the config directories the
  owner already maintains. It never creates one. See §2.1.

### 1.2 Versions

Install the latest versions at build time and verify them. Do not trust the numbers above. The
first step of the implementation plan checks them.

The stream-json envelope shape depends on the CLI version, so **every run log records
`claude --version` in its header**.

**Built against, verified 2026-10-11:** Claude Code `2.1.296` (latest published), Bun `1.4.3`
(latest published), Node `26.11.1` (latest; pinned in `.nvmrc`, installed via nvm so other
projects on this machine keep 24.11.1). Node was bumped because the stack now includes Vite.

**Install Bun standalone, not through npm.** A Bun installed under an nvm-scoped npm prefix
disappears from `PATH` the moment the Node version changes, which is exactly what pinning
`.nvmrc` to 26 did. `curl -fsSL https://bun.sh/install | bash` puts it in `~/.bun/bin`, where it
is independent of Node. Node itself is needed only for Vite.

If the CLI's major or minor version changes from `2.1.296`, re-run `docs/probes/probe.mjs` and
`docs/probes/probeC.mjs` before trusting anything here: the stream-json envelope shape is
version-dependent, and the fixtures and parser encode it.

## 2. Four nouns

| Noun | Is actually | Lives in |
|---|---|---|
| Project | a repo directory, a test command, a profile, and its models | `~/.orch/projects.json` |
| Feature | a markdown file | `<repo>/docs/features/<slug>.md` |
| Task | a `- [ ]` line in that file | the same file |
| Run | one task through the pipeline | `~/.orch/runs/<uuid>.jsonl` |

The backlog is markdown in the target repo. Claude edits it with ordinary `Edit` calls, so the
tool needs no MCP server, no schema, and no sync logic. Git history is the audit log.

The run log is the raw stream-json, appended verbatim. It serves as both the live feed and the
permanent history. Delete `~/.orch` and you lose history, nothing else.

**The UI renders and remote-controls. It never owns truth.**

A project record:

```json
{
  "path": "/home/you/code/your-app",
  "testCmd": "npm test",
  "reportPath": "reports/junit.xml",
  "configDir": null,
  "budgetUsd": 50,
  "planModel": "claude-opus-5-5",
  "implementModel": "claude-sonnet-5-5",
  "planEffort": "high",
  "implementEffort": "medium",
  "resumePlanSession": false
}
```

### 2.1 Accounts

Many people hold more than one Claude account, typically a personal one and one issued by an
employer or client. Each lives in its own config directory:

| Profile | Config dir |
|---|---|
| default | `CLAUDE_CONFIG_DIR` unset, so `~/.claude` |
| additional | any directory, e.g. `~/.claude-work` |

A project's `configDir` selects one. The server sets `CLAUDE_CONFIG_DIR` in the spawn
environment, which is the entire mechanism. A second profile runs correctly under `-p`
**(probed)**, including with `bypassPermissions` and real tool calls.

Two consequences are easy to get wrong:

- **A profile carries its own `CLAUDE.md`, skills, plugins and settings**, not just its
  credentials. A second profile is often far less configured than the primary one, so a global
  instruction you rely on can silently stop applying when a project switches profiles. Verify
  that both profiles carry what you expect rather than assuming they mirror each other, and
  surface the active profile prominently in the UI.
- **Rate limits are per account.** Key the 5h window meter by profile, never globally.

A non-default profile runs the full flag set **(probed)**: `bypassPermissions` with
`claude-sonnet-5-5` at effort `medium` ran a `Bash` call and an `Edit` that actually changed a
file, returning `permission_denials: []` and exit 0. The same turn confirmed the `ORCH: done`
sentinel arrives as the final assistant text.

**Do not assume this holds for every profile.** A managed or enterprise profile can carry
policy that restricts permission modes, models, or tools, so check `policy-limits.json` and run
one real tool call before trusting a profile unattended. Treat a profile that refuses
`bypassPermissions` as a supported case, not a bug.

**Reading the account identity differs by directory.** The default profile's identity lives in
`~/.claude.json`, not `~/.claude/.claude.json`; only a non-default `CLAUDE_CONFIG_DIR` keeps it
inside the directory. The run-log header writer needs that special case.

Every run log header records the account used. You should never have to guess which account
paid for a run.

## 3. Pipeline

```
 plan --> [GATE] --> implement --> test --> done
            |                       |
       feedback                   fail
            +--> plan              +--> refine --> test
```

Run states: `running`, `waiting(gate | question | blocked | stalled)`, `done`, `failed`.

### 3.1 Process model

The plan phase runs as its own process:

```
CLAUDE_CONFIG_DIR=<project.configDir> \
claude -p --input-format stream-json --output-format stream-json --verbose \
       --session-id <runId> --permission-mode bypassPermissions --model <model>
```

It writes `docs/plans/<date>-<task-slug>.md` at a path the server dictates, then exits. **The
gate holds no child process.** On approval the server respawns with `--resume <runId>` and the
context returns intact **(probed)**: context survives separate processes and the session id
stays stable. This also survives a server restart, WSL sleep, and every dev-server reload while
building this tool.

Post-gate phases share one live process **until effort changes**. `--effort` is a spawn-time
flag, so each escalation step ends the process and resumes with the next level. `--resume` does
accept a different `--effort` and keeps context **(probed)**. A run therefore spawns once per
phase plus once per escalation.

**Plan and implement are two conversations, not one.** The implement phase starts a fresh session
and reads the plan file rather than resuming the plan session. Two reasons:

1. It is what `superpowers:writing-plans` is built for. Its premise is a plan written for an
   engineer with "zero context for our codebase," so the document is the handoff by design.
2. It is the only legitimate way to run a different model per phase. Anthropic's guidance is
   "switch between conversations, not inside one"; a mid-conversation switch cold-starts the
   cache and drops thinking blocks the new model cannot read.

The cost is real and worth stating: the implement session re-reads files the plan session already
explored. With prompt caching, carrying that context forward would have been cheap, so this trades
a small cost increase for the model split. `project.resumePlanSession` makes it one flag either
way, defaulting to `false` (two conversations).

Gate feedback still resumes the **plan** session, on the same model. Only the plan-to-implement
boundary is a new conversation.

### 3.2 Questions never auto-advance

`AskUserQuestion` does not exist in `-p` mode **(probed)**. The agent searched the deferred tool
list, found nothing, asked its question as plain prose, and exited `subtype=success`. A question
and a completion are therefore **indistinguishable by message type**.

So the server never infers completion from exit status. Instead, each phase prompt instructs the
agent that **its final message must end with a sentinel line**:

- `ORCH: done`
- `ORCH: blocked <reason>`

Anything else, including prose trailing into a question, becomes `waiting(question)` and
surfaces to the human with the text. The plan phase gets this free, because it ends at the gate
regardless.

Post-gate prompts explicitly suppress the skill checkpoints we do not want: execute inline, do
not pause between batches, do not run `finishing-a-development-branch`.

`superpowers:writing-plans` runs headless without stalling **(probed)**, honours a dictated
plan path, and emits a plan that names its own successor skill.

### 3.3 Verification belongs to the server

The server runs the project's `testCmd` itself and branches on the **exit code**. It never
accepts the agent's claim that tests pass. This enforces
`superpowers:verification-before-completion` from outside the agent, where no prompt can talk
its way around it.

### 3.4 Bounds: progress and money, not attempt counts

An attempt cap stops legitimate grinding and fails to stop real loops. Three bounds instead.

**Stall detection, which escalates effort before it escalates to the human.** After each test
run, hash a failure signature. Three consecutive identical signatures mean a loop, not progress.
A changing signature means progress, so the run continues freely: nine failures down to four
down to one is never interrupted.

On a stall, raise effort one level and continue rather than stopping:

```
implement @ medium --> test
   stall --> high  --> test
   stall --> xhigh --> test
   stall --> waiting(stalled), with the identical outputs shown side by side
```

Each step respawns, because `--effort` is set at spawn time. Resuming with a different effort
preserves context **(probed)**, so the only cost is a cold prompt cache. Counting the gate's own
`high` to `medium` change, a fully escalating run pays three cache cold starts.

This is Anthropic's measured "re-run failures at higher effort" pattern, which held the pass
rate of running everything at the higher setting for a little over half the cost. It requires a
usable failure signal, and §3.3 is exactly that.

**The ladder stops at `xhigh`; `max` is deliberately excluded.** Anthropic's own FrontierCode 1.1
figures show Sonnet 5.5 scoring **52.1% at `xhigh` but 46.2% at Max** - the top setting is worse,
not merely more expensive. Past `xhigh` the human is the cheaper and better next step.

Deriving the signature needs care, because a project's test runner is whatever it is: Pest,
PHPUnit, pytest, `go test`, `flutter test`, Jest, `cargo test`. Do not assume one output format:

1. Prefer `project.reportPath`, a JUnit XML file, and hash the set of failing test names.
2. Otherwise hash the normalized tail of stdout, stripping durations, timestamps, absolute
   paths and ANSI codes.

**Budget ceiling.** `--max-budget-usd` bounds **one process, not the run** (probed). A fresh
process reported `$0.004574` and the resumed process `$0.005097`, so cost resets per process
rather than accumulating. (Within a single process it does accumulate.) Therefore:

- The server keeps the running total per run, summing one figure per process.
- Each respawn passes `--max-budget-usd = ceiling - spent`.
- Exhaustion surfaces as `subtype=error_max_budget_usd` with exit 1 **(probed)**, which is the
  signal to catch.

Set the ceiling high and make it configurable per project and per run. The owner routinely
spends on the order of $100 in a session, so a low default would only get in the way. This bound
exists to stop runaway cost, not to throttle.

**Stop button.** SIGTERM the child. The session resumes from the same `--session-id`, so
stopping costs nothing.

A soft nudge past roughly five attempts flags the run as grinding and shows cost to date. It is
a notification, not a gate.

### 3.5 One model per run, effort per phase

**Sonnet 5.5 implements; Opus 5.5 plans.** Plan at effort `high`, implement at `medium`.

| Phase | Model | Effort | Why this one |
|---|---|---|---|
| plan | `claude-opus-5-5` | `high` | Leads CursorBench (57.8 vs 55.5) and FrontierCode (54.4 vs 52.1), which measure code reasoning. One turn, reviewed by a human, so capability matters more than per-token cost here than anywhere else in the system. |
| implement, test, refine | `claude-sonnet-5-5` | `medium` -> `xhigh` | Leads Terminal-Bench 4.0 (70.6 vs 66.4), which is agentic terminal work: exactly this phase. Also the phase with the most turns, so the cheaper model compounds. |

This split is only sound because §3.1 makes the two phases two conversations. Within a single
conversation it would be the one arrangement to avoid.

Model selection is deliberately the last lever. Anthropic's cost guidance sweeps effort first
and warns: "Switch between conversations, not inside one: a mid-conversation switch cold-starts
the cache and, where the new model cannot read the old one's thinking blocks, runs on without
that reasoning." Since a run resumes one conversation across the gate, splitting models across
phases would cold-start the cache **and** silently discard the plan phase's reasoning, because
Sonnet 5.5 cannot read Opus 5.5's thinking blocks. So the tempting "Opus plans, Sonnet
implements" shape is the one arrangement to avoid.

Sonnet is also the better fit on merit for this workload, not merely the cheaper one. Verified
against Anthropic's own Sonnet 5.5 page:

| Benchmark | Sonnet 5.5 | Opus 5.5 |
|---|---|---|
| Terminal-Bench 4.0 | **70.6%** | 66.4% (at xhigh) |
| CursorBench 4.0 | 55.5% | **57.8%** |
| FrontierCode 1.1 | 52.1% at xhigh (46.2% at Max) | **54.4%** |

Sonnet leads on Terminal-Bench, the benchmark closest to this workload, and trails by about two
points on the other two. Anthropic's framing: Sonnet 5.5 "complements Opus 5.5 best when running
at lower effort settings, where it costs less per task," and at higher settings "can perform
comparably at a similar cost." So the real gap is cost per completed task, not capability.

| Model | ID | In / Out per 1M | Default effort |
|---|---|---|---|
| Opus 5.5 | `claude-opus-5-5` | $4 / $20 | medium |
| Sonnet 5.5 | `claude-sonnet-5-5` | $2 / $10 | high |
| Haiku 5.5 | `claude-haiku-5-5` | $0.10 / $0.50 | medium |

`medium` for implementation is Sonnet 5.5's own starting point for agentic coding, since its
effort levels were recalibrated from Sonnet 5. Do not carry a level over from another model.

Either model is overridable per project: a repo where planning is cheap can plan on Sonnet, and a
repo that keeps stalling can implement on Opus. Never mid-conversation.

### 3.5.1 Where Haiku 5.5 earns its place

At $0.10 / $0.50 it is twenty times cheaper than Sonnet, and at 39.2% on Terminal-Bench it has no
business in the implement loop. Two jobs outside the loop fit it well, because both are bounded,
single-turn, and produce output a human reads before it matters:

| Job | Why Haiku | Failure cost |
|---|---|---|
| **Draft a feature file.** Paste a rough description, get `docs/features/<slug>.md` with a task list in the house format. | Single-turn structured transformation, the shape it is good at. | You are editing the markdown anyway. Visible and harmless. |
| **Summarize a stall.** Collapse three identical failure outputs into one readable line for the UI. | Bounded input, no judgment required, called at most twice per run. | The three raw outputs stay on screen beside it. |

**What does not warrant a model, stated so it does not creep in:** branch slugs (a regex),
commit messages (the agent that made the change writes them), and deciding whether a stall is
real (that is the signature hash, and a model would make it non-deterministic).

Both `--model` and `--effort` are session flags on the CLI, so this is configuration, not
architecture.

One limitation: the guidance recommends the 1-hour prompt-cache TTL for loops that wait on a
human between turns, which describes the gate exactly. The CLI does not expose cache TTL, so the
default applies.

### 3.6 Where a run works

A task owns **one branch**, created in the project's main checkout as `orch/<task-slug>`. The
agent commits its own work there, so the repo never sits dirty between runs and a bad run rolls
back by deleting the branch.

**The server allows one active run per project.** That serialization is the collision guard. Per-run
worktrees would also prevent collisions, but they proliferate, and a task maps to one branch
rather than many. Runs across different projects proceed in parallel freely.

The dirty-repo refusal in §5 therefore does double duty: it guards against clobbering
uncommitted work and against a second run entering an occupied repo.

**Base branch discipline.** Without it, run 2 branches off run 1 and tasks silently stack:

- Record the base branch at run start. Every task branches from **that base**, never from
  whatever branch the last run left checked out.
- The plan phase commits its plan file, so the gate does not sit on a dirty tree.
- On `done`, return the checkout to base. The task's tick then lives on `orch/<task-slug>` until
  merged, so the tree would read it as open.
- **The tree therefore reads task state from the run logs, not only from the working tree**, and
  shows "done, unmerged on orch/T1" as its own state. A task in that state cannot be started
  again.
- The dirty check applies to **new** runs only. Resuming a run on its own branch must not be
  blocked by the half-written files a SIGTERM left behind.

## 4. Interface

Stack: Vite, React, Tailwind v4, Motion, shadcn/ui, and selected Magic UI components. Bun serves
the API and spawns children.

```
+--------------+---------------------------+-------------+
| PROJECTS     |  RUN . T2 Parse headers        | PHASES      |
| v your-app   |  plan OK   [GATE]  impl   | plan   8s   |
|   work       | ------------------------- | impl  2m14  |
|   v importer |  [rendered plan.md]       | test  fail  |
|     x T1     |                           | ----------- |
|     > T2 <   |  > Bash  npm test    OK   | $0.42/50    |
|     o T3     |  > Edit  src/importer.js  | 5h: 41%     |
| > other-repo |                           | [Stop]      |
|   personal   | +-----------------------+ |             |
|              | | Approve | feedback... | |             |
+--------------+-+-----------------------+-+-------------+
```

Mode is **Operate**: the visitor completes a task. Scanability, consistency, and the real usage
scene outrank expression. Brand lives in precise details.

Dials: variance 6, motion 4, density 8.

The account label sits on every project row and in the run header. Mis-billing a client because
the UI stayed quiet about the account is a defect.

### 4.1 Tokens (provisional)

**Run `impeccable init` then `new-work` before the first UI commit.** The palette below is the
ui-ux-pro-max database default, matched to its "RPA / Automation Dashboard" profile. The match
is apt for the state vocabulary, but the values are Tailwind slate-900, slate-800 and slate-400,
which is the default this project should move past. The ring color also breaks the no-pure-white
rule. Treat the semantics as settled and the hex values as a starting point.

| Token | Provisional value | Meaning |
|---|---|---|
| background / card / muted | `#0F172A` / `#1B2336` / `#272F42` | surfaces |
| foreground / muted | `#F8FAFC` / `#94A3B8` | text |
| accent | `#22C55E` | running, pass |
| destructive | `#EF4444` | failed |
| waiting | amber | gate, stalled, question |
| done | blue | finished |

OLED dark, locked for the whole app. No section inverts.

Status color is semantic, never decorative. The status dots carry real state, which is the
documented exception to the no-decorative-dots rule.

Type: JetBrains Mono for paths, costs, durations, session ids, task refs and test output. IBM
Plex Sans for labels and prose. All numbers are mono.

Shape lock: 6px panels, 4px chips, no pills. Applied everywhere.

### 4.2 Motion and components

Each effect states what it communicates. Nothing animates for show.

| Effect | Communicates | Source |
|---|---|---|
| spring enter per stream row | feedback: something arrived | `AnimatedListItem`, used alone |
| Border Beam on the active run panel | state: this is live. Stops at the gate | Magic UI |
| Number Ticker on cost | feedback: cost is accruing | Magic UI |
| Animated Circular Progress | the 5h rate-limit window, per account | Magic UI |
| Code Comparison | diffs inside `Edit` tool calls | Magic UI |
| File Tree | the project and feature and task tree | Magic UI |

**Magic UI `AnimatedList` and `Terminal` are excluded from the stream.** Verified against its
registry source: `AnimatedList` reveals children on a `setTimeout` (default 1000ms), slices
`children.slice(0, index + 1)`, reverses the result, and keeps everything mounted. It is a
notification-stack demo reel. On a live log it would drip one line per second, in reverse, with
no virtualization. `AnimatedListItem` is separable and is just a spring-transitioned
`motion.div`, so that is the per-row animation we keep. Treat `Terminal` as likely scripted too
and verify before use.

**The virtualizer owns the stream.** Row animations are keyed by event id and fire only on first
arrival, or every row re-animates when scrolled back into view.

No marquee, no meteors, no confetti. Everything collapses to static under
`prefers-reduced-motion`.

### 4.3 Two hard constraints

**Virtualize the stream.** A long run emits thousands of events. Use TanStack Virtual.

**Long-token wrapping.** Tool calls carry absolute paths over 100 characters. Apply
`min-inline-size: 0; overflow-wrap: anywhere`. Never `white-space: nowrap`, and never
`break-all` on prose.

Tool-call rows clamp to one line and expand on click. Keyboard: `j` and `k` move through tasks,
`Enter` opens, `a` approves. Focus rings stay visible.

The empty state carries weight, because zero registered projects is the first screen anyone
sees. Give it one clear action: point at a repo.

### 4.4 Transport and local security

SSE carries the run stream. Plain `POST` carries actions: start, approve, feedback, stop.

The server owns the child process, so closing the browser does not touch the run. On reconnect
the server replays the JSONL from byte 0, then tails live. No websocket and no reconnect state
machine.

**These endpoints feed arbitrary text to an agent running under `bypassPermissions`, so
"it only listens on localhost" is not sufficient.** Any page the owner visits can POST to a
localhost port, and DNS rebinding defeats the naive assumption. Required:

- Bind to `127.0.0.1` only, never `0.0.0.0`.
- Reject any request whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>`.
- Reject any POST whose `Origin` is not the app's own.
- Mint a token per launch and require it on every request.

**The token travels in a `SameSite=Strict` cookie, not a header.** `EventSource`, the browser's
SSE client, cannot send custom headers, so a header-only token would break the run stream
outright. The cookie is set on page load.

**In production Bun serves the built `dist/`, giving a single origin.** In development Vite runs
on its own port, so it would fail the `Origin` check: dev mode proxies `/api` to Bun and allows
the Vite origin, and only in dev mode.

About ten lines of server code, and not optional.

## 5. Failure modes

| Failure mode | Observed | Handling |
|---|---|---|
| `SessionEnd hook failed: Hook cancelled` | probed, both runs | Drain before closing stdin |
| `hook_*` events flood the stream | probed, ~20 before the first real message | Filtered at parse for display; the log stays raw |
| Rate limit actually constrained | probed | Key the banner on `status != "allowed"` and on utilization. **Not** on `overageStatus`: every normal probe event carried `overageStatus: "rejected"` with `org_level_disabled`, which only means overage cannot be bought, so a banner keyed on it fires on every run |
| `subtype=error_max_budget_usd`, exit 1 | probed | Budget exhausted. Offer a raise and resume |
| Budget resets on respawn | probed | Server tracks the total and passes `ceiling - spent` |
| CLI version drift changes stream shape | expected | Record `claude --version` in the run log header |
| Server restart kills the child mid-run | expected | Session id is on disk. Mark the run resumable, offer one click |
| Browser closed | by design | The run continues. SSE replays from JSONL |
| Repo dirty when a run starts | expected | Refuse, and say why. Never stash someone's work silently |
| Second run requested for a busy project | expected | Refuse. One active run per project |
| Human edits the feature markdown mid-run | expected | Re-read before write, last write wins, warn |
| `claude` exits non-zero | expected | Mark failed, keep stderr in the log |
| Output truncated at the token cap | expected | Treat as a failed attempt, not a retry at the same cap |
| Wrong account on a project | expected | Show the account on every row and run header |

## 6. Testing

**The keystone is a fake `claude` binary.** A script replays canned stream-json fixtures
captured from the probe output in `docs/probes/`. The server reads its binary path from config,
so the phase machine, gate, resume logic, stall detector and budget arithmetic all run at zero
API cost in milliseconds.

Tests, with `bun test`:

- Markdown parser round-trip: file to tasks and back, preserving formatting.
- Phase machine against fixtures, including a turn that ends in a question.
- Stall detector against three identical failure signatures, and against a changing one.
- Signature derivation from JUnit XML and from a normalized stdout tail.
- Budget arithmetic across a simulated respawn.
- Resume after kill.
- Host and Origin rejection.
- One live smoke test against the real binary.

## 7. Scale

Roughly 1000 lines of server and 900 of UI. One active run per project, parallel across
projects.

## 8. Open questions

- Should the gate render the plan file alone, or the plan plus the diff of any files the plan
  phase touched?
