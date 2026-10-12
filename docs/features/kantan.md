# kantan

Real, open work on kantan itself, taken from `docs/HANDOFF.md`. Each line is a
task kantan can run: it writes a plan, waits for your approval, implements it,
then runs `bun run check` until the exit code says it passed.

Task titles are kept short on purpose — the tree gives a task one line beside
its state label, and a sentence-long title wraps badly. Put the detail
underneath.

- [x] T1 Serve the built UI from `GET /`
      `INDEX_STUB` in `src/server.ts` still answers "the UI arrives in a later task".
      `vite build` writes `dist/` and nothing serves it, so the only supported way to
      run kantan is two terminals. Fall back to the stub when `dist/` is absent, and
      register the asset routes inside `ROUTES` — a route in `Bun.serve({routes})` is
      matched before the guard chain and would never meet it.
- [x] T2 Give a project an account kind
      The chip reads "account unknown" for every project. `Account` in
      `src/ui/Tree.tsx` is `personal | work | unknown`, and its doc comment forbids
      defaulting to "personal", because billing a client from the wrong account is the
      defect it exists to prevent. `Project` carries a `configDir` and nothing maps one
      to a kind. The mapping has to be something the user states, not something a path
      is parsed for.
- [ ] T3 Render `vcs_state_changed` instead of an unknown row
      A real run emits it twice — the CLI reporting that the agent committed, carrying
      `{kind:"commit", branch, cwd, uuid, session_id}`. The fixtures predate it, so
      `src/stream.ts` classifies it as `unknown` and the log shows a raw blob. Needs an
      `Event` variant and a `Row.tsx` renderer.
- [x] T4 Offer a way to start a new task file from the tree
- [x] T5 Show a project summary when a project is clicked
