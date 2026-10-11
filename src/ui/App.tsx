/**
 * Placeholder shell. Tasks 21 to 24 replace this with the real three-column
 * layout: the task tree, the run record, the gate and the right rail.
 *
 * Its only job today is to prove the token layer loads — the ground, Geist,
 * Geist Mono, and the one colour that is allowed to pull the eye.
 *
 * The design is authoritative and lives in docs/design/. Read the artboard for
 * a region before building it; it is far more specific than this file.
 */
export function App() {
  return (
    <div className="min-h-dvh">
      <header className="flex h-14 items-center gap-3 border-b border-edge bg-white/90 px-5">
        <span
          aria-hidden
          className="grid size-[26px] place-items-center rounded-lg bg-gradient-to-br from-ink-soft to-[#0e0f12] shadow-[inset_0_1px_0_rgba(255,255,255,.14),0_2px_6px_-2px_rgba(17,18,22,.5)]"
        >
          <span className="size-2 rounded-full bg-attention" />
        </span>
        <span className="text-[17px] font-bold tracking-[-0.025em]">kantan</span>
        <span className="rounded-full bg-panel-3 px-2 py-[3px] font-mono text-xs text-muted-400">
          localhost:3100
        </span>
      </header>

      <main className="mx-auto max-w-2xl px-6 py-20">
        <h1 className="text-[clamp(38px,5vw,58px)] font-[650] leading-[1.02] tracking-[-0.045em] text-balance">
          Tokens are live.
        </h1>
        <p className="mt-5 max-w-[46ch] text-[17px] leading-relaxed text-muted-700 text-pretty">
          Geist for prose, Geist Mono for machine values, and one accent that means
          exactly one thing. The components arrive next.
        </p>
        <div className="mt-8 inline-flex items-center gap-2 rounded-full border border-edge bg-white px-3 py-1.5 text-sm shadow-[0_1px_2px_rgba(17,18,22,.04)]">
          <span className="rounded-full bg-attention-tint px-2 py-0.5 text-xs font-semibold text-attention-ink">
            needs you
          </span>
          <span className="font-mono text-xs text-muted-400">the only colour that pulls the eye</span>
        </div>
      </main>
    </div>
  )
}
