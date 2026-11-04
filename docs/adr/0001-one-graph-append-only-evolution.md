# ADR 0001 — One contribution graph, explicit rollups, append-only evolution

**Status:** Accepted (PoC) · **Date:** 2026-11-03

## Context

The platform has to hold requirements, constraints and business + quality KPIs
for a piece of software, show their state from the very top, and let a person
dive one level at a time down to raw readings. It must support building the
model iteratively — a one-line goal today, measurable scenarios next month —
and it must survive the model changing underneath it: targets are tightened,
priorities shift, requirements move, get split or retired.

Four decisions carry the design. Each one is cheap to get right on day one
and expensive to retrofit.

## Decision

### 1. One recursive node type, in a contribution graph

Every element is a **node** with a `kind` label: `product`, `goal`,
`requirement`, `constraint`, `kpi`, `scenario`. Kinds are vocabulary, not
schema: any node may contribute to any other, and the UI only *suggests* typical
children. A node has one **primary parent** (the path progressive disclosure
walks, the breadcrumb) and any number of **links** — further parents it also
contributes to, because one KPI often evidences several requirements (the demo's
5xx rate counts for both availability and checkout).

Edges form a DAG. `decide` refuses any move or link that would make a node
contribute to itself; evaluation also guards against cycles so a hand-edited log
cannot hang the server.

A node *may* carry its own **measure** (`unit`, `direction`, `target`, `warn`,
`staleAfterHours`) and, for quality scenarios, the stimulus / environment /
response text of an ATAM-style scenario. A pass/fail check is a measure with unit
`pass/fail`. Quality classification uses the nine dimensions of the arc42
Quality Model plus `business`, cited by name, not vendored.

### 2. "Unknown" is a status in its own right and never rolls up as green

Statuses are `ok`, `warn`, `breach`, `unknown`. A node is unknown when its
measure has never received a reading, when its latest reading is older than
`staleAfterHours`, or when it has nothing beneath it yet (an unrefined stub).
In worst-of, `unknown` ranks **above** `ok`; in the weighted rule an otherwise
green score with unknown inputs reports unknown; in quorum, unknown inputs keep
the result undecided whenever they could change it.

This is what makes iterative refinement honest: a stub is legitimate and
visible, shows up in the "Not yet observable" backlog of everything above it,
and every node reports **coverage** — how many of its observable endpoints are
actually measured.

### 3. Rollup rules are explicit data on each node

How contributors combine is stored on the node and versioned with it, never
implied by code:

- `worst` — the worst input decides;
- `weighted` — priority-weighted score (critical 8, high 4, medium 2, low 1;
  ok 1, warn ½, breach 0) against `okAt` / `warnAt`; any **critical** input in
  breach vetoes to breach;
- `quorum` — on target when `okShare` of inputs are, warning at `warnShare`.

Every evaluation returns a one-sentence **reason** and its **drivers** (the
inputs that decided it), so "why is this red?" is answered as a path — the UI's
*Follow the signal*.

### 4. Evolution never rewrites history

The only state is an **append-only event log** (`data/events.jsonl`).
Everything else is a projection. Consequences:

- A change to a measure, rollup or scenario appends a new **definition
  version**, effective from that moment. A reading is always judged against the
  version in force when it was observed — tightening a target re-zones the chart
  from that day on and leaves earlier readings their original colour.
- Priority changes, moves, links, deprecations and redefinitions **require a
  reason**; the timeline keeps who, when and why.
- **Time travel** is a projection to an earlier `asOf`: the model *as it was
  known then*, with the targets and priorities in force then.
- Deprecation retires a node from its parent's rollup without deleting it.

## Consequences

- The domain core (`packages/core`) is pure and synchronous: projection,
  evaluation, rollup, history and the command gate (`decide`) are plain
  functions, tested without I/O. The server is a thin shell.
- Projection is recomputed per request. At PoC scale (~3k events, ~45 nodes) a
  full view takes ~40 ms. Beyond tens of thousands of readings this needs
  snapshots, or a split into a definition log plus a time-series store
  (see README → *Next steps*).
- Readings are events too, so "what did we know at T" is answerable.
  Recording time (`at`) and observation time (`observedAt`) are kept apart, and
  late back-dated readings land in place.
- There is no authentication; the caller names itself via `x-actor`. That is
  acceptable only for the PoC.

## Revisit when

- reading volume makes per-request projection too slow;
- several products or teams need isolation (tenancy, permissions);
- definitions should live as code in the target repository (YAML in git,
  readings in the platform).
