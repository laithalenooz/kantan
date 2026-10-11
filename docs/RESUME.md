# Resume point

Paused 2026-10-11 for a shutdown. Everything below is on disk and in git.

## Where the build stands

**19 of 32 tasks landed and pushed.** 818 tests, typecheck clean at the last green run.

Done: 0 versions · 1 scaffold · 2 backlog parser · 3 project store · 4 fixtures · 5 fake binary ·
6 stream parser · 6b feature file I/O · 7 run log · 8 spawn · 8b permissions · 9 sentinel ·
11 test runner · 12 git guards · 15 prompts · 16 server · 19 product + direction · 20 UI tokens ·
26b Haiku jobs.

## Interrupted mid-flight — their files are on disk, uncommitted

Three agents were working when the session paused. **Their code survives; their context does not.**
Re-dispatch each with its brief rather than resuming the agent.

| Task | Files on disk | State |
|---|---|---|
| **7b** run index | `src/runindex.ts`, `test/runindex.test.ts`, modified `src/runlog.ts` | well along: **21 of 27 mutants killed**, was analysing 6 survivors. Was adding `featureFileHash` to `RunHeader` |
| **10** stall signature | modified `src/stall.ts`, `test/stall.test.ts`, ~20 fixtures under `test/fixtures/output/` | captured real output from **dart, jest and pest** — that capture is the expensive part, keep it. Was nearly done, running its final attributable check |
| **13** phase machine | nothing yet | barely started: had confirmed a green baseline and was about to plan. Re-dispatch from scratch |
| **17** SSE | modified `src/server.ts` | was adding the run stream. **Had just found that Bun cuts an idle stream at ~10s**, so a 15s keep-alive never fires — see HANDOFF |

Check `git status` first: anything uncommitted there is one of these four, not a mistake.

## Start the thing

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun run check                                  # typecheck then tests
ORCH_DEV=1 bun run server                      # API on 127.0.0.1:3100
bunx vite                                      # UI on localhost:5173
```

`ORCH_DEV=1` is required or the Vite origin is refused with a 403 — that refusal is the
rebinding guard working, not a bug.

## Ports freed for kantan

Two systemd user services were stopped and are **still `enabled`**, so they return on reboot and
will retake the ports:

- `paperclipai.service` → was on **3100**
- `lms-preview.service` → was on **5173**

```bash
systemctl --user stop paperclipai.service lms-preview.service
```

Unrelated, noted while looking: **18 `paca-acp-bridge@*` services are still running**, one per
agent, each holding a Claude Code process. Paca's tracker was removed; its fleet was not.

## Next actions, in order

1. **Re-dispatch 7b, 10, 13, 17** with their briefs. 13 is the funnel and needs
   `docs/SEAMS.md` plus the stdout-drain warning (a 93 KB log through a 64 KB pipe deadlocks a
   machine that awaits `exited` before draining).
2. **Fix the plan text for Tasks 21 to 24 before dispatching them** — it still says Border Beam,
   status dots, a progress ring and IBM Plex, all of which the locked direction removed. Without
   that they will reach for arbitrary values and break the token encoding.
3. **Add a monument size token.** §4.1 asks for "extreme, monumental against tiny mono" and only
   two size tokens exist, so a later task would invent one.
4. Then 14, 18, 21-25, 26, 27.

## Decisions already settled, do not reopen

- **Yellow carries ink, not white type.** ISO 3864-1 Table 1 pairs yellow with black; no yellow
  that still reads as a warning can carry light type. The original brief asked for the impossible.
- **`resumePlanSession` is removed.** It made two lines of the implement prompt false.
- **The escalation ladder stops at `xhigh`.** Sonnet 5.5 scores lower at Max on FrontierCode.
- **Colour has no theme tokens.** Pigments exist only as `plate-*` utilities, so colour can only
  commit at region scale.

## Going public

The repo is **private**. `docs/` is scrubbed and the working tree is clean of identifiers, but the
**pre-scrub history was squashed away rather than filtered**, and GitHub keeps unreachable objects
fetchable by SHA. To publish provably clean: `gh auth refresh -h github.com -s delete_repo`, then
delete and recreate from the current single-commit history.
