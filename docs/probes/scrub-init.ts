/**
 * Strips a machine's own details out of a recorded stream-json run.
 *
 * Two places carry them, and the second is the worse one.
 *
 *   bun run docs/probes/scrub-init.ts test/fixtures/*.jsonl    # rewrite
 *   bun run docs/probes/scrub-init.ts --check test/fixtures/*.jsonl
 *
 * **Run this over any new recording before committing it.** A real `claude -p`
 * run opens with a `system/init` event, and that event is an inventory of the
 * machine it ran on: every skill, every slash command, every tool - so every
 * connected integration - every MCP server with its connection status, every
 * plugin with its version and cache path, the auto-memory directory, and a
 * socket path carrying a uid and a pid. No credentials, which is why three of
 * these sat in a public repository without anyone noticing; a detailed map of
 * one person's tooling all the same, and of no use to this project.
 *
 * It had been missed once already. An earlier pass rewrote the home directory
 * to `/home/user`, so searching for the username came up clean while the
 * inventory sat untouched two fields away. Searching for the *shape* of private
 * data beats searching for the strings you happen to remember - which is also
 * how the second place turned up: a scrub of `init` alone left the word
 * `superpowers` in the files 28 times.
 *
 * **`system/hook_response` embeds the output of the SessionStart hooks**, which
 * is whatever that machine's hooks inject - in the recordings here, the entire
 * text of a personal skill, 51 KB of it across three files. More revealing than
 * the inventory, because it is the configuration itself rather than a list of
 * its names. The parser yields **nothing** for these: `hook_response` is in
 * `FILTERED_HOOK_SUBTYPES`, so the payload is unread, and only the envelope has
 * to survive. One test counts `hook_started` events and none looks at an
 * `output`.
 *
 * **What must survive, because something reads it.** `system()` in
 * `src/stream.ts` takes `cwd`, `session_id`, and `count(tools)` and
 * `count(skills)` - the lengths, not the contents - and `src/ui/Row.tsx`
 * renders those two counts. So every array keeps its exact length and every
 * field keeps its type: only the names inside change. A fixture is a record of
 * the envelope's shape, and a scrub that changed the shape would quietly
 * destroy the thing it was kept for.
 *
 * Built-in names stay: `Bash`, `Read`, `doctor` and the protocol capabilities
 * are Claude Code's own vocabulary, identical on every machine, and keeping
 * them leaves the fixture readable as the real thing it is. Only what is
 * installed, connected or personal is replaced.
 */

const pad = (n: number, w: number) => String(n).padStart(w, "0")

/** Names that say what someone installed, rather than what the CLI ships. */
function scrubTools(tools: unknown[]): unknown[] {
  let n = 0
  return tools.map((t) =>
    typeof t === "string" && t.startsWith("mcp__") ? `mcp__example__tool_${pad(++n, 2)}` : t,
  )
}

/**
 * A hook's captured output, replaced where there is any.
 *
 * Empty strings stay empty: most of these events carry `""` already, and a
 * fixture that showed every hook producing output would misrepresent what a run
 * looks like.
 */
function scrubHookResponse(e: Record<string, unknown>): { event: Record<string, unknown>; changed: string[] } {
  const changed: string[] = []
  const out = { ...e }
  for (const key of ["output", "stdout", "stderr"]) {
    const v = e[key]
    if (typeof v !== "string" || v === "") continue
    const after =
      key === "output"
        ? '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"[scrubbed]"}}'
        : "[scrubbed]"
    out[key] = after
    // Compared, not merely non-empty: reporting on "there is a string here"
    // made `--check` claim a scrubbed file was still dirty, because the
    // placeholder is a string too. The same slip as in `list()` below, made
    // twice in one file.
    if (after !== v) changed.push(`${key}[${v.length}b]`)
  }
  return { event: out, changed }
}

function scrubInit(e: Record<string, unknown>): { event: Record<string, unknown>; changed: string[] } {
  const changed: string[] = []
  const out = { ...e }
  /* Reports only a real difference, so `--check` is idempotent and can mean
     "does this still carry an inventory?" rather than "does this have arrays?".
     The first version pushed unconditionally and so could never report clean -
     caught by running `--check` straight after a successful scrub. */
  const list = (key: string, make: (i: number) => unknown) => {
    const v = e[key]
    if (!Array.isArray(v)) return
    const after = v.map((_, i) => make(i))
    out[key] = after
    if (JSON.stringify(after) !== JSON.stringify(v)) changed.push(`${key}[${v.length}]`)
  }

  if (Array.isArray(e.tools)) {
    const before = JSON.stringify(e.tools)
    const after = scrubTools(e.tools)
    if (JSON.stringify(after) !== before) changed.push(`tools[${e.tools.length}]`)
    out.tools = after
  }
  list("skills", (i) => `skill-${pad(i + 1, 3)}`)
  list("slash_commands", (i) => `command-${pad(i + 1, 3)}`)
  list("agents", (i) => `agent-${pad(i + 1, 2)}`)
  // `status` and `source` are kept: a server that `needs-auth` is a real state
  // worth having in a fixture, and neither field names anything personal.
  list("mcp_servers", (i) => {
    const was = (e.mcp_servers as Record<string, unknown>[])[i] ?? {}
    return { ...was, name: `example-server-${pad(i + 1, 2)}` }
  })
  list("plugins", (i) => {
    const was = (e.plugins as Record<string, unknown>[])[i] ?? {}
    const name = `example-plugin-${pad(i + 1, 2)}`
    return {
      ...was,
      name,
      path: `/home/user/.claude/plugins/cache/${name}`,
      source: `${name}@example-marketplace`,
      ...(was.version === undefined ? {} : { version: "1.0.0" }),
    }
  })

  if (e.memory_paths !== null && typeof e.memory_paths === "object") {
    const after = Object.fromEntries(
      Object.keys(e.memory_paths as object).map((k) => [k, "/home/user/.claude/projects/example/memory/"]),
    )
    out.memory_paths = after
    if (JSON.stringify(after) !== JSON.stringify(e.memory_paths)) changed.push("memory_paths")
  }
  if (typeof e.messaging_socket_path === "string") {
    const after = "/run/user/1000/cc-socks/000000.sock"
    out.messaging_socket_path = after
    if (after !== e.messaging_socket_path) changed.push("messaging_socket_path")
  }
  return { event: out, changed }
}

const args = process.argv.slice(2)
const check = args.includes("--check")
const files = args.filter((a) => a !== "--check")
if (files.length === 0) {
  console.error("usage: bun run docs/probes/scrub-init.ts [--check] <file.jsonl>...")
  process.exit(2)
}

let dirty = 0
for (const file of files) {
  const text = await Bun.file(file).text()
  // Line by line, and only the init lines are rewritten: everything else keeps
  // its bytes, because a fixture is only worth what it faithfully records.
  const lines = text.split("\n")
  const out: string[] = []
  const notes: string[] = []
  for (const line of lines) {
    if (line.trim() === "") {
      out.push(line)
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      out.push(line)
      continue
    }
    const e = parsed as Record<string, unknown>
    if (e.type !== "system" || (e.subtype !== "init" && e.subtype !== "hook_response")) {
      out.push(line)
      continue
    }
    const { event, changed } = e.subtype === "init" ? scrubInit(e) : scrubHookResponse(e)
    if (changed.length > 0) notes.push(`${String(e.subtype)}: ${changed.join(" ")}`)
    out.push(JSON.stringify(event))
  }
  if (notes.length === 0) {
    console.log(`clean  ${file}`)
    continue
  }
  dirty++
  console.log(`${check ? "DIRTY" : "wrote"}  ${file}`)
  for (const n of notes) console.log(`         ${n}`)
  if (!check) await Bun.write(file, out.join("\n"))
}

if (check && dirty > 0) {
  console.error(`\n${dirty} file(s) still carry an inventory. Run without --check to scrub them.`)
  process.exit(1)
}
