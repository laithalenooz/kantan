---
title: "Four things I learned building a UI on top of claude -p"
published: false
description: A question and a completion are indistinguishable in headless Claude Code. That one fact shaped the whole design.
tags: claude, ai, typescript, devtools
cover_image: https://raw.githubusercontent.com/laithalenooz/kantan/master/docs/screenshots/gate.png
---

I spent a while building a local web UI that drives the real `claude` CLI through one coding task at a time — plan, a human approval gate, then implement and test until the exit code is zero. It's called [kantan](https://github.com/laithalenooz/kantan) (簡単: simple, brief), it's MIT, and `curl get.kantan.sh | sh` installs it.

This post isn't about the tool. It's about four things I had to find out the hard way, each of which is now a rerunnable script in `docs/probes/`. All of them were probed against Claude Code `2.1.296`; the stream-json shape depends on the CLI version, which is why every run log records `claude --version`.

## 1. A question and a completion are indistinguishable

`AskUserQuestion` does not exist in `claude -p`. So when an agent wants to ask you something, it has no mechanism to ask — it just writes the question as text and exits `success`. Which is byte-for-byte what finishing looks like.

You cannot infer completion from exit status. I ended up with a sentinel: the prompts ask for a literal final line, and the parser looks for exactly that line. No sentinel means the agent stopped for a reason it couldn't express, and the run parks at a human instead of being recorded as done.

The parser is strict on purpose — a backticked copy of the sentinel, a list item, an indented line, and a lowercase spelling are all *not* it. Every one of those is something a model produces while talking *about* finishing rather than finishing, and a loose match turns a discussion into a false pass.

## 2. `bun --watch` reloads in the same process

I had a lock keyed on the standard `(pid, process start time)` liveness fingerprint. It read its own abandoned state as live, every time, after any reload.

Probed across three reloads: **the pid and `/proc/<pid>/stat` field 22 are identical** after a `bun --watch` reload. The fingerprint everyone uses cannot tell a reloaded server from the one that was running before it. The lock now carries a per-module-load nonce and checks it *before* the start-time check.

If you hold an exclusive resource under a watcher, check this.

## 3. A duplicate React key can take down the machine, not just the test

One test file was killing my editor sessions. Not load, not a leak — 16 GB with 12 GB free at idle, no OOM line in `dmesg`.

A single `act()` render of a radio list with two options sharing a React `key` **never returns**. Measured: React's duplicate-key warning, then 90 seconds of silence, with the process growing until a 3 GB cgroup cap killed it. Uncapped, that is the whole WSL2 VM.

The key was `option.kind` on a list of accounts — and two accounts can both read `work` while billing to different directories, which is the entire point of the feature. So the collision wasn't exotic; it was what the feature produces.

Two rules came out of it. **Run an unfamiliar suite inside a cap**, because the cgroup's kill is itself the diagnosis:

```bash
systemd-run --user --scope -q -p MemoryMax=3G -p MemorySwapMax=0 --collect \
  timeout -s KILL 240 bun test <file>
```

And the one that generalises: *the symptom appeared in the tool that ran the tests, not in the tests.* A session dying mid-command looks like an environment problem, and every instinct says go read `free -h`. Bound the suspect process first — the cap turns "my machine died" into "this test allocated without bound", which is a fact about the code.

## 4. Screenshot the thing before you call it done

A headless-Chromium screenshot of one screen caught three defects that **no assertion had**: markdown list items rendering one character per line, a collapsed file list rendering in full because `display: flex` outranks the user-agent's `[hidden]` rule, and a missing icon.

Every one was invisible to a DOM test that queried for the right nodes and found them. A passing suite says the nodes exist. It does not say they are laid out, visible, or legible.

```bash
google-chrome --headless --disable-gpu --no-sandbox --window-size=1440,900 \
  --screenshot=/tmp/x.png --virtual-time-budget=4000 http://localhost:5173/
```

## The design decision I'd defend hardest

**The server runs the tests, not the agent.** It branches on the exit code and never on the agent reporting success. Verification from outside the agent cannot be talked out of — and that sentence is the whole reason the project exists in the shape it does.

It has exactly one exception, and handling it honestly took more care than building it. A project may declare no test command, because most repositories have none and requiring one excluded them. Those runs are verified by the agent checking its own work, which is a strictly weaker claim. So the run log records *which* of the two happened, a reader answers `"unknown"` for a log written before that field existed, and **no surface prints an exit code, a green tick or the word "passed" for a run that checked itself.**

That last rule is the one worth copying. If a screen cannot tell you which kind of verification it saw, it does not get to imply either.

---

kantan is on [GitHub](https://github.com/laithalenooz/kantan) and at [kantan.sh](https://kantan.sh). It is rough in places and the README lists them by name. If you try it and something is wrong, the probe scripts are there so you can show me rather than describe it.
