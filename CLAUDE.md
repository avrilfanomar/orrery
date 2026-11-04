# Requirement Universe — agent guide

A PoC platform: requirements, constraints and business/quality KPIs as one
contribution graph with rolled-up status, progressive disclosure and
append-only evolution. Read [README.md](README.md) for the tour and
[ADR 0001](docs/adr/0001-one-graph-append-only-evolution.md) for the four
decisions everything rests on.

## Invariants

1. **The event log is the only state.** Never mutate a stored event or
   "fix" history; add a new event. Projections (`project`) are disposable.
2. **`decide` is the only gate.** Every rule that protects the model
   (existence, cycles, required reasons, valid measures) lives in
   `packages/core/src/decide.ts`; the API, the seed and any importer go through it.
3. **Unknown never rolls up as green.** Any change to `rollup()` or
   `evaluateUniverse()` must keep the tests in `packages/core/test/evaluate.test.ts` passing.
4. **Readings are judged against the definition in force when observed**
   (`definitionAt`). Never evaluate history against the current definition.
5. **`packages/core` stays pure** — no Node or DOM APIs, so the UI can import it.

## Commands

```bash
pnpm dev | start | reset | verify
pnpm --filter @ru/core test      # domain unit tests
pnpm --filter @ru/server test    # API + demo-story tests
pnpm --filter @ru/web e2e        # browser smoke test (needs a running app)
pnpm dogfood [--dry-run]         # measure this repo against its own model (ADR 0003)
pnpm dogfood:serve               # that universe in the UI on :4711
```

## Conventions

- TypeScript strict ESM; relative imports carry `.js`.
- Comments explain *why*, not what.
- The demo story is pinned by `apps/server/test/app.test.ts`. If you change
  `apps/server/src/demo.ts`, keep the story coherent and update that test.
- Commits are imperative, sentence case, with no `feat:`-style prefixes.
- The repo's own requirements live in `apps/server/src/dogfood/model.ts`.
  Edit it like code; the reason for a change comes from `--reason` or the
  commit subject.
  - If you change what a probe measures, bump its `version` and say why in
    `since`. Its `id@version` is the node's yardstick.
  - Never reword an old version in place.
  - `apps/server/test/dogfood.test.ts` keeps the model and the probe registry
    1:1.
- A new place in `apps/server/src` that writes to an event log must be added
  to `SANCTIONED_WRITES` in `probes.ts`, with a version bump.
