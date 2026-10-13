# Launch posts

**The posts are in `docs/marketing/posts/`, one file per platform, each already
in that platform's own syntax.** Open the file, paste it, done. They are not four
copies of one text — the same post pasted into all four editors comes out broken
in three of them, which is the reason they are separate files rather than
sections of this one.

| File | Syntax it is written in | Paste target |
|---|---|---|
| [`posts/reddit.md`](posts/reddit.md) | Reddit markdown | a text post, **Markdown Editor** mode |
| [`posts/devto.md`](posts/devto.md) | dev.to markdown + YAML front matter | the dev.to editor, front matter included |
| [`posts/discord.txt`](posts/discord.txt) | Discord's subset of markdown | one message |
| [`posts/linkedin.txt`](posts/linkedin.txt) | **plain text, no markup at all** | the post composer |

Files with more than one field start each one with a `▞▞▞ … ▞▞▞` marker line
saying where that block goes. Don't paste the marker lines.

## What differs between the editors, and what it breaks

This is the part worth reading before you paste.

- **Reddit.** New Reddit opens the *rich text* editor by default, and pasting
  markdown into it gives you literal asterisks. Switch to **Markdown Editor**
  first — the control is under the formatting bar. The ASCII diagram uses a
  **4-space indent** rather than a ``` fence on purpose: fences do not render on
  old Reddit, and a good share of the audience still reads it there. Four-space
  indentation works in both.
- **dev.to.** The YAML front matter is *part of the paste* — it sets the title,
  tags and cover image, so there is nothing to fill in by hand. It carries
  `published: false`, so it lands as a draft and you choose when it goes live.
  Tags must be at most four, lowercase, no spaces. The `cover_image` points at
  `raw.githubusercontent.com`, which resolves because `docs/screenshots/gate.png`
  is pushed to `master`.
- **Discord.** 2000 characters per message; this one is 1100, so it fits in one.
  **Masked links — `[text](url)` — do not work in an ordinary user message**,
  only in bot embeds, so every URL in that file is bare. `kantan.sh` is bare so
  its preview card renders; the GitHub URL is wrapped in `<…>` to *suppress* its
  card, because two cards under one message looks like a bot.
- **LinkedIn.** No markup of any kind. `**bold**` renders as `**bold**`, and so
  does everything else — which is why that file is plain text and reads as
  continuous prose rather than a bulleted list. Two further things about it:
  - LinkedIn truncates at roughly three lines behind a "see more", so the first
    two lines are the whole click. They are written to work alone.
  - **Don't convert the emphasis to Unicode bold** (𝗹𝗶𝗸𝗲 𝘁𝗵𝗶𝘀). It is a common
    trick and it does look like bold, but those are mathematical alphanumeric
    characters: screen readers announce them one garbled character at a time or
    skip them, and search indexes them as a different word. The copy is written
    not to need it.

## The assets

In `docs/media/`:

- **`flow.mp4`** — 37s, 1280×800, 0.48 MB. Use this wherever video is allowed:
  dev.to embeds it, and LinkedIn's native player reaches far more people than a
  link does and autoplays muted in the feed.
- **`flow.gif`** — 37s, 960 wide, 2.2 MB. For Reddit and Discord. Discord
  autoplays it inline, which is why the GIF is the better asset there despite
  being bigger.

Both show one task through the whole pipeline: the plan at the gate, a human
approving it, an implement phase, a **failing** test run, a refine, a passing
test run, and the finished task on an unmerged branch.

**Read [`docs/media/README.md`](../media/README.md) before you answer a question
about the clip.** It says precisely what is real in it (the server, the routes,
the log, the SSE replay, the fold, every component, and the click) and what is
not (the agent — a `Runner` writes the records a `claude` child would have
written, on a timer, so a take costs nothing). The two things people will ask
about are both the product rather than fixture artefacts: it ends on *"The
branch is not merged"* because kantan returns the checkout to base and leaves
the tick on the task branch for a human, and `Test` shows a dash because a phase
record has no closing entry.

## The figures the copy uses

All current as of v0.1.0. If you edit a number, edit it here too.

| Claim | Where it comes from |
|---|---|
| 75 modules, 2591 tests, 1 skipped | `bun run check`; the skip is the real-CLI version test, gated because CI has no `claude` |
| probed against Claude Code `2.1.296` | `docs/probes/`, rerunnable |
| `src/run.ts` is 2817 lines | measured, and listed in Rough edges rather than hidden |
| one JS bundle, 741 KB | Vite says so on every build |
| MIT | `LICENSE` |

`docs/marketing/SYSTEM.md` holds the full feature and screenshot inventory the
copy was drawn from.

## Where to post

### Discord

**Anthropic's own Claude Discord: <https://discord.com/invite/6PPFFzqPDZ>**
(`discord.com/invite/anthropic` is the vanity alias for the same server). This is
the primary venue, and not by guesswork — Anthropic's own community page
describes it as *"real-time help, project sharing, and active discussions with
thousands of developers"*, so showing a project is something the server is for
rather than something you are getting away with.

**Find the channel by reading, not by assuming.** Server layouts get
reorganised, so look for whatever the sidebar currently calls showcase /
share-your-project / built-with-claude, and read that channel's pinned message
before posting. If there is no obvious one, ask in a general channel where
projects go — that question is cheap and being moved by a mod is not.

**Bun's Discord is a real second: <https://bun.com/discord>.** kantan is a Bun
project and the post has something specific for that audience — the
`bun --watch` finding in `docs/probes/`, which is a genuine contribution to
them rather than a plug. If you post there, lead with the finding and mention
the tool second. The current `discord.txt` leads with the tool, so rewrite the
opening for that server.

Same rule as Reddit: **don't paste identical copy into several servers.**

### Reddit

- **`r/ClaudeAI` first.** Anthropic's community page points at it for *"long-form
  discussions, project showcases, and community knowledge that sticks around"*,
  and it is the audience that already knows what `claude -p` is, so the post
  needs no explaining there.
- `r/LocalLLaMA` and `r/ExperiencedDevs` are plausible seconds **with a reworked
  opening**.
- **`r/programming` has a hard self-promotion rule and will remove it** — don't.
- **Read the subreddit's rules the day you post.** Several now require a flair,
  and `r/ClaudeAI` has one for projects.
- **Don't cross-post identical copy.** It is the fastest way to get all of them
  removed.

### Anthropic's "share your build" form, with a caveat

<https://form.typeform.com/to/VIUAjxNi> — a community spotlight that can get a
project featured on Claude's own channels. Not a contest: no prize, no judging,
no deadline, and no guarantee anyone reads it.

**Read what you are agreeing to before you submit it**
([the terms](https://support.claude.com/en/articles/15485501-submit-your-build-how-it-works-and-what-you-re-agreeing-to)).
You keep ownership, but the licence you grant is non-exclusive, royalty-free,
worldwide, **perpetual and irrevocable**, it covers the content behind your links
as well as what you upload, it includes your name, handle and likeness, it is
sublicensable to partners and platforms, and **it cannot be withdrawn once
given**. They may also feature it with no advance notice. For an MIT repository
and a landing page that are already public, none of that costs you anything you
had — which is exactly why it is worth doing *here* and worth reading carefully
anywhere else.

One thing it asks for that applies to kantan: the form has an "anything we should
know?" field for third-party content. Say that `flow.gif` and `flow.mp4` contain
a re-enacted agent, and link `docs/media/README.md`. The whole argument of the
project is that it does not claim verification it did not observe; a spotlight
submission is a poor place to make an exception.

## Order, and being around

Reddit and Discord first, on the same day — those readers will find real bugs and
you want them before the wider audience arrives. dev.to a day or two later, once
you know what people actually asked; the article is easier to finish when the
questions are real. LinkedIn last.

**Be around for the first three hours.** On Reddit especially, reply speed in the
first hour is most of whether the thread lives.

## The questions you will get, and the answers

Nothing in these posts needs defending. These are the ones to answer fast.

- *"How is this different from Aider / OpenHands / Claude Code's own UI?"* — It
  is not an agent; it is a harness around one. It has no model of its own, no
  loop of its own, and no opinion about your prompt. The differences that matter
  are the gate and the exit-code branch.
- *"Why one task at a time?"* — One branch per task and one run per project means
  two agents can never share a working tree. It is also what keeps the state
  small enough to be a markdown file.
- *"Does it send anything anywhere?"* — No. It binds `127.0.0.1` and checks
  `Host`, `Origin` and a per-launch token, because its endpoints feed arbitrary
  text to an agent with tool access. The run logs stay on your disk — and they
  are raw stream-json, so they contain prompts, tool inputs and file contents.
  Read one before you attach it to a bug report.
- *"Windows?"* — Developed on WSL2. Native Windows is untested; say that rather
  than guessing.
- *"Is that a real recording?"* — Yes, of the real UI, and the agent in it is
  re-enacted rather than spawned. `docs/media/README.md` is the honest answer at
  length; link it rather than paraphrasing it.

## One thing not to cut

**The rough edges stay in.** They are the most credible paragraph in every one of
these posts, and the README's named list is what makes the rest believable.
Trimming them to look more finished would make the whole thing read like every
other launch.
