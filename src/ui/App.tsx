import { useCallback, useEffect, useMemo, useState } from "react"
import { Tree, canResume, canStart, type Account, type TaskId, type TreeProject, type TreeTask } from "./Tree.tsx"
import { Gate, type GateProps } from "./Gate.tsx"
import { Stream } from "./Stream.tsx"
import { Sidebar, sumProcessCost, type AccountWindow } from "./Sidebar.tsx"
import { Digest, ReturnBand, type DigestSubject } from "./Digest.tsx"
import { AppBar, Breadcrumb, NeedsYouBand, usePageAttention } from "./Chrome.tsx"
import { Empty } from "./Empty.tsx"
import { draftFeature, registerProject, removeProject, startRun, taskKeyOf, updateProject, type RunView } from "./live.ts"
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
 * Adding a repository: the only way a project enters the tree.
 *
 * A real form rather than a `prompt()`, because the server's refusals are the
 * useful part - "not a git repository", "not a worktree" - and they have to be
 * readable beside the field that caused them.
 */
function AddProject({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [path, setPath] = useState("")
  const [testCmd, setTestCmd] = useState("")
  const [account, setAccount] = useState<"personal" | "work" | "">("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await registerProject({
        path: path.trim(),
        testCmd: testCmd.trim(),
        ...(account === "" ? {} : { account }),
      })
      onDone()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[#111216]/30 p-6" role="dialog" aria-modal="true" aria-label="Add a repository">
      <form onSubmit={(e) => void submit(e)} className="w-full max-w-[520px] rounded-[18px] border border-edge bg-white p-6 shadow-lg">
        <h2 className="text-[19px] font-[650] tracking-[-.015em] text-ink">Add a repository</h2>
        <p className="mt-2 text-[13.5px] leading-[1.55] text-muted-500">
          kantan reads the tasks in <span className="m">docs/features/*.md</span> and runs your test command after each one.
        </p>

        <label className="mt-5 block text-[12.5px] font-semibold text-muted-400" htmlFor="ap-path">Repository path</label>
        <input id="ap-path" value={path} onChange={(e) => setPath(e.target.value)} required autoFocus
          placeholder="/home/you/code/your-app"
          className="m mt-1.5 w-full rounded-[10px] border border-edge px-3 py-2 text-[13.5px] text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#5B5BD6]" />

        <label className="mt-4 block text-[12.5px] font-semibold text-muted-400" htmlFor="ap-cmd">Test command</label>
        <input id="ap-cmd" value={testCmd} onChange={(e) => setTestCmd(e.target.value)} required
          placeholder="npm test"
          className="m mt-1.5 w-full rounded-[10px] border border-edge px-3 py-2 text-[13.5px] text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#5B5BD6]" />

        <fieldset className="mt-4 border-0 p-0">
          <legend className="text-[12.5px] font-semibold text-muted-400">Which Claude account does it bill to?</legend>
          {/* Asked, never inferred. A rule turning a profile directory into
              "work" is a guess about how someone names their folders, and
              billing a client from the wrong account is the defect this chip
              exists to prevent. "Not sure" is a real answer. */}
          <div className="mt-2 flex gap-2">
            {([["personal", "Personal"], ["work", "Work"], ["", "Not sure"]] as const).map(([value, label]) => (
              <button
                key={label}
                type="button"
                onClick={() => setAccount(value)}
                aria-pressed={account === value}
                className={`rounded-full border px-3 py-1.5 text-[12.5px] font-semibold ${
                  account === value ? "border-ink bg-ink text-white" : "border-edge text-muted-500"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>

        {error !== null && (
          <p role="alert" className="mt-4 rounded-[10px] border border-[#F3C6C9] bg-[#FDF2F3] px-3 py-2 text-[12.5px] leading-[1.5] text-[#D92D3A]">{error}</p>
        )}

        <div className="mt-6 flex items-center justify-end gap-3">
          <button type="button" onClick={onCancel} className="ghost rounded-full px-4 py-2 text-[13px] font-semibold text-muted-500">Cancel</button>
          <button type="submit" disabled={busy} className="cta rounded-full bg-ink px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50">
            {busy ? "Adding…" : "Add repository"}
          </button>
        </div>
      </form>
    </div>
  )
}

/**
 * Describing work, which writes the task file kantan runs from.
 *
 * Without this the product has a hole in the middle: you register a repo, and
 * if it has no `docs/features/*.md` the tree shows it with nothing underneath
 * and no way forward. The entire input is a markdown file, and until now the
 * only way to get one was to leave, open an editor, and learn the format.
 */
function DescribeWork({ projectPath, onDone, onCancel }: { projectPath: string; onDone: (path: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onDone(await draftFeature(projectPath, text.trim()))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[#111216]/30 p-6" role="dialog" aria-modal="true" aria-label="Describe the work">
      <form onSubmit={(e) => void submit(e)} className="w-full max-w-[560px] rounded-[18px] border border-edge bg-white p-6 shadow-lg">
        <h2 className="text-[19px] font-[650] tracking-[-.015em] text-ink">What do you want done?</h2>
        <p className="mt-2 text-[13.5px] leading-[1.55] text-muted-500">
          Describe it the way you would to a teammate. kantan writes a task file into{" "}
          <span className="m">docs/features/</span> and works through it one task at a time — you can edit the file afterwards.
        </p>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          required
          rows={5}
          autoFocus
          placeholder="Add CSV export to the reports page, with a test that the file downloads and parses."
          className="mt-4 w-full resize-y rounded-[12px] border border-edge px-3 py-2.5 text-[13.5px] leading-[1.6] text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#5B5BD6]"
        />

        {error !== null && (
          <p role="alert" className="mt-4 rounded-[10px] border border-[#F3C6C9] bg-[#FDF2F3] px-3 py-2 text-[12.5px] leading-[1.5] text-[#D92D3A]">{error}</p>
        )}

        <div className="mt-5 flex items-center justify-end gap-3">
          <button type="button" onClick={onCancel} className="ghost rounded-full px-4 py-2 text-[13px] font-semibold text-muted-500">Cancel</button>
          <button type="submit" disabled={busy || text.trim() === ""} className="cta rounded-full bg-ink px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50">
            {busy ? "Writing the task file…" : "Write the task file"}
          </button>
        </div>
      </form>
    </div>
  )
}

/** Changing a project's settings. Only what is edited is sent. */
function ProjectSettings({ project, onDone, onCancel }: { project: TreeProject; onDone: () => void; onCancel: () => void }) {
  const [testCmd, setTestCmd] = useState(project.testCmd)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      // Only what actually changed. A PATCH that sent every field would
      // rewrite settings this dialog never shows - the budget, the models, the
      // tool allowlist - which is the exact reason registering twice is
      // refused rather than treated as an edit.
      await updateProject(project.path, { testCmd: testCmd.trim() })
      onDone()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[#111216]/30 p-6" role="dialog" aria-modal="true" aria-label="Project settings">
      <form onSubmit={(e) => void submit(e)} className="w-full max-w-[520px] rounded-[18px] border border-edge bg-white p-6 shadow-lg">
        <h2 className="text-[19px] font-[650] tracking-[-.015em] text-ink">{repoName(project.path)}</h2>
        <p className="m mt-1 text-[12.5px] text-muted-400">{project.path}</p>

        <label className="mt-5 block text-[12.5px] font-semibold text-muted-400" htmlFor="ps-cmd">Test command</label>
        <input id="ps-cmd" value={testCmd} onChange={(e) => setTestCmd(e.target.value)} required
          className="m mt-1.5 w-full rounded-[10px] border border-edge px-3 py-2 text-[13.5px] text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#5B5BD6]" />

        {/*
          The account picker is deliberately NOT here.

          `Project.account` is a label and controls nothing: `src/spawn.ts`
          sets `CLAUDE_CONFIG_DIR` from `configDir`, `src/run.ts` records the
          run's profile from `configDir`, and nothing reads `account` except
          the chip's text. A control that PATCHed `account` alone would move
          the chip, show a confirmation, and bill exactly the same account as
          before - which is the defect `Account`'s own doc comment says the
          chip exists to prevent.

          The real switch is `ProjectPanel`'s, which carries the `configDir`
          with it, and it lands with the server support for clearing that
          field. Until then this dialog says so rather than offering a lever
          that does nothing.
        */}
        <p className="mt-4 rounded-[10px] border border-edge bg-panel px-3 py-2.5 text-[12.5px] leading-[1.5] text-muted-500">
          Changing which Claude account this project bills to means changing its profile directory, which this
          dialog cannot do yet. It is <strong className="font-semibold text-ink">{repoName(project.path)}</strong>&rsquo;s
          test command only for now.
        </p>

        {error !== null && (
          <p role="alert" className="mt-4 rounded-[10px] border border-[#F3C6C9] bg-[#FDF2F3] px-3 py-2 text-[12.5px] leading-[1.5] text-[#D92D3A]">{error}</p>
        )}

        <div className="mt-6 flex items-center justify-end gap-3">
          <button type="button" onClick={onCancel} className="ghost rounded-full px-4 py-2 text-[13px] font-semibold text-muted-500">Cancel</button>
          <button type="submit" disabled={busy} className="cta rounded-full bg-ink px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50">
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  )
}

/** Confirming removal, and saying plainly what is and is not deleted. */
function ConfirmRemove({
  project,
  onDone,
  onCancel,
  onError,
}: {
  project: TreeProject
  onDone: () => void
  onCancel: () => void
  onError: (message: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const go = async (): Promise<void> => {
    setBusy(true)
    try {
      await removeProject(project.path)
      onDone()
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
      onCancel()
    }
  }
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[#111216]/30 p-6" role="dialog" aria-modal="true" aria-label="Remove project">
      <div className="w-full max-w-[480px] rounded-[18px] border border-edge bg-white p-6 shadow-lg">
        <h2 className="text-[19px] font-[650] tracking-[-.015em] text-ink">Remove {repoName(project.path)}?</h2>
        {/* The sentence that matters: this is the one destructive-looking
            action in the app, and it touches nothing on disk. */}
        <p className="mt-2 text-[13.5px] leading-[1.55] text-muted-500">
          kantan stops tracking it. Your repository, its branches and its task files are not touched — nothing is
          deleted from disk. You can add it again at any time.
        </p>
        <div className="mt-6 flex items-center justify-end gap-3">
          <button type="button" onClick={onCancel} className="ghost rounded-full px-4 py-2 text-[13px] font-semibold text-muted-500">Cancel</button>
          <button type="button" onClick={() => void go()} disabled={busy}
            className="rounded-full bg-[#D92D3A] px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50">
            {busy ? "Removing…" : "Remove"}
          </button>
        </div>
      </div>
    </div>
  )
}

export function App() {
  const { tree, origin, error: treeError, reload } = useTree()
  const [adding, setAdding] = useState(false)
  const [describing, setDescribing] = useState<string | null>(null)
  /** A project opened in its own right, rather than one of its tasks. */
  const [openProject, setOpenProject] = useState<string | null>(null)
  const [editing, setEditing] = useState<TreeProject | null>(null)
  const [removing, setRemoving] = useState<TreeProject | null>(null)
  const [projectError, setProjectError] = useState<string | null>(null)
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
    treeError === null && tree !== null && projects.length > 0 && selected === null && openProject === null && emptyProjectOf(projects) === null
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
    openProject !== null
      ? (projects.find((p) => p.path === openProject) ?? null)
      : selected === null
        ? emptyProject
        : null
  const noProjects = treeError === null && tree !== null && projects.length === 0

  const failure = treeError ?? startError ?? actionError ?? projectError

  return (
    /* `kr` is the artboards' own root class, and `artboard.css`'s reduced-motion
       guard is `.kr, .kr *` — it does nothing until a root carries it.
       A column, not the grid itself: both artboards put a full-width band
       between the header and the three columns, and only one band ever shows. */
    <div className="kr flex h-dvh flex-col overflow-hidden">
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

      <div className={`grid min-h-0 flex-1 overflow-hidden ${showRail ? "grid-cols-[18rem_minmax(0,1fr)_16.25rem]" : "grid-cols-[18rem_minmax(0,1fr)]"}`}>
      {/* A flex column, because `Tree` draws its own panel as an `<aside
          className="basis-72 grow">` - and `grow` does nothing to a child of a
          block, so the panel ends at its content and the ground shows through
          below it. Caught in a screenshot; no assertion would have seen it. */}
      <div className="flex min-w-0 flex-col overflow-y-auto">
        <Tree
          projects={projects}
          selected={selected}
          selectedProject={openProject}
          onSelect={(task) => {
            // The two selections are exclusive: the centre column is about one
            // thing, and leaving a project open behind a task would make the
            // breadcrumb and the panel disagree.
            setOpenProject(null)
            setSelected(task)
          }}
          onSelectProject={(path) => {
            setSelected(null)
            setOpenProject(path)
          }}
          onAddProject={() => setAdding(true)}
        />
      </div>

      {/* Empty renders its own `<main>` and its own `.dots` layer, because
          `artboard.css` scopes the first-run dot geometry to `.kr-empty .dots`
          and the column below already carries `.dots` with the other mask.
          `treeError` is in both conditions deliberately: the failure alert is
          rendered *inside* the main these replace, and `useTree` does not clear
          `tree` on a failed refetch - so without it an error would be silently
          swallowed on a tree that had loaded once. */}
      {noProjects && <Empty kind="no-projects" onAddProject={() => setAdding(true)} />}
      {nothingSelected && <Empty kind="no-selection" />}

      {/* The dotted ground is its **own absolutely positioned layer**, exactly
          as the artboard draws it (`position:absolute;inset:0;pointer-events:
          none`). It cannot go on the column itself: `.dots` carries a
          `mask-image`, and a mask applies to the element's entire rendering,
          children included - putting it on the container faded the digest and
          erased the run record below the mask's 75% stop. */}
      <main hidden={noProjects || nothingSelected} className="relative flex min-w-0 flex-col overflow-y-auto px-6 pb-10">
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

        {panelProject !== null && (
          <section className="m-4 max-w-[620px] rounded-[14px] border border-edge bg-white px-5 py-5">
            <h2 className="text-[19px] font-[650] tracking-[-.015em] text-ink">{repoName(panelProject.path)}</h2>
            <p className="m mt-1 text-[12.5px] text-muted-400">{panelProject.path}</p>
            <p className="m mt-3 text-xs text-muted-400">$ {panelProject.testCmd}</p>

            {panelProject.features.length === 0 ? (
              <p className="mt-4 text-[13.5px] leading-[1.55] text-muted-500">
                No task file yet. kantan works through tasks written in <span className="m">docs/features/*.md</span>,
                one at a time. Describe what you want and it will write the first one — or add the file yourself and
                it will appear here.
              </p>
            ) : (
              <>
                <p className="mt-4 text-[13.5px] leading-[1.55] text-muted-500">
                  {taskCount(panelProject)} in {panelProject.features.length}{" "}
                  {panelProject.features.length === 1 ? "task file" : "task files"}. Pick one on the left to plan it,
                  or add more work below.
                </p>
                <ul className="m mt-3 list-none space-y-1 p-0 text-[12.5px] text-muted-500">
                  {panelProject.features.map((f) => (
                    <li key={f.path}>
                      {f.path} · {f.tasks.length} {f.tasks.length === 1 ? "task" : "tasks"}
                    </li>
                  ))}
                </ul>
              </>
            )}

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => setDescribing(panelProject.path)}
                className="cta rounded-full bg-ink px-4 py-2 text-[13px] font-semibold text-white"
              >
                Describe what you want done
              </button>
              <button
                type="button"
                onClick={() => setEditing(panelProject)}
                className="ghost rounded-full border border-edge px-4 py-2 text-[13px] font-semibold text-muted-500"
              >
                Settings
              </button>
              <button
                type="button"
                onClick={() => setRemoving(panelProject)}
                className="ghost rounded-full px-4 py-2 text-[13px] font-semibold text-[#D92D3A]"
              >
                Remove
              </button>
            </div>
          </section>
        )}

        {task !== null && canResume(task) && runId !== null && (
          <div className="m-4 max-w-[620px] rounded-[14px] border border-edge bg-panel px-5 py-[18px]">
            <p className="text-[13.5px] leading-[1.55] text-muted-500">
              {task.ref} was interrupted — the run was killed before it finished, so its log just stops. Resuming
              picks it up from the last phase it recorded, on the branch it was already using.
            </p>
            <button
              type="button"
              onClick={() => void send({ kind: "resume" })}
              className="cta mt-3 rounded-full bg-ink px-4 py-2 text-[13px] font-semibold text-white"
            >
              Resume this run
            </button>
          </div>
        )}

        {runId === null && task !== null && canStart(task) && (
          <div className="m-4 rounded-[14px] border border-edge bg-panel px-4 py-[18px]">
            <p className="text-[13.5px] leading-[1.55] text-muted-500">
              {task.ref} has not run yet.
            </p>
            <button
              type="button"
              onClick={() => void onStart()}
              className="mt-3 rounded-full bg-ink px-4 py-2 text-[13px] font-semibold text-white"
            >
              Start this task
            </button>
          </div>
        )}
        </div>
      </main>

      {/* No border or background here: `Sidebar` draws its own aside, faithfully
          to the artboard, and repeating them painted a 2px seam. */}
      {showRail && (
      <div className="flex min-w-0 flex-col overflow-y-auto">
        {view !== null && view.ceilingUsd !== null && (
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
      )}
      </div>

      {editing !== null && (
        <ProjectSettings
          project={editing}
          onDone={() => {
            setEditing(null)
            reload()
          }}
          onCancel={() => setEditing(null)}
        />
      )}

      {removing !== null && (
        <ConfirmRemove
          project={removing}
          onDone={() => {
            // The panel was about a project that no longer exists.
            if (openProject === removing.path) setOpenProject(null)
            if (selected?.projectPath === removing.path) setSelected(null)
            setRemoving(null)
            reload()
          }}
          onCancel={() => setRemoving(null)}
          onError={setProjectError}
        />
      )}

      {describing !== null && (
        <DescribeWork
          projectPath={describing}
          onDone={() => {
            setDescribing(null)
            reload()
          }}
          onCancel={() => setDescribing(null)}
        />
      )}

      {adding && (
        <AddProject
          onDone={() => {
            setAdding(false)
            reload()
          }}
          onCancel={() => setAdding(false)}
        />
      )}
    </div>
  )
}
