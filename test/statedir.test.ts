import { afterAll, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { LEGACY_STATE_DIR, STATE_DIR, defaultProjectsFileIn, defaultRunsDirIn, stateDirIn } from "../src/statedir"

/**
 * Where kantan keeps its own state, after the rename from `orch`.
 *
 * The product is kantan and the directory said `~/.orch`. Renaming it is
 * cheap; renaming it *without stranding the state already there* is the part
 * that needs deciding, because `~/.orch/projects.json` is the only thing in
 * this system that no repository can rebuild.
 *
 * **A fallback, not a migration.** Nothing here moves a file. Moving a user's
 * data on first launch is the kind of action that is hard to undo and easy to
 * get wrong, and it would happen before they had any reason to trust the new
 * version. Reading the old location is reversible, costs one `stat`, and the
 * entry point says which one it chose.
 */

const ROOT = join(import.meta.dir, "..", ".kantan-test", "statedir", `${process.pid}`)
let made = 0

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

async function home(dirs: string[] = []): Promise<string> {
  const dir = join(ROOT, `home-${made++}`)
  await mkdir(dir, { recursive: true })
  for (const name of dirs) await mkdir(join(dir, name), { recursive: true })
  return dir
}

test("the two names are what the product is called, and what it used to be", () => {
  expect(STATE_DIR).toBe(".kantan")
  expect(LEGACY_STATE_DIR).toBe(".orch")
})

/**
 * The enumeration, because this is a skipping guard and its dimension is
 * "which of the two directories exists". All four values, including the one
 * no test would produce by accident.
 */
test("a fresh install uses the new directory", async () => {
  const h = await home()
  expect(stateDirIn(h)).toEqual({ dir: join(h, ".kantan"), legacy: false })
})

test("an existing install keeps reading the one its state is in", async () => {
  // The case that matters: anyone who used kantan before the rename. Pointing
  // at an empty `~/.kantan` would read as "no projects, no history" and the
  // next write would make that permanent.
  const h = await home([".orch"])
  expect(stateDirIn(h)).toEqual({ dir: join(h, ".orch"), legacy: true })
})

test("the new directory wins once it exists", async () => {
  const h = await home([".kantan"])
  expect(stateDirIn(h)).toEqual({ dir: join(h, ".kantan"), legacy: false })
})

test("with both present the new one wins, and nothing is merged", async () => {
  /* The value no accident produces: somebody who ran the new version, then an
   * older one, then the new one again. Preferring the new directory is the
   * only answer that is stable - the alternative is a rule where adding a
   * project can change which store the *next* launch reads. Nothing is merged
   * either, because two stores disagreeing about one project path is ambiguous
   * identity rather than a duplicate to reconcile, and the entry point's line
   * is how a person finds the other one.
   */
  const h = await home([".orch", ".kantan"])
  expect(stateDirIn(h)).toEqual({ dir: join(h, ".kantan"), legacy: false })
})

test("a file where the directory should be is not a state directory", async () => {
  // `~/.orch` as a *file* is not somewhere state can live, and treating it as
  // one would send every read and write into an ENOTDIR.
  const h = await home()
  await writeFile(join(h, ".orch"), "not a directory")
  expect(stateDirIn(h)).toEqual({ dir: join(h, ".kantan"), legacy: false })
})

test("the store and the logs always agree about which directory they are in", async () => {
  /* The reason this lives in one module instead of being inlined twice.
   * `defaultProjectsFile` and `defaultRunsDir` were separate copies of
   * `join(homedir(), ".orch", ...)`, and two copies of a fallback rule can
   * disagree - which for a store means a launch that reads one user's projects
   * and writes another's history. */
  for (const dirs of [[], [".orch"], [".kantan"], [".orch", ".kantan"]]) {
    const h = await home(dirs)
    const { dir } = stateDirIn(h)
    expect({ dirs, projects: defaultProjectsFileIn(h) }).toEqual({ dirs, projects: join(dir, "projects.json") })
    expect({ dirs, runs: defaultRunsDirIn(h) }).toEqual({ dirs, runs: join(dir, "runs") })
  }
})
