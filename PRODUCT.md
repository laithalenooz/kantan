# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Bun server (HTTP, SSE, child processes). Vite, React, Tailwind v4, Motion, shadcn/ui, and a
selected handful of Magic UI components for the browser. TanStack Virtual for the run stream.
Chosen deliberately by the owner: an earlier buildless decision was reversed once real components
and motion were wanted, and the reversal was recorded rather than assumed.

## Users

**Primary: the owner.** A developer working across several real repositories at once (Laravel,
Flutter, Next.js), fluent in Claude Code and its headless mode, who already knows what `--effort`
and a permission mode are. Decisions optimise for this person's flow.

**Secondary, explicitly recorded so later work does not foreclose it: a competent stranger.**
kantan is open source and public. Someone who uses Claude Code daily but has never seen kantan
should be able to get a run going. This audience does not get bespoke onboarding, but no decision
may make the tool unusable for them.

The job in both cases: take one task from a backlog through plan, approval, implementation and
tests, without babysitting a terminal.

## Product Purpose

Wrap one straightforward workflow in a UI and add nothing else: ask Claude, plan, execute, test,
refine.

Success is that the owner still reaches for it in six months instead of abandoning it, which is
what happened to the two tools that preceded it. Those failed by growing faster than their
usefulness, not by lacking features.

## Positioning

**kantan refuses parallelism, and verifies from outside the agent.** Both are load-bearing and
both cut against the field.

Surveyed 2026-10-11, the dominant pattern in open-source Claude Code tooling is **a worktree per
task and several agents at once**: Vibe Kanban, Conductor, Crystal, Claude Squad and Claw
Orchestrator are all variants of it. A second camp manages sessions and remote access rather than
work (CloudCLI, opcode, agents-ui). Anthropic ships Agent View, a multi-session dashboard.

Three things a neighbour could not truthfully copy without abandoning its own premise:

1. **A human approval gate between plan and implementation.** The field's tools launch an agent
   and show you the result, or launch several. kantan stops after planning and waits. That is one
   decision per task, at the point where a decision is cheapest.
2. **Verification the agent cannot talk its way around.** kantan runs the project's own test
   command itself and branches on the **exit code**. It never accepts the agent's report that
   tests pass. Tools that trust the transcript cannot make this claim retroactively.
3. **The backlog lives in the user's repository, not the tool's database.** Markdown under
   `docs/features/`, in their git history. Delete kantan and the backlog is still there, still
   diffable, still reviewable by a colleague who has never heard of it.

A fourth, smaller one: **no retry cap.** Progress is detected by hashing the test failure
signature, so a run that is still converging is never interrupted, and a run that is genuinely
looping escalates the agent's effort before it interrupts a person.

## Operating Context

**Two usage scenes, switched deliberately, and the gate is the switch.**

The owner watches the **plan** phase closely, because that is the phase where intervention is
possible and cheap. After approving, they look away during implementation and come back ten to
forty minutes later. So the interface has to serve attentive reading and absent-then-returning
glancing, and the approval gate is the natural boundary between the two.

Returning after an absence, the question is always "what happened, and what needs me?" Running
the plan phase, the question is "is this plan right?"

Other context: one active run per project, several projects in parallel. Runs happen in the
owner's real working repositories with years of history. More than one Claude account is in play,
one personal and one issued by an employer, each with its own config directory and its own rate
limits.

## Capabilities and Constraints

- Drives the real `claude` binary. It does not reimplement an agent loop, so `CLAUDE.md`, skills,
  plugins, hooks, settings and auth all load unchanged.
- One task, one session, one human. No agent personas, no autonomy, no heartbeats, no schedulers.
- No database. The backlog is markdown in the target repo; run logs are JSONL on disk.
- One branch per task, one active run per project. Serialisation is the collision guard, not
  worktrees.
- Local only. Binds `127.0.0.1` and checks `Host`, `Origin` and a per-launch token, because its
  endpoints feed arbitrary text to an agent with file-write and shell access.
- **Behaviour is tied to the Claude Code CLI version**, because the stream-json envelope shape is.
  Every run records `claude --version`.
- Plan and implementation are two conversations, which is what allows a different model per phase.

## Brand Commitments

The name is **kantan**, 簡単, Japanese for simple or brief. It is a commitment rather than a label:
a change that makes the codebase harder to read in an afternoon is at odds with the name, whatever
it buys.

## Evidence on Hand

- `docs/probes/` holds rerunnable scripts behind every claim marked `(probed)` in the design. The
  findings about headless mode were paid for in real API calls and are the repository's most
  immediately useful content.
- `test/fixtures/` holds real captured stream-json, redacted of identifiers and of account
  telemetry.
- Model benchmark figures in the design are quoted from Anthropic's own published pages, verified
  2026-10-11, not from secondary reporting.
- **No users, testimonials, benchmarks of kantan itself, adoption numbers or performance claims
  exist.** Future work must not invent any. The implementation is five tasks of thirty-two.

## Product Principles

1. **Refuse the thing everyone else sells.** Parallel agents and worktree sprawl are the field's
   default and the owner's stated pain point. Saying no early is a feature.
2. **Verify from outside the agent.** Anything the agent reports about its own success is a claim,
   not evidence. The exit code is evidence.
3. **Own no truth the user's repo could own.** The backlog, the plans and the commits belong in
   their repository. The tool renders and remote-controls.
4. **Bound money and progress, never attempts.** A cap on retries stops useful work and misses
   real loops. Cost and lack of progress are the real bounds.
5. **Stay readable.** The codebase must remain something the owner can read in an afternoon and
   change confidently. Opacity is the failure mode that killed the predecessors.

## Accessibility & Inclusion

No product-specific requirement was established beyond the general floor: WCAG AA contrast,
visible focus for keyboard navigation, and motion that collapses under `prefers-reduced-motion`.
The run stream is long and read often, so keyboard navigation of it is a usability requirement
rather than a nicety.
