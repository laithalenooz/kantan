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

import { useCallback, useEffect, useRef, useState } from "react"

import { draftFeature, fetchAccounts, removeTask, runTestCommand, startRun, updateProject } from "./live.ts"
import type { AccountUsage } from "./live.ts"
import type { TestRun } from "./AddRepo.tsx"
import type { AccountOption } from "./ProjectPanel.tsx"
import type { AdvancedSettings } from "./Tree.tsx"
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


export interface ProjectSettings {
  /** The last refusal, for the alert the page shows. */
  error: Failure
  clearError: () => void
  switchAccount: (path: string, account: AccountOption) => Promise<void>
  saveTestCmd: (path: string, testCmd: string | null) => Promise<void>
  saveAdvanced: (path: string, change: Partial<AdvancedSettings>) => Promise<void>
  saveBudget: (path: string, budgetUsd: number) => Promise<void>
  /** For the two callers that write the store themselves: registering a
   *  repository and removing one. Same refetch, same error surface. */
  guard: (work: () => Promise<void>) => Promise<void>
}

/**
 * Every edit to a project's stored settings, behind one refusal surface.
 *
 * Six operations that differ only in which keys they PATCH, so they shared a
 * `guard` even before this hook existed - which is what marked them as one
 * cluster. The guard is the whole point: **refetch on success, keep the
 * server's own sentence on failure.** `PATCH /api/projects` names the field it
 * refused, and rewording that here would lose the one detail the human needs.
 *
 * `switchAccount` sends the folder as well as the word, and the comment it
 * carries is the defect it was written to fix: `account` is only a label.
 * `src/spawn.ts` sets `CLAUDE_CONFIG_DIR` from `configDir`, so a PATCH with the
 * word alone moved the chip and kept billing the same profile.
 */
export function useProjectSettings(reload: () => void): ProjectSettings {
  const [error, setError] = useState<Failure>(null)

  const guard = useCallback(
    async (work: () => Promise<void>): Promise<void> => {
      setError(null)
      try {
        await work()
        reload()
      } catch (cause) {
        setError(reason(cause))
      }
    },
    [reload],
  )

  return {
    error,
    clearError: useCallback(() => setError(null), []),
    guard,
    switchAccount: useCallback(
      async (path, account) =>
        /* The folder as well as the word. `account` is only a label; nothing
           reads it to decide what gets billed. `null` is how an option with no
           folder sends the project back to the default profile. */
        await guard(() => updateProject(path, { account: account.kind, configDir: account.configDir ?? null })),
      [guard],
    ),
    saveTestCmd: useCallback(
      async (path, testCmd) => await guard(() => updateProject(path, { testCmd })),
      [guard],
    ),
    saveAdvanced: useCallback(
      async (path, change) =>
        /* Straight through: the route is a partial update and the store
           validates every field by name, so the one thing this must not do is
           fill in keys the human did not touch. */
        await guard(() => updateProject(path, change)),
      [guard],
    ),
    saveBudget: useCallback(
      async (path, budgetUsd) => await guard(() => updateProject(path, { budgetUsd })),
      [guard],
    ),
  }
}

export interface RunStart {
  /** Run ids started in this session, by task key: addressable before the
   *  tree has been re-read, so the fresh id wins over its older answer. */
  started: Readonly<Record<string, string>>
  /** A refusal with nothing else to offer. */
  error: Failure
  /**
   * The prose of a dirty-tree refusal, held apart from `error`.
   *
   * It is the one refusal with a **second thing to offer** - start anyway - so
   * it drives a card rather than an alert. `src/git.ts` writes it, naming the
   * files and explaining why `git stash` without `-u` leaves you hitting it
   * again, and it is reproduced rather than summarised because which files are
   * dirty is the one thing the human needs exact.
   */
  dirtyRefusal: string | null
  dismissDirty: () => void
  /** Rethrows after recording, which `StartPanel` needs: it shows "the agent is
   *  reading your repo" until its promise settles. */
  start: (task: { projectPath: string; featureFile: string; taskRef: string; key: string }, allowDirty?: boolean) => Promise<void>
}

/** Starting a run, and the two refusals that read differently. */
export function useRunStart(): RunStart {
  const [started, setStarted] = useState<Record<string, string>>({})
  const [error, setError] = useState<Failure>(null)
  const [dirtyRefusal, setDirtyRefusal] = useState<string | null>(null)

  const start = useCallback(
    async (task: { projectPath: string; featureFile: string; taskRef: string; key: string }, allowDirty = false): Promise<void> => {
      setError(null)
      if (!allowDirty) setDirtyRefusal(null)
      try {
        const id = await startRun({
          projectPath: task.projectPath,
          featureFile: task.featureFile,
          taskRef: task.taskRef,
          ...(allowDirty ? { allowDirty: true } : {}),
        })
        setDirtyRefusal(null)
        setStarted((prior) => ({ ...prior, [task.key]: id }))
      } catch (cause) {
        const message = reason(cause)
        // A dirty tree is the one refusal with a second thing to offer, so it
        // is held apart from the generic alert rather than only shouted.
        if (message.includes("uncommitted changes")) setDirtyRefusal(message)
        else setError(message)
        // Rethrown, not swallowed: `StartPanel` shows "Planning. The agent is
        // reading your repo." until its promise settles, and resolving on a
        // refusal leaves that sentence on screen forever.
        throw cause
      }
    },
    [],
  )

  return { started, error, dirtyRefusal, start, dismissDirty: useCallback(() => setDirtyRefusal(null), []) }
}


export interface RepoTrial {
  /** The phase `AddRepo` draws. `idle` until someone presses the button. */
  run: TestRun
  /** Tries `cmd` in `projectPath`. Fire and forget: the phase is the answer. */
  start: (projectPath: string, cmd: string) => void
  /** Back to `idle`, for when the panel closes. */
  reset: () => void
}

/**
 * Trying a test command once, from the add-repository panel.
 *
 * This is what wires "Run it once", which was drawn, documented and inert
 * because `POST /api/test` required a *registered* project - and the premise of
 * that screen is that the project is not saved yet. The route now accepts an
 * unregistered path that passes the same two gates registration uses.
 *
 * Two things this hook owes the screen:
 *
 * - **A refusal is a phase, not an exit code.** `runTestCommand` throws on a
 *   409 or a 400 rather than folding it into an outcome, because a run in
 *   flight and a command that could not start are not test results. Swallowing
 *   one would leave a button that looks dead; inventing a code for one would
 *   claim a verification nobody observed.
 * - **Only the newest attempt may write.** Someone can press this twice, and
 *   the first answer arriving after the second click would replace a running
 *   spinner with a finished result for a command they have moved on from.
 *   `TestOutcome` already hides a result whose `cmd` is not the one in the
 *   field, which covers an edited command but not two clicks on the same one -
 *   so the attempt is counted and a stale resolution is dropped.
 */
export function useRepoTrial(): RepoTrial {
  const [run, setRun] = useState<TestRun>({ phase: "idle" })
  /** Which attempt is current. Compared, never rendered. */
  const attempt = useRef(0)

  const start = useCallback((projectPath: string, cmd: string): void => {
    const mine = ++attempt.current
    setRun({ phase: "running", cmd })
    void (async () => {
      try {
        const answer = await runTestCommand({ projectPath, testCmd: cmd })
        if (attempt.current !== mine) return
        /* `answer.summary` carries its own provenance, so the panel can label
           a model's sentence as the agent's. Dropping `by` here would render
           model prose beside a measured exit code with nothing to say which
           was which - which is the overclaim this project does not make. */
        setRun({
          phase: "done",
          cmd,
          exitCode: answer.exitCode,
          ...(answer.summary.text === "" ? {} : { summary: answer.summary.text, summaryBy: answer.summary.by }),
        })
      } catch (cause) {
        if (attempt.current !== mine) return
        setRun({ phase: "refused", cmd, why: reason(cause) })
      }
    })()
  }, [])

  const reset = useCallback((): void => {
    // Bumped as well, or an answer in flight would arrive into the next
    // panel's idle state and show a result nobody asked for.
    attempt.current++
    setRun({ phase: "idle" })
  }, [])

  return { run, start, reset }
}

export interface Accounts {
  accounts: AccountUsage[] | null
  /** Profiles on disk kantan has not been told about. `[]` until the first
   *  answer, and `[]` from a server too old to report any. */
  found: string[]
  error: Failure
  /** Refetches now. The button beside the list, and what the poll calls. */
  refresh: () => void
  /** A refetch is in flight, so the control can say so rather than look dead. */
  busy: boolean
}

/**
 * How often the list refetches while it is on screen.
 *
 * Ten seconds, and the figure is a judgement about what "real time" can mean
 * here rather than a default. A rate-limit reading only changes when a run
 * emits one, so between runs a faster poll reads the same bytes more often. A
 * live run emits them every few turns, and ten seconds is inside that. The
 * cost of each poll is reading the tail of a few log files.
 */
const POLL_MS = 10_000

/**
 * The accounts list, refetched while it is open.
 *
 * Polled rather than streamed, deliberately. `GET /api/runs/:id/stream` carries
 * `rate_limit_event` for **one** run, and this list is about every account -
 * including the ones nothing is running on, whose figures change only when the
 * window resets. A poll is the honest shape for "re-read a derived answer",
 * and it stops when the panel closes rather than holding a connection for a
 * screen nobody is looking at.
 */
export function useAccounts(open: boolean): Accounts {
  const [accounts, setAccounts] = useState<AccountUsage[] | null>(null)
  const [found, setFound] = useState<string[]>([])
  const [error, setError] = useState<Failure>(null)
  const [busy, setBusy] = useState(false)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!open) return
    let alive = true
    const read = async (): Promise<void> => {
      setBusy(true)
      try {
        const got = await fetchAccounts()
        if (alive) {
          setAccounts(got.accounts)
          setFound(got.found)
          setError(null)
        }
      } catch (cause) {
        /* The previous answer stays on screen beside the message: a reading
           that was true a minute ago is more use than an empty list, and
           blanking it would make a dropped poll look like "no accounts". */
        if (alive) setError(reason(cause))
      } finally {
        if (alive) setBusy(false)
      }
    }
    void read()
    const timer = setInterval(() => void read(), POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [open, nonce])

  return { accounts, found, error, busy, refresh: useCallback(() => setNonce((n) => n + 1), []) }
}
