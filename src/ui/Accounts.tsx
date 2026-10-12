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

import type { ReactElement } from "react"

import { formatResetTime, percentLabel } from "./format.ts"
import type { AccountUsage, Freshness, UsageWindow } from "./live.ts"

export interface AccountsProps {
  /** `null` while the first read is in flight. */
  accounts: AccountUsage[] | null
  error: string | null
  busy: boolean
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
                {account.freshness === "live"
                  ? "A run is billing to this account now, so this updates as it reports."
                  : account.seenDuringRunStartedAt === undefined
                    ? "Reported by a run kantan has a log for."
                    : `Reported during a run that started ${new Date(account.seenDuringRunStartedAt).toLocaleString()}.`}
              </>
            )}
          </p>
        </>
      )}
    </li>
  )
}

export function Accounts({ accounts, error, busy, onRefresh, onClose }: AccountsProps): ReactElement {
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
