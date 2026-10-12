/**
 * Why `ProjectPanel`'s account cards are keyed on `(kind, configDir)`.
 *
 * Keying them on `kind` alone looked like a cosmetic slip. It is not: a single
 * render of a list holding two options that read `work` never returns.
 *
 * Measured 2026-10-12, React 19 + happy-dom under Bun 1.4.3: the render below
 * printed React's "two children with the same key" warning and then produced
 * nothing for 90s until `timeout` killed it, while the process grew until a
 * 3 GB cgroup cap killed it. Uncapped on this machine that is the whole WSL2
 * VM, which takes the editor and any agent session down with it - which is how
 * it was found.
 *
 * Run it inside a cap, or it will do that again:
 *
 *   systemd-run --user --scope -p MemoryMax=2G -p MemorySwapMax=0 \
 *     timeout -s KILL 30 bun run docs/probes/account-key-collision.ts
 *
 * Prints "returned" if a fix has made the render terminate.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
GlobalRegistrator.register()

const { act, createElement } = await import("react")
const { createRoot } = await import("react-dom/client")

/** Two options sharing a `kind`, which `AccountSwitch`'s "Add an account" makes. */
const accounts = [
  { kind: "work" as const, label: "acme", configDir: "/home/you/.claude-acme" },
  { kind: "work" as const, label: "globex", configDir: "/home/you/.claude-globex" },
]

/** The collision on its own, with no kantan code involved. */
function Colliding(): unknown {
  return createElement(
    "div",
    null,
    accounts.map((option) => createElement("button", { key: option.kind }, option.label)),
  )
}

const host = document.createElement("div")
document.body.append(host)
const root = createRoot(host)

const started = Date.now()
await act(async () => {
  root.render(createElement(Colliding))
})
console.log(`returned after ${Date.now() - started}ms; html=${host.innerHTML}`)
