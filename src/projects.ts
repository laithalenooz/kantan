import { mkdir, open, readFile, readlink, realpath, rename, stat, unlink } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"

export type Effort = "low" | "medium" | "high" | "xhigh" | "max"

/** The two modes the design supports, out of the six the CLI accepts. `plan`,
 * `dontAsk`, `auto`, `manual` and `default` are refused rather than forwarded:
 * each would spawn a phase that cannot do its job, and the run would fail for
 * a reason nothing connects back to this line of config. */
export type PermissionMode = "acceptEdits" | "bypassPermissions"

export interface Project {
  /** Repo root, absolute. Also the record's identity in the store. */
  path: string
  /** e.g. "npm test", "vendor/bin/pest", "flutter test". */
  testCmd: string
  /** JUnit XML, relative to `path`, for the stall signature. */
  reportPath?: string
  /** CLAUDE_CONFIG_DIR for this project's runs; absent means the default
   * profile. A profile carries its own CLAUDE.md, skills, plugins and
   * settings, not just credentials, so this is not only about which account. */
  configDir?: string
  /** How a phase is spawned, per design §2.2. `acceptEdits` with an allowlist
   * is the shipped default, because `bypassPermissions` is fine on the
   * author's machine and wrong for a stranger pointing this at a repo they
   * care about. In headless mode anything that would prompt is auto-denied, so
   * `acceptEdits` alone - which does not cover `Bash` - would fail
   * confusingly rather than safely: the allowlist is what makes it usable. */
  permissionMode: PermissionMode
  /** The exact tool rules to allow, or `null` to derive them from the repo and
   * `testCmd` (`deriveAllowedTools` in src/permissions.ts). An explicit list is
   * passed through untouched and never merged with the derived set, or nobody
   * could express "only these". Meaningless under `bypassPermissions`, where
   * the flag is not passed at all. */
  allowedTools: string[] | null
  budgetUsd: number
  /** Planning runs on the stronger reasoner. */
  planModel: string
  /** Implementing runs on the model with more turns. */
  implementModel: string
  planEffort: Effort
  implementEffort: Effort
}

/** Everything but the repo and its test command has a default. */
export type NewProject = Partial<Project> & Pick<Project, "path" | "testCmd">

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const
const PERMISSION_MODES = ["acceptEdits", "bypassPermissions"] as const

/**
 * Every field a record may hold, in the order it is written. Serving as both
 * the allowlist and the key order means a field cannot be added to one and
 * forgotten in the other.
 *
 * **Adding a field moves four places together**: `Project`, this list,
 * `DEFAULTS` and `validateProject`. Miss this list and the tool's own writes
 * stop loading, because `rejectUnknownFields` refuses the key it just wrote.
 * Miss `DEFAULTS` and the `satisfies` below is a compile error, which is the
 * one mistake that catches itself.
 *
 * `permissionMode` and `allowedTools` were the first fields added after stores
 * existed, so they also settle the absence policy: **a field younger than the
 * store format defaults when it is absent**, because a value nobody could have
 * typed cannot be lost by defaulting, and a misspelled key is still caught by
 * `rejectUnknownFields`. A field that has always existed throws when absent,
 * because there an absence means a damaged record rather than an older one.
 */
const FIELDS = [
  "path",
  "testCmd",
  "reportPath",
  "configDir",
  "permissionMode",
  "allowedTools",
  "budgetUsd",
  "planModel",
  "implementModel",
  "planEffort",
  "implementEffort",
] as const

/**
 * Fields this version no longer has, which a store may still name.
 *
 * Removing a field is the same question as adding one, and the answer has to
 * be consistent: a key the tool no longer honours is **not** a typo, so there
 * is no setting left to lose and refusing to load would punish someone for our
 * change. It loads, it is ignored, and `validateProject` rebuilds the record
 * from `FIELDS`, so the next write drops it - visible in the diff of a file
 * that is hand-edited and read in diffs.
 *
 * Only the exact retired name is forgiven. Anything near it is a key this tool
 * has never had, which is the ordinary lost-line case and still throws.
 *
 * - `resumePlanSession` ran plan and implement in one conversation. Removed
 *   once Task 15 showed that honouring it would make two lines of the implement
 *   prompt false - it tells the agent it has not seen the conversation that
 *   wrote the plan - and that is not worth a conditional inside the most
 *   load-bearing strings in the project.
 */
const RETIRED = new Set(["resumePlanSession"])

/** The design's defaults. Planning leads on code reasoning, implementing
 * leads on terminal work and has far more turns; they are two conversations,
 * so each phase can have the model that suits it. */
const DEFAULTS = {
  permissionMode: "acceptEdits",
  allowedTools: null,
  budgetUsd: 50,
  planModel: "claude-opus-5-5",
  implementModel: "claude-sonnet-5-5",
  planEffort: "high",
  implementEffort: "medium",
} satisfies Omit<Project, "path" | "testCmd" | "reportPath" | "configDir">

/**
 * Fills the design's defaults around what the caller supplied, then validates,
 * so the result is a record the store will accept. Idempotent: running it on a
 * record it already produced changes nothing, because each field is taken when
 * present rather than spread over a defaults literal - a spread would let an
 * explicitly `undefined` field from a half-filled form clobber its default.
 */
export function defaults(partial: NewProject): Project {
  // Shape before keys: this is handed parsed request bodies, and reading keys
  // off null raises a TypeError that names neither the field nor the function.
  rejectUnknownFields(asRecord(partial, "project"), "project")
  return validateProject(
    {
      path: partial.path,
      testCmd: partial.testCmd,
      reportPath: partial.reportPath,
      configDir: partial.configDir,
      permissionMode: partial.permissionMode ?? DEFAULTS.permissionMode,
      allowedTools: partial.allowedTools ?? DEFAULTS.allowedTools,
      budgetUsd: partial.budgetUsd ?? DEFAULTS.budgetUsd,
      planModel: partial.planModel ?? DEFAULTS.planModel,
      implementModel: partial.implementModel ?? DEFAULTS.implementModel,
      planEffort: partial.planEffort ?? DEFAULTS.planEffort,
      implementEffort: partial.implementEffort ?? DEFAULTS.implementEffort,
    },
    "project",
  )
}

/**
 * The projects in `file`, or `[]` when there is no such file yet.
 *
 * Only an absent file reads as empty. Anything else - unreadable, truncated,
 * not JSON, not an array, or a record this version cannot read with certainty
 * - throws with the file path, the record and the field in the message. This
 * is the one piece of state no repository can rebuild, and `addProject` writes
 * what this function returns, so reading a damaged store as "no projects" is
 * how a tool erases the configuration a person typed. An editor can fix what a
 * message points at; it cannot fix what was silently replaced.
 */
export async function loadProjects(file: string): Promise<Project[]> {
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch (e) {
    if (isErrno(e, "ENOENT")) return []
    throw e
  }
  return parseStore(text, file)
}

/**
 * Adds `project` to `file`, or replaces the record with the same `path`.
 *
 * The replacement is wholesale, not a merge: the caller passes a complete
 * record, so merging would resurrect a `configDir` or `reportPath` they had
 * just cleared.
 */
export async function addProject(file: string, project: Project): Promise<void> {
  // Before anything is read or written: a rejected record must not be able to
  // reach the file. If only loadProjects validated, one bad call here would
  // leave a store that every later load refuses - bricked by its own tool.
  const record = validateProject(project, `project for ${file}`)
  // The queue slot is taken here, synchronously, before the first await: a
  // queue joined after the store's path had been resolved would run in the
  // order the filesystem answered rather than the order the saves were made,
  // and two saves of one project would apply newest first.
  return serialised(async () => {
    const target = await storePath(file)
    const all = await loadProjects(target)
    const at = all.findIndex((p) => p.path === record.path)
    if (at === -1) all.push(record)
    else all[at] = record
    await writeStore(target, all)
  })
}

/**
 * The file a write should actually replace.
 *
 * A store symlinked into a dotfiles repo is a normal setup, and renaming over
 * the link would replace it with a regular file: later writes would stop
 * reaching the tracked copy, with nothing to show why. That holds for a link
 * whose target does not exist yet, which is what a checkout wired up ahead of
 * the first project looks like, so the link is followed by hand in that case.
 */
async function storePath(file: string): Promise<string> {
  try {
    return await realpath(file)
  } catch (e) {
    if (!isErrno(e, "ENOENT")) throw e
  }

  // Nothing there, or a link to something that is not there yet. Each hop is
  // resolved against the link's canonical directory, which is what the kernel
  // does: resolving "../store.json" against a lexical parent would name a
  // different file whenever an ancestor is itself a link. The hop count is
  // bounded and fails closed, because a chain that long is a mistake.
  let target = await canonicalise(resolve(file))
  for (let hop = 0; ; hop++) {
    if (hop === 8) throw new Error(`${file}: too many symlinks to follow to reach a store file`)
    let to: string
    try {
      to = await readlink(target)
    } catch (e) {
      // EINVAL is the ordinary answer: the path is not a symlink.
      if (isErrno(e, "EINVAL") || isErrno(e, "ENOENT")) return target
      throw e
    }
    target = await canonicalise(resolve(dirname(target), to))
  }
}

/**
 * `p` with its deepest existing ancestor replaced by that ancestor's real
 * path, and the missing tail appended. Directories that do not exist yet
 * cannot be links, so this is as canonical as the path can be made.
 *
 * It is what makes the hop above match the kernel: a relative link target is
 * resolved against the link's physical parent, so a lexical `dirname` would
 * name a different file whenever an ancestor is itself a link.
 */
async function canonicalise(p: string): Promise<string> {
  const missing = [basename(p)]
  let dir = dirname(p)
  for (;;) {
    try {
      return join(await realpath(dir), ...missing)
    } catch (e) {
      if (!isErrno(e, "ENOENT")) throw e
    }
    const parent = dirname(dir)
    // The root always exists, so this is a path no filesystem would accept.
    if (parent === dir) return p
    missing.unshift(basename(dir))
    dir = parent
  }
}

/**
 * One store write at a time, in the order the calls were made.
 *
 * `addProject` is a read-modify-write, so two running together would both read
 * the same snapshot and the second rename would drop the first one's record -
 * a project a person configured, gone with no error.
 *
 * One queue rather than one per file, for two reasons: a process has a single
 * store, and queueing by path would have to resolve the path first, which is
 * the await that let the saves reorder. It also means two names for one store
 * cannot race each other.
 *
 * In-process only, and deliberately: kantan runs one local server. A second
 * process writing the same file can still lose an update, though the rename
 * keeps the file whole either way. A cross-process lock would mean a lockfile
 * that can go stale, and explaining a stale lock to a user is worse than the
 * race it prevents here.
 */
let writes: Promise<void> = Promise.resolve()

function serialised<T>(job: () => Promise<T>): Promise<T> {
  // `job` runs whether the write before it resolved or rejected. That caller
  // already has its own rejection; holding it against the next write would
  // mean one bad store wedged every write for the life of the process.
  const run = writes.then(job, job)
  writes = run.then(
    () => {},
    () => {},
  )
  return run
}

function parseStore(raw: string, file: string): Project[] {
  // A hand-edited file is whatever the user's editor saves, and some editors
  // write a byte-order mark. JSON.parse refuses one, so it is stripped here as
  // the backlog parser strips it there: it frames the file rather than
  // belonging to it. The store is not written back with one.
  const text = raw.startsWith("\uFEFF") ? raw.slice(1) : raw

  // A zero-byte file is what a truncated write, a full disk or a killed editor
  // leaves behind. Reading it as [] would let the next write replace the lost
  // records with one, turning a recoverable accident into a permanent one.
  if (text.trim() === "") {
    throw new Error(
      `${file} is empty, which is what an interrupted write looks like; refusing to read it as "no projects". Restore it, or delete it to start over.`,
    )
  }
  let data: unknown
  try {
    data = JSON.parse(text) as unknown
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, {
      cause: e,
    })
  }
  if (!Array.isArray(data)) {
    throw new Error(`${file} must hold a JSON array of projects, but holds ${describe(data)}`)
  }
  const projects = data.map((record, i) => validateProject(record, `${file} record ${i}`))

  // Two records for one repo is ambiguous identity, not a duplicate to dedupe:
  // an upsert would update the first while a reader could use either, so an
  // edit would appear to be ignored. Ask which one to keep.
  const seen = new Map<string, number>()
  for (const [i, p] of projects.entries()) {
    const first = seen.get(p.path)
    if (first !== undefined) {
      throw new Error(
        `${file} records ${first} and ${i} both configure ${p.path}; refusing to guess which one wins. Delete one.`,
      )
    }
    seen.set(p.path, i)
  }
  return projects
}

/**
 * Narrows `value` to a `Project`, throwing on anything it cannot read with
 * certainty. `where` names the file and record so a message points at a line
 * someone can open.
 *
 * The returned object is rebuilt field by field in `FIELDS` order rather than
 * cast, so the store's key order is stable across writes no matter what order
 * a hand edit used.
 */
function validateProject(value: unknown, where: string): Project {
  const r = asRecord(value, where)
  rejectUnknownFields(r, where)

  const path = absolutePath(r.path, "path", where)
  const testCmd = nonBlank(r.testCmd, "testCmd", where)

  // Relative to the repo root, so an absolute value would read a report from
  // somewhere else entirely - or from nowhere.
  const reportPath = optionalNonBlank(r.reportPath, "reportPath", where)
  if (reportPath !== undefined && isAbsolute(reportPath)) {
    throw new Error(`${where}: reportPath is relative to the repo, so it cannot be ${reportPath}`)
  }

  // CLAUDE_CONFIG_DIR is handed to the child verbatim; nothing expands "~".
  // A relative value would create a profile next to the server's cwd, and the
  // run would start with no CLAUDE.md, no skills and no credentials.
  const configDir = optionalNonBlank(r.configDir, "configDir", where)
  if (configDir !== undefined && !isAbsolute(configDir)) {
    throw new Error(
      `${where}: configDir must be an absolute path - the CLI expands no "~" - got ${JSON.stringify(configDir)}`,
    )
  }

  // Strictly positive. Zero is refused rather than honoured as a pause: it is
  // likelier a typo or a half-finished edit, and a budget that can fund
  // nothing is indistinguishable from a project that never runs. NaN and
  // Infinity cannot even survive JSON - both write back as null.
  const budgetUsd = r.budgetUsd
  if (typeof budgetUsd !== "number" || !Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    throw new Error(
      `${where}: budgetUsd must be a positive number of dollars, got ${describe(budgetUsd)}`,
    )
  }

  // Younger than the store format, so an absent key is a store written before
  // the field existed rather than a damaged record, and it takes the default.
  // Only an absent key: an explicit null is an unfinished edit here, the way a
  // blank string is everywhere else in this file. `allowedTools` is the one
  // exception, because null is the design's own spelling of "derive it".
  const mode =
    r.permissionMode === undefined
      ? DEFAULTS.permissionMode
      : permissionMode(r.permissionMode, "permissionMode", where)

  return {
    path,
    testCmd,
    ...(reportPath === undefined ? {} : { reportPath }),
    ...(configDir === undefined ? {} : { configDir }),
    permissionMode: mode,
    allowedTools: toolRules(r.allowedTools, "allowedTools", where),
    budgetUsd,
    planModel: nonBlank(r.planModel, "planModel", where),
    implementModel: nonBlank(r.implementModel, "implementModel", where),
    planEffort: effort(r.planEffort, "planEffort", where),
    implementEffort: effort(r.implementEffort, "implementEffort", where),
  }
}

/** A record, or a message naming what arrived instead. An array is refused
 * too: a list of fields is not a project. */
function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where}: expected a project object, got ${describe(value)}`)
  }
  return value as Record<string, unknown>
}

/**
 * A key this version does not know is refused rather than ignored. It is
 * almost always a known key misspelled, and the two silent outcomes are both
 * bad: the field reads as absent, so `"configdir"` would run the project
 * against the default profile - the wrong account - and the next write would
 * drop the line the user typed. A missing-field check cannot catch this,
 * because an optional field is allowed to be missing.
 *
 * A `RETIRED` key is the one exception, and for the opposite reason: the
 * setting it named is gone, so ignoring it loses nothing a user still wants.
 */
function rejectUnknownFields(value: object, where: string): void {
  for (const key of Object.keys(value)) {
    if (RETIRED.has(key)) continue
    if (!(FIELDS as readonly string[]).includes(key)) {
      throw new Error(
        `${where}: unknown field ${JSON.stringify(key)}. Known fields are ${FIELDS.join(", ")}.`,
      )
    }
  }
}

/** A required non-blank string. Blank is refused everywhere it appears: an
 * empty `testCmd` would run as `sh -c ""`, which exits 0, and the whole design
 * branches on that exit code - every task would pass without being run. */
function nonBlank(value: unknown, field: string, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${where}: ${field} must be a non-empty string, got ${describe(value)}`)
  }
  return value
}

/** An optional non-blank string. `null` reads as absent because the design
 * spells "the default profile" both ways; the store then settles on absent, so
 * a round trip keeps one spelling. A blank string is not a third spelling of
 * absent - it is an unfinished edit, and it throws. */
function optionalNonBlank(value: unknown, field: string, where: string): string | undefined {
  if (value === undefined || value === null) return undefined
  return nonBlank(value, field, where)
}

function effort(value: unknown, field: string, where: string): Effort {
  if (typeof value !== "string" || !(EFFORTS as readonly string[]).includes(value)) {
    throw new Error(
      `${where}: ${field} must be one of ${EFFORTS.join(", ")}, got ${describe(value)}`,
    )
  }
  return value as Effort
}

/**
 * One of the two modes the design supports.
 *
 * The CLI accepts four more, and each of them loads here as a plausible typo
 * for a mode we do model. Forwarding one would spawn a run that cannot do its
 * job - `plan` refuses to edit, `manual` prompts nobody - and nothing in the
 * failure would point back at this field, so the message names the field and
 * both allowed values instead.
 */
function permissionMode(value: unknown, field: string, where: string): PermissionMode {
  if (typeof value !== "string" || !(PERMISSION_MODES as readonly string[]).includes(value)) {
    throw new Error(
      `${where}: ${field} must be one of ${PERMISSION_MODES.join(", ")}, got ${describe(value)}`,
    )
  }
  return value as PermissionMode
}

/**
 * An explicit allowlist, or `null` for "derive one".
 *
 * `null` is kept rather than collapsed to absent the way `configDir` is: it is
 * the design's spelling of "compute it", and writing it keeps the field
 * visible in a file people hand-edit, which is how someone discovers they can
 * narrow the allowlist at all.
 *
 * An empty list is refused. Under `acceptEdits` a run allowed nothing can
 * neither edit nor run the suite, and headless auto-denies anything that would
 * prompt, so every task would fail at verification; that is an unfinished edit
 * rather than a choice, and the message says which spelling means "derive".
 *
 * The list is copied, so a form object the UI reuses for its next save cannot
 * reach back into a record that has already been validated.
 */
function toolRules(value: unknown, field: string, where: string): string[] | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value)) {
    throw new Error(
      `${where}: ${field} must be a list of tool rules like ["Edit", "Bash(git *)"], or null to derive one from testCmd, got ${describe(value)}`,
    )
  }
  if (value.length === 0) {
    throw new Error(
      `${where}: ${field} is an empty list, which allows nothing at all; use null to derive the default set from testCmd, or list the rules the run needs`,
    )
  }
  return value.map((rule, i) => nonBlank(rule, `${field}[${i}]`, where))
}

/**
 * The repo root, absolute and normalised.
 *
 * A relative path is refused rather than resolved: the server's cwd is
 * wherever it was launched, so resolving would register a different repo
 * depending on how it was started. Normalising an already-absolute path is
 * what keeps "/repo/" and "/repo" one record instead of two that shadow each
 * other. The normalisation is lexical - no symlink is followed, so two
 * different spellings of one repo through a symlink remain two records.
 */
function absolutePath(value: unknown, field: string, where: string): string {
  const raw = nonBlank(value, field, where)
  if (!isAbsolute(raw)) {
    throw new Error(
      `${where}: ${field} must be an absolute repo path, got ${JSON.stringify(raw)}`,
    )
  }
  return resolve(raw)
}

/**
 * Replaces `file` by renaming a complete temp file over it, so an interrupted
 * write leaves the previous store intact rather than a truncated one. The temp
 * file is in the same directory, because a rename across filesystems is a copy
 * and is not atomic, and its name is unique per writer so two processes cannot
 * collide on it.
 *
 * The fsync matters as much as the rename: on a delayed-allocation filesystem
 * a crash just after the rename can otherwise leave the new name pointing at
 * zero bytes, which is the truncation the rename was supposed to prevent.
 *
 * Pretty-printed, newline-terminated, and keys in one canonical order, because
 * this file is hand-edited and read in diffs. A write that reordered keys
 * would show up as noise in every commit.
 */
async function writeStore(file: string, projects: readonly Project[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const json = JSON.stringify(projects, null, 2) + "\n"

  // A rename takes the temp file's mode, so without this every write would
  // reset a mode the user chose. 0o600 for a file that did not exist yet.
  let mode = 0o600
  try {
    mode = (await stat(file)).mode & 0o777
  } catch (e) {
    if (!isErrno(e, "ENOENT")) throw e
  }

  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    const fh = await open(tmp, "wx")
    try {
      // chmod rather than open's mode argument, which the umask masks: under
      // the usual 022 a store the user had chmod'd 0o664 would come back 0o644
      // after one write, which is the quiet drift this is here to prevent.
      await fh.chmod(mode)
      await fh.writeFile(json, "utf8")
      await fh.sync()
    } finally {
      await fh.close()
    }
    await rename(tmp, file)
  } catch (e) {
    // Best effort: if `open` is what failed there is nothing to remove.
    await unlink(tmp).catch(() => {})
    throw e
  }
}

function isErrno(e: unknown, code: string): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === code
}

/** A value named for an error message, without quoting a whole record. */
function describe(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  if (typeof value === "object") return "an object"
  if (typeof value === "string") return JSON.stringify(value)
  return String(value)
}
