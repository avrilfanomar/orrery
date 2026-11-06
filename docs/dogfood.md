# The repository measures itself

The platform's own requirements form a second universe, kept apart from the
demo ([ADR 0003](adr/0003-the-repository-measures-itself.adoc)). Its definitions
are code, in [`apps/server/src/dogfood/model.ts`](../apps/server/src/dogfood/model.ts).
Its readings come from versioned probes in
[`probes.ts`](../apps/server/src/dogfood/probes.ts).

```bash
pnpm dogfood          # sync the model, measure, record, print the tree (~3 min)
pnpm dogfood:serve    # the dogfood universe in the console on :4711
```

`--dry-run` plans and measures without writing. `--only k-bundle,s-smoke`
measures a subset.

## The eleven goals

| Goal | What it covers |
|---|---|
| *The model tells the truth* | the CLAUDE.md invariants: the log contract on load, writes only through `decide`, unknown never green, readings judged by the definition in force |
| *Changing it stays safe and cheap* | core purity, type errors, module size, verification time, the core's test coverage |
| *Its code stays easy to read, test and update* | complex functions, import cycles, copied blocks, hidden clocks, dependencies a major behind, references and tags that point at nothing; and, pinned by the suite, statuses and refusals that explain themselves, answers that ignore the system clock, dependencies declared and locked |
| *The console stays fast and frugal at realistic scale* | after a week of live signals: view, write and restart time, heap and response size; the UI bundle; and, pinned by the suite, how cost scales, the batch limit and a fixed benchmark workload |
| *It adapts, connects and outlasts its own versions* | frozen logs that must keep loading, the same answers in any time zone, two universes side by side, the README's API and settings as contracts, component seams, theme tokens |
| *Whoever runs it can install, start, watch and recover it* | a fresh clone that installs, builds and serves, settings read only where they are checked, licences of what it ships; and, pinned by the suite, startup refusals that name what to fix, health and failures an operator can see, recovery after a restart or a source outage, an audit trail, docs that name real commands |
| *What it acknowledges survives, and a fault stays where it happens* | acknowledged readings lost when a real server is killed mid-write, tests that fail only in a shuffled order; and, pinned by the suite, a failed write that changes nothing, one writer per log, faults that fail one request or one binding, a clean stop and a start after a kill |
| *No one acts on a green it hasn't earned, and nothing it does destroys the record* | breaks of the core that would show a green nobody earned and that no test catches; the console saying when it has stopped being live; and, pinned by the suite, rollup rules checked over every input, a reset that keeps the log it replaced, a simulator that feeds only the demo |
| *Running it exposes nothing it shouldn't* | dependency advisories, anything shaped like a credential in the git history; and, pinned by the suite, source and pull guards, no source token leaving the server, no web page acting through the operator's browser, the ingest token on every route a reading takes, refusals that leave a trace, oversized requests refused at their limit |
| *Everyone can read, operate and follow it end to end* | accessibility checks in a real browser, in both schemes, the browser smoke test against the real server, doc links; and, pinned by the suite, text that reads at 4.5:1 on every surface |
| *It does what the README says it does* | breaks of the core that would leave a need in *The idea* unmet and that no test catches; and, pinned by the suite, the backlog, the breadcrumb, the ribbon, the past, the reasons and the signal as described there, and the demo story |

One stub, identity, stays *unknown* until there is something to measure. It
keeps the top level from reading green until it is refined.

## How a measurement is kept consistent

- **Every measured node is bound to `probe` `<id>@<version>`.** To change a
  method, bump the version and give a `since` reason. The node is redefined,
  and older readings keep their old yardstick.
- **One run is one snapshot**, with a single `observedAt` and the source
  `probe:<env>@<sha>`.
- **Only committed code is recorded.** On a dirty tree the run measures but
  writes nothing, unless you pass `--allow-dirty`.
- **A probe that cannot measure records nothing.** That covers no network for
  `pnpm audit` and no browser for the smoke test or the accessibility scan.
  The node goes stale and reads unknown, never green.
- **Benchmarks use a fixed workload** (seed 7, fixed date): warm-up runs, then
  the median. Compare timings within one `ORRERY_PROBE_ENV` only. The workload's
  size is pinned. If an edit to the demo changes it, the tests ask for a new
  version of every probe that uses it.

## How each quality is tested

Each quality has an ADR. Broadly, the suite pins *shape* (what must always
hold, without a clock), and probes measure *size* on this machine.

- **Efficiency is tested twice** ([ADR 0004](adr/0004-efficiency-shape-in-the-suite-size-in-the-dogfood.adoc)).
  The suite pins how cost scales (reads of the log per request, answer size,
  the batch limit) without a clock. The probes measure how big each cost is.
- **Flexibility is tested as promises** ([ADR 0005](adr/0005-flexibility-is-tested-as-promises.adoc)).
  The suite holds the repository to what it claims: old logs load, time zones
  don't matter, the README's API is the API. Static probes count undocumented
  settings, imports across component seams and colours outside the theme.
- **Maintainability: structure is counted, diagnosis is pinned** ([ADR 0006](adr/0006-maintainability-structure-counted-diagnosis-pinned.adoc)).
  The suite checks that every status leads to its cause and every refusal
  names what is wrong, that no answer depends on the system clock, and that
  every package declares and locks what it imports. Probes count functions
  over cognitive complexity 15, import cycles, copied blocks and clock reads
  outside the composition roots. They also measure the core's test coverage
  and how many dependencies are a major version behind.
- **Operability: what whoever runs it can rely on** ([ADR 0007](adr/0007-operability-what-whoever-runs-it-can-rely-on.adoc)).
  The suite checks that a bad setting or a damaged log stops the server at
  start and names what to fix, that health and internal errors leave a trail,
  that a restart or a source outage heals by itself, that every change says
  who, when and why, and that the docs name commands that exist. Probes
  install, build and serve a fresh clone, count settings read past their
  checks, and check the licences of what it ships.
- **Reliability: what it acknowledged survives** ([ADR 0008](adr/0008-reliability-what-it-acknowledged-survives.adoc)).
  The suite checks that the store writes only what it would load, that a write
  the disk refuses changes nothing, that one process writes a log, that
  hostile input, a failing pull or a hanging source fails only itself, and
  that the server stops cleanly and starts again after a kill. Probes kill a
  real server in the middle of writes and count what it lost, and run the
  suite in a shuffled order.
- **Safety: no one acts on a green it hasn't earned** ([ADR 0009](adr/0009-safety-no-one-acts-on-a-green-it-has-not-earned.adoc)).
  The suite checks every rollup rule over every set of up to four inputs. No
  inputs reads unknown. A green holds however its unknown inputs turn out. A
  worse input never reads better. A critical breach is a breach under every
  rule. A rule that could never read breach is refused. The suite also checks
  that a reset keeps the log it replaced, and that the simulator feeds only
  the demo. The browser smoke test blocks the API and expects the console to
  say it is not live. A probe breaks the core on purpose in fifteen ways that
  would show a false green, and counts the breaks no test catches.
- **Security: the browser is the way in** ([ADR 0010](adr/0010-security-the-browser-is-the-way-in.adoc)).
  The suite checks that the server answers only to names nobody else's DNS can
  point at it, takes no write from another origin, and forbids framing and
  foreign code. It also checks that a reading needs the ingest token by either
  route, that every refusal is logged without the credentials offered, that a
  source's token never leaves the server whatever the source sends back, and
  that an oversized request is refused at its limit. Probes count advisories
  in the dependencies and anything shaped like a credential in the whole git
  history.
- **Usability: everyone can read and operate it** ([ADR 0011](adr/0011-usability-everyone-can-read-and-operate-it.adoc)).
  The suite checks that every text colour reads at 4.5:1 on every surface, in
  both schemes. A probe runs axe-core on eight views of the real console,
  light and dark, and checks focus rings and reflow at 320 px, counting the
  checks that fail.
- **Suitability: it does what the README says** ([ADR 0012](adr/0012-suitability-it-does-what-the-readme-says.adoc)).
  The suite checks that the backlog lists every gap and agrees with coverage,
  that the breadcrumb climbs every primary parent, that the ribbon ends at the
  moment shown, that the past holds nothing from after it, that reasons name
  their thresholds, that the signal leads to the breach, and that a late
  reading lands in place. A probe breaks the core on purpose in twenty-one
  ways, each leaving a need in *The idea* unmet, and counts the breaks no test
  catches.

## Changing the model

**To change the model**, edit `model.ts` and commit. `pnpm dogfood` turns the
difference into reasoned commands. The reason is `--reason "…"`, or the model's
last commit subject. Creations and wording changes need no reason.

**`model.ts` wins.** An edit made in the dogfood console is drift, which the
next run would revert. That run refuses to use an older commit subject to
explain the revert. Either carry the edit into `model.ts`, or pass `--reason`.

## What the first run found

The first run (2026-11-04) found three real problems, none of which the tests
had noticed ([ADR 0003](adr/0003-the-repository-measures-itself.adoc)):

- the store loads logs that break the contract (fixed in ADR 0008);
- dependencies have critical advisories;
- one module is over the size target.
