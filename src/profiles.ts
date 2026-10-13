/**
 * The Claude accounts kantan knows about, beyond the default profile.
 *
 * Exists because of two reports from use - *"why other accounts are not
 * detected?"* and *"if I try to add a new account nothing happens?"* - which
 * had a single cause. The account list was derived **from projects already
 * registered**: `accountOptionsFor` seeds the default profile and then adds one
 * option per registered project's `(kind, configDir)`. So a profile no project
 * had ever run with could not appear, and the only way to add one was to
 * already have a project using it. Meanwhile `onAddAccount` was a prop nothing
 * passed, so the button that would have broken the circle was hidden. The
 * `ProjectPanel` header table named what was missing - *"a profile registry"* -
 * and this is it.
 *
 * Two stores, not one. `projects.json` is a validated array of project records
 * that refuses unknown fields, so a second concern inside it would change the
 * shape every reader parses and every test asserts. This sits beside it.
 *
 * It holds **what the user told kantan**, and `discoverProfiles` separately
 * reports what is on disk. Those are different claims and the UI keeps them
 * apart: one is a record, the other is a suggestion.
 */

import { readFile, readdir, rename, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, normalize } from "node:path"

export type AccountKind = "personal" | "work"

/**
 * Where the registry lives: beside the project store.
 *
 * **Derived rather than a second injectable path**, which is a decision worth
 * stating. `defaultProjectsFile()` in `src/run.ts` owns where the state directory is,
 * and deriving keeps that the single source - a second `ServerOptions` field
 * would be one more thing every test has to remember, and the cost of
 * forgetting is a test writing into the developer's own the state directory.
 *
 * It also means a launch with no project store has no registry, which is the
 * honest reading: both are "the user's kantan state", so there is nowhere to
 * record an account for a server that was told not to keep projects.
 *
 * It lives in this module rather than in the route that writes it, so the tree
 * can read the registry without importing a route.
 */
export function accountsFile(projectsFile: string): string {
  return join(dirname(projectsFile), "accounts.json")
}

export interface Profile {
  /** Which of the two words the tree prints. Never derived from the path. */
  kind: AccountKind
  /** What the card prints. The user's words. */
  label: string
  /** `CLAUDE_CONFIG_DIR` for this account's runs. Absolute, `~` expanded. */
  configDir: string
}

/**
 * A profile's identity: the **pair**, never the word.
 *
 * The same rule as `optionId` in `src/ui/panel/accounts.ts`, and it is in both
 * places because they are different layers and the lesson was expensive: two
 * accounts can read `work` and bill to different folders - that is what
 * `configDir` is for - and a React key on the word alone produced duplicate
 * keys, which hung a render and took two editor sessions down with it.
 *
 * `/` as the separator, matching the UI, not the `NUL` that `taskKey` uses:
 * happy-dom matches `\0` to U+0000 while CSS says an escape of zero is U+FFFD,
 * so a NUL-keyed selector works only in a test harness.
 */
export function profileId(profile: Pick<Profile, "kind" | "configDir">): string {
  return `${profile.kind}/${profile.configDir}`
}

/**
 * The absolute, normalised folder a profile billing to it would use.
 *
 * **`~` is expanded here**, and that is not a convenience. The add form says in
 * so many words *"or start with ~ for your home directory"*, and the `claude`
 * CLI expands nothing - handed `~/.claude-work` it would create a directory
 * literally called `~`. So either this expands it or the form's promise is
 * false, and the way that failure shows up is a billed run against the wrong
 * account.
 *
 * Anything still not absolute afterwards is refused rather than resolved
 * against a working directory, because nothing here can say whose that would
 * be - the server's, which the person typing the path cannot see.
 */
export function profileDir(raw: unknown, where: string): string {
  if (typeof raw !== "string") {
    throw new Error(`${where}: a Claude config folder must be a string, got ${describe(raw)}`)
  }
  const trimmed = raw.trim()
  if (trimmed === "") throw new Error(`${where}: a Claude config folder cannot be blank`)

  const expanded =
    trimmed === "~" ? homedir() : trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed

  if (!isAbsolute(expanded)) {
    throw new Error(
      `${where}: a Claude config folder must be an absolute path, or start with ~ - got ${JSON.stringify(raw)}. ` +
        `A relative one would mean a different folder depending on where kantan was started.`,
    )
  }
  return normalize(expanded)
}

function validate(record: unknown, where: string): Profile {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw new Error(`${where} must be a JSON object, but is ${describe(record)}`)
  }
  const r = record as Record<string, unknown>

  const kind = r["kind"]
  if (kind !== "personal" && kind !== "work") {
    throw new Error(`${where}: kind must be "personal" or "work", got ${describe(kind)}`)
  }
  const label = typeof r["label"] === "string" ? r["label"].trim() : ""
  if (label === "") {
    throw new Error(`${where}: an account needs a name, so it can be told apart from the others`)
  }
  return { kind, label, configDir: profileDir(r["configDir"], where) }
}

/** Every account the user has told kantan about. `[]` when there is no store. */
export async function loadProfiles(file: string): Promise<Profile[]> {
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return []
    throw cause
  }
  // A byte-order mark frames the file rather than belonging to it; some
  // editors write one and `JSON.parse` refuses it.
  const raw = text.startsWith("﻿") ? text.slice(1) : text

  /* A zero-byte file is what a truncated write or a killed editor leaves.
     Reading it as [] would let the next add replace the lost records with one,
     turning a recoverable accident into a permanent one. */
  if (raw.trim() === "") {
    throw new Error(
      `${file} is empty, which is what an interrupted write looks like; refusing to read it as "no accounts". Restore it, or delete it to start over.`,
    )
  }
  let data: unknown
  try {
    data = JSON.parse(raw) as unknown
  } catch (cause) {
    throw new Error(`${file} is not valid JSON: ${(cause as Error).message}`, { cause })
  }
  if (!Array.isArray(data)) {
    throw new Error(`${file} must hold a JSON array of accounts, but holds ${describe(data)}`)
  }
  return data.map((record, i) => validate(record, `${file} record ${i}`))
}

/**
 * Adds `profile`, replacing any record with the same `(kind, configDir)`.
 *
 * Replacing rather than appending is how a mistyped label is corrected, and
 * two records for one pair would be ambiguous identity rather than a duplicate
 * to clean up later - a reader could use either.
 *
 * Validated **before** anything is read or written, so a refused add cannot
 * leave a store that every later load rejects. `src/projects.ts` says the same
 * thing at more length; the failure it prevents is a tool bricked by itself.
 */
export async function addProfile(file: string, profile: Profile): Promise<void> {
  const record = validate(profile, `account for ${file}`)
  const all = await loadProfiles(file)
  const at = all.findIndex((p) => profileId(p) === profileId(record))
  if (at === -1) all.push(record)
  else all[at] = record

  /* Written to a sibling and renamed: a rename within a directory is atomic,
     so a reader never sees a half-written store - which is the accident the
     empty-file refusal above exists to catch after the fact. */
  const temp = `${file}.tmp.${process.pid}`
  await writeFile(temp, `${JSON.stringify(all, null, 2)}\n`, "utf8")
  await rename(temp, file)
}

/** What a logged-in profile has and a plugin's data directory does not. */
const CREDENTIALS = ".credentials.json"

/**
 * Folders under `home` that look like Claude profiles kantan is not already
 * offering. **A suggestion, never a record.**
 *
 * This is a skipping guard, so its dimension is enumerated rather than
 * sampled. The dimension is one directory entry of the home directory, and its
 * values - taken from the machine this was reported on - are `.claude` (the
 * default), `.claude-work` (a real second profile), `.claude-mem` (a
 * **plugin's** data directory), `.claude-empty` (a profile folder never logged
 * in to), `.claude.json` and a row of `.claude.json.bak-*` files, and
 * everything else a home directory holds.
 *
 * Two conditions, and the second is the one that does the work:
 *
 * - The name starts with `.claude`, which is the convention the CLI documents.
 * - It contains `.credentials.json`. **This is the discriminator.**
 *   `.claude-mem` satisfies every name-based rule anyone would write and is
 *   not a profile; both real profiles here have credentials and it does not.
 *
 * The costs are lopsided **only because typing the path by hand also works**,
 * and that is why this is a convenience rather than the mechanism. A missed
 * profile - one kept at `~/work-claude`, or outside the home directory - costs
 * one paste into a field that is already on screen. A suggested folder that is
 * not a profile costs a run started against a `CLAUDE_CONFIG_DIR` with no
 * credentials in it, which asks for a login that kantan cannot answer, on the
 * user's money. So this fails toward missing one.
 *
 * `~/.claude` is excluded on purpose: that is what a run uses when no
 * `configDir` is set, and the option list already offers it as "default
 * profile". Suggesting it again would give a human two choices that do the
 * same thing.
 *
 * Never throws. Discovery is a nicety and must not be able to stop the page
 * that asks for it from rendering.
 */
export async function discoverProfiles(home: string = homedir()): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(home, { encoding: "utf8" })
  } catch {
    return []
  }

  const found: string[] = []
  for (const name of entries) {
    if (!name.startsWith(".claude")) continue
    const dir = join(home, name)
    if (dir === join(home, ".claude")) continue
    try {
      // `stat`, not `lstat`: a profile kept on another volume and linked into
      // the home directory is an ordinary arrangement, and the link is the
      // path a run should be given.
      if (!(await stat(dir)).isDirectory()) continue
      if (!(await stat(join(dir, CREDENTIALS))).isFile()) continue
    } catch {
      // No credentials, not a directory, or not readable: not offered.
      continue
    }
    found.push(dir)
  }
  return found.sort()
}

function describe(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  return typeof value
}
