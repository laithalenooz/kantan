/**
 * Serving the built UI, so kantan is one process instead of two.
 *
 * T1 in this project's own backlog, and the reason it was the blocker: until
 * this existed, `GET /` answered a stub reading *"the UI arrives in a later
 * task"* and the only supported way to run kantan was `bun run src/server.ts`
 * in one terminal and `bun run ui` in another. That loses most people before
 * they see the app.
 *
 * Four decisions worth keeping:
 *
 * - **The routes live in `ROUTES`, not in `Bun.serve({ routes })`.** That is the
 *   rule the route table's own header states: Bun matches its own table before
 *   the `fetch` handler runs, so an asset route registered there would never
 *   meet the Host, Origin and token checks. A static-file route is exactly the
 *   kind nobody thinks to guard.
 * - **`dist/` is resolved from this module, not from the working directory.**
 *   `import.meta.dir` is `src/routes`, so the build sits two levels up
 *   whatever directory the server was launched from. A cwd-relative path would
 *   serve the stub whenever kantan was started from anywhere else.
 * - **An unknown extension is refused, not guessed.** Everything in
 *   `dist/assets` was put there by Vite and this map covers all of it. Serving
 *   a `.js` as `application/octet-stream` breaks the app as surely as serving
 *   it as `text/plain`, so a file this module cannot name a type for is a 404 -
 *   which is a bug report rather than a blank page.
 * - **The fallback stays.** A checkout with no `dist/` is the normal state of a
 *   fresh clone and of the dev loop, and both are served by Vite on another
 *   port. So `GET /` says what to do rather than 404ing.
 *
 * And one thing that had to be probed rather than reasoned about: **the
 * directory this serves from is canonicalised on every request**, because
 * `readBytesInside` compares `realpath(file)` against the root it was handed
 * and `DEFAULT_DIST` is the *spelling* this module was loaded under. A
 * checkout reached through a symlink - `~/code` pointing at another volume, or
 * macOS resolving `/tmp` to `/private/tmp` - therefore made the containment
 * check refuse the build's own files, and `GET /` answered a page telling
 * somebody who had just run `bun run build` to run `bun run build`. Probed:
 * with the same `dist/` passed by its real path the index came back, and
 * passed by a symlink to it the read answered `outside`.
 *
 * Per request, not once at launch: `dist/` may be built while the server is
 * already up, which is the first thing anyone does after seeing the fallback.
 */

import { realpath } from "node:fs/promises"
import { join } from "node:path"

import type { RouteContext } from "../http/context"
import { fault, refuse } from "../http/guards"
import { readBytesInside, readInside } from "../http/readinside"

/**
 * Where a built UI would be, from this file rather than from the cwd.
 *
 * `import.meta.dir` is `<repo>/src/routes`, so two levels up is the root.
 */
export const DEFAULT_DIST = join(import.meta.dir, "..", "..", "dist")

/**
 * The most an asset may be.
 *
 * The bound exists so a mis-pointed `distDir` cannot stream something huge,
 * and it is this low because `readBytesInside` allocates `maxBytes + 1`
 * **eagerly** - a page load fetches five assets, so a generous cap is a
 * generous allocation five times over for a 731 KB bundle.
 *
 * 8 MB is an order of magnitude above the largest thing this build emits,
 * which is that JS chunk and not one of the ~29 KB fonts.
 */
const MAX_ASSET_BYTES = 8 * 1024 * 1024

/**
 * Content types, by extension.
 *
 * This is a skipping guard, so it gets the treatment `CLAUDE.md` requires
 * rather than the three extensions today's build happens to contain.
 *
 * **The dimension** is the substring from the last `.` of one URL path
 * segment - not the file, not its bytes. Nothing here sniffs content.
 *
 * **Its values**, enumerated: the three this build emits (`.js`, `.css`,
 * `.woff2`); the ones Vite emits from an `import` of an asset, which this
 * project does not do today and could tomorrow (`.svg`, `.png`, `.jpg`,
 * `.gif`, `.webp`, `.avif`, `.wasm`, `.ttf`, `.otf`, `.woff`, `.json`,
 * `.mjs`, `.txt`); `.map`, which only appears when sourcemaps are turned on;
 * a name with no dot and a name that is nothing but a dot, which `typeOf`
 * answers `null` for before this map is consulted; and everything else.
 *
 * **The cost of a wrong guess, in each direction, which is where this stops
 * being a list and starts being a decision:**
 *
 * - *Refusing something real* - a future build emits `.avif` and this map has
 *   not heard of it - costs one 404 on one subresource: a missing image, or a
 *   module that fails to load with the filename right there in the console.
 *   Loud, attributable, and a one-line fix.
 * - *Serving something unknown with a guessed type* costs more than it looks.
 *   `application/octet-stream` breaks a stylesheet and a module script just as
 *   completely, so the permissive version is not actually more permissive - it
 *   just fails further from the cause. And the guess that would "work" for the
 *   widest range of files is `text/html`, which would turn this route into one
 *   that renders arbitrary repository bytes **as a document on kantan's own
 *   origin** - same-origin with the token cookie. That is the asymmetry: the
 *   two directions are a 404 and a stored-XSS sink.
 *
 * So the cheap direction is to refuse, the list is closed, and **no entry here
 * may be `text/html`** - which is also why `index.html` is served by its own
 * handler from a fixed path rather than through this map.
 *
 * `.gz` and `.br` are deliberately absent rather than forgotten: they need a
 * `Content-Encoding`, this route sets none, and serving one as its inner type
 * would hand the browser bytes it cannot read.
 */
const TYPES: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  /* Not `image/svg+xml` by accident: an SVG *is* a document a browser will run
     script in, so it is served as one only because it can only arrive here by
     being in a build this repo produced - and it is still worth knowing that
     this single entry is the one with teeth. */
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
}

function typeOf(name: string): string | null {
  const dot = name.lastIndexOf(".")
  if (dot <= 0) return null
  return TYPES[name.slice(dot).toLowerCase()] ?? null
}

/**
 * `dir` as a canonical path, or `null` when there is nothing there.
 *
 * Both readers below go through this, because `readBytesInside`'s contract is
 * that the root it compares against is already canonical - a root that is
 * itself a symlinked spelling refuses every file under it. See the header for
 * what that looked like before it was probed.
 *
 * A missing directory is `null` rather than a throw: on `GET /` that is a
 * clone nobody has built yet, which is the normal state and not an error.
 */
async function canonical(dir: string): Promise<string | null> {
  try {
    return await realpath(dir)
  } catch {
    return null
  }
}

/**
 * The built `index.html`, or `null` when there is none.
 *
 * Read through `readInside` like every other file this server serves, even
 * though the path is its own: one reader, one containment rule, and nothing
 * that has to be remembered separately here. Text rather than bytes because
 * this one is HTML and a build that is not UTF-8 is a broken build.
 */
export async function builtIndex(distDir: string): Promise<string | null> {
  const root = await canonical(distDir)
  if (root === null) return null
  const read = await readInside(root, join(root, "index.html"), MAX_ASSET_BYTES)
  return read.ok ? read.text : null
}

/**
 * `GET /assets/:file` — one hashed file out of the build.
 *
 * The filename arrives from the URL, so it goes through `readInside` and is
 * held to one path segment by the router: `matchPattern` refuses a segment
 * containing `/` and decodes nothing, so `%2F` cannot put a separator back.
 * The containment check still runs, because a rule enforced in two places is
 * one that survives either being changed.
 */
export async function readAsset(ctx: RouteContext, file: string): Promise<Response> {
  if (file === "" || file.includes("\0")) return refuse(400, "refused: that is not a usable asset name")

  const type = typeOf(file)
  if (type === null) {
    return refuse(404, "no such asset")
  }

  // Bytes, not text: three of the five files Vite emits here are `.woff2`,
  // and the text reader refuses invalid UTF-8 on purpose. Running a font
  // through a fatal decoder answers 404 for a file that is sitting right
  // there, which is the kind of failure that reads as "the server is broken".
  const assets = await canonical(join(ctx.distDir, "assets"))
  if (assets === null) return refuse(404, "no such asset")
  const read = await readBytesInside(assets, join(assets, file), MAX_ASSET_BYTES)
  if (!read.ok) {
    // Switched rather than flattened to one 404, because two of these are a
    // file that is sitting right there and a flat 404 would send whoever hit
    // it looking for a missing file instead of at the real cause.
    switch (read.why) {
      case "missing":
      case "not-a-file":
      // `outside` joins them rather than getting a 403: the router has already
      // refused every spelling that could reach here, so this means a symlink
      // in the build pointing out of it - and a distinct status would tell a
      // prober which paths exist.
      case "outside":
        return refuse(404, "no such asset")
      case "too-large":
        // Not a 4xx: nothing is wrong with the request. The build contains an
        // asset this route will not serve, which is the server's problem and
        // belongs in its terminal - and a 404 for a file that is sitting
        // right there is the lie this switch exists to avoid.
        return fault(`GET /assets/${file}`, `it is larger than this route's ${MAX_ASSET_BYTES} byte cap`)
      case "failed":
        // To the terminal, not the body: the message can carry a local path.
        return fault(`GET /assets/${file}`, read.message)
    }
  }

  return new Response(read.bytes, {
    headers: {
      "Content-Type": type,
      /* Vite hashes every filename in `assets/`, so a given name is one
         immutable byte sequence forever. This is the one place in kantan that
         is not `no-store`, and it is safe for exactly that reason. */
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  })
}
