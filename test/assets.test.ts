import { afterAll, expect, test } from "bun:test"
import { mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { DEFAULT_DIST } from "../src/routes/assets"
import { createServer, type Launch } from "../src/server"

/**
 * Serving the built UI from `GET /`, which is what makes kantan one process.
 *
 * Every test here injects a `distDir`. **None of them reads the real `dist/`**,
 * for the reason `runsDir` is injected everywhere: the suite would otherwise
 * pass or fail on whether the developer happened to have run `bun run build`,
 * and the fallback case would be untestable on a machine that had.
 */

const launched: Launch[] = []
/* Keyed on the pid: several agents run `bun run check` at once here, and a
 * fixed path means one process's `rm -rf` deletes another's fixture mid-test. */
const ROOT = join(import.meta.dir, "..", ".orch-test", "assets", `${process.pid}`)

afterAll(async () => {
  for (const l of launched) l.stop()
  await rm(ROOT, { recursive: true, force: true })
})

let made = 0

/** A `dist/` with `index.html` and whatever assets were asked for. */
async function dist(assets: Record<string, string | Uint8Array> = {}): Promise<string> {
  const dir = join(ROOT, `dist-${made++}`)
  await mkdir(join(dir, "assets"), { recursive: true })
  await writeFile(join(dir, "index.html"), BUILT)
  for (const [name, body] of Object.entries(assets)) await writeFile(join(dir, "assets", name), body)
  return dir
}

const BUILT = `<!doctype html><html lang="en"><head><title>kantan</title>
<script type="module" crossorigin src="/assets/index-abc123.js"></script>
</head><body><div id="root"></div></body></html>
`

function serve(distDir: string): Launch {
  const l = createServer({
    port: 0,
    distDir,
    ask: () => Promise.reject(new Error("no test here may reach a model")),
  })
  launched.push(l)
  return l
}

/** As a browser's first request is: a navigation, with no cookie yet. */
function get(l: Launch, path: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { Host: `127.0.0.1:${l.port}` }
  if (cookie !== undefined) headers["Cookie"] = cookie
  return fetch(`http://127.0.0.1:${l.port}${path}`, { headers })
}

/** The token a page load hands out, which is how the assets become reachable. */
async function bootstrap(l: Launch): Promise<string> {
  const res = await get(l, "/")
  await res.arrayBuffer()
  const cookie = /orch_token=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1]
  if (cookie === undefined) throw new Error("the page load handed out no token")
  return `orch_token=${cookie}`
}

// --- GET / ------------------------------------------------------------------

test("GET / serves the built index when there is one, with the cookie", async () => {
  const l = serve(await dist())
  const res = await get(l, "/")

  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8")
  expect(await res.text()).toBe(BUILT)
  // The bootstrap's other job. A built page that answered without this would
  // load and then 401 on its own first API call.
  expect(res.headers.get("set-cookie")).toContain("orch_token=")
  expect(res.headers.get("set-cookie")).toContain("HttpOnly")
  /* The HTML names hashed asset files, so a cached copy would ask for the
   * previous build's chunks after a rebuild. This header is half of what makes
   * `immutable` on the assets safe. */
  expect(res.headers.get("cache-control")).toBe("no-store")
})

test("GET / falls back to a page naming the build command when dist is absent", async () => {
  const l = serve(join(ROOT, "no-such-dist"))
  const res = await get(l, "/")
  const body = await res.text()

  // 200, not 404: a fresh clone has no build and that is not an error.
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8")
  // The point of the page. Until T1 this said "the UI arrives in a later
  // task", which told a reader nothing they could act on.
  expect(body).toContain("bun run build")
  expect(body).toContain("bun run ui")
  // Still a bootstrap, so a dev-server page proxying through here gets a token.
  expect(res.headers.get("set-cookie")).toContain("orch_token=")
})

test("GET / never puts the token in the body, built or not", async () => {
  // HttpOnly hides the cookie from script; a page that could read its own
  // body would get the same secret back by another door.
  for (const dir of [await dist(), join(ROOT, "no-such-dist")]) {
    const l = serve(dir)
    const res = await get(l, "/")
    expect(await res.text()).not.toContain(l.token)
  }
})

test("a dist with no index.html reads as no build at all", async () => {
  // The guard is `stat(dist/index.html).isFile()`, not `dist/` existing: an
  // interrupted build leaves the directory, and half of one is not a UI.
  const dir = join(ROOT, "empty-dist")
  await mkdir(join(dir, "assets"), { recursive: true })
  const res = await get(serve(dir), "/")
  expect(res.status).toBe(200)
  expect(await res.text()).toContain("bun run build")
})

// --- GET /assets/:file ------------------------------------------------------

test("an asset is served byte for byte, including one that is not UTF-8", async () => {
  /**
   * The regression this pins: three of the five files Vite emits here are
   * `.woff2`, and the guarded reader this route shares decodes UTF-8 with
   * `fatal: true` on purpose - so routing a font through the *text* reader
   * answers an error for a file that is sitting right there. The bytes below
   * are invalid UTF-8 (a lone continuation byte, an unpaired lead byte, a NUL)
   * and are exactly what would be lost or refused.
   */
  const font = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0x00, 0x80, 0xc3, 0xff, 0xfe, 0x01])
  const l = serve(await dist({ "geist-abc123.woff2": font }))
  const res = await get(l, "/assets/geist-abc123.woff2", await bootstrap(l))

  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toBe("font/woff2")
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(font)
})

test("a hashed asset is immutable, which is what the no-store index buys", async () => {
  const l = serve(await dist({ "index-abc123.js": "export const x = 1\n" }))
  const res = await get(l, "/assets/index-abc123.js", await bootstrap(l))
  expect(res.status).toBe(200)
  expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
})

test("an asset needs the token, like every route that is not the bootstrap", async () => {
  // Deliberately not exempt. It works because `GET /` sets the cookie on the
  // navigation that pulls these in - the browser stores a `Set-Cookie` when it
  // processes the response headers, before it parses the HTML referencing them.
  // Exempting it would put a readable file route on this port for any page on
  // any other localhost port to probe.
  const l = serve(await dist({ "index-abc123.js": "export const x = 1\n" }))
  const res = await get(l, "/assets/index-abc123.js")
  expect(res.status).toBe(401)
})

// --- The content-type guard, as a matrix ------------------------------------

/**
 * `typeOf` is a skipping guard, so its dimension is enumerated rather than
 * sampled - `CLAUDE.md`, "The skipping-guard rule". The dimension is the
 * substring after the last `.` of one URL segment.
 *
 * The asymmetry that decides the direction: a refused-but-real asset costs one
 * 404 with the filename in the console, while a *guessed* type for an unknown
 * file is either equally broken (`application/octet-stream` fails a stylesheet
 * and a module script alike) or actively unsafe, since the guess that would
 * render the widest range of files is `text/html` - which would make this route
 * serve arbitrary bytes as a document on kantan's own origin.
 */
const EXTENSIONS: ReadonlyArray<readonly [name: string, type: string | null]> = [
  // The three this build actually emits.
  ["index-abc123.js", "text/javascript; charset=utf-8"],
  ["index-abc123.css", "text/css; charset=utf-8"],
  ["geist-abc123.woff2", "font/woff2"],
  // Emitted by an `import` of an asset, which this project does not do today.
  ["chunk.mjs", "text/javascript; charset=utf-8"],
  ["old.woff", "font/woff"],
  ["old.ttf", "font/ttf"],
  ["old.otf", "font/otf"],
  ["logo.svg", "image/svg+xml"],
  ["shot.png", "image/png"],
  ["shot.jpg", "image/jpeg"],
  ["shot.jpeg", "image/jpeg"],
  ["spin.gif", "image/gif"],
  ["shot.webp", "image/webp"],
  ["shot.avif", "image/avif"],
  ["heavy.wasm", "application/wasm"],
  ["data.json", "application/json; charset=utf-8"],
  ["notes.txt", "text/plain; charset=utf-8"],
  // Only when sourcemaps are turned on, which they are not here.
  ["index-abc123.js.map", "application/json; charset=utf-8"],
  // Refused, and each for a stated reason rather than by omission.
  // No dot at all: nothing to read, so nothing to guess from.
  ["LICENSE", null],
  // A dotfile: `lastIndexOf(".") <= 0`, so there is no extension to read.
  [".env", null],
  // Precompressed variants need a `Content-Encoding` this route does not set,
  // so serving one as its inner type hands the browser bytes it cannot read.
  ["index-abc123.js.gz", null],
  ["index-abc123.js.br", null],
  // Everything else. `...` is a legal filename whose last dot is at index 2,
  // so unlike `.` and `..` it reaches the guard and is refused by it.
  ["...", null],
  ["weird.xyz", null],
  ["notes.md", null],
  ["page.html", null],
  ["page.htm", null],
]

test("every extension in the enumeration gets its type, or a 404", async () => {
  const fixture: Record<string, string> = {}
  for (const [name] of EXTENSIONS) fixture[name] = `body of ${name}\n`
  const l = serve(await dist(fixture))
  const cookie = await bootstrap(l)

  // Every file exists on disk, so a 404 here is the guard refusing and not a
  // missing fixture - which is the whole point of writing them all first.
  for (const [name, type] of EXTENSIONS) {
    const res = await get(l, `/assets/${name}`, cookie)
    const got = res.status === 200 ? res.headers.get("content-type") : null
    await res.arrayBuffer()
    expect({ name, got }).toEqual({ name, got: type })
  }
})

test("a dot segment never reaches the route, percent-encoded or not", async () => {
  /**
   * The two names missing from the matrix above, and the reason they are
   * missing: `.` and `..` **cannot be written to disk**, so their refusal
   * could never be shown to come from the guard rather than from an absent
   * fixture - and they never get that far anyway. The WHATWG URL parser
   * resolves a dot segment during path parsing, and it counts `%2e` as a dot
   * while doing it, so there is no spelling that delivers `..` to a handler.
   *
   * Which makes `/assets/..` **the index page**, not a refusal, and that is
   * worth asserting rather than assuming: a test expecting a 404 there would
   * have been asserting the wrong mechanism and passing for years.
   */
  const l = serve(await dist({ "index-abc123.js": "export const x = 1\n" }))
  const cookie = await bootstrap(l)

  for (const spelling of ["..", "%2E%2E", "%2e%2e"]) {
    // Up out of /assets, so this is a request for "/" - the built index.
    const res = await get(l, `/assets/${spelling}`, cookie)
    expect({ spelling, status: res.status }).toEqual({ spelling, status: 200 })
    expect(await res.text()).toBe(BUILT)
  }

  for (const spelling of [".", "%2E", "%2e"]) {
    // Stays in /assets but names nothing: an empty final segment, which the
    // matcher refuses rather than passing on as an asset name.
    const res = await get(l, `/assets/${spelling}`, cookie)
    await res.arrayBuffer()
    expect({ spelling, status: res.status }).toEqual({ spelling, status: 404 })
  }
})

test("no extension is ever served as a document on kantan's own origin", async () => {
  // The property, not a sample: `text/html` anywhere in that map would turn
  // this route into a stored-XSS sink same-origin with the token cookie.
  // `.html` is absent from it for this reason, and `index.html` is served by
  // its own handler from a fixed path rather than through the map.
  const fixture: Record<string, string> = {}
  for (const [name] of EXTENSIONS) fixture[name] = "<script>alert(1)</script>"
  const l = serve(await dist(fixture))
  const cookie = await bootstrap(l)

  for (const [name] of EXTENSIONS) {
    const res = await get(l, `/assets/${name}`, cookie)
    const type = res.headers.get("content-type")
    await res.arrayBuffer()
    expect({ name, html: type?.includes("text/html") ?? false }).toEqual({ name, html: false })
  }
})

// --- Containment ------------------------------------------------------------

test("a symlink out of the build is refused even though its name looks fine", async () => {
  // The case `readBytesInside` exists for: the name passes every string check
  // and the path resolves somewhere else. A build cannot normally contain one,
  // but the agent kantan runs has write access to a repo and a shell.
  const dir = await dist()
  const outside = join(ROOT, "secret.js")
  await writeFile(outside, "export const secret = 1\n")
  await symlink(outside, join(dir, "assets", "escape-abc123.js"))

  const l = serve(dir)
  const res = await get(l, "/assets/escape-abc123.js", await bootstrap(l))
  expect(res.status).toBe(404)
  expect(await res.text()).not.toContain("secret")
})

test("a traversal survives as a filename rather than becoming a path", async () => {
  const l = serve(await dist({ "index-abc123.js": "export const x = 1\n" }))
  const cookie = await bootstrap(l)

  for (const path of [
    // Resolved by the URL parser before dispatch sees it, so these land on
    // other routes or none - never inside the assets directory.
    "/assets/../../etc/passwd",
    "/assets/..%2F..%2Fetc%2Fpasswd",
    // Two segments cannot match a one-segment pattern.
    "/assets/sub/index-abc123.js",
    // An empty segment is refused by the matcher rather than passed on.
    "/assets/",
  ]) {
    const res = await get(l, path, cookie)
    const body = await res.text()
    expect({ path, ok: res.status === 200 }).toEqual({ path, ok: false })
    expect(body).not.toContain("root:")
  }
})

test("a dist reached through a symlink serves the build, not the fallback", async () => {
  /**
   * The dimension the rest of this file does not vary: every fixture above
   * sits under the canonical repo root, so a green suite says nothing about a
   * checkout reached through a link - `~/code` pointing at another volume, or
   * macOS resolving `/tmp` to `/private/tmp`.
   *
   * It failed when first probed, and quietly: `readBytesInside` compares
   * `realpath(file)` against the root it was handed, `DEFAULT_DIST` is the
   * spelling the module was loaded under, so containment refused the build's
   * own files and `GET /` told somebody who had just run `bun run build` to
   * run `bun run build`.
   */
  const real = await dist({ "index-abc123.js": "export const x = 1\n" })
  const link = join(ROOT, `link-${made++}`)
  await symlink(real, link)

  const l = serve(link)
  const index = await get(l, "/")
  expect(await index.text()).toBe(BUILT)

  const asset = await get(l, "/assets/index-abc123.js", await bootstrap(l))
  expect(asset.status).toBe(200)
  expect(await asset.text()).toBe("export const x = 1\n")
})

test("a symlink out of the build is still refused when dist is itself a link", async () => {
  // The containment check has to survive canonicalising the root - the fix for
  // the test above is a `realpath` on the root, and a `realpath` that resolved
  // too much would make every escape look like it was inside.
  const real = await dist()
  const outside = join(ROOT, "secret-via-link.js")
  await writeFile(outside, "export const secret = 1\n")
  await symlink(outside, join(real, "assets", "escape-abc123.js"))
  const link = join(ROOT, `link-${made++}`)
  await symlink(real, link)

  const l = serve(link)
  const res = await get(l, "/assets/escape-abc123.js", await bootstrap(l))
  expect(res.status).toBe(404)
  expect(await res.text()).not.toContain("secret")
})

test("the default dist is resolved from the module, not the working directory", () => {
  // A cwd-relative default would serve the fallback page whenever kantan was
  // started from anywhere but the repo root, which is most of the time.
  expect(DEFAULT_DIST.startsWith("/")).toBe(true)
  expect(DEFAULT_DIST.endsWith(`${"/"}dist`)).toBe(true)
})
