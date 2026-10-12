import { useCallback, useEffect, useMemo, useState } from "react"
import { Tree, canResume, canStart, type Account, type TaskId, type TreeProject, type TreeTask } from "./Tree.tsx"
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
import { act, detectPath, registerProject, removeProject, startRun, taskKeyOf, updateProject, type RunView } from "./live.ts"
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

  const onStart = useCallback(async () => {
    if (selected === null || selected.taskRef === null || selectedKey === null) return
    setStartError(null)
    try {
      const id = await startRun({ projectPath: selected.projectPath, featureFile: selected.featureFile, taskRef: selected.taskRef })
      setStarted((prior) => ({ ...prior, [selectedKey]: id }))
    } catch (cause) {
      setStartError(cause instanceof Error ? cause.message : String(cause))
      // Rethrown, not swallowed. `StartPanel` shows "Planning. The agent is
      // reading your repo." until its promise settles, and resolving on a
      // refusal leaves that sentence on screen forever beside the red alert —
      // the card claiming a run that never started. Rejecting is how a refusal
      // is reported, which is `Gate.onApprove`'s contract too.
      throw cause
    }
  }, [selected, selectedKey])

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
        testCommand: project?.testCmd ?? "",
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
      // Carries the profile, never just the word. See `accountOptions`.
      await guard(() => updateProject(path, { account: account.kind }))
    },
    [guard],
  )

  const onSaveTestCmd = useCallback(
    async (path: string, testCmd: string): Promise<void> => await guard(() => updateProject(path, { testCmd })),
    [guard],
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
      testCmd: project.testCmd === "" ? null : project.testCmd,
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
        onStart: () => onStart(),
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
      <AppBar origin={origin} />

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
      {nothingSelected && <Empty kind="no-selection" />}

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
        <div className="relative flex min-w-0 flex-col">
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

        {panel?.kind === "addTasks" && addTasksFor !== null && (
          <AddTasks
            project={addTasksFor.project.path.split("/").at(-1) ?? addTasksFor.project.path}
            featureFile={addTasksFor.feature.path}
            tasks={addTasksFor.feature.tasks}
            account={addTasksFor.project.account}
            onAdd={() => {
              // No write endpoint yet: the component reports a refusal rather
              // than claiming an append that did not happen.
              throw new Error("adding tasks to an existing file is not wired to the server yet")
            }}
            onCancel={() => setPanel(null)}
          />
        )}

        {startPanel !== null && <StartPanel {...startPanel} />}

        {gate !== null && (
          <div className="w-full max-w-[920px]">
            <Gate {...gate} />
          </div>
        )}

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
            stopDisabled={view.ended !== null}
          />
      )}
      </div>




    </div>
  )
}
