import { expect, test } from "bun:test"
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parseFeature } from "../src/backlog"
import { draftFeature, haikuReply } from "../src/draft"

/**
 * The house format, as the prompt asks for it. The acceptance test is not that
 * this looks right: it is that `parseFeature` reads it back whole.
 */
const CLEAN = `# Widget export
- [ ] T1 Parse the manifest
- [ ] T2 Map records to rows
- [ ] T3 Write the CSV
`

/** A stub single-turn call. No test in this file may reach the real API. */
function replying(reply: string) {
  const prompts: string[] = []
  return {
    prompts,
    ask: async (prompt: string) => {
      prompts.push(prompt)
      return reply
    },
  }
}

/** The reply shape under test, drafted with a stub. */
function draft(reply: string) {
  return draftFeature("export widgets to csv", replying(reply).ask)
}

// --- The acceptance test: the parser, not a human's taste ---------------------

test("the drafted markdown round-trips through parseFeature", async () => {
  const d = await draft(CLEAN)
  const reparsed = parseFeature(d.markdown)

  expect(reparsed.title).toBe("Widget export")
  expect(reparsed.tasks.map((t) => t.text)).toEqual([
    "Parse the manifest",
    "Map records to rows",
    "Write the CSV",
  ])
  // The parse the function validated is the parse the caller gets.
  expect(d.feature).toEqual(reparsed)
})

test("every task line carries a T<n> ref, in order", async () => {
  // A ref-less task cannot be ticked at all: tickTask addresses by ref.
  const d = await draft(CLEAN)
  expect(d.feature.tasks.map((t) => t.ref)).toEqual(["T1", "T2", "T3"])
  expect(d.feature.tasks.every((t) => t.ref !== null)).toBe(true)
})

test("nothing comes back pre-ticked", async () => {
  const d = await draft(CLEAN)
  expect(d.feature.tasks.every((t) => !t.done)).toBe(true)
})

test("the draft ends in exactly one newline", async () => {
  const d = await draft("# T\n- [ ] T1 a")
  expect(d.markdown.endsWith("\n")).toBe(true)
  expect(d.markdown.endsWith("\n\n")).toBe(false)
})

// --- The enumeration: what a free-text reply can be --------------------------
// Accepted shapes keep the round-trip invariant; everything else refuses to
// produce a file, because refusing is recoverable and a file the parser
// misreads is the failure this project has already paid for fourteen times.

test("accepts a reply wrapped in a single fenced code block", async () => {
  const d = await draft("```markdown\n" + CLEAN + "```\n")
  expect(d.markdown).not.toContain("```")
  expect(d.feature).toEqual(parseFeature(d.markdown))
  expect(d.feature.tasks).toHaveLength(3)
})

test("accepts a fence with no info string", async () => {
  const d = await draft("```\n" + CLEAN + "```")
  expect(d.feature.tasks).toHaveLength(3)
})

test("accepts a preamble ahead of the title", async () => {
  const d = await draft("Here's your feature file:\n\n" + CLEAN)
  expect(d.markdown.startsWith("# Widget export")).toBe(true)
  expect(d.feature).toEqual(parseFeature(d.markdown))
})

test("accepts a preamble ahead of a fence", async () => {
  const d = await draft("Here's your feature file:\n\n```md\n" + CLEAN + "```\n")
  expect(d.feature.tasks).toHaveLength(3)
})

test("accepts trailing commentary after the list, tasks intact", async () => {
  // Nothing is guessed away: the region ends at the task list, the human is
  // editing the file anyway, and parseFeature still reads every task.
  const d = await draft(CLEAN + "\nLet me know if you want more detail.\n")
  expect(d.feature.tasks).toHaveLength(3)
  expect(d.feature.tasks.map((t) => t.ref)).toEqual(["T1", "T2", "T3"])
})

test("accepts CRLF line endings", async () => {
  const d = await draft(CLEAN.replaceAll("\n", "\r\n"))
  expect(d.feature.tasks).toHaveLength(3)
  expect(d.feature).toEqual(parseFeature(d.markdown))
})

test("refuses a refusal", async () => {
  await expect(draft("I can't help with that.")).rejects.toThrow(/no .*title|title/i)
})

test("refuses an empty reply", async () => {
  await expect(draft("")).rejects.toThrow(/empty/i)
})

test("refuses a whitespace-only reply", async () => {
  await expect(draft("   \n\n\t\n")).rejects.toThrow(/empty/i)
})

test("refuses valid markdown with no checkboxes", async () => {
  // The shape that renders in the UI as a feature with nothing in it.
  await expect(draft("# Widget export\n\nSome prose about widgets.\n")).rejects.toThrow(/no task/i)
})

test("refuses checkboxes with no refs", async () => {
  const noRefs = "# Widget export\n- [ ] Parse the manifest\n- [ ] Map records to rows\n"
  await expect(draft(noRefs)).rejects.toThrow(/ref/i)
})

test("refuses a single ref-less line among refs", async () => {
  const mixed = "# W\n- [ ] T1 a\n- [ ] b\n- [ ] T3 c\n"
  await expect(draft(mixed)).rejects.toThrow(/ref/i)
})

test("refuses duplicate refs", async () => {
  // tickTask throws on a duplicate ref, so the file would be half-unusable.
  await expect(draft("# W\n- [ ] T1 a\n- [ ] T1 b\n")).rejects.toThrow(/T1/)
})

test("refuses refs that skip a number", async () => {
  // A gap is the signature of a task the model dropped mid-reply.
  await expect(draft("# W\n- [ ] T1 a\n- [ ] T3 c\n")).rejects.toThrow(/T2|order|sequen/i)
})

test("refuses refs out of order", async () => {
  await expect(draft("# W\n- [ ] T2 b\n- [ ] T1 a\n")).rejects.toThrow(/order|sequen|T1/i)
})

test("refuses a reply truncated mid-checkbox", async () => {
  await expect(draft("# W\n- [ ] T1 a\n- [")).rejects.toThrow(/checkbox|truncat/i)
})

test("refuses a checkbox with no text", async () => {
  await expect(draft("# W\n- [ ] T1 a\n- [ ] \n")).rejects.toThrow(/checkbox|truncat|text/i)
})

test("refuses an indented checkbox", async () => {
  // An indented checkbox is not a task, so it can never be ticked, but it
  // renders to a human exactly like one.
  await expect(draft("# W\n- [ ] T1 a\n  - [ ] T2 b\n")).rejects.toThrow(/checkbox|column/i)
})

test("refuses a checkbox missing the space after the dash", async () => {
  await expect(draft("# W\n-[ ] T1 a\n")).rejects.toThrow(/checkbox|column/i)
})

test("refuses a pre-ticked task", async () => {
  await expect(draft("# W\n- [x] T1 a\n- [ ] T2 b\n")).rejects.toThrow(/ticked|done/i)
})

test("refuses a reply whose fences survive unwrapping", async () => {
  // Two fenced blocks: which one is the file is a guess, and backticks left in
  // the file would parse as tasks while rendering as noise.
  const twoFences = "```\n" + CLEAN + "```\n\nAnd an alternative:\n\n```\n# Other\n- [ ] T1 x\n```\n"
  await expect(draft(twoFences)).rejects.toThrow(/fence|```/)
})

test("refuses a checkbox ahead of the title rather than dropping it", async () => {
  // Dropping a preamble is safe only while the preamble holds no tasks.
  await expect(draft("- [ ] T1 stray\n\n" + CLEAN)).rejects.toThrow(/before the title|preamble|checkbox/i)
})

test("refuses checkboxes the parser does not count as tasks", async () => {
  // parseFeature ends the task region at the next heading, so this line
  // renders to a human as a task and is unreachable to tickTask. Every
  // well-formed task line in the file has to be a task the parser returned.
  const withNotes = CLEAN + "\n## Notes\n- [ ] T4 check the fixtures\n"
  await expect(draft(withNotes)).rejects.toThrow(/4 .*task|task line|region|heading/i)
})

test("refuses a reply with no title", async () => {
  await expect(draft("- [ ] T1 a\n- [ ] T2 b\n")).rejects.toThrow(/title/i)
})

// --- The slug: a regex, never a model ----------------------------------------

test("the path is docs/features/<slug>.md, slugged from the title", async () => {
  const d = await draft(CLEAN)
  expect(d.path).toBe("docs/features/widget-export.md")
})

test("punctuation and case collapse into the slug", async () => {
  const d = await draft("# Widget Export (v2) -- CSV!\n- [ ] T1 a\n")
  expect(d.path).toBe("docs/features/widget-export-v2-csv.md")
})

test("a traversal in the title cannot escape docs/features", async () => {
  const d = await draft("# ../../etc/passwd\n- [ ] T1 a\n")
  expect(d.path).toBe("docs/features/etc-passwd.md")
  expect(d.path.includes("..")).toBe(false)
})

test("a long title is capped", async () => {
  const title = "Export every widget record to a comma separated values file for the finance team"
  const d = await draft(`# ${title}\n- [ ] T1 a\n`)
  const slug = d.path.slice("docs/features/".length, -".md".length)
  expect(slug.length).toBeLessThanOrEqual(60)
  expect(slug.startsWith("export-every-widget")).toBe(true)
  expect(slug.endsWith("-")).toBe(false)
})

test("refuses a title that slugs to nothing", async () => {
  await expect(draft("# ???\n- [ ] T1 a\n")).rejects.toThrow(/slug|title/i)
})

// --- The input side ----------------------------------------------------------

test("refuses a blank description without spending a token", async () => {
  const stub = replying(CLEAN)
  await expect(draftFeature("   \n ", stub.ask)).rejects.toThrow(/description|empty/i)
  expect(stub.prompts).toEqual([])
})

test("the rough description reaches the model once", async () => {
  const stub = replying(CLEAN)
  await draftFeature("export widgets to csv", stub.ask)
  expect(stub.prompts).toHaveLength(1)
  expect(stub.prompts[0]).toContain("export widgets to csv")
})

// --- The envelope of one `claude -p --output-format json` run -----------------

const ok = (result: string) =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result })

test("reads the reply out of a success envelope", () => {
  expect(haikuReply({ stdout: ok("hello"), stderr: "", exitCode: 0 })).toBe("hello")
})

test("tolerates an envelope with no stop_reason", () => {
  const stdout = JSON.stringify({ type: "result", is_error: false, result: "hi" })
  expect(haikuReply({ stdout, stderr: "", exitCode: 0 })).toBe("hi")
})

test("reports the exit code and stderr when the CLI fails", () => {
  const run = { stdout: "", stderr: "could not reach the keychain", exitCode: 3 }
  expect(() => haikuReply(run)).toThrow(/exited 3/)
  expect(() => haikuReply(run)).toThrow(/keychain/)
})

test("quotes the output when it is not JSON", () => {
  const run = { stdout: "update available, run claude install", stderr: "", exitCode: 0 }
  expect(() => haikuReply(run)).toThrow(/update available/)
})

test("refuses a non-object envelope", () => {
  expect(() => haikuReply({ stdout: '"just a string"', stderr: "", exitCode: 0 })).toThrow()
})

test("refuses an is_error envelope", () => {
  const stdout = JSON.stringify({ type: "result", is_error: true, result: "boom" })
  expect(() => haikuReply({ stdout, stderr: "", exitCode: 0 })).toThrow(/boom|error/i)
})

test("names the subtype when the run ended in an error subtype", () => {
  // error_max_budget_usd returns an empty result, so an error subtype has to
  // outrank the emptiness check or the message says nothing useful.
  const stdout = JSON.stringify({ type: "result", subtype: "error_max_budget_usd", result: "" })
  expect(() => haikuReply({ stdout, stderr: "", exitCode: 0 })).toThrow(/error_max_budget_usd/)
})

test("refuses a reply that stopped at the token cap", () => {
  const stdout = JSON.stringify({
    type: "result",
    subtype: "success",
    stop_reason: "max_tokens",
    result: "# W\n- [ ] T1 a",
  })
  expect(() => haikuReply({ stdout, stderr: "", exitCode: 0 })).toThrow(/max_tokens|finish/)
})

test("refuses an envelope whose result is not a string", () => {
  const stdout = JSON.stringify({ type: "result", subtype: "success", result: { a: 1 } })
  expect(() => haikuReply({ stdout, stderr: "", exitCode: 0 })).toThrow(/result/)
})

// --- The seam: CLAUDE_BIN, so the fake binary can stand in -------------------

const repoRoot = join(import.meta.dir, "..")

test("the default call goes through CLAUDE_BIN on claude-haiku-5-5", async () => {
  const dir = join(repoRoot, ".orch-test", "draft-seam")
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })

  // A stub that records its argv and answers with one JSON result envelope.
  const argv = join(dir, "argv.txt")
  const stub = join(dir, "stub-claude")
  await writeFile(
    stub,
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argv)}\n` +
      `cat <<'JSON'\n${ok(CLEAN)}\nJSON\n`,
  )
  await chmod(stub, 0o755)

  // CLAUDE_BIN binds when src/version.ts loads, so the override has to be in
  // the environment of a fresh process.
  const probe = join(dir, "probe.ts")
  await writeFile(
    probe,
    `import { draftFeature } from ${JSON.stringify(join(repoRoot, "src/draft.ts"))}\n` +
      `const d = await draftFeature("export widgets to csv")\n` +
      `process.stdout.write(d.path + "\\n" + d.markdown)\n`,
  )

  const p = Bun.spawn([process.execPath, "run", probe], {
    env: { ...process.env, ORCH_CLAUDE_BIN: stub },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  if (code !== 0) throw new Error(`probe exited ${code}: ${err}`)

  expect(out.startsWith("docs/features/widget-export.md\n")).toBe(true)
  const args = (await readFile(argv, "utf8")).split("\n")
  expect(args).toContain("-p")
  expect(args).toContain("--output-format")
  expect(args).toContain("json")
  expect(args).toContain("--model")
  expect(args).toContain("claude-haiku-5-5")
  expect(args.some((a) => a.includes("export widgets to csv"))).toBe(true)
  // One answer, not a feed.
  expect(args).not.toContain("stream-json")
})
