# Changelog

## 0.1.0 — 2026-11-18

The first release of Orrery, a proof of concept: requirements, constraints and
business + quality KPIs as one living, observable graph. It is not stable; the
event format, the API and the console may all change.

### The model

- One recursive **node** type (product → goal → requirement / constraint →
  KPI / scenario), with **links** so one node can evidence several parents.
- **Measures** on KPIs (unit, better-when, target, warning threshold,
  staleness) and pass/fail **scenarios**, along the
  [arc42 Quality Model](https://quality.arc42.org/) dimensions plus `business`.
- A rolled-up **status** for every node (on target / warning / breach /
  unknown) with a one-line reason, **coverage** and a 14-day ribbon. Unknown
  never rolls up as green.
- **Append-only evolution**: targets, rollup rules, priorities, structure and
  lifecycle change through reasoned events, and a reading stays judged against
  the definition in force when it was taken.
- **References** from a node to the code, tests, documents and tickets behind
  it, harvested from tags in any file by `pnpm tags`. References never change a
  status.

### The console

- A focus view that shows one node and one level below it, a breadcrumb back
  up, and **Follow the signal** from a red goal to the reading behind it.
- **Time travel** to the universe as it was known on any day, a **Not yet
  observable** backlog, a **Changes** feed, **Connections**, file pages and
  **Jump to** (Ctrl+K).
- Forms to refine, record readings, revise definitions and add references.
- WCAG 2.2 AA wherever an automated scan can tell (ADR 0011).

### The server

- A Fastify API over an append-only JSONL event log that keeps every
  acknowledged write through failures, kills and second writers.
- Metrics pulled from configured Prometheus and Grafana sources, through the
  Prometheus module (ADR 0002, ADR 0013).
- Host and origin checks, a strict CSP and an optional ingest token on
  readings (ADR 0010).
- A demo universe, **Larch Store**, with thirty days of history, an incident in
  progress and a live signal simulator.

### The repository measures itself

- `pnpm dogfood` measures this repository against its own eleven goals with
  versioned probes, and `pnpm dogfood:serve` shows that universe in the console
  (ADR 0003, [docs/dogfood.md](docs/dogfood.md)).

### Architecture

- Written up in [arc42](docs/architecture.adoc) with fourteen accepted
  decisions (ADR 0001–0014). ADR 0015, suspect contributions, is still
  *Proposed* and not implemented.

### Getting started

Node ≥ 20.19 and pnpm:

```bash
pnpm install
pnpm dev        # API :4710 + UI :5710 + live signal simulator
```
