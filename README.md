# kantan

**簡単** *kantan*: simple, brief.

A local web UI that drives the real `claude` CLI through one coding task at a time:
plan, you approve, then implement and test until the tests pass.

> **Status: early.** The design is finished and evidence-backed. The implementation is
> five tasks of thirty-two, at 99 tests. If you came for working software, come back later. If you came
> for the hard-won facts about `claude -p`, those are in [`docs/probes/`](docs/probes/) and
> they are the best part of this repo today.

## What this is not

Read this part first, because it is the whole design.

- **No agent org chart.** No CEO, CTO or specialist personas.
- **No autonomy.** Nothing wakes itself up. No heartbeats, no routines, no schedulers.
- **No multi-agent orchestration.** One task, one session, one human. If you want a fleet of
  agents negotiating with each other, this will disappoint you, deliberately.
- **No tracker database.** Your backlog is markdown in your own repo, in your own git history.
- **No worktree sprawl.** One branch per task, one active run per project.

Every one of those is a reaction to a tool that started well and drifted. The ceremony tends
to grow faster than the usefulness.

## How it works

```
 plan --> [YOU APPROVE] --> implement --> test --> done
             |                             |
        feedback                    fail, and keep going
             +--> plan                     +--> refine --> test
```

It spawns the real `claude` binary. It does not reimplement an agent loop, so your
`CLAUDE.md`, skills, plugins, hooks, settings and auth all load exactly as they do in your
terminal. There is nothing to port and nothing to configure twice.

Four nouns, three of which already exist on your disk:

| Noun | Is actually | Lives in |
|---|---|---|
| Project | a repo directory, a test command, a profile | `~/.orch/projects.json` |
| Feature | a markdown file | `<repo>/docs/features/<slug>.md` |
| Task | a `- [ ]` line in that file | the same file |
| Run | one task through the pipeline | `~/.orch/runs/<uuid>.jsonl`, raw stream-json |

**The server runs your tests, not the agent.** It branches on the exit code and never on the
agent reporting success. Verification from outside the agent cannot be talked out of.

## Running it

Not yet. The server and UI arrive in later tasks. When they do, this section is the contract:

```bash
git clone https://github.com/laithalenooz/kantan && cd kantan
curl -fsSL https://bun.sh/install | bash     # standalone, not via npm
bun install
bun run check                                # typecheck and tests, to prove the clone works
```

Two things you will need: the `claude` CLI on your `PATH`, already logged in, and a repo with a
`docs/features/<slug>.md` holding `- [ ] T1 ...` lines.

Until then, `bun run check` works today and runs the full suite.

## Permissions, and what kantan grants an agent

An unattended agent needs real tool access: it runs its own tests and commits its work. So this
is per-project configuration, and the default is **derived from what you already declared**
rather than guessed:

| Granted by default | Why |
|---|---|
| `Edit`, `Write`, `Read`, `Glob`, `Grep` | implementing and reading the repo |
| `Bash(git *)` | the agent commits on the task branch |
| `Bash(<your testCmd> *)` | TDD runs the suite it is writing against |

Nothing else. No network, no package installs, no arbitrary shell. `bypassPermissions` is
available if you want it on your own machine, but it is not the default, because a default that
hands blanket shell access to a stranger's repo is the wrong default no matter how convenient it
is for the author.

A denied tool shows up in the UI by name, so the fix is a line of config rather than a debugging
session.

## What we learned about `claude -p`, so you do not have to

These cost real money to discover. Every script in [`docs/probes/`](docs/probes/) is
rerunnable, so you can check rather than trust.

- **`AskUserQuestion` does not exist in `-p` mode.** The agent asks in prose and exits
  `subtype: success`, so a question and a completion are indistinguishable by message type.
  Never infer completion from exit status. kantan requires a sentinel line instead.
- **`--max-budget-usd` bounds one process, not your run.** Cost resets on every `--resume`,
  so a ceiling set per process silently restarts at each gate. Track the total yourself and
  pass `ceiling - spent`.
- **`--resume` accepts a different `--effort`** and keeps context, which makes effort
  escalation on failure possible. It needs a respawn, since `--effort` is set at spawn time.
- **Hook events flood the stream.** Roughly twenty `system/hook_*` messages arrive before the
  first real one. Filter at parse.
- **`rate_limit_event` carries `overageStatus: "rejected"` on every normal event** when
  overage is disabled for the org. Key a warning on `status`, not on that field, or it fires
  constantly.
- **Switching models inside one conversation is a trap.** It cold-starts the prompt cache and
  drops thinking blocks the new model cannot read. Switch between conversations instead.

## Two warnings worth reading

**The stream-json shape depends on the CLI version.** These findings were probed against
Claude Code `2.1.296`. kantan records `claude --version` in every run log for that reason. On
a version bump, rerun the probes before trusting any of it.

**The server is not a public service.** It binds `127.0.0.1` and checks `Host`, `Origin` and a
per-launch token, because its endpoints feed arbitrary text to an agent with tool access. Do not
expose it, and do not remove those checks to make a reverse proxy work.

## Design

- [Design](docs/plans/2026-10-11-orchestrator-design.md), with every probed claim marked.
- [Implementation plan](docs/plans/2026-10-11-orchestrator-implementation.md), 32 TDD tasks.

## Licence

MIT. See [LICENSE](LICENSE).
