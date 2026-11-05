# ADR 0002 — A metric binds to a configured source; the platform pulls, the log keeps the binding

**Status:** Accepted (PoC) · **Date:** 2026-11-04 · **Builds on:**
[ADR 0001](0001-one-graph-append-only-evolution.md) · **Amended by:**
[ADR 0013](0013-modules-bring-what-core-does-not-know.md), which moves the
source kinds, the query languages and the Prometheus adapter out of core and
the server into modules

## Context

A measured node (a KPI, or a scenario's pass/fail check) gets readings in two
ways today: someone records them by hand, or something pushes them to
`POST /api/readings`. Nothing in the model says *where a number comes from*.
A person looking at *Checkout server errors (5xx rate)* cannot see which
PromQL expression produces it, and cannot jump to the Grafana panel the on-call
team watches. If nobody wires a pusher, the KPI simply goes stale.

Most teams already have these numbers in Prometheus, usually viewed through
Grafana. "Linking a metric to its source" covers three separate needs:

- **Provenance.** Which query defines the number. This matters for every KPI,
  including the ones that are pushed.
- **Drill-out.** Where a person goes to look at it: a Grafana panel, or a
  Prometheus graph.
- **Pull.** The platform runs the query on a schedule and turns each answer
  into a reading.

Five facts constrain the shape:

1. The event log is permanent (ADR 0001, decision 4). Whatever is written to it
   is replayed into every projection, forever.
2. `POST /api/commands` is unauthenticated in the PoC. Its `x-actor` and a
   reading's `source` are whatever the caller says they are.
3. `packages/core` must stay pure, with no network access, and `decide` is the
   only gate.
4. A reading is judged against the definition in force when it was observed.
   That includes *what the number meant* at the time.
5. Prometheus evaluates a query at the instants it is asked for, not at scrape
   times. A `query_range` is capped at 11 000 points.

## Decision

### 1. Three pieces, kept apart: source, binding, dashboard link

**A source** is a connection that the operator configures in a JSON file named
by `RU_SOURCES_FILE`. It holds an id, a kind, the URL the server fetches from,
an optional `publicUrl` that people may be sent to, an optional token
(referenced by the *name* of an environment variable), and the pull cadence.
None of it ever enters the log.

```json
[
  { "id": "prometheus", "kind": "prometheus", "url": "http://prometheus:9090",
    "publicUrl": "https://prometheus.example.com", "stepSeconds": 300 },
  { "id": "grafana-prod", "kind": "prometheus", "url": "https://grafana.example.com",
    "grafana": { "datasourceUid": "P1809F7CD0C75ACF3" }, "tokenEnv": "RU_GRAFANA_TOKEN",
    "publicUrl": "https://grafana.example.com" }
]
```

Grafana is **a route to Prometheus, not a second kind**. When `grafana` is set,
requests go through Grafana's datasource proxy
(`/api/datasources/proxy/uid/{uid}/api/v1/query_range`) using a Viewer service
account token. The drill-out link then opens Grafana Explore. Calling Grafana a
kind would blur what `kind` means and make the adapter seam look tested when it
is not. Because a binding names only a source id, moving between direct access
and Grafana changes configuration, never history.

**A binding** is part of a node's *definition*:

```json
{ "sourceId": "prometheus", "language": "promql",
  "query": "100 * sum(rate(http_requests_total{route=\"/checkout\",code=~\"5..\"}[5m])) / sum(rate(http_requests_total{route=\"/checkout\"}[5m]))" }
```

- `language` says what the query means, independent of whoever runs it. Without
  it, pointing the id `prometheus` at another system would silently reinterpret
  every logged query. The enum holds only `promql` and grows one value at a
  time.
- `sourceId` may be `null`. A binding without a source is **provenance only**:
  it documents the query behind a pushed KPI, and nothing pulls it. That is
  how the demo shows queries on KPIs fed by the simulator, without pretending
  to pull.

**A dashboard link** (`dashboardUrl`) is ordinary node metadata, changed by
`node.edit` without a reason. A renamed Grafana dashboard does not change what a
number means, so it needs no new definition version. The schema refines it to
`http:`/`https:` only. That check lives in the shared payload schema, so a
hand-edited log is held to it as well. The UI re-checks it before rendering.

This split follows from facts 1 and 2:

- **No secret enters the log.** A token written into an append-only log can be
  superseded but never removed.
- **No caller can point the server at an arbitrary address.** A binding chooses
  among configured sources. It cannot add a URL, a path or a method. The adapter
  hard-codes `/api/v1/query_range`, sends the query as a form body, and refuses
  redirects.
- `publicUrl` is separate from `url`, so internal topology such as
  `http://prometheus:9090` never reaches the browser. Without a `publicUrl`
  there is no drill-out link.

### 2. The binding is versioned with the measure, and a new query is a new yardstick

Changing a binding is a `node.redefine` with a required reason. It starts a new
definition version, like a measure change does. A query *is* the meaning of the
number: `rate(…[5m])` versus `rate(…[1h])`, or one route versus all routes, are
different quantities. Time travel shows which query was in force on a given
day, and the timeline records who changed it and why.

`evaluate` acts on this. If a version changes the binding's `language` or
`query` after the latest reading, the reading is **not comparable**, the same
treatment ADR 0001 gives a new unit. The node reports unknown until a reading
arrives under the new query. It is never re-judged into a false green. Changing
only `sourceId` (for example from direct access to the Grafana route, or from
`null` to a real source) keeps the readings comparable: the quantity is the
same.

`decide` refuses a binding on a node without a measure, and a redefinition that
removes the measure but keeps the binding. The fields are optional in the event
schema, so every existing log keeps loading unchanged.

### 3. Pulled readings are a reserved namespace, guarded by `decide`

Every reviewer found the same hole in the draft. A reading's `source` is a free
string, so a collector that resumed "after the last reading from source
`prometheus`" could be steered by anyone, including the shipped simulator,
which already says `prometheus`. Provenance resting on that string proves
nothing. So:

- Pulled readings carry `source: "pull:<sourceId>"` and actor `collector`.
- `decide` refuses any reading whose source starts with `pull:` unless
  `DecideContext.origin` is `'collector'`. Only the server's collector sets that
  flag. The API, the webhook and the seed never do. A plain `prometheus` stays
  free for pushers.
- For a collector reading, `decide` also checks that:
  - the node is active;
  - its *current* binding names that source;
  - the reading was observed **at or after the binding's start**, the
    `effectiveFrom` of the earliest version in the unbroken run of versions
    with this same binding. A catch-up therefore never runs today's query for
    instants when another query was in force (fact 4);
  - no reading with the same `(node, source, observedAt)` exists yet.
    Idempotency lives in the gate, not in the collector's arithmetic.
- `DecideContext.sources` is **required**: the catalogue of configured source
  ids and their kinds. When a binding is set or changed, `decide` refuses it if
  the source is unknown or its kind can't run the language. An unchanged
  binding is not re-checked, so a source dropped from configuration never
  blocks revising a threshold. The collector reports such a binding as
  `not-configured` instead. The seed passes an empty catalogue, because its
  bindings are provenance-only. No caller can forget the check, because
  leaving the catalogue out is a type error.
- `decide` refuses a pass/fail reading that is not exactly 0 or 1. A pass/fail
  check bound to a query that returns 99.9 is then refused instead of being
  judged a pass.

### 4. The collector: one loop per source, settled instants, chunks that are all or nothing

The collector lives in `apps/server/src/sources/`, never in core. Each
configured source runs its own loop at its `stepSeconds` (default 300). Each
binding is single-flight: a tick is skipped while the previous pull for that
binding is still running, so one slow source can't hold up another. For every
active node whose current binding names the source, a tick:

1. **Chooses instants on a fixed grid** of `k · step` (Unix seconds). The grid
   ends at `floor((now − settle) / step) · step`. The settle lag (default 60 s)
   leaves time for the latest scrape to land, so the newest point isn't taken
   from a half-filled `rate` window. The grid starts after the latest pulled
   reading, and never before the binding's start or the catch-up horizon. The
   horizon is the shorter of 24 h and 1 000 steps.
2. **Runs `query_range`** in chunks of at most 1 000 points. That stays well
   under Prometheus's cap, and step and timeout are checked when the config
   loads.
3. **Turns each sample into a `reading.record`**, with `observedAt` set to its
   evaluation instant, and passes each chunk through `decide` against a *fresh*
   projection. If the binding was redefined while the request was in flight,
   the gate refuses the chunk and the next tick runs the new query.

**A failed or ambiguous pull writes nothing.** That covers:

- an unreachable source, an HTTP error or a timeout;
- an empty result;
- more than one series;
- `NaN`/`±Inf` samples, which are skipped;
- a sample `decide` refuses.

The collector never writes 0 and never picks "the first series". The node goes
stale and reports **unknown**, as ADR 0001 decision 2 requires.

A pull's outcome is operational state, kept in memory and served at
`GET /api/sources`. A failed pull is not a fact about the requirement. Its
consequence, staleness, is what the model records. Each binding reports:

- its last attempt and its last success;
- an error **category** (`unreachable`, `http`, `timeout`, `empty`,
  `multi-series`, `rejected`, `not-configured`, `token-missing`);
- an HTTP status, but never upstream text, which could echo internals.

The server logs at `warn` only when a binding changes state (ok → failing,
failing → ok), not on every tick. The response serializes sources through an
allowlist: id, kind, public URL, route, step. Tokens and internal URLs never
appear.

### 5. Configuration fails fast; a missing token fails closed

- Unset `RU_SOURCES_FILE`, or a file containing `[]`: no collector starts, and
  `pnpm dev`, the simulator and the tests need no Prometheus.
- The server **refuses to start** if the file is missing, is not JSON, or has
  any of these: a duplicate id, an unknown kind, a URL with credentials or a
  query string, an inline `token` field, a step under 10 s, or a timeout not
  under half the step.
- If a named `tokenEnv` is unset, the source is marked `token-missing` and is
  never queried. That satisfies operable's "degrade, don't crash" and secure's
  "never send an unauthenticated request" together.
- With sources configured, the server **refuses to listen on a non-loopback
  `HOST`** unless `RU_ALLOW_REMOTE=1` is set. Commands are unauthenticated, and
  anyone who can bind a query can turn the server's token into a PromQL oracle
  whose answers land permanently in the log. This keeps "only while local"
  backed by a mechanism instead of a sentence.

### 6. The UI shows provenance and drills out

A node with a binding shows:

- the query, and the language it is written in;
- its source, and whether the server knows that source;
- the latest pull status, with its category;
- an "Open in Prometheus/Grafana" link, built from the source's `publicUrl`
  with the query URL-encoded;
- the dashboard link.

*Revise definition* can add, change or remove the binding. *Edit* changes the
dashboard link. The simulator skips any node whose binding names a source, so a
pulled KPI is never fed from both sides.

## Consequences

- A KPI can be observed without code outside the platform. The source is
  configured once, and each binding is a reasoned, versioned change.
- The reading volume grows by one reading per binding per step: 288 a day at
  the default 300 s. ADR 0001's *revisit when reading volume makes projection
  slow* gets closer.
- An expensive query costs Prometheus. A timeout bounds each request, and the
  loopback guard bounds who can write queries at all.
- Configuration becomes a second source of truth beside the log, deliberately.
  It holds only *how to reach* a system, never *what the model says*.
  `pnpm reset` reseeds the log and so drops bindings made by hand. The
  configuration survives.
- README sections on feeding data, the API, running, the layout, what is
  missing and next steps change with this ADR.

## Tensions resolved

- **A link in the definition, or as metadata** (suitable against the draft):
  the query is meaning, so it is versioned. The dashboard link is navigation,
  so it is metadata.
- **A missing token: degrade or fail closed** (operable against secure): both
  hold at once. The server starts, and the source is never queried without its
  token.
- **Grafana now** (flexible against the user's request): it is kept, but as a
  route, so it costs configuration and no log shape.

## Not decided here

- **Capping `staleAfterHours` for bound nodes.** A failing binding with a long
  staleness keeps its last value for that long. For now the UI shows the pull
  status next to it.
- **Unit checks between query and measure.** A ratio query against a `%`
  target is undetectable without a unit on the binding.
- **Other sources:**
  - Datadog, and SQL or analytics sources for business KPIs, would each be a new
    `kind` and `language` behind the same seam: `fetch(source, query, instants)
    → samples | failure`.
  - CI and JUnit results stay *push* events, on the webhook.
- **Alert webhooks** (Alertmanager, Grafana alerting). An alert is an event, not
  a value.
- **Several server processes on one log.** The store has no file lock, and two
  collectors would double the pulls. One process per log, as today.

## Revisit when

- commands get authentication, so bindings can be trusted against shared
  monitoring without the loopback guard;
- a second source kind or query language is needed;
- reading volume from pulls makes projection slow (ADR 0001).
