# Factoring `src/server.ts`

**Status:** done, 2026-10-13. Two corrections to the plan are recorded below.

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


---

## Done, and what the plan got wrong

`src/server.ts` is **449 lines**, down from 3219. It holds the `ROUTES` table,
`TOKEN_EXEMPT`, the `handle`/`matchRoute` glue that reads them, `createServer`
and `parsePort` — which is what this document asked for.

Correction 1: **`matchRoute` and `handle` did not move.** The table above put
them in `http/router.ts`; that was written without checking what they read.
Both reach for `ROUTES` and `TOKEN_EXEMPT`, so moving them meant either passing
the tables in — a body rewrite, which this plan forbids in the same change — or
importing them back from `src/server.ts`, which makes the module graph a ring.
They are *about* the table, so they stay with it. Only `isPattern` and
`matchPattern` moved: two pure string functions with a traversal argument to
make.

Correction 2: **`readProjects` stayed with the tree helpers** rather than going
to `src/routes/`. It is a route handler, but a thin one over the four functions
beside it, and splitting them would have put an import between a function and
the only things it calls.

Two modules were added that the plan did not anticipate, because the session
that executed it had added five routes since it was written:
`src/routes/test.ts` and `src/routes/detect.ts`.

## The same method, applied past the server

The plan's measurement discipline — *the real criticism is not size* — turned
out to be the whole value of it, because applied elsewhere it said **no** twice:

| file | before | after | why |
|---|---|---|---|
| `src/ui/ProjectPanel.tsx` | 3546 | 970 | eleven modules; no section called another, so the split was mechanical |
| `src/ui/Gate.tsx` | 1603 | 997 | 607 lines of it were one scoped stylesheet |
| `src/ui/Tree.tsx` | 1798 | 1594 | the task-state reading has no React in it and belongs outside the component |
| `src/run.ts` | 3002 | 2695 | **only two groups of seven were separable** |

`src/run.ts` is the one worth stating plainly. Of seven candidate groupings,
five reach back into the state machine for six to twenty-one symbols apiece,
because 34 of its 67 functions take the same mutable `ActiveRun` and mutate it.
Splitting those buys a smaller file and pays with a ring of imports and a
machine whose steps live in six places. That it is still 2695 lines is a fact
about a phase machine over one object, not a thing left undone.

`src/ui/Sidebar.tsx`, `Digest.tsx`, `Row.tsx` and `StartPanel.tsx` were
measured and left alone: 40–56 declarations each with the largest under 100
lines, which is already composed of small units. Their length is the comment
density this codebase carries on purpose, and splitting them would be churn.

## The tool

`/tmp` is the wrong place for it, so if this is done again: the reliable cutter
was **column-0 anchored**, not brace-counting. A depth tracker drifts in `.tsx`
on JSX, template literals and arrow bodies — it silently failed to find five of
`ProjectPanel`'s eight sections. Every file here is uniformly 2-space indented,
so "a declaration starts at column 0 and ends where the next one begins" is
exactly true, and that rule found all 60.
