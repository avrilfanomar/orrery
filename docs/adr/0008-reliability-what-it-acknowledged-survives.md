# ADR 0008 — Reliability: what it acknowledged survives, and a fault stays where it happens

**Status:** Accepted (PoC) · **Date:** 2026-11-05 · **Builds on:**
[ADR 0001](0001-one-graph-append-only-evolution.md),
[ADR 0002](0002-metrics-bind-to-configured-sources.md),
[ADR 0003](0003-the-repository-measures-itself.md),
[ADR 0006](0006-maintainability-structure-counted-diagnosis-pinned.md),
[ADR 0007](0007-operability-what-whoever-runs-it-can-rely-on.md)

## Context

The arc42 quality model tags about sixty qualities `#reliable`. Many were
already covered, and section 6 maps them:

- Correctness, accuracy and timeliness: *The model tells the truth* (the
  invariants).
- Determinism and predictability: ADR 0005 and 0006.
- Diagnosability, failure transparency and traceability: ADR 0006 and 0007.
- Backward compatibility: ADR 0005. Capacity: ADR 0004.

About a dozen belong to machine learning or to physical safety and do not
apply.

That left what happens when something goes wrong: a crash, a full disk, a
second writer, a failing pull, input nobody expected. Each problem below was
reproduced before it was fixed.

**The store never applied the log contract.** `packages/core/src/log.ts` says
the store checks every event on write and on load. Since the first commit,
`store.ts` checked only the schema, so it loaded logs with a sequence gap, a
repeated number or an event older than the one before it. The dogfood recorded
this. `s-log-load`, a critical scenario, has read 0 since ADR 0003, and ADR 0007
left it open. Every log at hand passes the contract: both frozen fixtures, and
the maintainer's local demo log (14,581 events) and dogfood log. Enforcing it
strands none of them.

**A failed write was served anyway.** `append()` added events to memory before
`appendFileSync`.
- On a full disk, the request answered 500, but the server served the change
  until it restarted.
- The next append then wrote a sequence number past the gap. Once the contract
  is enforced, the next start refuses that log, so a full disk that has since
  cleared becomes a server that will not start.
- A write cut off partway left a fragment, and the next append carried on from
  it, in the middle of the file.

**A crash between an event and its line break** left a complete last line with
no newline. The next append carried on from that line, so two acknowledged
events shared one line, and the next start refused the log.

**Seeding and reset were not atomic.**
- `replaceAll` wrote in place. A crash while seeding left a partial universe
  that reopened as if complete, and it was never seeded again.
- `pnpm reset` deleted the old log before it wrote the new one.

**Two writers on one log were prevented only by convention.** `reset` asked the
configured address whether a server was running, and `pnpm dogfood` asked its
URL. Neither saw a server on another port. Both writers would hand out the same
sequence numbers.

**A failed pull stopped the server.** The collector's tick ran as
`void tickSource()`. A store error inside a pull, the full disk again, rejected
that promise with no handler, and Node ended the process with exit code 1. One
binding took down the whole API.

**An offset past ±23:59 answered 500.** For example,
`2026-11-03T12:00:00+99:00` passes zod's format check, but `Date.parse` returns
NaN and `toISOString()` then throws. A reading with such an offset, a webhook
batch containing one, and every `asOf` route all answered 500. Sending hostile
input to every route found this. Everything else in that input was already
refused: deep nesting, prototype keys, `1e999`, 100 kB ids and wrong content
types.

**Nothing handled signals.** SIGINT or SIGTERM ended the process mid-request,
with the collector still pulling.

**Nothing flushed.** ADR 0007 noted it: a power cut could lose a write that had
already been acknowledged. On the maintainer's ZFS disk, `fsync` costs 1.3 ms a
write; without it, a write takes 0.09 ms. `/tmp` is tmpfs there, where `fsync`
costs nothing, so a measurement in `/tmp` would have hidden the cost.

**Run in a shuffled order** (seed 1), the suite failed two tests:
- the time-zone test, which takes 4.5 s on its own;
- a new test that starts processes.

Both ran past vitest's 5 s default while other test files were using the CPU.

## Decision

### 1. The store keeps what it acknowledged

| When | The store |
|---|---|
| it loads a log | holds every line to the contract (`checkLogEntry` replaces the schema parse, so each line is parsed once). A refusal names the line as an editor numbers it |
| it is about to write | holds every new event to the same contract, so the server never writes a line it would refuse at its next start |
| a write succeeds | writes, then `fsync`s, then remembers. A request is acknowledged only after that |
| a write fails, even partway | truncates the file back to the last acknowledged byte and stays writable. If that fails too, it refuses further writes until a restart, but reads go on. The next start names any damaged line (ADR 0007) |
| the log ends without a line break | adds one before the next event |
| it seeds or resets | writes the new log beside the old, `fsync`s it, renames it over the old one and `fsync`s the directory. A crash leaves the old log or the new one, never part of one |
| it opens a log to write | creates `<log>.lock` exclusively, holding its pid. A second writer, whether a store, a server, `reset` or `dogfood`, is refused with the pid and the lock's path. A lock whose process is gone is taken over. So is one holding this process's own pid that this process does not hold: a container restarts as pid 1. The lock is released on `close()` and on exit |

`EventStore.open` gains two options:
- `readOnly` takes no lock and refuses writes. The frozen fixtures and the
  probes use it.
- `fresh` takes the lock without reading the log. `reset` uses it, because the
  log it is resetting may be the broken thing.

`close()` releases the log. When the server closes, it stops the collector and
releases the log.

### 2. Faults stay contained

- **The collector.** A pull that fails inside the server marks its binding
  failing, in a new category, `internal`. Its detail is our own words. The
  cause, which may name a path, goes only to the server's log. A tick never
  rejects. The UI shows the category as "failed inside this server".
- **Instants.** The core's instant schema refuses an instant `Date.parse`
  cannot read, with "a UTC offset runs from -23:59 to +23:59". `asOf` gets the
  same check. Both now answer 400, not 500.
- **Signals.** The entry points (`main.ts`, `dogfood/serve.ts`) close on SIGINT
  or SIGTERM. Fastify lets the requests in flight finish, the collector stops,
  and the log is released before exit code 0.
  - One Ctrl-C can arrive twice: the terminal signals the whole process group,
    and `tsx` relays the signal to its child. So the same signal again within a
    second counts as the same request.
  - A signal later than that forces the exit, still releasing the log.
  - The listeners stay registered while the server closes. Otherwise Node's
    default, or the handler `tsx` installs in its child, would end it
    half-closed: that handler exits as soon as no other listener is left.
  - `tsx watch` waits up to 5 s for its child to exit before it restarts it, so
    a hot reload never meets its own lock.
- **Timeouts.** The tests that start processes, and the time-zone test, now
  take 30 s each. They do real work, which a busy machine slows down.

### 3. The suite pins what must always hold

`apps/server/test/reliability.test.ts` holds five outermost `describe` blocks.
Each is a dogfood scenario.

| `describe` | What it pins | Scenario |
|---|---|---|
| the store keeps the log contract | Four broken logs are refused, each naming the line an editor shows, and a refused log keeps no lock. An event the contract refuses, or a new log with a gap, is not written, and the store keeps its file and its answers. A log cut at every byte of its first six events either loads what came before the cut or names the line to delete; deleting that line, as told, loads the rest. A missing final line break is added | `s-log-written` |
| a failed write changes nothing | The real server under `ulimit -f`, so a batch's write stops partway as on a full disk. It answers 500 with a request id, serves none of the batch, takes a reading that fits, and leaves a log of exactly what it acknowledged. A new log that cannot be written leaves the old one whole. Read-only and closed stores refuse writes and answer as before | `s-failed-write` |
| one writer per log | A second writer in the same process is refused until the first lets go. A server closed in-process lets go. While a real server writes, a store and `reset` are both refused with its pid, and the log is unchanged. After SIGTERM it exits 0, the lock is gone, and `reset` works. A lock left by a dead process, or holding this process's pid, is taken over | `s-one-writer` |
| faults stay contained | A pull that cannot be recorded fails only its binding: no unhandled rejection, category `internal`, no path in the API, and the universe still answers. A source that hangs holds up no other, and its next tick is skipped, not queued. 42 hostile requests each get a refusal with a reason, never a 500, and the log is unchanged. The clock stepping back an hour still lets writes land, in order | `s-contained` |
| stops and restarts cleanly | SIGTERM: exit code 0, the lock released, every acknowledged write kept. The same signal again within a second is an echo; one later forces the exit, with 128 plus the signal's number. SIGKILL: the lock stays, and the next start takes it over and serves every acknowledged write | `s-restart` |

The tests that need `bash` and signals are skipped on Windows.

### 4. The dogfood measures what the suite cannot

| Probe | Node | Baseline | Target / warning |
|---|---|---|---|
| `kill-recovery` | Acknowledged readings missing after a kill mid-write | 0 of 13,450; back in 0.8 s, by itself | 0 / 0 |
| `tests-order-dependent` | Tests that fail only when the suite runs shuffled | 0 (seed from the commit) | 0 / 0 |

`kill-recovery` starts a real server on a copy of the demo log. Four writers
post batches of 50 readings for 1.5 s, then the server is killed with SIGKILL.
The probe starts it again, and if the server names a cut last line, deletes
that line once, as the message asks. It then counts acknowledged readings
missing from the log. The suite cannot do this: when the kill lands depends on
timing, which ADR 0004 keeps out of the suite.

`tests-order-dependent` runs both suites with `--sequence.shuffle`. The seed
comes from the commit, so each commit tries another order, and the detail names
the seed that replays it. It counts tests that fail in that order but pass in
the ordinary run.

### 5. The model

- **`s-log-written`** joins `s-log-load` under `c-log`. The log contract stays
  under *The model tells the truth*, so the two goals do not count it twice.
- **A new goal: *What it acknowledges survives, and a fault stays where it
  happens*.** It rolls up worst-of, like *Whoever runs it can install, start,
  watch and recover it*, so one broken promise shows.

| Requirement | Inputs |
|---|---|
| An acknowledged change survives a failed write, a second writer and a kill | `s-failed-write`, `s-one-writer`, `k-lost-on-kill` |
| A fault fails one request or one binding, never the server | `s-contained` |
| After a stop or a crash it starts again by itself, with everything it acknowledged | `s-restart`; `k-lost-on-kill`, linked. It is itself linked to `r-recovers` (ADR 0007) |
| Its tests give the same verdict in any order and on a busy machine | `k-order-dependent` |

### 6. Where each `#reliable` quality is covered

| Quality | Covered by |
|---|---|
| Durability, data integrity | `s-failed-write`, `s-one-writer`, `k-lost-on-kill`; the contract: `s-log-written`, `s-log-load` |
| Atomicity, transactionality | One request writes once, and a failed write is cut back (`s-failed-write`). A seed or reset is renamed into place. A webhook batch is all-or-nothing up to a crash, not across one (see Not decided) |
| Fault tolerance, fail safe | `s-failed-write`: cut back, else stop writing and keep reading. `s-contained` |
| Fault isolation, graceful degradation, resilience | `s-contained`. A failing source reads unknown, never green: invariant 3, `s-recovery` (ADR 0007) |
| Robustness | `s-contained` (hostile input); `s-gate-refuses` |
| Recoverability | `s-restart`, `k-lost-on-kill`, the every-byte cut test in `s-log-written`; `s-recovery` and `k-start-week` (ADR 0007) |
| Availability | Nothing in `s-contained` stops the server. No uptime is measured (left out below) |
| Stability | `s-contained` (a clock step); `s-bench` (ADR 0004) |
| Faultlessness, verifiability | `k-order-dependent`, `k-tests` |
| Correctness, accuracy, precision, data quality, timeliness | *The model tells the truth*: `s-unknown` (staleness reads unknown), `s-in-force`, `s-gate-refuses`. NaN and ±Inf are no answer (ADR 0002) |
| Determinism, predictability | `s-no-hidden-inputs` (ADR 0006), `s-time-zones` (ADR 0005), `s-bench` |
| Diagnosability, analysability, failure transparency, clarity, transparency | `s-explained` (ADR 0006); `s-startup-refusals`, `s-visible` (ADR 0007); the `internal` pull category |
| Traceability, credibility | `s-audit` (ADR 0007); every dogfood reading names its commit (ADR 0003) |
| Drift detectability | ADR 0003 |
| Backward compatibility, compatibility, longevity | `s-old-logs` (ADR 0005) |
| Capacity, jitter | `s-capacity` (ADR 0004); timings are medians after warm-up |
| Operational constraint, compliance | Settings refused at start, licences (ADR 0007) |
| Functional suitability, completeness, appropriateness, functionality | `s-story`, the invariants: the `#suitable` side |
| Security, vulnerability, immunity | *Running it exposes nothing it shouldn't* |
| Dependability, reliability | The goal as a whole |

Left out on purpose:

- **Bias mitigation, calibration, fairness, groundedness, model transparency.**
  There is no learned model.
- **Safety, patient safety, hazard warning, safe integration, risk
  identification.** Nothing it does can harm a person or a machine.
- **Redundancy.** One process by design (ADR 0001). The lock makes "one" a
  mechanism rather than a habit.
- **Availability as uptime, and sustainability.** Nothing is deployed, so there
  is no uptime to measure. Energy use is efficiency (ADR 0004).
- **Certifiability.** Nothing is certified.

## Consequences

- **Operators see different behaviour.**
  - A running server leaves `<log>.lock` beside its log. `.gitignore` covers
    `data/*.lock` and `data/*.tmp`, so a running server never makes the tree
    look dirty to `pnpm dogfood`.
  - `pnpm reset` refuses while any process writes the log, not only a server at
    `HOST:PORT`, and it no longer deletes the log before the new one exists.
  - A log that breaks the contract now stops the server at start, naming the
    line. Every log at hand passes.
  - SIGINT and SIGTERM stop the server cleanly, with exit code 0.
  - `/api/sources` can report `internal`.
  - An offset past ±23:59 is a 400.
- **The store's interface grows.** `EventStore.open(file, { readOnly, fresh })`
  and `close()`. The efficiency probes open the shared week log read-only, and
  their copies are released when the app closes.
- **The cost:**
  - each write `fsync`s, about 1.3 ms on the maintainer's disk.
    `write-ms-week` does not show it, because its copy of the log sits in the
    temp directory, which is tmpfs there;
  - a restart on a week of live signals (`k-start-week`) takes 2.1 to 2.3 s,
    up from 1.6 s. Each stored instant is now checked for its canonical
    spelling, and each line for its sequence number. That stays under the 3 s
    target. A first draft took 2.75 s, because it also refined every stored
    instant through zod and built two extra arrays. The refinement now applies
    only to instants a caller sends;
  - the server suite runs about 4 s longer, 13.8 s instead of 9.5 s, because
    five tests start real processes. `pnpm verify` takes about 31 s;
  - a dogfood run gains about 3.5 s for `kill-recovery` and about 17 s for
    `tests-order-dependent`'s second run of the suites.
- **The paths the suite does not take were run by hand**, on temp logs and
  spare ports. Each was its own process group, signalled as a terminal does:
  - `tsx watch src/main.ts`, the `pnpm dev` path: SIGINT to the group printed
    one "stopping" line, every process exited, and the lock was gone;
  - `tsx src/main.ts`, the `pnpm start` path: the same;
  - a hot reload under `tsx watch`: the old server stopped on tsx's SIGTERM,
    and the new one took the lock and answered. A SIGINT to the group then
    stopped it cleanly.
- **`model.ts` is now the largest module**, at 447 lines, up from 395.
  `k-largest` was already in warning (444 when last recorded) and stays there.
- **`s-log-load` goes from 0 to 1** once the next run records it. That changes
  *The model tells the truth*, and the root, for the first time since ADR 0003.
- **Findings, not fixed here:**
  - **A webhook batch is not atomic across a crash.** It is one write, but a
    kill partway through it can leave whole lines before the cut line. After the
    cut line is deleted, a subset of the batch stays: readings that were never
    acknowledged. Every command writes one event, and readings do not depend on
    each other, so the universe stays consistent; but "all-or-nothing" holds
    only up to a crash. Closing that needs a commit marker, which is a new
    event format (ADR 0005).
  - **Taking over a stale lock is racy.** Two processes that find the same dead
    lock at the same instant can both take it. A reused pid can make a dead
    writer look alive, and then the message says to delete the lock.
  - **The lock means nothing across machines.** The pid is checked only on this
    machine, and a network file system may not honour exclusive create.
  - **No test can cut the power.** Removing the `fsync` turns nothing red. The
    suite pins the order (write, flush, then acknowledge) only as far as a
    process can observe it.
  - **`k-vulns` is in breach** (dependency advisories). That is security, and
    unchanged here.

Each test and probe was shown to fail by breaking the code on purpose:

| Deliberate break | What turned red |
|---|---|
| the store loading with the schema alone | the load-contract test, and ADR 0007's damaged-log test |
| the store writing without the contract | the write-contract test |
| events remembered before they are written | the full-disk test and the read-only test |
| a failed write not cut back | the full-disk test |
| no line break added after a cut | the line-break test |
| a new log written in place | the failed-replace test |
| no lock | all four lock tests |
| a dead writer's lock not taken over | the stale-lock test and the restart-after-kill test |
| the collector rethrowing a pull's error | the failing-pull test |
| `main.ts` without signal handling | the SIGTERM test and the reset test |
| a repeat of the signal forcing the exit at once | the echo test |
| the server not releasing its log on close | the server-close test |
| the core's instant schema without the offset check | the hostile-input test and the core's offset test |
| `asOf` without the offset check | the hostile-input test |
| the store not clamping a clock that steps back | the clock-step test |
| a write acknowledged 50 ms before it is written | `kill-recovery` = 350 |
| no `fsync` | nothing: see the findings |
| the slow tests at vitest's 5 s default, seed 1 run by hand | 2 tests failing only when shuffled |

## Not decided here

- **A commit marker for multi-event writes.** It would make a webhook batch
  atomic across a crash.
- **Truncating a cut last line automatically.** ADR 0007 stands: the message
  says how to do it by hand.
- **Backups, replication and an availability target.**
- **Retrying a failed pull sooner than its next tick**, or backing off.

## Revisit when

- **The log moves to a database** (README, next steps): transactions replace
  the lock, the truncation and the rename, and the contract test then has a new
  store to hold to it.
- **More than one machine writes**: replace the pid lock with a lease the
  storage enforces.
- **A command writes more than one event**: a crash could then split it, so
  decide on the commit marker first.
- **A new place writes the log**: open it as a writer only where
  `SANCTIONED_WRITES` allows, and open everything else `readOnly`.
- **`k-start-week` nears its 3 s target**: `isCanonicalInstant` can check the
  fields of an already well-spelled instant instead of a round trip through
  `Date`. That would save about 0.3 s on a week of signals.
