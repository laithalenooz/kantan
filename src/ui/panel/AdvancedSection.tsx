/**
 * "How runs are shaped": the six settings that were hand-edit-only.
 *
 * Collapsed by default, and that is the honest default rather than a tidy one:
 * every field has a working value, and the two that can be set wrong cost real
 * money or real safety. A section nobody opened is a section nobody got wrong.
 *
 * The models are a `<datalist>` rather than a `<select>` because new model ids
 * ship between kantan releases and a closed list would make a model that
 * exists unreachable. `bypassPermissions` asks before widening; narrowing
 * never does. An empty tools box means **every** tool and sends `null`, since
 * an empty list would mean the agent may use nothing and every run would stop
 * at its first file read.
 */

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactElement } from "react"

import { BLURB, H2, LINE, PILL_GHOST, SECTION, messageOf } from "./chrome.tsx"
import { KindIcon, PILL_DARK } from "./chrome.tsx"
import type { AdvancedSettings, Effort, PermissionMode } from "../Tree.tsx"

/* -------------------------------------------------------------------------- */

/**
 * The four Claude models this build knows, as suggestions rather than a choice.
 *
 * A `<datalist>` and not a `<select>`, deliberately. The CLI takes a model id
 * as a string and new ones ship between kantan releases, so a closed list would
 * make a model that exists unreachable until someone edited this array - and
 * the fallback would be hand-editing `projects.json`, which is what this whole
 * section exists to replace. The store validates that the field is a non-blank
 * string and nothing more, which is the same judgement.
 */
export const KNOWN_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "claude-opus-5-5", label: "Opus 5.5 — the default for planning" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5 — the default for implementing" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5 — fastest, cheapest" },
  { id: "claude-fable-5-1", label: "Fable 5.1 — long-horizon work, costs more" },
]

export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"]

/**
 * The settings that shape a run, which were hand-edit-only until now.
 *
 * Collapsed by default, and that is the honest default rather than a tidy one:
 * every field here has a working value, and the two that can be set wrong cost
 * real money (a model, an effort) or real safety (`bypassPermissions`). A
 * section nobody opened is a section nobody got wrong.
 *
 * Each field commits on its own - see `onSaveAdvanced`. `PATCH /api/projects`
 * is a partial update, so committing a model does not rewrite an effort the
 * human was still deciding about.
 */
export function AdvancedSection({
  advanced,
  onSaveAdvanced,
  anim,
}: {
  advanced: AdvancedSettings
  onSaveAdvanced: (change: Partial<AdvancedSettings>) => void | Promise<void>
  anim: (classes: string) => string | undefined
}): ReactElement {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tools, setTools] = useState(advanced.allowedTools?.join(", ") ?? "")
  /** The confirmation `bypassPermissions` gets, because widening is one click. */
  const [asking, setAsking] = useState(false)
  const ids = useId()

  useEffect(() => {
    setTools(advanced.allowedTools?.join(", ") ?? "")
  }, [advanced.allowedTools])

  const save = (change: Partial<AdvancedSettings>): void => {
    setError(null)
    void (async () => {
      try {
        await onSaveAdvanced(change)
      } catch (cause) {
        setError(messageOf(cause))
      }
    })()
  }

  /**
   * The tools field, read on blur.
   *
   * Empty means **every tool**, which is `null` and the store's default - not
   * an empty list, which would mean the agent may use nothing and would make
   * every run fail at its first file read. The two readings of a blank box are
   * opposite, so the label says which one this is.
   */
  const commitTools = (): void => {
    const names = tools
      .split(/[,\n]/)
      .map((t) => t.trim())
      .filter((t) => t !== "")
    save({ allowedTools: names.length === 0 ? null : names })
  }

  const field: CSSProperties = {
    minHeight: 42,
    padding: "0 12px",
    borderRadius: 10,
    border: "1px solid #E2E2E7",
    background: "#fff",
    fontSize: 13.5,
    color: "#111216",
    boxSizing: "border-box",
    width: "100%",
  }
  const label: CSSProperties = { display: "block", fontSize: 12.5, fontWeight: 560, color: "#4A4E59", marginBottom: 5 }

  return (
    <div style={SECTION} className={anim("bf d4")}>
      <button
        type="button"
        data-advanced-toggle
        aria-expanded={open}
        aria-controls={`${ids}-body`}
        onClick={() => setOpen((was) => !was)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          border: 0,
          padding: 0,
          background: "none",
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="ic"
          style={{ width: 14, height: 14, transform: open ? "none" : "rotate(-90deg)", transition: "transform .2s" }}
          {...LINE}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
        <span style={H2}>How runs are shaped</span>
      </button>
      <p style={{ ...BLURB, margin: "4px 0 0", paddingLeft: 22 }}>
        The model and effort each phase runs with, and what the agent may do without asking. Every one of these has a
        working value — change them when you have a reason.
      </p>

      {open && (
        <div id={`${ids}-body`} style={{ paddingLeft: 22, marginTop: 14, display: "grid", gap: 14 }}>
          <datalist id={`${ids}-models`}>
            {KNOWN_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </datalist>

          <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit,minmax(min(220px,100%),1fr))" }}>
            {(
              [
                { key: "planModel" as const, title: "Planning model", why: "Writes the plan you approve." },
                { key: "implementModel" as const, title: "Implementing model", why: "Writes the code and fixes the tests." },
              ]
            ).map(({ key, title, why }) => (
              <div key={key}>
                <label htmlFor={`${ids}-${key}`} style={label}>
                  {title}
                </label>
                <input
                  id={`${ids}-${key}`}
                  data-advanced={key}
                  className="m"
                  list={`${ids}-models`}
                  defaultValue={advanced[key]}
                  onBlur={(e) => {
                    const next = e.target.value.trim()
                    if (next !== "" && next !== advanced[key]) save({ [key]: next })
                  }}
                  style={field}
                />
                <p style={{ margin: "5px 0 0", fontSize: 12, color: "#5F6370" }}>{why}</p>
              </div>
            ))}
          </div>

          <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit,minmax(min(220px,100%),1fr))" }}>
            {(
              [
                { key: "planEffort" as const, title: "Planning effort" },
                { key: "implementEffort" as const, title: "Implementing effort" },
              ]
            ).map(({ key, title }) => (
              <div key={key}>
                <label htmlFor={`${ids}-${key}`} style={label}>
                  {title}
                </label>
                <select
                  id={`${ids}-${key}`}
                  data-advanced={key}
                  value={advanced[key]}
                  onChange={(e) => save({ [key]: e.target.value as Effort })}
                  style={field}
                >
                  {EFFORTS.map((effort) => (
                    <option key={effort} value={effort}>
                      {effort}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          <p style={{ margin: 0, fontSize: 12, color: "#5F6370", maxWidth: "62ch" }}>
            Higher effort means the agent thinks for longer before answering. It costs more and is slower; it is worth
            it on work that is hard to specify.
          </p>

          <div>
            <span style={label}>What the agent may do without asking</span>
            <div style={{ display: "grid", gap: 8 }}>
              {(
                [
                  {
                    mode: "acceptEdits" as const,
                    title: "Accept edits",
                    why: "It may read and write files in this repository, and run your test command. Anything else is refused.",
                  },
                  {
                    mode: "bypassPermissions" as const,
                    title: "Bypass permissions",
                    why: "It may run any command, with your user's full access to this machine. kantan cannot take this back once a run has started.",
                  },
                ]
              ).map(({ mode, title, why }) => {
                const on = advanced.permissionMode === mode
                return (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    data-permission={mode}
                    onClick={() => {
                      if (on) return
                      /* Widening is one click and cannot be undone for a run
                         already in flight, so it asks. Narrowing never does:
                         the cheap direction needs no ceremony. */
                      if (mode === "bypassPermissions") setAsking(true)
                      else save({ permissionMode: mode })
                    }}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "18px minmax(0,1fr)",
                      gap: 10,
                      alignItems: "start",
                      padding: "11px 12px",
                      borderRadius: 12,
                      textAlign: "left",
                      boxSizing: "border-box",
                      border: on ? "1.5px solid #111216" : "1px solid #E2E2E7",
                      background: on ? "#fff" : "#FCFCFD",
                      color: "#111216",
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        width: 16,
                        height: 16,
                        marginTop: 2,
                        borderRadius: "50%",
                        boxSizing: "border-box",
                        border: on ? "5px solid #111216" : "1.5px solid #C4C7CE",
                        background: "#fff",
                      }}
                    />
                    <span>
                      <span style={{ display: "block", fontSize: 13.5, fontWeight: 620 }}>{title}</span>
                      <span style={{ display: "block", marginTop: 2, fontSize: 12.5, lineHeight: 1.45, color: "#4A4E59" }}>
                        {why}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
            {asking && (
              <div
                role="alertdialog"
                aria-label="Confirm bypass permissions"
                style={{
                  marginTop: 10,
                  padding: "12px 12px 10px",
                  borderRadius: 12,
                  border: "1px solid #F0B8BE",
                  background: "#FDF2F3",
                }}
              >
                <p style={{ margin: "0 0 10px", fontSize: 13, lineHeight: 1.5, color: "#3A3D45" }}>
                  Every future run on this project may run any command as you, without asking — including ones that
                  reach outside this repository. Your test command is still the only thing kantan reads a pass from.
                </p>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => {
                      setAsking(false)
                      save({ permissionMode: "bypassPermissions" })
                    }}
                    style={{
                      height: 38,
                      padding: "0 14px",
                      borderRadius: 999,
                      border: 0,
                      background: "#B4232F",
                      color: "#fff",
                      fontSize: 13.5,
                      fontWeight: 620,
                    }}
                  >
                    Allow any command
                  </button>
                  <button type="button" onClick={() => setAsking(false)} className={PILL_GHOST} style={{ height: 38, padding: "0 14px", borderRadius: 999, border: "1px solid #D9D9DF", background: "#fff", fontSize: 13.5, fontWeight: 560, color: "#1E2026" }}>
                    Keep it as it is
                  </button>
                </div>
              </div>
            )}
          </div>

          <div>
            <label htmlFor={`${ids}-tools`} style={label}>
              Tools the agent may use
            </label>
            <input
              id={`${ids}-tools`}
              data-advanced="allowedTools"
              className="m"
              value={tools}
              placeholder="Read, Edit, Write, Bash"
              onChange={(e) => setTools(e.target.value)}
              onBlur={commitTools}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  commitTools()
                }
              }}
              style={field}
            />
            <p style={{ margin: "5px 0 0", fontSize: 12, lineHeight: 1.45, color: "#5F6370", maxWidth: "62ch" }}>
              Comma-separated. <strong style={{ fontWeight: 620 }}>Leave it empty for every tool</strong>, which is the
              default — an empty list would mean the agent may use nothing, and every run would stop at its first file
              read.
            </p>
          </div>

          {error !== null && (
            <p role="alert" style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: "#D92D3A" }}>
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
