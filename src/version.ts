const CLAUDE_BIN = process.env.ORCH_CLAUDE_BIN ?? "claude"

/**
 * The CLI version string, recorded in every run log header because the
 * stream-json envelope shape depends on it.
 *
 * Reports the exit code and stderr on failure. Reading stdout alone turns a
 * missing or broken binary into "cannot parse version from:" with an empty
 * tail, which says nothing about what went wrong, and a wrong `ORCH_CLAUDE_BIN`
 * is one of the likelier ways to misconfigure this tool.
 */
export async function claudeVersion(): Promise<string> {
  let p
  try {
    p = Bun.spawn([CLAUDE_BIN, "--version"], { stdout: "pipe", stderr: "pipe" })
  } catch (cause) {
    // Bun throws synchronously when the binary does not exist.
    throw new Error(`cannot run ${CLAUDE_BIN}: ${(cause as Error).message}`, { cause })
  }

  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])

  if (code !== 0) {
    throw new Error(`${CLAUDE_BIN} --version exited ${code}: ${(err || out).trim() || "no output"}`)
  }

  const m = out.match(/(\d+\.\d+\.\d+)/)
  if (!m) throw new Error(`cannot parse a version from ${CLAUDE_BIN} --version: ${out.trim() || "no output"}`)
  return m[1]!
}

export { CLAUDE_BIN }
