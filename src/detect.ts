/**
 * What kantan can learn about a folder before anyone registers it.
 *
 * `src/ui/AddRepo.tsx` has drawn a progressive, sentence-by-sentence check of
 * the path in its box since it was ported, and `detectPath` in
 * `src/ui/live.ts` has called `POST /api/detect` to fill it. **That route did
 * not exist.** `detectPath` swallows a failure and answers `null`, so the whole
 * screen sat at `phase: "idle"`: no checks, no root, no task-file preview, no
 * detected command. Someone adding a repository typed a path blind and got the
 * register route's raw 400 - reported from use as exactly that, a JSON error
 * body where a sentence belonged.
 *
 * Two rules shape everything here.
 *
 * **`usable` is `requireUsableRepo`'s answer, never a count of ticks.**
 * `AddRepo`'s own docstring insists on this: a reading of the check list is a
 * second implementation of the same rule and would drift from the first. So the
 * checks are *prose about* the decision, and the decision is made once.
 *
 * **A detected test command is a guess, so it only ever reports a command a
 * file in the repo declares.** `AddRepo` says it plainly - "there is no default
 * command, because a wrong one fails every run" - and the asymmetry is the
 * reason: a wrong command fails every run of that project until a human
 * notices, while no command leaves a field empty that they were going to fill
 * anyway. Nothing is inferred from a dependency, a framework or a folder name.
 */

import { readFile, stat } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

import { requireUsableRepo } from "./git"
import { listFeatureFiles } from "./featurefile"
import { parseFeature } from "./backlog"

/** A machine value renders in mono; see `DetectionPhrase` in `AddRepo.tsx`. */
export type Phrase = ReadonlyArray<string | { mono: string }>

export interface Check {
  code?: string
  status: "pass" | "fail" | "info"
  says: Phrase
}

export interface PreviewTask {
  ref: string | null
  text: string
}

export interface TaskFilePreview {
  path: string
  tasks: PreviewTask[]
}

export interface Detection {
  phase: "done"
  path: string
  usable: boolean
  checks: Check[]
  root?: string
  testCmd?: string
  testCmdSource?: string
  taskFiles?: TaskFilePreview[]
}

/**
 * How many tasks a preview reads from one file, and how many files it previews.
 *
 * The preview is a reassurance that kantan is reading the right files, not a
 * second tree: a repo with forty task files does not need forty rendered
 * before anyone has pressed Add. Bounded here rather than in the component,
 * because the cost is the read and the JSON, not the markup.
 */
const MAX_PREVIEW_FILES = 8
const MAX_PREVIEW_TASKS = 12

/** A manifest is read only if it is small; a 50 MB `package.json` is not one. */
const MAX_MANIFEST_BYTES = 512 * 1024

/**
 * The test command a file in the repo **declares**, or `null`.
 *
 * This is a skipping guard in `CLAUDE.md`'s sense and its dimension is *which
 * manifest exists and what it says*. The enumeration:
 *
 * | file | reported when | command |
 * |---|---|---|
 * | `package.json` | it has a non-blank `scripts.test` | `<pm> test`, the pm from the lockfile |
 * | `composer.json` | it has a `scripts.test` | `composer test` |
 * | `Makefile` | it has a `test:` target at column zero | `make test` |
 * | `Cargo.toml` | it exists | `cargo test` |
 * | `go.mod` | it exists | `go test ./...` |
 *
 * The first three read a **declaration**: the repo itself says a test script
 * exists and what to call it. The last two are the ecosystem's single answer -
 * there is no other way to run Rust or Go tests - which is why they are
 * allowed to key on the file existing. Nothing else is: a `pytest` in a
 * dependency list says a library is installed, not that the suite is run that
 * way, and `jest` beside a `scripts.test` would be a second guess at the same
 * question.
 *
 * In manifest order and first match wins, so a polyglot repo gets its most
 * specific declaration rather than a merge of several.
 */
export async function detectTestCommand(
  root: string,
): Promise<{ testCmd: string; source: string } | null> {
  const read = async (name: string): Promise<string | null> => {
    try {
      const file = join(root, name)
      const info = await stat(file)
      if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) return null
      return await readFile(file, "utf8")
    } catch {
      return null
    }
  }

  const packageJson = await read("package.json")
  if (packageJson !== null) {
    const script = scriptNamed(packageJson, "test")
    if (script !== null) return { testCmd: `${await packageManager(root)} test`, source: "package.json" }
  }

  const composerJson = await read("composer.json")
  if (composerJson !== null && scriptNamed(composerJson, "test") !== null) {
    return { testCmd: "composer test", source: "composer.json" }
  }

  const makefile = (await read("Makefile")) ?? (await read("makefile"))
  // A target at column zero. An indented `test:` is a recipe line or a
  // variable, and `make test` would not reach it.
  if (makefile !== null && /^test:/m.test(makefile)) {
    return { testCmd: "make test", source: "Makefile" }
  }

  if ((await read("Cargo.toml")) !== null) return { testCmd: "cargo test", source: "Cargo.toml" }
  if ((await read("go.mod")) !== null) return { testCmd: "go test ./...", source: "go.mod" }

  return null
}

/**
 * A non-blank `scripts.<name>` in a JSON manifest, or `null`.
 *
 * Parse failures answer `null` rather than throwing: a `package.json` that is
 * not valid JSON is a repo with a broken manifest, which is a thing to let
 * someone register and fix - not a reason to refuse to look at their folder.
 */
function scriptNamed(json: string, name: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== "object") return null
  const scripts = (parsed as { scripts?: unknown }).scripts
  if (scripts === null || typeof scripts !== "object") return null
  const script = (scripts as Record<string, unknown>)[name]
  return typeof script === "string" && script.trim() !== "" ? script : null
}

/**
 * Which package manager runs the declared script, from the lockfile.
 *
 * A guess with a cheap failure in both directions: the command lands in a
 * field the human is looking at, and every one of these runs the same
 * `scripts.test`. `npm` last because it is the one that works without a
 * lockfile at all.
 */
async function packageManager(root: string): Promise<string> {
  const has = async (name: string): Promise<boolean> => {
    try {
      return (await stat(join(root, name))).isFile()
    } catch {
      return false
    }
  }
  if ((await has("bun.lock")) || (await has("bun.lockb"))) return "bun run"
  if (await has("pnpm-lock.yaml")) return "pnpm"
  if (await has("yarn.lock")) return "yarn"
  return "npm run"
}

/**
 * Everything the add-a-repository screen asks about one path.
 *
 * `registered` is a **fail**, not an `info`: `POST /api/projects` refuses a
 * second registration with a 409 whose message explains why (it would reset
 * settings tuned by hand), so registration genuinely cannot proceed and
 * `usable` has to say so. A detached HEAD or a dirty tree, by contrast, refuse
 * a *run* rather than a registration, so they are `info` - stopping someone
 * from adding a repository over something one `git switch` fixes would be the
 * wrong call, and `AddRepo`'s own docstring says as much.
 */
export async function detect(path: string, registeredPaths: readonly string[] = []): Promise<Detection> {
  const checks: Check[] = []

  if (path.trim() === "") {
    return { phase: "done", path, usable: false, checks: [{ code: "absolute", status: "fail", says: ["Type the full path to a git repository."] }] }
  }
  if (!isAbsolute(path)) {
    // Before anything touches the disk: a relative path names a different
    // folder depending on where the server was launched, so there is nothing
    // honest to check it against.
    return {
      phase: "done",
      path,
      usable: false,
      checks: [
        {
          code: "absolute",
          status: "fail",
          says: [{ mono: path }, " is not an absolute path, so it would mean a different folder depending on where kantan was started."],
        },
      ],
    }
  }
  checks.push({ code: "absolute", status: "pass", says: ["An absolute path."] })

  let repo
  try {
    repo = await requireUsableRepo(path)
  } catch (cause) {
    // git.ts throws plain `Error`s, so the sentence is passed through rather
    // than matched on to derive a code - `DetectionCheck.code` is optional for
    // exactly this reason, and matching prose is the guess `AddRepo` refuses.
    checks.push({ status: "fail", says: [(cause as Error).message] })
    return { phase: "done", path, usable: false, checks }
  }
  checks.push({ code: "repo", status: "pass", says: ["A git repository with a working tree."] })
  if (repo.root !== path) {
    checks.push({
      code: "root",
      status: "info",
      says: ["git resolves it to ", { mono: repo.root }, ", which is what kantan will register."],
    })
  }

  const already = registeredPaths.includes(repo.root) || registeredPaths.includes(path)
  if (already) {
    checks.push({
      code: "registered",
      status: "fail",
      says: ["kantan already tracks this repository. Open it from the list instead — registering it again would reset settings you may have tuned."],
    })
  }

  const taskFiles = await previewTaskFiles(repo.root)
  checks.push(
    taskFiles.length === 0
      ? {
          code: "tasks",
          status: "info",
          says: ["No ", { mono: "docs/features" }, " files yet. You can add one after registering, or describe the work and let kantan draft it."],
        }
      : {
          code: "tasks",
          status: "pass",
          says: [
            `${taskFiles.length} task file${taskFiles.length === 1 ? "" : "s"} in `,
            { mono: "docs/features" },
            `, holding ${taskFiles.reduce((n, f) => n + f.tasks.length, 0)} tasks.`,
          ],
        },
  )

  const found = await detectTestCommand(repo.root)
  checks.push(
    found === null
      ? {
          code: "tests",
          status: "info",
          says: ["No test command declared in the repository. Say how to run the tests below, or tell kantan this project has none."],
        }
      : {
          code: "tests",
          status: "pass",
          says: [{ mono: found.source }, " declares a test script, so ", { mono: found.testCmd }, " is the command."],
        },
  )

  return {
    phase: "done",
    path,
    // The decision, made once, by the function that owns it.
    usable: !already,
    checks,
    root: repo.root,
    ...(found === null ? {} : { testCmd: found.testCmd, testCmdSource: found.source }),
    ...(taskFiles.length === 0 ? {} : { taskFiles }),
  }
}

/** The task files, parsed, bounded; see `MAX_PREVIEW_FILES`. */
async function previewTaskFiles(root: string): Promise<TaskFilePreview[]> {
  let files: string[]
  try {
    files = await listFeatureFiles(root)
  } catch {
    // A `docs/features` that is a file, or unreadable. Not a reason to refuse
    // the folder; `listFeatureFiles`' own rules already answer `[]` for the
    // ordinary absence.
    return []
  }
  const out: TaskFilePreview[] = []
  for (const file of files.slice(0, MAX_PREVIEW_FILES)) {
    try {
      const src = await readFile(file, "utf8")
      const relative = file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file
      out.push({
        path: relative,
        tasks: parseFeature(src)
          .tasks.slice(0, MAX_PREVIEW_TASKS)
          .map((t) => ({ ref: t.ref, text: t.text })),
      })
    } catch {
      // One unreadable file does not spoil the preview of the others.
    }
  }
  return out
}
