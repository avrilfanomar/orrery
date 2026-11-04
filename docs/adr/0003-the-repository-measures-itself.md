# ADR 0003 — The repository measures itself: definitions as code, probes as versioned yardsticks

**Status:** Accepted (PoC) · **Date:** 2026-11-04 · **Builds on:**
[ADR 0001](0001-one-graph-append-only-evolution.md),
[ADR 0002](0002-metrics-bind-to-configured-sources.md)

## Context

The platform models other products' requirements, but not its own. Our own
claims are written down in prose:

- the five invariants in [CLAUDE.md](../../CLAUDE.md);
- the decisions in ADRs 0001 and 0002;
- the README's tour and its numbers ("~40 ms at ~3k events").

Nothing checks that they still hold. `pnpm verify` says the tests pass. It does
not say whether the store really enforces the log contract, whether the view is
still fast at a week of live volume, or whether a dependency has a known
critical advisory.

Dogfooding needs three things:

1. the repository's requirements as a universe;
2. a measurement method per KPI that gives the same number for the same code
   on the same machine;
3. readings that reach the log the way everyone else's do, through `decide`.

Four facts constrain it:

- **The log is permanent** (ADR 0001, decision 4). A wrong definition or a
  fabricated reading can be superseded, but never removed.
- **Changing what a number means needs a new version.** ADR 0002 decision 2
  makes a new query a new yardstick. If a measurement method could change
  silently, readings from before and after would be judged as the same
  quantity.
- **The demo must stay untouched.** `pnpm dev`, the simulator and the story
  pinned by `app.test.ts` are the product's tour.
- **There is no CI here yet.** Measurement runs on a developer's machine.

## Decision

### 1. The model is code; the log is its history

`apps/server/src/dogfood/model.ts` lists the nodes:

- a product;
- five goals, anchored in the invariants and ADRs;
- requirements and constraints under the goals;
- nineteen measured nodes, each naming its probe;
- two **honest stubs**: coverage (no coverage tool is installed) and identity
  (there is no authentication yet). They read unknown until refined.

`planSync` diffs the model against the log. The diff becomes ordinary commands
that go through the public API and so through `decide`:

| Change | Command | Reason |
|---|---|---|
| a node is missing from the log | create | none |
| wording, owner, dimensions or dashboard link differ | edit | none |
| the parent differs | move | required |
| the links differ | link / unlink | required |
| measure, rollup, scenario or binding differ | redefine | required |
| the priority differs | reprioritize | required |
| a node is gone from the model | deprecate | required |
| a deprecated node is back in the model | reactivate | required |

A changed kind is refused: deprecate the node and add a new id.

Reasons are resolved in this order:
1. `--reason`;
2. for a move onto a new probe version, the probe's own `since`;
3. the subject of the last commit touching `model.ts` or `probes.ts`, used only
   when both files are committed as they stand **and no change reached the
   log after that commit**.

If none applies, the whole plan is refused before anything is written.

`model.ts` wins. A change made in the console (a revised target, a refined
node) is drift: the next run plans to revert or deprecate it. A commit subject
older than that edit cannot explain the revert. So the run refuses, and names
the edit. The author either carries the edit into `model.ts` and commits, or
reverts it on purpose with `--reason`.
Editing the model is evolution, and its why ends up in the same timeline as
everyone else's.

A first slice of the README's "requirements as code": definitions live beside
the code, and readings stay in the platform.

### 2. `probe` is a provenance-only query language, and `id@version` is the yardstick

`QUERY_LANGUAGES` gains `probe`, the one-value-at-a-time growth ADR 0002
anticipated. `LANGUAGES_BY_KIND.prometheus` stays `['promql']`, so `decide`
refuses a probe bound to any configured source. A probe binding is always
`sourceId: null`: it documents provenance, and nothing pulls it.

The binding's query is a **stable identifier**, `<probe-id>@<version>`, for
example `ui-bundle-gzip@1`. It is never prose, because comparability keys on
the exact string.
- Changing the method is a version bump with a `since` reason. The sync turns
  it into a `node.redefine`.
- `evaluate`'s existing rule makes the latest reading not comparable, so the
  node reads unknown until a reading arrives under the new method.
- History is never re-judged.
- The prose of the method sits at the end of the node's description, where an
  edit can reword it freely.

The UI keeps a binding's language when a definition is revised. It used to
hard-code `promql`, which would have logged a wrong, permanent yardstick the
first time someone tightened a dogfood target by hand.

### 3. The measurement contract

`pnpm dogfood` runs every probe in `apps/server/src/dogfood/probes.ts`.

**What a reading carries**
- **One instant per run.** Every reading of a run shares one `observedAt`, so
  a run is a coherent snapshot.
- **Provenance in the source**: `probe:<env>@<sha>`, plus `+dirty` when the
  tree had uncommitted changes. `env` comes from `RU_PROBE_ENV` (default
  `local`). The `pull:` namespace stays the collector's (ADR 0002).

**When it writes**
- **Committed code by default.** On a dirty tree the run plans and measures,
  but writes nothing unless `--allow-dirty` is given. Static probes read
  tracked files only.
- **Sync before measuring.** A new definition takes effect before its first
  reading, so a version bump is judged by itself.

**What counts as a value**
- **Not measured is not a value.** A probe that cannot measure records nothing,
  and the node goes stale and reads unknown. That covers no network for
  `pnpm audit`, no browser for the smoke test, and a test selector that matches
  nothing.
- **A failed check is a value**: 0.
- **One malformed value doesn't sink the run.** The runner drops a non-finite
  value, or a pass/fail value other than 0 or 1, before the all-or-nothing
  webhook sees it.

**Fixed conditions**
- **Fixed workloads.** The timing benchmarks use the demo as seeded at
  `2026-11-03T12:00Z` with seed 7, and the week benchmark adds the simulator's
  six fast signals at a 30 s tick through `decide`.
- **Repeatable timing.** Warm-up runs, then the median. The heavy steps run
  sequentially, and the benchmarks run last.
- **The UI is built fresh** into a temporary directory, never taken from
  `apps/web/dist`.
- **Timings belong to a machine.** Compare them within one `RU_PROBE_ENV`.

**Staleness and failures**
- **Staleness is 192 h**: the intended cadence (after each merge to main, and
  at least weekly) plus a day.
- **The test suites map to invariants by selector** (file plus outermost
  `describe`). A renamed suite therefore reads unknown, not green.

**Checking the enforcement path itself**
Where a claim is about behaviour, the probe exercises the code path that
should enforce it. A probe that only reruns the test of a helper would miss
it. For example, `log-load-refuses` opens contract-breaking logs through
`EventStore.open`.

### 4. Its own log, its own port, the same server

- The dogfood universe lives in `data/dogfood.jsonl`, which is gitignored.
- `pnpm dogfood:serve` serves it on :4711 with the built UI, and no simulator
  runs.
- An empty log is seeded by an explicit choice: `RU_SEED=demo|dogfood`, used by
  both `main.ts` and `reset.ts`. Pointing `RU_DATA_FILE` at the dogfood log
  therefore never plants the demo.
- `pnpm dogfood` talks HTTP to a running dogfood server. Otherwise it opens
  the log in-process through `buildApp` and `inject`. Either way there is one
  writer per log.

## Consequences

**The first run is not green, and shouldn't be.**
- `s-log-load` fails. `packages/core/src/log.ts` says the store runs the
  contract check on write and on load, but `EventStore` only checks the schema,
  so it loads logs with sequence gaps and reordering.
- `k-vulns` breaches. Advisories exist for `@fastify/static`, `zod` and
  `tinypool` (through vitest).
- `k-largest` warns: `ActionDialog.tsx` is over 400 lines.

These are findings for follow-up changes, not things this ADR fixes.

**Measuring things that are not tests pays off.** The tests passed while the
log contract went unenforced and the advisories went unnoticed.

**Running it costs time and growth.**
- A run takes ~30 s, mostly the typecheck and `pnpm audit`.
- Each run adds ~20 readings.
- That is negligible next to the simulator.

**Vocabulary.** The probe registry is a second vocabulary to keep in step with
the model. A test enforces a 1:1 match: every measured node has one probe,
every probe is used once, and every binding is its probe's `id@version`.

## Not decided here

- **Running in CI**, and where CI readings would persist. The source naming
  (`probe:ci@…`) is ready for it.
- **Committing the dogfood log** to the repository, as opposed to keeping it
  local.
- **Backfilling** readings by measuring past commits.
- **Coverage.** It needs `@vitest/coverage-v8`; until then `r-coverage` stays a
  stub.
- **Exit codes.** Whether `pnpm dogfood` should fail the shell on a breach
  (a gate) or only report.

## Revisit when

- the dogfood runs in CI, or on more than one machine;
- a second repository wants the same setup, so the model format becomes a
  product feature rather than a file in this repo.
