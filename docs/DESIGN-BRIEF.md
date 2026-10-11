# kantan — design brief

**Paste this whole file.** Attach `.impeccable/mocks/shell-mockup.html` only as *what I do not
want* — see §7.

---

## 1. The aesthetic I want

Modern, polished, friendly AI-product design. The Linear / Vercel / Raycast register.

Concretely:

- **Light and airy**, generous whitespace, soft neutral greys
- **Big confident geometric sans** for headings — real typographic presence
- **Soft-filled rounded inputs**, **pill buttons** with a small icon
- **Subtle gradients, soft shadows, rounded cards** — depth and polish, used with restraint
- **Motion everywhere it helps**: things slide, fade, stagger and settle rather than appearing
- **A little personality.** Warmth is welcome. This is a tool someone chooses to open.
- Lucide-style line icons

**Do not** make it a dense terminal, a dark console, a printed document, or anything austere.
I have already seen that version and it is not what I want.

### The stack is already installed — please use it

- **React + TypeScript + Vite**
- **Tailwind v4**
- **Motion** (`motion/react`, formerly Framer Motion) — page and element transitions
- **shadcn/ui** — buttons, inputs, dialogs, tooltips, scroll areas
- **Magic UI** — animated components. I specifically want these used where they fit:
  `Terminal`, `Animated List`, `Border Beam`, `Shine Border`, `Magic Card`, `Number Ticker`,
  `Blur Fade`, `Animated Circular Progress Bar`, `File Tree`, `Code Comparison`, `Dot Pattern`,
  `Animated Shiny Text`
- **TanStack Virtual** — the log can run to thousands of rows, so it must virtualise even while
  looking lively

Reach for these rather than hand-rolling. If a Magic UI component fits a surface, use it.

---

## 2. What the product is

**kantan** is a local web app that drives Anthropic's `claude` CLI through **one coding task at a
time**: it writes an implementation plan, **stops and waits for a human to approve it**, then
implements the task and runs the project's tests until they pass.

It runs on `localhost`. One developer, their own machine, their own repositories.

**The defining idea:** other tools in this space run many AI agents at once across isolated copies
of a repo and show you a board of them. kantan runs **one** task, with **one** human decision at
the point where a decision is cheapest. The design should make that feel calm and deliberate —
focused rather than busy.

### The flow

1. Register a repository and point at a markdown file of tasks
2. Pick a task, press start
3. The agent writes a plan to a file — **the run stops here and waits**
4. The human **approves** it, or **sends it back with a note**
5. On approval a fresh agent implements it, writing code and running tests
6. The *server* runs the tests and reads the exit code — it never trusts the agent's word
7. On failure it retries; after three identical failures it raises the agent's effort level and
   keeps going; if that stalls too, it stops and asks
8. On success the task is marked done

---

## 3. Who uses it, and the two moments

One developer, working across several real repositories, fluent with command-line tools.

**Moment A — reading the plan.** 300–500 words of technical prose on screen, read carefully for
two minutes to decide if it is right. Wants comfortable reading: a sensible measure, clear
rhythm, quiet surroundings.

**Moment B — coming back.** They approved, switched away, and return **10 to 40 minutes later**.
Two questions only: *what happened* and *does anything need me*. Possibly glanced at from across
the room.

The approval gate is the switch between these two moments. Both must work.

---

## 4. Every region, and everything in it

One screen. Three columns. No routing, no settings page, no modals except confirmations.

### 4.1 Left — the task tree (~18rem)

**Projects → feature files → tasks.** A `File Tree` is a natural fit.

Per project: repository name · **which Claude account it runs under** (people have a personal and a
work account, with separate billing and separate rate limits — showing the wrong one is a real
error, not a cosmetic one) · its test command (`npm test`, `vendor/bin/pest`, `flutter test`)

Per feature file: its path, e.g. `docs/features/importer.md`

Per task: a short ref (`T1`, `T2`) · its text (arbitrary human prose, can be long, can be
non-English) · exactly one state from §5

**Empty state matters** — zero projects is the first screen anyone sees. It should teach the model
(repo → task file → tasks) and offer one clear action. This is the surface where personality and a
nice illustration earn their place.

### 4.2 Centre — the run

**At the top when a run needs the human: the approval gate. This is the product.**

- The question being asked
- The plan file's path
- The rendered plan: markdown — headings, prose, code blocks, numbered steps
- A collapsed list of other files the planning step touched
- **Approve** — the primary action in the whole app
- **A text box to send it back with a note** — this resumes the planning conversation, so its copy
  should read like replying to a draft, not restating a task

This is where the design should be most ambitious. `Magic Card`, `Border Beam` or `Shine Border`
all fit a moment of consequence. It should feel like arriving at a decision.

**A second, different thing also lands here.** Sometimes the agent *asks a question* instead of
finishing. There is no plan to approve — just a question and a reply box. **It must not look like
the approve gate**, because approving something that asked you a question is a mistake the UI can
prevent.

**Below: the run record.** Append-only, newest at the bottom, of what the agent actually did.
`Terminal` and `Animated List` both fit, but it must stay virtualised — a long run emits
**thousands** of entries.

| Entry | Contains |
|---|---|
| shell command | the command, e.g. `npm test` |
| file read | an absolute path, often **over 150 characters** |
| file edit | path plus lines added/removed, expandable to a diff (`Code Comparison`) |
| agent prose | a sentence or two of natural language |
| test result | pass/fail counts and the **exit code** |
| rate-limit info | the account's usage window |
| an unrecognised event | a future CLI may emit types this version does not know — **must stay visible, never hidden** |
| a parse error | normal, not alarming |

Rows clamp to one line and expand on click.

### 4.3 Right — run metadata (~14rem)

- **Phases and durations:** plan · gate · implement · test · refine, with the current one obvious
- **Cost:** money spent this run against a ceiling the user set (commonly $50), updating live —
  `Number Ticker` is exactly right
- **Rate-limit window:** a 5-hour usage window as a percentage, **per account** — two accounts
  means two separate windows. `Animated Circular Progress Bar` fits
- **A "grinding" notice** after ~5 failed attempts, with cost so far. A *notification, not a
  block* — the run continues and the human decides whether to look
- **Stop** — ends the run; it stays resumable, so stopping costs nothing

---

## 5. Every state, and what it means

The whole vocabulary. Nothing else exists.

| State | Means |
|---|---|
| **open** | not started — most tasks |
| **running** | an agent is working right now |
| **needs you** | waiting at the gate, or asking a question — the one thing that should pull the eye |
| **passed** | tests passed by exit code |
| **failed** | tests failed, or the agent could not continue |
| **stalled** | failed identically three times at top effort — *stuck*, not broken |
| **done, unmerged** | finished, branch not merged. **Common and permanent for anyone who squash-merges — not an error.** Cannot be started again |
| **interrupted** | the server died mid-run. Normal in development, resumable |
| **grinding** | still going, many attempts — a flag on a running task, not a state |

Nine states is a lot to distinguish. Giving each a clear, non-confusable treatment is one of the
real design problems here.

---

## 6. Things that are true regardless of style

Not aesthetic preferences — facts about the product that any design must survive.

1. **"Needs you" must be unmissable from across the room.** Moment B is real. Whatever carries it —
   colour, motion, scale — it has to work at a glance and at distance.
2. **The log virtualises.** Thousands of rows. Animate entry if you like, but do not mount them all.
3. **Paths are very long.** 150+ characters, arbitrary. They must wrap, never overflow or truncate
   invisibly.
4. **Two accounts, two rate-limit windows.** Never one global meter.
5. **Cost is live and must never surprise.** Visible at all times during a run.
6. **Exit codes are the truth.** When the UI says tests passed, that is from an exit code, not from
   the agent saying so. Worth making legible — it is the product's core promise.
7. **Nine states need nine readings.** Especially: *done-unmerged* is not an error, *stalled* is
   not *failed*, *interrupted* is not *failed*.

---

## 7. The attached file is the ANTI-reference

`.impeccable/mocks/shell-mockup.html` shows the current build: light paper, no cards, no shadows,
no rounded corners, two type sizes, almost no motion.

**That is the thing I am replacing.** Attached only so you can see the structure, the density, and
the real content — the three-column layout and what goes in each region are right. The *styling*
is what I want you to throw away.

---

## 8. What I want back

1. **A polished, modern, animated design** in the register of §1, using the components in §1.
2. **Two views:** mid-plan (reading the gate) and returning-after-an-absence (state at a glance).
3. **The empty state**, since it is the first thing anyone sees.
4. **A real treatment of the nine states** that does not rely on colour alone.
5. **Named components** — tell me which shadcn/Magic UI parts you used where, so it can be built.

Deliver as React + Tailwind code I can drop in, or as a high-fidelity mockup with the component
choices listed. Code is better.
