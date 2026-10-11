# kantan

**簡単** *kantan*: simple, brief.

A local web UI that drives the real `claude` CLI through one coding task at a time:
plan, you approve, then implement and test until the tests pass.

> **Status: early.** The design is finished and evidence-backed. The implementation is
> five tasks of thirty-one, at 99 tests. If you came for working software, come back later. If you came
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

**Permissions.** An unattended agent needs broad tool access to run its own tests and commit.
Decide for yourself what you grant it, per project, and prefer an explicit allowlist over
blanket bypass on anything you would not hand to a stranger. Bind the server to `127.0.0.1`,
and keep the `Host`, `Origin` and token checks: the endpoints feed arbitrary text to an agent
with tool access.

## Design

- [Design](docs/plans/2026-10-11-orchestrator-design.md), with every probed claim marked.
- [Implementation plan](docs/plans/2026-10-11-orchestrator-implementation.md), 31 TDD tasks.

## Licence

MIT. See [LICENSE](LICENSE).
