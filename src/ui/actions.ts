/**
 * The write operations `App.tsx` offers, as hooks that own their own state.
 *
 * This is what "extract to a service" means in React, and why it is worth
 * doing here rather than inventing a service layer: `App` held **fourteen**
 * pieces of `useState` and ten handlers in one 889-line function, and they
 * clustered into groups that never touch each other. A custom hook is exactly
 * a service - it owns some state and the operations on it, and the component
 * consumes an interface - with the difference that React already knows how to
 * schedule one and `test/ui/useRun.test.tsx` already shows how to test one
 * without a DOM.
 *
 * Each hook here keeps the rule that made its state worth isolating:
 *
 * - **A refusal belongs where the human still has the context to read it.**
 *   Removing a task can be refused because a run is in flight, because the ref
 *   is on two lines, or because the file moved - all of which name the task, so
 *   the message stays on the dialog rather than going to the page behind it.
 * - **A selection cannot outlive the task it names.** `runIdFor` keeps
 *   resolving a task from the run index after the row is gone, so a removal
 *   that was the subject of the centre column clears it.
 * - **Drafting a file is slow and visible.** Its `busy` is separate from every
 *   other busy flag, because the screen says "an agent is reading the
 *   repository" and that sentence must not appear for a budget edit.
 */

import { useCallback, useState } from "react"

import { draftFeature, removeTask } from "./live.ts"
import type { TaskId } from "./Tree.tsx"

/** A message for the human, or `null` while it is going well. */
export type Failure = string | null

function reason(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** The task a removal has been asked about. */
export interface PendingRemoval {
  projectPath: string
  featureFile: string
  taskRef: string
}

export interface TaskRemoval {
  /** The task awaiting confirmation, or `null`. Drives the dialog. */
  pending: PendingRemoval | null
  error: Failure
  busy: boolean
  /** Opens the confirmation. Asks; never removes. */
  ask: (task: PendingRemoval) => void
  /** Closes it, removing nothing. */
  cancel: () => void
  /** Removes it, and clears the selection when it was the task on screen. */
  confirm: () => Promise<void>
}

/**
 * Removing one task, confirmed first.
 *
 * Confirmed rather than done on the click, because it edits a file in the
 * user's own repository and the row it came from is one of a dozen a few pixels
 * apart. `ProjectPanel` confirms removing a project for the same reason and in
 * the same shape.
 */
export function useTaskRemoval(
  reload: () => void,
  selected: TaskId | null,
  setSelected: (task: TaskId | null) => void,
): TaskRemoval {
  const [pending, setPending] = useState<PendingRemoval | null>(null)
  const [error, setError] = useState<Failure>(null)
  const [busy, setBusy] = useState(false)

  const ask = useCallback((task: PendingRemoval) => {
    setError(null)
    setPending(task)
  }, [])

  const cancel = useCallback(() => {
    setPending(null)
    setError(null)
  }, [])

  const confirm = useCallback(async (): Promise<void> => {
    if (pending === null || busy) return
    setBusy(true)
    setError(null)
    try {
      await removeTask(pending)
      /* The selection goes with the task. A row the tree no longer draws
         cannot stay the subject of the centre column, and `runIdFor` would keep
         resolving it from the run index after the task that named it is gone. */
      if (
        selected?.projectPath === pending.projectPath &&
        selected.featureFile === pending.featureFile &&
        selected.taskRef === pending.taskRef
      ) {
        setSelected(null)
      }
      setPending(null)
      reload()
    } catch (cause) {
      /* Kept on the dialog, not the page: every refusal this can hit names the
         task - a run in flight, a ref on two lines, a file that moved - and the
         dialog is where the human still has the context to read it. */
      setError(reason(cause))
    } finally {
      setBusy(false)
    }
  }, [busy, pending, reload, selected, setSelected])

  return { pending, error, busy, ask, cancel, confirm }
}

export interface NewTaskFile {
  /** What the human has typed. The card is open when this hook is in use. */
  text: string
  setText: (text: string) => void
  error: Failure
  busy: boolean
  /** Drafts and writes it. Resolves `true` when a file was written. */
  create: (projectPath: string) => Promise<boolean>
  /** Forgets what was typed, for leaving the card. */
  reset: () => void
}

/**
 * Drafting a **new** task file from a sentence.
 *
 * Its own `busy`, separate from every other one, because the screen says "an
 * agent is reading the repository and drafting the tasks" while this runs - and
 * that sentence must not appear because somebody edited a cost ceiling.
 *
 * `create` answers whether a file was written, so the caller can close its card
 * on success and leave it open with the message on a refusal, without reading
 * `error` to infer which happened.
 */
export function useNewTaskFile(reload: () => void): NewTaskFile {
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Failure>(null)

  const reset = useCallback(() => {
    setText("")
    setError(null)
  }, [])

  const create = useCallback(
    async (projectPath: string): Promise<boolean> => {
      const described = text.trim()
      if (described === "" || busy) return false
      setBusy(true)
      setError(null)
      try {
        await draftFeature(projectPath, described)
        setText("")
        /* The tree is where the new file appears, and nothing else refetches
           on its own. */
        reload()
        return true
      } catch (cause) {
        setError(reason(cause))
        return false
      } finally {
        setBusy(false)
      }
    },
    [busy, reload, text],
  )

  return { text, setText, error, busy, create, reset }
}
