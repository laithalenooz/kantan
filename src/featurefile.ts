import { open, readFile, readdir, realpath, rename, stat, unlink } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { appendTasks, parseFeature, removeTask, tickTask } from "./backlog"
import type { Feature } from "./backlog"

/** The backlog lives in the user's own repo, in a flat directory. */
const FEATURES_DIR = ["docs", "features"] as const

/** The extensions a feature file may carry, lower-cased for comparison. `.md`
 * is the documented convention and the only one the drafter writes; its long
 * spelling is here because a repo that uses it would otherwise have an
 * invisible backlog, and an extra extension costs nothing. */
const MARKDOWN_EXTENSIONS = [".md", ".markdown"] as const

/**
 * Every feature file in `repoPath`, as absolute paths, sorted so a listing is
 * stable between calls.
 *
 * This is a skipping guard, and the dimension it reads is the directory entry:
 * its name, and its type *after* following a symlink. Over-including shows the
 * folder's README as a feature; under-including makes a real backlog invisible,
 * which is worse, so the guard is loose wherever the two are close.
 *
 * Included: a `.md` or `.markdown` file, in any case, since case is no signal
 * on a case-insensitive filesystem; a symlink to one, which is how a backlog is
 * shared between repos; and a file that parses to no tasks, because a feature
 * mid-draft is still the user's file and filtering on the parse result would
 * let a parser blind spot disappear a file.
 *
 * Excluded: `README.md`, which is documentation about the folder - and content
 * cannot rescue it, since the parser does not read fenced blocks, so a README
 * documenting the house format parses as holding real tasks. A name with no
 * markdown extension, because nothing this tool writes lacks one and the
 * drafter only ever writes `<slug>.md`, so the file it hides is one the tool
 * never created. A dotfile, which is an editor or tool artifact - a vim swap
 * file, an emacs lock, or a temp file left by an interrupted write of ours. A
 * subdirectory, not recursed into: the layout is flat, so a markdown file
 * deeper down is an archive or a sub-organised copy, and listing a retired
 * feature as runnable invites a run against a file the user put away. A
 * symlink to a directory, which is a directory, and a broken symlink, which
 * has nothing to read.
 *
 * An absent directory is the normal first state of a repo and reads as no
 * features. Any other failure throws, because an empty list cannot be told
 * apart from a repo that never had a backlog.
 */
export async function listFeatureFiles(repoPath: string): Promise<string[]> {
  const dir = resolve(repoPath, ...FEATURES_DIR)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (e) {
    if (isErrno(e, "ENOENT")) return []
    throw e
  }

  const found: string[] = []
  for (const name of names.sort()) {
    if (!isFeatureName(name)) continue
    const path = join(dir, name)
    // `stat`, never the dirent: a dirent for a symlink answers
    // `isSymbolicLink()` and never `isFile()`, so the naive check would drop
    // every linked backlog. ENOENT is a dangling link and ELOOP a cycle;
    // anything else - a directory we cannot search, say - is a fault to raise
    // rather than a file to skip.
    let entry
    try {
      entry = await stat(path)
    } catch (e) {
      if (isErrno(e, "ENOENT") || isErrno(e, "ELOOP")) continue
      throw e
    }
    if (entry.isFile()) found.push(path)
  }
  return found
}

/** Whether `name` names a feature file, judged by the name alone. */
function isFeatureName(name: string): boolean {
  if (name.startsWith(".")) return false
  const lower = name.toLowerCase()
  if (!MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext))) return false
  return !MARKDOWN_EXTENSIONS.some((ext) => lower === `readme${ext}`)
}

function isErrno(e: unknown, code: string): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === code
}

/** A feature file, parsed, with the exact bytes it was parsed from. */
export interface FeatureFile extends Feature {
  /** The path it was read from, link and all, not the path it resolves to. */
  path: string
  /** The file's bytes, decoded and otherwise untouched. `Task.line` indexes
   * this string and nothing else. */
  src: string
}

export interface TickResult {
  /** Whether bytes actually reached the disk. False for an already-ticked
   * task, which is a no-op on purpose so a retried run cannot disturb a
   * finished file - a caller that logs or commits "ticked" must read this
   * rather than assume a write happened. */
  written: boolean
  /** The bytes now on disk. */
  src: string
  /** Set when the file had changed since it was parsed, which design §5 lists
   * as expected: the human edits the markdown mid-run. The tick still lands,
   * because it is re-resolved by ref, but the caller should say so. */
  warning: string | null
}

/**
 * UTF-8, strictly, and with the BOM left in place.
 *
 * Both options read backwards. `fatal` makes an invalid byte throw instead of
 * decoding to U+FFFD, which matters because the string is written back: a
 * lossy decode would rewrite bytes the tool was asked to leave alone.
 * `ignoreBOM: true` means "do not give the BOM special treatment", so it stays
 * in the output - the default, `false`, silently strips it, and nothing
 * downstream would put it back.
 */
const DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

function decode(bytes: Uint8Array, path: string): string {
  try {
    return DECODER.decode(bytes)
  } catch {
    throw new Error(
      `${path} is not valid UTF-8. Ticking a task rewrites the whole file from the decoded text, so a byte that cannot be decoded would be replaced rather than preserved; refusing instead.`,
    )
  }
}

/** Reads and parses a feature file, keeping the bytes it was parsed from. */
export async function readFeature(path: string): Promise<FeatureFile> {
  const src = decode(await readFile(path), path)
  return { path, src, ...parseFeature(src) }
}

/**
 * Ticks `ref` in `file` on disk, and reports whether that wrote anything.
 *
 * The file is re-read first, because the human may have edited it since it was
 * parsed, and the tick is resolved against the bytes now on disk by ref -
 * never by `file`'s cached line numbers, which describe a string that no
 * longer exists. A changed file is warned about rather than refused: the edit
 * is expected, and last write wins. If the ref is gone from the new bytes the
 * write is refused instead of guessed at.
 */
export async function tickTaskInFile(file: FeatureFile, ref: string): Promise<TickResult> {
  const fresh = decode(await readFile(file.path), file.path)
  const changed = fresh !== file.src
  const warning = changed
    ? `${file.path} changed on disk since it was parsed; ${ref} was re-resolved against the bytes now on disk`
    : null

  let out: string
  try {
    out = tickTask(fresh, ref)
  } catch (e) {
    if (!changed) throw e
    throw new Error(
      `${file.path} changed on disk since it was parsed, and ${ref} can no longer be ticked: ${describe(e)}`,
      { cause: e },
    )
  }

  // Idempotent, so a retried run leaves a finished file alone - including its
  // mtime, which is why this returns before touching the disk at all.
  if (out === fresh) return { written: false, src: fresh, warning }

  await writeExact(file.path, out)
  return { written: true, src: out, warning }
}

/** What removing a task did. Mirrors `TickResult`, and for the same reasons. */
export interface RemoveResult {
  /** The bytes now on disk. */
  src: string
  /** The text of the task that went, so a caller can say what it removed. */
  removed: string
  /** Set when the file had changed since it was parsed; see `TickResult`. */
  warning: string | null
}

/**
 * Removes `ref` from `file` on disk.
 *
 * The file is re-read first and the ref re-resolved against the bytes now on
 * disk, exactly as `tickTaskInFile` does and for the same reason: the human
 * edits the markdown while kantan is looking at it, and cached line numbers
 * describe a string that no longer exists. Here that re-read is doing more
 * work than it does for a tick - a stale line number would make a tick write
 * `[x]` on the wrong line, and would make *this* delete the wrong line.
 *
 * There is no idempotent case to skip. A tick of an already-ticked task is a
 * no-op because the end state is the same either way; a ref that is not in the
 * file has no end state to reach, so `removeTask` refuses and that refusal is
 * passed on rather than swallowed. "It was already gone" and "it is gone
 * because I removed it" are different answers, and only one of them should let
 * a caller report a removal.
 */
export async function removeTaskFromFile(file: FeatureFile, ref: string): Promise<RemoveResult> {
  const fresh = decode(await readFile(file.path), file.path)
  const changed = fresh !== file.src
  const warning = changed
    ? `${file.path} changed on disk since it was parsed; ${ref} was re-resolved against the bytes now on disk`
    : null

  // Read before the write, from the same bytes the write is computed from, so
  // the text reported is the text that actually went.
  const going = parseFeature(fresh).tasks.find((t) => t.ref === ref)

  let out: string
  try {
    out = removeTask(fresh, ref)
  } catch (e) {
    if (!changed) throw e
    throw new Error(
      `${file.path} changed on disk since it was parsed, and ${ref} can no longer be removed: ${describe(e)}`,
      { cause: e },
    )
  }

  await writeExact(file.path, out)
  return { src: out, removed: going?.text ?? ref, warning }
}

/** What appending tasks did. */
export interface AppendResult {
  /** The bytes now on disk. */
  src: string
  /** The refs the new tasks were given, in the order the texts came in. */
  refs: string[]
  /** Set when the file had changed since it was parsed; see `TickResult`. */
  warning: string | null
}

/**
 * Appends `texts` to `file` on disk as new tasks.
 *
 * Numbered against the bytes **now on disk**, which is the whole reason this
 * re-reads rather than trusting what it was handed. The texts were drafted or
 * typed against a file the human may have edited since - and a ref chosen from
 * a stale read is a ref that may already exist, which is the one mistake
 * `appendTasks` is written to avoid. A tick re-reads to find the right line; so
 * does this, to find the right number.
 *
 * No idempotent case: appending the same text twice is two tasks, because that
 * is what it means. Nothing here tries to recognise a repeat - two tasks
 * reading the same sentence are a thing a human may legitimately want, and
 * guessing otherwise would silently drop work.
 */
export async function appendTasksToFile(file: FeatureFile, texts: readonly string[]): Promise<AppendResult> {
  const fresh = decode(await readFile(file.path), file.path)
  const changed = fresh !== file.src
  const warning = changed
    ? `${file.path} changed on disk since it was parsed; the new tasks were numbered against the bytes now on disk`
    : null

  const { src, refs } = appendTasks(fresh, texts)
  if (refs.length === 0) return { src: fresh, refs: [], warning }

  await writeExact(file.path, src)
  return { src, refs, warning }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Replaces `path` with `src` by renaming a complete temp file over it, so an
 * interrupted write leaves the user's feature file as it was rather than
 * truncated. The temp file sits in the same directory, because a rename across
 * filesystems is a copy and is not atomic, and its name is unique per writer.
 *
 * The temp name is a dotfile so that a crash-left one is hidden from discovery
 * and from an `ls`, which matters more here than it does for the project
 * store: this file lives inside the user's own repository, where a stray
 * sibling would show up in their `git status`.
 *
 * The fsync matters as much as the rename: on a delayed-allocation filesystem
 * a crash just after the rename can otherwise leave the new name pointing at
 * zero bytes, which is the truncation the rename was there to prevent. The
 * directory itself is not synced, so a power loss can lose the newest tick -
 * never corrupt the file.
 *
 * A link is followed rather than renamed over, because discovery lists a
 * symlinked feature file and renaming over the link would turn it into a
 * regular file: later ticks would stop reaching the real file, with nothing to
 * show why. The temp file then belongs beside the target, which is also the
 * only place the rename is guaranteed to stay on one filesystem.
 */
async function writeExact(path: string, src: string): Promise<void> {
  const target = await realpath(path)
  // A rename takes the temp file's mode, so without this every tick would
  // reset a mode the user chose - inside their git repo, where it is tracked.
  const mode = (await stat(target)).mode & 0o777
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    const fh = await open(tmp, "wx")
    try {
      // chmod rather than open's mode argument, which the umask masks: under
      // the usual 022 a file the user had chmod'd 0o664 would come back 0o644
      // after one tick, which is the quiet drift this prevents.
      await fh.chmod(mode)
      await fh.writeFile(src, "utf8")
      await fh.sync()
    } finally {
      await fh.close()
    }
    await rename(tmp, target)
  } catch (e) {
    // Best effort: if `open` is what failed there is nothing to remove.
    await unlink(tmp).catch(() => {})
    throw e
  }
}
