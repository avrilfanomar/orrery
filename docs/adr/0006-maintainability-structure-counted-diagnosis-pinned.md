# ADR 0006 — Maintainability: structure is counted, diagnosis is pinned

**Status:** Accepted (PoC) · **Date:** 2026-11-04 · **Builds on:**
[ADR 0001](0001-one-graph-append-only-evolution.md),
[ADR 0003](0003-the-repository-measures-itself.md),
[ADR 0004](0004-efficiency-shape-in-the-suite-size-in-the-dogfood.md),
[ADR 0005](0005-flexibility-is-tested-as-promises.md)

## Context

The arc42 quality model tags about twenty qualities `#maintainable`. About half
of them were already measured:

- *Changing it stays safe and cheap* (ADR 0003) covers changeability: type
  errors, module size and verification time.
- ADR 0005 covers evolvability, longevity, extensibility, reusability and
  themability.

Five areas had no measure:

- **Analysability and debuggability.** The product exists to answer "why is
  this red?". `Evaluation.drivers` is documented as "the next step down the
  why path", and `signalPath` follows it. Tests checked that on hand-made
  examples. Nothing checked it across a whole universe, over time.
- **Testability.** `decide` takes `now` as an argument, and `buildApp` and the
  collector take an injectable clock. Nothing stopped a new
  `Date.now()` from creeping in.
- **Test coverage.** `r-coverage` was a stub, because `@vitest/coverage-v8`
  was not installed.
- **Modularity and loose coupling.** ADR 0005's seams cover component
  boundaries, not cycles or copied code inside a component.
- **Updateability and upgradeability.** Nothing checked that a package
  declares what it imports, that the lockfile matches the manifests, or how far
  the dependencies trail. The dogfood was about to import the TypeScript
  compiler from `apps/server`, which only the root declared.

## Decision

### 1. The suite pins what must always hold

[`apps/server/test/maintainability.test.ts`](../../apps/server/test/maintainability.test.ts)
has one outermost `describe` per contract:

| `describe` | What it pins | Scenario |
|---|---|---|
| statuses explain themselves | It walks every node of the demo on each of its 30 days, and the freshly seeded dogfood model. Each status has a reason. Its drivers are its own inputs and never on target. Following them (`signalPath`) ends at a node with its own measurement, or at a stub, and never at something on target. The walk must meet all four statuses | `s-explained` |
| refusals explain themselves | Nine bad requests, each answered with the HTTP status its code maps to and a message naming the node, field or rule at fault. The log is unchanged afterwards. The requests: an unknown node, an instant without a zone, an unknown command, a missing reason, a taken id, a move into its own subtree, an impossible pass/fail reading, one bad reading in a batch, a body that is not JSON | `s-explained` |
| no hidden inputs | The system clock goes to 1999 and then 2099, and `Math.random` returns 0.01 and then 0.99. Every answer must be byte-identical: both seeds, five read routes, a command and a reading. The test checks that the fake clock took, and compares answers by digest, so a failure names the answer that moved | `s-no-hidden-inputs` |
| declared dependencies | Every bare import in each workspace package is declared in that package's own manifest. That covers static, type-only and dynamic imports, and `.mjs` files. The lockfile's importers hold exactly the manifests' ranges, which is the offline half of a frozen install | `s-dependencies` |

`dogfood.test.ts` gains a verifiability check: every suite probe's
`describe` titles must exist in its test file. A rename now fails
`pnpm verify`. Before, it would have turned the node unknown at the next
dogfood run.

### 2. The dogfood counts what makes the code harder to keep

These probes are in [`apps/server/src/dogfood/maintainability.ts`](../../apps/server/src/dogfood/maintainability.ts):

| Probe | Node | Baseline | Target / warning |
|---|---|---|---|
| `complex-functions` | Functions above cognitive complexity 15 | 17 of 679 | 10 / 20 |
| `import-cycles` | Cycles among source modules at run time | 0 | 0 / 0 |
| `duplicated-lines` | Lines in a 6-line run that appears elsewhere | 0.84% | 3% / 5% |
| `hidden-inputs` | Clock and random reads outside the composition roots | 0 | 0 / 0 |
| `core-coverage` | Statements of `packages/core` its own tests execute | 92.69% | 90% / 80%, higher is better |
| `outdated-majors` | Direct dependencies a major version or more behind | 71.4%, 10 of 14 | 25% / 75% |

**`complex-functions` uses cognitive, not cyclomatic, complexity.**
- `decide` and `applyEvent` are reducers that switch over event types.
  Cyclomatic counting charges every `case` and gives `decide` 51. Cognitive
  counting charges the switch once, so complexity grows with nesting, not with
  the number of event types.
- The probe counts functions over 15, SonarSource's default limit, rather than
  taking the maximum. One reducer then cannot hide every other function.
- The rules follow SonarSource's definition with two deliberate differences,
  spelled out in the method:
  - each function is scored on its own, so a callback does not nest its
    parent;
  - `??` counts like `&&` and `||`.
- `dogfood.test.ts` pins the rules on code snippets. One of them is
  SonarSource's own example, which scores 7.

**`import-cycles` counts what loads at run time.** With
`verbatimModuleSyntax`, only `import type` and `export type` are erased, so
only those are left out. The dogfood probe modules import types from
`probes.ts` in a loop. That loop is not counted (see Findings).

**`hidden-inputs` has an allowlist**, `SANCTIONED_CLOCKS`, like
`k-gate-writes`. It allows:
- the default of each injectable clock (`app.ts`, the collector);
- the seeding roots (`server.ts`, `reset.ts`);
- the simulator, which plays live time.

The dogfood is out of scope, because it times things on purpose. The UI is
out of scope until it has unit tests to protect.

**`core-coverage` counts only core's own tests.** It runs vitest once more,
in `packages/core`, with the V8 provider and a `json-summary` report in a temp
dir. It does not add `--coverage` to the shared test run, because that would
change what `verify-seconds` measures. Server tests that happen to run core
code do not count.

**`outdated-majors` is a share, not a count.** A count would drift as
dependencies are added. On target means at most one in four dependencies is
behind. At three in four, upgrades have effectively stopped.
- `@types/*` are left out: they follow the Node and React versions the code
  targets.
- For 0.x versions, a minor counts as a major.
- New releases appear without a commit, so offline runs record nothing, as
  `audit-high` does.

### 3. The model gains a goal and refines a stub

The new goal, *Its code stays easy to read, test and update*, rolls up
worst-of. It is a sibling of *Changing it stays safe and cheap*, which rolls
up by quorum. Five green guards added there would outvote its one warning
(ADR 0005 made the same choice).

| Requirement | Inputs |
|---|---|
| Any function can be followed in one reading | `k-complex` |
| Dependencies point one way, and each piece of logic lives in one place | `k-cycles`, `k-duplication` |
| A status or a refusal leads straight to its cause | `s-explained` |
| Every part can be tested without faking the world | `s-no-hidden-inputs`, `k-hidden-inputs` |
| Its dependencies can be updated without surprises | `s-dependencies`, `k-outdated` |

`r-coverage` stays where it was, under the quorum goal, and gains its KPI
`k-core-coverage`. The 90% target and 80% warning come from common practice
for a domain core, not from where the quorum would land.

### 4. Where each `#maintainable` quality is covered

| Quality | Covered by |
|---|---|
| Analysability, inspectability | `s-explained` (statuses), `k-complex` |
| Debuggability | `s-explained` (refusals) |
| Testability, unit testability | `s-no-hidden-inputs`, `k-hidden-inputs`; `k-core-impure` (core runs anywhere) |
| Test coverage | `k-core-coverage` |
| Modularity, loose coupling | `k-cycles`; `k-seams` and `k-core-impure` (ADR 0005) |
| Changeability, modifiability, mutability | *Changing it stays safe and cheap*; `k-duplication` |
| Updateability, upgradeability | `s-dependencies`, `k-outdated`; `s-old-logs` for the data (ADR 0005) |
| Verifiability | The dogfood's own contract: every measured node has a probe, and every suite probe's `describe` titles exist (`dogfood.test.ts`) |
| Evolvability, extensibility, longevity, reusability, themability | ADR 0005 |
| Maintainability, supportability | The two goals together |

Left out on purpose:

- **Cohesion as its own number.** LCOM-style metrics measure classes, and this
  code is functions and modules. Module size and complexity are the proxies.
- **Coherence.** One strict `tsconfig.base.json` serves every package, and no
  relative import lacks `.js` (checked: 0). There is no lint configuration
  whose drift a probe could count.
- **Unused exports.** The baseline was 45 of 257. Nearly all were types used
  in signatures or the public surface of `@orrery/core`, so the count would mostly
  measure style.

## Consequences

- **Two dev dependencies:**
  - `@vitest/coverage-v8`, pinned to vitest's exact version (3.2.7). It must
    move together with vitest.
  - `typescript`, declared in `apps/server`, where the probes load the
    compiler API. Before, it resolved only through the root manifest.
- **The quorum goal stops being undecided.** Today it reads *unknown*: three
  of five inputs are on target, module size is in warning, and the coverage
  stub is unknown. At 92.7% coverage it reads four of five, which is
  *on target*. The module-size warning stays visible one level down. Its
  other inputs did not change.
- **The new goal starts in warning**, from `k-complex` (17) and `k-outdated`
  (71.4%). Offline, `k-outdated` reads unknown and `k-complex` still sets the
  warning.
- **The cost:**
  - the server suite runs ~1.5 s longer, mostly walking 30 days of the demo;
  - the complexity-rule test loads the TypeScript compiler once (~0.6 s);
  - a dogfood run is ~20 s longer, ~70 s in all: `pnpm outdated` takes 12–21 s
    online (up to the 120 s timeout offline), coverage ~2.5 s, complexity
    ~1 s.
- **Locally, pnpm can repair an unlocked change before the lockfile test sees
  it.** Here, pnpm 12 ran an install before `pnpm exec` when a manifest had
  changed. The lockfile was rewritten, and the change showed in `git diff`
  instead of as a red test. The test catches it wherever tests run without
  that step: vitest called directly, or CI after a frozen install.
- **The probes caught their own author.** The first draft of
  `maintainability.ts` added three functions over 15. They were split before
  commit, so the baseline is the repository's, not the probe's. Its highest
  score is now 9.
- **Findings, not fixed here:**
  - **The shared import regex** in `probes.ts` and `flexibility.ts` also
    matches a string that ends in "from" followed by a quote, such as a message
    in `decide.ts`. No count is wrong today, because the bogus specifier
    matches no rule. The new dependency test uses an anchored pattern instead.
    Fixing the shared one means a version bump for `core-impurities` and
    `seam-crossings`.
  - **A type-only cycle among the dogfood probe modules.** `probes.ts` imports
    the probe lists from `efficiency.ts`, `flexibility.ts` and
    `maintainability.ts`, which import its types back. Moving `Probe` and
    `ProbeContext` into a types module would break the loop.
  - **`format.ts` is core's coverage gap**, at 51% of statements.
  - **TypeScript 7 is out**, and its compiler API may differ from 5's.
    Upgrading means revisiting `complex-functions` and `import-cycles`. They
    record nothing, rather than a wrong number, if the API cannot load or lacks
    what they walk.
  - **The ADR 0003 finding stands:** the store still loads logs that break the
    contract, and `s-log-load` is in breach.

Each test and probe was shown to fail by breaking the code on purpose:

| Deliberate break | What turned red |
|---|---|
| worst-of drivers listing every input, healthy ones included | the statuses test |
| a worst-of node on target with an empty reason | the statuses test |
| an undecided quorum naming no drivers | both statuses tests |
| the not-found message dropping the id | the refusals test |
| a conflict answered with 400 | the refusals test |
| `decide` stamping events with the system clock | the no-hidden-inputs test and both statuses tests; `hidden-inputs` = 1 |
| views deciding "live" from `Date.now()` | the no-hidden-inputs test, naming the answers that moved |
| `apps/server` no longer declaring `typescript` | the declared-imports test |
| a manifest range changed without `pnpm install` | the lockfile test, when pnpm does not install first |
| a new function with nested loops and branches | `complex-functions` 17 → 18 |
| `harness.ts` importing a value from `probes.ts` | `import-cycles` = 1 |
| the same import as `import type` | `import-cycles` unchanged at 0 (correct) |
| a 12-line function copied into another file | `duplicated-lines` 0.84 → 1.24 |
| core's log tests removed | `core-coverage` 92.69 → 92.14 |
| `@types/*` no longer excluded from the outdated count | `outdated-majors` 71.4 → 92.9 |
| a selected `describe` renamed | the selector test in `dogfood.test.ts` |

## Not decided here

- **Whether to upgrade.** React 19, vite 8, vitest 5 (with its coverage
  provider), TypeScript 7 and zod 4 are each a migration. The KPI says how far
  behind the repository is. It does not say which upgrade comes first.
- **Splitting `decide` and `applyEvent`.** The target asks for the worst
  functions to be split as they are next changed, never just to move the
  number.
- **Branch coverage, and coverage of `apps/server`.** Branches stand at 80.6%.
  Statements were the stub's stated candidate.

## Revisit when

- **TypeScript moves to 7:** check that the complexity and cycle probes still
  parse.
- **vitest moves:** bump `@vitest/coverage-v8` with it.
- **The UI gains unit tests:** extend `hidden-inputs` and coverage to
  `apps/web`.
- **A new composition root appears:** add it to `SANCTIONED_CLOCKS` with a
  version bump.
