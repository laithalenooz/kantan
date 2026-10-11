/**
 * The run record: the centre log, and the only place a human sees what the
 * agent actually did.
 *
 * Translated from `docs/design/Main.dc.html` (under the gate) and
 * `docs/design/Return.dc.html` (coming back, still running). The frame is the
 * designer's Magic UI `Terminal`: a white card with a hairline header carrying
 * the terminal glyph, the heading, the event count in mono, and a Follow
 * toggle, over a fixed-height scroller — 520px under the gate, 640px coming
 * back.
 *
 * ## Why it virtualises
 *
 * A real run emits thousands of events; `Return.dc.html` draws 2,184 and that
 * is not the ceiling. So the rows come from TanStack Virtual, and the measured
 * cost at ten thousand rows is a few dozen row elements, not ten thousand —
 * `test/ui/Stream.test.tsx` asserts the count is bounded and, more to the
 * point, that it is the *same* at one thousand and at ten thousand. A bound
 * that grows with the log is not a bound.
 *
 * `measureElement` is wired because rows are not one height: a 156-character
 * path wraps to three lines and an expanded row carries a whole diff.
 *
 * ## Why the seen set lives here and not in a row
 *
 * A virtualized row unmounts the moment it leaves the window. Anything it
 * remembered — that it has already played its entry fade, that it was
 * expanded — dies with it and comes back false, so every row re-animates when
 * you scroll back up and expanded rows collapse behind you. Both sets are held
 * here, keyed by event id, for the life of the component.
 *
 * The seed matters as much as the set: **every id present at mount counts as
 * already seen**. Opening a run with ten thousand events in it is not ten
 * thousand arrivals, and a history row reached by scrolling is not new.
 *
 * That costs one thing on purpose. Both artboards stagger the rows that are
 * already there when the card appears (`bf d1` through `bf d9`), and this does
 * not: an animation on a row that was already in the log is indistinguishable
 * from the bug above, so there is no rule that keeps one and drops the other.
 * The card's own blur fade — `bf d3` on the same `<section>` in the artboards —
 * carries the opening instead, as one movement rather than thirty.
 *
 * ## What the seed cannot do, and what has to hold instead
 *
 * The seed only covers rows that are in `rows` on the first render. The real
 * log does not arrive that way: `GET /api/runs/:id/stream` replays the run's
 * JSONL **from byte 0 on every connect** and then follows, deliberately
 * unbatched — one record on disk is one event on the wire, with no marker
 * between the replay and the live tail. So a caller that mounts this empty and
 * fills it from the stream has no boundary to pass, and the replay arrives as
 * first arrivals: the opening window fades in, which is the artboards' look
 * reached by a different road, and then settles.
 *
 * What must not happen is the **reconnect** doing it again, and the only thing
 * that stops it is the one thing a caller controls: **`id` has to be
 * deterministic per log line** — the run id and the record's index, say — so a
 * replay of the same bytes produces the same ids and this component recognises
 * every one of them. Ids minted per delivery would re-animate the whole log on
 * every reconnect, collapse every expanded row, and throw away the
 * virtualizer's measurement cache with them. `test/ui/Stream.test.tsx` holds
 * that contract both ways round.
 *
 * One asymmetry falls out of that and is kept on purpose. Following moves the
 * scroll in a commit *after* the one that drew an arrival, so a single update
 * carrying hundreds of records lands the viewer past the rows that faded in,
 * and those finally on screen will not have. The alternative — absorbing only
 * what a commit drew — animates that case and pays for it by fading in every
 * never-drawn row the first time someone scrolls up through the log, which is
 * the behaviour this whole mechanism exists to prevent. A fade that did not
 * happen is cheaper than one that happens again.
 *
 * For the same reason, a caller showing a **different run** should give this a
 * `key` of the run id rather than swapping `rows` underneath it. Swapped rows
 * are absorbed, but only after the render that first held them has already
 * treated its window as arrivals — and `following` and the expanded set would
 * carry over from a run they do not belong to.
 *
 * ## Reduced motion
 *
 * `main.tsx` wraps the app in `MotionConfig reducedMotion="user"`, which is
 * necessary and not sufficient: it disables transform animations and leaves
 * opacity and filter running, which is most of a blur fade. So the preference
 * is read here too, and `enter` is forced false — which removes `initial` and
 * `animate` from the row altogether rather than hoping the config covers them.
 */

import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode, type UIEvent } from "react"
import { motion, useReducedMotion } from "motion/react"
import { useVirtualizer } from "@tanstack/react-virtual"

import { Icon, ROW_ESTIMATE_PX, Row, group, type StreamRow } from "./Row.tsx"

export type { EventRow, StreamRow, TestsRow, TestsSeen } from "./Row.tsx"

/** How many rows past the window are kept mounted, so scrolling is not blank. */
const OVERSCAN = 8

/** The longest entry stagger, in rows. `Main.dc.html` stops at `d9`. */
const MAX_STAGGER = 9

/** Seconds between two staggered entries, matching the artboard's `.d*` steps. */
const STAGGER_STEP = 0.05

/** Within this many pixels of the end counts as "at the bottom". */
const BOTTOM_SLACK = 24

/**
 * `bf d3` from the artboards: the card arrives as one blur fade.
 *
 * This is the opening movement, and it is the only one on mount — see the file
 * comment on why the rows do not stagger behind it.
 */
const CARD_FADE = {
  initial: { opacity: 0, y: 10, filter: "blur(6px)" },
  animate: { opacity: 1, y: 0, filter: "blur(0px)" },
  transition: { duration: 0.7, delay: 0.15, ease: [0.2, 0.7, 0.2, 1] as const },
} as const

export interface StreamProps {
  /**
   * Newest last, which is what the header promises. Each row needs a stable,
   * unique `id`: the entry animation, the expanded set and the virtualizer's
   * measurement cache are all keyed on it.
   */
  rows: readonly StreamRow[]
  /** The scroller's height. 520 under the gate, 640 coming back. */
  maxHeight?: number
  /**
   * Drawn inside the scroller below the last row, which is where both
   * artboards put the run's current state: the orange "Gate · run paused until
   * you decide" band, or the spinning "npm test · running, attempt 6" row.
   * That state belongs to whoever owns the run, not to the log.
   */
  footer?: ReactNode
  className?: string
}

/** The query. Motion asks `(prefers-reduced-motion)`, which means the same. */
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

/**
 * Does this person want less movement?
 *
 * Two sources, OR'd. Either can miss a yes, and the cached one can also hold a
 * stale yes after the setting goes off again — so the two directions are both
 * reachable, and they are not the same size. A spurious yes costs one fade
 * nobody asked to stop. A missed yes costs the thing the preference exists to
 * prevent. So the OR, which fails toward the cheap one.
 *
 * Motion's `useReducedMotion()` is one of them, as the gate for a fade should
 * be. On its own it is not enough: it answers from a module-level singleton
 * initialised at the **first call anywhere in the process**, returns `null`
 * until then, and carries a standing TODO about not updating afterwards. So it
 * can be stale — including for a person who turns the setting on while the page
 * is open, which is exactly when a log full of moving rows is worst.
 *
 * The second is the media query itself, subscribed to, so the answer is live.
 */
function usePrefersReducedMotion(): boolean {
  const motionsAnswer = useReducedMotion() === true
  const live = useSyncExternalStore(subscribeToReducePreference, readReducePreference, () => false)
  return motionsAnswer || live
}

export function Stream({ rows, maxHeight = 520, footer, className }: StreamProps) {
  const headingId = useId()
  const viewport = useRef<HTMLDivElement | null>(null)

  /** Expanded row ids. Here, not in the row, so scrolling does not collapse them. */
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set<string>())

  const [following, setFollowing] = useState(true)
  const lastTop = useRef(0)

  const reduced = usePrefersReducedMotion()

  /* Seeded with the whole log: see the file comment. A row only ever animates
   * on its first arrival in a session that was already open. */
  const [seen] = useState<Set<string>>(() => new Set(rows.map((row) => row.id)))

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => viewport.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    /* Keyed by event id, not by index. The default index key would make the
     * measurement cache wrong the moment anything but an append happened, and
     * would also hand React a key that changes under a row. */
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: OVERSCAN,
  })

  const items = virtualizer.getVirtualItems()

  /*
   * Record what has been drawn, after the commit that drew it.
   *
   * After the commit, not during render: reading the set during render and
   * writing it in the same pass would make the second of StrictMode's two
   * render calls disagree with the first, and a row would decide it was old
   * before it had ever appeared.
   *
   * Guarded on the array's identity rather than its length, so an array that
   * changed without growing — a replay rebuilt from byte 0, a different run
   * swapped in — is absorbed too. Absorbed *after the fact*, though: the render
   * that first held those rows has already decided what was new in it. Which is
   * right for a reconnect, whose ids are old, and is the reason the file comment
   * asks for a `key` on a run change, whose ids are not.
   */
  const absorbed = useRef<readonly StreamRow[] | null>(null)
  useEffect(() => {
    if (absorbed.current === rows) return
    absorbed.current = rows
    for (const row of rows) seen.add(row.id)
  })

  const totalSize = virtualizer.getTotalSize()

  /* Newest at the bottom means the bottom is where the eye is. Driving the
   * scroll element directly rather than `scrollToIndex` keeps the footer — the
   * gate band, the running row — in view, since it sits below the last row.
   *
   * `totalSize` is a dependency because the first run of this cannot be the
   * last: on mount every row is still an estimate, so the bottom it reaches is
   * an estimate too, and measuring the window moves the real bottom out from
   * under it. Re-pinning on each change converges, because measuring a row
   * only ever replaces its estimate with its height. */
  useEffect(() => {
    if (!following) return
    const el = viewport.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    lastTop.current = el.scrollTop
  }, [following, rows.length, totalSize])

  function onScroll(event: UIEvent<HTMLDivElement>) {
    const el = event.currentTarget
    const top = el.scrollTop
    const wentUp = top < lastTop.current - 1
    lastTop.current = top

    const atBottom = el.scrollHeight - top - el.clientHeight < BOTTOM_SLACK
    /* Only an upward scroll stops following. Deriving it from "not at the
     * bottom" instead would let the component's own scroll-to-bottom turn
     * following off, because the total height grows as rows are measured and
     * the previous bottom is no longer the bottom. */
    if (atBottom) setFollowing(true)
    else if (wentUp) setFollowing(false)
  }

  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }

  /** How many rows sit above the window, unrendered. 0 hides the notice. */
  const above = items[0]?.index ?? 0

  let entering = 0

  return (
    <motion.section
      aria-labelledby={headingId}
      className={[
        "overflow-clip rounded-[20px] border border-edge bg-white",
        "shadow-[0_1px_2px_rgba(17,18,22,.04),0_12px_32px_-20px_rgba(17,18,22,.18)]",
        className ?? "",
      ].join(" ")}
      {...(reduced ? {} : CARD_FADE)}
    >
      <div className="flex flex-wrap items-center gap-2.5 border-b border-hairline px-4 py-3.5">
        <Icon name="terminal" className="size-4 shrink-0 text-muted-900" />
        <h2 id={headingId} className="m-0 text-[15px] font-[620]">
          Run record
        </h2>
        <span className="font-mono text-xs text-muted-400">
          {group(rows.length)} {rows.length === 1 ? "event" : "events"} · newest at the bottom
        </span>
        <button
          type="button"
          aria-pressed={following}
          onClick={() => setFollowing((prev) => !prev)}
          className={[
            "ml-auto inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px]",
            following
              ? "border-[#CFD0F7] bg-[#F3F3FE] font-semibold text-indigo-deeper"
              : "border-edge-soft bg-white font-medium text-muted-900 hover:bg-[#F6F6F8]",
          ].join(" ")}
        >
          <Icon name="arrowDown" className="size-[13px] shrink-0" />
          {following ? "Following" : "Follow"}
        </button>
      </div>

      {/* The artboard draws this at the top of the scroller. It lives just
          outside it instead, so the virtual container starts at the scroller's
          own origin — inside, its height would offset every row by its own
          size and the window would be computed one row out. */}
      {above > 0 ? (
        <div className="bg-gradient-to-b from-[#F7F7F9] to-white px-4 py-2.5 font-mono text-xs text-muted-400">
          ↑ {group(above)} earlier {above === 1 ? "event" : "events"}, rendered as you scroll
        </div>
      ) : null}

      <div
        ref={viewport}
        onScroll={onScroll}
        data-stream-viewport
        /* Focusable because it scrolls: a keyboard user needs to reach it, and
         * a pointer user is the only one a bare overflow container serves. */
        tabIndex={0}
        role="region"
        aria-label="Run record, newest at the bottom"
        style={{ maxHeight, overflow: "auto" }}
      >
        <div data-stream-total style={{ height: totalSize, position: "relative" }}>
          {items.map((item) => {
            const row = rows[item.index]
            if (!row) return null

            const isNew = !seen.has(row.id) && !reduced
            const delay = isNew ? Math.min(entering++, MAX_STAGGER) * STAGGER_STEP : 0

            return (
              <Row
                key={item.key}
                row={row}
                index={item.index}
                top={item.start}
                measure={virtualizer.measureElement}
                resize={virtualizer.resizeItem}
                open={open.has(row.id)}
                onToggle={() => toggle(row.id)}
                enter={isNew}
                delay={delay}
              />
            )
          })}
        </div>
        {footer}
      </div>
    </motion.section>
  )
}
