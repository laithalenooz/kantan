# kantan — visual design

**Source of truth:** the design canvas at
`https://claude.ai/artifact/8bUgEYyZnhurjGHMjWjNvE` — five artboards, mirrored into
`docs/design/` so the repo does not depend on a link.

| Artboard | Shows |
|---|---|
| `Main.dc.html` | the gate: reading a plan |
| `Return.dc.html` | coming back, still running |
| `Question.dc.html` | coming back, it asked a question |
| `Empty.dc.html` | first screen, no repositories |
| `States.dc.html` | the nine states as one system |

Read the relevant artboard before building a region. It is more precise than this summary.

## Type

**Geist** (400 / 500 / 600 / 700) and **Geist Mono** (400 / 500 / 600). Mono for every machine
value: paths, commands, costs, refs, exit codes, test output.

Headings run large and tight: `clamp(38px, 5vw, 58px)`, `line-height: 1.02`,
`letter-spacing: -.045em`, `font-weight: 650`. Body 15–17px at `line-height: 1.5–1.6`.
Rendered plan prose sits at `max-width: 68ch`.

## Colour

```
ground      #F4F4F6     panels      #FAFAFB #F0F0F3 #F1F1F4 #EEEEF1
ink         #111216     deep        #1E2026 #26272D
muted       #3A3D45 #4A4E59 #5F6370 #6B7080 #A3A7B1
borders     #E7E7EB #E2E2E7 #DCDCE2
```

Semantic, each with a tint and a readable text shade:

| Role | Core | Tint | On-tint |
|---|---|---|---|
| **needs you** | `#FF6A1A` | `#FFF1E8` | `#9A3B06` |
| running / primary | `#5B5BD6` `#4B4BC8` `#3A3AA8` | `#DCDCF6` | |
| passed | `#0F8A5F` `#0F7A54` | | |
| failed | `#D92D3A` | | |
| stalled / grinding | amber | | |
| account chip | | `#E0F2FE` | `#075985` |

**Orange is the one that pulls the eye, and only for "needs you".**

## Shape and depth

Pills (`999px`) for buttons and chips. Cards `14–18px`. Small controls `6–10px`.
Soft layered shadows, e.g. `0 1px 2px rgba(17,18,22,.04), 0 16px 36px -18px rgba(17,18,22,.28)`.
The primary button is near-black `#111216`, hover `#2A2B31`, with an inset highlight.

## The nine states

One `<StateGlyph state=… />` plus `<StateLabel/>`. **The shape carries the meaning; colour only
backs it up** — the greyscale row on `States.dc.html` is the test, and it must keep working.

**Only `needs you` pulses. Only `running` spins.** Nothing else moves.

## Components, by region

Taken from the designer's own notes on the canvas.

**Gate.** Three columns, each a shadcn `ScrollArea`. A top band using Motion `AnimatePresence`
slides down when a run needs you — and it also sets `document.title` and a favicon dot, so it
reads from another tab. Tree: Magic UI `File Tree`. Account: shadcn `Badge`. The gate card is
Magic UI `Magic Card` inside `Border Beam`, eyebrow in `Animated Shiny Text`, entering with
`Blur Fade`. Plan: `react-markdown` + Tailwind typography. Files touched: shadcn `Collapsible`.
Reply: `Textarea` + outline `Button`. Approve: shadcn `Button`, `rounded-full`, `size lg`, with a
`⌘↵` hint. Run record: Magic UI `Terminal` frame, rows from **TanStack Virtual**
(`useVirtualizer` + `measureElement` for expanded rows), only new rows animating in. Right rail:
custom stepper, `Number Ticker` for cost, **two** `Animated Circular Progress Bar` for the two
accounts, `Button` + `Tooltip` to stop.

**Coming back.** Same band slot, but calm indigo reading "Nothing needs you". A `Blur Fade`
digest; the timeline is Magic UI `Animated List`, staggered. Exit-code chips are shadcn `Badge` +
`ShieldCheck` and **always print the code, never "looks good"**. Expanded edits use
`Code Comparison`. Grinding is a shadcn `Alert` in amber that slides in — **a notice, never a
modal**, dismissed with "Let it run".

**Question ≠ gate.** No `Border Beam`, no Approve, no check icon, no black button. The question is
a speech bubble from the agent; the composer is a `Textarea` with `Shine Border` while focused and
an indigo "Send answer". The copy says plainly there is nothing to approve yet. In the tree it is
still "needs you" — **only the centre changes shape**.

**Empty.** Magic UI `Dot Pattern` with a radial mask. Three small cards (repo → task file → task)
floating with Motion, drawn in the app's own UI so it teaches the real model. Steps use
`Blur Fade` with a stagger. One action: `Button` → `Dialog`.

## Motion

Keyframes in use: `kfade` (blur-fade in), `kfloat`, `kpulse`, `kspin`, `kslide`, `kpop`, `kring`,
`kshine`, `kbeam`, `kband`, `ktick`, `kdash`.

**Every artboard guards `@media (prefers-reduced-motion: reduce)`.** Keep that; it is not optional
and the design already does it correctly.

## What must survive any further change

1. "Needs you" legible from across the room, and from another tab via title and favicon.
2. The run record virtualises — thousands of rows.
3. Paths over 150 characters wrap, never overflow or truncate invisibly.
4. Two accounts, two rate-limit windows. Never one global meter.
5. Cost live and never surprising.
6. **Exit codes printed, never paraphrased.** It is the product's core promise.
7. Nine states distinguishable **in greyscale**.
