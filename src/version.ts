const CLAUDE_BIN = process.env.ORCH_CLAUDE_BIN ?? "claude"

/** The CLI version string, recorded in every run log header. */
export async function claudeVersion(): Promise<string> {
  const p = Bun.spawn([CLAUDE_BIN, "--version"], { stdout: "pipe" })
  const out = await new Response(p.stdout).text()
  const m = out.match(/(\d+\.\d+\.\d+)/)
  if (!m) throw new Error(`cannot parse version from: ${out.trim()}`)
  return m[1]!
}

export { CLAUDE_BIN }
