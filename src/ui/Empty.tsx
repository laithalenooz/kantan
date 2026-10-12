/**
 * The empty screen: what the centre column says when there is no run to show.
 *
 * Translated from `docs/design/Empty.dc.html` — "kantan — first run" — whose
 * geometry is read off that file rather than summarised from `DESIGN.md`. The
 * three floating specimen cards are drawn **in the app's own UI**, which
 * `DESIGN.md` is explicit about: "so it teaches the real model". A screenshot
 * of a product would teach a screenshot.
 *
 * ## Two emptinesses, and the artboard draws one
 *
 * `no-projects` is the artboard: nothing is registered, and the only way
 * forward is to point kantan at a repository.
 *
 * `no-selection` is the commoner one and the one a user actually reported —
 * repositories exist, the tree is full, nothing is picked, and the screen
 * "looks mostly empty". The teaching content is the same in both, because the
 * model someone needs is the same: repository, then a task file, then a task.
 * What differs is the **action**, and only in one direction that matters:
 * telling someone who already has repositories to add another sends them to
 * the wrong control, with the tree they wanted sitting unread beside it.
 *
 * So the two states share everything except the heading and the action slot.
 * One string on this screen is not in the artboard — the line naming where the
 * task is — and the `no-selection` heading is step three's own words.
 *
 * ## Why this renders `<main>`
 *
 * `App.tsx` swaps this in **in place of** its own `<main>`, not inside it. Two
 * reasons, both structural:
 *
 *  - `artboard.css` scopes Empty's dot geometry to `.kr-empty .dots`, so the
 *    layer has to be a descendant of this root. `App.tsx`'s `<main>` already
 *    carries its own `.dots` with the *other* mask (`ellipse 80% 60% at 50% 0%`
 *    against this screen's `70% 70% at 70% 40%`), and two offset dot grids read
 *    as a rendering fault.
 *  - the artboard's `<main>` has its own padding — `clamp(32px,6vw,80px)
 *    clamp(16px,4vw,64px) 64px` against the shell's `px-6 pb-10` — and this
 *    screen is the one that needs the air.
 *
 * ## Two things that are deliberately not the artboard's
 *
 * **`overflow`.** The artboard writes `overflow:hidden` and relies on the
 * document scrolling. `App.tsx`'s shell is `h-dvh overflow-hidden`, so ported
 * verbatim a short viewport clips the action off the bottom with no way to
 * reach it. Horizontal clipping is what the rotated cards actually need, so it
 * is `overflow-x: hidden` with `overflow-y: auto`.
 *
 * **The CTA's background.** The artboard sets it inline *and* declares
 * `.cta:hover{background:#2A2B31}`, and a `style` attribute outranks every
 * selector — so that hover is dead in the artboard too. Both states of the
 * button are utilities here (`bg-ink hover:bg-ink-hover`, the same two values),
 * which is how `src/ui/Tree.tsx` fixes the same collision on its own `.ghost`.
 * The `cta` class stays, because it is the artboard's name for this control.
 *
 * ## Tailwind's preflight, twice
 *
 * `leading-[normal]` on the root undoes preflight's `line-height: 1.5`, which
 * the artboard never had: every element that does not declare its own leading —
 * the eyebrow, `your-app`, `$ npm test`, the step digits — sat 2-4px taller
 * without it. `Tree.tsx` does the same on its aside.
 *
 * `box-sizing: content-box` appears on six elements, and the rule that picks
 * them is "an explicit width or height, *plus* padding or a border". The
 * artboard declares `border-box` on `<main>` and `<aside>` only, so everything
 * else was drawn content-box; under preflight the three cards lose 34, 2 and
 * 3px and two step markers and one pill lose 2. Step three's marker has no
 * border, so it is 32px either way and says nothing.
 *
 * ## Reduced motion
 *
 * This is the most heavily animated screen in the app: a six-rung entrance
 * ladder, three infinite float loops a second apart, a pulse ring and two
 * marching dashed connectors. `artboard.css`'s `.kr, .kr *` guard is a strong
 * second belt and the root carries `kr` for it, but the real gate is in JS and
 * it **removes the classes**, so there is nothing left to animate rather than
 * an animation asked to stop.
 *
 * Motion's `useReducedMotion()` is one of its two sources and not enough on its
 * own: `CLAUDE.md` records it as a module-level singleton seeded at the first
 * call anywhere in the process, which has answered `false` with the media
 * feature actually set. So it is OR'd with a live `matchMedia` read. The OR
 * fails toward the cheap direction — a spurious yes costs one entrance nobody
 * asked to stop; a missed yes is the thing the preference exists to prevent,
 * on the screen where it would be most conspicuous.
 */

import { useSyncExternalStore, type CSSProperties, type ReactElement, type ReactNode } from "react"
import { useReducedMotion } from "motion/react"

/* -------------------------------------------------------------------------- */
/* Props                                                                      */
/* -------------------------------------------------------------------------- */

interface EmptyCommon {
  className?: string
}

/** First run: `GET /api/projects` answered, and there are none. */
export interface NoProjectsShape extends EmptyCommon {
  kind: "no-projects"
  /**
   * Point kantan at a repository.
   *
   * **Required**, which is a departure from `TreeProps.onAddProject` and the
   * reason is the asymmetry rather than a change of mind. Tree's control is a
   * 30px icon in a column header, so hiding it when nobody wired it costs a
   * convenience and leaves a working screen. This one is the only exit from
   * the only screen a new user sees: with no handler there is no way to use the
   * product at all, and the person who finds out is the user. A required prop
   * moves that discovery to `tsc`, at the one site that can satisfy it — which
   * is why `GateShape` requires `onApprove` too.
   *
   * It should be the **same function** `Tree` is given: both controls say "Add
   * a repository", and an action keeps its name through a flow.
   */
  onAddProject: () => void
}

/** Repositories exist; no task is selected. Not drawn in the artboard. */
export interface NoSelectionShape extends EmptyCommon {
  kind: "no-selection"
  /** There is no repository to add here. Declared so passing one is an error. */
  /**
   * Optional here, required on `no-projects`.
   *
   * It was `never`, on the reasoning that someone with repositories needs to
   * pick a task rather than add another repo. True, and it left the only
   * screen most people see without the artboard's one action — which read as
   * missing rather than as deliberate. It is the secondary action now: the
   * arrow still points at the tree, and adding another repository is a thing
   * people do.
   */
  onAddProject?: () => void
}

export type EmptyProps = NoProjectsShape | NoSelectionShape

/* -------------------------------------------------------------------------- */
/* Motion preference                                                          */
/* -------------------------------------------------------------------------- */

/** Motion asks `(prefers-reduced-motion)`, which means the same thing. */
const REDUCE_QUERY = "(prefers-reduced-motion: reduce)"

function canAskForMotionPreference(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
}

function subscribeToReducePreference(onChange: () => void): () => void {
  if (!canAskForMotionPreference()) return () => {}
  const query = window.matchMedia(REDUCE_QUERY)
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

function readReducePreference(): boolean {
  return canAskForMotionPreference() ? window.matchMedia(REDUCE_QUERY).matches : false
}

/** Does this person want less movement? See the file header for why it is two
 * sources OR'd rather than either one. */
function usePrefersReducedMotion(): boolean {
  const motionsAnswer = useReducedMotion() === true
  const live = useSyncExternalStore(subscribeToReducePreference, readReducePreference, () => false)
  return motionsAnswer || live
}

/* -------------------------------------------------------------------------- */
/* Icons. Lucide shapes, as the artboard draws them.                          */
/* -------------------------------------------------------------------------- */

/**
 * `.ic` carries the 16px default, the `fill:none` and the round joins, and they
 * are repeated here as attributes so a specimen still reads as a line drawing
 * in a harness that has not loaded `artboard.css`.
 */
function Icon({ children, style }: { children: ReactNode; style?: CSSProperties }): ReactElement {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="ic"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
    >
      {children}
    </svg>
  )
}

/* -------------------------------------------------------------------------- */
/* The screen                                                                 */
/* -------------------------------------------------------------------------- */

/** The artboard's three steps, verbatim. The lead is its `<strong>`. */
const STEPS = [
  {
    lead: "Add a repository",
    rest: "and choose the Claude account it runs under: personal or work.",
  },
  { lead: "Point at a task file", rest: "such as", code: "docs/features/importer.md" },
  { lead: "Start a task.", rest: "kantan plans it, then stops and waits for you." },
] as const

/** `.bf` plus a rung, dropped whole when the person asked for less movement. */
function entrance(reduced: boolean, rung?: string): string {
  if (reduced) return ""
  return rung === undefined ? "bf" : `bf ${rung}`
}

export function Empty(props: EmptyProps): ReactElement {
  const { kind, className } = props
  const reduced = usePrefersReducedMotion()
  const anim = (classes: string): string => (reduced ? "" : classes)

  const heading = kind === "no-projects" ? "Start with a repository." : "Start a task."

  return (
    <main
      /* `kr-empty` is what switches on this screen's own longer, softer fade
         (12px / blur(8px) / .8s), its 8px pulse ring, its .08s delay ladder and
         its dot geometry — `artboard.css` scopes all four to a descendant of
         that class. `kr` is what the reduced-motion `!important` guard needs.
         `leading-[normal]` undoes preflight; see the file header. */
      className={`kr kr-empty leading-[normal]${className === undefined ? "" : ` ${className}`}`}
      data-motion={reduced ? "static" : "animated"}
      style={{
        /* Inert in `App.tsx`'s grid and correct in the artboard's flex row,
           where this column is the one that takes the slack. */
        flex: "999 1 560px",
        minWidth: 0,
        minHeight: 0,
        position: "relative",
        overflowX: "hidden",
        overflowY: "auto",
        padding: "clamp(32px,6vw,80px) clamp(16px,4vw,64px) 64px",
        boxSizing: "border-box",
      }}
    >
      {/* Its **own** absolutely positioned layer, exactly as the artboard draws
          it. `.dots` carries a `mask-image`, and a mask applies to the
          element's entire rendering including its children — on a content
          container it silently fades the content out. */}
      <div
        className="dots"
        data-testid="dots"
        aria-hidden="true"
        style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
      />

      <div
        style={{
          position: "relative",
          maxWidth: 1040,
          margin: "0 auto",
          display: "grid",
          /* `auto-fit` with a 400px floor: side by side where there is room for
             both, stacked where there is not. `min(400px,100%)` is what keeps
             it from overflowing a narrow column rather than wrapping. */
          gridTemplateColumns: "repeat(auto-fit,minmax(min(400px,100%),1fr))",
          gap: 48,
          alignItems: "center",
        }}
      >
        <div>
          <div
            className={entrance(reduced)}
            data-testid="eyebrow"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "5px 12px 5px 6px",
              borderRadius: 999,
              background: "#fff",
              border: "1px solid #E7E7EB",
              boxShadow: "0 1px 2px rgba(17,18,22,.04)",
              fontSize: 13,
              color: "#3A3D45",
            }}
          >
            {/* `lang` so a screen reader reads 簡単 in Japanese rather than
                spelling it at an English voice. */}
            <span
              lang="ja"
              style={{
                padding: "2px 7px",
                borderRadius: 999,
                background: "#111216",
                color: "#fff",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              簡単
            </span>
            kantan means &ldquo;simple&rdquo; in Japanese
          </div>

          <h1
            className={entrance(reduced, "d1")}
            style={{
              margin: "22px 0 0",
              fontSize: "clamp(38px,5vw,58px)",
              lineHeight: 1.02,
              fontWeight: 650,
              letterSpacing: "-.045em",
              textWrap: "balance",
            }}
          >
            {heading}
          </h1>

          <p
            className={entrance(reduced, "d2")}
            data-testid="lede"
            style={{
              margin: "18px 0 0",
              maxWidth: "46ch",
              fontSize: 17,
              lineHeight: 1.6,
              color: "#4A4E59",
              textWrap: "pretty",
            }}
          >
            kantan works through the tasks in a markdown file in your repo, one at a time. It writes
            a plan, waits for your OK, then implements it and runs your tests until the exit code
            says they pass.
          </p>

          {/* A real sequence — repository, then a task file, then a task — which
              is the one thing that earns a numbered list. */}
          <ol
            data-testid="steps"
            style={{
              listStyle: "none",
              margin: "30px 0 0",
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}
          >
            {STEPS.map((step, index) => (
              <li
                key={step.lead}
                className={entrance(reduced, `d${index + 3}`)}
                style={{
                  display: "grid",
                  gridTemplateColumns: "32px minmax(0,1fr)",
                  gap: 14,
                  alignItems: "start",
                }}
              >
                <span
                  style={
                    index === 2
                      ? {
                          /* Orange is the one colour that pulls the eye and
                             DESIGN.md allows it for one thing: what needs you.
                             Here that is the live step. No border, so it is
                             32px under either box model. */
                          width: 32,
                          height: 32,
                          borderRadius: 10,
                          background: "#FF6A1A",
                          display: "grid",
                          placeItems: "center",
                          fontSize: 14,
                          fontWeight: 700,
                          color: "#1A0B02",
                        }
                      : {
                          width: 32,
                          height: 32,
                          borderRadius: 10,
                          background: "#fff",
                          border: "1px solid #E2E2E7",
                          boxShadow: "0 1px 2px rgba(17,18,22,.05)",
                          display: "grid",
                          placeItems: "center",
                          fontSize: 14,
                          fontWeight: 650,
                          /* 32 + a 1px border each side = the 34px it was drawn
                             at. Preflight's border-box would make it 32. */
                          boxSizing: "content-box",
                        }
                  }
                >
                  {index + 1}
                </span>
                {/* One `<span>` holding the whole item, because the `<li>` is a
                    two-column grid: siblings would each become a grid item and
                    flow into the 32px counter column. That is the "one
                    character per line" defect `CLAUDE.md` records. */}
                <span style={{ fontSize: 15, lineHeight: 1.5, paddingTop: 5 }}>
                  <strong style={{ fontWeight: 620 }}>{step.lead}</strong>{" "}
                  <span style={{ color: "#4A4E59" }}>{step.rest}</span>
                  {"code" in step ? (
                    <>
                      {" "}
                      <code
                        className="m"
                        style={{
                          fontSize: 13,
                          background: "#fff",
                          border: "1px solid #E7E7EB",
                          borderRadius: 6,
                          padding: "1px 6px",
                        }}
                      >
                        {step.code}
                      </code>
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>

          <div className={entrance(reduced, "d6")} data-testid="action" style={{ marginTop: 34 }}>
            {props.kind === "no-projects" ? (
              <button
                type="button"
                onClick={props.onAddProject}
                /* `cta` is the artboard's name for this control. The background
                   and its hover are utilities rather than inline, because an
                   inline `background` outranks `.cta:hover`. */
                className="cta bg-ink hover:bg-ink-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo"
                style={{
                  height: 56,
                  padding: "0 26px 0 20px",
                  borderRadius: 999,
                  border: 0,
                  color: "#fff",
                  fontSize: 16,
                  fontWeight: 620,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 10,
                  boxShadow:
                    "0 12px 30px -12px rgba(17,18,22,.65),inset 0 1px 0 rgba(255,255,255,.16)",
                }}
              >
                <Icon style={{ width: 18, height: 18, strokeWidth: 2.4 }}>
                  <path d="M5 12h14" />
                  <path d="M12 5v14" />
                </Icon>
                Add a repository
              </button>
            ) : (
              /* Not a button, because there is nothing here to press: the task
                 is in `Tree`'s column, which labels itself "Projects". A pill
                 shaped like the one above would be a control that does nothing,
                 and the quieter weight is honest — the action is elsewhere on
                 this screen. */
              <p
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  margin: 0,
                  fontSize: 15,
                  lineHeight: 1.5,
                  color: "#4A4E59",
                }}
              >
                <Icon style={{ width: 18, height: 18, color: "#6B7080" }}>
                  <path d="m12 19-7-7 7-7" />
                  <path d="M19 12H5" />
                </Icon>
                Choose one in the projects list on the left.
              </p>
            )}

            {props.kind === "no-selection" && props.onAddProject !== undefined && (
              <div style={{ marginTop: 18 }}>
                <button
                  type="button"
                  onClick={props.onAddProject}
                  className="ghost"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    height: 44,
                    padding: "0 18px 0 14px",
                    borderRadius: 999,
                    border: "1px solid #DCDCE2",
                    background: "#fff",
                    color: "#3A3D45",
                    fontSize: 14.5,
                    fontWeight: 600,
                  }}
                >
                  <Icon style={{ width: 16, height: 16, strokeWidth: 2.4 }}>
                    <path d="M5 12h14" />
                    <path d="M12 5v14" />
                  </Icon>
                  Add another repository
                </button>
              </div>
            )}
          </div>
        </div>

        {/* The specimens: a repository, a task file and a gate, drawn in the
            app's own UI so they teach the real model. `aria-hidden` because
            they are a picture of three regions the real screen renders for
            itself, and Approve and Send back are `<span>`s for the same reason
            — a `<button>` in here would be reachable by Tab and invisible to
            the reader that would say what it is. */}
        <div
          className={entrance(reduced, "d3")}
          data-testid="specimens"
          aria-hidden="true"
          style={{
            position: "relative",
            width: "100%",
            maxWidth: 460,
            height: 420,
            justifySelf: "center",
          }}
        >
          <svg
            viewBox="0 0 460 420"
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              overflow: "visible",
            }}
          >
            <path
              className={anim("flow")}
              d="M150 110 C 150 160, 230 150, 250 170"
              fill="none"
              stroke="#B9BAC6"
              strokeWidth={1.6}
              strokeDasharray="4 8"
              strokeLinecap="round"
            />
            <path
              className={anim("flow")}
              d="M300 300 C 300 330, 220 320, 200 330"
              fill="none"
              stroke="#FFB27F"
              strokeWidth={1.6}
              strokeDasharray="4 8"
              strokeLinecap="round"
            />
          </svg>

          <div
            className={anim("fl")}
            data-testid="repo-card"
            style={{
              position: "absolute",
              left: 0,
              top: 8,
              width: 250,
              padding: "14px 16px",
              borderRadius: 16,
              background: "#fff",
              border: "1px solid #E7E7EB",
              boxShadow: "0 1px 2px rgba(17,18,22,.04),0 16px 36px -18px rgba(17,18,22,.28)",
              rotate: "-2deg",
              /* 250 + 32 of padding + 2 of border = the 284px it was drawn at. */
              boxSizing: "content-box",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Icon style={{ color: "#6B7080" }}>
                <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
              </Icon>
              <span style={{ fontSize: 14.5, fontWeight: 620 }}>your-app</span>
              {/* The account chip. `DESIGN.md` gives it its own tint pair
                  (#E0F2FE on #075985) precisely so which account a run bills to
                  is never a silent default. */}
              <span
                style={{
                  marginLeft: "auto",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "2px 7px 2px 5px",
                  borderRadius: 6,
                  background: "#E0F2FE",
                  color: "#075985",
                  fontSize: 11.5,
                  fontWeight: 550,
                }}
              >
                <Icon style={{ width: 12, height: 12 }}>
                  <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </Icon>
                personal
              </span>
            </div>
            {/* Mono, because it is a command. DESIGN.md: mono for every machine
                value. And it is the promise Approve makes. */}
            <div className="m" style={{ margin: "8px 0 0 24px", fontSize: 12, color: "#6B7080" }}>
              $ npm test
            </div>
          </div>

          <div
            className={anim("fl2")}
            data-testid="taskfile-card"
            style={{
              position: "absolute",
              right: 0,
              top: 130,
              width: 280,
              borderRadius: 16,
              background: "#fff",
              border: "1px solid #E7E7EB",
              boxShadow: "0 1px 2px rgba(17,18,22,.04),0 16px 36px -18px rgba(17,18,22,.28)",
              overflow: "hidden",
              rotate: "1.5deg",
              /* 280 + 2 of border = the 282px it was drawn at. */
              boxSizing: "content-box",
            }}
          >
            <div
              className="m"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "9px 14px",
                borderBottom: "1px solid #EEEEF1",
                background: "#FAFAFB",
                fontSize: 11.5,
                color: "#5F6370",
              }}
            >
              <Icon style={{ width: 13, height: 13 }}>
                <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
                <path d="M14 2v4a2 2 0 0 0 2 2h4" />
              </Icon>
              docs/features/importer.md
            </div>
            <div
              className="m"
              style={{ padding: "12px 14px 14px", fontSize: 12, lineHeight: 1.85, color: "#3A3D45" }}
            >
              <div style={{ color: "#111216", fontWeight: 600 }}># Importer</div>
              <div>- [ ] T1 Parse the manifest</div>
              {/* Tinted, not recoloured: the row stays readable prose and the
                  tint says which task the gate beside it is about. */}
              <div
                style={{
                  background: "#FFF1E8",
                  margin: "0 -6px",
                  padding: "0 6px",
                  borderRadius: 6,
                  color: "#9A3B06",
                }}
              >
                - [ ] T2 Map records to rows
              </div>
              <div>- [ ] T3 Runtime shim (v1.2)</div>
            </div>
          </div>

          <div
            className={anim("fl3")}
            data-testid="plan-card"
            style={{
              position: "absolute",
              left: 12,
              bottom: 0,
              width: 270,
              padding: 1.5,
              borderRadius: 18,
              background: "linear-gradient(135deg,#FFD2B3,#FF6A1A 55%,#FFE3D0)",
              boxShadow: "0 24px 50px -24px rgba(255,106,26,.55)",
              rotate: "-1deg",
              /* 270 + 3 of gradient border = the 273px it was drawn at. */
              boxSizing: "content-box",
            }}
          >
            <div style={{ borderRadius: 16.5, background: "#fff", padding: "14px 16px 16px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  className={anim("pulse")}
                  style={{ width: 10, height: 10, borderRadius: "50%", background: "#FF6A1A" }}
                />
                <span style={{ fontSize: 12, fontWeight: 620, color: "#9A3B06" }}>
                  Plan ready · T2
                </span>
              </div>
              <div
                style={{
                  marginTop: 8,
                  fontSize: 20,
                  lineHeight: 1.15,
                  fontWeight: 650,
                  letterSpacing: "-.03em",
                }}
              >
                Is this plan right?
              </div>
              {/* Two bars standing in for the plan's prose. Not lorem: there is
                  no sentence here a reader could mistake for a real plan. */}
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <span style={{ height: 6, width: 92, borderRadius: 999, background: "#EDEDF0" }} />
                <span style={{ height: 6, width: 56, borderRadius: 999, background: "#EDEDF0" }} />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14 }}>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    height: 32,
                    padding: "0 13px 0 11px",
                    borderRadius: 999,
                    background: "#111216",
                    color: "#fff",
                    fontSize: 12.5,
                    fontWeight: 600,
                  }}
                >
                  <Icon style={{ width: 13, height: 13, strokeWidth: 2.6 }}>
                    <path d="M20 6 9 17l-5-5" />
                  </Icon>
                  Approve
                </span>
                <span
                  data-testid="send-back"
                  style={{
                    height: 32,
                    padding: "0 12px",
                    borderRadius: 999,
                    border: "1px solid #DCDCE2",
                    display: "inline-flex",
                    alignItems: "center",
                    fontSize: 12.5,
                    fontWeight: 550,
                    color: "#3A3D45",
                    /* 32 + a 1px border top and bottom = the 34px it was drawn
                       at, which is what lines it up with Approve beside it. */
                    boxSizing: "content-box",
                  }}
                >
                  Send back
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  )
}
