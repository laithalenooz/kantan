/**
 * Reading a file the caller named, without leaving the directory it named it
 * in.
 *
 * Moved from `src/server.ts` unchanged, and shared rather than copied: the
 * plan route and the feature routes both read a path that arrived from a
 * client, and two implementations of a containment check are two chances to
 * get it wrong in different ways.
 *
 * The symlink reasoning is the whole value of this module and stays with the
 * code: a path can pass a string check and still resolve outside the
 * repository, so the check that counts happens after the open.
 */

import { constants } from "node:fs"
import { open, realpath } from "node:fs/promises"
import { relative, resolve, sep } from "node:path"

/**
 * What one guarded read answered: the text, or which way it would not give it.
 *
 * A code rather than prose, because the two callers say different things about
 * the same outcome - the gate owns "the agent ended its planning turn without
 * writing one", and the tree owns a warning naming a backlog it could not list.
 * `size` is present when the refusal came from the `fstat` and `null` when the
 * bounded read is what found it, which is the difference between a message that
 * can name the size and one that cannot.
 */
export type FileRead =
  | { ok: true; text: string }
  /** Nothing at that path, or a path component that is a file. */
  | { ok: false; why: "missing" }
  /** It resolves outside `root`, so a link is pointing out of the repository. */
  | { ok: false; why: "outside" }
  | { ok: false; why: "not-a-file" }
  | { ok: false; why: "too-large"; size: number | null }
  /** Anything else, with the cause's own message: a permission error, an
   * `ELOOP`, or bytes that are not UTF-8. */
  | { ok: false; why: "failed"; message: string }

/**
 * The same answer, undecoded.
 *
 * Every refusal is shared with `FileRead` - the containment check, the size cap
 * and the open flags are the same work, and the only difference is whether the
 * bytes are handed back or run through a decoder. Spelled as the union minus
 * the success case so a refusal added later lands in both automatically.
 */
export type BytesRead = { ok: true; bytes: Uint8Array<ArrayBuffer> } | Exclude<FileRead, { ok: true }>

/**
 * `joined`'s bytes, if and only if it really sits inside `root`.
 *
 * **The string checks a caller makes on a path are not enough, and this is the
 * function that makes a route safe.** `stat` and `readFile` follow symlinks, so
 * a `docs/plans/x.md` or a `docs/features/x.md` that links to `~/.ssh/id_rsa` -
 * or a `docs/plans` directory that does - passes every check on the path and
 * still reads the key. The agent kantan runs has shell access in that repo, so
 * the link is one command away.
 *
 * Resolved once, and then **opened** with `O_NOFOLLOW` and read through that
 * one handle: the window between resolving and reading is a window the same
 * agent can swap the final component in, and a handle-based `stat` and read
 * cannot be pointed at a second file after the size was checked. Only the final
 * component is covered, which is the realistic case; an intermediate directory
 * swapped mid-request would need `openat` on every segment, which is a
 * different piece of machinery than an HTTP route should carry.
 *
 * `root` must already be canonical - both sides of the containment check are
 * compared as resolved paths, and a `root` that is itself a symlinked spelling
 * would refuse every file under it.
 *
 * **What this does not stop is a hard link**, and that is worth saying plainly
 * rather than leaving to be discovered: `ln ~/.ssh/id_rsa docs/features/x.md`
 * is a second directory entry for the same inode, not a link to follow, so
 * `realpath` answers the path inside the repository and `O_NOFOLLOW` has
 * nothing to refuse. Probed through this route, and the contents came back.
 * Both callers inherit it. Refusing on `st_nlink > 1` would close it, and is
 * not done here because it is a judgement about the threat model rather than
 * about this function: the agent that could make the link can already read the
 * file and paste it into the repo, so the hole is about what this server
 * *renders*, not about what that agent can reach - and a hard-linked file is a
 * thing a real repository can contain.
 */
export async function readBytesInside(root: string, joined: string, maxBytes: number): Promise<BytesRead> {
  let real: string
  try {
    real = await realpath(joined)
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    // `ENOTDIR` is the same answer one level up: a path component that is a
    // file. `ENOENT` is also a dangling symlink, which has nothing to read.
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, why: "missing" }
    return { ok: false, why: "failed", message: (cause as Error).message }
  }
  if (!inside(real, root)) return { ok: false, why: "outside" }

  // `O_NONBLOCK` as well, so a FIFO swapped in where the file was does not hang
  // the request on a writer that never comes.
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (cause) {
    // `ELOOP` is the final component having become a symlink since `realpath`
    // answered, which is the swap this flag exists to refuse.
    return { ok: false, why: "failed", message: (cause as Error).message }
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) return { ok: false, why: "not-a-file" }
    if (info.size > maxBytes) return { ok: false, why: "too-large", size: info.size }
    // Read through the handle the size came from, and read it **bounded**: the
    // check above is a cheap refusal that can name the size, but a file appended
    // to between the two would be read to its new end, and bounding what one
    // GET spends is the cap's only job. One byte past the cap is what makes
    // "too large" detectable here rather than silently truncated - and a short
    // read is why this loops, since dropping half of the document a human is
    // being asked to approve is the worst thing a read could do.
    const buffer = new Uint8Array(maxBytes + 1)
    let total = 0
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    if (total > maxBytes) return { ok: false, why: "too-large", size: null }
    // Copied into an exactly-sized array rather than handed back as a
    // `subarray`: a view would keep the whole `maxBytes + 1` buffer alive
    // behind a few hundred bytes of asset, and the caller may hold it as a
    // response body for as long as the request lasts. The copy also pins the
    // backing store to a real `ArrayBuffer`, which is what `BodyInit` takes.
    const bytes = new Uint8Array(total)
    bytes.set(buffer.subarray(0, total))
    return { ok: true, bytes }
  } catch (cause) {
    return { ok: false, why: "failed", message: (cause as Error).message }
  } finally {
    // Closed because a handle left to the garbage collector is an error on bun
    // 1.4, and swallowing a close failure because the answer is already decided
    // by then - letting it throw would turn a served file into a 500.
    await handle.close().catch((cause: unknown) => console.error(`closing ${real} failed:`, cause))
  }
}

/** Whether `path` is `root` or sits under it. Both sides are canonical where
 * this is called, so there is nothing left for a link to hide behind. */
export function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep)
}

/**
 * `joined`'s contents as **text**, with every guarantee above plus one.
 *
 * Not `utf8`: a decoder that substitutes U+FFFD would show a human mangled
 * prose and let them approve it, and would put a replacement character into a
 * task's text, so invalid bytes refuse as `failed` instead.
 *
 * Split from `readBytesInside` when `GET /assets/:file` arrived: a `.woff2` is
 * not UTF-8 and a fatal decoder is exactly right for a plan and exactly wrong
 * for a font. The alternative was a `binary` flag on one function, which makes
 * the return type depend on an argument and puts two policies behind one name.
 */
export async function readInside(root: string, joined: string, maxBytes: number): Promise<FileRead> {
  const read = await readBytesInside(root, joined, maxBytes)
  if (!read.ok) return read
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(read.bytes) }
  } catch (cause) {
    return { ok: false, why: "failed", message: (cause as Error).message }
  }
}
