export interface TestOutcome {
  exitCode: number
  stdout: string
  stderr: string
  /** Absolute path to a JUnit XML, if the project declares one. */
  reportPath?: string
}

/**
 * A hash of what failed, stable across runs of the same failure and different
 * across different failures. Three consecutive identical signatures are how
 * kantan tells a loop from a run that is still converging: it raises the
 * agent's effort level rather than counting attempts, and stops for the human
 * only after the ladder runs out.
 *
 * **The caller's contract.** This function is total: it answers for a passing
 * run too, because refusing to would only move the branch. But a signature
 * carries no claim that anything failed, so comparing two of them means
 * something only for runs that failed by exit code. Feed it only failures.
 *
 * The exit code is part of every signature, which is what makes a timeout
 * behave correctly: `runTests` reports `TIMEOUT_EXIT_CODE` (124) for a killed
 * run whatever the command returned, so a suite that hangs the same way twice
 * hashes alike and reads as the stall it is, and a hang is never confused with
 * the exit-1 failure of the same suite.
 *
 * Two branches, in this order:
 *
 * 1. A readable, well-formed JUnit XML naming at least one failing test. The
 *    failing names need no normalization at all, which is why this is first
 *    rather than a nicety.
 * 2. The normalized tail of stdout and stderr. Both: `bun test` writes failures
 *    to stderr and `go test` to stdout.
 *
 * Anything wrong with the report - absent, empty, truncated, not XML, or naming
 * no failing test - falls through to the output rather than throwing. See
 * `failingTests` for why the no-failing-test case has to fall through too.
 */
export async function failureSignature(o: TestOutcome): Promise<string> {
  if (o.reportPath !== undefined) {
    const failing = await failingTests(o.reportPath)
    if (failing !== null && failing.length > 0) {
      return digest(["junit", o.exitCode, [...failing].sort()])
    }
  }
  return digest(["output", o.exitCode, tailOf(o.stdout), tailOf(o.stderr)])
}

function digest(parts: unknown): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(parts)).digest("hex")
}

// ---------------------------------------------------------------------------
// Branch 1: the JUnit report
// ---------------------------------------------------------------------------

/**
 * The `class::name` of every failing test in a JUnit XML, or `null` if the file
 * cannot be trusted.
 *
 * Identity is class plus name because pytest writes the bare function name in
 * `name` and the module in `classname`, so two modules each holding a `test_add`
 * would otherwise be one test.
 *
 * `<failure>` and `<error>` both count. `<skipped>` does not: a skip is not a
 * failing test, and counting it would make adding a `@skip` look like a stall.
 *
 * **Well-formedness is required, not nice to have.** A runner killed mid-write
 * leaves a file whose last element is cut off, and the elements before the cut
 * parse perfectly. A scanner that does not check for balance returns a
 * confident subset of the real failing set, which is a different signature from
 * the same failure's complete report - a stall that never fires, or one that
 * fires on nothing.
 *
 * An empty failing set is **not** an answer. A collection error, a lint step
 * ahead of the tests, or a coverage gate all fail the command without failing a
 * test, and hashing the empty set would make every one of those look identical
 * to every other. The caller falls through to the output, which can still tell
 * them apart.
 *
 * **A stale report is the one failure mode this cannot see, and it is the
 * expensive one.** A run that crashed or was killed before writing the XML
 * leaves the previous attempt's file on disk, where it parses perfectly and
 * names the previous attempt's failures. Two attempts then hash equal and the
 * detector reports a stall against a run that may have been converging: effort
 * is escalated, and at the top of the ladder a human is interrupted, for
 * nothing. Nothing in `TestOutcome` dates the file, and an mtime check here
 * would only move the problem, since the caller would still have to supply the
 * moment the run began. The fix belongs to whoever spawns the command, which is
 * the only code that knows when that was: **delete `project.reportPath` before
 * spawning `testCmd`**, so an absent file is unambiguous. `src/testrun.ts` does
 * not do this today; `docs/HANDOFF.md` carries it for Task 13.
 */
async function failingTests(reportPath: string): Promise<string[] | null> {
  let xml: string
  try {
    xml = await Bun.file(reportPath).text()
  } catch {
    // Absent, unreadable, or a directory. The project declared a report; this
    // run may simply not have produced one.
    return null
  }
  return parseFailingTests(xml)
}

interface Frame {
  name: string
  attrs: Record<string, string>
  failed: boolean
}

/**
 * A deliberately small XML reader: enough to walk elements and attributes, and
 * strict enough that a truncated or mangled document is rejected rather than
 * half-read. Returns `null` on anything it cannot read to a balanced end.
 */
function parseFailingTests(xml: string): string[] | null {
  const src = xml.startsWith("﻿") ? xml.slice(1) : xml
  const stack: Frame[] = []
  const failing: string[] = []
  let i = 0

  while (i < src.length) {
    const lt = src.indexOf("<", i)
    if (lt < 0) break
    i = lt + 1

    if (src.startsWith("?", i)) {
      const end = src.indexOf("?>", i)
      if (end < 0) return null
      i = end + 2
      continue
    }
    if (src.startsWith("!--", i)) {
      const end = src.indexOf("-->", i)
      if (end < 0) return null
      i = end + 3
      continue
    }
    if (src.startsWith("![CDATA[", i)) {
      const end = src.indexOf("]]>", i)
      if (end < 0) return null
      i = end + 3
      continue
    }
    if (src.startsWith("!", i)) {
      // A doctype. Its internal subset may hold a ">", which this does not
      // handle; rejecting is the safe answer and no runner emits one.
      const end = src.indexOf(">", i)
      if (end < 0) return null
      i = end + 1
      continue
    }

    if (src.startsWith("/", i)) {
      i += 1
      const end = src.indexOf(">", i)
      if (end < 0) return null
      const name = src.slice(i, end).trim()
      const open = stack.pop()
      if (open === undefined || open.name !== name) return null
      if (name === "testcase" && open.failed) failing.push(identity(open.attrs))
      i = end + 1
      continue
    }

    const tag = readTag(src, i)
    if (tag === null) return null
    i = tag.next

    if (tag.name === "failure" || tag.name === "error") {
      for (let d = stack.length - 1; d >= 0; d -= 1) {
        const frame = stack[d]
        if (frame !== undefined && frame.name === "testcase") {
          frame.failed = true
          break
        }
      }
    }
    if (!tag.selfClosing) stack.push({ name: tag.name, attrs: tag.attrs, failed: false })
  }

  // A document that did not close every element it opened was cut short.
  if (stack.length > 0) return null
  return failing
}

interface Tag {
  name: string
  attrs: Record<string, string>
  selfClosing: boolean
  next: number
}

function readTag(src: string, start: number): Tag | null {
  let i = start
  while (i < src.length && !/[\s/>]/.test(src[i] ?? ">")) i += 1
  const name = src.slice(start, i)
  if (name === "") return null
  const attrs: Record<string, string> = {}

  for (;;) {
    while (i < src.length && /\s/.test(src[i] ?? "x")) i += 1
    if (i >= src.length) return null
    const ch = src[i]
    if (ch === ">") return { name, attrs, selfClosing: false, next: i + 1 }
    if (ch === "/") {
      if (src[i + 1] !== ">") return null
      return { name, attrs, selfClosing: true, next: i + 2 }
    }
    const nameStart = i
    while (i < src.length && !/[\s=/>]/.test(src[i] ?? ">")) i += 1
    const attr = src.slice(nameStart, i)
    if (attr === "") return null
    while (i < src.length && /\s/.test(src[i] ?? "x")) i += 1
    if (src[i] !== "=") return null
    i += 1
    while (i < src.length && /\s/.test(src[i] ?? "x")) i += 1
    const quote = src[i]
    // XML requires a quoted value. Anything else means the file is not XML, or
    // is cut off mid-attribute, which is what a killed runner leaves.
    if (quote !== '"' && quote !== "'") return null
    const close = src.indexOf(quote, i + 1)
    if (close < 0) return null
    attrs[attr] = unescapeXml(src.slice(i + 1, close))
    i = close + 1
  }
}

function unescapeXml(s: string): string {
  if (!s.includes("&")) return s
  return s.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(lt|gt|amp|quot|apos));/g, (all, dec, hex, named) => {
    if (typeof dec === "string") return String.fromCodePoint(Number(dec))
    if (typeof hex === "string") return String.fromCodePoint(Number.parseInt(hex, 16))
    switch (named) {
      case "lt":
        return "<"
      case "gt":
        return ">"
      case "amp":
        return "&"
      case "quot":
        return '"'
      case "apos":
        return "'"
      default:
        return all
    }
  })
}

/** PHPUnit writes both `class` and `classname`; pytest writes only `classname`. */
function identity(attrs: Record<string, string>): string {
  const cls = attrs["classname"] ?? attrs["class"] ?? ""
  return `${cls}::${attrs["name"] ?? ""}`
}

// ---------------------------------------------------------------------------
// Branch 2: the normalized output tail
// ---------------------------------------------------------------------------

/**
 * How much of one stream is read. The informative part of a test run is at the
 * end, and a 5 MB wall of stack traces is mostly the same frame repeated.
 *
 * `TAIL_BYTES` is cut first, and the partial line it lands in is dropped: a
 * window measured in characters moves when a path above it changes length, and
 * a half line at the top would then differ between two runs of one failure.
 * `TAIL_LINES` is applied after the chrome lines are dropped, so the window
 * holds that many lines that say something. `MAX_LINE` bounds a single
 * enormous line, which minified output and serialized fixtures both produce.
 *
 * Anything earlier than this is invisible to stall detection. That is the
 * deliberate trade: a loop whose only difference is 4 MB back reads as a stall.
 *
 * **`TAIL_BYTES` must stay well below `testrun.MAX_OUTPUT_BYTES`** (1 MiB).
 * That module hands over the *tail* of each stream, so a window of the same
 * size would reach bytes that a chatty run had already dropped and a quiet one
 * still had, and one failure would hash two ways depending on how much the
 * suite printed.
 *
 * The name is a half-truth worth stating: this counts UTF-16 code units, not
 * bytes, because that is what `String.length` is. ASCII output, which is nearly
 * all of it, makes them the same; output that is entirely outside the BMP would
 * be about 768 KB of UTF-8. Still under the cap, but not the quarter it looks.
 */
const TAIL_BYTES = 256 * 1024
const TAIL_LINES = 400
const MAX_LINE = 2000

/** Every ANSI escape, not only the colour ones. An OSC-8 hyperlink carries a
 * URL that may hold an absolute path, and a CSI cursor move varies with how
 * fast the runner wrote. */
const ANSI_RE =
  /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)?|[@-Z\\-_])/g

/** A source line echoed by the runner with its line number: `  13 | expect(...`.
 * Dropped whole. Keeping it would mean every agent edit changes the signature,
 * because every line number moves, and that is the direction that burns money:
 * the loop kantan is looking for always has an edit between its two runs. The
 * cost is that two failures differing only in the echoed source read alike;
 * the test name and the error text are kept, and they are what differ.
 *
 * Three gutter characters and a marker, because three runners disagree: bun
 * writes ` 13 | `, Jest marks the failing line `    > 15 | `, and Pest draws
 * `      8▕ ` with `  ➜  12▕ ` for the failure. A regex built against any one
 * of them silently keeps the other two, and with them every line number. */
const CODE_FRAME_RE = /^\s*(?:[>➜]\s*)?\d+\s*(?:\||│|▕)/

/** The caret under the failing expression. Its column moves with the line, and
 * the line it points at has already been dropped. Jest puts it behind a gutter
 * (`         |            ^`), so the gutter characters are allowed here. */
const CARET_RE = /^[\s|│▕]*[\^~][\s^~|│▕]*$/

/** A line of progress glyphs and nothing else: cargo's `. 1/3`, a row of dots,
 * `FF.`. The same information is in the failure blocks below it. */
const PROGRESS_RE = /^[\s.FEsxX!*✓✔✗✘×✕·]*(?:\d+\s*\/\s*\d+)?[\s.]*(?:\[\s*\d+%\s*\])?[\s.]*$/

/** A fail or pass marker standing at the start of its line. `bun test` prints
 * `(fail)` with colour off and `✗` with it on, so the glyph is not a colour
 * overlay; vitest and jest use `×` and `✕`. Anchored, so a glyph inside a test
 * name survives. */
const FAIL_GLYPH_RE = /^(\s*)[✗✘×✕⨯](\s)/
const PASS_GLYPH_RE = /^(\s*)[✓✔√](\s)/

/** Three or more of one rule character. pytest pads its banners to the terminal
 * width, so the count changes when a path or duration beside it gains a digit.
 * Pest rules its sections with box drawing instead. */
const RULE_RUN_RE = /([=\-_─━═])\1{2,}/g

/** A duration is only a duration in a position the runner controls. Every form
 * here is anchored to the end of its line (`[0.26ms]`, `(0.00s)`, `in 0.03s`),
 * to a tab (go's package summary), or to the line start (`Time:`, `Memory:`).
 * Unanchored, `Expected: "took 1.2s"` and `"took 1.25s"` would read alike, and
 * a project formatting durations could never trip the detector. */
const UNIT = "(?:ns|µs|us|ms|s|m|sec|secs|seconds?|min|minutes?)"
const TRAILING = "(?=[\\s=\\-_.,;:)\\]]*$)"
/** A plain figure, and the clock PHPUnit prints instead: `00:00.003`, `01:02:03`. */
const NUM = "\\d+(?:\\.\\d+)?"
const CLOCK = "(?:\\d+:)?\\d+:\\d+(?:\\.\\d+)?"
const DURATION_RULES: [RegExp, string][] = [
  [new RegExp(`\\[\\s*\\d+(?:\\.\\d+)?\\s*${UNIT}\\s*\\]${TRAILING}`, "g"), "[<time>]"],
  [new RegExp(`\\(\\s*\\d+(?:\\.\\d+)?\\s*${UNIT}\\s*\\)${TRAILING}`, "g"), "(<time>)"],
  [new RegExp(`\\b(in|took|after|within)\\s+\\d+(?:\\.\\d+)?\\s*${UNIT}\\b${TRAILING}`, "gi"), "$1 <time>"],
  // go: `ok  \tpkg\t0.002s`, and the same package `(cached)` on the next run.
  [/\t\d+(?:\.\d+)?s(?=\s*$)/g, "\t<time>"],
  [/\t\(cached\)(?=\s*$)/g, "\t<time>"],
  // A field in a summary line. PHPUnit writes two on one line, `Time:
  // 00:00.003, Memory: 14.00 MB`, so a line-start anchor alone misses the
  // second; Jest indents its `Time:` line, so an anchor without the leading
  // whitespace misses that one.
  //
  // At the line start the unit may be absent, because PHPUnit's duration is a
  // clock. After a comma it may not: `time` is an ordinary field name, and
  // `expected { id: 1, time: 5 } to equal { id: 1, time: 6 }` must keep both
  // numbers or two different failures read as one.
  // The `\b` after a unit is load-bearing: the alternation tries `s` before
  // `seconds` and `m` before `minutes`, so without it `time: 3 steps` loses its
  // `s` to the unit and `3 steps` and `4 steps` normalize alike.
  [new RegExp(`(^\\s*)(Time|Duration|Elapsed|Runtime)\\s*:\\s*(?:${CLOCK}|${NUM}(?:\\s*${UNIT}\\b)?)`, "gi"), "$1$2: <time>"],
  [new RegExp(`([,;]\\s*)(Time|Duration|Elapsed|Runtime)\\s*:\\s*${NUM}\\s*${UNIT}\\b`, "gi"), "$1$2: <time>"],
  // Pest right-aligns a bare per-test duration: `⨯ it adds two numbers` then
  // padding then `0.01s`. Two spaces or more is the anchor, which is what keeps
  // it off `Received: 1000ms`, where one space follows the colon. The padding is
  // replaced rather than kept, because Pest aligns to a fixed column and the
  // padding therefore shrinks by one as the duration gains a digit.
  [new RegExp(`\\s{2,}${NUM}\\s*${UNIT}\\b\\s*$`, "i"), " <time>"],
  // A memory figure always carries its unit, so one rule covers both positions.
  [new RegExp(`(^\\s*|[,;]\\s*)(Memory|Peak memory|RSS|Heap)\\s*:\\s*${NUM}\\s*(?:[KMGT]i?B|bytes?)`, "gi"), "$1$2: <mem>"],
]

/** Everything else that is new on every run of one failure. Each is keyword- or
 * position-anchored for the same reason the durations are. */
const VOLATILE_RULES: [RegExp, string][] = [
  // `src/testrun.ts` prepends this when it caps a stream, and the byte counts
  // in it change from run to run. Reading the tail is the real defence: the
  // marker sits at the head of a stream that is by definition larger than this
  // window, so it is never in it. This rule is the backup, so the guarantee
  // does not rest on another module's constant, and it is what the test
  // exercises. It keeps the fact of truncation and drops the counts.
  [/^\[kantan: (\w+) truncated - dropped the first \d+ bytes, kept the last \d+\]$/, "[kantan: $1 truncated]"],
  // A log timestamp sits at the start of its line. A formatted date inside an
  // assertion message does not, and it survives: it is often the thing asserted.
  [/^(\s*[[(]?)\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/, "$1<ts>"],
  [/^(\s*[[(]?)\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?=\s)/, "$1<ts>"],
  // The value has to look like a timestamp. `\S+` swallowed the next word, so
  // "expected range to start at 1" and "...at 2" read alike.
  [/\b(timestamp|started at|start at|generated at)\s*[:=]?\s*(?:\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?|\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?|\d{10,})/gi, "$1 <ts>"],
  // file.ext:line:col. The extension must start with a letter, so 127.0.0.1:8080
  // is left to the port rule below. Runs before the temp-path rule, or a line
  // number would survive its path being collapsed.
  [/([\w./\\+-]*\.[A-Za-z][A-Za-z0-9]{0,8}):\d+(?::\d+)?/g, "$1"],
  // `dart test` and `flutter test` separate the file from the position with a
  // space instead: `  test/calc_test.dart 15:5  main.<fn>`. Both the line and
  // the column are required here, so an ordinary sentence like "expected
  // calc.ts 3 times" keeps its number.
  [/([\w./\\+-]*\.[A-Za-z][A-Za-z0-9]{0,8})\s+\d+:\d+\b/g, "$1"],
  [/\bpid\s*[:=#]?\s*\d+/gi, "pid=<pid>"],
  // cargo: `thread 'tests::adds' (738104) panicked at src/lib.rs:26:9`.
  [/(thread\s+'[^']*'\s*)\(\d+\)/g, "$1(<tid>)"],
  [/\b((?:\d{1,3}\.){3}\d{1,3}|localhost|\[::1\]):\d{1,5}\b/g, "$1:<port>"],
  [/\bport\s*[:=]?\s*\d{1,5}\b/gi, "port=<port>"],
  // A numeric value, not `\w+`: PHPUnit, pytest-randomly and jest all print a
  // number, and `\w+` turned "Failed to seed users table" and "...posts table"
  // into one line.
  [/\bseed\b\s*[:=]?\s*\d+/gi, "seed=<seed>"],
  [/\[gw\d+\]/g, "[gw<worker>]"],
  [/\b(worker|shard)\s*[-:=#]?\s*\d+(?:\s*\/\s*\d+)?/gi, "$1=<worker>"],
  // An address is printed after `at`, `@` or `address`. A bare 0xdeadbeef is
  // left alone: in an assertion message it is usually the value under test.
  [/(\bat|@|\baddress)\s*0x[0-9a-fA-F]{4,}/gi, "$1 0x<addr>"],
]

/** Where a temp path can start. A path under the system temp root is new on
 * every run by construction, and nothing identifying a failure lives there.
 * Project paths are **not** normalized: `project.path` is fixed for the life of
 * a run, so it never varies between two attempts, while stripping it would
 * throw away the failing file's name for PHPUnit, which prints it only in
 * absolute form. */
const TEMP_PATH_RE =
  /(?:\/tmp|\/var\/tmp|\/var\/folders|\/private\/var\/folders|\/dev\/shm|[A-Za-z]:\\[^\s"'`]*?\\Temp)(?:[/\\][^\s"'`,:;)\]}]+)*/g

/** A path segment random enough to have been generated: at least six characters
 * with both a letter and a digit. Pure numbers are excluded on purpose, so a
 * pid that happens to equal an asserted value is not propagated.
 *
 * `_` counts as part of the token, and `PART_SEPARATOR_RE` does not split on
 * it, because Python's `mkdtemp` alphabet includes it. Measured over 1000 real
 * `mkdtemp` names: splitting on `_` propagated 822, keeping it propagates 906.
 * The remaining 94 are the names whose random suffix happens to contain no
 * digit at all, which is the documented degradation below.
 *
 * The cost of keeping `_` is that a directory named after a test, which is what
 * pytest's `tmp_path` fixture creates (`.../pytest-12/test_add0`), now
 * qualifies and is substituted wherever else it appears. It is a counter
 * appended to the test's name, so it is a strict superstring of that name and
 * the name itself survives; the test "a temp directory named after a test does
 * not erase the test's name" pins that. */
const RANDOM_PART_RE = /^(?=[^\d]*\d)(?=[^A-Za-z]*[A-Za-z])[A-Za-z0-9_]{6,}$/

/** Where one path segment's parts end. Deliberately **not** `_`; see above. */
const PART_SEPARATOR_RE = /[/\\.-]/

/**
 * One stream, normalized and bounded, as a sorted list of lines.
 *
 * Sorted because output order genuinely varies: five identical `cargo test`
 * reruns emitted their two failing blocks in two different orders, so a run
 * keyed on order would have produced a fresh signature for the same failure
 * about half the time. The cost is that two failures that are line
 * permutations of each other read alike - swapping `left` and `right` in an
 * assertion is the realistic case, and it is not progress.
 */
function tailOf(raw: string): string[] {
  let text = raw.length > TAIL_BYTES ? raw.slice(raw.length - TAIL_BYTES) : raw
  if (text.length < raw.length) {
    const nl = text.indexOf("\n")
    text = nl < 0 ? "" : text.slice(nl + 1)
  }
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(ANSI_RE, "")

  const kept: string[] = []
  const volatiles = new Set<string>()
  for (const line of text.split("\n")) {
    const capped = line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line
    if (capped.trim() === "") continue
    if (CODE_FRAME_RE.test(capped)) continue
    if (CARET_RE.test(capped)) continue
    if (PROGRESS_RE.test(capped)) continue
    kept.push(normalizeLine(capped, volatiles))
  }

  const window = kept.length > TAIL_LINES ? kept.slice(kept.length - TAIL_LINES) : kept
  // A second pass for values this output proved volatile. pytest abbreviates
  // long values as '[kantan] rea...ntan-iz587lzh', smuggling the tail of a temp
  // directory into a place no path rule can see; the same random segment having
  // been collapsed in a path above is the evidence that it is noise.
  const propagated =
    volatiles.size === 0 ? window : window.map((line) => replaceAll(line, volatiles, "<rand>"))
  return propagated.sort()
}

function normalizeLine(line: string, volatiles: Set<string>): string {
  let out = line
  out = out.replace(FAIL_GLYPH_RE, "$1(fail)$2").replace(PASS_GLYPH_RE, "$1(pass)$2")
  out = out.replace(RULE_RUN_RE, "$1$1$1")
  for (const [re, to] of DURATION_RULES) out = out.replace(re, to)
  for (const [re, to] of VOLATILE_RULES) out = out.replace(re, to)
  out = out.replace(TEMP_PATH_RE, (path) => {
    for (const part of path.split(PART_SEPARATOR_RE)) {
      if (RANDOM_PART_RE.test(part)) volatiles.add(part)
    }
    return "<tmp>"
  })
  return out
}

function replaceAll(line: string, needles: Set<string>, to: string): string {
  let out = line
  for (const needle of needles) out = out.split(needle).join(to)
  return out
}
