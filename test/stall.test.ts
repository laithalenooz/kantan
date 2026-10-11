import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { failureSignature, type TestOutcome } from "../src/stall"

const FIXTURES = join(import.meta.dir, "fixtures")
const JUNIT = join(FIXTURES, "junit")
const STDOUT_MARK = "--8<-- stdout --8<--\n"
const STDERR_MARK = "--8<-- stderr --8<--\n"

/**
 * Loads one captured run from `test/fixtures/output/`. The format is described
 * in `test/fixtures/output/README.md`: a header line, then each stream verbatim behind
 * a marker line. The marker is checked for uniqueness, because a capture that
 * happened to contain it would silently truncate.
 */
async function capture(name: string): Promise<TestOutcome> {
  const raw = await Bun.file(join(FIXTURES, "output", `${name}.txt`)).text()
  const nl = raw.indexOf("\n")
  const header = raw.slice(0, nl)
  const m = header.match(/^kantan-fixture v1 exit=(\d+)$/)
  if (!m) throw new Error(`${name}: unexpected fixture header: ${header}`)
  const body = raw.slice(nl + 1)
  if (!body.startsWith(STDOUT_MARK)) throw new Error(`${name}: missing stdout marker`)
  const rest = body.slice(STDOUT_MARK.length)
  const i = rest.indexOf(STDERR_MARK)
  if (i < 0) throw new Error(`${name}: missing stderr marker`)
  if (i !== rest.lastIndexOf(STDERR_MARK)) throw new Error(`${name}: stderr marker is not unique`)
  return {
    exitCode: Number(m[1]),
    stdout: rest.slice(0, i),
    stderr: rest.slice(i + STDERR_MARK.length),
  }
}

/**
 * The runners captured in `test/fixtures/output/`, by fixture prefix. Each one
 * is put through the same five tests below, which is the point: a normalizer
 * tuned to one runner is not a normalizer, and Pest, Jest and `dart test` each
 * broke a rule that the first five had agreed on.
 */
const RUNNERS = ["bun", "pytest", "go", "cargo", "phpunit", "pest", "jest", "dart"] as const

// ---------------------------------------------------------------------------
// Shape and determinism
// ---------------------------------------------------------------------------

test("a signature is a stable hex digest", async () => {
  const o = await capture("bun-base-run1")
  const a = await failureSignature(o)
  expect(a).toMatch(/^[0-9a-f]{64}$/)
  expect(await failureSignature(o)).toBe(a)
})

// ---------------------------------------------------------------------------
// The over-stripping end: the same failure must hash the same, or a converging
// run is interrupted. One case per captured runner format.
// ---------------------------------------------------------------------------

for (const runner of RUNNERS) {
  test(`${runner}: two runs of one failure hash equal despite timing, pids, temp dirs and colour`, async () => {
    const a = await failureSignature(await capture(`${runner}-base-run1`))
    const b = await failureSignature(await capture(`${runner}-base-run2`))
    expect(b).toBe(a)
  })

  // The loop kantan is trying to detect always has an agent edit between the
  // two runs, so every line number in the output has moved. If that reaches
  // the hash, no real loop is ever detected and the run grinds to its budget.
  test(`${runner}: an edit that shifts every line number still hashes equal`, async () => {
    const a = await failureSignature(await capture(`${runner}-base-run1`))
    const b = await failureSignature(await capture(`${runner}-base-edited`))
    expect(b).toBe(a)
  })
}

// ---------------------------------------------------------------------------
// The under-stripping end: genuinely different failures must hash differently,
// or a stall fires on progress.
// ---------------------------------------------------------------------------

for (const runner of RUNNERS) {
  test(`${runner}: the same test failing with a different assertion message hashes differently`, async () => {
    const a = await failureSignature(await capture(`${runner}-base-run1`))
    const b = await failureSignature(await capture(`${runner}-msg`))
    expect(b).not.toBe(a)
  })

  test(`${runner}: a different test failing hashes differently`, async () => {
    const a = await failureSignature(await capture(`${runner}-base-run1`))
    const b = await failureSignature(await capture(`${runner}-other`))
    expect(b).not.toBe(a)
  })

  test(`${runner}: one failure hashes differently from two`, async () => {
    const a = await failureSignature(await capture(`${runner}-base-run1`))
    const b = await failureSignature(await capture(`${runner}-one`))
    expect(b).not.toBe(a)
  })
}

// ---------------------------------------------------------------------------
// Exit code
// ---------------------------------------------------------------------------

test("the exit code is part of the signature", async () => {
  const o = await capture("bun-base-run1")
  const one = await failureSignature({ ...o, exitCode: 1 })
  const two = await failureSignature({ ...o, exitCode: 2 })
  expect(two).not.toBe(one)
})

test("a passing run still produces a signature, distinct from the failing one", async () => {
  // failureSignature is total: it does not inspect the exit code to decide
  // whether to answer. Comparing signatures only means something for runs that
  // failed, and that is the caller's contract, documented in src/stall.ts.
  const pass = await failureSignature(await capture("bun-pass"))
  expect(pass).toMatch(/^[0-9a-f]{64}$/)
  expect(pass).not.toBe(await failureSignature(await capture("bun-base-run1")))
})

test("pest: a bare right-aligned per-test duration does not reach the signature", async () => {
  // The other fixtures run in hundredths of a second, so their durations happen
  // to match and cannot prove this. These two are a real pair from a test that
  // sleeps a random 40-400ms, and they differ in nothing else.
  const a = await failureSignature(await capture("pest-slow-run1"))
  const b = await failureSignature(await capture("pest-slow-run2"))
  expect(b).toBe(a)
})

test("go: a cached rerun hashes equal to the uncached one", async () => {
  // `ok pkg 0.002s` on the first run becomes `ok pkg (cached)` on the second,
  // so a duration rule that only knows about digits misses it. Both captures
  // are real: `go clean -testcache`, run, run again.
  const a = await failureSignature(await capture("go-pass-run1"))
  const b = await failureSignature(await capture("go-pass-run2"))
  expect(b).toBe(a)
})

// ---------------------------------------------------------------------------
// JUnit XML: the preferred branch
// ---------------------------------------------------------------------------

/** An outcome whose output is deliberately useless, so only the report can speak. */
function reported(path: string, exitCode = 1, noise = ""): TestOutcome {
  return { exitCode, stdout: `nothing useful here ${noise}`, stderr: "", reportPath: path }
}

test("a JUnit report is preferred over the output", async () => {
  const a = await failureSignature(reported(join(JUNIT, "pytest-base-run1.xml"), 1, "run A"))
  const b = await failureSignature(reported(join(JUNIT, "pytest-base-run1.xml"), 1, "run B"))
  expect(b).toBe(a)
})

for (const [runner, first, second] of [
  ["pytest", "pytest-base-run1.xml", "pytest-base-reordered.xml"],
  ["phpunit", "phpunit-base-run1.xml", "phpunit-base-reordered.xml"],
] as const) {
  test(`${runner}: failing test names are read order-independently`, async () => {
    const a = await failureSignature(reported(join(JUNIT, first)))
    const b = await failureSignature(reported(join(JUNIT, second)))
    expect(b).toBe(a)
  })

  test(`${runner}: a different failing set hashes differently`, async () => {
    const a = await failureSignature(reported(join(JUNIT, first)))
    const b = await failureSignature(reported(join(JUNIT, `${runner}-other.xml`)))
    expect(b).not.toBe(a)
  })
}

test("the exit code is part of the signature on the report branch too", async () => {
  const p = join(JUNIT, "phpunit-base-run1.xml")
  expect(await failureSignature(reported(p, 2))).not.toBe(await failureSignature(reported(p, 1)))
})

test("nested testsuites are flattened, so PHPUnit's three levels are read", async () => {
  // PHPUnit nests testsuite/testsuite/testsuite; the two failing cases live at
  // the innermost level. If nesting were not handled the set would be empty and
  // the signature would fall back to the (useless) output.
  const a = await failureSignature(reported(join(JUNIT, "phpunit-base-run1.xml"), 1, "A"))
  const b = await failureSignature(reported(join(JUNIT, "phpunit-base-run1.xml"), 1, "B"))
  expect(b).toBe(a)
})

test("the failing-test identity includes the class, not just the method name", async () => {
  // A rule probe, not a capture: pytest writes the bare function name, so two
  // modules with a test of the same name would otherwise collide.
  const dir = await mkdtemp(join(tmpdir(), "kantan-stall-"))
  try {
    const one = join(dir, "one.xml")
    const two = join(dir, "two.xml")
    const xml = (cls: string) =>
      `<testsuite><testcase classname="${cls}" name="test_add"><failure message="boom"/></testcase></testsuite>`
    await writeFile(one, xml("tests.test_alpha"))
    await writeFile(two, xml("tests.test_beta"))
    expect(await failureSignature(reported(two))).not.toBe(await failureSignature(reported(one)))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("an errored case counts as failing and a skipped one does not", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kantan-stall-"))
  try {
    const errored = join(dir, "errored.xml")
    const skipped = join(dir, "skipped.xml")
    await writeFile(
      errored,
      `<testsuite><testcase classname="C" name="a"><error message="exploded"/></testcase>` +
        `<testcase classname="C" name="b"/></testsuite>`,
    )
    await writeFile(
      skipped,
      `<testsuite><testcase classname="C" name="a"><skipped/></testcase>` +
        `<testcase classname="C" name="b"/></testsuite>`,
    )
    // The errored report has a failing set, so it uses the report branch. The
    // skipped one has none, so it falls back to the output and cannot match.
    expect(await failureSignature(reported(skipped))).not.toBe(await failureSignature(reported(errored)))
    expect(await failureSignature(reported(skipped))).toBe(
      await failureSignature({ exitCode: 1, stdout: "nothing useful here ", stderr: "" }),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// JUnit XML: every way the file can let us down
// ---------------------------------------------------------------------------

/** The same outcome without a report, which is what a fallback must produce. */
function unreported(o: TestOutcome): TestOutcome {
  const { reportPath, ...rest } = o
  return rest
}

for (const [what, file] of [
  ["an empty report", "empty.xml"],
  ["a report truncated mid-element by a crashed runner", "phpunit-truncated.xml"],
] as const) {
  test(`${what} falls back to the output instead of throwing`, async () => {
    const o = reported(join(JUNIT, file))
    expect(await failureSignature(o)).toBe(await failureSignature(unreported(o)))
  })
}

test("a truncated report does not hash as its partial failing set", async () => {
  // phpunit-truncated.xml holds one complete failing <testcase> before the cut.
  // A scanner that does not insist on well-formedness returns just that case
  // and reports a stall against a run that failed differently.
  const truncated = await failureSignature(reported(join(JUNIT, "phpunit-truncated.xml")))
  const dir = await mkdtemp(join(tmpdir(), "kantan-stall-"))
  try {
    const partial = join(dir, "partial.xml")
    await writeFile(
      partial,
      `<testsuites><testsuite name="kantan"><testsuite name="CalcTest">` +
        `<testcase name="testAddsTwoNumbers" class="CalcTest" classname="CalcTest">` +
        `<failure type="PHPUnit\\Framework\\ExpectationFailedException">boom</failure>` +
        `</testcase></testsuite></testsuite></testsuites>`,
    )
    expect(truncated).not.toBe(await failureSignature(reported(partial)))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a reportPath that does not exist falls back silently", async () => {
  const o = reported(join(JUNIT, "this-run-never-wrote-one.xml"))
  expect(await failureSignature(o)).toBe(await failureSignature(unreported(o)))
})

test("a reportPath pointing at a directory falls back rather than throwing", async () => {
  const o = reported(JUNIT)
  expect(await failureSignature(o)).toBe(await failureSignature(unreported(o)))
})

test("a well-formed report with no failing cases falls back, even on a non-zero exit", async () => {
  // A collection error, a lint step before the tests, or a coverage gate fails
  // the command without failing a test. Hashing the empty set would make every
  // such crash look identical to every other.
  const o = reported(join(JUNIT, "pytest-pass.xml"))
  expect(await failureSignature(o)).toBe(await failureSignature(unreported(o)))
})

test("a report that is not XML at all falls back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kantan-stall-"))
  try {
    const junk = join(dir, "junit.xml")
    await writeFile(junk, "Fatal error: allowed memory size exhausted\n")
    const o = reported(junk)
    expect(await failureSignature(o)).toBe(await failureSignature(unreported(o)))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Bounded reading
// ---------------------------------------------------------------------------

const DEEP_STACK = Array.from(
  { length: 120_000 },
  (_, i) => `    at deepFrame${i} (/srv/app/src/deep.ts)`,
).join("\n")

/** Five megabytes of stack frames, with `head` before them and `tail` after. */
function big(head: string, tail: string): string {
  return `${head}\n${DEEP_STACK}\n${tail}`
}

test("five megabytes of stack traces hash on the tail, so earlier output is ignored", async () => {
  const tail = (await capture("bun-base-run1")).stderr
  const a = { exitCode: 1, stdout: big("Suite A started, 412 files", tail), stderr: "" }
  const b = { exitCode: 1, stdout: big("Suite B started, 9 files", tail), stderr: "" }
  expect(a.stdout.length).toBeGreaterThan(5_000_000)
  expect(await failureSignature(b)).toBe(await failureSignature(a))
})

test("a difference inside the tail window is still seen in a huge output", async () => {
  const tail = (await capture("bun-base-run1")).stderr
  const a = { exitCode: 1, stdout: big("Suite A", tail), stderr: "" }
  const b = { exitCode: 1, stdout: big("Suite A", `${tail}Expected: 99\n`), stderr: "" }
  expect(await failureSignature(b)).not.toBe(await failureSignature(a))
})

test("the truncation marker src/testrun.ts prepends does not carry its byte counts", async () => {
  // The marker holds a count that changes every run, so two runs of one failure
  // would hash differently if it reached the digest. Reading the tail puts it
  // outside the window at the real cap; this covers it directly.
  const tail = (await capture("bun-base-run1")).stderr
  const marker = (dropped: number) =>
    `[kantan: stdout truncated - dropped the first ${dropped} bytes, kept the last 1048576]\n${tail}`
  await same(marker(4_194_304), marker(9_001_221))
  await differ(marker(4_194_304), tail)
})

test("a timeout is its own failure: two identical hangs stall, and a hang is not a failure", async () => {
  // runTests reports TIMEOUT_EXIT_CODE (124) for a killed run whatever the
  // command returned, because a watch-mode runner that traps SIGTERM exits 0.
  const partial = { stdout: "RUN  v2.1.9\n\n test/calc.test.ts\n", stderr: "" }
  const first = await failureSignature({ ...partial, exitCode: 124 })
  const second = await failureSignature({ ...partial, exitCode: 124 })
  expect(second).toBe(first)
  expect(await failureSignature({ ...partial, exitCode: 1 })).not.toBe(first)
})

test("stdout and stderr are hashed as separate streams", async () => {
  // bun writes failures to stderr and go to stdout. Concatenating them would
  // make a run that moved a line between streams look unchanged.
  const a = { exitCode: 1, stdout: "error: boom\n", stderr: "" }
  const b = { exitCode: 1, stdout: "", stderr: "error: boom\n" }
  expect(await failureSignature(b)).not.toBe(await failureSignature(a))
})

// ---------------------------------------------------------------------------
// The rule matrix: inputs each normalization rule's regex could reach but must
// not change. These are rule probes, so they are written rather than captured.
// ---------------------------------------------------------------------------

async function differ(a: string, b: string): Promise<void> {
  const sa = await failureSignature({ exitCode: 1, stdout: a, stderr: "" })
  const sb = await failureSignature({ exitCode: 1, stdout: b, stderr: "" })
  expect(sb).not.toBe(sa)
}

async function same(a: string, b: string): Promise<void> {
  const sa = await failureSignature({ exitCode: 1, stdout: a, stderr: "" })
  const sb = await failureSignature({ exitCode: 1, stdout: b, stderr: "" })
  expect(sb).toBe(sa)
}

test("bare integers survive: they are what usually distinguishes two failures", async () => {
  await differ("error: expected\n\nExpected: 5\nReceived: 4\n", "error: expected\n\nExpected: 7\nReceived: 4\n")
})

test("a duration inside an assertion message survives", async () => {
  await differ('Expected: "took 1.2s"\n', 'Expected: "took 1.25s"\n')
  await differ("Expected: 250ms\nReceived: 1000ms\n", "Expected: 500ms\nReceived: 1000ms\n")
})

test("a runner's own duration does not survive", async () => {
  await same("(fail) adds numbers [0.24ms]\n", "(fail) adds numbers [11.07ms]\n")
  await same("--- FAIL: TestAdd (0.00s)\n", "--- FAIL: TestAdd (1.42s)\n")
  await same("Time: 00:00.003, Memory: 14.00 MB\n", "Time: 00:12.991, Memory: 22.50 MB\n")
  await same("test result: FAILED. finished in 0.00s\n", "test result: FAILED. finished in 3.91s\n")
})

test("an indented summary line is normalized too, because Jest indents its Time", async () => {
  await same("Tests:       3 failed, 1 passed\n  Time:        2.14s\n", "Tests:       3 failed, 1 passed\n  Time:        19.07s\n")
})

test("a field called time inside an asserted object survives", async () => {
  // The summary rule reaches past a comma for PHPUnit's `Time: ..., Memory:
  // ...`, which puts it one step from every object dump that has a time field.
  await differ("expected { id: 1, time: 5 } to equal { id: 1, time: 6 }\n", "expected { id: 1, time: 7 } to equal { id: 1, time: 6 }\n")
  await differ("retried { time: 3 steps }\n", "retried { time: 4 steps }\n")
  await differ("expected { time: 12:30 }\n", "expected { time: 12:45 }\n")
})

test("a path outside the system temp root survives, because the project path does not move", async () => {
  await differ(
    "Failed asserting that 4 is identical to 5.\n\n/srv/app/tests/FooTest.php\n",
    "Failed asserting that 4 is identical to 5.\n\n/srv/app/tests/BarTest.php\n",
  )
})

test("a temp path does not survive, because it is new on every run", async () => {
  await same(
    "Received: /tmp/tmp.GjRL1fl42h/kantan-wnFLPb/junit.xml\n",
    "Received: /tmp/tmp.r8vtKLYyTy/kantan-gKSUNc/junit.xml\n",
  )
})

test("a hex literal in an assertion survives; a printed address does not", async () => {
  await differ("Expected: 0xdeadbeef\n", "Expected: 0xcafebabe\n")
  await same("<Foo object at 0x7f3a1c0d4e50>\n", "<Foo object at 0x7f91bb2d9110>\n")
})

test("a seed, a worker id and a thread id do not survive", async () => {
  await same("Random Seed:   1760184308\n", "Random Seed:   1760199999\n")
  await same("[gw2] PASSED tests/test_a.py\n", "[gw7] PASSED tests/test_a.py\n")
  await same("thread 'tests::adds' (738104) panicked at src/lib.rs:26:9:\n", "thread 'tests::adds' (999999) panicked at src/lib.rs:26:9:\n")
})

test("the word seed and the words after an at survive, because those rules took a value", async () => {
  // `seed\s*\w+` read "Failed to seed users table" as a seed, and the timestamp
  // keyword rule's `\S+` swallowed whatever word came after "start at".
  await differ("Failed to seed users table\n", "Failed to seed posts table\n")
  await differ("expected range to start at 1\n", "expected range to start at 2\n")
  await differ("generated at 2026-01-01 users\n", "generated at 2026-01-01 posts\n")
})

test("a temp suffix containing an underscore is still recognized as volatile", async () => {
  // Both names came out of a real `tempfile.mkdtemp(prefix="kantan-")`, chosen
  // because splitting them on `_` leaves no part that passes the length gate:
  // nothing propagated into pytest's abbreviated repr, and two runs of one
  // failure hashed differently about one time in twelve.
  await same(
    "E  AssertionError: assert '[kantan] rea...ntan-29_m_6av' == '[kantan] rea...ol=/srv/spool'\n" +
      "E  + [kantan] ready spool=/tmp/tmp.6W9HkBCyZG/kantan-29_m_6av\n",
    "E  AssertionError: assert '[kantan] rea...ntan-c0_2s4vy' == '[kantan] rea...ol=/srv/spool'\n" +
      "E  + [kantan] ready spool=/tmp/tmp.HB2VdL2Ddq/kantan-c0_2s4vy\n",
  )
})

test("a temp directory named after a test does not erase the test's name", async () => {
  // pytest's tmp_path fixture creates `.../pytest-12/test_add0`, which the
  // underscore change makes eligible for propagation. It is the test's name
  // plus a counter, so the name itself is never the token.
  await differ(
    "FAILED test_calc.py::test_add - assert 4 == 5\nspool = /tmp/pytest-of-dev/pytest-12/test_add0\n",
    "FAILED test_calc.py::test_sub - assert 4 == 5\nspool = /tmp/pytest-of-dev/pytest-12/test_sub0\n",
  )
})

test("a log timestamp at the start of a line does not survive; a formatted date mid-line does", async () => {
  await same("2026-10-11T14:45:08.030601+03:00 starting suite\n", "2026-10-12T09:02:11.991204+03:00 starting suite\n")
  await differ("Expected: 2026-01-01T00:00:00Z\n", "Expected: 2026-06-30T00:00:00Z\n")
})

// ---------------------------------------------------------------------------
// Collisions this design accepts. Each is a stall that fires on something that
// was arguably progress, or a change that reads as none; the reasoning is in
// src/stall.ts beside the rule.
// ---------------------------------------------------------------------------

test("accepted: a port number asserted on is treated as volatile", async () => {
  await same("Expected: port 8080\n", "Expected: port 9090\n")
})

test("accepted: reordered lines read as the same failure, because concurrency reorders them", async () => {
  // Proven necessary: five identical `cargo test` reruns emitted the two
  // failing blocks in two different orders.
  await same("  left: 4\n right: 5\n", " right: 5\n  left: 4\n")
})

test("accepted: on the report branch a changed message under the same failing set reads as a stall", async () => {
  // The brief's rule is to hash the set of failing names. Two runs that fail the
  // same tests with different messages are a stall by that definition. The
  // output branch is the one that sees messages, and pytest-msg covers it.
  const a = await failureSignature(reported(join(JUNIT, "pytest-base-run1.xml")))
  const dir = await mkdtemp(join(tmpdir(), "kantan-stall-"))
  try {
    const edited = join(dir, "junit.xml")
    const src = await Bun.file(join(JUNIT, "pytest-base-run1.xml")).text()
    await writeFile(edited, src.replaceAll("assert 4 == 5", "assert 4 == 9"))
    expect(await failureSignature(reported(edited))).toBe(a)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("known limitation: pytest's colour mode changes line truncation, not just colour", async () => {
  // Forcing colour makes pytest print more of the short-summary line than the
  // plain run does, so the two are genuinely different text. kantan always runs
  // the test command the same way, so colour does not vary between retries of
  // one run; a project whose command colours conditionally would miss a stall.
  const plain = await failureSignature(await capture("pytest-base-run1"))
  const colour = await failureSignature(await capture("pytest-colour"))
  expect(colour).not.toBe(plain)
})
