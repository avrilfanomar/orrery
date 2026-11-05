# ADR 0004 — Efficiency is tested twice: its shape in the suite, its size in the dogfood

**Status:** Accepted (PoC) · **Date:** 2026-11-04 · **Builds on:**
[ADR 0001](0001-one-graph-append-only-evolution.md),
[ADR 0003](0003-the-repository-measures-itself.md)

## Context

The dogfood goal *The console stays fast at realistic scale* measured three
numbers: view time at demo scale, view time after a week of live signals, and
the UI bundle. Several costs went unmeasured:

- **The write path.** Every command and every webhook push projects the whole
  log before `decide` sees it.
- **A restart.** The store schema-checks every stored line on load, and
  `pnpm dev` restarts the server on each code change.
- **Memory.** The whole log stays in memory between requests.
- **The answer.** Every open console fetches the universe view every 5 s.
- **The batch limit.** Nothing showed that a batch at the documented limit
  gets past the body limit.
- **How cost scales.** Re-projecting per request is linear by design
  (ADR 0001). Nothing would notice a second fold per node, per ribbon day or
  per reading.

The arc42 quality model tags about forty qualities `#efficient`. Most of them
are ISO 25010's *performance efficiency* (time behaviour, resource use,
capacity) or close to it (latency, throughput, start-up time, determinism).

Two constraints shape the answer:

- **Timings belong to a machine** (ADR 0003). In `pnpm verify` a timing budget
  is either flaky or too loose to catch anything.
- **A probe's version pins its method, not its workload.** The timing probes
  measure "the demo as seeded at a fixed instant, seed 7". An edit to `demo.ts`
  changes every timing, and today nothing says so.

## Decision

### 1. The suite pins the shape, without a clock

[`packages/core/test/efficiency.test.ts`](../../packages/core/test/efficiency.test.ts)
and [`apps/server/test/efficiency.test.ts`](../../apps/server/test/efficiency.test.ts)
time nothing. Each outermost `describe` is one dogfood scenario:

| `describe` | What it pins | Scenario |
|---|---|---|
| log passes per request | A Proxy counts reads of the event array. Reads per stored event stay the same with ten times the nodes, with 60 ribbon days instead of 14, and with a batch of 1000 readings instead of 1. A command folds the log as often as one reading | `s-log-passes` |
| answer size | The universe view keeps its size when readings grow tenfold. Sparklines (42 points), series (360) and the change feed (its limit) stay capped | `s-answer-size` |
| capacity | A batch of `MAX_READINGS_PER_REQUEST` readings, every field at its longest, is accepted whole, not refused with 413. One reading more is refused with 400 and nothing is written | `s-capacity` |
| benchmark workload | The workloads come out identical on every run, and their size matches `BENCH_SHAPES` (see 3) | `s-bench` |

The property is that the count does not change, whatever the constant is. A
new pass over the whole log is allowed. A pass per node, per day or per
reading fails.

Each test was shown to fail by breaking the code on purpose:

| Deliberate break | Test that turned red |
|---|---|
| projecting per ribbon day | the view fold |
| a fold per node in the detail; a fold per entry in the feed | the detail and feed fold |
| projecting per reading | both server fold tests |
| removing the spark cap | both answer-size tests |
| a 1 MB body limit | both capacity tests |
| a clock-seeded demo | the determinism test |
| a wall-clock instant in the view | the same-view test |
| a faster cadence for one signal | the shape pin |

### 2. The dogfood measures the size, after a week of live signals

These probes live in [`apps/server/src/dogfood/efficiency.ts`](../../apps/server/src/dogfood/efficiency.ts):

| Probe | Node | Baseline | Target / warning |
|---|---|---|---|
| `write-ms-week` | Recording one reading (median) | 68 ms | 150 / 400 ms |
| `start-s-week` | Loading the log to the first view (median) | 1.6 s | 3 / 6 s |
| `heap-mb-week` | Heap held after loading | 37 MB | 64 / 128 MB |
| `universe-gzip-week` | Universe response, gzip | 6.8 kB | 16 / 32 kB |

- **The workload is built once per run.** The run builds the week of live
  signals once (`ctx.week()`, ~124k events) and stores it as JSONL in the
  run's temp directory. Probes load that file the way the server does. The
  write probe appends, so it works on its own copy.
- **Benchmarks run last.** The write, restart and heap probes run with the
  timings, last and one at a time.
- **Heap is measured between collections.** The probe sets `--expose_gc` at
  run time (as jest's leak detector does) and forces a full collection before
  and after. The value is the growth of `heapUsed`. It depends on the Node
  version, not on the CPU.
- **The restart is measured in-process.** Process and module start-up are left
  out because they don't grow with the log.
- **Thresholds leave room.** Every target sits well above its baseline, so the
  goal's worst-of rollup starts green.

### 3. The workload is part of the yardstick

A probe declares the fixed workload it depends on with `workload: 'demo' |
'week'`. `BENCH_SHAPES` pins the number of events of each type in both
workloads. When an edit changes that size, the benchmark-workload test fails
and names every such probe. The author bumps each one with a `since` reason,
then updates the pin.

The pin uses counts, not a hash. A reworded demo still gives comparable
timings, so it should not need a bump. A new node, a new signal or a new
cadence does change the workload, and those change the counts.

### 4. Where each `#efficient` quality is covered

| Quality | Covered by |
|---|---|
| Time behaviour, response time, latency, speed, performance | `k-view-demo`, `k-view-week`, `k-write-week` |
| Start-up time | `k-start-week` |
| Throughput | `s-log-passes` (a batch shares one projection), `s-capacity` |
| Capacity | `s-capacity`. `k-view-week` remains ADR 0001's volume trigger |
| Resource utilization, memory usage, resource efficiency | `k-heap-week` |
| Conciseness | `k-payload-week`, `s-answer-size`, `k-bundle` |
| Algorithmic complexity, scalability | `s-log-passes`, `s-answer-size` |
| Determinism | `s-bench` |
| Cycle time | `k-verify` (ADR 0003) |

Left out on purpose:

- **Jitter.** In an in-process benchmark it measures the machine (GC, the
  scheduler), not the code. It needs a sustained load test against a running
  server.
- **Shutdown time.** `app.close()` takes ~0.2 ms and nothing is buffered, so no
  number would move.
- **Energy efficiency, energy proportionality, carbon.** There is no meter.
  CPU time, which the timings already give, is the proxy. See the idle-console
  finding below.
- **Cost, affordability, profitability, value for money, time to market,
  releasability.** These are business and process qualities, and the
  repository holds no data for them.
- **Distributability.** The PoC is one process by design (ADR 0001).
- **Code complexity, readability, cohesion, coupling, simplicity.** Here they
  are maintainability more than efficiency. See *Not decided here*.

## Consequences

- **The first dry run measured all eight new nodes, all on target:** write
  67–68 ms, restart 1.5–1.8 s, heap 37.4 MB, response 6.8 kB, and four passing
  scenarios.
- **The cost:**
  - a dogfood run takes ~13 s longer, mostly the restart probe loading the week
    four times;
  - `pnpm verify` generates the week once, ~2 s of CPU.
- **A demo edit that changes the workload's size now means bumping six
  probes.** That is the point. Readings taken before and after the edit are
  different quantities.
- **Findings, not fixed here:**
  - **`EventStore.replaceAll` overflows on large logs.** It spreads its
    argument into `push`, and above ~120k events the stack overflows. Seeding
    and reset write small logs, so this is latent. A re-seed of a week-sized
    log would crash.
  - **An idle console is not free.** Each open tab triggers a full projection
    every 5 s, whether or not anything changed. At a week of signals that is
    ~250 ms of CPU, about 5% of a core per tab. The work tracks polling, not
    change. An ETag keyed by the log's last sequence number would make an idle
    tab nearly free.
  - **The restart is mostly schema parsing.** `EventStore.open` takes 1.1–1.5 s
    of the restart. The contract check on load that `s-log-load` asks for will
    add to it, and `k-start-week` will show how much.

## Not decided here

- **Code complexity.** A cyclomatic scan of tracked sources gives `decide` 51,
  `applyEvent` 42 and `Focus` 40, all dispatch switches. 13 functions exceed
  15. A maximum would start in breach or be arbitrary. A count above a
  threshold could work, but it belongs under *Changing it stays safe and
  cheap* with its own reasoning.
- **A load test.** Concurrent requests against the real server, which jitter
  and throughput under contention need.
- **Gating.** Whether a breach should fail `pnpm dogfood` is still ADR 0003's
  open question.

## Revisit when

- **Snapshots or incremental projection land** (ADR 0001's revisit). The
  pass-count tests then pin a different shape.
- **The dogfood runs in CI.** Heap and timings there need their own
  `ORRERY_PROBE_ENV`.
