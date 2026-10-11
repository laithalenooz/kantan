# kantan — design brief

Paste this whole file. Attach `shell-mockup.html` (see the end) so you can see the current state.

---

## 1. What the product is

**kantan** (簡単, Japanese for *simple*) is a local web UI that drives Anthropic's `claude` CLI
through **one coding task at a time**: it writes a plan, **stops and waits for a human to approve
it**, then implements the task and runs the project's tests until they pass.

It runs on `localhost` only. One person uses it, on their own machine, against their own code
repositories.

**The one thing to understand:** every competing tool in this space runs *many* AI agents in
parallel across isolated copies of a repository, and shows you a board of them. kantan refuses
that on purpose. One task, one agent, one human, one decision. The interface should feel like
that refusal is a considered position, not a missing feature.

### The job it does

1. The user registers a repository and points at a markdown file of tasks.
2. They pick one task and press start.
3. The agent writes an implementation plan to a file. **The run stops here.**
4. The user reads the plan and either **approves** it or **sends it back with a note**.
5. On approval, a fresh agent implements the plan, writing code and running the project's tests.
6. The server (not the agent) runs the tests and reads the exit code. It never trusts the agent's
   claim that tests pass.
7. If tests fail, it tries again. If it fails the *same way* three times, it raises the agent's
   effort level and continues. If that also stalls, it stops and asks the human.
8. On success the task is marked done.

---

## 2. Who uses it, and the two scenes

One person: a professional developer who works across several real repositories at once, fluent in
command-line tools. Secondary audience: any competent developer who has never seen kantan, since
it is open source.

**The interface serves two different moments, and the approval gate is the switch between them.**

**Scene A — close reading.** The plan is on screen. They are reading 300 to 500 words of technical
prose carefully, deciding whether it is right. This is attentive, focused, two minutes long. It
wants comfortable reading: a measure of roughly 66 characters, clear paragraph rhythm.

**Scene B — returning after an absence.** They approved, switched to another window, and come back
**10 to 40 minutes later**. The only questions are *"what happened?"* and *"does anything need
me?"* They may be glancing from several feet away. This wants state legible at a glance, without
reading.

A design that serves only one of these fails. The current solution is that **colour appears only
when something needs the human** — so a screen with no colour means nothing is waiting, readable
across a room.

---

## 3. Every region, and everything in it

The app is **one screen**, three columns, no navigation, no routing, no modals, no settings page.

### 3.1 Left column — the task tree (~18rem)

A list of **projects → feature files → tasks**.

**Per project:**
- Repository name
- **Which Claude account it runs under** (a person may have a personal and a work account, with
  separate billing and separate rate limits). Showing the wrong one and not noticing means billing
  a client's account for personal work — treat as a correctness requirement, not decoration.
- Its test command, e.g. `npm test`, `vendor/bin/pest`, `flutter test`

**Per feature file:** its path, e.g. `docs/features/importer.md`

**Per task:**
- A short reference: `T1`, `T2`, `T3`
- Its text, e.g. "Map records to rows" — arbitrary human prose, can be long, can be non-English
- Exactly one state (see §4)

**Every task row must carry identical fields in identical positions**, so the eye scans by position
rather than by reading.

**Empty state matters.** Zero registered projects is the first screen anyone ever sees. It must
teach the model — repository, then a markdown file of tasks, then tasks — and offer one action.

### 3.2 Centre column — the run

**At the top, when a run needs the human: the approval gate.** This is the product. It contains:
- The question being asked
- The plan file's path
- The rendered plan: markdown, headings, prose, code snippets, numbered steps
- A collapsed list of any other files the planning step touched
- **Approve** (primary action)
- **A free-text box to send it back with a note.** This resumes the planning conversation, so its
  copy should read as replying to a draft, not restating a task.

**A second, different thing also lands here.** Sometimes the agent asks a *question* instead of
finishing — it cannot be answered automatically, so it surfaces here. There is no plan to approve,
just a question and a reply box. **It should not look like the approve gate**, because approving
something that asked you a question is a mistake the UI can prevent.

**Below that: the run record.** An append-only log of what the agent actually did, newest at the
bottom. Each entry is one of:

| Entry | Contains |
|---|---|
| a shell command | the command, e.g. `npm test`, `git log --oneline` |
| a file read | an absolute path, often **over 150 characters** |
| a file edit | the path plus lines added/removed, expandable to a diff |
| agent prose | a sentence or two of natural language |
| a test result | pass/fail counts and the **exit code** |
| rate-limit info | the account's usage window |
| an unrecognised event | a future CLI may emit event types this version does not know. **These must remain visible, never hidden** — silently dropping them is how a tool lies about what happened |
| a parse error | normal, not alarming: a process killed mid-write produces one |

A long run emits **thousands** of these. The list is virtualised. Entries clamp to one line and
expand on click.

### 3.3 Right column — run metadata (~14rem)

- **Phases and their durations:** plan · gate · implement · test · refine. The current one is
  visibly current.
- **Cost:** money spent on this run so far, against a ceiling the user set (commonly $50). Updates
  live during a run.
- **Rate-limit window:** a 5-hour usage window as a percentage, **per account** — two projects on
  two accounts have two separate windows.
- **A "grinding" notice:** after roughly five failed attempts, the run is flagged with its cost so
  far. It is a *notification, not a block* — the run keeps going, the user decides whether to look.
- **Stop:** ends the run. It stays resumable, so stopping costs nothing.

---

## 4. Every state, and exactly what it means

These are the whole vocabulary. Nothing else exists.

| State | Means | Notes |
|---|---|---|
| **open** | not started | the resting state of most tasks |
| **running** | an agent is working right now | **deliberately has no colour** — see §5 |
| **needs you** | waiting at the approval gate, or asking a question | the only thing that should pull the eye |
| **passed** | tests passed by exit code | |
| **failed** | tests failed, or the agent could not continue | |
| **stalled** | failed the same way three times at the top effort level | distinct from failed: it is *stuck*, not broken |
| **done, unmerged** | finished, but its branch is not merged into the main branch | **common and permanent for anyone who squash-merges.** Not an error. Must not be startable again |
| **interrupted** | the server died mid-run | normal during development. Resumable |
| **grinding** | still going, but has taken many attempts | a flag on a running task, not a state of its own |

---

## 5. The constraints that are decisions, not defaults

These were chosen deliberately and tested. **Treat them as the brief, not as the starting point.**
Everything else is yours to improve.

**The ground is light, not dark.** Every tool in this category is a dark console. The scene forced
this: half the job is reading 400 words of prose closely, which paper serves better. It is also a
deliberate refusal of the category default.

**Colour is purely semantic, never decorative, and follows the ISO safety convention:**

| | | |
|---|---|---|
| blue `#0057B8` | mandatory action | **needs you** |
| green `#046A38` | safe condition | passed |
| red `#C8102E` | danger | failed |
| yellow `#FFC72C` | warning | stalled, grinding |
| *(none)* | | **running** |

**"Running has no colour" is load-bearing.** It means the *presence* of colour is itself the
information: a screen with nothing coloured on it means nothing needs you. This only works if the
rule is absolute, so a decorative use of any of those four hues is a defect.

**Colour commits at region scale.** A whole area takes the colour as a solid field with reversed
type — not a dot, a badge, or a tinted border. This is what makes it readable from across a room.

**Yellow carries dark type, not white.** ISO pairs yellow with black, and no yellow that still
reads as a warning can carry light type.

**No cards, no shadows, no rounded corners.** Regions are separated by hairline rules. This is the
single most likely thing for a designer to "fix" — please don't. The reference world is a printed
technical standard or transit signage, not a dashboard.

**Two type sizes only, plus one exception.** Rank comes from weight, case, reversal and rule — not
from size. The exception is one deliberately large moment, currently the gate.

**Monospace for every machine value** — paths, costs, durations, refs, test output. Sans for prose
and labels. The mix is doing real hierarchical work.

**Density is high.** This is a working document, not a marketing page.

---

## 6. What I actually want from you

The current state (see the attached file) is a competent execution of the above. I want it to be
**professional and visually considered** without abandoning the position.

Specifically:

1. **Make it feel designed rather than merely plain.** The austerity is intentional; looking
   unfinished is not. Typography, rhythm, spacing and proportion are where the quality has to come
   from, because the usual devices (shadows, gradients, rounded cards, colour accents) are all
   ruled out.
2. **The gate is the product.** It should feel like a moment of consequence, not a notification bar.
3. **Fix what is weak.** Honestly: the right column runs out of content and goes dead below the
   fold; the large headline may be too shouty when seen twenty times a day; the three columns do
   not yet feel proportioned to each other.
4. **Show the two scenes working.** One view mid-plan (close reading), one view returning after an
   absence (state at a glance).
5. **Tell me where I am wrong.** If a constraint above is genuinely hurting the result, say so and
   show the alternative. I would rather hear the argument than get silent compliance.

**Do not add:** a dashboard, charts, a sidebar of navigation, avatars, a settings screen, a dark
mode toggle, onboarding carousels, or anything implying multiple agents working at once.

---

## 7. The file

`.impeccable/mocks/shell-mockup.html` — self-contained, opens in any browser, shows the whole
three-column screen with realistic content and the real typefaces (Public Sans and Commit Mono,
both open licence).

It is a **comp, not shipped code**: a static HTML file with inline CSS, no framework. Edit it
freely, or replace it entirely.

The real application is React with Tailwind. Its design tokens live in `src/ui/tokens.css`, where
the constraints above are *encoded rather than documented* — the stock Tailwind colour, radius,
shadow and type scales are deliberately removed and emit no CSS at all. If you propose a change
that needs a new token, say so explicitly; that is how this project keeps a constraint from quietly
eroding.
