/**
 * The card that stands where a run record would be, when there is no run.
 *
 * Reported from use: *"When a ticket is passed and I click on it I see empty
 * page, why?"* Clicking a ticked task drew the breadcrumb and then nothing -
 * `App.tsx`'s three centre-column branches each declined and none of them said
 * why. A blank column reads as a crash, so every combination that reaches here
 * gets a sentence. `nothingToShow` in `src/ui/taskstate.ts` decides which.
 *
 * It is deliberately **plain**: no illustration, no call to action it cannot
 * honour. `Empty.tsx` is the illustrated hero for the two whole-app states and
 * is the wrong shape for this - and there is nothing to press here anyway,
 * because the task file is the truth and kantan does not own it.
 */

import type { ReactElement } from "react"

import type { NothingToShow as Reason } from "./taskstate.ts"

/**
 * What each reason says, as prose rather than a status word.
 *
 * `checked-off` names all three ways it happens instead of guessing one,
 * because they are indistinguishable from here - the tick is the only
 * evidence, and what it means depends on who wrote it. Guessing "it passed"
 * is what put the word "Passed" on these rows in the first place.
 */
function say(reason: Reason, featureFile: string): { heading: string; body: string[] } {
  switch (reason) {
    case "checked-off":
      return {
        heading: "Nothing ran here.",
        body: [
          `This task is ticked in ${featureFile}, so kantan reads it as finished — but it has no run for it.`,
          "That means it was ticked by hand, ticked before kantan saw this repository, or its run log was deleted. kantan is not claiming the tests passed, because it did not run them.",
          "To have kantan do this one, untick the box in the task file and start it from here.",
        ],
      }
    case "no-ref":
      return {
        heading: "This line has no task ref.",
        body: [
          `kantan addresses a task by its \`T<n>\` label, and this line in ${featureFile} does not have one.`,
          "Add a ref to the line — `- [ ] T6 …` — and it becomes something that can be started. Without one there is nothing for a run to be about.",
        ],
      }
    case "no-run":
      return {
        heading: "No run to show.",
        body: [
          `kantan has no run record for this task in ${featureFile}, and it is not in a state that can be started or resumed.`,
          "That combination is not one kantan expects, so this message is deliberately vague rather than absent — if the task looks like it should be startable, the run index and the task file disagree about it.",
        ],
      }
  }
}

export function NothingToShow({
  reason,
  featureFile,
  className,
}: {
  reason: Reason
  /** Named in the prose: the file is the truth, so it is what to go and edit. */
  featureFile: string
  className?: string
}): ReactElement {
  const { heading, body } = say(reason, featureFile)
  return (
    <section
      data-nothing-to-show={reason}
      className={`rounded-2xl border border-line bg-white px-5 py-4 ${className ?? ""}`}
    >
      <h2 className="text-[15px] font-[650] text-ink">{heading}</h2>
      {body.map((line) => (
        <p key={line} className="mt-2 text-[13.5px] leading-[1.55] text-muted-500">
          {line}
        </p>
      ))}
    </section>
  )
}
