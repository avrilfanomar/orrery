# Orrery — agent guide

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
   `evaluateUniverse()` must keep the tests in `packages/core/test/evaluate.test.ts`
   and `safety.test.ts` passing. A new rollup strategy joins the grid in
   `safety.test.ts` and keeps every promise there (ADR 0009).
4. **Readings are judged against the definition in force when observed**
   (`definitionAt`). Never evaluate history against the current definition.
5. **`packages/core` stays pure** — no Node or DOM APIs, so the UI can import it.
6. **Core names no integration** (ADR 0013). A query language or a source kind
   is a module: a package under `packages/` implementing `@orrery/module-kit`,
   installed in `apps/server/src/modules.ts` and nowhere else. A module loads
   only core and the kit; the console loads none and learns what to show from
   `GET /api/sources`. `seam-crossings` counts every import that breaks this.

## Commands

```bash
pnpm dev | start | reset | verify
pnpm --filter @orrery/core test      # domain unit tests
pnpm --filter @orrery/core exec vitest run --coverage   # its statement coverage (ADR 0006)
pnpm --filter @orrery/server test    # API + demo-story tests
pnpm --filter @orrery/web e2e        # browser smoke test (needs a running app)
pnpm --filter @orrery/web a11y       # accessibility scan (needs a running app; reads only)
pnpm --filter @orrery/web readme-gif # re-record docs/tour.gif (needs a freshly reset, running app and ffmpeg)
pnpm dogfood [--dry-run]         # measure this repo against its own model (ADR 0003)
pnpm dogfood:serve               # that universe in the UI on :4711
```

## Branches

Work on `main`. Never create a feature branch (or a worktree on a new branch)
unless the user explicitly asks for one in that conversation. An earlier
request for a branch does not carry over. If a task seems to call for a branch,
ask first.

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
- Probes that declare a `workload` measure the fixed benchmark workload
  (ADR 0004). If `apps/server/test/efficiency.test.ts` says it changed size
  (usually an edit to `demo.ts`), bump every such probe, then update
  `BENCH_SHAPES` in `apps/server/src/dogfood/efficiency.ts`.
- Efficiency tests count and compare; they never time. Timings belong in a
  dogfood probe.
- `apps/server/test/fixtures/*.jsonl` is frozen history (ADR 0005). Never
  edit one. A new event type or format gets a new `events.v<n>.jsonl` in the
  new shape, pinned by its hash in `flexibility.test.ts`.
- A new environment variable needs a row in the README's configuration
  table. A new route needs a row in its API table.
- `apps/server` reads the environment only in `apps/server/src/settings.ts`
  (ADR 0007), and only from entry points, never at import time. There, an empty
  value means unset, and anything else must parse or the process stops,
  naming the variable. A new setting also needs a row in `SETTINGS` in
  `apps/server/test/operability.test.ts`.
- Log a failure inside a request with `req.log`, so the line carries the
  request id the caller gets back.
- Apart from probes and tests, which write their own temp logs, only
  `apps/server/src/store.ts` writes a log file (ADR 0008). Open a log you only
  read with `{ readOnly: true }`; a writer holds `<log>.lock` until `close()`. The store may cut back a write that failed, which was never
  acknowledged, but never rewrites an acknowledged line.
- Nothing the repository runs destroys a log. An operation that replaces or
  removes one keeps what it replaces (`replaceAll(events, keep)`, ADR 0009).
- Made-up readings (the simulator) feed only the demo universe
  (`simulatorRefusal` in `apps/server/src/demo.ts`).
- `FALSE_GREEN_MUTANTS` in `apps/server/src/dogfood/safety.ts` and
  `CLAIM_MUTANTS` in `apps/server/src/dogfood/suitability.ts` quote
  `packages/core/src` verbatim. If you change quoted text, rewrite the break
  for the new code and bump `false-green-mutants` or `claim-mutants`;
  `dogfood.test.ts` names it. A new row in the README's *The idea* table needs
  an entry in `NEEDS` and at least one break that leaves it unmet (ADR 0012).
- Logic that decides what the console shows (the backlog, the breadcrumb, the
  signal, the ribbon) lives in `packages/core`, with a test there: the console has no unit
  tests, and the claim breaks reach only the core.
- `docs/tour.gif` pictures the console and the demo story. If a change alters
  what it shows, re-record it with `readme-gif` against a fresh `pnpm reset`.
- The console warns when its live view stops updating (`useStalledSince` in
  `apps/web/src/App.tsx`). The smoke test checks it in its last steps, after the
  console-error check, because the requests it blocks log errors.
- Every request passes `guard` in `apps/server/src/guard.ts` (ADR 0010): a Host
  the server answers to, no write from another origin, the security headers.
  A new route needs nothing more; a new way in (a socket, a second port) gets
  the same checks. The console loads only its own files: no inline script, no
  `eval`, nothing from a CDN, or the CSP blocks it and the smoke test fails.
- A reading needs the ingest token by every route that records one. Refuse
  with `refuse()`, which logs the refusal and never the credentials offered.
- Nothing shaped like a credential is committed, not even in a test: build a
  fake one at runtime (`secrets-in-history` reads all of history).
- The settings every source shares, and their checks, live in
  `apps/server/src/sources/config.ts`. A source kind declares only its own
  fields, never a shared one, and lets out only what its `details` allowlists.
  Only the collector calls a kind's `queryRange`. `registryProblems` and
  `apps/server/test/sources.test.ts` hold the installed modules to this.
- Background work (timers, the collector) never lets a promise reject
  unhandled: a failure fails its own binding or tick, not the process.
- A test that starts real processes, or works for seconds, sets an explicit
  timeout (`SPAWNS` in `apps/server/test/reliability.test.ts`).
  `tests-order-dependent` runs the suites shuffled and counts what fails only
  then.
- UI colours go through the theme tokens in `styles.css` (`--name: …`). A
  text colour reads at 4.5:1 on every surface it is drawn on, in both schemes;
  a new text or surface token joins the lists in
  `apps/server/test/usability.test.ts`, and both dark blocks stay identical.
- The console meets WCAG 2.2 AA wherever a scan can tell (ADR 0011). A new view
  or dialog joins `VIEWS` in `apps/web/e2e/a11y.mjs`. Targets are at least
  24 px. Give a control a role only with the keyboard behaviour the role
  promises. The scan sets the CSP aside in its own browser context; the smoke
  test never does.
- Instants that cross the API carry a zone (`Z` or an offset), so answers
  don't depend on the server's time zone.
- Core and the server take the time and any randomness as arguments
  (ADR 0006). A new `Date.now()`, argument-less `new Date()` or
  `Math.random()` in `packages/*/src` or `apps/server/src` goes into
  `SANCTIONED_CLOCKS` in `apps/server/src/dogfood/maintainability.ts`, with a
  version bump.
- Write new functions at or under cognitive complexity 15 (`k-complex`). Split
  an existing one when you are changing it anyway, never just to move the
  number.
- Every package declares what it imports in its own `package.json`. Commit
  `pnpm-lock.yaml` with any manifest change.
- A suite probe names `describe` titles. `dogfood.test.ts` checks they exist,
  so rename the test and the probe together.
