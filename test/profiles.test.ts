import { afterAll, expect, test } from "bun:test"
import { mkdir, rm, writeFile, symlink } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import { addProfile, discoverProfiles, loadProfiles, profileId } from "../src/profiles"

/**
 * The account registry, which exists because of two reports from use: *"why
 * other accounts are not detected?"* and *"if I try to add a new account
 * nothing happens?"*
 *
 * Both had one cause. The account list was derived **from projects already
 * registered** - `accountOptionsFor` seeds the default profile and then adds
 * one option per registered project's `(kind, configDir)` - so a profile no
 * project had ever run with could not appear, and the only way to add one was
 * to already have a project using it. Circular.
 */

const ROOT = join(import.meta.dir, "..", ".kantan-test", "profiles", `${process.pid}`)
let made = 0

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

async function storeFile(): Promise<string> {
  const dir = join(ROOT, `store-${made++}`)
  await mkdir(dir, { recursive: true })
  return join(dir, "accounts.json")
}

// --- Reading and writing ----------------------------------------------------

test("a store that does not exist yet reads as no accounts", async () => {
  // A fresh install has none, which is not an error. Same rule as the project
  // store: ENOENT is empty, and only a *damaged* file throws.
  expect(await loadProfiles(join(ROOT, "nope", "accounts.json"))).toEqual([])
})

test("an account added comes back", async () => {
  const file = await storeFile()
  await addProfile(file, { kind: "work", label: "Acme", configDir: "/home/dev/.claude-acme" })
  expect(await loadProfiles(file)).toEqual([
    { kind: "work", label: "Acme", configDir: "/home/dev/.claude-acme" },
  ])
})

test("an account's identity is the pair, so one kind can hold several folders", async () => {
  /* The lesson `optionId` in the UI was built from, and it cost a hung render
   * before it was learned: two accounts can both read `work` and bill to
   * different folders - that is the entire point of `configDir`. Keying on the
   * word alone makes them one. */
  const file = await storeFile()
  await addProfile(file, { kind: "work", label: "Acme", configDir: "/home/dev/.claude-acme" })
  await addProfile(file, { kind: "work", label: "Globex", configDir: "/home/dev/.claude-globex" })

  const all = await loadProfiles(file)
  expect(all).toHaveLength(2)
  expect(new Set(all.map(profileId)).size).toBe(2)
})

test("adding the same pair twice replaces it rather than duplicating it", async () => {
  // Re-adding is how a label gets corrected, and two records for one pair is
  // ambiguous identity rather than a duplicate to dedupe later.
  const file = await storeFile()
  await addProfile(file, { kind: "work", label: "typo", configDir: "/home/dev/.claude-acme" })
  await addProfile(file, { kind: "work", label: "Acme", configDir: "/home/dev/.claude-acme" })

  expect(await loadProfiles(file)).toEqual([
    { kind: "work", label: "Acme", configDir: "/home/dev/.claude-acme" },
  ])
})

test("a leading ~ is expanded, because the form promises it and the CLI does not", async () => {
  /**
   * The add form says, in those words, *"or start with ~ for your home
   * directory"*. The `claude` CLI expands no `~` in `CLAUDE_CONFIG_DIR` - it
   * would be handed the four characters literally and make a folder called
   * `~`. So the expansion has to happen on this side, or the form's promise is
   * false in a way that costs a billed run against the wrong profile.
   */
  const file = await storeFile()
  await addProfile(file, { kind: "work", label: "Acme", configDir: "~/.claude-acme" })
  expect((await loadProfiles(file))[0]?.configDir).toBe(join(homedir(), ".claude-acme"))
})

test("a relative folder is refused, since nothing could say what it is relative to", async () => {
  const file = await storeFile()
  for (const configDir of ["", "   ", ".claude-acme", "./x", "../x"]) {
    await expect(
      addProfile(file, { kind: "work", label: "Acme", configDir }),
    ).rejects.toThrow()
  }
  // And nothing was written by a refused add.
  expect(await loadProfiles(file)).toEqual([])
})

test("a blank label and an unknown kind are both refused", async () => {
  const file = await storeFile()
  await expect(addProfile(file, { kind: "work", label: "  ", configDir: "/home/dev/.c" })).rejects.toThrow()
  await expect(
    // @ts-expect-error - the kind is exactly the two words, and a third is the
    // case a hand-edited store produces.
    addProfile(file, { kind: "personel", label: "Acme", configDir: "/home/dev/.c" }),
  ).rejects.toThrow()
})

test("a damaged store throws rather than reading as empty", async () => {
  // The project store's reasoning, and it matters more here than there: if an
  // interrupted write read as "no accounts", the next add would replace the
  // lost records with one and a recoverable accident becomes permanent.
  const file = await storeFile()
  await writeFile(file, "")
  await expect(loadProfiles(file)).rejects.toThrow(/empty/)

  const broken = await storeFile()
  await writeFile(broken, "{ not json")
  await expect(loadProfiles(broken)).rejects.toThrow()

  const wrong = await storeFile()
  await writeFile(wrong, '{"accounts":[]}')
  await expect(loadProfiles(wrong)).rejects.toThrow(/array/)
})

// --- Discovery --------------------------------------------------------------

/**
 * Finding the profiles already on disk, which is the other half of the report.
 *
 * **A skipping guard, so the dimension is enumerated**: a directory entry of
 * the home directory. Its values, from this machine - `.claude` (the default),
 * `.claude-work` (a real second profile), `.claude-mem` (a *plugin's* data
 * directory, not a profile), `.claude.json` and a dozen `.claude.json.bak-*`
 * files, plus everything else in a home directory.
 *
 * The marker is `.credentials.json`, which both real profiles have and
 * `.claude-mem` does not. Not the name: `.claude-mem` matches every
 * name-based rule anyone would write.
 *
 * The costs are lopsided **only because typing a path by hand also works**.
 * A missed profile costs one paste into a field that is right there. A
 * suggested folder that is not a profile costs a run started against a
 * `CLAUDE_CONFIG_DIR` with no credentials, which prompts for a login kantan
 * cannot answer. So this is deliberately conservative, and is a suggestion
 * rather than the only way in.
 */
async function fakeHome(): Promise<string> {
  const home = join(ROOT, `home-${made++}`)
  // A real profile: the default, and a second one.
  for (const name of [".claude", ".claude-work"]) {
    await mkdir(join(home, name), { recursive: true })
    await writeFile(join(home, name, ".credentials.json"), "{}")
  }
  // A plugin's data directory. Matches every name-based rule, is not a profile.
  await mkdir(join(home, ".claude-mem"), { recursive: true })
  await writeFile(join(home, ".claude-mem", "settings.json"), "{}")
  // A profile folder that was never logged in to: no credentials, so nothing
  // to bill, so not offered.
  await mkdir(join(home, ".claude-empty"), { recursive: true })
  // The files that sit beside them, which are not directories at all.
  await writeFile(join(home, ".claude.json"), "{}")
  await writeFile(join(home, ".claude.json.bak-20260915"), "{}")
  // Something unrelated with credentials in it, to prove the name matters too.
  await mkdir(join(home, ".config"), { recursive: true })
  await writeFile(join(home, ".config", ".credentials.json"), "{}")
  return home
}

test("a second profile on disk is found, and a plugin's folder is not", async () => {
  const home = await fakeHome()
  expect(await discoverProfiles(home)).toEqual([join(home, ".claude-work")])
})

test("the default profile is not offered as an extra account", async () => {
  // `~/.claude` is what a run uses when no `configDir` is set, and the option
  // list already seeds it as "default profile". Offering it again would give a
  // human two choices that do the the same thing.
  const home = await fakeHome()
  expect(await discoverProfiles(home)).not.toContain(join(home, ".claude"))
})

test("a home directory that cannot be read answers nothing, not a throw", async () => {
  // Discovery is a convenience. Nothing it does should be able to stop the
  // page that calls it from rendering.
  expect(await discoverProfiles(join(ROOT, "no-such-home"))).toEqual([])
})

test("a symlinked profile folder is found through the link", async () => {
  // Keeping a profile on another volume and linking it into the home
  // directory is an ordinary thing to do, and `stat` follows links.
  const home = await fakeHome()
  const real = join(ROOT, `elsewhere-${made++}`)
  await mkdir(real, { recursive: true })
  await writeFile(join(real, ".credentials.json"), "{}")
  await symlink(real, join(home, ".claude-linked"))

  expect(await discoverProfiles(home)).toContain(join(home, ".claude-linked"))
})
