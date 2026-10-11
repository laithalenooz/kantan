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
 * The default allowlist is derived rather than written down, because the two
 * facts it needs - the repo and the test command - are already required
 * fields. A fixed default would be wrong for every project that does not run
 * `npm test`.
 *
 * What deriving does not do is make the command safe: it grants the runner the
 * project already declares, so `Bash(npm *)` includes `npm install` and
 * `Bash(npx *)` can fetch and run a package. The bound is "the one program
 * your tests run, plus git", not a sandbox.
 *
 * Two facts about the CLI this module leans on, read out of the 2.1.296
 * binary rather than assumed:
 *
 * - A rule of the form `Tool(word *)`, with that one wildcard, is compiled to
 *   `^word( .*)?$`. The trailing argument is **optional**, so a single-word
 *   test command like `vendor/bin/pest` matches its own rule. A rule with a
 *   second wildcard loses that, which is why the leading word must be literal.
 * - `Bash(*)` and `Bash()` are both normalised to the bare tool name `Bash`,
 *   which allows every command. That is why `deriveAllowedTools` refuses
 *   rather than ever emitting an empty or wildcard program.
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
 * The design's derived allowlist: the five file tools, git, and one rule for
 * the program `testCmd` runs. Nothing else - no network, no package installs,
 * no arbitrary shell.
 *
 * Throws when `testCmd` is a shape no single rule can cover; see `program`.
 * The caller is `allowedToolsFor`, which only derives when it has to, so both
 * fixes the message offers - an explicit `allowedTools`, or
 * `bypassPermissions` - make the project runnable again.
 */
export function deriveAllowedTools(project: Project): string[] {
  const rules: string[] = [...BASE_TOOLS, GIT_RULE]
  const rule = `Bash(${program(project)} *)`
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
 *   same thing wearing a hat: `Bash(sh *)`, `Bash(sudo *)` and
 *   `Bash(timeout *)` all grant "run anything you like", and because a
 *   wildcard rule is matched against the whole command line, `Bash(cd *)`
 *   allows `cd /any && <anything>` too.
 * - **Too narrow** denies the suite, so every run fails at verification with
 *   nothing in the output naming this field. A compound or env-prefixed
 *   command does exactly that: the leading word of `cd packages/api && npm
 *   test` is `cd`, and of `CI=1 npm test` is `CI=1`, so the rule grants
 *   something useless while the command that matters is denied.
 *
 * Neither is worth guessing at, so those shapes throw. Refusing costs one
 * line of config and says which line; the two silent outcomes cost a repo or
 * a debugging session.
 */
function program(project: Project): string {
  const testCmd = project.testCmd.trim()
  if (testCmd === "") {
    refuse(project, "it is blank, so there is no program to grant")
  }

  // Anything that chains, substitutes, redirects, quotes or escapes means the
  // string is not one literal command, so its first word is not the program
  // that runs the tests. Globs in the *arguments* are left alone: they never
  // reach the rule.
  const meta = /[&|;\n\r<>$`"'\\()]/.exec(testCmd)
  if (meta) {
    refuse(
      project,
      `it contains ${JSON.stringify(meta[0])}, so it is not one literal command and its first word is not the program that runs the tests`,
    )
  }

  const word = testCmd.split(/\s+/)[0] ?? ""
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
    refuse(
      project,
      `it starts with the environment assignment ${JSON.stringify(word)}, so there is no rule that both grants the program and matches the command as typed`,
    )
  }
  if (!/^[A-Za-z0-9_./][A-Za-z0-9_.:+@/-]*$/.test(word)) {
    refuse(
      project,
      `its first word ${JSON.stringify(word)} is not a literal program name, so a rule built from it would match something other than this command`,
    )
  }
  if (WRAPPERS.has(word)) {
    refuse(
      project,
      `its first word ${JSON.stringify(word)} runs whatever it is given, so Bash(${word} *) would grant an arbitrary shell rather than this project's tests`,
    )
  }
  return word
}

/**
 * Leading words that are not a test runner: each one either runs another
 * command or only changes the shell's state, so a rule built from it grants
 * far more than the suite, or nothing that can run it.
 *
 * This is a tripwire, not a security boundary. A wrapper that is not listed
 * derives a grant as broad as the wrapper - the same honest limit `npx` and
 * `make` already have - and the fix is the same explicit `allowedTools`.
 */
const WRAPPERS = new Set([
  ".",
  "bash",
  "builtin",
  "cd",
  "command",
  "csh",
  "dash",
  "doas",
  "env",
  "eval",
  "exec",
  "fish",
  "ksh",
  "nice",
  "nohup",
  "sh",
  "source",
  "su",
  "sudo",
  "tcsh",
  "time",
  "timeout",
  "xargs",
  "zsh",
])

/** Names the project, the value, the reason and both ways out, because §2.2
 * promises the fix is a line of config rather than a debugging session. */
function refuse(project: Project, why: string): never {
  throw new Error(
    `${project.path}: cannot derive allowedTools from testCmd ${JSON.stringify(project.testCmd)}, because ${why}. ` +
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
