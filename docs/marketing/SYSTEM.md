# kantan — a brief for designing the landing page

Everything here is true of the shipped code. Where a number appears it was
measured, and where a claim is unusual the file that backs it is named, so
nothing in the marketing has to be softened later.

**簡単** *kantan*: simple, brief.

---

## One sentence

A local web UI that drives the real `claude` CLI through one coding task at a
time: it plans, **you approve**, then it implements and runs your tests until
the exit code says they pass.

## Who it is for

Someone who already uses Claude Code in a terminal, trusts it to write code, and
does not trust it to decide that it is finished. They want to hand over a task,
read the plan, say yes, and come back to a commit — not to supervise a
conversation, and not to configure a fleet of agents.

The emotional pitch is **leaving the room**. You approve a plan and go and do
something else, because the thing that decides whether the work is done is your
own test suite's exit code and not the agent's opinion of itself.

---

## The four things to lead with, in this order

### 1. "The server runs your tests, not the agent."

kantan spawns your test command itself and branches on the **exit code**. It
never branches on the agent reporting success. Verification from outside the
agent cannot be talked out of.

Concrete, immediately legible to a sceptic, and visible in the product: the
running screen says, in its own words, *"Each pass or fail above is the exit
code of `npm test`, read by kantan itself. What the agent says about its own
work is never used."*

### 2. "No surface claims a verification it did not observe."

This is the unusual one, and it is backed by code rather than by a promise.

A project may legitimately have **no** test command — most repositories do not,
and requiring one excluded them — and then the agent checks its own work. That
is a weaker claim, so kantan records **which of the two happened**
(`EndRecord.verifiedBy`), and no screen prints an exit code, a green tick or the
word "passed" for a run that checked itself. It says **"Self-checked"**. A log
written before that field existed reads **"unknown"**, never as a pass.

The same rule caught a defect in kantan's own UI this week: a task whose
checkbox someone had ticked by hand showed **"Passed"** with a green tick, for
work kantan had never run. It now reads **"Checked off"** in grey, and clicking
it explains that kantan has no run for it and names the three ways that happens.

Nobody else in this space talks this way. It is the most defensible thing the
project has.

### 3. "The opposite of an agent framework."

- **No agent org chart.** No CEO, CTO or specialist personas.
- **No autonomy.** Nothing wakes itself up. No heartbeats, no schedulers.
- **No multi-agent orchestration.** One task, one agent, one human gate.
- **No tracker database.** Your backlog is markdown in your own repo, in your
  own git history. The UI renders and remote-controls; it never owns truth.
- **No worktree sprawl.** One branch per task, one active run per project.

Every one of those is a reaction to a tool that started well and drifted. The
ceremony tends to grow faster than the usefulness. Contrarian, memorable, and
the thing most likely to be quoted.

### 4. The probe findings — the part people share

These cost real money to discover and are useful to someone who will never run
kantan, which is what gets a post passed around. Every script is rerunnable in
`docs/probes/`.

- **`AskUserQuestion` does not exist in `-p` mode.** The agent asks in prose and
  exits `subtype: success`, so a question and a completion are
  **indistinguishable by message type**. Never infer completion from exit
  status. kantan requires a sentinel line instead.
- **`--max-budget-usd` bounds one process, not your run.** Cost resets on every
  `--resume`, so a ceiling set per process silently restarts at each gate. Track
  the total yourself and pass `ceiling − spent`.
- **`--resume` accepts a different `--effort`** and keeps context, which makes
  effort escalation on a stall possible.
- **Hook events flood the stream.** Roughly twenty `system/hook_*` messages
  arrive before the first real one.
- **Switching models inside one conversation is a trap.** It cold-starts the
  prompt cache and drops thinking blocks the new model cannot read. kantan runs
  plan and implement as two conversations for exactly this reason — which is
  also what lets them run different models.

---

## How it works, in the product's own vocabulary

```
 plan --> [YOU APPROVE] --> implement --> test --> done
             |                             |
        feedback                    fail, and keep going
             +--> plan                     +--> refine --> test
```

It spawns the real `claude` binary. It does not reimplement an agent loop, so
your `CLAUDE.md`, skills, plugins, hooks, settings and auth all load exactly as
they do in your terminal. **There is nothing to port and nothing to configure
twice** — a strong line for the page.

Four nouns, three of which already exist on the reader's disk:

| Noun | Is actually | Lives in |
|---|---|---|
| Project | a repo directory, a test command (or none), a Claude account | `~/.kantan/projects.json` |
| Feature | a markdown file | `<repo>/docs/features/<slug>.md` |
| Task | a `- [ ]` line in that file | the same file |
| Run | one task through the pipeline | `~/.kantan/runs/<uuid>.jsonl` |

Words the UI uses, which the page should not contradict: **gate**, **needs
you**, **run record**, **phases**, **checked off**, **self-checked**,
**grinding** (the same failure three times at top effort), **interrupted**.

---

## What is genuinely true about maturity

Do not oversell this. The honest framing is *"it works, and it is rough in
places"*, which is also more credible than a claim of polish.

- The pipeline runs end to end against the real binary, from **one process on
  one port**.
- **73 modules, 2,576 tests**, one skipped — the live smoke test, which spawns
  the real CLI and is gated so it cannot spend money in CI.
- Known rough edges are listed by name in the README rather than hidden: the
  usage view only sees what kantan's own runs reported, a second Claude account
  must be named by hand once, `src/run.ts` is 2,695 lines of one state machine,
  one 731 KB JS bundle, and an event a future CLI adds will render as raw JSON
  until someone gives it a row.
- It has only ever been run on one machine (WSL2). A clone-build-run elsewhere
  has not happened yet.

Install is three commands and one process:

```bash
bun install
bun run build     # needs Node, for Vite
bun run server    # 127.0.0.1:3100
```

---

## The visual system already in use

The app has a finished visual language. The landing page should extend it rather
than invent one. Tokens are `src/ui/tokens.css`.

**Type.** Geist and Geist Mono, self-hosted — deliberately no Google Fonts
`<link>`, because that is a third-party request on every load of a tool that
binds loopback precisely so it talks to nothing.

**Light only.** `<meta name="color-scheme" content="only light">`. There is no
dark variant, by decision.

| Role | Value |
|---|---|
| Page ground | `#f4f4f6` |
| Card / panel | `#fafafb`, hairline `#eeeef1`, edge `#e7e7eb` |
| Ink | `#111216`, deep `#1e2026` |
| Muted text | `#5f6370`, lighter `#6b7080`, lightest `#a3a7b1` |
| **Attention** — the gate, "needs you" | `#ff6a1a`, tint `#fff1e8`, ink `#9a3b06` |
| Indigo — links, live/running | `#5b5bd6`, deep `#4b4bc8` |
| Pass | `#0f8a5f` · Fail | `#d92d3a` |
| Account chip | tint `#e0f2fe`, ink `#075985` |
| Easing | `cubic-bezier(.2,.7,.2,1)` |

Shapes: generously rounded (`12–16px` cards, `999px` pills), a dotted ground
behind the centre column, and a single black pill for the primary action.

**Motion, and a caution worth carrying into any animated page.** Framer Motion's
`useReducedMotion()` cannot be trusted alone — probed independently three times,
its preference is a module-level singleton initialised at the first call
anywhere in the process, and it answered `false` with `prefers-reduced-motion:
reduce` actually set. OR it with a live `matchMedia` read. And
`<MotionConfig reducedMotion="user">` only switches **transform** animations
off: opacity, filter and anything hand-rolled keep running, so a blur-fade or a
number ticker has to be gated explicitly.

---

## The screenshots, and what each one is for

In `docs/screenshots/`, all 1440px wide, taken from
`docs/probes/states.ts` — an ordinary kantan booted against a scratch home, so
they are the real UI and not a mockup.

| File | Shows | Use it for |
|---|---|---|
| `gate.png` | The hero. The "Needs you" band, an agent-written plan rendered as markdown, the phase rail, cost against the run's ceiling, and the Approve / Send back pair. | The fold. This one image is the whole idea. |
| `running.png` | A run mid-implement: phases with Implement live, live cost, the event log, and the "read by kantan itself" note. | Differentiator 1 and 2 together. |
| `start.png` | The start panel, refusing because another run is in flight, and saying so in a sentence instead of greying a button out. | Differentiator 3 — one task at a time. |
| `accounts.png` | Rate-limit windows per account, saying "last seen" and "window reset" rather than drawing a stale bar, plus a profile found on disk offered as a suggestion. | Honesty as a product value. |
| `overview.png` | Nothing selected: the three steps, and the four nouns. | Explaining the model without a diagram. |

**Still to make:** a 30–60 second screen recording of plan → gate → approve →
green. `states.ts` can stage everything up to the gate; the approve-to-green
half needs one real billed run.

---

## Lines that are already written and already true

Usable more or less verbatim.

> kantan works through the tasks in a markdown file in your repo, one at a time.
> It writes a plan, waits for your OK, then implements it and runs your tests
> until the exit code says they pass.

> Read it the way you would read a teammate's draft. If you approve, a fresh
> agent implements it, and kantan runs `bun run check` until the exit code says
> it passed.

> The server runs your tests, not the agent. It branches on the exit code and
> never on the agent reporting success. Verification from outside the agent
> cannot be talked out of.

> kantan runs one task at a time, so this one can start once that run finishes
> or you stop it.

> Resumable. Stopping costs nothing.

> kantan only sees what its own runs report.

---

## Two things the page must not say

1. **Do not imply unconditional verification.** "Always verified by your tests"
   is false for a project with no test command, and the whole of differentiator
   2 is that kantan refuses to blur that line. Say "your tests decide, and when
   there are none it says so."
2. **Do not call it autonomous, or an agent swarm, or self-improving.** The
   absence of those is the product.
