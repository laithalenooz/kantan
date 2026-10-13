/**
 * Where each Claude account stands, as far as kantan can tell.
 *
 * The screen has no artboard, because the design never drew one — the rail's
 * rings are per-run and there was nowhere to see an account nothing is running
 * on. So every decision here is this file's, and the ones that matter are
 * about **not claiming more than the data supports**:
 *
 * - **kantan only sees usage its own runs reported.** `claude` has no
 *   subcommand that reports a rate limit, so the only source is the
 *   `rate_limit_event` a run emits. A Claude Code session in a terminal spends
 *   from the same window and is invisible here. The footnote says so, once, in
 *   plain words — a figure presented as "your usage" would be wrong for anyone
 *   who also uses the CLI directly, which is everyone using this.
 * - **An expired reading shows no bar.** Once `resetsAt` passes, the figure is
 *   about a window that no longer exists. Drawing 3% would invite someone to
 *   start an expensive run on an account whose real usage is unknown, so the
 *   row says the window reset and what the figure *was*, and draws nothing.
 * - **Both windows, shortest first.** The five-hour one blocks the next run,
 *   the seven-day one blocks the week, and a surface that showed only the
 *   active one would hide the second the moment it was the binding constraint.
 */

import { useState } from "react"
import type { ReactElement } from "react"

import { formatResetTime, percentLabel } from "./format.ts"
import type { AccountUsage, Freshness, UsageWindow } from "./live.ts"

export interface AccountsProps {
  /** `null` while the first read is in flight. */
  accounts: AccountUsage[] | null
  error: string | null
  busy: boolean
  /**
   * Folders on this machine that look like Claude profiles kantan has not been
   * told about. **Suggestions, not records.**
   *
   * They answer the report *"why other accounts are not detected?"* - kantan
   * could only ever offer an account some project already billed to, so a
   * profile sitting on disk was invisible. What it must not do is turn a
   * directory it found into an account by itself: it cannot know whose that
   * account is, what to call it, or whether anybody wants kantan running under
   * it. So a suggestion fills the form in, and a person presses add.
   */
  found: string[]
  /** Records one. Rejects with the server's sentence, which the form prints. */
  onAdd: (account: { kind: "personal" | "work"; label: string; configDir: string }) => Promise<void>
  onRefresh: () => void
  onClose: () => void
}

const CARD = "rounded-[16px] border border-edge bg-white p-4"

/** What `five_hour` is called on screen. An unknown name is printed as sent. */
function windowName(name: string): string {
  if (name === "five_hour") return "5-hour window"
  if (name === "seven_day") return "7-day window"
  return name.replace(/_/g, " ")
}

/** The profile a row is about. `null` is the account with no folder set. */
function profileLabel(profile: string | null): string {
  return profile ?? "default profile"
}

const FRESHNESS: Record<Freshness, { word: string; tone: string }> = {
  live: { word: "live", tone: "text-[#3A3AA8]" },
  current: { word: "last seen", tone: "text-muted-500" },
  expired: { word: "window reset", tone: "text-[#9A3B06]" },
  never: { word: "never used", tone: "text-muted-400" },
}

function Bar({ window: w }: { window: UsageWindow }): ReactElement {
  const used = w.utilization
  /* No bar at all for a window with no figure: a 0%-wide bar and "nothing
     reported" look the same, and one of them is a claim. */
  if (used === undefined) {
    return <span className="text-[12.5px] text-muted-400">no figure reported</span>
  }
  return (
    <span className="flex items-center gap-2">
      <span className="relative h-[6px] w-full min-w-[80px] overflow-hidden rounded-full bg-[#EEEEF1]">
        <span
          data-bar
          className="absolute inset-y-0 left-0 rounded-full bg-ink"
          /* `minWidth` so a non-zero figure is never invisible: 0.4% of a
             120px bar is half a pixel, and a bar that renders as nothing reads
             as "unused" rather than as "barely used". */
          style={{ width: `${Math.min(100, Math.max(0, used * 100))}%`, minWidth: used > 0 ? 3 : 0 }}
        />
      </span>
      <span className="m shrink-0 text-[12.5px] tabular-nums text-ink">{percentLabel(used)}</span>
    </span>
  )
}

function Row({ account }: { account: AccountUsage }): ReactElement {
  const { word, tone } = FRESHNESS[account.freshness]
  const windows = account.windows ?? []
  const expired = account.freshness === "expired"

  return (
    <li data-account={account.profile ?? ""} className={`${CARD} list-none`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="m text-[13.5px] font-[620] text-ink [overflow-wrap:anywhere]">
          {profileLabel(account.profile)}
        </span>
        <span data-freshness={account.freshness} className={`text-[12px] font-[560] ${tone}`}>
          {account.freshness === "live" && (
            <span aria-hidden className="mr-1.5 inline-block size-[6px] rounded-full bg-[#5B5BD6] align-middle" />
          )}
          {word}
        </span>
        {account.status !== undefined && account.status !== "allowed" && (
          <span className="m rounded-full bg-[#FFF8F2] px-2 py-[1px] text-[11.5px] text-[#9A3B06]">
            {account.status}
          </span>
        )}
      </div>

      {account.freshness === "never" ? (
        <p className="mt-2 mb-0 text-[13px] leading-[1.5] text-muted-500">
          No run has billed to this account yet, so kantan has never been told a figure for it.
        </p>
      ) : (
        <>
          <div className="mt-3 grid gap-2">
            {windows.map((w) => (
              <div key={w.name} className="grid grid-cols-[108px_minmax(0,1fr)] items-center gap-3">
                <span className="text-[12.5px] text-muted-500">{windowName(w.name)}</span>
                {expired ? (
                  <span className="text-[12.5px] text-muted-400">
                    was {w.utilization === undefined ? "not reported" : percentLabel(w.utilization)}
                  </span>
                ) : (
                  <Bar window={w} />
                )}
              </div>
            ))}
          </div>

          <p className="mt-3 mb-0 text-[12.5px] leading-[1.5] text-muted-500">
            {expired ? (
              <>
                {/* The reading described a window that has since reset, so what
                    has been spent in the new one is unknown. Not zero. */}
                The shortest window reset
                {windows[0]?.resetsAt === undefined ? "" : ` at ${formatResetTime(windows[0].resetsAt)}`}, so these
                figures are about a window that has ended. What has been used since is unknown until the next run
                reports it.
              </>
            ) : (
              <>
                {windows[0]?.resetsAt !== undefined && <>Resets at {formatResetTime(windows[0].resetsAt)}. </>}
                {/* The record's own stamp when the log has one, and the run's
                    start when it does not. Those are different claims - an
                    exact time against a lower bound - so they are worded
                    differently rather than both printed as "reported at". A log
                    written before `CliRecord.at` gets the honest, looser
                    sentence. */}
                {account.freshness === "live"
                  ? "A run is billing to this account now, so this updates as it reports."
                  : account.takenAt !== undefined
                    ? `Read at ${new Date(account.takenAt).toLocaleString()}.`
                    : account.seenDuringRunStartedAt === undefined
                      ? "Reported by a run kantan has a log for."
                      : `Reported some time during a run that started ${new Date(account.seenDuringRunStartedAt).toLocaleString()}.`}
              </>
            )}
          </p>
        </>
      )}
    </li>
  )
}

/**
 * Telling kantan about an account: the suggestions, and the form.
 *
 * **The kind is never inferred from the path.** `accountOf` on the server
 * refuses to default an unknown account to `personal`, because billing a
 * client from the wrong account is the defect that rule exists to prevent - so
 * a one-click "add this folder" would have to invent the one thing only the
 * user can say. A suggestion therefore fills the folder in and stops.
 */
function AddAccount({ found, onAdd }: { found: string[]; onAdd: AccountsProps["onAdd"] }): ReactElement {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<"personal" | "work">("work")
  const [label, setLabel] = useState("")
  const [dir, setDir] = useState("")
  const [failure, setFailure] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const use = (path: string): void => {
    setDir(path)
    // Prefilled from the folder, because it is the only name kantan has and a
    // blank field invites nothing. Editable, because it is a guess at a word.
    if (label.trim() === "") setLabel(path.split("/").filter((p) => p !== "").at(-1) ?? "")
    setFailure(null)
    setOpen(true)
  }

  const submit = (): void => {
    const name = label.trim()
    const folder = dir.trim()
    if (name === "" || folder === "") {
      setFailure("An account needs a name and the Claude config folder it bills to.")
      return
    }
    setFailure(null)
    setSaving(true)
    void (async () => {
      try {
        await onAdd({ kind, label: name, configDir: folder })
        setLabel("")
        setDir("")
        setOpen(false)
      } catch (cause) {
        /* The store's own sentence, kept where the fields are: it says why a
           relative folder cannot work, which is the part a person can act on.
           The form stays open with what they typed - closing it on a failure
           would look like it had worked. */
        setFailure(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setSaving(false)
      }
    })()
  }

  const FIELD =
    "h-9 w-full rounded-[10px] border border-edge-strong bg-white px-3 text-[13.5px] text-ink-deep outline-none"

  return (
    <section data-add-account className={`${CARD} mt-5`}>
      <h2 className="m-0 text-[15px] font-[650] text-ink">Another account</h2>

      {found.length > 0 && (
        <>
          {/* One sentence per number rather than a pluralised word in the
              middle of a shared one: the first version read "found a folder
              that look like Claude profiles… whose account each one is", which
              is three disagreements for the common case of exactly one. */}
          <p className="mt-2 mb-3 max-w-[66ch] text-[13px] leading-[1.55] text-muted-500">
            {found.length === 1
              ? "kantan found a folder on this machine that looks like a Claude profile it has not been told about. It cannot tell whose account that is, so it will not add it for you."
              : `kantan found ${found.length} folders on this machine that look like Claude profiles it has not been told about. It cannot tell whose account each one is, so it will not add them for you.`}
          </p>
          <ul className="m-0 mb-4 grid list-none gap-2 p-0">
            {found.map((path) => (
              <li
                key={path}
                data-found={path}
                className="flex flex-wrap items-center gap-3 rounded-[10px] border border-edge bg-[#FCFCFD] px-3 py-2"
              >
                <span className="m min-w-0 flex-1 truncate text-[12.5px] text-muted-700">{path}</span>
                <button
                  type="button"
                  onClick={() => use(path)}
                  className="ghost h-8 shrink-0 rounded-full border border-edge-strong bg-white px-3 text-[12.5px] font-[560] text-ink-deep"
                >
                  Use this folder
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {!open ? (
        <button
          type="button"
          data-account-add="open"
          onClick={() => setOpen(true)}
          className="h-9 rounded-full bg-ink px-4 text-[13px] font-[600] text-white"
        >
          Add an account
        </button>
      ) : (
        <div className="grid gap-3">
          <label className="grid gap-1 text-[12.5px] font-[560] text-muted-700">
            Name
            <input
              data-account-add="name"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Acme"
              className={FIELD}
            />
          </label>
          <label className="grid gap-1 text-[12.5px] font-[560] text-muted-700">
            Claude config folder
            <input
              data-account-add="dir"
              value={dir}
              onChange={(e) => setDir(e.target.value)}
              placeholder="~/.claude-acme"
              className={`${FIELD} m`}
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12.5px] font-[560] text-muted-700">Bills as</span>
            {(["personal", "work"] as const).map((option) => (
              <button
                key={option}
                type="button"
                data-account-add={`kind-${option}`}
                aria-pressed={kind === option}
                onClick={() => setKind(option)}
                className={`h-8 rounded-full border px-3 text-[12.5px] font-[560] ${
                  kind === option ? "border-ink bg-ink text-white" : "border-edge-strong bg-white text-ink-deep"
                }`}
              >
                {option}
              </button>
            ))}
          </div>

          {failure !== null && (
            <p role="alert" className="m-0 text-[12.5px] leading-[1.5] text-[#D92D3A]">
              {failure}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              data-account-add="submit"
              disabled={saving}
              onClick={submit}
              className="h-9 rounded-full bg-ink px-4 text-[13px] font-[600] text-white disabled:opacity-60"
            >
              {saving ? "Adding…" : "Add account"}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                setFailure(null)
              }}
              className="ghost h-9 rounded-full px-3 text-[13px] font-[560] text-muted-500"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

export function Accounts({ accounts, error, busy, found, onAdd, onRefresh, onClose }: AccountsProps): ReactElement {
  /* A folder already in the list above is not a suggestion: it is in the
     report with its usage, and offering it as new would be kantan suggesting
     something it is already doing. */
  const known = new Set((accounts ?? []).map((a) => a.profile).filter((p): p is string => p !== null))
  const suggestions = found.filter((path) => !known.has(path))

  return (
    <main
      data-accounts
      aria-labelledby="kantan-accounts"
      className="kr relative flex min-w-0 flex-[999_1_560px] flex-col px-[clamp(16px,3vw,44px)] pt-6 pb-12 leading-[normal]"
    >
      <div className="relative mx-auto flex w-full min-w-0 max-w-[820px] flex-col">
        <div className="flex flex-wrap items-center gap-3">
          <h1 id="kantan-accounts" className="m-0 text-[28px] font-[650] tracking-[-.02em]">
            Claude accounts
          </h1>
          <button
            type="button"
            data-refresh
            onClick={onRefresh}
            disabled={busy}
            className="ghost ml-auto h-9 rounded-full border border-edge-strong bg-white px-4 text-[13px] font-[560] text-ink-deep disabled:text-muted-300"
          >
            {busy ? "Reading…" : "Refresh"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="ghost h-9 rounded-full border border-edge-strong bg-white px-4 text-[13px] font-[560] text-ink-deep"
          >
            Close
          </button>
        </div>

        <p className="mt-[10px] mb-5 max-w-[66ch] text-[14px] leading-[1.55] text-muted-700">
          Billing and the rate limits follow a project&rsquo;s <span className="m text-[13px]">CLAUDE_CONFIG_DIR</span>,
          so each folder below is one account.
        </p>

        {error !== null && (
          <p
            role="alert"
            className="mb-4 rounded-[10px] border border-[#F3C6C9] bg-[#FDF2F3] px-3 py-[10px] text-[13px] leading-[1.5] text-[#D92D3A]"
          >
            {error}
            {accounts !== null && " The figures below are the last ones that arrived."}
          </p>
        )}

        {accounts === null ? (
          <p className="text-[13.5px] text-muted-500">Reading the run logs…</p>
        ) : accounts.length === 0 ? (
          <p className="text-[13.5px] text-muted-500">
            No accounts yet. Add a repository and kantan will have one to bill to.
          </p>
        ) : (
          <ul className="m-0 grid list-none gap-3 p-0">
            {accounts.map((account) => (
              <Row key={account.profile ?? "\u0000default"} account={account} />
            ))}
          </ul>
        )}

        <AddAccount found={suggestions} onAdd={onAdd} />

        {/* Once, in plain words, because every figure above depends on it. */}
        <p className="mt-6 mb-0 max-w-[66ch] text-[12.5px] leading-[1.55] text-muted-500">
          <strong className="font-[620]">kantan only sees what its own runs report.</strong> There is no command that
          asks Claude for a rate limit, so these figures come from the usage events a run emits while it works. Anything
          you spend in a Claude Code session of your own counts against the same window and does not appear here.
        </p>
      </div>
    </main>
  )
}
