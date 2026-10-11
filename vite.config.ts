import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

/** The Bun server's default port. Design §4.4: in production Bun serves the
 * built `dist/`, giving a single origin; in development Vite serves the page on
 * its own port and proxies the API, which is the only reason the server has a
 * dev mode at all. Enable that side with `ORCH_DEV=1`. */
const API = "http://127.0.0.1:3100"

export default defineConfig({
  plugins: [react(), tailwindcss()],

  server: {
    port: 5173,

    /** Load-bearing, not tidiness. Vite silently moves to 5174 when 5173 is
     * taken, and `src/server.ts` widens its Host and Origin allowlists to 5173
     * only — `devPort` has no launch-time setting yet. A moved Vite therefore
     * gets a 403, which reads like a bug in the security guard and invites
     * someone to loosen it. Failing loudly on the port is the cheaper error. */
    strictPort: true,

    proxy: {
      "/api": {
        target: API,

        /** Deliberately absent: `changeOrigin`. Setting it rewrites the Host
         * header to the target's, which hides the browser's real Host from the
         * server's rebinding check — the project's only defence against DNS
         * rebinding against an endpoint that feeds arbitrary text to an agent
         * with file-write and shell access. Most proxy examples set it. This
         * one must not. */
      },
    },
  },

  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
})
