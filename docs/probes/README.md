# Probes

Rerunnable scripts behind the claims this project makes. Every `(probed)` mark
in the design doc points at one of these, so you can check rather than trust.

Two kinds, and the difference matters before you run anything.

## The four that cost money

These spawn the **real** `claude` binary against your own account. They
established the design's assumptions on 2026-10-11 against Claude Code
`2.1.296`, and they cost a few cents each.

```bash
node docs/probes/probe.mjs
```

| Script | Establishes |
|---|---|
| `probe.mjs` | A single process holds a session across several turns via `--input-format stream-json`. |
| `probeC.mjs` | `--session-id` then `--resume` preserves context across separate processes. |
| `probeAB.mjs` | `AskUserQuestion` is absent in `-p` mode, and a plan-writing skill runs headless without stalling. |
| `probeCost.mjs` | Cost and `--max-budget-usd` bound **one process**, not the session: cost resets on every `--resume`. |

Their output is the source for the fake-binary fixtures in `test/fixtures/`, so
a version bump means rerunning these before trusting anything downstream of
them. kantan records `claude --version` in every run log header for that reason.

## The three that cost nothing

These spawn no agent and spend nothing. Run them with `bun`.

```bash
bun run docs/probes/states.ts              # a kantan with a run in every state
bun run docs/probes/shoot.ts <url> <out.png> [steps…]
bun run docs/probes/account-key-collision.ts
```

| Script | What it is for |
|---|---|
| `states.ts` | Boots the ordinary server against a **scratch home** — real git repos, real feature files, run logs written through `createRunLog` — so the gate, a running run and the rest can be looked at without driving a billed agent. Writes only under `/tmp`. This is how the screenshots in `docs/screenshots/` are made. |
| `shoot.ts` | Drives real Chrome over CDP: navigate, click, type, screenshot. Exists because a headless `--screenshot` cannot click, and every visual defect reported from use so far has been about a state you only reach by clicking. It **refuses** to press consequential controls unless `--force` is passed — it once approved a real parked run, spent money and committed to a repository. |
| `account-key-collision.ts` | Reproduces, with no kantan code involved, the React duplicate-key render that hung a process until a 3 GB cgroup cap killed it. Two accounts of one kind are what the feature produces, so the collision is not exotic. |

### shoot.ts steps

| Step | Does |
|---|---|
| `size:1440x1200` | sets the viewport before anything loads |
| `click:<text>` | clicks the first element whose text contains this |
| `btn:<text>` | a `<button>` whose own trimmed text is exactly this |
| `sel:<css>` | `querySelector`, then click |
| `nth:<i>:<css>` | the `i`th match, zero-based — CSS cannot say "the fifth" when the matches are not siblings |
| `type:<css>=<value>` | focuses and inserts text; refuses if the selector matches nothing |
| `hover:<css>` | a real pointer move, so `:hover` actually applies |
| `scroll:<y>` | scrolls the window |
| `wait:<ms>` | sleeps |
| `full` | also reports layout metrics |
| `--force` | allows the refused controls |
