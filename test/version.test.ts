import { expect, test } from "bun:test"
import { chmod, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { claudeVersion } from "../src/version"

const repoRoot = join(import.meta.dir, "..")

test("reads the claude CLI version", async () => {
  const v = await claudeVersion()
  expect(v).toMatch(/^\d+\.\d+\.\d+$/)
})

test("honours ORCH_CLAUDE_BIN when spawning the CLI", async () => {
  const dir = join(repoRoot, ".orch-test", "version-seam")
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
    env: { ...process.env, ORCH_CLAUDE_BIN: stub },
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
