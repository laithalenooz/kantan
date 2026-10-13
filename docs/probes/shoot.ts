/**
 * Drives real Chrome over CDP: navigate, click text, screenshot.
 *
 * Exists because a headless `--screenshot` cannot click, and every defect
 * reported from use so far has been about a state you only reach by clicking.
 *
 *   bun run shoot.ts <url> <out.png> [click:<text>] [wait:<ms>] [full]
 */
const [url, out, ...rest] = process.argv.slice(2)
if (url === undefined || out === undefined) throw new Error("need <url> <out.png>")

const PORT = 9333
const chrome = Bun.spawn(
  [
    "google-chrome", "--headless=new", "--disable-gpu", "--no-sandbox",
    `--remote-debugging-port=${PORT}`, "--window-size=1440,900",
    "--user-data-dir=/tmp/claude-1000/chrome-cdp-profile", "about:blank",
  ],
  { stdout: "ignore", stderr: "ignore" },
)

/** Chrome's debug endpoint is not up the instant the process is. */
async function targetUrl(): Promise<string> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = (await res.json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl !== undefined)
      if (page?.webSocketDebuggerUrl !== undefined) return page.webSocketDebuggerUrl
    } catch { /* not listening yet */ }
    await Bun.sleep(250)
  }
  throw new Error("chrome never opened a debugging port")
}

const ws = new WebSocket(await targetUrl())
await new Promise<void>((ok, bad) => {
  ws.addEventListener("open", () => ok())
  ws.addEventListener("error", () => bad(new Error("cdp socket failed")))
})

let id = 0
const waiting = new Map<number, (value: Record<string, unknown>) => void>()
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(String(e.data)) as { id?: number; result?: Record<string, unknown> }
  if (msg.id !== undefined) waiting.get(msg.id)?.(msg.result ?? {})
})
const send = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const mine = ++id
  ws.send(JSON.stringify({ id: mine, method, params }))
  return new Promise((ok) => waiting.set(mine, ok))
}

/**
 * Controls this probe refuses to press, by their exact label.
 *
 * Earned rather than precautionary. While verifying the gate's layout at four
 * window sizes, a loose `innerText.includes` match reached **Approve plan** on
 * a real parked run: it approved a plan, spawned an implement phase, committed
 * to the user's repository and spent money, and the only reason that was
 * recoverable is that kantan keeps the work on its own `orch/*` branch. A
 * screenshot probe must not be able to do that, and "be careful" is not a
 * mechanism.
 *
 * The list is of *consequences outside this process*: approving, sending back,
 * answering, starting, resuming, stopping, removing. Everything else - opening
 * a panel, switching a tab, collapsing a file - is reversible by reloading, so
 * it stays clickable and the probe stays useful.
 *
 * `--force` exists because a probe for one of these controls is a legitimate
 * thing to want. It has to be asked for in the argv, which is the point: the
 * failure above was a click nobody wrote down.
 */
const REFUSED = new Set([
  "Approve plan",
  "Send back",
  "Send answer",
  "Start planning",
  "Resume run",
  "Start over from planning",
  "Stop run",
  "Remove project",
  "Add account",
  "Write the task file",
  "Draft tasks",
])

const forced = rest.includes("--force")

/** Whether this probe may press a control reading `label`. */
function allowed(label: string): boolean {
  if (forced) return true
  for (const refused of REFUSED) if (label.trim() === refused) return false
  return true
}

/** A button whose own trimmed text is exactly `text`. Narrower than
 *  `clickText`, which searches `li` and `span` too and so can match an
 *  ancestor of the control - `querySelectorAll` is document order, so the
 *  wrapping `li` comes first and clicking it does nothing. */
const clickButton = (text: string): string => `(() => {\n  const ALLOWED = ${String(allowed(text))}
  const hit = [...document.querySelectorAll("button")].find(
    (el) => (el.innerText ?? "").trim() === ${JSON.stringify(text)},
  )
  if (hit === undefined) return "NO BUTTON"
  if (!ALLOWED) return "REFUSED: this probe does not press " + JSON.stringify((hit.innerText ?? "").trim())
  hit.scrollIntoView({ block: "center" })
  hit.click()
  return "clicked button: " + (hit.innerText ?? "").trim().slice(0, 70)
})()`

/** Evaluated in the page: `innerText.trim() === text` wins, else `includes`. */
const clickText = (text: string): string => `(() => {\n  const ALLOWED = ${String(allowed(text))}
  const all = [...document.querySelectorAll("button,[role=treeitem],[role=button],a,li,span")]
  const exact = all.find((el) => (el.innerText ?? "").trim() === ${JSON.stringify(text)})
  const loose = all.find((el) => (el.innerText ?? "").includes(${JSON.stringify(text)}))
  const hit = exact ?? loose
  if (hit === undefined) return "NOT FOUND"
  if (!ALLOWED) return "REFUSED: this probe does not press " + JSON.stringify((hit.innerText ?? "").trim())
  hit.scrollIntoView({ block: "center" })
  hit.click()
  return "clicked: " + (hit.innerText ?? "").trim().slice(0, 70)
})()`

for (const arg of rest) {
  if (!arg.startsWith("size:")) continue
  const [w, h] = arg.slice(5).split("x").map(Number)
  await send("Emulation.setDeviceMetricsOverride", {
    width: w ?? 1440, height: h ?? 900, deviceScaleFactor: 1, mobile: false,
  })
}

await send("Page.enable")
await send("Runtime.enable")
await send("Page.navigate", { url })
await Bun.sleep(3500)

let full = false
for (const arg of rest) {
  if (arg === "full") { full = true; continue }
  if (arg.startsWith("wait:")) { await Bun.sleep(Number(arg.slice(5))); continue }
  if (arg.startsWith("scroll:")) {
    await send("Runtime.evaluate", { expression: `window.scrollTo(0, ${Number(arg.slice(7))})` })
    await Bun.sleep(600)
    continue
  }
  if (arg.startsWith("sel:")) {
    const r = await send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(arg.slice(4))})
        if (el === null) return "NOT FOUND"
        el.scrollIntoView({ block: "center" })
        el.click()
        return "clicked " + el.getAttribute("aria-label")
      })()`,
    })
    console.log((r["result"] as { value?: unknown } | undefined)?.value)
    await Bun.sleep(1200)
    continue
  }
  if (arg.startsWith("hover:")) {
    /* A real pointer move, so `:hover` and `group-hover` actually apply -
       dispatching a mouseover event does not set the hover flag in Chrome. */
    const box = await send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(arg.slice(6))})
        if (el === null) return null
        el.scrollIntoView({ block: "center" })
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`,
    })
    const at = (box["result"] as { value?: { x: number; y: number } | null }).value
    if (at == null) console.log("hover target not found")
    else {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y, buttons: 0 })
      console.log(`hovered ${arg.slice(6)} at ${at.x},${at.y}`)
    }
    await Bun.sleep(900)
    continue
  }
  if (arg.startsWith("type:")) {
    /* Real key events, so React's onChange fires: setting `value` directly
       does not, and a controlled input would snap back. */
    /**
     * Split at the first `=` **outside** any brackets, not at the first `=`.
     *
     * `split("=")` was the first version and it cannot express the selector
     * this probe most needs: `input[data-addrepo="path"]` contains an `=`, so
     * the selector came out as `input[data-addrepo` and the value as
     * `"path"]=/the/real/value`. The whole lot then went into whichever input
     * that broken selector happened to match, which looked exactly like a UI
     * bug - a path field containing a selector and a shell command.
     */
    const raw = arg.slice(5)
    let depth = 0
    let cut = -1
    for (const [i, ch] of [...raw].entries()) {
      if (ch === "[") depth++
      else if (ch === "]") depth--
      else if (ch === "=" && depth === 0) {
        cut = i
        break
      }
    }
    if (cut === -1) throw new Error(`type: needs <selector>=<value>, got ${JSON.stringify(raw)}`)
    const sel = raw.slice(0, cut)
    const value = raw.slice(cut + 1)
    /**
     * Refuse to type when the selector matches nothing.
     *
     * `?.focus()` on a missing element is a no-op, so focus stayed on
     * whatever was focused before and `Input.insertText` typed into *that*.
     * Hit for real: a step aimed at a field inside a section the panel had not
     * rendered yet appended a shell command to the path field above it, and
     * the screenshot showed a path with a command glued to the end of it -
     * indistinguishable from a UI bug, and the probe reported success.
     */
    const found = await send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(sel)})
        if (el === null) return false
        el.scrollIntoView({ block: "center" })
        el.focus()
        return document.activeElement === el
      })()`,
    })
    if ((found["result"] as { value?: unknown } | undefined)?.value !== true) {
      throw new Error(`type: nothing matched ${sel}, so nothing was typed - the step before it may not have landed`)
    }
    /* `insertText`, not a keyDown/char/keyUp triple: a `keyDown` carrying
       `text` inserts the character *and* so does the `char` that follows it,
       so the triple typed everything twice - `/home` arrived as `//hhoommee`.
       `insertText` fires the input event React listens for, once. */
    await send("Input.insertText", { text: value })
    console.log(`typed ${value.length} chars into ${sel}`)
    await Bun.sleep(1500)
    continue
  }
  if (arg.startsWith("btn:")) {
    const r = await send("Runtime.evaluate", { expression: clickButton(arg.slice(4)), returnByValue: true })
    console.log((r["result"] as { value?: unknown } | undefined)?.value)
    await Bun.sleep(1800)
    continue
  }
  if (arg.startsWith("click:")) {
    const r = await send("Runtime.evaluate", { expression: clickText(arg.slice(6)), returnByValue: true })
    console.log((r["result"] as { value?: unknown } | undefined)?.value)
    await Bun.sleep(2500)
  }
}

/** What the viewport actually shows, and what it would show unclipped. */
const metrics = await send("Runtime.evaluate", {
  returnByValue: true,
  expression: `({
    scrollH: document.documentElement.scrollHeight,
    clientH: document.documentElement.clientHeight,
    stopBtn: (() => {
      const b = [...document.querySelectorAll("button")].find((x) => (x.innerText ?? "").trim() === "Stop run")
      if (b === undefined) return null
      const r = b.getBoundingClientRect()
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), inViewport: r.top >= 0 && r.bottom <= innerHeight }
    })(),
    /** Every element the browser is actually animating, by keyframe name. */
    animations: (() => {
      const seen = {}
      for (const el of document.querySelectorAll("*")) {
        const cs = getComputedStyle(el)
        if (cs.animationName === "none" || cs.animationName === "") continue
        for (const name of cs.animationName.split(",").map((n) => n.trim())) {
          const key = name + " | " + el.tagName.toLowerCase() + "." +
            String(el.className).split(" ").filter((c) => c.length < 12).slice(0, 2).join(".")
          seen[key] = (seen[key] ?? 0) + 1
        }
      }
      return Object.entries(seen).map(([k, n]) => k + " x" + n).sort()
    })(),
    buttons: [...document.querySelectorAll("button")].map((b) => {
      const cs = getComputedStyle(b)
      const label = (b.innerText ?? "").trim().replace(/\s+/g, " ").slice(0, 34)
      return label === "" ? null : {
        label,
        bg: cs.backgroundColor,
        color: cs.color,
        border: cs.borderTopWidth === "0px" ? "none" : cs.borderTopWidth + " " + cs.borderTopColor,
      }
    }).filter((x) => x !== null),
    disclosure: [...document.querySelectorAll("[data-feature-toggle]")].map((t) => {
      const list = document.getElementById(t.getAttribute("aria-controls") ?? "")
      const cs = list === null ? null : getComputedStyle(list)
      return {
        file: (t.getAttribute("data-feature-toggle") ?? "").split("/").pop(),
        expanded: t.getAttribute("aria-expanded"),
        /** The computed value, which is the only thing that settles . */
        display: cs === null ? null : cs.display,
        listHeight: list === null ? null : Math.round(list.getBoundingClientRect().height),
        rows: list === null ? 0 : list.querySelectorAll("[data-task-row]").length,
      }
    }),
    stopHit: (() => {
      const b = [...document.querySelectorAll("button")].find((x) => (x.innerText ?? "").trim() === "Stop run")
      if (b === undefined) return null
      const r = b.getBoundingClientRect()
      const x = Math.round(r.left + r.width / 2)
      const y = Math.round(r.top + r.height / 2)
      const top = document.elementFromPoint(x, y)
      const cs = getComputedStyle(b)
      return {
        at: [x, y],
        disabled: b.disabled,
        pointerEvents: cs.pointerEvents,
        opacity: cs.opacity,
        /** What a click at the button's centre would actually land on. */
        topmost: top === null ? null : top.tagName + "." + String(top.className).split(" ").slice(0, 3).join("."),
        reachesButton: top === b || b.contains(top),
      }
    })(),
    overlap: (() => {
      const out = []
      for (const b of document.querySelectorAll("[data-remove-task]")) {
        const li = b.parentElement
        const chip = li?.querySelector("[data-state-label]")
        const title = li?.querySelector("[data-task-text]")
        const br = b.getBoundingClientRect()
        const hits = (el) => {
          if (el == null) return null
          const r = el.getBoundingClientRect()
          if (r.width === 0) return false
          return !(br.right <= r.left || br.left >= r.right || br.bottom <= r.top || br.top >= r.bottom)
        }
        out.push({ ref: b.getAttribute("data-remove-task"), overChip: hits(chip), overTitle: hits(title) })
      }
      return out
    })(),
    gateBox: (() => {
      const g = document.querySelector(".kg")
      if (g === null) return null
      const r = g.getBoundingClientRect()
      const col = g.closest("main")
      const c = col === null ? null : col.getBoundingClientRect()
      return {
        card: [Math.round(r.left), Math.round(r.right)],
        column: c === null ? null : [Math.round(c.left), Math.round(c.right)],
        gapLeft: c === null ? null : Math.round(r.left - c.left),
        gapRight: c === null ? null : Math.round(c.right - r.right),
      }
    })(),
    gateText: (() => {
      const g = document.querySelector("[data-gate], [role=region]")
      return g === null ? null : (g.innerText ?? "").slice(0, 160)
    })(),
  })`,
})
console.log("metrics:", JSON.stringify((metrics["result"] as { value?: unknown }).value, null, 1))

const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: full })
await Bun.write(out, Buffer.from(String(shot["data"]), "base64"))
console.log(`wrote ${out}`)
ws.close()
chrome.kill()
