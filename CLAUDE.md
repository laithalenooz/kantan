# Working on kantan

A local web UI that drives the real `claude` CLI through one coding task at a time:
plan, a human approval gate, then implement and test until the tests pass by exit code.

## Build and verify

```bash
export PATH="$HOME/.bun/bin:$PATH"   # bun is standalone, not under nvm
bun run check                        # typecheck then tests; finish every change on this
```

Bun is installed standalone in `~/.bun/bin` on purpose. A Bun under an nvm-scoped npm prefix
vanishes from `PATH` when the Node version changes. Node is needed only for Vite.

## Two traps that have already cost time

**`noUncheckedIndexedAccess` is on.** `arr[i]` and `match[1]` are `T | undefined`. Prefer a real
guard, `.entries()`, or destructuring with a default over a blanket `!`. Nothing in `src/` uses a
non-null assertion today; keep it that way if you can.

**`tsc` is not optional.** A strict project that never typechecks accumulates errors invisibly.
That is why `check` runs `typecheck` before `test`, and why `bun test` alone is not enough.

## The skipping-guard rule

`src/backlog.ts` produced fourteen defects in roughly a hundred lines. **Every one came from a
rule that decided to skip, filter, or normalize input**, and none from the byte-preservation
logic everyone was worried about. Three rounds of fixes each introduced the next defect, because
each fix aimed at the case that motivated it rather than the worst case it could hit.

A skipping guard is a guess, and its risk is its worst case. Before writing one:

1. Name the input dimension the guard reads. The specific thing it inspects, not the input.
2. Enumerate every value that dimension can take, including values no test produces.
3. State what a wrong guess costs **in each direction**. They are rarely symmetric, and the
   cheap direction is the one to fail toward.
4. Test the enumeration, as a matrix if it has more than one dimension.

**Corollary:** replaying an existing suite after a change proves nothing about a rule that reads
something the suite never varied. A regression check inherits the blind spots of the suite it
replays, so report the method together with what it cannot see.

## Design constraints that are decisions, not oversights

- **No agent org chart, no autonomy, no multi-agent orchestration.** One task, one session, one
  human. These are the point of the project, not gaps in it.
- **The backlog is markdown in the target repo.** No database. The UI renders and remote-controls;
  it never owns truth.
- **The server runs the tests, not the agent.** Branch on the exit code. Never on the agent
  reporting success. Verification from outside the agent cannot be talked out of.
- **Plan and implement are two conversations.** That is what lets them run different models.
  Switching models inside one conversation cold-starts the prompt cache and drops thinking blocks
  the new model cannot read.
- **A question and a completion are indistinguishable** in `claude -p`, because `AskUserQuestion`
  does not exist there. Hence the `ORCH: done` / `ORCH: blocked` sentinel. It is a literal string
  this codebase emits in prompts and parses in output. Do not "improve" it.

## Scope discipline

Build what the task asks for. Over-building is a defect, not a bonus: an unrequested
`removeProject` or validation framework is work someone has to review, maintain and reason about.

Add no dependencies without a reason that survives being written down.

## Commits

Conventional-ish subject, body explaining *why*. End with:

```
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```

## Where things are

| Path | What |
|---|---|
| `docs/plans/*-design.md` | The design. Claims marked `(probed)` were verified; scripts in `docs/probes/`. |
| `docs/plans/*-implementation.md` | 29 TDD tasks. |
| `docs/HANDOFF.md` | Decisions and deferrals a later task needs. Read before starting one. |
| `docs/probes/` | Rerunnable scripts behind the `(probed)` claims. |
