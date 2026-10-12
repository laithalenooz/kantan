# Factoring `src/server.ts`

**Status:** planned, not started. `src/server.ts` is held by a running agent.

## The measurement, not the impression

| file | lines | top-level functions |
|---|---|---|
| `src/run.ts` | 2910 | — |
| `src/server.ts` | 2648 | 57 |

`server.ts` currently holds: cookie minting, host and origin allowlists, the
token comparison, the route table, pattern matching, SSE framing and the
streaming body, a symlink-safe file reader, plan rendering, **tree-payload
construction**, body parsing and refusal helpers, and the handlers for five
resources (runs, projects, features, plan, session).

## The real criticism, which is not size

**Domain logic sits in the transport layer.** `treeTask`, `featuresOf`,
`accountOf` and `whyUnread` build the project tree inside the HTTP module.
That is not routing. Nothing else can reuse it, and nothing can test it
without standing up a server — which is why its only coverage today is
through `call()` in `test/server.test.ts`.

Everything else is a consequence of that plus accretion.

## What this must NOT become

`CLAUDE.md`: *"Build what the task asks for. Over-building is a defect."* The
design rejects frameworks deliberately. So:

- **No DI container, no layers for their own sake, no interfaces with one
  implementation.** The `Runner` port exists because it keeps the phase machine
  out of the server's module graph — that is a real seam with a stated reason,
  and it is the only one of its kind that has earned its place.
- **Pure file-splitting plus explicit imports.** Function bodies move
  unchanged. A diff that rewrites a body is doing two things at once.
- **No new abstractions in the same change.** Extract first; improve later,
  against a green suite.

## The seams, which the file already marks with section comments

| new module | moves |
|---|---|
| `src/http/guards.ts` | `tokenCookie`, `allowedHosts`, `allowedOrigins`, `hasToken`, `sameSecret`, `checkRequest`, `refuse`, `fault` |
| `src/http/router.ts` | `matchRoute`, `isPattern`, `matchPattern`, `handle` |
| `src/http/body.ts` | `readBody`, `tooLarge`, `parseBody`, `badBody`, `nonEmptyString` |
| `src/http/readInside.ts` | `readInside`, `inside` — the symlink-safe reader both the plan and feature routes share |
| `src/http/sse.ts` | `sseFrame`, `isTerminal`, `runLogPathFor`, `streamRunLog`, `runLogBody`, `send` |
| `src/tree.ts` | `readProjects`, `accountOf`, `featuresOf`, `whyUnread`, `featurePath`, `treeTask` — **the domain fix**, testable without a server |
| `src/routes/plan.ts` | `plannedPath`, `plannedFor`, `readPlan`, `unreadable`, `planAnswer` |
| `src/routes/runs.ts` | `startRun`, `actionGate`, the six actions, `refuseRun`, `acted`, `noRunner`, `liveRunIdFor`, `liveRunFor`, `projectOfRun` |
| `src/routes/projects.ts` | `registerProject`, `removeRegistration`, `editProject`, `noStore` |
| `src/routes/features.ts` | `draftFeatureFile` |
| `src/server.ts` | the `ROUTES` table, `TOKEN_EXEMPT`, `createServer`, `parsePort` |

`RouteContext` and `ServerOptions` go to `src/http/context.ts`, since every
module above takes one.

## What keeps it honest

The route table **stays one table in one file**. Its header already says why:
`Bun.serve({routes})` matches before the `fetch` handler, so a route registered
elsewhere never meets the guard chain. Scattering routes across modules is the
one refactor that would make this codebase less safe, and it is the one most
"clean architecture" rewrites do first.

## How to verify it changed nothing

The suite is the safety net: **2215 pass, 1 skip** at the time of writing, with
`test/server.test.ts` alone at 244. Move in small commits, run `bun run check`
after each, and do not touch a test file except to follow an import. A test
that needed editing to pass means the behaviour moved.
