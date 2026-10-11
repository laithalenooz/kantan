# Probes

Scripts that established the design's technical assumptions on 2026-10-11 against
Claude Code 2.1.296. Run them with `node <file>`; they cost a few cents each.

| Script | Establishes |
|---|---|
| `probe.mjs` | A single process holds a session across multiple turns via `--input-format stream-json`. |
| `probeC.mjs` | `--session-id` then `--resume` preserves context across separate processes. |
| `probeAB.mjs` | `AskUserQuestion` is absent in `-p` mode, and `/superpowers:writing-plans` runs headless without stalling. |

`probeCost.mjs` establishes that cost and `--max-budget-usd` bound one process, not the session.

Their output is the source for the fake-binary test fixtures.
