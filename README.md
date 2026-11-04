<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/logo-dark.svg">
    <img src="docs/brand/logo.svg" alt="Requirement Universe" width="380">
  </picture>
</p>

# Requirement Universe

**Requirements, constraints and business + quality KPIs as one living,
observable graph** — seen whole from the top, explored one level at a time, and
allowed to evolve without rewriting its past.

> Proof of concept. The demo data describes **Larch Store**, a fictional online
> shop, with thirty days of history and an incident in progress.

## The idea

| Need | How the PoC answers it |
|---|---|
| Build and manage requirements & constraints | One recursive **node** type — product → goal → requirement / constraint → KPI / scenario — with links when one node evidences several parents |
| Business + quality KPIs | A node can carry a **measure** (unit, better-when, target, warning threshold, staleness); scenarios carry stimulus / environment / response and a pass/fail check. Quality is classified by the [arc42 Quality Model](https://quality.arc42.org/) dimensions plus `business` |
| High-level monitoring | Every node gets a **status** (on target / warning / breach / unknown), a one-line **reason**, **coverage** (how much beneath it is actually measured) and a 14-day **ribbon** |
| Progressive disclosure | The focus view shows one node and exactly one level below it; tiles drill down, the breadcrumb climbs back, **Follow the signal** jumps straight from a red goal to the reading that caused it |
| Iterative refinement | A one-line stub is legitimate: it shows as **unknown**, never green, and appears in the **Not yet observable** backlog of everything above it until someone refines it |
| Dynamic evolution | Targets, rollup rules, priorities, structure and lifecycle change through **reasoned, append-only events**. Readings stay judged against the definition in force when they were taken; **time travel** shows the universe as it was known on any day |

The four design decisions behind this are in
[ADR 0001](docs/adr/0001-one-graph-append-only-evolution.md). How metrics bind to
Prometheus and Grafana is in [ADR 0002](docs/adr/0002-metrics-bind-to-configured-sources.md).
How the repository measures itself is in [ADR 0003](docs/adr/0003-the-repository-measures-itself.md).

## Run it

Node ≥ 20.19 and pnpm.

```bash
pnpm install
pnpm dev        # API :4710 + UI :5710 (Vite) + live signal simulator
```

Open <http://localhost:5710>. The first start seeds `data/events.jsonl`.

```bash
pnpm start      # build the UI and serve everything from :4710
pnpm reset      # re-seed the demo relative to now (stop the server first)
pnpm verify     # typecheck + unit/API tests + UI build
pnpm --filter @ru/web e2e   # browser smoke test against a running app (writes to the log)
pnpm dogfood    # measure this repository against its own requirements (see below)
```

## A five-minute tour

1. **Top level.** Larch Store is in **breach**. *Follow the signal* →
   *Customers find and buy…* → *Checkout is short and dependable* →
   *Checkout server errors (5xx rate)*: a checkout incident began six hours
   before the seed. The 5xx KPI lives under *availability* but is **linked** to
   checkout too, so it counts in both places. The simulator keeps the incident
   going for three hours after seeding, then lets it recover live — watch the
   top level fall back to *warning* (the tightened p95 target remains). To replay
   the story: stop `pnpm dev`, `pnpm reset`, start again.
2. **Customer data is safe** is **unknown**, not green: legal added an EU
   residency constraint eight days ago, and its audit scenario has never run.
   Its coverage reads 4/5.
3. **Pages feel instant → Product page latency (p95).** The chart's zones
   change eighteen days ago, when the target was tightened from ≤ 800 ms to
   ≤ 500 ms (v2, with its reason). Earlier readings stay blue, later ones amber — same
   values, different yardstick, and nothing was repainted.
4. **Time travel.** Drag the slider back three weeks: the KPI is green again,
   the requirement is back to *medium* priority, *Search finds relevant
   products* does not exist yet. Ticks on the slider mark model changes.
5. **Evolve it.** Open *Search finds relevant products* (an unrefined stub) →
   **+ Refine** → add a KPI → **Record reading** → **Revise definition**
   (a reason is required). Watch coverage, the parent's status and the
   **Changes** feed update.

## The repository measures itself

The platform's own requirements form a second universe, kept apart from the
demo. Its definitions are code, in
[`apps/server/src/dogfood/model.ts`](apps/server/src/dogfood/model.ts). Its
readings come from versioned probes in
[`probes.ts`](apps/server/src/dogfood/probes.ts).

```bash
pnpm dogfood          # sync the model, measure, record, print the tree (~30 s)
pnpm dogfood:serve    # the dogfood universe in the console on :4711
```

The five goals:

| Goal | What it covers |
|---|---|
| *The model tells the truth* | the CLAUDE.md invariants: the log contract on load, writes only through `decide`, unknown never green, readings judged by the definition in force |
| *Changing it stays safe and cheap* | core purity, type errors, module size, verification time |
| *The console stays fast at realistic scale* | view time at demo scale and after a week of live signals, UI bundle size |
| *Running it exposes nothing it shouldn't* | source and pull guards, dependency advisories |
| *People can follow it end to end* | the demo story, the browser smoke test against the real server, doc links |

Two stubs, coverage and identity, stay *unknown* until they can be measured.

How a measurement is kept consistent:

- **Every measured node is bound to `probe` `<id>@<version>`.** To change a
  method, bump the version and give a `since` reason. The node is redefined,
  and older readings keep their old yardstick.
- **One run is one snapshot**, with a single `observedAt` and the source
  `probe:<env>@<sha>`.
- **Only committed code is recorded.** On a dirty tree the run measures but
  writes nothing, unless you pass `--allow-dirty`.
- **A probe that cannot measure records nothing.** That covers no network for
  `pnpm audit` and no browser for the smoke test. The node goes stale and reads
  unknown, never green.
- **Benchmarks use a fixed workload** (seed 7, fixed date): warm-up runs, then
  the median. Compare timings within one `RU_PROBE_ENV` only.

**To change the model**, edit `model.ts` and commit. `pnpm dogfood` turns the
difference into reasoned commands. The reason is `--reason "…"`, or the model's
last commit subject. Creations and wording changes need no reason.

**`model.ts` wins.** An edit made in the dogfood console is drift, which the
next run would revert. That run refuses to use an older commit subject to
explain the revert. Either carry the edit into `model.ts`, or pass `--reason`.

`--dry-run` plans and measures without writing. `--only k-bundle,s-smoke`
measures a subset.

The two stubs keep the top level from reading green until they are refined.
The first run (2026-11-04) also found three real problems, recorded in
[ADR 0003 → Consequences](docs/adr/0003-the-repository-measures-itself.md#consequences):
- the store loads logs that break the contract;
- dependencies have critical advisories;
- one module is over the size target.

## Feeding it data

Readings arrive through one generic webhook, which is what the simulator uses:

```bash
curl -X POST localhost:4710/api/readings -H 'content-type: application/json' \
  -d '{"readings":[{"nodeId":"k-5xx","value":0.04,"source":"prometheus"}]}'
```

`observedAt` (ISO-8601) is optional and may be in the past; a batch is
all-or-nothing. Set `RU_INGEST_TOKEN` to require `Authorization: Bearer …`.
Readings can also be recorded by hand from any measured node.

### Pulling from Prometheus or Grafana

A measured node can carry a **binding**: the PromQL query that defines its
number, optionally with a configured **source** that runs it. *Revise definition*
sets it (a new query is a new definition version, with a reason). *Edit* sets a
**dashboard link** for people to follow. The demo documents the queries behind
its three Prometheus KPIs and links them to a (fictional) Grafana. The simulator
still pushes their readings.

To have the server pull, configure sources and bind a node to one:

```bash
docker run -d -p 9090:9090 prom/prometheus      # or use your own
cp apps/server/sources.example.json sources.json # edit ids, URLs, steps
RU_SOURCES_FILE=sources.json pnpm dev
```

- Each source is pulled every `stepSeconds` (default 300). Instants are on a
  fixed grid, wait `settleSeconds` for scrapes to land, and catch up after
  downtime up to 24 h, never before the binding took effect.
- Pulled readings are stored as `source: "pull:<id>"`. Only the collector may
  use that prefix.
- A failed, empty, multi-series or non-finite answer records nothing, so the
  node goes stale and **unknown**. `GET /api/sources` and the node view say why.
- Grafana is a route, not a kind: set `grafana.datasourceUid` and a Viewer
  token (by env var name, `tokenEnv`). Requests then go through Grafana's
  datasource proxy, and "Open in Grafana Explore" uses `publicUrl`.
- Tokens are never stored in the log or returned by the API. With sources
  configured, the server refuses a non-loopback `HOST` unless
  `RU_ALLOW_REMOTE=1`, because commands are unauthenticated.

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/universe?asOf=` | Every node with status, reason, drivers, coverage, ribbon, sparkline |
| `GET` | `/api/nodes/:id?asOf=` | Definition versions, history, reading series judged per version |
| `GET` | `/api/changes?asOf=&limit=` | The model's change feed (readings excluded) |
| `POST` | `/api/commands` | `node.create · edit · redefine · reprioritize · move · link · unlink · deprecate · reactivate`, `reading.record` |
| `POST` | `/api/readings` | Ingestion webhook (single reading or `{ readings: [...] }`) |
| `GET` | `/api/sources` | Configured metric sources (public fields only) and each binding's pull state |

Commands are validated by `decide` in the core: unknown ids are 404, cycles
and duplicate state are 409, and missing reasons or malformed measures are 400.
The optional `x-actor` header names the author (there is no authentication in
the PoC).

## Layout

```
packages/core   pure domain — schemas, projection, evaluation & rollup, history, read models
apps/server     Fastify shell, append-only JSONL event store, demo seed, simulator,
                metric sources and the pull collector (src/sources),
                the dogfood model, probes and runner (src/dogfood)
apps/web        React + TanStack Query UI — outline, focus view, chart, dialogs, time travel
docs/adr        architecture decisions
```

## What is deliberately missing

- **Identity and tenancy.** The author is self-declared, and there is one
  universe per log.
- **Scale.** The view is re-projected from the full log on each request.
  That's fine for thousands of events, not for millions of readings. The simulator
  adds ~17k readings a day while `pnpm dev` runs (6 fast signals every 30 s;
  `RU_SIM_TICK_MS` changes it), so `pnpm reset` now and then on a long-running demo.
- **Integrations beyond Prometheus.** Prometheus (directly or through Grafana)
  can be pulled (ADR 0002). Datadog, SQL or analytics sources and alert webhooks
  are not built. CI reporters push into the webhook.

## Next steps

1. **Requirements as code.** The dogfood universe is the first slice
   (ADR 0003): definitions in a reviewed file, reconciled through `decide`.
   Next, make the format a product feature (YAML beside any codebase, imported
   the same way) and run the probes in CI.
2. **Integrations.** More source kinds behind the ADR 0002 seam (Datadog, SQL or
   analytics for business KPIs), JUnit/CI results feeding scenarios, and
   authentication on commands so bindings can safely target shared monitoring.
3. **Impact preview.** Before publishing a new target or priority, show which
   ancestors would change status ("this makes *Pages feel instant* amber").
4. **Storage.** Snapshots plus a time-series table (Postgres) once the reading
   volume grows; the definition log stays event-sourced.
5. **Alerting and ownership.** Notify a node's owner when it enters breach or goes
   stale; add per-team views of the same universe.
