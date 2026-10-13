/**
 * Where kantan keeps the state no repository can rebuild.
 *
 * The product is kantan and this directory said `~/.orch` until the rename.
 * Renaming it is easy; renaming it **without stranding the state already
 * there** is the part that needed deciding, because `projects.json` is the
 * only thing in this system that cannot be reconstructed from a git
 * repository or a run log.
 *
 * **A fallback, not a migration. Nothing here moves a file.** Moving a user's
 * data on first launch is hard to undo, easy to get half-right, and would
 * happen before they had any reason to trust the new version. Reading the old
 * location costs one `stat` and is reversible, and the entry point prints
 * which one it chose so nobody has to guess.
 *
 * It lives in its own module because `defaultProjectsFile` and
 * `defaultRunsDir` both need the answer and neither owns it. They used to be
 * two separate copies of `join(homedir(), ".orch", …)`, and two copies of a
 * fallback rule can disagree - which for a store means a launch reading one
 * directory's projects while writing the other's history.
 */

import { statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** What the directory is called now. */
export const STATE_DIR = ".kantan"

/** What it was called before the rename, and still is for anyone who has one. */
export const LEGACY_STATE_DIR = ".orch"

function isDirectory(path: string): boolean {
  try {
    // Follows symlinks on purpose: keeping state on another volume and linking
    // it into the home directory is an ordinary arrangement.
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * The state directory under `home`, and whether it is the legacy one.
 *
 * A skipping guard, so its dimension is enumerated: **which of the two
 * directories exists**. All four values, and what each costs:
 *
 * - *Neither* - a fresh install. The new name, nothing to lose.
 * - *Only `.orch`* - anybody who used kantan before the rename. **This is the
 *   case that matters.** Pointing at an empty `.kantan` would read as "no
 *   projects and no history", and the next write would make that permanent,
 *   which is the one failure in this system that cannot be undone.
 * - *Only `.kantan`* - the new name, obviously.
 * - *Both* - somebody who ran the new version, then an older one, then the new
 *   one again. The new directory wins. It is the only answer that is stable:
 *   any rule keyed on contents means adding a project could change which store
 *   the *next* launch reads. Nothing is merged, because two stores naming one
 *   project path is ambiguous identity rather than a duplicate to reconcile -
 *   and the entry point's line is how a person finds the other one.
 *
 * A *file* at either path is not a state directory: treating one as a
 * directory would send every read and write into an `ENOTDIR` with no clue why.
 */
export function stateDirIn(home: string): { dir: string; legacy: boolean } {
  const fresh = join(home, STATE_DIR)
  if (isDirectory(fresh)) return { dir: fresh, legacy: false }

  const legacy = join(home, LEGACY_STATE_DIR)
  if (isDirectory(legacy)) return { dir: legacy, legacy: true }

  return { dir: fresh, legacy: false }
}

/** `stateDirIn` for the real home directory. */
export function stateDir(): { dir: string; legacy: boolean } {
  return stateDirIn(homedir())
}

export function defaultProjectsFileIn(home: string): string {
  return join(stateDirIn(home).dir, "projects.json")
}

export function defaultRunsDirIn(home: string): string {
  return join(stateDirIn(home).dir, "runs")
}
