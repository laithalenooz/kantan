/**
 * A sentence a model wrote, labelled as a sentence a model wrote.
 *
 * It exists for one case today: a stalled run, where three identical failures
 * at the top of the effort ladder is a state the log decides, and *why* they
 * failed is a sentence no template can write. The machine's own `detail` says
 * what happened mechanically; this says what broke.
 *
 * **The line this component is the enforcement of:** the agent may write text
 * that appears inside a surface; it may never decide what surface appears, or
 * what a status says. So:
 *
 * - Nothing here is a status. The band, the footer, the glyph and every branch
 *   read `reason`, which the signature hash decided before a model was asked.
 * - It is always marked. Unlabelled model prose beside measured figures reads
 *   as another measurement, which is the same class of overclaim as a green
 *   tick on a self-checked run. The run record has done this since it was
 *   written, with `AGENT` on its own rows; this is the same label.
 * - It is additive. Absent, nothing claims the state is different - the
 *   machine's detail and the raw output in the log are still there.
 */

import type { ReactElement } from "react"

export function AgentNote({ text, className }: { text: string; className?: string }): ReactElement {
  return (
    <section
      data-agent-note
      className={`rounded-2xl border border-line bg-white px-5 py-4 ${className ?? ""}`}
    >
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
        {/* The record's own label, in the record's own treatment: mono, small,
            uppercase, muted. A reader who has seen one AGENT row knows what
            this is without being told again. */}
        <span className="m shrink-0 text-[10.5px] font-[650] tracking-[.06em] text-muted-400 uppercase">agent</span>
        <span className="min-w-0 text-[14px] leading-[1.6] text-muted-700">{text}</span>
      </span>
    </section>
  )
}
