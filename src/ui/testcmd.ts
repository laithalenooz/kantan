/**
 * One reading of `project.testCmd`, shared by every surface that prints it.
 *
 * The field is a skipping guard in the sense `CLAUDE.md` means, so its
 * enumeration is written here once rather than guessed per call site:
 *
 * | stored          | reads as     | why |
 * |-----------------|--------------|-----|
 * | `null`          | no command   | the store's own spelling of "no suite" |
 * | `""`            | no command   | `sh -c ""` exits 0 - a pass from nothing |
 * | `"   "`         | no command   | same, after the shell eats the spaces |
 * | `"npm test"`    | `"npm test"` | a command |
 * | `"  npm test "` | `"  npm test "` | a command, spacing intact |
 *
 * The costs are not symmetric. Reading a real command as "no command"
 * under-claims: a surface says the agent checked its own work when kantan in
 * fact ran a command and read an exit code. Reading no command as a command
 * over-claims: a bare `$` under a blurb promising an exit code was read, and
 * work merged on a verification nothing performed. So blank folds to `null`.
 *
 * `src/projects.ts` refuses `""` and `"   "` on write, so they cannot reach
 * here from a valid record - but these surfaces read a tree over HTTP rather
 * than the store, and a hand-edited store file is still a file.
 *
 * The command itself is never trimmed: it is handed to `sh -c` verbatim, so
 * its spacing is the user's and not a view's to tidy.
 */
export function commandOf(testCmd: string | null): string | null {
  if (testCmd === null) return null
  return testCmd.trim() === "" ? null : testCmd
}

/**
 * What a surface prints where a command would go when there is none.
 *
 * Spelled once because the condition on the user's 2026-10-12 decision is that
 * nothing may claim a verification it did not observe, and this string is how
 * three surfaces say so. It carries no exit code, no tick and not the word
 * "passed", by design.
 */
export const SELF_CHECKED = "Self-checked by the agent — no test command"
