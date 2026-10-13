# kantan — everything in the system, for designing the site

**Hand this whole file to Claude Design.** It is the feature inventory, the
screenshot inventory, the design tokens, and a copy bank. Everything in it is
true of the shipped code; every number was measured.

**The page itself lives in its own repo**, `kantan-landing`, and is generated
from the `Landing` artboard in this project's design canvas — so the canvas is
the source and a revision there is one command away from the live page. This
file is the brief *behind* that page: the inventory, the claims and the limits.
Nothing here is a layout instruction.

---

## 1 · What kantan is

**簡単** *kantan*: simple, brief.

A local web UI that drives the real `claude` CLI through one coding task at a
time: it reads your repo and writes a plan, **you approve it**, then a fresh
agent implements it and kantan runs your tests until the exit code says they
pass.

It spawns the real `claude` binary rather than reimplementing an agent loop, so
your `CLAUDE.md`, skills, plugins, hooks, settings and auth all load exactly as
they do in your terminal. Nothing to port, nothing to configure twice.

Runs on `127.0.0.1`, one process, one port. Talks to no service.

**Who it is for:** someone who already uses Claude Code in a terminal, trusts it
to write code, and does not trust it to decide that it is finished. The feeling
to sell is **leaving the room** — you approve a plan and go and do something
else, because what decides whether the work is done is your own suite's exit
code and not the agent's opinion of itself.

---

## 2 · Feature inventory, screen by screen

Everything here exists and works. This is the complete surface.

### The run, which is the product

| Feature | What it does | Worth showing? |
|---|---|---|
| **Plan phase** | An agent reads the repo and writes a plan to `docs/plans/<date>-<task>.md`. Touches no code. | yes |
| **The gate** | The plan rendered as markdown, with **Approve plan** and **Send back**. Nothing moves until a human decides. ⌘↵ approves. | **the hero** |
| **Send back with a note** | A reply box beside the buttons. Resumes the *plan* conversation with your words passed through byte for byte. | yes |
| **Implement phase** | A **fresh** conversation on the task's own `kantan/<task>` branch — fresh so the two phases can run different models without cold-starting the prompt cache. | yes |
| **Test phase** | kantan runs your command and reads the **exit code**. Never the agent's report. | **lead with this** |
| **Refine on failure** | A non-zero exit sends it back to refine, then tests again. | yes |
| **Effort escalation** | The same failure repeating escalates `--effort`, because `--resume` accepts a different one and keeps context. | nice detail |
| **Stall detection** | Three identical failures at top effort is `stalled` — a calm state, not an error. No red, no cross, because nothing got worse. | yes |
| **Budget ceiling** | Per-run dollar ceiling. A run that hits it parks for a human instead of dying, and can be **raised in place** and continue. | yes |
| **Stop and resume** | Stop SIGTERMs the child and leaves the run resumable — the session resumes from the same id, so stopping costs nothing. Resume picks up from the last complete phase. | yes |
| **Answer a question** | `AskUserQuestion` does not exist in `-p`, so an agent that asks something exits "success". kantan catches that by a missing sentinel, parks the run, and your reply goes back to **the session that asked**. | good story |
| **Run record** | Every stream-json event as a row: `AGENT`, `READ`, `EDIT`, `SHELL`, `GREP`, tool results, rate-limit events, commits. Virtualised — 10,000 events render 22 rows. Newest at the bottom, with a Following toggle. | yes |
| **Live digest** | A plain-language "while you were away" summary above the record: *"Still going. The tests have not run yet."* | yes |
| **Phase rail** | Plan → Gate → Implement → Test → Refine, with per-phase elapsed time and the live one marked. | yes |
| **Live cost** | Dollars spent against this run's ceiling, with a bar. `--max-budget-usd` bounds one *process*, so kantan tracks the total itself and passes `ceiling − spent`. | yes |
| **5-hour window** | Which account this run bills to, and where its rate-limit window stood. | yes |
| **SSE replay** | On connect the server replays the run's JSONL from byte 0, then follows live. Closing the browser is safe; there is no cursor and no reconnect state machine. | mention |

### The task tree (left rail, always present)

| Feature | What it does |
|---|---|
| **Projects** | Each with its repo name, its test command, and the Claude account it bills to as a chip. |
| **Task files** | `docs/features/*.md` in the repo, collapsible. |
| **Tasks** | Every `- [ ]` line, with a state glyph and label. |
| **Ten states** | `open`, `running`, `needs-you`, `passed`, `checked-off`, `failed`, `stalled`, `done-unmerged`, `interrupted`, `grinding`. All ten are distinguishable **with colour removed**. |
| **Add task** | Type it, or have Claude draft several and pick from them. |
| **New task file** | Describe the work and an agent writes the whole file. |
| **Keyboard** | Arrow keys move between task rows; the tree is one control. |

### Project settings panel

| Feature | What it does |
|---|---|
| **Account switch** | Which Claude account this project bills to. **Always asks first**, in a dialog, because getting it wrong costs real money. |
| **Test command** | Edit it, **run it once** to prove it works before trusting it, or declare the project has no suite. |
| **Default ceiling** | The dollar default for new runs. |
| **Task files** | Which markdown files kantan reads. |
| **Advanced** | Per-project models and efforts for plan and implement, permission mode, allowed tools. |
| **Remove project** | Confirmation dialog. Removes the record, keeps the run logs. |
| **Project summary** | Task counts by state and total spend. |

### Add a repository

| Feature | What it does |
|---|---|
| **Checks as you type** | Per keystroke: is it absolute, is it a git repo with a working tree, is it the root, has it any commits, are there task files. Each answer is git's **own sentence**, including the one that locates a typo: *"The deepest part of that path which does exist is /home — check the spelling of what comes after it."* |
| **Detects the test command** | Reads `package.json` and friends and proposes one. Only ever a **declared** command. |
| **Account choice** | Personal, work, or "Not sure" — which is recorded as unknown rather than defaulted. |
| **Run it once** | Tries the command before the project is saved. |
| **Live preview** | A mock of how the project will appear in the tree. |

### Accounts

| Feature | What it does |
|---|---|
| **Per-account usage** | Rate-limit windows per Claude profile, shortest first. |
| **Honest freshness** | `live`, `last seen`, `window reset`, `never used`. An expired reading draws **no bar** and says "was 90%". A window with no figure says "no figure reported" rather than drawing 0%. |
| **Profile discovery** | Scans your home directory for folders that look like Claude profiles — keyed on a `.credentials.json` inside, not on the name, because a plugin's `~/.claude-mem` matches every name-based rule. |
| **Add an account** | Name it and say whether it bills as personal or work. kantan will **not** guess that part. |

### The guarantees, which are features

| Feature | What it does |
|---|---|
| **Exit codes, never self-report** | The server runs the tests. |
| **`verifiedBy` on every run** | Records *which* kind of verification happened. A project may have no suite; then the agent checks itself, and the screen says **"Self-checked"** — never an exit code, a tick, or the word passed. A log written before that field existed reads **"unknown"**, never as a pass. |
| **"Checked off"** | A ticked checkbox with no run kantan performed reads "Checked off" in grey with an **outline** tick, not "Passed" in green. |
| **One run per project** | Two agents can never share a working tree. A task that cannot start says why in a sentence. |
| **Markdown is the truth** | Your backlog is markdown in your repo, in your git history. kantan renders and remote-controls it; it never owns it. |
| **Local only** | Binds `127.0.0.1`, checks `Host` and `Origin` against exact allowlists, and a per-launch token in an `HttpOnly; SameSite=Strict` cookie. |
| **Derived permissions** | By default the agent gets the five file tools, `Bash(git *)`, and one rule for the program your tests run. Nothing else — no network, no package installs, no arbitrary shell. |

---

## 3 · Screenshots we have

In `docs/screenshots/`, PNG, 1440px wide, no scrollbars. Taken by
`docs/probes/states.ts`, which boots an ordinary kantan against a scratch home
— real git repos, real task files, real run logs — so these are **the product,
not mockups**.

| File | Size | What is in the frame | Best used for |
|---|---|---|---|
| `gate.png` | 1440×1500 | The full gate: orange **"Needs you"** band across the top with elapsed wait, breadcrumb, *"Is this plan right?"*, the plan rendered as markdown with a numbered change list, the plan's file path and "Planned in 7m 0s · $0.00", a collapsed "Planning also read 1 file", the reply box with **Send back** and the black **Approve plan** pill, then the run record below. Right rail: phase rail, cost against ceiling, 5-hour window, Stop run. | **The fold.** One image is the whole idea. |
| `running.png` | 1440×1200 | Indigo **"Running"** band, *"Still going."* digest, "You approved the plan", and the sentence *"Each pass or fail above is the exit code of `npm test`, read by kantan itself. What the agent says about its own work is never used."* Run record with AGENT / EDIT / SHELL rows. Rail shows Implement live, cost live. | Claims 1 and 2 together, in the product's own words. |
| `start.png` | 1440×1100 | The start panel for an open task: three numbered cards (Plan / You decide / Build and test), "Runs as personal", the test command, and a blue notice that another run is in flight with a disabled **Start planning**. | Claim 3 — one task at a time, explained rather than greyed out. |
| `accounts.png` | 1440×1000 | Per-account rate-limit windows with "window reset" and "was 3%", a found-on-disk profile offered with **Use this folder**, **Add an account**, and the footnote *"kantan only sees what its own runs report."* | Honesty as a product value. |
| `overview.png` | 1440×1100 | Nothing selected: *"Start a task."*, the three steps, and a floating illustration of a repo card, a task file and a mini gate. | Explaining the model without a diagram. |

### What we do not have yet, and what it would take

- **A 30–60s screen recording** of plan → gate → approve → green. `states.ts`
  stages everything up to the gate for free; the approve-to-green half needs one
  real billed run. This is the highest-value missing asset.
- **`failed`, `stalled`, `grinding`, `done-unmerged`, `interrupted`** as
  screenshots. All reachable — add a fixture log to `states.ts`; no money needed.
- **The add-repository and project-settings panels.** Both reachable by a click
  in `states.ts`; say the word.
- **Mobile.** The app is a desktop tool and has no mobile layout. Do not mock one.

---

## 4 · Design tokens, already in use

Source: `src/ui/tokens.css`. Extend this language rather than inventing one.

**Type.** Geist and Geist Mono, self-hosted (`src/ui/fonts/`). The monospace is
load-bearing: paths, commands, branch names and exit codes are always mono.

**Light only.** `<meta name="color-scheme" content="only light">`. There is no
dark variant, by decision.

| Role | Hex |
|---|---|
| Page ground | `#f4f4f6` |
| Panel / card | `#fafafb` |
| Panel alt | `#f0f0f3` |
| Hairline | `#eeeef1` |
| Edge / edge-strong | `#e7e7eb` / `#dcdce2` |
| Ink | `#111216` |
| Ink deep | `#1e2026` |
| Muted 900 / 700 / 500 / 400 / 300 | `#3a3d45` / `#4a4e59` / `#5f6370` / `#6b7080` / `#a3a7b1` |
| **Attention** (the gate, "needs you") | `#ff6a1a`, tint `#fff1e8`, ink `#9a3b06` |
| Indigo (links, live, running) | `#5b5bd6`, deep `#4b4bc8`, deeper `#3a3aa8`, tint `#dcdcf6` |
| Pass | `#0f8a5f`, deep `#0f7a54` |
| Fail | `#d92d3a` |
| Account chip | tint `#e0f2fe`, ink `#075985` |

**Shape.** Cards `12–18px`. Pills `999px`. The primary action is a single black
pill. A dotted ground sits behind the centre column as **its own absolutely
positioned layer** — it carries a `mask-image`, and a mask on a container
applies to its children, which faded the content when it was tried that way.

**Easing.** `cubic-bezier(.2, .7, .2, 1)`. Fades ~0.45–0.8s, state changes ~0.2s.

### Two motion facts worth carrying over

Both cost this project real time, and both apply to any animated page.

1. **Framer Motion's `useReducedMotion()` cannot be trusted alone.** Probed
   independently three times: the preference is a module-level singleton
   initialised at the first call anywhere in the process, and it answered
   `false` with `prefers-reduced-motion: reduce` actually set. OR it with a live
   `matchMedia` read.
2. **`<MotionConfig reducedMotion="user">` only switches *transform* animations
   off.** Opacity, filter and anything hand-rolled keep running, so a blur-fade
   or a number ticker has to be gated explicitly.

And one CSS trap this repo has now hit twice, the second time on the landing
page itself: **`display: flex` or `display: grid` on a class outranks the user
agent's `[hidden]` rule.** An element you think you hid stays painted. Add an
explicit `.thing[hidden] { display: none }`.

---

## 5 · Positioning: four claims, in this order

### 1. "The server runs your tests, not the agent."
Branches on the **exit code**, never on the agent reporting success.
Verification from outside the agent cannot be talked out of. Concrete and
immediately legible to a sceptic — and visible in `running.png`.

### 2. "No surface claims a verification it did not observe."
The unusual one, and backed by code: `verifiedBy`, `verificationOf()` answering
`"unknown"` for an older log, "Self-checked" instead of a tick, and "Checked
off" for a hand-ticked box. The same rule caught a defect in kantan's own UI
this week. **Nobody else in this space talks this way.**

### 3. "The opposite of an agent framework."
No org chart. No autonomy — nothing wakes itself up. No multi-agent
orchestration. No tracker database. No worktree sprawl. Every one is a reaction
to a tool that started well and drifted: the ceremony grows faster than the
usefulness. Contrarian and the most quotable.

### 4. The probe findings — the part people share
Cost real money to learn, useful to someone who will never run kantan. Scripts
in `docs/probes/`.

- **`AskUserQuestion` does not exist in `-p` mode.** The agent asks in prose and
  exits `subtype: success`, so a question and a completion are
  **indistinguishable by message type**. Never infer completion from exit status.
- **`--max-budget-usd` bounds one process, not your run.** Cost resets on every
  `--resume`, so a per-process ceiling silently restarts at each gate.
- **`--resume` accepts a different `--effort`** and keeps context, which is what
  makes escalation-on-stall possible.
- **Switching models inside one conversation is a trap.** Cold-starts the prompt
  cache and drops thinking blocks the new model cannot read.
- **Hook events flood the stream** — ~20 `system/hook_*` before the first real one.

---

## 6 · Copy bank — already written, already true

Usable more or less verbatim.

> kantan works through the tasks in a markdown file in your repo, one at a time.
> It writes a plan, waits for your OK, then implements it and runs your tests
> until the exit code says they pass.

> Read it the way you would read a teammate's draft.

> The server runs your tests, not the agent. It branches on the exit code and
> never on the agent reporting success. Verification from outside the agent
> cannot be talked out of.

> kantan runs one task at a time, so this one can start once that run finishes
> or you stop it.

> Resumable. Stopping costs nothing.

> kantan only sees what its own runs report.

> Each pass or fail above is the exit code of your test command, read by kantan
> itself. What the agent says about its own work is never used.

> Nothing runs until you press start.

> Your backlog is markdown in your own repo, in your own git history.

Install, which is genuinely three lines:

```bash
bun install
bun run build     # needs Node, for Vite
bun run server    # 127.0.0.1:3100
```

---

## 7 · Honest limits — and two things the page must not say

Maturity, framed the way the README frames it: **"it works, and it is rough in
places."** More credible than a claim of polish.

- Pipeline runs end to end against the real binary, one process, one port.
- **75 modules, 2,591 tests**, one skipped — the live smoke test, gated so it
  cannot spend money in CI.
  *These four figures move whenever the code does — they were 73 / 2,576 /
  2,695 / 731 KB a few hours before this line was written. Re-measure before
  publishing: `find src -name '*.ts' -o -name '*.tsx' | wc -l`, `bun test`,
  `wc -l src/run.ts`, `bun run build`.*
- Rough edges, listed by name rather than hidden: the usage view only sees what
  kantan's own runs reported; a second account must be named by hand once;
  `src/run.ts` is 2,817 lines of one state machine; one 741 KB bundle, no code
  splitting; an event a future CLI adds renders as raw JSON until someone gives
  it a row.
- **It has only ever been run on one machine** (WSL2). No clone-build-run
  elsewhere yet.

**Do not say:**

1. **Anything implying unconditional verification.** "Always verified by your
   tests" is false for a project with no test command, and refusing to blur that
   line is the whole of claim 2. Say *"your tests decide, and when there are none
   it says so."*
2. **Autonomous, agent swarm, self-improving, AI employee.** The absence of all
   of that is the product.

---

## 8 · A starting shape, to take or leave

1. **Hero** — headline, one-sentence lede, the three install lines, `gate.png`
   full width. The gate is the idea; show it above the fold.
2. **How it works** — the five stages with the human one marked, and the
   four-noun table (Project / Feature / Task / Run). Three of the four already
   exist on the reader's disk, which is the point.
3. **The three claims** — as cards, each with the mechanism named, not just the
   promise. `running.png` and `start.png` alongside.
4. **What this is not** — the five negatives, as a list. Short, blunt, quotable.
5. **What we learned about `claude -p`** — the probe findings. This is the
   section that gets the post shared, including by people who will never install
   it.
6. **Honest status** — the test count, and the rough edges by name. Ending on
   candour is the right note for this audience.

Interaction worth having, if you want it: the five stages clickable, and a
toggle for "does this project have a test command" that switches a status row
between `Passed · exit 0` and `Self-checked`. Both are in the reference page —
the second one teaches claim 2 in a single click, which no paragraph does.
