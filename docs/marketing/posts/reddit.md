▞▞▞ TITLE — paste into Reddit's title field ▞▞▞

I built a web UI that drives the real claude CLI through one task at a time — plan, you approve, then it tests until green

▞▞▞ BODY — click "Markdown Editor" first, then paste everything below ▞▞▞

I kept starting agent frameworks and abandoning them. Both of mine grew an org chart, a scheduler and a database before they could finish a single task. The ceremony grew faster than the usefulness.

So I wrote the smallest thing that does the part I actually wanted: **one task at a time, with a human gate in the middle.**

    plan --> [YOU APPROVE] --> implement --> test --> done
                |                             |
           feedback                    fail, and keep going
                +--> plan                     +--> refine --> test

An agent reads your repo and writes a plan. It stops. You read the plan and either approve it or send it back with a note. On approval a **fresh** session implements it, then your test command runs, and it keeps going until the exit code is zero.

**Three things that are deliberate, not missing:**

* **It spawns the real `claude` binary.** It does not reimplement an agent loop, so your `CLAUDE.md`, skills, plugins, hooks, settings and auth all load exactly as they do in your terminal. Nothing to port, nothing to configure twice.
* **The server runs your tests, not the agent.** It branches on the exit code and never on the agent reporting success. Verification from outside the agent cannot be talked out of.
* **Your backlog is markdown in your own repo.** `docs/features/<slug>.md`, with `- [ ] T1 ...` lines. No database. The UI renders and remote-controls; it never owns the truth.

And one thing I want to be straight about, because it changes what a green result means: a project can declare **no test command**, since most repositories have none and requiring one excluded them. Those runs are verified by the agent checking its own work, which is a weaker claim — so it records which of the two happened, and **no screen prints an exit code, a tick or the word "passed" for a run that checked itself.** A log written before that field existed reads as "unknown", never as a pass.

It is rough in places and the README lists them by name — a 2817-line state machine, a 741 KB unsplit bundle, an account-usage view that can only report what past runs happened to see. I would rather you hit those in the README than in an afternoon.

The hard-won facts about `claude -p` are in `docs/probes/` and every script there is rerunnable, so you can check instead of trusting me. The one that cost the most: **a question and a completion are indistinguishable in `claude -p`**, because `AskUserQuestion` doesn't exist there. Both exit `success` with text. So there's a sentinel line the prompts ask for and the parser looks for, and its absence is how an agent asking something gets noticed instead of being recorded as done.

MIT, runs on loopback only, talks to no service.

`curl -fsSL https://get.kantan.sh | sh` — or read it first, it's short: https://kantan.sh

Source: https://github.com/laithalenooz/kantan
