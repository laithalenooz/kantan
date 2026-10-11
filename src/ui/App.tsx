import { useState } from "react"
import { Tree, type TreeProject, type TaskId } from "./Tree.tsx"
import { Gate, type GateProps } from "./Gate.tsx"
import { Stream, type StreamRow } from "./Stream.tsx"
import { Sidebar, type CostProcess, type PhaseStep, type AccountWindow } from "./Sidebar.tsx"
import type { Event } from "../stream.ts"

/** stream.ts's result variant: the DOMAIN shape, not the wire shape sentinel.ts reads. */
type ResultEvent = Extract<Event, { kind: "result" }>

/**
 * The shell: tree, run, rail. Three columns, per docs/design/Main.dc.html.
 *
 * The four regions were built independently against the artboards; this file
 * is the only place they meet, so the seams between them live here.
 *
 * It still renders fixture data. Wiring it to the server is the next step, and
 * two of the shapes below exist to make that wiring correct rather than
 * convenient:
 *
 *   - `rowId` is deterministic. The SSE replays from byte 0 on every connect
 *     and carries no replay-versus-live marker, so a generated id would
 *     re-animate the whole log on reconnect, collapse every expanded row and
 *     throw away the measurement cache.
 *   - `waitId` is `runId#phaseRecordIndex`. Content alone cannot tell a
 *     re-asked question from a poll of the same one.
 */

const RUN = "r-8f3a1c"

/** Deterministic per log line. Never a counter. */
const rowId = (recordIndex: number) => `${RUN}#${recordIndex}`

const PROJECTS: TreeProject[] = [
  {
    path: "/home/you/code/your-app",
    account: { kind: "personal", label: "personal" },
    testCmd: "npm test",
    features: [
      {
        path: "docs/features/importer.md",
        tasks: [
          { ref: "T1", text: "Parse the manifest", done: true, run: { state: { kind: "done", merged: true }, branch: "orch/importer-t1-4b20a9" } },
          { ref: "T2", text: "Map records to rows", done: false, run: { state: { kind: "waiting", reason: "gate" }, branch: "orch/importer-t2-9f3a1c" } },
          { ref: "T3", text: "Runtime shim (v1.2)", done: false },
        ],
      },
    ],
  },
  {
    path: "/home/you/code/other-repo",
    account: { kind: "work", label: "work" },
    testCmd: "vendor/bin/pest",
    features: [
      {
        path: "docs/features/billing.md",
        tasks: [
          { ref: "T1", text: "Ledger reconciliation", done: true, run: { state: { kind: "done", merged: false }, branch: "orch/billing-t1-2ce471" } },
          { ref: "T2", text: "Refund path", done: false, run: { state: { kind: "failed", why: "tests failed after 3 attempts" }, branch: "orch/billing-t2-77d0ba" } },
        ],
      },
    ],
  },
]

const PLAN_MD = `# T2 Map records to rows

Add \`mapRecord()\`, taking one parsed manifest entry and returning a row.
Unknown fields are dropped rather than passed through, because the writer
refuses unknown keys.

1. **Failing test** for a record carrying an unknown field.
2. **Run it** and watch it fail.
3. **Implement** the mapping.
4. **Run the suite** and commit.
`

const ROWS: StreamRow[] = [
  { id: rowId(1), event: { kind: "tool_use", id: "t1", name: "Bash", input: { command: "git log --oneline -1" } } },
  { id: rowId(2), event: { kind: "tool_use", id: "t2", name: "Read", input: { file_path: "/home/you/code/your-app/src/importer/manifest.ts" } } },
  { id: rowId(3), event: { kind: "tool_use", id: "t3", name: "Edit", input: { file_path: "src/importer/map.ts", old_string: "return row", new_string: "return mapRecord(row)" } } },
  { id: rowId(4), tests: { exitCode: 1, attempt: 1, summary: "9 passing, 1 failing" } },
  { id: rowId(5), event: { kind: "text", text: "The unknown-field case was dropping the whole row. Narrowing the guard." } },
  { id: rowId(6), tests: { exitCode: 0, attempt: 2, summary: "10 passing" } },
]

const res = (costUsd: number): ResultEvent => ({
  kind: "result",
  subtype: "success",
  isError: false,
  costUsd,
  numTurns: 1,
  text: "",
  permissionDenials: [],
})

const PHASES: PhaseStep[] = [
  { phase: "plan", state: "done", elapsedMs: 8_000 },
  { phase: "gate", state: "waiting" },
  { phase: "implement", state: "pending" },
  { phase: "test", state: "pending" },
]

/**
 * One entry per process, holding that process's result events.
 *
 * `sumProcessCost` takes the LAST of each. Within a process the figure
 * accumulates, so summing every result double-counts — the plan process below
 * reads 0.25, not 0.10 + 0.25.
 */
const PROCESSES: CostProcess[] = [
  // stream.ts's DOMAIN shape (isError, costUsd), not the wire shape
  // (is_error, total_cost_usd) that src/sentinel.ts reads.
  { results: [res(0.1), res(0.25)] },
  { results: [res(0.17)] },
]

const WINDOWS: AccountWindow[] = [
  { profile: null, label: "personal", status: "allowed", utilization: 0.41, current: true },
  { profile: "/home/you/.claude-work", label: "work", status: "allowed", utilization: 0.12 },
]

export function App() {
  const [selected, setSelected] = useState<TaskId | null>({
    projectPath: "/home/you/code/your-app",
    featureFile: "docs/features/importer.md",
    taskRef: "T2",
  })

  const gate: GateProps = {
    kind: "gate",
    waitId: `${RUN}#7`,
    plan: { status: "loaded", path: "docs/plans/2026-10-11-t2-map-records.md", markdown: PLAN_MD },
    testCommand: "npm test",
    filesRead: ["src/importer/manifest.ts", "src/importer/map.ts"],
    planDurationMs: 8_000,
    costUsd: 0.25,
    onApprove: () => console.log("approve"),
    onFeedback: (text) => console.log("feedback", text),
  }

  return (
    <div className="grid h-dvh grid-cols-[18rem_minmax(0,1fr)_14rem] overflow-hidden">
      <div className="min-w-0 overflow-y-auto border-r border-edge bg-panel">
        <Tree projects={PROJECTS} selected={selected} onSelect={setSelected} />
      </div>

      <div className="flex min-w-0 flex-col overflow-y-auto">
        <Gate {...gate} />
        <Stream rows={ROWS} maxHeight={520} />
      </div>

      <div className="min-w-0 overflow-y-auto border-l border-edge bg-panel">
        <Sidebar
          phases={PHASES}
          processes={PROCESSES}
          ceilingUsd={50}
          windows={WINDOWS}
          onStop={() => console.log("stop")}
        />
      </div>
    </div>
  )
}
