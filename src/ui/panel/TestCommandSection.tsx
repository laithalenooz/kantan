/**
 * The test command, and proving it works before trusting it.
 *
 * Two states behind one heading, and which one shows is read through
 * `commandOf` rather than `testCmd === null`: a stored `""` is "no command"
 * too, because `sh -c ""` exits 0 and a pass from nothing is the one answer no
 * reader could tell from a real one.
 *
 * `readOutcome` is why this file is worth opening: an exit code is reported as
 * the number it is, and the artboard's shield is drawn **only** on a zero. A
 * tick beside `exit 1` would be the exact defect the exit code exists to
 * prevent.
 */

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactElement } from "react"

import { BLURB, H2, LINE, PILL_GHOST, SECTION, messageOf, seconds } from "./chrome.tsx"
import { SELF_CHECKED, commandOf } from "../testcmd.ts"
import type { TestCommandResult } from "../ProjectPanel.tsx"

/* -------------------------------------------------------------------------- */

export interface TestRunState {
  phase: "idle" | "running" | "done"
  /** The command the result belongs to, so a stale answer can be recognised. */
  cmd: string
  result?: TestCommandResult
}

/** What a result reads as. Only a zero code may read as a pass. */
export function readOutcome(result: TestCommandResult): { reads: string; outcome: "pass" | "fail" | "unknown" } {
  if (typeof result.exitCode === "number" && Number.isFinite(result.exitCode)) {
    return { reads: `exit ${result.exitCode}`, outcome: result.exitCode === 0 ? "pass" : "fail" }
  }
  if (result.timedOut === true) return { reads: "timed out", outcome: "fail" }
  if (typeof result.signal === "string" && result.signal !== "") {
    return { reads: `killed by ${result.signal}`, outcome: "fail" }
  }
  /* No code and no reason. "unknown" rather than "fail": the command may have
     run fine and the server may simply not have said, and inventing either
     verdict is the thing exit codes exist to prevent. */
  return { reads: "no exit code", outcome: "unknown" }
}

export const BADGE_LOOK: Record<"pass" | "fail" | "unknown", CSSProperties> = {
  pass: { background: "#0F8A5F", color: "#fff" },
  fail: { background: "#D92D3A", color: "#fff" },
  unknown: { background: "#F1F1F4", color: "#3A3D45" },
}

/**
 * Two states behind one heading, and which one shows is read through
 * `commandOf` rather than `testCmd === null`.
 *
 * With a command: the field, and a blurb promising kantan reads an exit code.
 * Without one: no field at all, and the sentence that says so. An empty field
 * behind a `$` is the defect this avoids - it reads as a command that failed
 * to load, under a promise that is false for this project.
 *
 * The transitions between them are deliberate in both directions:
 *
 * - **Blank is refused when a command exists.** `sh -c ""` exits 0, so saving
 *   one would tick every task as tested with nothing run. The message names
 *   the opt-out instead, and only when something can take it.
 * - **Blank is not an error when there is none.** Nothing was required, the
 *   human changed nothing, and the field simply closes again.
 */
export function TestCommandSection({
  testCmd,
  anim,
  animate,
  onSaveTestCmd,
  onClearTestCmd,
  onRunTest,
}: {
  testCmd: string | null
  anim: (classes: string) => string | undefined
  animate: boolean
  onSaveTestCmd: (cmd: string) => void | Promise<void>
  onClearTestCmd?: () => void | Promise<void>
  onRunTest?: (cmd: string) => Promise<TestCommandResult>
}): ReactElement {
  const stored = commandOf(testCmd)
  const [draft, setDraft] = useState(stored ?? "")
  const [saved, setSaved] = useState(stored ?? "")
  const [error, setError] = useState<string | null>(null)
  const [run, setRun] = useState<TestRunState>({ phase: "idle", cmd: stored ?? "" })
  /** The human asked for a field on a project that has no command yet. */
  const [opening, setOpening] = useState(false)
  /**
   * The opt-out this panel took and the handler accepted, before the props it
   * came from have been refetched.
   *
   * Local because the handler's success is the event: `project.testCmd` is a
   * copy of the store fetched by whatever mounted this, and waiting for it to
   * come back `null` would leave the panel printing a command the store no
   * longer has. Cleared by the effect below the moment the props do change.
   */
  const [optedOut, setOptedOut] = useState(false)
  const [clearing, setClearing] = useState(false)
  /** Monotonic, so an answer from an abandoned request can be dropped. */
  const ticket = useRef(0)
  const field = useRef<HTMLInputElement>(null)

  /* The stored command is the truth; a reload that changes it wins over a
     draft nobody committed, over a field nobody filled, and over an opt-out
     this panel is still holding optimistically. */
  useEffect(() => {
    const fresh = commandOf(testCmd)
    setDraft(fresh ?? "")
    setSaved(fresh ?? "")
    setOpening(false)
    setOptedOut(false)
    setError(null)
    ticket.current += 1
    setRun({ phase: "idle", cmd: fresh ?? "" })
  }, [testCmd])

  useEffect(() => {
    if (opening) field.current?.focus()
  }, [opening])

  /** What this project has as far as this panel can tell right now. */
  const command = optedOut ? null : stored
  /** Whether the field is on screen: there is a command, or one is being typed. */
  const open = command !== null || opening

  const blankRefusal = (): string =>
    onClearTestCmd === undefined
      ? 'A blank command is not an opt-out. `sh -c ""` exits 0, so kantan would tick every task as tested with nothing run.'
      : 'A blank command is not an opt-out. `sh -c ""` exits 0, so kantan would tick every task as tested with nothing run. Use "Remove the test command" to say this project has no suite.'

  const commit = (): void => {
    const trimmed = draft.trim()
    if (trimmed === "") {
      /* Nothing was required and nothing changed, so there is nothing to
         refuse: the field closes and the section says what it said before. */
      if (command === null) {
        setOpening(false)
        setDraft("")
        setError(null)
        return
      }
      setError(blankRefusal())
      return
    }
    setError(null)
    if (trimmed === saved) return
    setSaved(trimmed)
    void (async () => {
      try {
        await onSaveTestCmd(trimmed)
      } catch (cause) {
        setError(messageOf(cause))
      }
    })()
  }

  const clear = (): void => {
    if (onClearTestCmd === undefined || clearing) return
    setError(null)
    setClearing(true)
    void (async () => {
      try {
        await onClearTestCmd()
        /* Only now. A refused PATCH that had already blanked the field would
           leave the panel claiming this project has no suite while the store
           still has a command - the mirror of claiming a verification nobody
           observed. */
        setOptedOut(true)
        setOpening(false)
        setDraft("")
        setSaved("")
        ticket.current += 1
        setRun({ phase: "idle", cmd: "" })
      } catch (cause) {
        setError(messageOf(cause))
      } finally {
        setClearing(false)
      }
    })()
  }

  const go = (): void => {
    if (onRunTest === undefined) return
    const cmd = draft.trim()
    if (cmd === "") return
    const mine = ++ticket.current
    setError(null)
    setRun({ phase: "running", cmd })
    void (async () => {
      try {
        const result = await onRunTest(cmd)
        /* Dropped, not shown: this answer is about a command the field no
           longer holds, and a result attributed to the wrong command is worse
           than no result. */
        if (mine !== ticket.current) return
        setRun({ phase: "done", cmd, result })
      } catch (cause) {
        if (mine !== ticket.current) return
        setRun({ phase: "idle", cmd })
        setError(messageOf(cause))
      }
    })()
  }

  const read = run.phase === "done" && run.result !== undefined ? readOutcome(run.result) : null
  const took = seconds(run.result?.durationMs)

  return (
    <div style={SECTION} className={anim("bf d2")}>
      {/* A `for` that names an input which is not on screen points at nothing,
          so the heading is only a label while the field exists. */}
      {open ? (
        <label htmlFor="kp-testcmd" style={{ display: "block", ...H2 }}>
          Test command
        </label>
      ) : (
        <h3 style={H2}>Test command</h3>
      )}
      <p style={BLURB}>
        {open ? (
          <>kantan runs this itself and trusts only its exit code. It never takes the agent&rsquo;s word for it.</>
        ) : (
          <>
            This project has none, so a fresh agent verifies its own work and the run records that nothing
            outside it checks the result.
          </>
        )}
      </p>

      {!open && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          <span
            data-test-cmd
            className="m"
            style={{
              flex: "1 1 260px",
              display: "flex",
              alignItems: "center",
              minHeight: 46,
              padding: "0 14px",
              borderRadius: 12,
              background: "#F4F4F6",
              fontSize: 13.5,
              color: "#5F6370",
              boxSizing: "border-box",
            }}
          >
            {SELF_CHECKED}
          </span>
          <button
            type="button"
            onClick={() => {
              setOpening(true)
              setError(null)
            }}
            className={PILL_GHOST}
            style={{
              height: 46,
              padding: "0 16px",
              borderRadius: 999,
              border: "1px solid #D9D9DF",
              background: "#fff",
              fontSize: 14,
              fontWeight: 560,
              color: "#1E2026",
            }}
          >
            Set a test command
          </button>
        </div>
      )}

      {open && (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <span
          className="fld"
          style={{
            flex: "1 1 260px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            minHeight: 46,
            padding: "0 14px",
            borderRadius: 12,
            border: "1px solid #E2E2E7",
            background: "#fff",
            boxSizing: "border-box",
          }}
        >
          <span className="m" style={{ color: "#8A8F9C" }}>
            $
          </span>
          <input
            id="kp-testcmd"
            ref={field}
            className="m"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              /* A result is about a command string. Editing it makes the
                 result meaningless, so it goes rather than lingering beside a
                 command it never ran. */
              ticket.current += 1
              setRun({ phase: "idle", cmd: e.target.value })
              setError(null)
            }}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                commit()
              }
            }}
            style={{
              border: 0,
              outline: "none",
              background: "transparent",
              width: "100%",
              fontSize: 14,
              color: "#111216",
            }}
          />
        </span>
        {onRunTest !== undefined && draft.trim() !== "" && (
          <button
            type="button"
            onClick={go}
            disabled={run.phase === "running"}
            className={PILL_GHOST}
            style={{
              height: 46,
              padding: "0 16px 0 14px",
              borderRadius: 999,
              border: "1px solid #D9D9DF",
              background: "#fff",
              fontSize: 14,
              fontWeight: 560,
              color: "#1E2026",
              gap: 8,
            }}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" style={{ width: 12, height: 12, fill: "#1E2026" }}>
              <polygon points="6 3 20 12 6 21 6 3" />
            </svg>
            Run it now
          </button>
        )}
      </div>
      )}

      {/* The consequence sits beside the control rather than arriving after
          the fact, because the opt-out changes what a green run means: from
          here on nothing outside the agent checks it. */}
      {command !== null && onClearTestCmd !== undefined && (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "6px 12px", marginTop: 12 }}>
          <button
            type="button"
            onClick={clear}
            disabled={clearing}
            style={{
              border: 0,
              padding: 0,
              background: "none",
              font: "inherit",
              fontSize: 13.5,
              fontWeight: 560,
              // `#4B4BC8`, the artboard's colour for a text button: "Create a
              // new task file", "Add another account", "Start a new task file
              // instead" are all this. `#5B5BD6` is in the artboards too, but
              // for focus rings and running states rather than for links.
              color: "#4B4BC8",
              cursor: clearing ? "default" : "pointer",
              textDecoration: "underline",
              textUnderlineOffset: 3,
            }}
          >
            Remove the test command
          </button>
          <span style={{ fontSize: 13, lineHeight: 1.5, color: "#5F6370", maxWidth: "58ch" }}>
            Then a fresh agent verifies its own work, and every run records that it was never tested.
          </span>
        </div>
      )}

      {run.phase === "running" && (
        <div
          data-test-status
          role="status"
          className={anim("pop")}
          style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, fontSize: 13.5, color: "#20205E" }}
        >
          <svg
            className={animate ? "spin" : undefined}
            aria-hidden="true"
            viewBox="0 0 24 24"
            style={{ width: 15, height: 15 }}
          >
            <circle cx="12" cy="12" r="9" fill="none" stroke="#DCDCF6" strokeWidth="3" />
            <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="#5B5BD6" strokeWidth="3" strokeLinecap="round" />
          </svg>
          Running{" "}
          <span className="m">{run.cmd}</span>…
        </div>
      )}

      {read !== null && (
        <div
          data-test-status
          role="status"
          className={anim("pop")}
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "8px 10px",
            marginTop: 10,
            fontSize: 13.5,
            color: "#2A2C33",
          }}
        >
          <span
            data-exit-badge
            data-outcome={read.outcome}
            className="m"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "3px 9px",
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 600,
              ...BADGE_LOOK[read.outcome],
            }}
          >
            {/* The artboard's shield-check, and **only** on a zero code.
                `canvas.json` names the chip as "Badge + ShieldCheck", but
                `DESIGN.md` forbids a tick standing in for a code - so a glyph
                that reads "verified" beside `exit 1` would be the exact defect
                the exit code exists to prevent. The number is the content; the
                shield only ever agrees with it. */}
            {read.outcome === "pass" && (
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className="ic"
                style={{ width: 12, height: 12 }}
                {...LINE}
              >
                <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
                <path d="m9 12 2 2 4-4" />
              </svg>
            )}
            {read.reads}
          </span>
          {(run.result?.summary !== undefined || took !== undefined) && (
            <span>
              {[run.result?.summary, took].filter((p): p is string => p !== undefined && p !== "").join(" · ")}
            </span>
          )}
        </div>
      )}

      {error !== null && (
        <p
          role="alert"
          style={{ margin: "10px 0 0", fontSize: 13, lineHeight: 1.5, color: "#D92D3A", maxWidth: "68ch" }}
        >
          {error}
        </p>
      )}
    </div>
  )
}
