/**
 * The gate's own stylesheet, scoped to `.kg`.
 *
 * 607 lines of one template literal, which is why it is its own module: it was
 * 38% of `src/ui/Gate.tsx` and the component is easier to read without
 * scrolling past it.
 *
 * **Scoped rather than global, and that is the decision rather than the
 * consequence.** The gate is the one screen ported with its own class
 * namespace (`kg-*`) instead of `src/ui/artboard.css`'s, because it carries a
 * border beam, a shiny-text eyebrow and a cursor spotlight that exist nowhere
 * else - and because `react-markdown` renders the plan, so the rules have to
 * reach elements this file never writes. A global sheet would have those rules
 * applying to every `<ol>` in the app.
 *
 * Shipped through `<style href="kantan-gate" precedence="medium">`, which React
 * deduplicates: the gate can mount and unmount without the sheet being
 * re-inserted.
 */

/* -------------------------------------------------------------------------- */
/* Styles                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Scoped CSS rather than Tailwind utilities, for three reasons that are all
 * load-bearing:
 *
 *  - The gate needs `@property`, a conic-gradient beam, counter-numbered plan
 *    steps and a cursor-tracked radial spotlight. None are expressible as
 *    utilities.
 *  - The prose styles would otherwise want `@tailwindcss/typography`, which has
 *    to be registered in `src/ui/tokens.css`. That file belongs to someone else.
 *  - Every ground a focus ring can land on has to resolve to a real colour in a
 *    test. Utilities resolve through Tailwind's compiler, which does not run in
 *    `bun test`; these declarations resolve through the token layer, which the
 *    test reads from `tokens.css`.
 *
 * Token names come from `src/ui/tokens.css`. Literal hexes appear only where the
 * artboard uses a value the token layer does not name.
 *
 * ## Why this does not use `src/ui/artboard.css`
 *
 * That file now carries the artboards' own classes — `.beam`, `.shiny`, `.bf`,
 * `.plan` — and `main.tsx` loads it. The gate deliberately keeps its own copy of
 * those four effects, for two reasons that were measured rather than assumed:
 *
 *  - **`.beam` bundles paint and motion into one class.** It declares the
 *    conic-gradient border *and* `animation: kbeam …, kfade …`. The artboard can
 *    do that because it stops motion with `.kr * { animation: none }`, keeping
 *    the class. This component is required to withhold the animated class in JS
 *    instead — three tests assert its absence under the media feature, and
 *    `CLAUDE.md` explains why a class that is never added beats a duration
 *    override. Withholding `.beam` would take the border away with the
 *    animation and leave the card with no edge at all, so the two are split here
 *    into `.kg-beamframe` (the edge) and `.kg-beam` (the motion).
 *  - **`.plan ol li` is a two-column grid that assumes one child.** The artboard
 *    hand-wraps each step in a single `<span>`; `react-markdown` emits the text,
 *    every `<code>` and every `<strong>` as siblings, and each becomes its own
 *    grid item. Measured by the agent that wrote `artboard.css`: a step renders
 *    105px tall in a 273.5px column instead of 27px in a 618px one — the
 *    one-word-per-line defect `CLAUDE.md` already records. `.kg-prose` positions
 *    the marker absolutely instead, which has no opinion about how many children
 *    a list item has. Measured side by side against the artboard at a 1440px
 *    viewport, the first step comes out 698.8 x 52.7 in both, so this is a
 *    different implementation of the same drawing, not a different drawing.
 *
 * The element rules in `artboard.css` (`button { font: inherit }`,
 * `textarea { font: inherit }`, the placeholder colour, `a { color: … }`) agree
 * with what this stylesheet sets, and they sit in `@layer base` while this is
 * unlayered, so the two do not fight.
 */
export const GATE_CSS = `
@property --kg-a { syntax: "<angle>"; initial-value: 0deg; inherits: false; }
@property --kg-s { syntax: "<angle>"; initial-value: 0deg; inherits: false; }

@keyframes kg-beam { to { --kg-a: 360deg; } }
@keyframes kg-shineborder { to { --kg-s: 360deg; } }
@keyframes kg-fade {
  from { opacity: 0; transform: translateY(10px); filter: blur(6px); }
  to { opacity: 1; transform: none; filter: blur(0); }
}
@keyframes kg-pop {
  from { opacity: 0; transform: translateY(8px) scale(.98); }
  to { opacity: 1; transform: none; }
}
@keyframes kg-pulse {
  0% { box-shadow: 0 0 0 0 rgba(255,106,26,.55); }
  70% { box-shadow: 0 0 0 9px rgba(255,106,26,0); }
  100% { box-shadow: 0 0 0 0 rgba(255,106,26,0); }
}
@keyframes kg-shine {
  from { background-position: 150% 0; }
  to { background-position: -50% 0; }
}
@keyframes kg-spin { to { transform: rotate(360deg); } }

/* --- the one ring, and the ground rule ---------------------------------- */

.kg {
  /* Local aliases for the token layer, each carrying the artboard's literal as
     its fallback. Two reasons, both load-bearing: this stylesheet then renders
     correctly even if it is ever mounted without tokens.css, and every colour
     in it resolves under bun test, where Tailwind's compiler does not run —
     which is what lets the focus-ring test measure a real ground instead of
     measuring nothing and passing. test/ui/Gate.test.tsx fails if a colour
     here ever references a token without a fallback. */
  --kg-ink: var(--color-ink, #111216);
  --kg-ink-deep: var(--color-ink-deep, #1e2026);
  --kg-ink-soft: var(--color-ink-soft, #26272d);
  --kg-ink-hover: var(--color-ink-hover, #2a2b31);
  --kg-ground: var(--color-ground, #f4f4f6);
  --kg-panel: var(--color-panel, #fafafb);
  --kg-panel-2: var(--color-panel-2, #f0f0f3);
  --kg-panel-3: var(--color-panel-3, #f1f1f4);
  --kg-hairline: var(--color-hairline, #eeeef1);
  --kg-edge: var(--color-edge, #e7e7eb);
  --kg-edge-strong: var(--color-edge-strong, #dcdce2);
  --kg-muted-900: var(--color-muted-900, #3a3d45);
  --kg-muted-700: var(--color-muted-700, #4a4e59);
  --kg-muted-500: var(--color-muted-500, #5f6370);
  --kg-muted-400: var(--color-muted-400, #6b7080);
  --kg-muted-300: var(--color-muted-300, #a3a7b1);
  --kg-attention: var(--color-attention, #ff6a1a);
  --kg-attention-tint: var(--color-attention-tint, #fff1e8);
  --kg-attention-ink: var(--color-attention-ink, #9a3b06);
  --kg-indigo: var(--color-indigo, #5b5bd6);
  --kg-indigo-deep: var(--color-indigo-deep, #4b4bc8);
  --kg-indigo-deeper: var(--color-indigo-deeper, #3a3aa8);
  --kg-indigo-tint: var(--color-indigo-tint, #dcdcf6);
  --kg-fail: var(--color-fail, #d92d3a);

  /* The card and the composer are white in the artboard; the token layer names
     no white, so this is the one surface colour declared here outright. */
  --kg-paper: #ffffff;

  /* One ring for the whole gate, and no control overrides it. outline-offset
     is positive, so the ring lands on the ground BEHIND the control: an ink ring
     is 19:1 on the card and on the action bar, where a paper-coloured one would
     be invisible. Re-declaring this per control is how the earlier version of
     this project shipped 2.56:1. */
  --kg-ring: var(--kg-ink);
}

/* Mouse focus on a textarea should not draw the UA ring next to ours. The
   :focus-visible rule below re-adds a ring for keyboard focus and must stay
   after this one, since both have the same specificity. */
.kg textarea:focus { outline-style: none; }

.kg button:focus-visible,
.kg textarea:focus-visible,
.kg a:focus-visible,
.kg [tabindex]:focus-visible {
  outline-width: 2px;
  outline-style: solid;
  outline-color: var(--kg-ring);
  outline-offset: 2px;
}

/* --- shared ------------------------------------------------------------- */

.kg { font-family: var(--font-sans, ui-sans-serif, system-ui, sans-serif); color: var(--kg-ink); }
.kg-mono { font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
.kg-inert { overflow-wrap: anywhere; }
/* Tailwind names this "sr-only", and the tree and the sidebar use that. Declared
   here instead for the reason the rest of this stylesheet exists: Tailwind's
   compiler does not run under "bun test", so a utility class is simply absent
   there, and a rule this file depends on has to resolve where this file is
   tested. */
.kg-visually-hidden {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
}
.kg-fade { animation: kg-fade .7s cubic-bezier(.2,.7,.2,1) both; }
.kg-pop { animation: kg-pop .5s cubic-bezier(.2,.7,.2,1) both; }
.kg-pulse { animation: kg-pulse 1.8s ease-out infinite; }
.kg-spin { animation: kg-spin .9s linear infinite; transform-origin: 50% 50%; }

/* --- Border Beam -------------------------------------------------------- */

.kg-beamframe {
  padding: 1.5px;
  border-radius: 24px;
  background-color: #e8e3de;
  box-shadow:
    0 1px 2px rgba(17,18,22,.04),
    0 18px 50px -18px rgba(17,18,22,.18),
    0 40px 90px -50px rgba(255,106,26,.35);
}
.kg-beam {
  background-image: conic-gradient(
    from var(--kg-a),
    transparent 0deg 200deg,
    #ffd2b3 270deg,
    var(--kg-attention) 330deg,
    transparent 360deg
  );
  animation: kg-beam 5s linear infinite;
}
/* Once the decision is made the beam stops asking for one. */
.kg-calm { background-color: #dcefe6; background-image: none; animation: none; }

/* --- Magic Card --------------------------------------------------------- */

.kg-card {
  --kg-mx: -600px;
  --kg-my: -600px;
  border-radius: 22.5px;
  overflow: clip;
  background-color: var(--kg-paper);
  background-image: radial-gradient(
    560px circle at var(--kg-mx) var(--kg-my),
    rgba(255,106,26,.07),
    transparent 45%
  );
}

/* --- gate head ---------------------------------------------------------- */

.kg-head {
  padding: 32px clamp(20px,4vw,44px) 26px;
  border-bottom: 1px solid var(--kg-hairline);
  /* No background-colour. The artboard's head is a warm gradient over a
     transparent base, so the Magic Card spotlight on .kg-card beneath shows
     through it; painting the head white as well occluded the spotlight over
     the whole top third of the card, which is exactly where the cursor is when
     someone starts reading. */
  background-image: linear-gradient(180deg, #fff8f3 0%, rgba(255,255,255,0) 100%);
}
.kg-eyebrow { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.kg-dot { width: 10px; height: 10px; border-radius: 50%; background-color: var(--kg-attention); flex: none; }
.kg-shiny {
  font-size: 13px; font-weight: 620; letter-spacing: .02em;
  color: var(--kg-attention-ink);
}
.kg-shiny-anim {
  background-image: linear-gradient(90deg,
    var(--kg-attention-ink) 0%, var(--kg-attention-ink) 38%,
    #ff9a5e 50%,
    var(--kg-attention-ink) 62%, var(--kg-attention-ink) 100%);
  background-size: 250% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: kg-shine 3.2s linear infinite;
}
.kg-h1 {
  margin: 0;
  font-size: clamp(32px, 4vw, 46px);
  line-height: 1.05;
  font-weight: 650;
  letter-spacing: -.035em;
  text-wrap: balance;
}
.kg-lede {
  margin: 12px 0 0;
  max-width: 60ch;
  font-size: 15.5px;
  line-height: 1.6;
  color: var(--kg-muted-700);
  text-wrap: pretty;
}
.kg-lede code {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 13.5px; background-color: var(--kg-panel-3);
  border-radius: 6px; padding: 1px 5px;
}
.kg-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
.kg-chip {
  padding: 6px 10px; border-radius: 999px;
  background-color: var(--kg-panel-3);
  font-size: 12.5px; font-weight: 500; color: var(--kg-muted-900);
}
.kg-chip-path {
  display: inline-flex; align-items: center; gap: 6px; min-width: 0;
  padding: 6px 10px; border-radius: 999px;
  background-color: var(--kg-paper); border: 1px solid var(--kg-edge);
  font-size: 12px; color: #2a2c33; overflow-wrap: anywhere;
}
.kg-chip-icon { width: 13px; height: 13px; flex: none; color: var(--kg-muted-400); }

/* --- plan prose, per Main.dc.html .plan ---------------------------------- */

/* content-box, against the app's preflight, because the measure is the point.
 *
 * Tailwind's preflight sets box-sizing:border-box on everything, and this
 * rule is one of three here that pair a max-width with padding. Under
 * border-box the padding comes out of the 68ch instead of sitting beside it, so
 * the prose measured 610.8px against the artboard's 698.8px and every line of
 * the plan rewrapped - 88px narrower than the document a human is being asked
 * to approve was drawn to be. DESIGN.md names 68ch for this text specifically.
 * The artboard has no preflight and so is already content-box; this restores
 * the same sizing model rather than re-tuning the number to hide the symptom. */
.kg-prose {
  box-sizing: content-box;
  padding: 30px clamp(20px,4vw,44px) 8px;
  font-size: 15.5px; line-height: 1.7; color: #272930;
  max-width: 68ch;
  overflow-wrap: anywhere;
}
.kg-prose h1, .kg-prose h2, .kg-prose h3, .kg-prose h4 {
  font-size: 19px; line-height: 1.3; font-weight: 650;
  letter-spacing: -.015em; color: var(--kg-ink); margin: 32px 0 10px;
}
.kg-prose > :first-child { margin-top: 0; }
.kg-prose p { margin: 0 0 14px; text-wrap: pretty; }
.kg-prose code {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 13.5px;
  background-color: var(--kg-panel-3); border: 1px solid var(--kg-edge);
  border-radius: 6px; padding: 1px 5px;
}
.kg-prose pre {
  margin: 16px 0 18px; padding: 16px 18px;
  background-color: var(--kg-panel); border: 1px solid var(--kg-edge);
  border-radius: 14px; overflow-x: auto;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 13px; line-height: 1.65; color: #272930;
}
.kg-prose pre code { background: none; border: 0; padding: 0; font-size: inherit; }
/* The marker is positioned, never a grid or flex column. Markdown hands a list
   item a mix of text, <code> and <strong>, and each of those would become its
   own column in a grid: the artboard could use one because its content was a
   single hand-written <span>. The symptom is a word per line. */
.kg-prose ol {
  list-style: none; counter-reset: kgs; margin: 0 0 14px; padding: 0;
  display: flex; flex-direction: column; gap: 10px;
}
.kg-prose ol > li { counter-increment: kgs; position: relative; padding-left: 40px; min-height: 26px; }
.kg-prose ol > li::before {
  content: counter(kgs);
  position: absolute; left: 0; top: 0;
  display: grid; place-items: center;
  width: 26px; height: 26px; border-radius: 999px;
  background-color: var(--kg-ink); color: var(--kg-paper);
  font-size: 12.5px; font-weight: 600;
}
.kg-prose ul { margin: 0 0 14px; padding: 0; list-style: none; }
.kg-prose ul > li { position: relative; padding-left: 18px; margin-bottom: 8px; }
.kg-prose ul > li::before {
  content: ""; position: absolute; left: 2px; top: 11px;
  width: 6px; height: 6px; border-radius: 50%;
  background-color: var(--kg-muted-300);
}
.kg-prose li > ul, .kg-prose li > ol { margin-top: 8px; }
.kg-prose strong { font-weight: 620; color: var(--kg-ink); }
.kg-prose blockquote {
  margin: 16px 0; padding: 2px 0 2px 16px;
  border-left: 2px solid var(--kg-edge-strong); color: var(--kg-muted-700);
}
.kg-prose table {
  display: block; overflow-x: auto; max-width: 100%;
  border-collapse: collapse; margin: 0 0 16px; font-size: 14px;
}
.kg-prose th, .kg-prose td {
  border: 1px solid var(--kg-edge); padding: 7px 10px; text-align: left; vertical-align: top;
}
.kg-prose th { background-color: var(--kg-panel-3); font-weight: 620; }
/* A task list is a list of boxes, not a list of bullets. */
.kg-prose li:has(> input[type="checkbox"]) { padding-left: 0; }
.kg-prose li:has(> input[type="checkbox"])::before { content: none; }
.kg-prose li > input[type="checkbox"] { margin: 0 8px 0 0; accent-color: var(--kg-ink); }
.kg-prose del { color: var(--kg-muted-500); }
.kg-prose a { color: var(--kg-indigo-deep); overflow-wrap: anywhere; }
.kg-prose a:hover { color: var(--kg-indigo-deeper); }
.kg-prose img { max-width: 100%; }

/* --- missing plan ------------------------------------------------------- */

.kg-missing {
  display: flex; gap: 12px; align-items: flex-start;
  margin: 24px clamp(20px,4vw,44px) 8px;
  padding: 16px 18px; border-radius: 14px;
  background-color: var(--kg-attention-tint); border: 1px solid #ffd3b8;
  font-size: 14px; line-height: 1.6; color: #6b2c05;
}
.kg-missing-path { display: block; margin-top: 8px; overflow-wrap: anywhere; font-size: 12.5px; }

/* --- files touched (Collapsible) ---------------------------------------- */

.kg-files { padding: 8px clamp(20px,4vw,44px) 24px; }
.kg-files-toggle {
  display: flex; align-items: center; gap: 8px; width: 100%;
  min-height: 44px; padding: 0 14px;
  border-radius: 12px; border: 1px solid var(--kg-hairline);
  background-color: #fcfcfd; color: var(--kg-muted-900);
  font-size: 13.5px; font-weight: 550; text-align: left; cursor: pointer;
}
.kg-files-toggle:hover { background-color: #f6f6f8; }
.kg-files-chev { width: 14px; height: 14px; flex: none; transition: transform .2s; }
.kg-files-chev-open { transform: rotate(90deg); }
.kg-files-note { margin-left: auto; font-size: 12px; color: var(--kg-muted-400); font-weight: 400; }
.kg-files-list {
  list-style: none; margin: 8px 0 0; padding: 6px 14px;
  border-radius: 12px; background-color: var(--kg-panel); border: 1px solid var(--kg-hairline);
  font-size: 12.5px; color: var(--kg-muted-900);
  display: flex; flex-direction: column; gap: 6px;
}
.kg-files-list li { overflow-wrap: anywhere; }
/* display:flex on a class outranks the user agent's [hidden] rule, so the
   collapsed list rendered in full with its toggle still saying "closed".
   Caught by a screenshot, not by a test that only read the attribute. */
.kg-files-list[hidden] { display: none; }

/* --- the actions bar ---------------------------------------------------- */

.kg-actions {
  position: sticky; bottom: 0;
  padding: 20px clamp(20px,4vw,44px) 24px;
  background-color: rgba(251,251,252,.94);
  border-top: 1px solid var(--kg-hairline);
  display: flex; flex-wrap: wrap; align-items: flex-end; gap: 16px;
}
.kg-reply { flex: 1 1 380px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.kg-label { font-size: 13px; font-weight: 600; color: #2a2c33; }
.kg-reply-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-end; }
/* The artboard's composer, with one arithmetic fix.
 *
 * Measured on Main.dc.html itself at a 1440px viewport: scrollHeight 67
 * against clientHeight 46, so the artboard clips its own placeholder and shows
 * a scrollbar before a character is typed. Two causes, and both are fixed here
 * rather than reproduced:
 *
 *  - 48px box - 26px padding - 2px border leaves 20px for a 20.3px line, so
 *    even a single line overflowed. 12px padding leaves 22px and it fits.
 *  - The placeholder is two lines in this column, so the box is given two rows.
 *    That makes it ~18px taller at rest than the artboard draws it, which is
 *    the one place this component deliberately departs from the drawing: a
 *    control whose own example text is cut in half reads as broken, and the
 *    gate's column is narrower in the app than on the artboard, so the wrap is
 *    the common case rather than the edge.
 */
.kg-textarea {
  flex: 1 1 240px; min-height: 48px; resize: vertical;
  padding: 12px 16px; border-radius: 14px;
  border: 1px solid transparent; background-color: #efeff2;
  font: inherit; font-size: 14px; line-height: 1.45; color: var(--kg-ink);
  box-sizing: border-box;
}
.kg-textarea::placeholder { color: #7a7f8c; }
.kg-send-back {
  height: 48px; padding: 0 18px; border-radius: 999px;
  border: 1px solid #d9d9df; background-color: var(--kg-paper);
  color: var(--kg-ink-deep); font: inherit; font-size: 14px; font-weight: 560;
  display: inline-flex; align-items: center; gap: 8px; cursor: pointer;
}
.kg-send-back:hover:not(:disabled) { background-color: #f6f6f8; }
.kg-send-back:disabled { cursor: not-allowed; color: var(--kg-muted-300); border-color: var(--kg-edge); }
.kg-approve {
  height: 56px; padding: 0 22px 0 20px; border-radius: 999px; border: 0;
  background-color: var(--kg-ink); color: var(--kg-paper);
  font: inherit; font-size: 16px; font-weight: 620;
  display: inline-flex; align-items: center; gap: 10px; cursor: pointer;
  box-shadow: 0 10px 28px -10px rgba(17,18,22,.6), inset 0 1px 0 rgba(255,255,255,.16);
}
.kg-approve:hover:not(:disabled) { background-color: var(--kg-ink-hover); }
.kg-approve:disabled {
  background-color: var(--kg-panel-2); color: var(--kg-muted-400);
  box-shadow: none; cursor: not-allowed;
}
.kg-approve-icon { width: 18px; height: 18px; stroke-width: 2.5; flex: none; }
.kg-kbd {
  margin-left: 4px; padding: 3px 7px; border-radius: 7px;
  background-color: rgba(255,255,255,.14); font-size: 12px; font-weight: 500;
}
.kg-approve:disabled .kg-kbd { background-color: rgba(17,18,22,.06); }
.kg-refused {
  flex: 1 1 100%;
  display: flex; align-items: flex-start; gap: 10px;
  padding: 10px 12px; border-radius: 12px;
  background-color: var(--kg-paper); border: 1px solid var(--kg-fail);
  color: var(--kg-fail); font-size: 13.5px; line-height: 1.5;
}
.kg-refused svg { width: 16px; height: 16px; flex: none; margin-top: 1px; }
.kg-refused strong { font-weight: 620; }
.kg-refused span { min-width: 0; overflow-wrap: anywhere; }
.kg-settled {
  flex: 1; display: flex; flex-wrap: wrap; align-items: center; gap: 12px; min-height: 56px;
}
.kg-settled-icon { width: 20px; height: 20px; flex: none; }
.kg-settled-main { font-size: 16px; font-weight: 600; }
.kg-settled-aside { margin-left: auto; font-size: 13px; color: var(--kg-muted-500); }

/* --- the question shape ------------------------------------------------- */

.kg-ask {
  background-color: var(--kg-paper);
  border: 1px solid var(--kg-edge);
  border-radius: 24px;
  padding: 28px clamp(20px,4vw,40px) 30px;
  box-shadow: 0 1px 2px rgba(17,18,22,.04), 0 18px 50px -22px rgba(17,18,22,.2);
}
.kg-ask-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; }
.kg-avatar {
  width: 34px; height: 34px; border-radius: 11px; flex: none;
  background-image: linear-gradient(145deg, #2a2b31, #0e0f12);
  background-color: var(--kg-ink-soft);
  display: grid; place-items: center;
}
.kg-avatar span { width: 9px; height: 9px; border-radius: 50%; background-color: var(--kg-attention); }
.kg-who { display: flex; flex-direction: column; min-width: 0; }
.kg-who-name { font-size: 14.5px; font-weight: 620; margin: 0; }
.kg-who-when { font-size: 12px; color: var(--kg-muted-400); }
.kg-ask-pill {
  margin-left: auto; display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 11px; border-radius: 999px;
  border: 1px solid #cfd0f7; color: var(--kg-indigo-deeper);
  font-size: 12.5px; font-weight: 600;
}
.kg-ask-pill svg { width: 14px; height: 14px; flex: none; }
/* content-box for the same reason as .kg-prose: 640px is the speech bubble's
   measure in the artboard, with the padding outside it. */
.kg-bubble {
  box-sizing: content-box;
  margin: 16px 0 0; max-width: 640px;
  padding: 22px 26px 20px;
  border-radius: 6px 22px 22px 22px;
  background-color: #f3f3fe; border: 1px solid #e2e3fb;
  font-size: 15px; line-height: 1.65; color: #2f3140;
  overflow-wrap: anywhere;
}
.kg-bubble > :first-child { margin-top: 0; }
/* The question itself, at the artboard's #ask-h size. The agent writes the
   question as markdown, so it arrives as a leading paragraph far more often
   than as a heading; both are drawn as the heading the artboard draws. */
.kg-bubble > p:first-of-type {
  font-size: clamp(22px, 2.6vw, 28px); line-height: 1.2; font-weight: 640;
  letter-spacing: -.025em; color: #17174a; text-wrap: pretty; margin-bottom: 12px;
}
.kg-bubble h1, .kg-bubble h2, .kg-bubble h3 {
  font-size: clamp(22px, 2.6vw, 28px); line-height: 1.2; font-weight: 640;
  letter-spacing: -.025em; color: #17174a; margin: 0 0 12px;
}
.kg-bubble p { margin: 0 0 10px; }
.kg-bubble code {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 13px;
  background-color: var(--kg-paper); border: 1px solid #e2e3fb; border-radius: 6px; padding: 1px 5px;
}
.kg-bubble pre {
  margin: 12px 0; padding: 12px 14px; overflow-x: auto;
  background-color: var(--kg-paper); border: 1px solid #e2e3fb; border-radius: 12px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12.5px; line-height: 1.6;
}
.kg-bubble pre code { background: none; border: 0; padding: 0; }
.kg-bubble ul, .kg-bubble ol { margin: 0 0 12px; padding: 0; list-style: none; }
.kg-bubble ol { counter-reset: kgq; }
.kg-bubble li { position: relative; padding-left: 18px; margin-bottom: 8px; }
.kg-bubble li::before {
  content: ""; position: absolute; left: 0; top: 10px;
  width: 6px; height: 6px; border-radius: 50%;
  background-color: var(--kg-indigo);
}
.kg-bubble ol > li { counter-increment: kgq; padding-left: 22px; }
.kg-bubble ol > li::before {
  content: counter(kgq) ".";
  top: 0; left: 0; width: auto; height: auto; border-radius: 0;
  background: none; color: var(--kg-indigo-deeper); font-weight: 620; font-size: 13.5px;
}
.kg-bubble strong { font-weight: 620; color: #17174a; }
.kg-bubble a { color: var(--kg-indigo-deep); overflow-wrap: anywhere; }
.kg-nothing {
  display: flex; align-items: flex-start; gap: 10px;
  margin: 20px 0 14px; font-size: 13.5px; line-height: 1.5; color: var(--kg-muted-700);
}
.kg-nothing svg { width: 16px; height: 16px; flex: none; margin-top: 1px; color: var(--kg-muted-500); }
.kg-composer { margin-left: auto; max-width: 640px; }
.kg-composer-label { display: block; margin: 0 0 8px 4px; font-size: 13px; font-weight: 600; color: #2a2c33; }
/* Shine Border: decoration while the box has focus. Never the focus ring —
   #c7c8f6 on white is nowhere near 3:1. */
.kg-shineframe {
  padding: 1.5px; border-radius: 18px;
  background-color: var(--kg-indigo-tint);
}
.kg-shineframe-anim {
  background-image: conic-gradient(from var(--kg-s), #c7c8f6, #5b5bd6, #38bdf8, #a5b4fc, #c7c8f6);
  animation: kg-shineborder 6s linear infinite;
}
.kg-composer-inner { border-radius: 16.5px; background-color: var(--kg-paper); padding: 4px; }
.kg-answer {
  display: block; width: 100%; box-sizing: border-box;
  min-height: 96px; resize: vertical;
  padding: 12px 14px; border: 0; border-radius: 13px;
  background-color: #f7f7f9;
  font: inherit; font-size: 15px; line-height: 1.55; color: var(--kg-ink);
}
.kg-answer::placeholder { color: #7a7f8c; }
.kg-composer-foot {
  display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
  padding: 10px 8px 6px 10px;
}
.kg-composer-hint { font-size: 12.5px; color: var(--kg-muted-500); }
.kg-send {
  margin-left: auto; height: 44px; padding: 0 18px 0 16px;
  border-radius: 999px; border: 0;
  background-color: var(--kg-indigo-deep); color: var(--kg-paper);
  font: inherit; font-size: 14.5px; font-weight: 600;
  display: inline-flex; align-items: center; gap: 8px; cursor: pointer;
  box-shadow: 0 8px 20px -10px rgba(75,75,200,.8);
}
.kg-send svg { width: 15px; height: 15px; flex: none; }
.kg-send:hover:not(:disabled) { background-color: #3f3fb8; }
.kg-send:disabled { background-color: var(--kg-indigo-tint); color: #4a4e59; box-shadow: none; cursor: not-allowed; }
/* And the human's own reply bubble, the third max-width-plus-padding rule. */
.kg-mine {
  box-sizing: content-box;
  margin: 18px 0 0 auto; max-width: 560px;
  padding: 16px 20px; border-radius: 22px 6px 22px 22px;
  background-color: var(--kg-ink); color: var(--kg-ground);
  font-size: 15px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere;
}
.kg-resumed {
  display: flex; align-items: center; gap: 10px; margin-top: 16px;
  font-size: 14px; font-weight: 560; color: #20205e;
}
.kg-resumed svg { width: 16px; height: 16px; flex: none; }

/* The artboards guard every keyframe this way, and so does the token layer.
   The classes above are also withheld in JS when the feature is set; this is
   the belt to that braces, and covers a preference that changes mid-session
   before React has re-rendered. */
@media (prefers-reduced-motion: reduce) {
  .kg-beam, .kg-shineframe-anim, .kg-shiny-anim, .kg-fade, .kg-pop, .kg-pulse, .kg-spin {
    animation: none;
  }
  .kg-card { background-image: none; }
  .kg-files-chev { transition: none; }
}
`
