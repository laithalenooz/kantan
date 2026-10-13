import { expect, test } from "bun:test"
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { summarizeRun, summarizeStall, tailLine } from "../src/summarize"

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

// --- Summarizing one test run -----------------------------------------------

/**
 * **The agent writes the sentence; the exit code still decides the verdict.**
 *
 * This exists because the mechanical version was actively misleading. The
 * summary beside a trial run was the last non-empty line of output, and a real
 * run of `npm test` that **passed** showed:
 *
 *     npm error A complete log of this run can be found in: /home/…/2026-10-13…
 *
 * Exit 0, and a summary saying "error". The last line of output is not the
 * summary of the output; npm, cargo, pytest and gradle all put something else
 * there.
 *
 * The dividing line, which is the whole reason this is safe: the agent may
 * write text that appears **inside** a surface. It may never decide what
 * surface appears, or what a status says. So the exit code is passed to the
 * model only so its sentence cannot contradict what the reader can already
 * see - and the chip, the colour and the pass/fail branch all still come from
 * the number. Nothing here is on the run's decision path.
 */
const PASSING = `
> importer@1.0.0 test
> bun test

 24 pass
 0 fail
 112 expect() calls
Ran 24 tests across 6 files. [1.20s]

npm error A complete log of this run can be found in: /home/dev/.npm/_logs/2026-10-13T06_52_21_824Z-debug-0.log
`

test("the agent's sentence replaces the last line, which was not a summary", async () => {
  const { ask, prompts } = replying("24 tests passed across 6 files in 1.2 seconds.")
  const said = await summarizeRun({ exitCode: 0, stdout: PASSING, stderr: "" }, ask)

  expect(said).toEqual({ text: "24 tests passed across 6 files in 1.2 seconds.", by: "agent" })
  // What the mechanical reader would have said, for contrast - and it is still
  // what this falls back to.
  expect(tailLine({ stdout: PASSING, stderr: "" })).toContain("npm error")
})

test("the provenance travels with the text, so a surface can mark it", async () => {
  /* The same discipline as `EndRecord.verifiedBy`: a reader that cannot tell
   * who wrote a sentence cannot mark it, and unmarked model prose sitting
   * beside measured figures is the thing this project refuses to ship. There
   * are exactly two values and no third that blurs them. */
  const { ask } = replying("One suite failed.")
  expect((await summarizeRun({ exitCode: 1, stdout: "x", stderr: "" }, ask)).by).toBe("agent")

  const broken: typeof ask = () => Promise.reject(new Error("no model today"))
  expect((await summarizeRun({ exitCode: 1, stdout: "last thing\n", stderr: "" }, broken)).by).toBe("tail")
})

test("a model that fails degrades to the tail rather than failing the control", async () => {
  // Unlike `summarizeStall`, which throws: this one answers a button somebody
  // pressed, and an exit code with no sentence beside it is still the answer
  // they asked for. The summary is a convenience and must never be a blocker.
  const broken = (): Promise<string> => Promise.reject(new Error("rate limited"))
  const said = await summarizeRun({ exitCode: 3, stdout: "1 failing\n", stderr: "" }, broken)
  expect(said).toEqual({ text: "1 failing", by: "tail" })
})

test("the exit code is in the prompt, so the sentence cannot contradict the chip", async () => {
  const { ask, prompts } = replying("Two assertions failed in the importer.")
  await summarizeRun({ exitCode: 3, stdout: "nope\n", stderr: "" }, ask)

  expect(prompts[0]).toContain("exited 3")
  /* And the prompt says the model does not get a verdict, in those words. The
   * exit code is the verdict; a model adding "so the build is broken" would be
   * deciding what a status says. */
  expect(prompts[0]).toContain("no verdict of your own")
})

test("nothing is summarized when there is nothing to read", async () => {
  /* A silent failure - an exit code and both streams empty - gives the model
   * nothing, so any sentence would be invention. The same rule
   * `summarizeStall` holds, with the softer consequence this caller needs. */
  let asked = 0
  const ask = async (): Promise<string> => {
    asked += 1
    return "something confident"
  }
  for (const out of [
    { exitCode: 1, stdout: "", stderr: "" },
    { exitCode: 0, stdout: "   \n\n", stderr: "  " },
  ]) {
    expect(await summarizeRun(out, ask)).toEqual({ text: "", by: "tail" })
  }
  expect(asked).toBe(0)
})

test("a long output is excerpted from both ends, and the line is capped", async () => {
  // A runner prints the command first and the failure last, so a head-only
  // window shows passing-test noise and nothing of what broke - the reason
  // `excerpt` exists for the stall path too.
  const { ask, prompts } = replying("x".repeat(400))
  const said = await summarizeRun(
    { exitCode: 1, stdout: `HEAD-MARKER\n${"filler ".repeat(5000)}\nTAIL-MARKER`, stderr: "" },
    ask,
  )
  expect(prompts[0]).toContain("HEAD-MARKER")
  expect(prompts[0]).toContain("TAIL-MARKER")
  expect(prompts[0]).toContain("characters cut")
  expect(said.text.length).toBeLessThanOrEqual(200)
  expect(said.text.endsWith("...")).toBe(true)
})

test("stderr is read when stdout says nothing, which is where runners print failures", async () => {
  const { ask, prompts } = replying("The suite could not start.")
  await summarizeRun({ exitCode: 1, stdout: "", stderr: "cannot find module\n" }, ask)
  expect(prompts[0]).toContain("cannot find module")
})

test("a reply with newlines becomes one line, because the row is one line", async () => {
  const { ask } = replying("Two tests failed.\n\nBoth in the importer.\n")
  expect((await summarizeRun({ exitCode: 1, stdout: "x", stderr: "" }, ask)).text).toBe(
    "Two tests failed. Both in the importer.",
  )
})

test("an empty reply is not a summary, so it falls back rather than blanking the row", async () => {
  const { ask } = replying("   \n  ")
  expect(await summarizeRun({ exitCode: 1, stdout: "3 failing\n", stderr: "" }, ask)).toEqual({
    text: "3 failing",
    by: "tail",
  })
})
