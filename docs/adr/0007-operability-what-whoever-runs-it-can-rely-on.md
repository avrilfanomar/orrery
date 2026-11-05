# ADR 0007 — Operability: what whoever runs it can rely on

**Status:** Accepted (PoC) · **Date:** 2026-11-04 · **Builds on:**
[ADR 0001](0001-one-graph-append-only-evolution.md),
[ADR 0002](0002-metrics-bind-to-configured-sources.md),
[ADR 0003](0003-the-repository-measures-itself.md),
[ADR 0005](0005-flexibility-is-tested-as-promises.md),
[ADR 0006](0006-maintainability-structure-counted-diagnosis-pinned.md)

## Context

The arc42 quality model tags about forty-five qualities `#operable`. Some were
already covered:

- Debuggability, updateability and upgradeability: ADR 0006.
- Portability, integrability, interchangeability and replaceability: ADR 0005.
- Latency: ADR 0004. Restart time: `k-start-week`.
- Backward compatibility: `s-old-logs`.

About a third are also tagged `#usable`, such as learnability and ease of use.
They are left for a usability pass (see section 6).

That left what an operator meets: installing it, starting it, seeing whether
it is healthy, recovering it, and answering "who changed this?". Each problem
below was reproduced before it was fixed.

**Settings.** The server package read 15 environment variables, 18 times in 7
files, and each file parsed its own.
- An empty `HOST` bound every interface (`[::]`), so unauthenticated commands
  became reachable from the network. `pnpm reset` then asked
  `http://:4710/api/health` whether the server was running. That URL is
  invalid, so it read "not running" and would have deleted a live log.
- An empty `PORT` meant port 0, so the server listened on a random port. A
  malformed `PORT` failed with Fastify's message, which never names `PORT`.
- An empty `ORRERY_DATA_FILE` kept the log in memory. Every write was lost on
  restart, and nothing said so.
- An empty `ORRERY_WEB_DIST` served no UI.
- A malformed, zero or too-large `ORRERY_SIM_TICK_MS` made `setInterval` fire every
  millisecond: 74 ticks in 100 ms, each a webhook request.
- An `ORRERY_API` without `http://` left the simulator waiting forever, catching
  each failed fetch as "not up yet".
- The README's own `ORRERY_SOURCES_FILE=sources.json pnpm dev` looked for the file
  in `apps/server`, because pnpm runs a package's scripts in that package's
  directory.

**A log cut short by a crash** was refused with a bare `SyntaxError`, which
named neither the file nor the line.

**An internal error** was logged on the app's logger, without the request id.
The caller got no id to quote.

**Health** reported only a count of events.

**Recovery and audit.**
- The collector's catch-up (ADR 0002) was never tested after a failure.
- The schema requires a reason on every change of meaning. Nothing checked
  that the change feed reports each change, or that a past day's answers stay
  put when later writes land, including readings backdated before that day.

**Licences** were never checked.

**Installability.** ADR 0005 left it out because a frozen install needed the
registry. With the repository's own package store, an offline frozen install
works, and takes under a second.

## Decision

### 1. One settings module, one rule

[`apps/server/src/settings.ts`](../../apps/server/src/settings.ts) reads every
setting of the server, the simulator, `reset` and the dogfood. The rule:

- **An empty value means unset**, as `${VAR:-default}` does in a shell. The
  smoke harness already cleared `ORRERY_SOURCES_FILE` this way.
- **Anything else must parse.** Otherwise the process stops before it opens or
  serves anything, naming the variable and the value.
- **A relative path is read from where the command was typed.** pnpm passes
  that directory as `INIT_CWD`. Without it, the working directory is used.
- **Only the entry points read it, never at import time.** Tests pass in the
  environment they mean.

The checks:

| Setting | Must be |
|---|---|
| ports | 1–65535 |
| `ORRERY_SIM_TICK_MS` | 1 s to 1 day. `setInterval` turns anything outside 1 ms–24.8 days into 1 ms |
| URLs | http(s) |
| `ORRERY_ALLOW_REMOTE` | `1` or `0` |
| `NO_COLOR` | any value turns colour off, per no-color.org |

The web dev server and the smoke script cannot import the server's module,
because that would cross a seam (ADR 0005). They apply the empty rule inline.

### 2. Smaller fixes the contracts needed

- **The store.** A line that is not JSON is refused as
  `<file>:<line>: not a complete JSON event`. On the last line, the message
  adds: back up the file, then delete that line. The store does not delete it
  itself (invariant 1). The line was never acknowledged, but removing it is the
  operator's call.
- **Errors.** An internal error is logged with `req.log`, so the line carries
  `reqId`. The 500 answer carries the same `requestId` and no detail.
  `buildApp` accepts a log stream, so a test can read the log.
- **Health.** `/api/health` adds `lastEventAt`. An operator can then tell
  whether data is still arriving, not just whether the server is up.
- **Signatures.** `loadSources` takes the file, and `assertSafeToServe` takes
  `allowRemote`. `startServer` resolves to the app once it listens, so a test
  can start and stop it. `paths.ts` keeps only `repoRoot`.

### 3. The suite pins what must always hold

[`apps/server/test/operability.test.ts`](../../apps/server/test/operability.test.ts)
has one outermost `describe` per contract:

| `describe` | What it pins | Scenario |
|---|---|---|
| startup refusals explain themselves | 14 malformed values, each refused with the variable and the value. Every setting left empty or blank equals its default. A valid value for every setting takes effect, and the real server starts on its log, seed and ingest token. It refuses a non-loopback host with sources configured while `ORRERY_ALLOW_REMOTE` is `0`. A torn last line, a non-JSON line and a non-event line are refused naming the file and line. A missing or broken sources file is refused naming it. The real `main.ts` and `simulate.ts` exit non-zero, and the log file is never created. A completeness check: every `env.<NAME>` that `settings.ts` reads has a row | `s-startup-refusals` |
| failures are visible | Health reports the events held and when the last landed, and both move after a write. A request that fails inside the server gets 500 with an id and no internal text. The log holds the error and its stack under that id | `s-visible` |
| recovery | Four answers are byte-identical after a restart on the same log. A source goes down for two hours: nothing is recorded, `/api/sources` says `failing`, the node reads unknown, and the collector logs the change once. When it is back, every missed minute is recorded once, with no gap, and the recovery is logged | `s-recovery` |
| on the record | Both seeded universes, and every evolution command sent under a named author. Every event has an author and an exact instant. Every change of meaning, place or lifecycle has a reason, and the feed reports each change faithfully. A past day's universe, feed and node answers are identical after later writes, including a reading backdated before that day | `s-audit` |
| documented operations | Every `pnpm` command in the code of README.md and CLAUDE.md names a script that exists. `engines`, `.nvmrc`, the README and `@types/node` agree on the Node floor. A relative path is read from `INIT_CWD` | `s-documented-ops` |

### 4. The dogfood measures what the suite cannot

These probes are in
[`apps/server/src/dogfood/operability.ts`](../../apps/server/src/dogfood/operability.ts):

| Probe | Node | Baseline | Target / warning |
|---|---|---|---|
| `fresh-clone` | A fresh clone installs, builds and serves the console | pass, about 3 s | pass |
| `settings-unchecked` | Settings read outside `settings.ts` | 0, was 18 | 0 / 0 |
| `licences-unapproved` | Shipped dependencies under a licence not approved | 0 of 90 | 0 / 0 |

**`fresh-clone`** clones HEAD into a temp dir. It then installs with
`--frozen-lockfile --offline` from the repository's own store. pnpm keeps one
store per filesystem, so a clone in the temp dir would otherwise look in an
empty one. It builds the UI with the clone's own vite, starts the clone's
server with every other setting cleared, and checks health, the UI and the
seeded demo.
- **What it adds** over `s-dependencies` and the smoke test: it catches code
  that depends on something untracked, ignored or left in a working copy.
- **Pass or fail, not a timing.** A warm-store install measures linking, not
  installability, so the times go in the detail only.
- **A store missing a locked package records nothing**, as `audit-high` does
  when offline.

**`settings-unchecked`** reuses the variable scanner of `config-undocumented`.
Its scope is `apps/server/src`, since the web code cannot use the module. It
needs no allowlist: the only place allowed is `settings.ts`.

**`licences-unapproved`** counts what is shipped (`pnpm licenses list --prod`):
the server's runtime, and the UI bundle's dependencies, which `@orrery/web` lists
under `dependencies`.
- **Build and test tools are left out.** They are not redistributed. One of
  them, a platform binary rollup pulls in, declares no licence, so the full
  count would depend on the OS.
- **The allowlist** holds the permissive licences an Apache-2.0 project can
  ship with a notice: MIT, MIT-0, ISC, Apache-2.0, BSD-2-Clause, BSD-3-Clause,
  0BSD, BlueOak-1.0.0, CC0-1.0, Unlicense and CC-BY-4.0.
- **SPDX expressions:** `OR` is a choice and `AND` needs both. With
  parentheses, every licence named must be approved, which is never more
  permissive than the expression. `Unknown` counts.

### 5. The model gains a goal

The new goal, *Whoever runs it can install, start, watch and recover it*,
rolls up worst-of. Like the goals of ADR 0005 and 0006, it is a sibling of
the quorum goal, not under it.

| Requirement | Inputs |
|---|---|
| A fresh clone runs with the documented commands | `s-fresh-clone`, `s-documented-ops` |
| A bad setting or a damaged log stops it at start, naming what to fix | `s-startup-refusals`, `k-settings-unchecked` |
| From outside, an operator can tell it is up, what it holds and why a request failed | `s-visible` |
| It comes back by itself after a restart or a source outage | `s-recovery`; `k-start-week`, linked |
| Every change can be traced to who made it, when and why | `s-audit` |
| Everything it ships may be shipped under its licence | `k-licences` |

`k-start-week` stays under *A restart is back within seconds* and is also
linked here: the model's links exist for a node that evidences two parents.
Restart time is the nearest thing this PoC has to time to recover.

### 6. Where each `#operable` quality is covered

| Quality | Covered by |
|---|---|
| Installability, deployability | `s-fresh-clone` |
| Operational and environment requirements | `s-documented-ops` (the Node floor), `s-fresh-clone` |
| Diagnosability, controllability | `s-startup-refusals`, `k-settings-unchecked`; `s-explained` for refusals at run time (ADR 0006) |
| Observability | `s-visible`; `/api/sources` names a failing pull (ADR 0002, `s-sources`) |
| Autonomy, self-healing | `s-recovery` (collector catch-up) |
| Mean time to recovery | `k-start-week`, linked under `r-recovers` |
| Auditability, traceability | `s-audit`; every dogfood reading's source names its commit (ADR 0003) |
| Legal requirements | `k-licences` |
| Governability, policy enforcement | `c-gate`, `k-gate-writes`; in the dogfood, `model.ts` wins over console edits (ADR 0003) |
| Drift detectability | The dogfood refuses to revert a console edit under an unrelated commit subject (ADR 0003). `s-dependencies` checks lockfile against manifests, `k-config-undocumented` checks settings against the README, and the frozen fixtures are pinned by hash (ADR 0005) |
| Backward compatibility, legacy support, compatibility | `s-old-logs` (ADR 0005) |
| Interoperability, integrability | `s-api-contract` (ADR 0005) |
| Portability, replaceability, interchangeability | ADR 0005 |
| Debuggability, updateability, upgradeability | ADR 0006 |
| Latency, cycle time of a request | ADR 0004 |
| Operability | The goal as a whole |

Left out on purpose:

- **DORA metrics, MTBF and cycle time** (deployment frequency, lead time for
  changes, change failure rate). Nothing here is deployed and no incident is
  recorded, and commits go straight to `main`. A proxy built from git history
  would measure commit habits, not operations. Once the probes run on every
  merge, the dogfood log will hold test pass rate and type errors per commit.
  Change failure rate and time to restore could then be read from it, by the
  product itself.
- **Redundancy.** One process by design (ADR 0001).
- **Releasability.** No release process exists. HEAD that passes
  `pnpm verify` and `s-fresh-clone` is as releasable as it gets.
- **Expected physical environment, self-configuring, self-optimizing,
  self-protecting.** A laptop or one server, and nothing that tunes itself.
  `assertSafeToServe` is the one self-protecting rule (ADR 0002).
- **The `#usable` half:** appropriateness recognizability, ease of use,
  interaction capability, learnability, understandability, user error
  protection and usability. Today they are covered only by *People can follow
  it end to end* and `s-explained`. They belong to a usability pass.

## Consequences

- **Operators see different behaviour.**
  - An empty `HOST`, `PORT`, `ORRERY_DATA_FILE` or `ORRERY_WEB_DIST` now takes its
    default instead of being misread.
  - Values that used to start now stop the process, naming the variable.
    Examples: `ORRERY_ALLOW_REMOTE=true`, which was silently ignored;
    `ORRERY_SIM_TICK_MS=500`; a schemeless `ORRERY_API`.
  - `ORRERY_DATA_FILE=x.jsonl pnpm dev` used to write `apps/server/x.jsonl`. It now
    writes `x.jsonl` in the directory the command was typed in.
- **The API gains two fields:** `lastEventAt` on `/api/health`, and
  `requestId` on a 500.
- **The cost:**
  - the server suite runs about 2.5 s longer. Most of it is starting the two
    real entry points, about 0.8 s alone and up to 2 s under `pnpm verify`'s
    parallel load;
  - a dogfood run is about 3 s longer: the fresh clone takes about 2.7 s, the
    licences 30 ms.
- **Each rewired entry point was run on its success path**, against temp logs
  and spare ports:
  - a server started with an empty `HOST` bound 127.0.0.1;
  - `pnpm reset`, also with an empty `HOST`, refused next to it ("The server is
    running"), and the log kept all its lines;
  - the simulator at a 1 s tick moved `events` and `lastEventAt`;
  - `dogfood:serve` seeded its own log and answered.
- **The fresh-clone probe caught the committed code.** In the dry run before
  this commit, it cloned HEAD, which predates the settings module. The clone's
  server read the cleared `ORRERY_WEB_DIST=''` as "no UI", and the probe failed
  with "the server answers, but does not serve the built UI". That is one of
  the bugs in Context.
- **Findings, not fixed here:**
  - **The default author is "you".** A request without `x-actor` is attributed
    to "you", so the audit trail is only as good as the header. Identity stays
    the open stub (`r-identity`).
  - **The store does not fsync.** `appendFileSync` returns once the OS has the
    bytes, so a crash or power loss can cut the last line. That is why the
    refusal now explains what to do.
  - **There are no access logs and no metrics endpoint.** The server logs only
    warnings and errors. The product reads Prometheus but exposes nothing for
    it to scrape.
  - **The ADR 0003 finding stands:** the store still loads logs that break the
    contract, and `s-log-load` is in breach. Fixing it would change the root's
    status, so it is its own decision.

Each test and probe was shown to fail by breaking the code on purpose:

| Deliberate break | What turned red |
|---|---|
| an empty setting read as given | the empty-setting test |
| `JSON.parse` in the store without the wrapper | the damaged-log test |
| `ORRERY_SIM_TICK_MS` read with `Number()` | its three refusal cases, the empty-setting test and the entry-point test |
| `main.ts` reading `PORT` itself | the entry-point test |
| `ORRERY_ALLOW_REMOTE=0` read as allowed | the valid-values test and the server test |
| `ORRERY_INGEST_TOKEN` dropped by the settings | the valid-values test and the server test |
| the token not passed from `startServer` to the app | the server test |
| the error logged on the app logger | the internal-error test |
| the 500 without `requestId` | the internal-error test |
| health without `lastEventAt` | the health test |
| collector catch-up capped at one hour | the outage test |
| the change feed ignoring `asOf` | the past-day test |
| the feed dropping a reprioritization's reason | both audit tests over the logs |
| a script renamed in `package.json` | the commands test |
| `.nvmrc` moved to 22 | the Node-floor test |
| relative paths read from the working directory | the relative-path test |
| `server.ts` reading `ORRERY_SOURCES_FILE` itself | `settings-unchecked` = 1 |
| `BlueOak-1.0.0` dropped from the allowlist | `licences-unapproved` = 8 |
| HEAD before this commit, cloned | `fresh-clone` = 0 |

## Not decided here

- **Truncating a torn last line automatically.** The refusal says how to do it
  by hand.
- **Access logs, a metrics endpoint, readiness as distinct from liveness.**
- **An online `fresh-clone` in CI**, which would also check that the registry
  still serves every locked version.

## Revisit when

- **The probes run on every merge:** read change failure rate and time to
  restore from the dogfood log.
- **Identity exists:** require authors, and refine `r-identity`.
- **A setting or an entry point is added:** read it in `settings.ts`, and add
  its row to `SETTINGS` in the test.
- **The Node floor moves:** move `engines`, `.nvmrc`, the README and
  `@types/node` together.
- **pnpm changes how its store works offline:** `fresh-clone` may start to
  skip.
