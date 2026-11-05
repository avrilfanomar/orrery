# ADR 0012 — Suitability: it does what the README says, and a test would notice if it stopped

**Status:** Accepted (PoC) · **Date:** 2026-11-05 · **Builds on:**
[ADR 0001](0001-one-graph-append-only-evolution.md),
[ADR 0003](0003-the-repository-measures-itself.md),
[ADR 0006](0006-maintainability-structure-counted-diagnosis-pinned.md),
[ADR 0009](0009-safety-no-one-acts-on-a-green-it-has-not-earned.md)

## Context

The arc42 quality model tags 35 qualities `#suitable`
(<https://quality.arc42.org/tag-suitable>). At their centre is functional
suitability: the product does what it claims, completely and correctly, for
the people it claims to serve.

This product states its claims in one place: the README's *The idea* table.
Six needs sit there, from *Build and manage requirements & constraints* to
*Dynamic evolution*, each with how the PoC meets it. Until now the model held
the suitable dimension in four scenarios:
- unknown never rolls up as green;
- readings are judged against the definition in force;
- every change is on the record;
- the demo tells the documented story.

ADR 0009 asked whether the tests would notice a false green, by breaking the
core on purpose (`false-green-mutants`). Nothing asked the same of the other
claims: a wrong answer that is not a green, or a promise quietly dropped.

**Risk identification.** Nineteen breaks were written against the core, each
making one claim false: a boundary moved, a link ignored, a ribbon shifted by a
day, a reason quoting the wrong threshold. Then the core's tests were run
against each, and the server's tests against those the core missed. One break,
a deprecated node's ribbon still painted, broke nothing the README or a doc
comment promises, and was dropped. Of the 18 that remained, 5 got past the
core's tests.

| # | Hazard | What happened |
|---|---|---|
| F1 | **Claims nothing defended.** Five breaks of a written claim got past the core's tests, and four of them past the whole suite | `ribbon-ends-yesterday`: the 14-day ribbon could end the day before the moment shown ("Daily status for the last 14 days"). `warn-reason-wrong`: a warning's one-line reason could quote the target as its warning threshold. `drivers-by-weight`: *Follow the signal* could lead from a red goal to a heavier warning while the breach that made it red sat beside it. `late-reading-out-of-order`: a late, back-dated reading could replace today's status, though ADR 0001 says it lands in place. `time-travel-leaks`: the past could show nodes created after it. The server's API tests caught only this last one |
| F2 | **The backlog and the breadcrumb lived where no test reached them.** The *Not yet observable* backlog, which the README promises for "everything above" a stub, and the breadcrumb that "climbs back" were computed in `Focus.tsx`. The console has no unit tests | Both were right. On the demo, the dogfood log and a local demo log (41, 50 and 41 nodes) the backlog agreed with every node's coverage. Nothing would have noticed either stop being right |

Already in place, and not news here:
- the four invariants and their tests (CLAUDE.md, ADR 0001);
- the false greens (ADR 0009);
- every status and refusal explains itself (ADR 0006);
- the demo story pinned by `app.test.ts`;
- the API the README documents is the one served (ADR 0005).

## Decision

### 1. Every need in *The idea* has breaks the core's tests must catch (F1)

`CLAIM_MUTANTS` in `apps/server/src/dogfood/suitability.ts` holds 21 breaks.
Each one names the need it breaks and what a person would be shown if it
shipped. The `claim-mutants` probe runs the core's tests against each break, on
a copy of `packages/core`, as `false-green-mutants` does. The value is the
number of breaks no test catches.

| Need | Breaks |
|---|---|
| Build and manage requirements & constraints | `links-ignored`, `move-cycle`, `link-cycle` |
| Business + quality KPIs | `on-target-warns`, `at-warning-breaches`, `fresh-reads-stale` |
| High-level monitoring | `warn-reason-wrong`, `coverage-overstated`, `ribbon-ends-yesterday` |
| Progressive disclosure | `signal-one-step`, `drivers-by-weight`, `breadcrumb-one-step`, `backlog-skips-links` |
| Iterative refinement | `backlog-misses-stubs` |
| Dynamic evolution | `reason-optional`, `deprecated-counts`, `time-travel-leaks`, `new-target-waits`, `diff-misses-target`, `late-reading-out-of-order`, `backfill-unjudged` |

- **A break is kept only when it breaks something written:** the README, an ADR,
  or a doc comment the console shows its reader.
- **The false greens stay in their own list.** A break whose harm is a status
  greener than earned belongs to `FALSE_GREEN_MUTANTS` (ADR 0009). One break here
  does both: `links-ignored` can hide a breach from a second parent. It is kept
  because the claim it breaks is the link itself.
- **The core's tests only, so each claim is pinned where its logic lives.**
  `time-travel-leaks` was caught by the server's tests through the API; it now
  has a core test too.
- **The runner is shared.** `copyCore`, the verdict and the side-by-side runs
  moved from `safety.ts` into `mutants.ts`. `false-green-mutants` measures
  exactly as before, with the same messages, so it keeps version 1.
- **The suite keeps the list honest** (`dogfood.test.ts`):
  - every break's text still occurs exactly once in the code;
  - no id repeats across both lists;
  - no claim break duplicates a false green;
  - the README's rows are exactly `NEEDS`;
  - every need has at least one break.

  A need added to the README without a break fails the suite, and so does a
  break a refactor has quietly retired.

### 2. Tests for what got through (F1)

`packages/core/test/suitability.test.ts` pins each claim F1 found undefended:
- the ribbon ends at the moment shown, and that day's change is in its last
  cell;
- a past view holds nothing created or redefined after the moment it names;
- the reason names its thresholds, in every status;
- *Follow the signal* goes to a breach before a heavier warning;
- a late reading lands in place, and the latest observation decides.

### 3. The backlog and the breadcrumb move into core (F2)

`backlogBelow(view, id)` and `breadcrumbTo(view, id)` in
`packages/core/src/views.ts` replace the console's own `gaps()` and `trail()`,
unchanged in what they return.

The breadcrumb's test: it lists every primary parent from the top down, and
no link. Two tests pin the backlog:
- **The backlog lists every kind of gap, and nothing else.** That means a
  measure never read, a stale one, a stub, and a stub reached through a link.
  A deprecated node and a measured one stay out.
- **The backlog agrees with coverage.** For every node, the backlog plus the
  node itself, when it is a gap, is exactly the number of leaves its coverage
  counts as unmeasured. The two numbers the console shows side by side can
  never disagree.

### 4. What the suite and the dogfood pin

| `describe` | File | Scenario |
|---|---|---|
| the refinement backlog; the breadcrumb climbs back to the top; the view shows the moment it names; the reason and the signal point at the cause; late readings land in place | `packages/core/test/suitability.test.ts` | `s-claims` |

| Probe | Node | Baseline | Target / warning |
|---|---|---|---|
| `claim-mutants` | *Breaks of a README claim no test catches* | 5 of 18 before; 0 of 21 after (36 s) | 0 / 0 |

Before, the breadcrumb and backlog breaks had nothing in core to break.

### 5. The model

A new goal, *It does what the README says it does* (`g-fit`, high, suitable),
rolls up worst-of:

| Node | Inputs |
|---|---|
| *Breaking any claim in "The idea" turns a test red* | `k-claims`; `s-claims` |
| *The demo tells the documented story* (moved from `g-usable`) | — |

The invariants' own suitable scenarios stay under *The model tells the truth*,
where they evidence the invariants.

### 6. Where each `#suitable` quality is covered

| Quality | Covered by |
|---|---|
| Functional suitability, suitability, functionality | The goal as a whole |
| Functional completeness, completeness | Every need in *The idea* has breaks the tests catch (§1). What is not built is in the README's *What is deliberately missing* |
| Correctness | Wrong answers here (§1, §2); false greens in ADR 0009; the thresholds inclusive in both directions; `decide` as the only gate (ADR 0001) |
| Functional appropriateness, effectiveness | The five-minute tour, pinned by `s-story`. *Follow the signal* goes from a red goal to its cause in one move. Not measured with people |
| Explainability, model transparency | Every status carries a reason and its drivers (ADR 0006). Every measured node in the dogfood says how it is measured. There is no learned model to make transparent |
| Groundedness | Every status rests on a reading judged by the definition in force when it was taken. With no reading it is unknown, never green (ADR 0001, ADR 0009) |
| Timeliness | A reading goes stale and unknown after its stated hours. The console says when it is no longer live (ADR 0009). Dogfood readings go stale after eight days |
| Data quality | `decide` refuses a pass/fail reading other than 0 or 1, a reading from the future, a time outside the years 0000 to 9999, and a reading for a node with no measure. The log contract holds on write and load (ADR 0008) |
| Test coverage, testability | `core-coverage` counts lines run (ADR 0006). `claim-mutants` and `false-green-mutants` count whether the tests would notice a claim break, which lines run cannot tell |
| Versatility, functional adaptability | Three rollup rules, both directions, pass/fail checks, bindings to Prometheus and Grafana (ADR 0002). The same model describes a shop (the demo) and this repository (ADR 0003) |
| Calibration | Of thresholds: each numeric target in the dogfood model cites the baseline it was set against. Not checked by a test. Of a model's confidence: not applicable |
| Cohesion, loose coupling | ADR 0005 and ADR 0006 |
| Deployability | ADR 0007 |
| Mean time to recovery | The server's restart time (ADR 0008). The demo shows the product tracking a team's MTTR as a KPI |
| Deployment frequency, cycle time | Not measured: a PoC with no deployment pipeline. The product can hold them as KPIs |
| Compliance, certifiability | No compliance or certification is claimed (ADR 0010, ADR 0011). Licences: ADR 0007 |
| Cost, affordability | ADR 0011. Cost is not measured |
| Data localization, data residency, data sovereignty | ADR 0010: one local file, on the operator's machine |
| Expected physical environment | Not applicable: a Node server and a browser |
| Autonomy, bias mitigation, fairness | Not applicable. Nothing learns, and nothing is decided about people: a status is a rule applied to numbers, the same for everyone |

The tag's description also names code readability, which ADR 0006 covers.

## Consequences

- **No behaviour changes.** No stored event changes, and no status now or in the
  past. The backlog and the breadcrumb the console shows come from the same
  rules as before.
- **The cost:**
  - the core suite gains eight tests (about 45 ms);
  - the server suite gains one, the list check in `dogfood.test.ts`;
  - the dogfood gains one mutant run of about 36 s;
  - the core's statement coverage rises from 89.37% to 90.19% in vitest's
    own report. `core-coverage` reads 90.07%, which takes `k-core-coverage` out
    of the warning ADR 0010 left it in (target 90);
  - `model.ts` grows to 547 lines, and `k-largest` stays in warning (target
    400, warning 600).
- **Findings, not fixed here:**
  - **The breaks reach only the core, and the console's own share of each
    claim is checked by nothing.** That covers tiles that drill down, the one
    level shown below the focus, and the buttons that call into core. These are
    React components with no unit tests, and the smoke test walks only the
    evolution loop. The API's share is checked by the server's tests.
  - **A hand-written list shows only the claims someone thought to break.** It
    is not a mutation score. A tool that mutates every line would say more,
    and cost a dependency and many minutes.

Each check was shown to fail by breaking the code on purpose:

| Deliberate break | What turned red |
|---|---|
| each of the 21 breaks in `CLAIM_MUTANTS` | a core test, every one (`claim-mutants` reads 0) |
| `suitability.test.ts` removed | `claim-mutants` reads 8: the five of F1, the breadcrumb break and the two backlog breaks |
| a row of *The idea* renamed in the README | the list check in `dogfood.test.ts` |
| a break's text changed in the code | the same check, naming the break to rewrite |

## Not decided here

- **Tests for the console's own share of each claim:** drill-down, the one
  level below the focus, the buttons that call into core.
- **Breaks for the console and the API,** which would need the server's suite
  or a browser run per break.
- **A mutation testing tool** in place of a hand-written list.
- **Checking each threshold's cited baseline** against the reading that set it.

## Revisit when

- **A row is added to *The idea*:** add it to `NEEDS`, and at least one break
  that would leave it unmet.
- **The code a break quotes changes:** rewrite the break for the new code, and
  bump `claim-mutants`.
- **A claim's logic moves into core** (as the backlog and the breadcrumb did):
  give it a break.
