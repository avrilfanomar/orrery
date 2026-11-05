# ADR 0011 — Usability: everyone can read and operate the console

**Status:** Accepted (PoC) · **Date:** 2026-11-05 · **Builds on:**
[ADR 0003](0003-the-repository-measures-itself.md),
[ADR 0004](0004-efficiency-shape-in-the-suite-size-in-the-dogfood.md),
[ADR 0009](0009-safety-no-one-acts-on-a-green-it-has-not-earned.md),
[ADR 0010](0010-security-the-browser-is-the-way-in.md)

## Context

The arc42 quality model tags 62 qualities `#usable`
(<https://quality.arc42.org/tag-usable>). Most of them already have a home here:
- latency and responsiveness in ADR 0004;
- compatibility in ADR 0005;
- code complexity and readability in ADR 0006;
- operability in ADR 0007;
- fault tolerance and recoverability in ADR 0008;
- correctness and functional suitability in ADR 0012.

What is left is the person at the console: whether they can read it, reach
every control, and operate it. Until now the model's usability goal, *People
can follow it end to end* (`g-usable`), held three things:
- the README tour;
- the smoke test;
- the docs' links.

None of these asks whether the text is readable or a control is reachable. The
console's own palette promised more than was checked. A comment in `styles.css`
says that status colours "always ship with an icon and a label", and the smoke
test drives the console by roles and labels. Nothing measured contrast, target
size or names.

**Risk identification.** axe-core 4.14.0 checked the built console against WCAG
2.2 A and AA and axe's best practices. It ran on the eight views the tour walks
through, in the light and the dark scheme. Of 31 checks, 25 failed, under three
rules. U4 came from reading the code, because axe checks a role's structure,
not the behaviour it promises.

| # | Hazard | What happened |
|---|---|---|
| U1 | **Secondary text too faint in the light scheme.** `--muted` (#7d7c76) read 3.83:1 on the page, 3.67:1 on `--surface-2`, and 3.41:1 on the outline's focus row. WCAG AA asks 4.5:1 | `color-contrast` failed in all eight light views, on 154 elements: hints, labels, kinds, times, table heads, the actor field, and U2's buttons |
| U2 | **White on the accent too faint.** The primary buttons read 4.41:1 in the light scheme and 3.63:1 in the dark one | *+ Refine*, *Publish* and *Record* failed in five dark views, and in the light ones among U1's elements |
| U3 | **Targets under 24 px** (WCAG 2.2, 2.5.8). The outline's chevrons were 18 × 18 px, and the change feed's links 17 px tall | `target-size` failed in ten checks, on 53 elements with the feed open |
| U4 | **A tree that was not one.** The outline said `role="tree"`, which promises arrow-key navigation, with `aria-selected` and `aria-expanded` on its items. It offered none of that, only buttons in the tab order | A screen reader announced a tree, and its tree commands did nothing |
| U5 | **A select with no name.** The revise dialog's rollup rule sat in a `<fieldset>`, whose legend does not name the control inside it | `select-name` failed in both schemes |

Already in place, and not news here:
- **Focus.** Every tab stop on the top level and on a KPI shows a focus ring.
- **Reflow.** Nothing scrolls sideways at 320 CSS px.
- **Dialogs.** They are native `<dialog>` elements: Escape closes them and
  focus stays inside.
- **Language.** The page declares `lang="en"`.
- **Status.** It is never colour alone: each badge carries an icon and a word.

## Decision

### 1. A browser scan the dogfood runs (U1–U5)

`apps/web/e2e/a11y.mjs` runs against a running app, like the smoke test:
`pnpm --filter @ru/web a11y`.
- **What it scans.** It runs axe-core (WCAG 2.2 A and AA, and best practices) on
  eight views, in both schemes:
  - the top level;
  - a measured KPI;
  - an unrefined stub;
  - the refine, record and revise dialogs;
  - the change feed;
  - a past day.
- **Two checks axe cannot make.** It tabs through the top level and a KPI,
  checking that every stop shows a focus ring. It loads both 320 CSS px wide,
  checking that nothing scrolls sideways.
- **What it counts.** A check is one rule in one view in one scheme, one page's
  focus rings, or one page at one width. The value is the number of checks
  that fail. It does not count elements: those grow with whatever the demo
  renders, which is the drift ADR 0004 keeps out of the numbers.
- **It only reads.** Dialogs are opened and closed, never submitted.
- **It sets the console's CSP aside in its own browser context**, because axe is
  injected as a script. The smoke test keeps the policy: its console-error
  step is what caught zod's `new Function` probe (ADR 0010).
- **axe-core is a devDependency of `apps/web`, pinned at 4.14.0.** It is
  MPL-2.0, which is not on the approved list. `licences-unapproved` counts only
  what ships (`--prod`), and axe-core never reaches the bundle.

### 2. A suite test for the tokens (U1, U2)

`apps/server/test/usability.test.ts` reads `styles.css` on every `pnpm verify`.
- **Contrast.** Every text colour (`--ink`, `--ink-2`, `--muted`, `--accent-ink`)
  must reach 4.5:1 on every surface it can be drawn on, in both schemes. The
  surfaces are `--page`, `--surface`, `--surface-2` and `--sunken`, plus the
  accent and status washes over the surface they tint. `--on-accent` must reach
  4.5:1 on the accent and on its hover colour.
- **One dark scheme.** The dark scheme is declared twice: once for the system's
  preference and once for `data-theme="dark"`. Both blocks must stay identical.

The browser checks what is rendered; this checks the tokens it is rendered
from, in milliseconds, so a token edit that breaks contrast fails before
anything is built.

- **It found one thing the scan could not.** Dark `--muted` read 3.81:1 on the
  warning wash. No view scanned today draws muted text on a wash, but the
  console may, so the token was lightened.

### 3. The fixes

| Hazard | Change |
|---|---|
| U1 | Light `--muted` #7d7c76 → #696862, at least 4.56:1 on every light surface. Dark `--muted` #8f8e88 → #9d9c96, at least 4.54:1 on every dark surface and wash |
| U2 | Light `--accent` #2a78d6 → #246fcb. A new token, `--on-accent`, sets the text on the accent: white in the light scheme (4.99:1), near-black in the dark one (5.41:1, and more on its hover colour). The literal `#fff` in `.btn-primary` is gone |
| U3 | `.chev` is 24 × 24 px; `.link-btn` is at least 24 px tall |
| U4 | The outline is nested lists of buttons. Each chevron is a disclosure button, with `aria-expanded` and the name "What contributes to …". The node in focus carries `aria-current="location"` |
| U5 | The rollup select is named "Rollup rule" |

### 4. What the suite and the dogfood pin

| `describe` | File | What it pins | Scenario |
|---|---|---|---|
| the theme is readable in both schemes | `apps/server/test/usability.test.ts` | §2 | `s-contrast` |

| Probe | Node | Baseline | Target / warning |
|---|---|---|---|
| `ui-accessibility` | *Accessibility checks that fail in a real browser* | 25 of 31 before, 0 of 20 after | 0 / 0 |

The count of checks fell from 31 to 20, as well as the failures, because a view
with no violation is one check, and one with three failing rules is three.

### 5. The model

`g-usable` keeps its id and its weighted rollup. It is retitled *Everyone can
read, operate and follow it end to end*, and its dimensions narrow to `usable`.
The demo story, which is about whether the product does what it says, moves to
the suitability goal (ADR 0012).

| Node | Inputs |
|---|---|
| *The console meets WCAG 2.2 AA wherever a scan can tell* | `k-a11y`; `s-contrast` |
| *The evolution loop works in a real browser* (existing) | — |
| *Broken relative links in Markdown docs* (existing) | — |

### 6. Where each `#usable` quality is covered

| Quality | Covered by |
|---|---|
| Accessibility, inclusivity, legibility, readability | §1 and §2, for what an automated check can tell. Status is never colour alone. What a scan cannot judge is not tested: how a screen reader user gets through a task, plain language, cognitive load |
| Interaction capability, operability, controllability, ease of use, convenience | Focus rings on every stop, and targets of at least 24 px (§1). Native dialogs. The smoke test drives the loop by roles and labels, the way assistive technology does |
| Understandability, self-descriptiveness, clarity, communicability | Every status and refusal explains itself (`s-explained`, ADR 0006). Banners say when the view is the past or no longer live (ADR 0009) |
| User error protection | An evolutionary change needs a reason, and the console refuses one without (`ui-smoke`). Nothing is deleted: deprecate and reactivate, time travel, an append-only log (ADR 0001). A reset keeps what it replaces (ADR 0009) |
| Learnability, appropriateness recognizability, discoverability, user assistance, intuitiveness | The five-minute tour, pinned by `s-story` (ADR 0012). Field hints in the dialogs. The *Not yet observable* backlog and *Follow the signal*. There is no in-app help or onboarding |
| Consistency, coherence | One status vocabulary, four status colours, and every colour through a theme token (`k-theme-literals`, ADR 0005). The two dark blocks are one scheme (§2) |
| Appearance, user interface aesthetics, attractiveness | The theme tokens, light and dark. Not measured |
| Adaptability, anticipated workplace environment | A desktop or phone browser, in light or dark; reflow at 320 px (§1). The scheme follows the system; there is no switch in the console |
| Conciseness, simplicity | Progressive disclosure: one node and one level below it (ADR 0001). Not measured |
| Customizability, configurability | The operator's settings (ADR 0007). A person cannot customise the console |
| Internationalization, localizability | **Not provided.** The console is English only, and dates use a fixed `en-GB` format in the browser's time zone. Instants that cross the API carry a zone (ADR 0005) |
| Reproducibility | The demo is seeded, so the scan and the smoke test see the same universe every time. Time travel reproduces any past view (ADR 0001) |
| Responsiveness, latency | ADR 0004 |
| Availability, fault tolerance, graceful degradation, recoverability, faultlessness | ADR 0008. The console says when it has stopped being live (ADR 0009) |
| Compatibility, interoperability, backward compatibility | ADR 0005 |
| Code complexity, code readability | ADR 0006 |
| Correctness, accuracy, precision, data quality, effectiveness, features, functionality, functional completeness, functional appropriateness, functional suitability | ADR 0012 |
| Compliance, legal requirements | WCAG 2.2 AA is the bar where a scan can tell. **No conformance is claimed:** automated checks find only part of what WCAG asks. Licences: ADR 0007 |
| Consent management | Not applicable (ADR 0010) |
| Affordability | Apache-2.0. It runs on Node with one local file and no service to pay for |
| User engagement, user experience | Not measured. There are no users to ask yet, and nothing is collected about the people who use it, by design (ADR 0010) |
| Usability | The goal as a whole |

The tag's description also names testability (ADR 0006), and installability
and deployability (ADR 0007).

## Consequences

- **The console looks a little different.**
  - Secondary text is darker in the light scheme and lighter in the dark one.
  - The light accent is a shade deeper.
  - The dark primary buttons carry near-black text.
  - The outline's chevrons are larger targets; the rows keep their height.
- **No stored event changes,** and no status, now or in the past.
- **The cost:**
  - the server suite gains three tests: two in `usability.test.ts`, which take
    milliseconds, and one in `dogfood.test.ts` (ADR 0012);
  - the dogfood gains one browser run, of about 15 s;
  - `theme-literals` drops from 7 to 6, the `#fff` in `.btn-primary`;
  - `k-outdated` drops from 57.1% to 53.3%, because axe-core is a current
    dependency.
- **Findings, not fixed here:**
  - **Machine checks are not an audit.** No one has used the console with a
    screen reader, by keyboard alone, or with magnification.
  - **The outline has no arrow keys.** It is a list of buttons, honestly named,
    and a long universe means a long tab order. The search box and *Issues
    only* shorten it.
  - **The chart is a picture.** Its label gives the range and the latest
    reading, but the readings inside it have no text form.

Each check was shown to fail by breaking the code on purpose:

| Deliberate break | What turned red |
|---|---|
| light `--muted` back to #7d7c76 | the contrast test; the scan's `color-contrast` in every light view |
| dark `--on-accent` back to white | the contrast test |
| one dark block's `--ink` changed | the one-dark-scheme test |
| `.chev` back to 18 px | the scan's `target-size` |
| the rollup select's name removed | the scan's `select-name` in the revise dialog |
| focus rings removed (`:focus-visible { outline: none }`) | the scan's focus-ring check |
| a 400 px minimum width on the page | the scan's reflow check |

## Not decided here

- **A manual audit** with a screen reader and keyboard only, and whether to claim
  WCAG conformance after one.
- **Arrow-key navigation** for the outline, which would earn back the tree role.
- **Languages other than English.**
- **A scheme switch in the console** (`data-theme` is ready for one).
- **A text alternative for the reading chart.**

## Revisit when

- **A view or a dialog is added:** add it to `VIEWS` in `a11y.mjs`.
- **A colour is added or changed:** it goes through a token, and the contrast
  test decides whether it is readable. A new surface or text token joins the
  test's lists.
- **axe-core is upgraded:** new rules can fail checks that passed. Read what
  changed before reading the number as a regression.
- **A control needs a new role:** give it the keyboard behaviour that role
  promises, or do not use the role.
