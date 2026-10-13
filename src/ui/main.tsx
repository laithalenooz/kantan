/// <reference types="vite/client" />

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { MotionConfig } from "motion/react"

import "./tokens.css"
/* After `tokens.css`, which owns the `@import` and the theme: `artboard.css`
 * declares its rules in `@layer components`, and its own header says the order
 * matters. It carries the artboards' real class vocabulary — `.m`, `.ic`,
 * `.bf` with `.d1`–`.d9`, `.beam`, `.ring`, `.dots`, `.plan`, `.trow` — so a
 * component ported from `docs/design/*.dc.html` keeps the markup it was drawn
 * with. Nothing imported it until now, which meant every one of those classes
 * was inert. */
import "./artboard.css"
import { App } from "./App.tsx"

/**
 * Hand the browser its auth cookie before anything else talks to the API.
 *
 * In production Bun serves `dist/`, so the page itself comes from `GET /` and
 * that response sets the cookie. In development Vite serves `index.html`, so
 * the browser never loads Bun's `/` and the cookie has nowhere to come from —
 * every later request would be a 401 that looks like a broken guard.
 * `GET /api/session` exists for exactly this and is the one route exempt from
 * the token check.
 *
 * Deliberately not fatal. A token specimen has to render with no server
 * running, and so does any later UI work on a laptop with the backend stopped.
 * The failure is reported once, in the console, naming the fix.
 */
async function bootstrapSession(): Promise<void> {
  try {
    /* Timed out, because the render waits on this. A server that is up but not
     * answering — paused in a debugger, still starting — would otherwise leave
     * the page blank indefinitely. The abort lands in the catch below. */
    const res = await fetch("/api/session", {
      credentials: "same-origin",
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) {
      console.warn(`kantan: GET /api/session answered ${res.status}; API calls will be refused`)
    }
  } catch (err) {
    /* A timeout and a missing server need different advice. After either, the
     * page still renders but holds no cookie and does not retry, so both have
     * to say what unsticks it. */
    if (err instanceof DOMException && err.name === "TimeoutError") {
      console.warn(
        "kantan: /api/session did not answer within 3s. API calls will be refused; reload once the server responds.",
      )
    } else {
      console.warn("kantan: no server on /api. Start it with `bun run server` (KANTAN_DEV=1 in dev), then reload.")
    }
  }
}

/**
 * Every action is a POST, and every GET handler stays side-effect-free.
 *
 * Not a style preference. The auth cookie is `SameSite=Strict`, and cookies
 * ignore ports — so a page on any other localhost port counts as same-site.
 * Its no-cors GETs (an `img` tag, a `script` tag, a plain navigation) carry the
 * cookie and send no `Origin` header, which means the Origin check cannot see
 * them. A convenience GET that started a run would be reachable from any other
 * local page. Start, approve, feedback and stop are POSTs for that reason.
 */

const host = document.getElementById("root")
if (!host) throw new Error("index.html is missing #root, so there is nowhere to mount")

/* Mount only once the session call has settled, succeeded or not. Firing it
 * alongside the render would leave the cookie in flight while the first effect
 * pass — doubled under StrictMode — issued its own request, which is the 401
 * this whole dance exists to avoid. `finally` keeps a stopped server from
 * blocking the page. */
void bootstrapSession().finally(() => {
  createRoot(host).render(
    <StrictMode>
      {/* Covers the tree for Tasks 21-24. Note its documented limit: it
          switches transform and layout animations off, not opacity or filter,
          so a blur fade still runs under a reduced-motion preference.
          tokens.css explains what is left for Task 25. */}
      <MotionConfig reducedMotion="user">
        <App />
      </MotionConfig>
    </StrictMode>,
  )
})
