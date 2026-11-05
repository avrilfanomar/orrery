# ADR 0009 — Safety: no one acts on a green it hasn't earned, and nothing it does destroys the record

**Status:** Accepted (PoC) · **Date:** 2026-11-05 · **Builds on:**
[ADR 0001](0001-one-graph-append-only-evolution.md),
[ADR 0002](0002-metrics-bind-to-configured-sources.md),
[ADR 0003](0003-the-repository-measures-itself.md),
[ADR 0005](0005-flexibility-is-tested-as-promises.md),
[ADR 0007](0007-operability-what-whoever-runs-it-can-rely-on.md),
[ADR 0008](0008-reliability-what-it-acknowledged-survives.md) ·
**Amends:** ADR 0001, decision 3 (the critical veto)

## Context

The arc42 quality model tags fourteen qualities `#safe` beyond the reliable
ones: bias mitigation, certifiability, compliance (and its alias, standard
compliance), fail safe, failure transparency, fairness, fault isolation,
hazard warning, operational constraint, patient safety, provability, risk
identification, safe integration and safety itself.

ADR 0008 left most of them out, because "nothing it does can harm a person or
a machine". That was wrong for this product. It is a console people make
decisions on. Because it said green, a release ships, an incident is not
escalated, a target is relaxed. The harm comes through those decisions, and it
starts in one of two places:
- a status that isn't true, or a picture that is no longer current;
- an operation that destroys the record a status was built from.

**Risk identification.** The hazards below were each reproduced before they
were fixed.

| # | Hazard | What a person would have seen |
|---|---|---|
| H1 | **A critical breach could be outvoted.** ADR 0001 gave the critical veto to `weighted` only. Under `quorum`, a critical input in breach counted as one vote among the rest. The dogfood's own quorum goal, *Changing it stays safe and cheap*, holds a critical constraint (`packages/core` stays pure), so three healthy siblings would have outvoted its breach | A green goal over a broken constraint someone had marked critical |
| H2 | **Some rules could never read breach.** The schema accepted `warnAt: 0` and `warnShare: 0`. Every score and every share meets 0, so with every input in breach the rule read warning. A weighted rule whose on-target score was also 0 read **on target** | A goal that cannot turn red, whatever happens below it |
| H3 | **`rollup` judged "no inputs" as a pass.** With no inputs, worst-of read on target and quorum read warning or breach. `evaluateUniverse` never asks this, because it reports a node without inputs as an unrefined stub, but `rollup` is exported | A green from nothing, for any future caller |
| H4 | **A console that stopped updating still looked live.** React Query keeps the last answer when a refresh fails, and the error splash shows only when there is no data. When the server stopped, the last picture stayed up under the "Live" label. `fetch` has no timeout, so a server that accepts the request and never answers never even raised an error | Yesterday's green, presented as now |
| H5 | **`pnpm reset` destroyed the log.** It replaced the log and kept no copy. A reset typed in the wrong terminal, or with the wrong `ORRERY_DATA_FILE`, wiped the record for good. It is the one command in the repository that throws history away | A universe whose past is gone, with no way back |
| H6 | **Made-up readings could enter a real universe.** The simulator fed any universe holding a node with one of the demo's ids, and `k-p95` is a name anyone might pick. Its readings carry the names of real systems (`prometheus`, `ci`) | Invented numbers, indistinguishable from measurements |
| H7 | **The demo described its own rule wrongly.** *Customers find and buy…* said "a critical breach anywhere below still turns it red". The veto only looks at direct inputs | A guarantee the code does not give |
| H8 | **Two guards had no test.** Nothing tested the cycle guard in `evaluateUniverse`, and nothing tested that `latestReadingAt` ignores readings taken after the moment asked about. The log contract checks events, not the graph, so a hand-edited log can still hold a cycle. Breaking either guard turned no test red. The mutation probe below found both | Nodes that feed each other reading green, once the guard rots |

Already in place, and not news here:
- unknown never rolls up as green (invariant 3);
- a stale reading reads unknown, with its age;
- a new unit, direction or query makes the latest reading unknown, not green;
- a source answer that is not exactly one finite number records nothing
  (ADR 0002);
- only the collector may claim pulled provenance;
- time travel shows a banner;
- every change carries its reason (`s-audit`, ADR 0007).

## Decision

### 1. Every rule keeps the same promises

`rollup` is split into one function per rule (`worstOf`, `weightedOf`,
`quorumOf`), and every rule now keeps these promises:

| Promise | What changed |
|---|---|
| No inputs reads unknown, not a pass | `rollup` answers "Nothing to roll up — it has no inputs" before it applies any rule (H3) |
| A critical input in breach is a breach of its parent | `quorum` gains the veto `weighted` already had, with the same wording: "…which overrides the quorum" (H1) |
| A green stays green however its unknown inputs turn out | That was already true. The veto added one case: a quorum that is met while a critical input is unmeasured now reads unknown, "a critical input is unmeasured and could still veto it". The property check below found this case when the veto was first written |
| An input reading worse never makes the result read better | Already true. Now it is checked |
| A rule a caller can set can read breach | A command whose `warnAt` or `warnShare` is 0 is refused with a 400: "With a warning threshold of 0 it could never read breach…" (H2). The stored-event schema still accepts 0, so a log that holds one keeps loading (ADR 0005) |

`warnAt ≤ okAt` already held, so refusing a `warnAt` of 0 also refuses an
`okAt` of 0. The console's rule form now starts every threshold at 1%, and its
quorum option says that critical breaches still veto.

**This amends ADR 0001, decision 3.** The critical veto applies under every
rule, not only `weighted`. ADR 0001's text stays as it was written; this ADR
supersedes that line. The veto still applies to **direct** inputs only.
Priority says how much a node matters to its parent. A critical KPI under a
`high` requirement reaches the goal through that requirement's status, by the
requirement's own priority. The demo's description now says "a critical input
in breach still turns it red" (H7).

**Nothing in the past changes.** Rules are data, but how a rule combines its
inputs is code, so a change to that code could have changed what time travel
shows. The old and new code were compared on every log at hand: the
maintainer's demo log (14,581 events), the dogfood log, both frozen fixtures,
and fresh demo and dogfood seeds. For each log the comparison covered every
node, at every event and every hour, 263,758 statuses in all, and 0 differ. No
quorum node has ever had a critical input in breach, or unmeasured while the
quorum was met. No stored rule uses a 0 threshold.

### 2. The console says when it has stopped being live

The web app tracks whether its live view is still current.
- **When it warns.** After a refresh fails (following React Query's one
  retry), or once a refresh has been unanswered for 10 s.
- **What it shows.** An alert names the time of the last answer: "Not live.
  The server has not answered since … Every status here is what it reported
  then, and may no longer hold." The time-travel label reads "Not live"
  instead of "Live", and the statuses fade toward grey, so nobody reads them as
  current.
- **When it clears.** As soon as answers return.
- **A hidden tab.** It pauses refreshes and is not flagged. Refocusing the tab
  refreshes it at once.

### 3. Nothing it does destroys the record

- **`pnpm reset` keeps the log it replaces**, beside it, as
  `<log>.<instant>.bak`. It prints the path and how to undo.
- **The store makes the copy** (`replaceAll(events, keep)`), since only the
  store writes a log. It hard-links the old file before renaming the new one
  over it, so the copy costs nothing and no moment exists without a log. Where
  the file system has no hard links, it copies the file and flushes the copy.
- **It never writes over an earlier copy**, and an empty or missing log keeps
  nothing.
- `.gitignore` covers `data/*.bak`.

### 4. Made-up readings stay in the demo

The simulator feeds a universe only when its top level is exactly the demo's
product (`DEMO_PRODUCT`, `larch-store`; `simulatorRefusal` in `demo.ts`).
Anywhere else it says why and feeds nothing. It stays running, because
`pnpm dev` runs it under `concurrently -k`, which would stop the server and the
UI with it.

### 5. The suite pins what must always hold

| `describe` | File | What it pins | Scenario |
|---|---|---|---|
| rollup rules, checked over every input | `packages/core/test/safety.test.ts` | Covers every multiset of up to four inputs, each status at each priority (4,845 in all), under 30 rules, including the edges 0 and 1. No inputs reads unknown. A green holds through every way its unknown inputs could turn out. A worse input never reads better. A critical breach reads breach. Under every rule a caller can set, all-on-target reads on target and all-in-breach reads breach. The rules refused are exactly those that could never read breach | `s-rules-proven` |
| evidence it does not have never reads green | `packages/core/test/safety.test.ts` | A cycle in a hand-edited log that passes the log contract reads unknown. A moment is judged by the readings taken by then, even when the universe holds later ones | `s-rules-proven` |
| a reset keeps what it replaced | `apps/server/test/safety.test.ts` | The real reset script keeps the old log byte for byte, under a name for the moment, and prints how to undo. A missing log keeps nothing, and an existing copy is never written over | `s-reset-keeps` |
| the simulator feeds only the demo | `apps/server/test/safety.test.ts` | The refusal names the universe's top level. The real simulator, started against a universe that shares the demo's `k-p95` but is not the demo, writes nothing | `s-sim-demo-only` |

The check over every input runs in about 1.1 s. It proves the promises only for
up to four inputs and for the thresholds in its grid. The rules count statuses
and weights, so nothing in them changes at a fifth input; but that is an
argument, not a proof.

The not-live warning is checked in the browser. `apps/web/e2e/smoke.mjs`
blocks `/api/universe` three ways in turn: it refuses the requests, restores
them, then holds them unanswered. After each, it expects "Not live", then
"Live" again, then "Not live". These steps run after the check for console
errors, because the blocked requests log errors of their own. `ui-smoke` is
now version 2.

### 6. The dogfood measures what the suite cannot

| Probe | Node | Baseline | Target / warning |
|---|---|---|---|
| `false-green-mutants` | Deliberate false-green breaks of the core that no test catches | 0 of 15 (2 of 15 before the H8 tests) | 0 / 0 |
| `ui-smoke@2` | *The evolution loop works in a real browser* | pass, 10 steps | pass |

`false-green-mutants` copies `packages/core` into a temp directory. It never
breaks the checkout, which an interrupted run would leave broken. It then
applies, one at a time, each of fifteen breaks that would show someone a status
nobody earned:
- unknown ranks below on target;
- never measured reads on target;
- stale reads fresh;
- an incomparable reading is judged anyway;
- a warning reads on target;
- history is judged by today's target;
- a past moment sees later readings;
- no inputs passes;
- weighted ignores unknown inputs;
- quorum counts unknown inputs as on target;
- the critical veto is gone;
- an unmeasured critical input is ignored;
- a stub reads on target;
- a cycle reads on target;
- a rule that can never read breach is accepted.

After each break it runs the core's tests. The value is the number of breaks no
test catches. A break counts as caught only when a test case fails. A
replacement that leaves code that does not load gives no reading, because
otherwise it would read as a catch: a false green in the very probe that looks
for them.
- **Why it is a probe.** The suite cannot ask whether the suite would notice:
  that takes fifteen runs of it.
- **Why the list cannot rot.** `dogfood.test.ts` checks that every break still
  applies to the code exactly once, so a refactor cannot retire one quietly.

### 7. The model

**A new goal: *No one acts on a green it hasn't earned, and nothing it does
destroys the record*** (`g-harmless`). `g-safe` stays the security goal's id,
since ids are permanent in the log. Like the reliability goal, it rolls up
worst-of, so one hazard shows.

| Requirement | Inputs |
|---|---|
| A green is earned under every rule, and evidence it lacks never reads green | `s-rules-proven`, `k-false-green-mutants`; *Unknown never rolls up as green* (`r-unknown`), linked. That invariant stays under *The model tells the truth* |
| A console that has stopped updating says so | `s-smoke`, linked |
| Nothing it does destroys the record | `s-reset-keeps` |
| Made-up readings never pass for real ones | `s-sim-demo-only` |

### 8. Where each `#safe` quality is covered

| Quality | Covered by |
|---|---|
| Fail safe | §1; invariant 3 (`s-unknown`); a failed write changes nothing (`s-failed-write`, ADR 0008) |
| Provability | §1, checked over a bounded domain; `k-false-green-mutants` |
| Hazard warning | §2; the time-travel banner; a stale reading reads unknown with its age |
| Risk identification | The hazard table above. H1 to H6 and H8 each have a test and a model node. H7 was wording, now corrected |
| Safe integration | §4. A source answer that is not exactly one finite number records nothing, and pulled provenance belongs to the collector (ADR 0002) |
| Operational constraint | §4; settings refused at start (ADR 0007); loopback-only with sources configured (ADR 0002); one writer per log (ADR 0008) |
| Failure transparency | §2; statuses and refusals that explain themselves (`s-explained`, ADR 0006); visible failures (`s-visible`, ADR 0007); the `internal` pull category (ADR 0008) |
| Fault isolation | `s-contained` (ADR 0008) |
| Compliance, standard compliance | The licences of what it ships (ADR 0007); the arc42 model cited, not vendored (ADR 0001) |
| Certifiability | Nothing is certified. The nearest thing is traceability: each hazard but H7 leads to a test, a scenario and a status |
| Safety | The goal as a whole |

Not applicable:
- **Bias mitigation and fairness.** There is no learned model, and nothing
  ranks people. The author of a change is recorded but never weighed: a
  reading counts the same whoever sent it.
- **Patient safety.** No patients.

## Consequences

- **Behaviour changes:**
  - Under `quorum`, a critical input in breach reads breach. A quorum met while
    a critical input is unmeasured reads unknown.
  - A command that sets a 0 warning threshold is a 400.
  - The console warns when it is not live.
  - `pnpm reset` leaves a `.bak` file per reset. Nothing prunes them.
  - The simulator refuses any universe but the demo.
- **No status in the past changes.** The comparison above showed none.
- **The cost:**
  - the core suite gains nine tests and the server suite five, four in
    `safety.test.ts` and one in `dogfood.test.ts`. `pnpm verify` stays at
    about 30 s;
  - the browser smoke test takes about 29 s, up from 1.9 s. It waits out real
    refreshes: one that fails, one that comes back, and one that hangs past the
    10 s mark. A fake clock would make it quicker, and would no longer test the
    clock the warning runs on;
  - a dogfood run gains 31 to 39 s for `false-green-mutants`, depending on what
    else holds the CPU. Its three copies run side by side; one at a time they
    took 45 s;
  - `model.ts` grows to 480 lines. `k-largest` stays in warning (target 400,
    warning 600).
- **Functions over cognitive complexity 15 go from 17 to 16.** `rollup` (34)
  is split per rule. `App` would have grown from 23 to 26 with the warning, so
  its banners move into a `Banners` component, and it stays at 23.
- **Fixed on the way: ADR 0008's clock reads.** `stopOnSignals` added two
  `performance.now()` reads to `server.ts` but not to `SANCTIONED_CLOCKS`, so
  `k-hidden-inputs` would have read 2 at the next run. They time a repeated
  stop signal at the entry point, which is what the allowlist is for:
  `server.ts` now has 3, and `hidden-inputs` is version 2.
- **Findings, not fixed here:**
  - **A server clock that runs behind makes stale readings look fresh.**
    Staleness is measured on the server's clock, and nothing checks that clock
    against another. A clock that runs ahead errs safe: things read stale.
  - **A query in the wrong unit reads in that unit.** A ratio bound to a
    percentage KPI reads a hundred times too good. Nothing can check that in
    general.
  - **Moving the yardstick turns a status green.** Deprecating a node in breach,
    or relaxing its target, needs a reason, and the change feed shows the
    change. But nothing marks that a change, rather than the system, turned a
    status green (README, next steps: impact preview).
  - **The web app has no unit tests**, so the not-live warning is held only by
    the browser smoke test. That test needs a browser, so it runs in the
    dogfood rather than in `pnpm verify`.
  - **`k-vulns` is in breach** (dependency advisories). That is security, and
    unchanged here.

Each test and probe was shown to fail by breaking the code on purpose:

| Deliberate break | What turned red |
|---|---|
| the old `rollup` and schema, under the new tests | 4 of the 7 checks over every input: no inputs, the critical breach, and the two on rules a caller can set. The two H8 tests pass on the old code: they pin guards that existed but were untested |
| the quorum veto without the unmeasured-critical case | "keeps a green however its unknown inputs turn out" |
| quorum without the veto | "reads breach when a critical input is in breach" |
| callers allowed a 0 warning threshold | the two checks on rules a caller can set |
| the fifteen false-green breaks | each caught by the core's tests (`false-green-mutants` = 0); before the two H8 tests, the cycle and the reading horizon survived |
| reset without keeping the old log | the reset test |
| the store writing over an existing copy (both guards removed) | the keep-nothing test. Removing only the `EEXIST` rethrow is not a break: the copy fallback refuses to write over an existing file too |
| the simulator without its guard | the simulator test |
| a break that no longer applies to the code | `dogfood.test.ts` |
| a break whose replacement does not parse | `false-green-mutants` gives no reading, rather than counting a catch |
| the console without the warning | the smoke test's first not-live step |
| the console not noticing a hung refresh | the smoke test's hung step |

## Not decided here

- **Marking a status flip caused by a change rather than a reading.** The
  impact preview in the README's next steps would show it before publishing;
  the change feed could show it after.
- **Pruning the copies `reset` keeps.**
- **Checking the server's clock** against an outside source.
- **A deep veto**: a critical node anywhere below vetoing every ancestor. It
  would turn the whole product red for any critical breach, and override the
  priorities set in between.

## Revisit when

- **A rollup strategy is added or changed**: put it in the grid in
  `packages/core/test/safety.test.ts`. It must keep every promise there.
- **Another command replaces or removes a log**, a compaction for instance: it
  keeps what it replaces.
- **Another source of made-up data appears** (an importer of examples, a load
  generator): it feeds only the demo.
- **The web app gets unit tests**: pin the not-live rule in one, and keep the
  browser step.
- **There are users and owners**: warn the owner when a node goes stale or not
  live, not only whoever has the console open (README, next steps: alerting).
