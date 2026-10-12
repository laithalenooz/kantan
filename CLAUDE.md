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

  **One exception, decided by the user on 2026-10-12**: a project may set `testCmd: null`, meaning
  it has no suite, and then the agent verifies its own work. Most repositories have none, and
  requiring one excluded them. The rule above still holds wherever a command exists, and the
  exception carries a condition that is not optional — **nothing may claim a verification it did
  not observe**. `EndRecord.verifiedBy` records which happened, `verificationOf()` in
  `src/runindex.ts` reads it and answers `"unknown"` for a log written before the field, and no
  surface may print an exit code, a green tick or the word "passed" for a run that was
  self-checked. See `docs/HANDOFF.md`, *"A project may have no test command"*.
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

## `bun --watch` reloads in the same process

Probed across three reloads: the pid and `/proc/<pid>/stat` field 22 (start time) are **identical**
after a reload. So the standard `(pid, start time)` liveness fingerprint cannot tell a reloaded
server from the one that was running before it, and any lock or lease keyed on that pair will read
its own abandoned state as live until you restart.

`src/git.ts`'s run lock carries a per-module-load nonce for exactly this reason, and checks it
*before* the start-time check. If you add anything else that claims an exclusive resource, it needs
the same discriminator.

## Working alongside a background agent

This repo is developed with background agents, and they edit files in the same working tree.

**Do not `git add` until you are ready to commit.** The index is shared, so a file staged
"just to count something" rides into whatever another agent commits next. That has now happened
three times here, most recently to a test file whose author had staged it mid-run and kept working.

**Never `git add -A`, and never a bare `git commit`, while one is running.** Both sweep in
whatever else sits in the shared index. Twice during development a docs-only commit captured
another agent's half-written test file: harmless content, but the message then describes something
other than its diff.

**Commit when a piece is green, not when the task is finished.** Measured here: an agent had
working, tested code on disk at 23:40 and committed it at 05:35, because it was saving the commit
for the end of its task. The machine slept in between, so for six hours that work existed only in
the working tree — where another agent's `git add -A` would have swept it into someone else's
commit, and where nobody looking at the repo could see it existed.

A commit per landed piece also makes the difference between "this agent is stuck" and "this agent
is suspended" visible from outside, which no status display currently shows: elapsed wall-clock is
reported, compute time is not.

**Commit with a pathspec instead:**

```bash
git add src/mine.ts test/mine.test.ts
git commit -m "feat: ..." -- src/mine.ts test/mine.test.ts
```

Verified: a pathspec commit builds from HEAD plus only the named paths, so another agent's staged
files stay staged and uncommitted, and it can then commit them itself. Both land, nothing is lost,
nothing is cross-contaminated. A bare commit with both staged takes both.

This is what makes work on disjoint files parallelisable without a worktree per agent, which
matters because kantan's own design rejects worktree proliferation in favour of serialising runs.

## Motion's `useReducedMotion()` cannot be trusted alone

Probed independently by **three** agents: its preference is a **module-level singleton
initialised at the first call anywhere in the process**, and it answered `false` with
`prefers-reduced-motion: reduce` actually set. One agent saw `<MotionConfig reducedMotion="user">`
fail to suppress even a *transform* animation, because a co-resident sibling test had already
initialised that singleton. A component that
relies on it alone keeps animating for a user who asked it not to.

OR it with a live read:

```ts
const live = useSyncExternalStore(subscribe, () => matchMedia("(prefers-reduced-motion: reduce)").matches)
const reduced = useReducedMotion() || live
```

Related and separate: `<MotionConfig reducedMotion="user">` only switches **transform** animations
off. Opacity, filter and anything hand-rolled keep running, so a blur-fade or a number ticker must
be gated explicitly.

## Screenshot the thing before you call it done

A headless-Chromium screenshot of the gate caught three defects that **no assertion had**:
markdown list items rendering one character per line, a collapsed file list rendering in full
because `display: flex` outranks `[hidden]`, and a missing code chip. Each was invisible to a DOM
test that queried for the right nodes and found them.

```bash
google-chrome --headless --disable-gpu --no-sandbox --window-size=1440,900 \
  --screenshot=/tmp/x.png --virtual-time-budget=4000 http://localhost:5173/
```

A passing suite says the nodes exist. It does not say they are laid out, visible, or legible.

## Scratch directories must be keyed on the pid

Several agents run `bun run check` at once, so a test helper that does
`rm -rf <fixed path>` will delete another process's workspace mid-test. The failures look like
real bugs and move between runs — ten in one, one in the next, with nothing wrong in either copy
of the code.

Key every scratch path on `process.pid`:

```ts
const dir = join(repoRoot, ".orch-test", "<suite>", `${name}-${process.pid}`)
```

`test/run.test.ts` and `test/spawn.test.ts` both do this. Any new suite that writes to disk must.

## Commits

Conventional-ish subject, body explaining *why*. End with:

```
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```

## Where things are

| Path | What |
|---|---|
| `docs/plans/*-design.md` | The design. Claims marked `(probed)` were verified; scripts in `docs/probes/`. |
| `docs/plans/*-implementation.md` | 32 TDD tasks. |
| `docs/HANDOFF.md` | Decisions and deferrals a later task needs. Read before starting one. |
| `docs/probes/` | Rerunnable scripts behind the `(probed)` claims. |
