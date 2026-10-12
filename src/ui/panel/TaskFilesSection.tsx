/**
 * The markdown files kantan reads tasks from, and the ways to change that set.
 *
 * Removing one here leaves the file in the repository alone, which the copy
 * promises and which is why this is not a danger zone. "Create a new task
 * file" is the artboard's own placement - the last option under "Found in the
 * repo" - because it answers the same question as the rows above it, and
 * looking down that list and seeing nothing that fits is exactly when it is
 * needed.
 */

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react"

import { BLURB, H2, LINE, PILL_GHOST, SECTION, messageOf } from "./chrome.tsx"
import { Cross, FileIcon, Plus, taskWord } from "./chrome.tsx"
import type { TaskFileCandidate } from "../ProjectPanel.tsx"
import type { TreeProject } from "../Tree.tsx"

/* -------------------------------------------------------------------------- */

export function TaskFilesSection({
  project,
  anim,
  animate,
  taskFileCandidates,
  onAddTaskFile,
  onStopTracking,
  onNewTaskFile,
}: {
  project: TreeProject
  anim: (classes: string) => string | undefined
  animate: boolean
  taskFileCandidates?: readonly TaskFileCandidate[]
  onAddTaskFile?: (path: string) => void | Promise<void>
  onStopTracking?: (path: string) => void | Promise<void>
  onNewTaskFile?: () => void
}): ReactElement {
  const [query, setQuery] = useState("")
  const [error, setError] = useState<string | null>(null)
  const listId = useId()
  const tracked = useMemo(() => new Set(project.features.map((f) => f.path)), [project.features])

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const all = taskFileCandidates ?? []
    return needle === "" ? all : all.filter((c) => c.path.toLowerCase().includes(needle))
  }, [query, taskFileCandidates])

  const add = (path: string): void => {
    if (onAddTaskFile === undefined) return
    const trimmed = path.trim()
    if (trimmed === "" || tracked.has(trimmed)) return
    setError(null)
    setQuery("")
    void (async () => {
      try {
        await onAddTaskFile(trimmed)
      } catch (cause) {
        setError(messageOf(cause))
      }
    })()
  }

  const stop = (path: string): void => {
    if (onStopTracking === undefined) return
    setError(null)
    void (async () => {
      try {
        await onStopTracking(path)
      } catch (cause) {
        setError(messageOf(cause))
      }
    })()
  }

  return (
    <div style={SECTION} className={anim("bf d3")}>
      <h2 style={H2}>Task files</h2>
      <p style={BLURB}>
        Markdown files kantan reads tasks from. Removing one here leaves the file in your repo alone.
      </p>

      {project.features.length === 0 ? (
        <p
          style={{
            margin: 0,
            padding: "14px 16px",
            borderRadius: 14,
            border: "1px dashed #E2E2E7",
            fontSize: 13.5,
            lineHeight: 1.55,
            color: "#5F6370",
          }}
        >
          No task file yet. kantan reads tasks from <span className="m">docs/features/*.md</span>, one at a time.
        </p>
      ) : (
        <ul
          data-files
          style={{ listStyle: "none", margin: 0, padding: 0, border: "1px solid #EEEEF1", borderRadius: 14, overflow: "hidden" }}
        >
          {project.features.map((feature, index) => (
            <li
              key={feature.path}
              style={{
                display: "grid",
                gridTemplateColumns: onStopTracking === undefined ? "18px minmax(0,1fr) auto" : "18px minmax(0,1fr) auto 40px",
                gap: 10,
                alignItems: "center",
                /* 50px plus the 1px rule the artboard adds from the second row
                   on: preflight's border-box would take it out of the row. */
                minHeight: index === 0 ? 50 : 51,
                padding: "0 6px 0 14px",
                boxSizing: "border-box",
                ...(index === 0 ? {} : { borderTop: "1px solid #F0F0F3" }),
              }}
            >
              <FileIcon size={15} color="#5F6370" />
              <span className="m" style={{ fontSize: 13, overflowWrap: "anywhere" }}>
                {feature.path}
              </span>
              <span style={{ fontSize: 12.5, color: "#5F6370" }}>{taskWord(feature.tasks.length)}</span>
              {onStopTracking !== undefined && (
                <button
                  type="button"
                  aria-label={`Stop tracking ${feature.path}`}
                  onClick={() => stop(feature.path)}
                  className={`${PILL_GHOST} rounded-[10px]`}
                  style={{ width: 36, height: 36, border: 0, background: "transparent", color: "#5F6370" }}
                >
                  <Cross size={15} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {onAddTaskFile !== undefined && (
        <div
          style={{
            marginTop: 10,
            border: "1px solid #E2E2E7",
            borderRadius: 14,
            background: "#fff",
            overflow: "hidden",
          }}
        >
          <label
            htmlFor="kp-newfile"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              /* 46px plus the 1px rule below it. See the file header. */
              minHeight: 47,
              padding: "0 14px",
              borderBottom: "1px solid #F0F0F3",
              boxSizing: "border-box",
            }}
          >
            <Plus size={15} />
            <input
              id="kp-newfile"
              className="m"
              role="combobox"
              aria-expanded={shown.length > 0}
              aria-controls={listId}
              aria-autocomplete="list"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return
                e.preventDefault()
                add(query)
              }}
              placeholder="Add a task file: type a path or pick one below"
              style={{
                border: 0,
                outline: "none",
                background: "transparent",
                width: "100%",
                fontSize: 13,
                color: "#111216",
              }}
            />
          </label>
          <div id={listId} role="listbox" aria-label="Task files found in the repo" style={{ padding: 6 }}>
            {(taskFileCandidates ?? []).length > 0 && (
              <div
                style={{
                  padding: "4px 8px 6px",
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: ".06em",
                  textTransform: "uppercase",
                  color: "#6B7080",
                }}
              >
                Found in the repo
              </div>
            )}
            {shown.map((candidate) => {
              const already = tracked.has(candidate.path)
              const hint = already
                ? "added"
                : candidate.taskCount === undefined
                  ? "not counted"
                  : candidate.taskCount === 0
                    ? "no tasks found"
                    : `${taskWord(candidate.taskCount)} found`
              return (
                <button
                  key={candidate.path}
                  type="button"
                  role="option"
                  aria-selected={already}
                  data-candidate={candidate.path}
                  disabled={already}
                  onClick={() => add(candidate.path)}
                  className={`opt ${animate ? "pop " : ""}focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo`}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0,1fr) auto",
                    gap: 10,
                    alignItems: "center",
                    width: "100%",
                    minHeight: 42,
                    padding: "0 10px",
                    border: 0,
                    borderRadius: 10,
                    background: "transparent",
                    textAlign: "left",
                    color: already ? "#5F6370" : "#111216",
                  }}
                >
                  <span className="m" style={{ fontSize: 13 }}>
                    {candidate.path}
                  </span>
                  <span style={{ fontSize: 12.5, color: "#5F6370" }}>{hint}</span>
                </button>
              )
            })}

            {onNewTaskFile !== undefined && (
              <button
                type="button"
                data-new-task-file
                onClick={onNewTaskFile}
                className="opt focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  minHeight: 42,
                  padding: "0 12px",
                  borderRadius: 10,
                  border: 0,
                  background: "transparent",
                  textAlign: "left",
                  fontSize: 13.5,
                  fontWeight: 560,
                  // The artboard's text-button colour. See `optionId`'s
                  // neighbours for the rest of this palette.
                  color: "#4B4BC8",
                }}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" className="ic" style={{ width: 15, height: 15 }} {...LINE}>
                  <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
                  <path d="M14 2v4a2 2 0 0 0 2 2h4" />
                  <path d="M12 12v6" />
                  <path d="M9 15h6" />
                </svg>
                Create a new task file
              </button>
            )}
          </div>
        </div>
      )}

      {error !== null && (
        <p role="alert" style={{ margin: "10px 0 0", fontSize: 13, lineHeight: 1.5, color: "#D92D3A" }}>
          {error}
        </p>
      )}
    </div>
  )
}
