/**
 * What identifies a Claude account, and which one a project runs as.
 *
 * The leaf the rest of the account code sits on, and the module worth reading
 * first: **`kind` alone is not an identity.** It is one of three words, while
 * the thing that decides what a run costs is `configDir` - so a list may hold
 * two options reading "work" that bill to different folders.
 *
 * Keying a React list on `kind` in such a list is not a cosmetic slip. Two
 * children with one key put the reconciler in a state it calls unsupported,
 * and measured here it did not merely mis-render: a single render of a
 * three-card list holding two `work` options never returned, and the process
 * grew until a 3 GB cgroup killed it. `docs/probes/account-key-collision.ts`
 * reruns it; `CLAUDE.md` records it.
 *
 * So every answer here is about the **pair**, and `accountOptionsFor` is keyed
 * on `optionId` so a map makes a collision unrepresentable rather than leaving
 * it to be noticed.
 */

import type { Account } from "../Tree.tsx"
import type { AccountKind, AccountOption } from "../ProjectPanel.tsx"

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * What identifies an account option: the word **and** the folder.
 *
 * `kind` alone is not an identity. It is one of three words, while the thing
 * that decides what a run costs is `configDir` - so a list may hold two
 * options reading "work" that bill to different folders, and `AccountSwitch`'s
 * own "Add an account" is how they get there.
 *
 * Keying a React list on `kind` in that list is not a cosmetic slip. Two
 * children with the same key put the reconciler in a state it calls
 * unsupported, and measured here it does not merely mis-render: a single
 * render of a three-card list holding two `work` options never returned, and
 * the process grew until a 3 GB cgroup killed it. Uncapped, that is the whole
 * machine. `docs/probes/account-key-collision.ts` reruns it.
 *
 * The separator is `/` because a `kind` is one of three words and none of them
 * contains one, so the first `/` always ends the word and the rest is the path
 * verbatim. A NUL would also be unambiguous, and was tried: happy-dom's
 * selector parser reads `\0` in a selector as that NUL and matches, but CSS
 * says an escape of zero is U+FFFD, so the same selector finds nothing in a
 * real browser. A separator that only works in the test harness is worse than
 * no separator.
 *
 * An absent `configDir` and an empty one both mean the default profile, and
 * folding them together is the reading, not a loss.
 */
export function optionId(option: { kind: Account["kind"]; configDir?: string }): string {
  return `${option.kind}/${option.configDir ?? ""}`
}

/**
 * The accounts to choose between, derived from what is registered.
 *
 * An account **is** a profile directory: `src/spawn.ts` sets
 * `CLAUDE_CONFIG_DIR` from `configDir` and `src/run.ts` records the run's
 * profile from it, while `account` is only the chip's word. So the options are
 * the distinct `(kind, configDir)` pairs across the tree, plus the default
 * profile so there is always somewhere to switch to.
 *
 * Here, exported and pure, because `App.tsx` built this inline and keyed it on
 * the **label** while setting no `configDir` at all - under a docstring that
 * said it did both. Two projects reading "personal" therefore produced two
 * options with the same `optionId`, which is the duplicate React key that hung
 * a render hard enough to take a 3 GB cgroup with it (`CLAUDE.md`, "A duplicate
 * React key took the whole machine down"). It also made `profileAmbiguous`
 * true for a project that was perfectly unambiguous, so the panel said it could
 * not tell which profile a project ran on while checking none of its cards.
 *
 * Keyed on `optionId`, so the map itself makes a collision unrepresentable
 * rather than leaving it to be noticed.
 */
export function accountOptionsFor(
  projects: ReadonlyArray<{ account: Account; configDir?: string }>,
  /**
   * The accounts the user recorded, from `~/.kantan/accounts.json`.
   *
   * **The second source, and the one that makes this list usable.** Reported
   * from use: *"why other accounts are not detected?"* - because the only
   * source was the projects above, so an account could be offered when some
   * project already billed to it. Which made adding one circular: to choose an
   * account you needed a project already using that account.
   *
   * Applied **after** the projects, so a recorded label wins where the two
   * disagree. A project's label is whatever was stored alongside the project;
   * a registry entry is what somebody typed into the add form for this
   * account, which is the more deliberate and more specific answer.
   */
  recorded: ReadonlyArray<{ kind: "personal" | "work"; label: string; configDir: string }> = [],
): AccountOption[] {
  const byId = new Map<string, AccountOption>()
  /* Seeded first so a project that genuinely runs on the default profile
     overwrites it with its own label rather than sitting beside it. */
  byId.set(optionId({ kind: "personal" }), { kind: "personal", label: "default profile" })
  for (const project of projects) {
    const kind = project.account.kind
    // `unknown` is the absence of an answer, not a third account: offering it
    // as something to switch *to* would let a human choose "nobody has said".
    if (kind !== "personal" && kind !== "work") continue
    const option: AccountOption = {
      kind,
      label: project.account.label ?? kind,
      ...(project.configDir === undefined ? {} : { configDir: project.configDir }),
    }
    byId.set(optionId(option), option)
  }
  /* Keyed by `optionId` like the projects, so a recorded account and a project
     on the same folder are one option rather than two rows with one identity -
     which is a duplicate React key, which hung a render. */
  for (const account of recorded) {
    const option: AccountOption = { kind: account.kind, label: account.label, configDir: account.configDir }
    byId.set(optionId(option), option)
  }
  return [...byId.values()]
}

/** The pair a project stores, in the same spelling `optionId` produces. */
export function storedId(project: { account: Account; configDir?: string }): string {
  return optionId({ kind: project.account.kind, ...(project.configDir === undefined ? {} : { configDir: project.configDir }) })
}

/**
 * The one option a project runs as, or `null` when the record cannot say.
 *
 * `null` has two causes and they are not distinguished here because the
 * surface treats them alike: no option matches the stored pair, or more than
 * one does. Either way nothing may be drawn as checked - a checked card is a
 * claim about where the money goes, and the cheap direction is to check
 * nothing and say so.
 */
export function storedOption(
  project: { account: Account; configDir?: string },
  accounts: readonly AccountOption[],
): AccountOption | null {
  const want = storedId(project)
  const hits = accounts.filter((option) => optionId(option) === want)
  return hits.length === 1 ? (hits[0] ?? null) : null
}

/** Whether the stored word names more than one of the options on offer. */
export function profileAmbiguous(
  project: { account: Account; configDir?: string },
  accounts: readonly AccountOption[],
): boolean {
  if (storedOption(project, accounts) !== null) return false
  return accounts.filter((option) => option.kind === project.account.kind).length > 1
}
