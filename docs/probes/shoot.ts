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

/** Evaluated in the page: `innerText.trim() === text` wins, else `includes`. */
const clickText = (text: string): string => `(() => {
  const all = [...document.querySelectorAll("button,[role=treeitem],[role=button],a,li,span")]
  const exact = all.find((el) => (el.innerText ?? "").trim() === ${JSON.stringify(text)})
  const loose = all.find((el) => (el.innerText ?? "").includes(${JSON.stringify(text)}))
  const hit = exact ?? loose
  if (hit === undefined) return "NOT FOUND"
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
