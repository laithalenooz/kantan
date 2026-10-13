# Contributing

Thanks for looking. A few things about this repo that are not obvious, and one
rule that is unusual.

## Build and verify

```bash
export PATH="$HOME/.bun/bin:$PATH"   # bun is standalone, not under nvm
bun install
bun run check                        # typecheck then tests
```

(`curl kantan.sh | sh` is the user-facing install — [`kantan.sh`](kantan.sh) in
this repo. Contributors want a clone they can commit from, which is this.)

**Finish every change on `bun run check`.** It is typecheck *then* tests, in
that order, because `noUncheckedIndexedAccess` is on and a strict project that
never typechecks accumulates errors invisibly. `bun test` alone is not enough.

Bun runs the server and the suite. Node is needed for exactly one thing,
`bun run build`, because Vite needs it.

## The one unusual rule

Read **the skipping-guard rule** in [`CLAUDE.md`](CLAUDE.md) before you write a
rule that decides to skip, filter or normalise an input. One hundred lines of
`src/backlog.ts` produced fourteen defects, every one of them from such a rule
and none from the byte-preservation logic everyone was worried about.

The short version: name the input dimension your guard reads, enumerate every
value it can take including the ones no test produces, state what a wrong guess
costs **in each direction**, and fail toward the cheap one. Then test the
enumeration.

Its corollary matters as much: replaying the existing suite after a change
proves nothing about a rule that reads something the suite never varied. A
symlinked checkout, a profile directory that belongs to a plugin, and a
hand-ticked checkbox were each found that way, with 2500 tests green.

## What a change should come with

- **A test you watched fail first.** Tests written after the code pass
  immediately, which proves nothing about whether they test the right thing.
- **The reasoning, next to the code.** This codebase explains *why* in comments
  rather than in commit messages, because the comment is what the next person
  reads. If a decision was between two options, say what the other one cost.
- **A screenshot, for anything visual.** A passing suite says the nodes exist.
  It does not say they are laid out, visible or legible. `docs/probes/shoot.ts`
  drives a real Chrome; `docs/probes/states.ts` boots a kantan with a run in
  every interesting state so you do not need a live agent to see one.

## What not to send

- **An agent org chart.** No autonomy, no multi-agent orchestration, no
  scheduler. One task, one agent, one human gate. These are the design, not
  gaps in it — see *"What this is not"* in the README.
- **A dependency without a reason that survives being written down.**
- **A change that lets a surface claim a verification it did not observe.**
  Nothing may print an exit code, a green tick or the word "passed" for work
  kantan did not watch pass. This is the project's one hard line.

## Where the reasoning lives

| Path | What |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | the rules, and the traps that have already cost time |
| `docs/HANDOFF.md` | decisions and their reasons, including the ones that were wrong first |
| `docs/probes/` | rerunnable scripts behind every claim marked `(probed)` |
| `docs/plans/*-design.md` | the design |
