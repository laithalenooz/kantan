import { expect, test } from "bun:test"
import { chmod, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { claudeVersion } from "../src/version"

const repoRoot = join(import.meta.dir, "..")

test("reads the claude CLI version", async () => {
  const v = await claudeVersion()
  expect(v).toMatch(/^\d+\.\d+\.\d+$/)
})

test("honours KANTAN_CLAUDE_BIN when spawning the CLI", async () => {
  const dir = join(repoRoot, ".kantan-test", "version-seam")
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })

  // A stub that reports a version the real CLI could never return, so the
  // assertion cannot pass by accident if the override is ignored.
  const stub = join(dir, "fake-claude")
  await writeFile(stub, '#!/bin/sh\necho "99.88.77 (Claude Code)"\n')
  await chmod(stub, 0o755)

  // CLAUDE_BIN is resolved when src/version.ts loads, so the override has to
  // be present in the environment of a fresh process.
  const probe = join(dir, "probe.ts")
  await writeFile(
    probe,
    `import { claudeVersion } from ${JSON.stringify(join(repoRoot, "src/version.ts"))}\n` +
      `process.stdout.write(await claudeVersion())\n`,
  )

  const p = Bun.spawn([process.execPath, "run", probe], {
    env: { ...process.env, KANTAN_CLAUDE_BIN: stub },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  if (code !== 0) throw new Error(`probe exited ${code}: ${err}`)

  expect(out).toBe("99.88.77")
})

// A wrong KANTAN_CLAUDE_BIN is one of the likelier misconfigurations, so the
// failure has to name what went wrong rather than report an empty parse.

/** Runs claudeVersion() in a fresh process, since CLAUDE_BIN binds at import. */
async function versionWith(bin: string): Promise<{ out: string; err: string; code: number }> {
  const dir = join(repoRoot, ".kantan-test", "version-failure")
  await mkdir(dir, { recursive: true })
  const probe = join(dir, "probe.ts")
  await writeFile(
    probe,
    `import { claudeVersion } from ${JSON.stringify(join(repoRoot, "src/version.ts"))}\n` +
      `try { process.stdout.write(await claudeVersion()) }\n` +
      `catch (e) { process.stderr.write((e as Error).message); process.exit(1) }\n`,
  )
  const p = Bun.spawn([process.execPath, "run", probe], {
    env: { ...process.env, KANTAN_CLAUDE_BIN: bin },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  return { out, err, code }
}

test("names the binary when it does not exist", async () => {
  const { err, code } = await versionWith(join(repoRoot, ".kantan-test", "definitely-not-here"))
  expect(code).toBe(1)
  expect(err).toContain("definitely-not-here")
})

test("reports the exit code and stderr when the binary fails", async () => {
  const dir = join(repoRoot, ".kantan-test", "version-failure")
  await mkdir(dir, { recursive: true })
  const stub = join(dir, "angry-claude")
  await writeFile(stub, '#!/bin/sh\necho "could not reach the keychain" >&2\nexit 3\n')
  await chmod(stub, 0o755)
  const { err, code } = await versionWith(stub)
  expect(code).toBe(1)
  expect(err).toContain("exited 3")
  expect(err).toContain("could not reach the keychain")
})

test("reports the output when it succeeds but prints no version", async () => {
  const dir = join(repoRoot, ".kantan-test", "version-failure")
  await mkdir(dir, { recursive: true })
  const stub = join(dir, "chatty-claude")
  await writeFile(stub, '#!/bin/sh\necho "update available, run claude install"\n')
  await chmod(stub, 0o755)
  const { err, code } = await versionWith(stub)
  expect(code).toBe(1)
  expect(err).toContain("cannot parse a version")
  expect(err).toContain("update available")
})
