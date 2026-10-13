/**
 * The `claude` binary, overridable for a nonstandard install - and how every
 * test substitutes the fake one instead of spending money.
 *
 * `KANTAN_CLAUDE_BIN` is still accepted. The rename cost nothing to keep it, and
 * refusing it would silently start spawning the **real** `claude` in anyone's
 * harness that still sets the old name - a failure that bills money rather
 * than raising an error, which is the worst direction this variable has.
 */
const CLAUDE_BIN = process.env.KANTAN_CLAUDE_BIN ?? process.env.ORCH_CLAUDE_BIN ?? "claude"

/**
 * The CLI version string, recorded in every run log header because the
 * stream-json envelope shape depends on it.
 *
 * Reports the exit code and stderr on failure. Reading stdout alone turns a
 * missing or broken binary into "cannot parse version from:" with an empty
 * tail, which says nothing about what went wrong, and a wrong `KANTAN_CLAUDE_BIN`
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
