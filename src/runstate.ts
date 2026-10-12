/**
 * What a run is doing, and how it was verified — the pure half of `runindex`.
 *
 * Its own module because **the browser imports it**. `src/runindex.ts` opens
 * files at module scope (`node:fs/promises`), so a *value* import of anything
 * from there drags that into the client bundle and Vite fails the page with
 * "Module node:fs/promises has been externalized for browser compatibility".
 * That is not hypothetical: it happened the moment `src/ui/Tree.tsx` imported
 * `verificationOf` to stop labelling a self-checked run as "Passed", and it
 * broke the whole app rather than one label.
 *
 * So anything a component needs at runtime lives here, where there is nothing
 * to externalise. Types alone would not have needed it — a type import erases —
 * but `verificationOf` is a function, and it exists precisely so that reading
 * is not duplicated per surface.
 *
 * `runindex.ts` re-exports all three, so server-side callers are unchanged.
 */
import type { RunPhase, Verification, WaitReason } from "./runlog"

/**
 * What a reader concludes about how a run was verified. `Verification` plus the
 * one answer a writer cannot give: **nobody wrote it down.**
 *
 * `unknown` is not a gap to be filled in later. It is the honest reading of
 * every log written before `verifiedBy` existed, of a log a newer writer
 * truncated, and of a label this build has no word for - and it must never be
 * rendered as, or collapse into, "the tests passed".
 */
export type VerificationReading = Verification | "unknown"

/**
 * How the newest run of a task was verified, read so that absence cannot pass
 * for a pass.
 *
 * Exported as a function rather than left to callers reading `state.verifiedBy`
 * for the reason `src/permissions.ts` exports `permissionDenials`: the
 * guarantee - absence is `unknown`, a non-`done` run is `unknown`, and neither
 * is ever `test-command` - lives here, once, instead of in every surface that
 * draws a label. A caller that destructures the field instead gets `undefined`
 * and will render nothing, which looks precisely like a run that passed.
 *
 * Deliberately total over `RunState | undefined`: a task with no run at all is
 * `unknown` too, and making the caller guard first is how the one case nobody
 * thinks about becomes the one case that reads wrong.
 */
export function verificationOf(state: RunState | undefined): VerificationReading {
  if (state === undefined || state.kind !== "done") return "unknown"
  return state.verifiedBy ?? "unknown"
}

export type RunState =
  | { kind: "running"; phase: RunPhase }
  | { kind: "waiting"; reason: WaitReason }
  | {
      kind: "done"
      merged: boolean
      /**
       * How it was verified, when the log said. **Absent means unknown** - read
       * it through `verificationOf`, never directly.
       *
       * Optional rather than required, which is a deliberate trade and not an
       * oversight. Required would force every reader to handle it, but it would
       * also land a typecheck error in four `test/ui` suites that construct
       * this value, which other agents hold right now. The guarantee is kept at
       * runtime instead - `src/run.ts` writes it on every `done` run, so a
       * state without one came from a log without one - and `verificationOf` is
       * what makes the reading unmissable.
       */
      verifiedBy?: Verification
    }
  | { kind: "failed"; why: string }
  /** No `end` record, and nobody says the run is live: the server died. */
  | { kind: "interrupted"; resumeFrom: RunPhase }
