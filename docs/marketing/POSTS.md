# Launch posts

Four platforms, four different readerships, one set of facts. Everything below is
checkable against the repository — if you edit a number, edit it here too, and
`docs/marketing/SYSTEM.md` holds the full inventory the copy is drawn from.

**The assets are in `docs/media/`:** `flow.mp4` (upload this wherever video is
allowed) and `flow.gif` (for the places that only take images). Both are the
real UI driving a real run log. `docs/media/README.md` says exactly what is real
in them and what is re-enacted — read it before you answer a question about it,
because somebody will ask.

Figures used below, all current as of v0.1.0:

| Claim | Where it comes from |
|---|---|
| 75 modules, 2591 tests, 1 skipped | `bun run check`; the skip is the real-CLI version test, gated because CI has no `claude` |
| probed against Claude Code `2.1.296` | `docs/probes/`, rerunnable |
| `src/run.ts` is 2817 lines | measured, and listed in Rough edges rather than hidden |
| one JS bundle, 741 KB | Vite says so on every build |
| MIT | `LICENSE` |

---

## 1. Reddit

**Where.** `r/ClaudeAI` first — it is the audience that already knows what
`claude -p` is, and the post needs no explaining there. `r/LocalLLaMA` and
`r/ExperiencedDevs` are plausible seconds with a reworked opening.
`r/programming` has a hard self-promotion rule and a project announcement will
be removed; do not post it there.

**Read the subreddit's rules the day you post.** Several of these now require a
flair, and `r/ClaudeAI` has a dedicated flair for projects. Post the link as a
text post with the GIF attached, not as a bare link to GitHub.

**Title** (pick one):

- `I built a web UI that drives the real claude CLI through one task at a time — plan, you approve, then it tests until green`
- `kantan: a localhost UI for claude -p that stops and asks before it writes any code`

**Body:**

> I kept starting agent frameworks and abandoning them. Paperclip, then Paca —
> both grew an org chart, a scheduler and a database before they could finish a
> single task. The ceremony grew faster than the usefulness.
>
> So I wrote the smallest thing that does the part I actually wanted: **one task
> at a time, with a human gate in the middle.**
>
> ```
>  plan --> [YOU APPROVE] --> implement --> test --> done
>              |                             |
>         feedback                    fail, and keep going
>              +--> plan                     +--> refine --> test
> ```
>
> An agent reads your repo and writes a plan. It stops. You read the plan and
> either approve it or send it back with a note. On approval a **fresh** session
> implements it, then your test command runs, and it keeps going until the exit
> code is zero.
>
> **Three things that are deliberate, not missing:**
>
> - **It spawns the real `claude` binary.** It does not reimplement an agent
>   loop, so your `CLAUDE.md`, skills, plugins, hooks, settings and auth all
>   load exactly as they do in your terminal. Nothing to port, nothing to
>   configure twice.
> - **The server runs your tests, not the agent.** It branches on the exit code
>   and never on the agent reporting success. Verification from outside the agent
>   cannot be talked out of.
> - **Your backlog is markdown in your own repo.** `docs/features/<slug>.md`,
>   with `- [ ] T1 ...` lines. No database. The UI renders and remote-controls;
>   it never owns the truth.
>
> And one thing I want to be straight about, because it changes what a green
> result means: a project can declare **no test command**, since most
> repositories have none and requiring one excluded them. Those runs are
> verified by the agent checking its own work, which is a weaker claim — so
> kantan records which of the two happened, and **no screen prints an exit code,
> a tick or the word "passed" for a run that checked itself.** A log written
> before that field existed reads as "unknown", never as a pass.
>
> It is rough in places and the README lists them by name — a 2817-line state
> machine, a 741 KB unsplit bundle, an account-usage view that can only report
> what past runs happened to see. I would rather you hit those in the README
> than in an afternoon.
>
> The hard-won facts about `claude -p` are in `docs/probes/` and every script
> there is rerunnable, so you can check instead of trusting me. The one that
> cost the most: **a question and a completion are indistinguishable in
> `claude -p`**, because `AskUserQuestion` doesn't exist there. Both exit
> `success` with text. So there's a sentinel line the prompts ask for and the
> parser looks for, and its absence is how an agent asking something gets
> noticed instead of being recorded as done.
>
> MIT, runs on loopback only, talks to no service.
>
> `curl get.kantan.sh | sh` — or read it first, it's short: https://kantan.sh
>
> https://github.com/laithalenooz/kantan

**Attach:** `flow.gif`.

**Expect these questions.** Have the answers ready; a fast, specific reply is
worth more than the post.

- *"How is this different from \<Aider / OpenHands / Claude Code's own UI\>?"* —
  It is not an agent; it is a harness around one. It has no model of its own, no
  loop of its own, and no opinion about your prompt. The differences that matter
  are the gate and the exit-code branch.
- *"Why one task at a time?"* — One branch per task and one run per project means
  two agents can never share a working tree. It is also the thing that makes the
  state small enough to be a markdown file.
- *"Does it send anything anywhere?"* — No. It binds `127.0.0.1` and checks
  `Host`, `Origin` and a per-launch token, because its endpoints feed arbitrary
  text to an agent with tool access. The run logs stay on your disk — and they
  are raw stream-json, so they contain prompts, tool inputs and file contents.
  Read one before you attach it to a bug report.
- *"Windows?"* — Developed on WSL2. Native Windows is untested; say so rather
  than guessing.

---

## 2. dev.to

A technical article, which is where the real value is: the findings, not the
feature list. Tags: `claude`, `ai`, `typescript`, `devtools`.

**Title:** `Four things I learned building a UI on top of `claude -p``

**Subtitle / description field:** `A question and a completion are
indistinguishable in headless Claude Code. That one fact shaped the whole
design.`

**Cover image:** `docs/screenshots/gate.png`.

**Body:**

> I spent a while building a local web UI that drives the real `claude` CLI
> through one coding task at a time — plan, a human approval gate, then
> implement and test until the exit code is zero. It's called
> [kantan](https://github.com/laithalenooz/kantan) (簡単: simple, brief), it's
> MIT, and `curl get.kantan.sh | sh` installs it.
>
> This post isn't about the tool. It's about four things I had to find out the
> hard way, each of which is now a rerunnable script in `docs/probes/`. All of
> them were probed against Claude Code `2.1.296`; the stream-json shape depends
> on the CLI version, which is why every run log records `claude --version`.
>
> ## 1. A question and a completion are indistinguishable
>
> `AskUserQuestion` does not exist in `claude -p`. So when an agent wants to ask
> you something, it has no mechanism to ask — it just writes the question as
> text and exits `success`. Which is byte-for-byte what finishing looks like.
>
> You cannot infer completion from exit status. I ended up with a sentinel: the
> prompts ask for a literal final line, and the parser looks for exactly that
> line. No sentinel means the agent stopped for a reason it couldn't express,
> and the run parks at a human instead of being recorded as done.
>
> The parser is strict on purpose — a backticked copy of the sentinel, a list
> item, an indented line, and a lowercase spelling are all *not* it. Every one of
> those is something a model produces while talking *about* finishing rather
> than finishing, and a loose match turns a discussion into a false pass.
>
> ## 2. `bun --watch` reloads in the same process
>
> I had a lock keyed on the standard `(pid, process start time)` liveness
> fingerprint. It read its own abandoned state as live, every time, after any
> reload.
>
> Probed across three reloads: **the pid and `/proc/<pid>/stat` field 22 are
> identical** after a `bun --watch` reload. The fingerprint everyone uses cannot
> tell a reloaded server from the one that was running before it. The lock now
> carries a per-module-load nonce and checks it *before* the start-time check.
>
> If you hold an exclusive resource under a watcher, check this.
>
> ## 3. A duplicate React key can take down the machine, not just the test
>
> One test file was killing my editor sessions. Not load, not a leak — 16 GB with
> 12 GB free at idle, no OOM line in `dmesg`.
>
> A single `act()` render of a radio list with two options sharing a React `key`
> **never returns**. Measured: React's duplicate-key warning, then 90 seconds of
> silence, with the process growing until a 3 GB cgroup cap killed it. Uncapped,
> that is the whole WSL2 VM.
>
> The key was `option.kind` on a list of accounts — and two accounts can both
> read `work` while billing to different directories, which is the entire point
> of the feature. So the collision wasn't exotic; it was what the feature
> produces.
>
> Two rules came out of it. **Run an unfamiliar suite inside a cap**, because the
> cgroup's kill is itself the diagnosis:
>
> ```bash
> systemd-run --user --scope -q -p MemoryMax=3G -p MemorySwapMax=0 --collect \
>   timeout -s KILL 240 bun test <file>
> ```
>
> And the one that generalises: *the symptom appeared in the tool that ran the
> tests, not in the tests.* A session dying mid-command looks like an environment
> problem, and every instinct says go read `free -h`. Bound the suspect process
> first — the cap turns "my machine died" into "this test allocated without
> bound", which is a fact about the code.
>
> ## 4. Screenshot the thing before you call it done
>
> A headless-Chromium screenshot of one screen caught three defects that **no
> assertion had**: markdown list items rendering one character per line, a
> collapsed file list rendering in full because `display: flex` outranks the
> user-agent's `[hidden]` rule, and a missing icon.
>
> Every one was invisible to a DOM test that queried for the right nodes and
> found them. A passing suite says the nodes exist. It does not say they are
> laid out, visible, or legible.
>
> ```bash
> google-chrome --headless --disable-gpu --no-sandbox --window-size=1440,900 \
>   --screenshot=/tmp/x.png --virtual-time-budget=4000 http://localhost:5173/
> ```
>
> ## The design decision I'd defend hardest
>
> **The server runs the tests, not the agent.** It branches on the exit code and
> never on the agent reporting success. Verification from outside the agent
> cannot be talked out of — and that sentence is the whole reason the project
> exists in the shape it does.
>
> It has exactly one exception, and handling it honestly took more care than
> building it. A project may declare no test command, because most repositories
> have none and requiring one excluded them. Those runs are verified by the
> agent checking its own work, which is a strictly weaker claim. So the run log
> records *which* of the two happened, a reader answers `"unknown"` for a log
> written before that field existed, and **no surface prints an exit code, a
> green tick or the word "passed" for a run that checked itself.**
>
> That last rule is the one worth copying. If a screen cannot tell you which
> kind of verification it saw, it does not get to imply either.
>
> ---
>
> kantan is on [GitHub](https://github.com/laithalenooz/kantan) and at
> [kantan.sh](https://kantan.sh). It is rough in places and the README lists them
> by name. If you try it and something is wrong, the probe scripts are there so
> you can show me rather than describe it.

**Attach:** embed `flow.mp4` (dev.to takes a video embed) or `flow.gif` near the
top, under the first paragraph.

---

## 3. Discord

For the Claude Developers server's showcase channel, or any dev community where
you are already a participant. Short, no pitch, one link.

> Built a local web UI that drives the real `claude` CLI through one coding task
> at a time: an agent reads the repo and writes a plan, **stops**, you approve
> it or send it back with a note, then a fresh session implements it and your
> test command runs until the exit code is zero.
>
> It spawns the actual binary rather than reimplementing an agent loop, so your
> `CLAUDE.md`, skills, plugins, hooks and auth load exactly as they do in your
> terminal.
>
> Two things that are deliberate: **one task, one session, one human** — no org
> chart, no autonomy, no multi-agent anything — and **the server runs your tests,
> not the agent**, branching on the exit code and never on the agent saying it
> worked.
>
> The thing that cost me the most to learn is in there too: a question and a
> completion are indistinguishable in `claude -p`, because `AskUserQuestion`
> doesn't exist headless. Both exit `success` with text. So there's a sentinel
> line, and its absence is how an agent asking something gets noticed.
>
> MIT, loopback only, `curl get.kantan.sh | sh`
> <https://kantan.sh> · <https://github.com/laithalenooz/kantan>

**Attach:** `flow.gif` (Discord renders it inline and it autoplays, which is why
the GIF is the better asset here even though it is bigger).

---

## 4. LinkedIn

Different readership: fewer people who have typed `claude -p`, more who care
about the review boundary. Lead with the problem, not the tool. Short
paragraphs, because LinkedIn truncates at roughly three lines and the "see more"
click is the whole battle.

> Every coding-agent tool I tried grew an org chart before it could finish a
> single task.
>
> Specialist personas. A scheduler. A tracker database. A fleet of agents
> negotiating with each other. The ceremony grew faster than the usefulness, and
> I abandoned two of my own attempts for exactly that reason.
>
> So I built the smallest thing that does the part I actually wanted, and I want
> to describe it by what it refuses to do.
>
> **One task at a time.** An agent reads the repository and writes a plan. Then
> it stops. A human reads that plan and either approves it or sends it back with
> a note. Nothing else moves until that happens.
>
> **The harness runs the tests, not the agent.** It branches on the exit code of
> your own test command, and never on the agent reporting success. Verification
> from outside the agent cannot be talked out of — which is the difference
> between a tool you can hand to a team and a demo.
>
> **The backlog is markdown in your own repository.** Not a database. The
> interface renders and remote-controls; it never owns the truth.
>
> The part I am most pleased with is the least visible. A project can legitimately
> have no test suite — most repositories don't — and in that case the agent
> verifies its own work, which is a weaker claim. So the system records which of
> the two happened, and no screen prints an exit code, a green tick or the word
> "passed" for a run that checked itself. If a surface cannot tell you which kind
> of verification it saw, it does not get to imply either.
>
> That rule is not about AI. It is the same rule as not labelling an untested
> deployment "verified", and it is the one I would carry into any system that
> reports on its own work.
>
> It is open source under MIT, it runs entirely on localhost, and it is rough in
> places — the README lists them by name, which was also a deliberate choice.
>
> kantan.sh
>
> #OpenSource #DeveloperTools #AI #SoftwareEngineering

**Attach:** `flow.mp4` — LinkedIn's native video player gets far more reach than
a link, and it autoplays muted in the feed. Put the repository link in the first
comment if you want the post itself to stay link-free, which LinkedIn's ranking
still rewards.

---

## Before you post

- **Order matters.** Reddit and Discord first, on the same day, because those
  readers will find real bugs and you want them before the wider audience
  arrives. dev.to a day or two later, once you know what people actually asked —
  the article is easier to write when the questions are real. LinkedIn last.
- **Be around for the first three hours.** On Reddit especially, reply speed in
  the first hour is most of whether the thread lives. Nothing in these posts
  needs defending; the questions in the Reddit section are the ones to answer
  fast.
- **Don't repost the same text.** Cross-posting identical copy to several
  subreddits is the fastest way to get all of them removed.
- **The rough edges stay in.** They are the most credible paragraph in every one
  of these posts, and the README's list is the thing that makes the rest
  believable. Cutting them to look more finished would make the whole thing read
  like every other launch.
