import { useCallback, useEffect, useMemo, useState } from "react"
import { Tree, canResume, canStart, type Account, type AdvancedSettings, type TaskId, type TreeProject, type TreeTask } from "./Tree.tsx"
import { Gate, type GateProps } from "./Gate.tsx"
import { Stream } from "./Stream.tsx"
import { Sidebar, sumProcessCost, type AccountWindow } from "./Sidebar.tsx"
import { Digest, ReturnBand, type DigestSubject } from "./Digest.tsx"
import { AppBar, Breadcrumb, NeedsYouBand, usePageAttention } from "./Chrome.tsx"
import { Empty } from "./Empty.tsx"
import { AddRepo, type Detection } from "./AddRepo.tsx"
import { AddTasks } from "./AddTasks.tsx"
import { ProjectPanel, type AccountOption } from "./ProjectPanel.tsx"
import { StartPanel } from "./StartPanel.tsx"
import { act, addTasks, detectPath, draftFeature, proposeTasks, registerProject, removeProject, removeTask, runTestCommand, startRun, summaryOf, taskKeyOf, updateProject, type RunView } from "./live.ts"
import { useAction, usePlan, useRun, useTree } from "./useRun.ts"
import type { RunPhase } from "../runlog.ts"
import type { AskingPhase } from "./Gate.tsx"

/**
 * The shell: tree, run, rail. Three columns, per `docs/design/Main.dc.html`.
 *
 * The four regions were built independently against the artboards; this file is
 * the only place they meet, so the seams between them live here. The data comes
 * from `useRun.ts`, which owns the races, and from `live.ts`, which owns the
 * fold - this file owns only the joins, and every one of them is a decision
 * some type would otherwise have let us make silently.
 */

/**
 * Which conversation an answer goes back into.
 *
 * `park` records the phase that was running, so a question can arrive on any
 * of `plan`, `implement` or `refine`; `AskingPhase` offers only the first two,
 * because a `refine` turn runs **inside the implement conversation** and that
 * is the one `--resume` has to reopen. `gate` and `test` never ask: the gate
 * spawns nothing and the test phase runs the suite, not an agent.
 *
 * So the mapping is total rather than partial, and the default is `implement`
 * because that is where every non-plan turn lives. Getting this wrong is the
 * silent failure design §2 is built around: answering into the planning session
 * runs the reply in the wrong conversation and still exits `success`.
 */
function askingPhase(phase: RunPhase): AskingPhase {
  return phase === "plan" ? "plan" : "implement"
}

/** The run id for a selection, or `null` when that task has never run. */
function runIdFor(runs: Readonly<Record<string, { runId: string }>> | undefined, selected: TaskId | null): string | null {
  if (runs === undefined || selected === null) return null
  const key = taskKeyOf(selected)
  return key === null ? null : (runs[key]?.runId ?? null)
}

function findTask(projects: readonly TreeProject[], selected: TaskId | null): TreeTask | null {
  if (selected === null) return null
  const project = projects.find((p) => p.path === selected.projectPath)
  const feature = project?.features.find((f) => f.path === selected.featureFile)
  return feature?.tasks.find((t) => t.ref === selected.taskRef) ?? null
}

function projectFor(projects: readonly TreeProject[], selected: TaskId | null): TreeProject | null {
  if (selected === null) return null
  return projects.find((p) => p.path === selected.projectPath) ?? null
}

/**
 * The rings.
 *
 * One window, for the account **this run** bills to, and that is a limitation
 * rather than a choice: a window's `status` and `utilization` only ever arrive
 * on a `rate_limit` event inside some run's log, so a second account's figures
 * live in a log this screen is not reading. Showing a second ring would mean
 * either inventing its numbers or labelling it with the first account's, and
 * `AccountWindow` says plainly that merging two accounts shows a run the wrong
 * limit silently. So the rail shows what it knows.
 *
 * `profile` is passed exactly as the header recorded it - no trimming, no
 * `realpath` - because that field is the account's identity and normalising it
 * would merge two of them.
 */
function windowsFor(view: RunView | null, account: Account | undefined): AccountWindow[] {
  if (view?.header === null || view?.header === undefined) return []
  const label = account?.label ?? (account?.kind === "unknown" ? "account unknown" : (account?.kind ?? "account unknown"))
  return [
    {
      profile: view.header.profile,
      label,
      current: true,
      // `status` is required and only a real event can supply it. "allowed" is
      // the CLI's own word for a window with room, and it is what the rail
      // reads as "nothing to say yet" - the notice keys on the other values.
      status: view.limit?.status ?? "allowed",
      utilization: view.limit?.utilization,
      // Epoch seconds, as the CLI sends and `AccountWindow` expects. Omitted
      // when unknown, which the rail prints as an em dash rather than guessing.
      ...(view.limit?.resetsAt === undefined ? {} : { resetsAtSec: view.limit.resetsAt }),
    },
  ]
}

/** "asked at 18:22 · 9 min ago", as the card's `askedAt` expects. */
function askedLabel(atMs: number, nowMs: number): string {
  const clock = new Date(atMs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  const mins = Math.floor((nowMs - atMs) / 60_000)
  if (mins < 1) return `asked at ${clock} · just now`
  return `asked at ${clock} · ${mins} min ago`
}

/**
 * How many tasks across the whole tree are waiting on a human.
 *
 * Counted here because that is where the whole tree is. `ReturnBand` refuses to
 * say "Nothing needs you" when this is `undefined`, and the asymmetry is the
 * reason: a false "nothing needs you" sends the user away from a run that is
 * parked, which is the one failure the band exists to prevent. So a tree that
 * has not loaded yields `undefined`, not `0`.
 *
 * `stalled` is deliberately excluded. It is its own state with its own plum
 * treatment, and `src/run.ts` parks a stalled run without a question
 * outstanding - counting it would make the band demand attention that no gate
 * is waiting for.
 */
function countNeedsYou(projects: readonly TreeProject[]): number | undefined {
  if (projects.length === 0) return undefined
  let waiting = 0
  for (const project of projects) {
    for (const feature of project.features) {
      for (const task of feature.tasks) {
        const state = task.run?.state
        if (state?.kind === "waiting" && state.reason !== "stalled") waiting += 1
      }
    }
  }
  return waiting
}

/** The repo's own directory name, as the tree shows it. */
function repoName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path
}

/** How many tasks a project holds, across all of its task files. */
function taskCount(project: TreeProject): string {
  const n = project.features.reduce((sum, f) => sum + f.tasks.length, 0)
  return `${n} ${n === 1 ? "task" : "tasks"}`
}

/** The first registered project that has no task file, or `null`. */
function emptyProjectOf(projects: readonly TreeProject[]): TreeProject | null {
  return projects.find((p) => p.features.length === 0) ?? null
}

/** The line under the log saying what the run is doing, per both artboards. */
function footerFor(view: RunView | null): string | null {
  if (view === null) return null
  if (view.ended !== null) {
    const why = view.ended.why === undefined ? "" : ` · ${view.ended.why}`
    return view.ended.state === "done" ? "Done" : `Failed${why}`
  }
  /* Before the park, for the reason `runindex.ts`'s `finish` gives at length: a
     run can be stopped while parked, and then "waiting until you decide" asks
     someone to decide something no process is listening for. */
  if (view.stopped) {
    const at = view.phases.find((p) => p.state === "running")
    return at === undefined
      ? "Stopped · resumable, and stopping cost nothing"
      : `Stopped at ${at.phase} · resumable, and stopping cost nothing`
  }
  if (view.waiting !== null) {
    switch (view.waiting.reason) {
      case "gate":
        return "Gate · run paused until you decide"
      case "question":
        return "Question · waiting for your answer"
      case "blocked":
        // The prose carries the figures and the instruction to raise, and it is
        // the only place they exist: nothing else in the log holds it.
        return view.waiting.detail ?? "Blocked · waiting for you"
      case "stalled":
        return view.waiting.detail ?? "Stalled · the same failure three times"
    }
  }
  const running = view.phases.find((p) => p.state === "running")
  return running === undefined ? null : `${running.phase} · running`
}

/**
 * A clock that ticks once a minute.
 *
 * The shell owns it because a parked run emits no events for minutes, so
 * anything deriving "9 min ago" from incoming data freezes at the last event
 * and quietly understates how long the human has been away.
 */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])
  return now
}





/**
 * What the centre column shows instead of a run.
 *
 * One value, not four booleans. The design says each of these *replaces* the
 * centre column, so two being open at once is a state that should not be
 * representable - and dialogs are for confirmations only, which leaves exactly
 * one, inside `ProjectPanel`.
 */
type Panel =
  | { kind: "addRepo" }
  | { kind: "addTasks"; projectPath: string; featureFile: string }
  /** A **new** task file, for work none of the project's files is about. */
  | { kind: "newTaskFile"; projectPath: string }
  | { kind: "project"; path: string }
  | null

export function App() {
  const { tree, origin, error: treeError, reload } = useTree()
  const [panel, setPanel] = useState<Panel>(null)
  const [projectError, setProjectError] = useState<string | null>(null)
  const [repoPath, setRepoPath] = useState("")
  const [detection, setDetection] = useState<Detection>({ phase: "idle" })
  const nowMs = useNow()
  const [selected, setSelected] = useState<TaskId | null>(null)
  const [started, setStarted] = useState<Record<string, string>>({})
  const [startError, setStartError] = useState<string | null>(null)

  const projects = tree?.projects ?? []
  const selectedKey = selected === null ? null : taskKeyOf(selected)
  // A run started in this session is addressable before the tree has been
  // re-read, so the freshly minted id wins over the tree's older answer.
  const fresh = selectedKey === null ? undefined : started[selectedKey]
  const runId = fresh ?? runIdFor(tree?.runs, selected)

  const { view } = useRun(runId)
  const atGate = view?.waiting?.reason === "gate"
  const plan = usePlan(runId, atGate)
  const { send, error: actionError } = useAction(runId)

  const task = findTask(projects, selected)
  const project = projectFor(projects, selected)

  /**
   * The uncommitted files a dirty refusal named, so the retry can be offered.
   *
   * `null` means no refusal is outstanding. The prose comes from `src/git.ts`
   * and already lists the files and says why `git stash` without `-u` leaves
   * you hitting it again - it is reproduced rather than summarised, because a
   * summary of which files are dirty is the one thing the human needs exact.
   */
  const [dirtyRefusal, setDirtyRefusal] = useState<string | null>(null)

  const onStart = useCallback(
    async (allowDirty = false): Promise<void> => {
      if (selected === null || selected.taskRef === null || selectedKey === null) return
      setStartError(null)
      if (!allowDirty) setDirtyRefusal(null)
      try {
        const id = await startRun({
          projectPath: selected.projectPath,
          featureFile: selected.featureFile,
          taskRef: selected.taskRef,
          ...(allowDirty ? { allowDirty: true } : {}),
        })
        setDirtyRefusal(null)
        setStarted((prior) => ({ ...prior, [selectedKey]: id }))
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        // A dirty tree is the one refusal with a second thing to offer, so it
        // is held apart from the generic alert rather than only shouted.
        if (message.includes("uncommitted changes")) setDirtyRefusal(message)
        else setStartError(message)
        // Rethrown, not swallowed. `StartPanel` shows "Planning. The agent is
        // reading your repo." until its promise settles, and resolving on a
        // refusal leaves that sentence on screen forever.
        throw cause
      }
    },
    [selected, selectedKey],
  )

  const gate: GateProps | null = useMemo(() => {
    if (view === null || view.waitId === null || view.waiting === null) return null

    if (view.waiting.reason === "gate") {
      // Held until the plan has actually arrived. `PlanSource` has no "loading"
      // variant, and the nearest stand-in - `undictated` - would tell the human
      // this run dictated no plan, which is a different and false statement.
      if (plan === null) return null
      return {
        kind: "gate",
        waitId: view.waitId,
        plan,
        testCommand: project?.testCmd ?? null,
        planDurationMs: view.phases.find((p) => p.phase === "plan")?.elapsedMs,
        // What the run has spent, which the gate prints beside the duration.
        // `sumProcessCost` takes the last result of each process because cost
        // accumulates within one and resets between them.
        costUsd: sumProcessCost(view.processes),
        ...(view.planFilesRead.length === 0 ? {} : { filesRead: view.planFilesRead }),
        onApprove: () => send({ kind: "approve" }),
        onFeedback: (text: string) => send({ kind: "feedback", text }),
      }
    }

    if (view.waiting.reason === "question") {
      // The card prints the agent's own words, and `detail` is where `park` put
      // them. With none recorded there is nothing to quote, so the footer says
      // the run is waiting and no card claims to know what it asked.
      if (view.waiting.detail === null) return null
      const asked = view.phases.find((p) => p.state === "waiting")?.phase ?? "implement"
      return {
        kind: "question",
        waitId: view.waitId,
        phase: askingPhase(asked),
        question: view.waiting.detail,
        // Preformatted, because the card takes a string and the clock is the
        // shell's. Omitted when the log predates `PhaseRecord.at` rather than
        // printing a time the run never recorded.
        ...(view.waiting.sinceMs === null ? {} : { askedAt: askedLabel(view.waiting.sinceMs, nowMs) }),
        onAnswer: (text: string) => send({ kind: "answer", text }),
      }
    }

    // `blocked` and `stalled` have no card in the design: they are a notice
    // under the log, which `footerFor` writes.
    return null
  }, [view, plan, project, send, nowMs])

  const needsYou = countNeedsYou(projects)

  /**
   * What the band and the digest are about.
   *
   * `state` comes from the **tree**, not from the fold, and that is deliberate:
   * `RunState`'s `done` variant carries `merged`, which only `isMergedIntoBase`
   * can answer - the log cannot. Taking it from the log would mean guessing,
   * and `runindex.ts` is explicit that a `done` run read as merged lets a
   * second run start against work that is not integrated.
   */
  const subject: DigestSubject | null =
    task?.run === undefined || selected?.taskRef == null
      ? null
      : {
          state: task.run.state,
          taskRef: selected.taskRef,
          ...(task.text === "" ? {} : { title: task.text }),
          ...(project === null ? {} : { project: project.path.split("/").at(-1) ?? project.path }),
        }

  /* The single writer of `document.title` and the favicon. `ReturnBand`
     deliberately refuses both so there cannot be two. */
  usePageAttention({ subject, needsYou })

  /* The rail is only drawn for a run, so its column must not be reserved when
     there is none: 16.25rem of empty grid leaves the centre too narrow for the
     empty state's two-column hero, which then stacks below the fold. */
  const showRail = view !== null && view.ceilingUsd !== null
  const nothingSelected =
    treeError === null && tree !== null && projects.length > 0 && selected === null && panel === null
  /**
   * A registered project with no task file at all.
   *
   * Shown even with nothing selected, because there is nothing in that project
   * to select - the tree renders the repo and then stops, which reads as a
   * broken app rather than as a repo that has not been given any work.
   */
  const emptyProject = emptyProjectOf(projects)
  /**
   * The project the centre is about: one the user opened, or - when they have
   * opened nothing and a project has no work in it at all - that one, because
   * there is nothing in the column to click and the app would otherwise look
   * broken.
   */
  const panelProject =
    panel?.kind === "project" ? (projects.find((p) => p.path === panel.path) ?? null) : null
  const noProjects = treeError === null && tree !== null && projects.length === 0 && panel === null

  /**
   * The accounts to choose between, derived from what is registered.
   *
   * An account IS a profile directory: `src/spawn.ts` sets
   * `CLAUDE_CONFIG_DIR` from `configDir` and `src/run.ts` records the run's
   * profile from it, while `account` is only the chip's word. So the options
   * are the distinct `configDir`s across the tree plus the default profile,
   * and switching carries the directory - not the label - or it changes
   * nothing at all.
   */
  const accountOptions: AccountOption[] = useMemo(() => {
    const byKey = new Map<string, AccountOption>()
    byKey.set("", { kind: "personal", label: "default profile" })
    for (const p of projects) {
      if (p.account.kind === "personal" || p.account.kind === "work") {
        const label = p.account.label ?? p.account.kind
        byKey.set(label, { kind: p.account.kind, label })
      }
    }
    return [...byKey.values()]
  }, [projects])

  const guard = useCallback(async (work: () => Promise<void>): Promise<void> => {
    setProjectError(null)
    try {
      await work()
      reload()
    } catch (cause) {
      setProjectError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [reload])

  const onSwitchAccount = useCallback(
    async (path: string, account: AccountOption): Promise<void> => {
      /* The profile as well as the word, and the comment that used to sit here
         claiming so was the whole defect: `account` is only a label.
         `src/spawn.ts` sets `CLAUDE_CONFIG_DIR` from `configDir` and `src/run.ts`
         keys the rate-limit window on it, so a PATCH carrying the word alone
         moved the chip and kept billing the same profile - the one thing the
         confirmation exists to prevent. `null` is how an option with no folder
         sends the project back to the default one. */
      await guard(() =>
        updateProject(path, { account: account.kind, configDir: account.configDir ?? null }),
      )
    },
    [guard],
  )

  const onSaveTestCmd = useCallback(
    async (path: string, testCmd: string | null): Promise<void> => await guard(() => updateProject(path, { testCmd })),
    [guard],
  )

  const onSaveAdvanced = useCallback(
    async (path: string, change: Partial<AdvancedSettings>): Promise<void> =>
      /* Straight through: `PATCH /api/projects` is a partial update and the
         store validates every field by name, so the one thing this layer must
         not do is fill in the keys the human did not touch. */
      await guard(() => updateProject(path, change)),
    [guard],
  )

  const onSaveBudget = useCallback(
    async (path: string, budgetUsd: number): Promise<void> => await guard(() => updateProject(path, { budgetUsd })),
    [guard],
  )

  /**
   * The task a removal has been asked about, or `null`.
   *
   * Confirmed rather than done on the click, because it edits a file in the
   * user's own repository and the row it came from is one of a dozen a few
   * pixels apart. `ProjectPanel` confirms removing a project for the same
   * reason and in the same shape.
   */
  const [removing, setRemoving] = useState<{ projectPath: string; featureFile: string; taskRef: string } | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [removeBusy, setRemoveBusy] = useState(false)

  const confirmRemoveTask = useCallback(async (): Promise<void> => {
    if (removing === null || removeBusy) return
    setRemoveBusy(true)
    setRemoveError(null)
    try {
      await removeTask(removing)
      /* The selection goes with the task. A row the tree no longer draws
         cannot stay the subject of the centre column, and `runIdFor` would
         keep resolving it from the run index after the task that named it is
         gone. */
      if (
        selected?.projectPath === removing.projectPath &&
        selected.featureFile === removing.featureFile &&
        selected.taskRef === removing.taskRef
      ) {
        setSelected(null)
      }
      setRemoving(null)
      reload()
    } catch (cause) {
      /* Kept on the dialog, not the page: every refusal this can hit names
         the task - a run in flight, a ref on two lines, a file that moved -
         and the dialog is where the human still has the context to read it. */
      setRemoveError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRemoveBusy(false)
    }
  }, [reload, removeBusy, removing, selected])

  /** What the human typed for a new task file, and how that call is going. */
  const [newFileText, setNewFileText] = useState("")
  const [newFileBusy, setNewFileBusy] = useState(false)
  const [newFileError, setNewFileError] = useState<string | null>(null)

  const createTaskFile = useCallback(
    async (projectPath: string): Promise<void> => {
      const text = newFileText.trim()
      if (text === "" || newFileBusy) return
      setNewFileBusy(true)
      setNewFileError(null)
      try {
        await draftFeature(projectPath, text)
        setPanel(null)
        setNewFileText("")
        /* The tree is where the new file appears, and nothing else refetches
           on its own. */
        reload()
      } catch (cause) {
        setNewFileError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setNewFileBusy(false)
      }
    },
    [newFileBusy, newFileText, reload],
  )

  const onRemoveProject = useCallback(
    async (project: TreeProject): Promise<void> => {
      await guard(async () => {
        await removeProject(project.path)
        setPanel(null)
        if (selected?.projectPath === project.path) setSelected(null)
      })
    },
    [guard, selected],
  )

  /**
   * Refetch the tree when the followed run reaches a new state.
   *
   * The tree's glyphs come from `GET /api/projects`, which was fetched once at
   * mount and after a project edit - and nowhere else. So a run could start,
   * park at a gate and finish while every task in the column still drew the
   * empty circle it had at page load. Reported exactly that way: "all look
   * empty circle even if one is running".
   *
   * Driven by the run's own state rather than a timer. That route folds every
   * run log on the disk - measured at 107-180ms - so polling it would be a
   * steady cost for a thing that changes a handful of times per run. The
   * signature below changes only on a transition a glyph can show: which
   * phases exist and what each is doing, why it is parked, and how it ended.
   * Records arrive constantly and almost all of them leave it identical.
   */
  const runSignature =
    view === null
      ? null
      : [
          runId,
          view.phases.map((p) => `${p.phase}:${p.state}`).join(","),
          view.waiting?.reason ?? "",
          view.ended?.state ?? "",
        ].join("|")

  useEffect(() => {
    if (runSignature === null) return
    reload()
  }, [runSignature, reload])

  /* Debounced in the shell, not the component: one owner holds the string and
     the component keys its answer on the exact bytes it was told about. */
  useEffect(() => {
    if (panel?.kind !== "addRepo" || repoPath.trim() === "") {
      setDetection({ phase: "idle" })
      return
    }
    const asked = repoPath
    setDetection({ phase: "checking", path: asked })
    let live = true
    const id = setTimeout(() => {
      void (async () => {
        const answer = await detectPath(asked)
        if (!live) return
        setDetection(
          answer === null
            ? { phase: "unknown", path: asked, why: "kantan could not check this path from here. Adding it will still be checked properly." }
            : (answer as Detection),
        )
      })()
    }, 350)
    return () => {
      live = false
      clearTimeout(id)
    }
  }, [panel?.kind, repoPath])

  /**
   * Another task in this project that is already holding the run lock.
   *
   * `acquireRunLock` is per repository - one active run per project - so this
   * is computed within the selected project and not across the tree. The
   * state travels with the label because "is running" is a claim the card
   * cannot make from being blocked alone: a run parked at a gate holds the
   * lock and no process.
   */
  const blockedBy = useMemo(() => {
    if (project === null || selected === null) return null
    for (const feature of project.features) {
      for (const other of feature.tasks) {
        if (other.ref === selected.taskRef && feature.path === selected.featureFile) continue
        const state = other.run?.state
        if (state?.kind === "running" || state?.kind === "waiting") {
          return { label: other.ref === null ? other.text : `${other.ref} ${other.text}`, state }
        }
      }
    }
    return null
  }, [project, selected])

  /** The feature file an "add tasks" panel is about. */
  const addTasksFor = useMemo(() => {
    if (panel?.kind !== "addTasks") return null
    const project = projects.find((p) => p.path === panel.projectPath)
    const feature = project?.features.find((f) => f.path === panel.featureFile)
    return project === undefined || feature === undefined ? null : { project, feature }
  }, [panel, projects])

  /**
   * Start or resume, which is the centre column for a selected task with no
   * run on screen. `canStart` and `canResume` are the Tree's own readings, so
   * the two cannot disagree about what a task's state allows.
   */
  const startPanel = useMemo(() => {
    if (task === null || selected === null || project === null) return null
    if (runId !== null && view !== null) return null
    const common = {
      task,
      featureFile: selected.featureFile,
      account: project.account,
      testCmd: project.testCmd,
    }
    // `act` directly, not `send`: `useAction` catches into its own `error` and
    // resolves, which would settle the card as though the resume had worked.
    if (canResume(task) && runId !== null) {
      return { ...common, kind: "resume" as const, onResume: () => act(runId, { kind: "resume" }) }
    }
    if (canStart(task)) {
      return {
        ...common,
        kind: "start" as const,
        onStart: () => onStart(false),
        ...(blockedBy === null ? {} : { blockedBy }),
      }
    }
    return null
  }, [task, selected, project, runId, view, onStart, blockedBy])

  const failure = treeError ?? startError ?? actionError ?? projectError

  return (
    /* `kr` is the artboards' own root class, and `artboard.css`'s reduced-motion
       guard is `.kr, .kr *` — it does nothing until a root carries it.
       A column, not the grid itself: both artboards put a full-width band
       between the header and the three columns, and only one band ever shows. */
    /* `min-h-dvh`, never `h-dvh overflow-hidden`. Every artboard's root is
       `min-height:100vh` and every board is 1140-1780px tall at 1440 wide: the
       design is a page that SCROLLS AS A WHOLE, not a fixed-height app with a
       scrollbar per column. Pinning the shell to the viewport squeezed each
       panel into a short column and clipped it - which is exactly what it
       looked like. */
    <div className="kr flex min-h-dvh flex-col">
      <AppBar
        origin={origin}
        /* The initial screen is "nothing selected, no panel open" - there is no
           router here, so home is a state rather than a URL. */
        onHome={() => {
          setSelected(null)
          setPanel(null)
          setProjectError(null)
          setStartError(null)
          setDirtyRefusal(null)
        }}
      />

      {/* Exactly one band, in the slot both artboards put it in. The orange one
          wins: a run that needs you is never also a calm one. */}
      {view?.waiting != null && view.waiting.sinceMs !== null ? (
        <NeedsYouBand
          project={project?.path.split("/").at(-1) ?? null}
          taskRef={selected?.taskRef ?? null}
          taskText={task?.text ?? null}
          reason={view.waiting.reason}
          startedAtMs={view.waiting.sinceMs}
        />
      ) : (
        subject !== null && view?.ended === null && <ReturnBand subject={subject} needsYou={needsYou} />
      )}

      {/* `flex:1 1 288px` / `flex:999 1 560px` / `flex:1 1 260px`, wrapping,
          exactly as every artboard draws it. `Tree` and `Sidebar` each render
          their own `<aside>`, so they are the flex children directly - the
          wrapper divs that used to hold them were a second box around a box
          that already knew its own width. */}
      <div className="flex flex-1 flex-wrap items-stretch">
        <Tree
          projects={projects}
          selected={selected}
          selectedProject={panel?.kind === "project" ? panel.path : null}
          onSelect={(task) => {
            // The two selections are exclusive: the centre column is about one
            // thing, and leaving a project open behind a task would make the
            // breadcrumb and the panel disagree.
            setPanel(null)
            setSelected(task)
          }}
          onSelectProject={(path) => {
            setSelected(null)
            setPanel({ kind: "project", path })
          }}
          onAddProject={() => setPanel({ kind: "addRepo" })}
          onAddTask={(projectPath, featureFile) => {
            setSelected(null)
            setPanel({ kind: "addTasks", projectPath, featureFile })
          }}
          onRemoveTask={(projectPath, featureFile, taskRef) => {
            setRemoveError(null)
            setRemoving({ projectPath, featureFile, taskRef })
          }}
          onNewTaskFile={(projectPath) => {
            setSelected(null)
            setNewFileError(null)
            setNewFileText("")
            setPanel({ kind: "newTaskFile", projectPath })
          }}
        />

      {/* Empty renders its own `<main>` and its own `.dots` layer, because
          `artboard.css` scopes the first-run dot geometry to `.kr-empty .dots`
          and the column below already carries `.dots` with the other mask.
          `treeError` is in both conditions deliberately: the failure alert is
          rendered *inside* the main these replace, and `useTree` does not clear
          `tree` on a failed refetch - so without it an error would be silently
          swallowed on a tree that had loaded once. */}
      {noProjects && <Empty kind="no-projects" onAddProject={() => setPanel({ kind: "addRepo" })} />}

      {/* `ProjectPanel` and `AddRepo` each render their own `<main>` and
          `<aside>`: they replace the centre column AND the rail, exactly as
          `Empty` does. Nested inside our `<main>` instead, their
          `flex:999 1 560px` is read in a COLUMN context and becomes
          `height:560px` - which sliced the card at 560 with 830 of content, the
          clipping that looked like a layout bug and was a nesting one. */}
      {panelProject !== null && (
        <ProjectPanel
          project={panelProject}
          accounts={accountOptions}
          onSwitchAccount={(account) => onSwitchAccount(panelProject.path, account)}
          onSaveTestCmd={(cmd) => onSaveTestCmd(panelProject.path, cmd)}
          /* `null`, which is the only spelling the store accepts for "no
             suite" - it refuses `""`, because `sh -c ""` exits 0. */
          onClearTestCmd={() => onSaveTestCmd(panelProject.path, null)}
          /* Both or neither: `ProjectPanel` hides the ceiling section without a
             figure, and a figure with nothing to save it is a control that
             silently does nothing. A project from a store written before the
             field existed has no figure, and prints no guessed one. */
          /* The artboard's "Run it now", which was never drawn because nothing
             routed `runTests`. The command comes from the field rather than the
             store, because the control exists to prove a command works before
             it is trusted. */
          onRunTest={async (cmd) => {
            const answer = await runTestCommand({ projectPath: panelProject.path, testCmd: cmd })
            const summary = summaryOf(answer)
            return {
              exitCode: answer.exitCode,
              durationMs: answer.durationMs,
              timedOut: answer.timedOut,
              ...(summary === undefined ? {} : { summary }),
            }
          }}
          {...(panelProject.advanced === undefined
            ? {}
            : { onSaveAdvanced: (change: Partial<AdvancedSettings>) => onSaveAdvanced(panelProject.path, change) })}
          {...(panelProject.budgetUsd === undefined
            ? {}
            : { budgetUsd: panelProject.budgetUsd, onSaveBudget: (usd: number) => onSaveBudget(panelProject.path, usd) })}
          /* The artboard's placement for this: the last option in the task-file
             combobox. The tree's own "New task file" row is the other way in,
             and both open the same card. */
          onNewTaskFile={() => {
            setSelected(null)
            setNewFileError(null)
            setNewFileText("")
            setPanel({ kind: "newTaskFile", projectPath: panelProject.path })
          }}
          onRemove={() => onRemoveProject(panelProject)}
        />
      )}

      {panel?.kind === "addRepo" && (
        <AddRepo
          path={repoPath}
          onPathChange={setRepoPath}
          detection={detection}
          onCheck={() => setRepoPath((p) => p)}
          onSubmit={async (draft) => {
            await guard(async () => {
              await registerProject(draft)
              setPanel(null)
              setRepoPath("")
            })
          }}
          onCancel={() => {
            setPanel(null)
            setRepoPath("")
          }}
          accounts={accountOptions}
        />
      )}
      {nothingSelected && <Empty kind="no-selection" onAddProject={() => setPanel({ kind: "addRepo" })} />}

      {/* The dotted ground is its **own absolutely positioned layer**, exactly
          as the artboard draws it (`position:absolute;inset:0;pointer-events:
          none`). It cannot go on the column itself: `.dots` carries a
          `mask-image`, and a mask applies to the element's entire rendering,
          children included - putting it on the container faded the digest and
          erased the run record below the mask's 75% stop. */}
      <main
        hidden={noProjects || nothingSelected || panel?.kind === "project" || panel?.kind === "addRepo"}
        className="relative flex min-w-0 flex-[999_1_560px] flex-col px-[clamp(16px,3vw,44px)] pt-6 pb-12"
      >
        <div className="dots pointer-events-none absolute inset-0" aria-hidden="true" />
        {/* The artboard's own wrapper, verbatim: `position:relative;
            max-width:920px; margin:0 auto` around the *whole* centre column
            (`Main.dc.html:152`), not around one card inside it.

            It was on the gate alone and without the centring, which is what
            put a measured band of dead space down the right of the gate while
            its siblings ran wider - reported from use. Two different content
            widths in one column also means the breadcrumb, the gate and the
            run record do not share a left edge, and that misalignment is what
            reads as "off" before anyone can name a number. */}
        <div className="relative mx-auto flex w-full min-w-0 max-w-[920px] flex-col">
        {project !== null && selected !== null && (
          <Breadcrumb
            project={project.path.split("/").at(-1) ?? project.path}
            featureFile={selected.featureFile}
            account={project.account}
            {...(selected.taskRef === null ? {} : { taskRef: selected.taskRef })}
            {...(task === null ? {} : { taskText: task.text })}
          />
        )}

        {failure !== null && (
          <p role="alert" className="m-4 rounded-[12px] border border-[#F3C6C9] bg-[#FDF2F3] px-4 py-3 text-[13px] leading-[1.5] text-[#D92D3A]">
            {failure}
          </p>
        )}

        {panel?.kind === "newTaskFile" && (
          <section
            aria-labelledby="kantan-new-file"
            className="rounded-[20px] border border-edge bg-white p-6 shadow-[0_1px_2px_rgba(17,18,22,.04),0_18px_50px_-22px_rgba(17,18,22,.2)]"
          >
            <h1 id="kantan-new-file" className="m-0 text-[28px] font-[650] tracking-[-.02em]">
              Describe the work
            </h1>
            <p className="mt-[10px] mb-5 max-w-[62ch] text-[14.5px] leading-[1.55] text-muted-700">
              A sentence or two about what you want done, in your own words. kantan writes a new task file in{" "}
              <span className="m font-mono text-[13px]">docs/features/</span>, breaks the work into tasks, and commits
              the file. Nothing runs until you start a task. Use this for work none of the files in the tree is about —
              to add to one that already fits, use its own{" "}
              <span className="font-[560]">Add task</span> row instead.
            </p>
            <label htmlFor="kantan-new-file-text" className="block text-[13px] font-[560] text-muted-700">
              What needs doing?
            </label>
            <textarea
              id="kantan-new-file-text"
              autoFocus
              rows={5}
              value={newFileText}
              onChange={(e) => {
                setNewFileText(e.target.value)
                setNewFileError(null)
              }}
              placeholder="e.g. The importer should survive a crash halfway through a file and pick up where it stopped."
              className="mt-2 w-full resize-y rounded-[12px] border border-edge-strong bg-white p-3 text-[14px] leading-[1.55] text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-indigo"
            />
            {newFileError !== null && (
              <p
                role="alert"
                className="mt-3 mb-0 rounded-[10px] border border-[#F3C6C9] bg-[#FDF2F3] px-3 py-[10px] text-[13px] leading-[1.5] text-[#D92D3A]"
              >
                {newFileError}
              </p>
            )}
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={newFileText.trim() === "" || newFileBusy}
                onClick={() => void createTaskFile(panel.projectPath)}
                className="inline-flex h-12 items-center gap-2 rounded-full border-0 bg-ink px-5 text-[15px] font-[620] text-white disabled:bg-[#D9D9DF] disabled:text-muted-400"
              >
                {newFileBusy ? "Writing it…" : "Write the task file"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setPanel(null)
                  setNewFileText("")
                  setNewFileError(null)
                }}
                className="ghost h-12 rounded-full border border-edge-strong bg-white px-5 text-[14px] font-[560] text-ink-deep"
              >
                Cancel
              </button>
              {newFileBusy && (
                <span className="text-[13px] text-muted-500">
                  An agent is reading the repository and drafting the tasks. This usually takes a few seconds.
                </span>
              )}
            </div>
          </section>
        )}

        {panel?.kind === "addTasks" && addTasksFor !== null && (
          <AddTasks
            project={addTasksFor.project.path.split("/").at(-1) ?? addTasksFor.project.path}
            featureFile={addTasksFor.feature.path}
            tasks={addTasksFor.feature.tasks}
            account={addTasksFor.project.account}
            /* The artboard's "Ask Claude" tab, which has been built since this
               screen was ported and had nothing to call. `POST /api/features`
               drafts a whole *new* file numbered from T1, which is the wrong
               shape for a file that already has tasks - the gap `AddTasks`
               records in its own header. */
            onDraft={async (prompt) => ({
              tasks: await proposeTasks({
                projectPath: addTasksFor.project.path,
                featureFile: addTasksFor.feature.path,
                text: prompt,
              }),
            })}
            onAdd={async (texts) => {
              const refs = await addTasks({
                projectPath: addTasksFor.project.path,
                featureFile: addTasksFor.feature.path,
                texts,
              })
              /* The tree is the point of adding: without this the new tasks
                 exist on disk and nowhere on screen until something else
                 happens to refetch. Not inside `guard`, because `AddTasks`
                 reports its own refusals on its own screen and `guard` would
                 also put them on the page behind it. */
              reload()
              return refs
            }}
            onOpen={(ref) => {
              setPanel(null)
              setSelected({
                projectPath: addTasksFor.project.path,
                featureFile: addTasksFor.feature.path,
                taskRef: ref,
              })
            }}
            onCancel={() => setPanel(null)}
          />
        )}

        {dirtyRefusal !== null && (
          <section className="m-4 max-w-[620px] rounded-[14px] border border-[#F3D9C6] bg-[#FFF8F2] px-5 py-[18px]">
            <h2 className="text-[14px] font-[650] text-[#9A3B06]">This repository has uncommitted work</h2>
            {/* The server's own prose, reproduced rather than summarised: it
                names the files and explains why `git stash` without `-u`
                leaves you hitting this again. Which files are dirty is the one
                thing the human needs exact. */}
            <p className="m mt-2 whitespace-pre-wrap text-[12.5px] leading-[1.6] text-muted-500">{dirtyRefusal}</p>
            <p className="mt-3 text-[13.5px] leading-[1.55] text-muted-500">
              If that work is what you want the agent to carry on from, start anyway. kantan records that the tree
              was not clean, and the agent is told those files are yours to build on rather than revert.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void onStart(true).catch(() => {})}
                className="cta rounded-full bg-ink px-4 py-2 text-[13px] font-semibold text-white"
              >
                Start anyway
              </button>
              <button
                type="button"
                onClick={() => setDirtyRefusal(null)}
                className="ghost rounded-full px-4 py-2 text-[13px] font-semibold text-muted-500"
              >
                Cancel
              </button>
            </div>
          </section>
        )}

        {startPanel !== null && <StartPanel {...startPanel} />}

        {gate !== null && <Gate {...gate} />}

        {/* Keyed by run, as Stream's rows are: the entrance is keyed on entry
            ids and a replayed log must reconcile rather than re-animate. */}
        {subject !== null && view !== null && view.digest.length > 0 && (
          <Digest
            key={runId ?? "none"}
            subject={subject}
            entries={view.digest}
            needsYou={needsYou}
            testCommand={project?.testCmd}
            {...(view.header === null ? {} : { startedAtMs: Date.parse(view.header.startedAt) })}
          />
        )}

        {view !== null && (
          <Stream rows={view.rows} maxHeight={atGate ? 520 : 640} footer={footerFor(view)} />
        )}



        </div>
      </main>

      {/* No border or background here: `Sidebar` draws its own aside, faithfully
          to the artboard, and repeating them painted a 2px seam. */}
      {showRail && view !== null && view.ceilingUsd !== null && (
          <Sidebar
            phases={view.phases}
            processes={view.processes}
            ceilingUsd={view.ceilingUsd}
            windows={windowsFor(view, project?.account)}
            onStop={() => void send({ kind: "stop" })}
            onResume={() => void send({ kind: "resume" })}
            /* The footer swaps rather than greying out: a dead "Stop run" on a
               run that is already stopped was the only control there. */
            resumable={view.stopped && view.ended === null}
            /* `stopped` as well as `ended`: a stopped run is resumable, so it
               is not ended, but there is nothing left to stop either. Without
               it the button stayed enabled after a successful stop and looked
               broken - which is how it was reported. */
            stopDisabled={view.ended !== null || view.stopped}
          />
      )}
      </div>

      {removing !== null && (
        <div
          data-scrim
          /* `.kr` on the scrim as well as the root: it is `position: fixed`,
             and the kill-switch is a descendant selector. Rendered here,
             outside every column, because an ancestor carrying a `filter`
             becomes the containing block for a fixed child - which is how a
             scrim inside a card ended up clipped by that card's
             `overflow: clip`. `ProjectPanel` records the same trap. */
          className="kr dim fixed inset-0 z-40 grid place-items-center bg-[rgba(17,18,22,.32)] p-4"
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="kantan-remove-task"
            aria-describedby="kantan-remove-task-why"
            className="pop w-full max-w-[440px] box-border rounded-[20px] bg-white p-6 leading-[normal] shadow-[0_30px_80px_-20px_rgba(17,18,22,.5)]"
          >
            <h2
              id="kantan-remove-task"
              className="m-0 text-[20px] font-[650] tracking-[-.02em]"
            >
              Remove {removing.taskRef} from {removing.featureFile.split("/").at(-1)}?
            </h2>
            <p
              id="kantan-remove-task-why"
              className="mt-[10px] mb-5 text-[14.5px] leading-[1.55] text-muted-700"
            >
              The line is deleted from{" "}
              <span className="m font-mono text-[13px] [overflow-wrap:anywhere]">{removing.featureFile}</span> in your
              repository, and kantan commits that one file so the change is in your history rather than loose in your
              working tree. Every other task in the file is left exactly as it is. If {removing.taskRef} has already
              been run, its log and its branch are kept.
            </p>
            {removeError !== null && (
              <p
                role="alert"
                className="mt-0 mb-4 rounded-[10px] border border-[#F3C6C9] bg-[#FDF2F3] px-3 py-[10px] text-[13px] leading-[1.5] text-[#D92D3A]"
              >
                {removeError}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setRemoving(null)
                  setRemoveError(null)
                }}
                className="ghost h-11 rounded-full border border-edge-strong bg-white px-[18px] text-[14px] font-[560] text-ink-deep"
              >
                Keep it
              </button>
              <button
                type="button"
                autoFocus
                disabled={removeBusy}
                onClick={() => void confirmRemoveTask()}
                className="h-11 rounded-full border-0 bg-[#A61B27] px-[18px] text-[14px] font-[620] text-white disabled:opacity-60"
              >
                {removeBusy ? "Removing…" : `Remove ${removing.taskRef}`}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
