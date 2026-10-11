/**
 * Placeholder. Tasks 21 to 24 replace the contents of this file with the real
 * three-column shell, the project tree, the stream, the gate and the sidebar.
 *
 * Until then it is a token specimen, and its only job is to make a wrong token
 * visible on sight: the paper ground, ink type at the one working size, a
 * hairline rule, machine values in mono, the fixed reading measure, and one
 * reversed blue plate standing in for the gate. If this page looks like grey
 * mush, tokens.css is wrong and no component built on it can be right.
 *
 * Note what the markup does NOT contain: no font-size utility (there is one
 * working size and the body carries it), no rounded corner, no shadow, and no
 * colour outside the single plate. Rank here comes from weight, case, reversal
 * and rule, which is the whole typographic argument.
 */

/** Measured against #F4F4F1 paper, or against its own plate for reversed type.
 * Printed on the page so the specimen states its own evidence. */
const INKS = [
  { name: "ground", value: "#F4F4F1", note: "cool paper, not cream" },
  { name: "ink", value: "#17191C", note: "15.98:1 on paper" },
  { name: "rule", value: "#C9C9C3", note: "1.51:1 — divider only" },
  { name: "muted ink", value: "#5C6066", note: "5.74:1 on paper" },
] as const

/** Roles are kantan's, not ISO's. ISO 3864-1 Table 1 gives the meanings these
 * borrow from — mandatory action, safe condition, prohibition, warning — but
 * what a later component needs to know is what the colour means here. */
const PIGMENTS = [
  { name: "blue", role: "needs you", value: "#0057B8", note: "6.24:1 reversed" },
  { name: "green", role: "tests passed", value: "#046A38", note: "6.10:1 reversed" },
  { name: "red", role: "failed", value: "#C8102E", note: "5.34:1 reversed" },
  { name: "yellow", role: "stalled", value: "#FFC72C", note: "11.29:1, ink type" },
  { name: "none", role: "running", value: "—", note: "merely happening, so no colour" },
] as const

export function App() {
  return (
    <main className="min-h-screen bg-paper p-region">
      <header className="flex items-baseline justify-between border-b border-rule pb-tight">
        <h1 className="font-bold uppercase tracking-label">kantan</h1>
        <span className="machine muted">task 20 · token specimen</span>
      </header>

      <section className="measure mt-region">
        <h2 className="font-bold">4.1 Tokens</h2>
        <p className="mt-tight">
          A document of record, not a console. This paragraph sits on the fixed reading measure the
          rendered plan uses at the gate — the same working size as every other line on the surface,
          because §4.1&apos;s exception is the measure and not the size. Rank is carried by weight,
          case, reversal and rule.
        </p>
      </section>

      {/* Identical fields in identical positions, per row — a grid, not a
          flex row with guessed widths. The templates below are arbitrary on
          purpose: this specimen's columns are not the real clause tree's, so
          inventing a token for them would be inventing Task 21's field model.
          Task 21 should promote its actual template into tokens.css. */}
      <section className="mt-region border-t border-rule pt-tight">
        <h3 className="font-medium uppercase tracking-label muted">Inks</h3>
        <dl className="mt-tight">
          {INKS.map((ink) => (
            <div
              key={ink.name}
              className="grid h-row grid-cols-[8rem_7rem_1fr] items-center gap-field border-b border-rule"
            >
              <dt>{ink.name}</dt>
              <dd className="machine font-bold">{ink.value}</dd>
              <dd className="machine muted">{ink.note}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mt-region border-t border-rule pt-tight">
        <h3 className="font-medium uppercase tracking-label muted">
          Semantic pigments — ISO safety convention
        </h3>
        <dl className="mt-tight">
          {PIGMENTS.map((p) => (
            <div
              key={p.name}
              className="grid h-row grid-cols-[8rem_10rem_7rem_1fr] items-center gap-field border-b border-rule"
            >
              <dt className="font-bold">{p.name}</dt>
              <dd>{p.role}</dd>
              <dd className="machine">{p.value}</dd>
              <dd className="machine muted">{p.note}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* The signature move. When a run needs the human a whole region becomes
          this plate; when nothing needs them there is no colour on screen at
          all, which is why the rest of this page has none. */}
      <section className="mt-region">
        <div className="plate-action p-region">
          <p className="font-bold uppercase tracking-label">Approval required</p>
          <p className="machine muted mt-hair">
            your-app · importer/T2 · plan · 8s · $0.42 ·
            /home/you/projects/your-app/docs/features/importer.md
          </p>
          {/* No --ring override, deliberately. The ring is drawn outside the
              button's edge, so it lands on the PLATE, not on the button: the
              inherited paper ring is 6.24:1 against blue, where an ink one
              would be 2.56:1 and fail. The rule is that --ring belongs to the
              ground the ring sits on, which is the parent's. */}
          <button
            type="button"
            className="mt-block bg-paper px-field py-tight font-bold uppercase tracking-label text-ink"
          >
            Approve
          </button>
        </div>
      </section>

      <footer className="machine muted mt-region border-t border-rule pt-tight">
        Public Sans for prose and labels · Commit Mono for every machine value · one working size ·
        no radius, no shadow, no card
      </footer>
    </main>
  )
}
