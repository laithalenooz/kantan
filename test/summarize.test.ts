import { expect, test } from "bun:test"
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { summarizeStall } from "../src/summarize"

const FAILURE = `FAIL test/widget.test.ts > maps records
error: expected 3 rows, got 0
  at mapRecords (src/widget.ts:41:7)
`

/** Three outputs, as a stall always has. */
const THREE = [FAILURE, FAILURE, FAILURE]

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

// --- It is called only on a stall --------------------------------------------

test("refuses fewer than three outputs rather than handling them", async () => {
  // A stall is three identical failures. Anything shorter is a caller bug, and
  // silently summarizing two would hide it.
  for (const outputs of [[], [FAILURE], [FAILURE, FAILURE]]) {
    const stub = replying("it fails the same way every time")
    await expect(summarizeStall(outputs, stub.ask)).rejects.toThrow(/three|3/)
    expect(stub.prompts).toEqual([])
  }
})

test("refuses three blank outputs rather than inventing a cause", async () => {
  // A silent failure (exit code only, nothing on either stream) gives the
  // model nothing to read, so whatever it answers is invention.
  const stub = replying("the tests fail because of a missing fixture")
  await expect(summarizeStall(["", "  ", "\n"], stub.ask)).rejects.toThrow(/empty|blank|nothing/i)
  expect(stub.prompts).toEqual([])
})

test("accepts more than three outputs", async () => {
  const four = [...THREE, FAILURE]
  const { summary } = await summarizeStall(four, replying("same error each time").ask)
  expect(summary).toBe("same error each time")
})

test("does not require the outputs to be identical", async () => {
  // Whether a stall is real is the signature hash's call, not this function's,
  // and never a model's. Three differing outputs still summarize.
  const mixed = [FAILURE, FAILURE.replace("3 rows", "4 rows"), FAILURE]
  const { outputs } = await summarizeStall(mixed, replying("row count mismatch").ask)
  expect(outputs).toEqual(mixed)
})

// --- The summary is a convenience, never the evidence ------------------------

test("hands back the raw outputs beside the summary", async () => {
  // The UI shows the three raw outputs next to the summary, so the summary
  // must never be the only thing a caller holds.
  const result = await summarizeStall(THREE, replying("same assertion fails each run").ask)
  expect(result.summary).toBe("same assertion fails each run")
  expect(result.outputs).toEqual(THREE)
  expect(result.outputs[0]).toBe(FAILURE)
})

test("the carried outputs are not the caller's array", async () => {
  const live = [...THREE]
  const result = await summarizeStall(live, replying("one line").ask)
  live.push("a fourth run nobody summarized")
  expect(result.outputs).toHaveLength(3)
})

test("carries long outputs through untouched", async () => {
  const huge = "x".repeat(10_000)
  const result = await summarizeStall([huge, huge, huge], replying("it times out").ask)
  expect(result.outputs[0]).toHaveLength(10_000)
})

// --- One readable line for the UI --------------------------------------------

test("collapses a multi-line reply into one line", async () => {
  const { summary } = await summarizeStall(THREE, replying("row count\nis zero\n\nevery run").ask)
  expect(summary).toBe("row count is zero every run")
})

test("caps a long reply, because the raw outputs are beside it", async () => {
  const { summary } = await summarizeStall(THREE, replying("word ".repeat(200)).ask)
  expect(summary.length).toBeLessThanOrEqual(200)
  expect(summary.endsWith("...")).toBe(true)
})

test("refuses an empty summary rather than showing a blank line", async () => {
  await expect(summarizeStall(THREE, replying("   \n\n").ask)).rejects.toThrow(/empty/i)
})

// --- What the model is shown --------------------------------------------------

test("the model sees all three outputs", async () => {
  const stub = replying("same failure three times")
  const three = ["first failure", "second failure", "third failure"]
  await summarizeStall(three, stub.ask)
  expect(stub.prompts).toHaveLength(1)
  for (const output of three) expect(stub.prompts[0]).toContain(output)
})

test("bounds each output in the prompt without truncating the record", async () => {
  const huge = "y".repeat(50_000)
  const stub = replying("it times out")
  const result = await summarizeStall([huge, huge, huge], stub.ask)
  expect(stub.prompts[0]!.length).toBeLessThan(20_000)
  expect(result.outputs[0]).toHaveLength(50_000)
})

test("keeps the end of a long output, where the failure is", async () => {
  // A test runner prints the summary last, so a head-only window would show
  // the model nothing but passing-test noise.
  const long = `FIRST LINE\n${"passing noise\n".repeat(5_000)}LAST LINE: 3 failed`
  const stub = replying("three tests fail")
  await summarizeStall([long, long, long], stub.ask)
  expect(stub.prompts[0]).toContain("LAST LINE: 3 failed")
  expect(stub.prompts[0]).toContain("FIRST LINE")
})

// --- The seam: CLAUDE_BIN, so the fake binary can stand in -------------------

const repoRoot = join(import.meta.dir, "..")

test("the default call goes through CLAUDE_BIN on claude-haiku-5-5", async () => {
  const dir = join(repoRoot, ".kantan-test", "summarize-seam")
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })

  const argv = join(dir, "argv.txt")
  const stub = join(dir, "stub-claude")
  const envelope = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "the same assertion fails on every run",
  })
  // U+001F between arguments, not newlines: the prompt is itself multi-line.
  await writeFile(
    stub,
    `#!/bin/sh\nprintf '%s\\037' "$@" > ${JSON.stringify(argv)}\n` +
      `cat <<'JSON'\n${envelope}\nJSON\n`,
  )
  await chmod(stub, 0o755)

  // CLAUDE_BIN binds when src/version.ts loads, so the override has to be in
  // the environment of a fresh process.
  const probe = join(dir, "probe.ts")
  await writeFile(
    probe,
    `import { summarizeStall } from ${JSON.stringify(join(repoRoot, "src/summarize.ts"))}\n` +
      `const r = await summarizeStall(["boom", "boom", "boom"])\n` +
      `process.stdout.write(r.summary + "|" + r.outputs.length)\n`,
  )

  const p = Bun.spawn([process.execPath, "run", probe], {
    env: { ...process.env, KANTAN_CLAUDE_BIN: stub },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  if (code !== 0) throw new Error(`probe exited ${code}: ${err}`)

  expect(out).toBe("the same assertion fails on every run|3")

  // The terminating separator leaves an empty trailing field.
  const args = (await readFile(argv, "utf8")).split("\u001f").slice(0, -1)
  const valueOf = (flag: string) => {
    const at = args.indexOf(flag)
    return at === -1 ? `no ${flag} in argv` : args[at + 1]
  }
  expect(args).toContain("-p")
  expect(valueOf("--model")).toBe("claude-haiku-5-5")
  // One answer, not a feed.
  expect(valueOf("--output-format")).toBe("json")
  expect(args).not.toContain("stream-json")
  // No tools, so untrusted test output cannot talk the call into reading a
  // path out of a stack trace; no settings, CLAUDE.md, skills, hooks, plugins
  // or MCP servers, so nothing turns one bounded call into an agent run.
  expect(valueOf("--tools")).toBe("")
  expect(args).toContain("--safe-mode")
  expect(args).toContain("--strict-mcp-config")
  expect(valueOf("--max-budget-usd")).toBe("0.05")
})
