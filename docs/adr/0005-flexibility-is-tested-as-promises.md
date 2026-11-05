# ADR 0005 — Flexibility is tested as promises the repository makes

**Status:** Accepted (PoC) · **Date:** 2026-11-04 · **Builds on:**
[ADR 0001](0001-one-graph-append-only-evolution.md),
[ADR 0002](0002-metrics-bind-to-configured-sources.md),
[ADR 0003](0003-the-repository-measures-itself.md),
[ADR 0004](0004-efficiency-shape-in-the-suite-size-in-the-dogfood.md) ·
**Amended by:** [ADR 0013](0013-modules-bring-what-core-does-not-know.md),
which redraws the seams around module packages (`seam-crossings` v2)

## Context

The arc42 quality model tags about thirty qualities `#flexible`. Examples are
portability, co-existence, configurability, integrability, replaceability,
longevity and themability. The dogfood model had touched only one of them:
`k-core-impure` keeps the domain core free of Node and DOM APIs, so the UI can
import it.

Flexibility has no natural unit. "How portable is it?" has no number the way
"how fast is it?" does. But the repository already makes concrete promises
about flexibility, in its code and its docs, and each promise can be checked:

- **Old logs keep loading.** `log.ts` says that
  `apps/server/test/fixtures/events.v1.jsonl` "is frozen history that must keep
  loading". The file did not exist.
- **Old shapes stay valid.** `schema.ts` makes `binding` optional "so logs
  written before ADR 0002 keep loading". Nothing loaded such a log, and
  nothing loaded a log with bindings either, though every dogfood log is full
  of them.
- **The API table is complete.** The README's API table lists what the server
  serves. It left out `GET /api/health`, which `pnpm reset` and `pnpm dogfood`
  call.
- **Settings are documented.** The server, the simulator and the tooling read
  17 environment variables. The README named 6.
- **Answers don't depend on the time zone.** Instants are stored in UTC.
  Nothing checked that an answer is the same whatever the server's time zone.
  It was not: `?asOf=2026-10-20T15:00` was read in the server's local time.

## Decision

### 1. The suite pins each promise as a contract

[`apps/server/test/flexibility.test.ts`](../../apps/server/test/flexibility.test.ts)
has one outermost `describe` per dogfood scenario:

| `describe` | What it pins | Scenario |
|---|---|---|
| frozen history | Every file in `test/fixtures` is pinned by its SHA-256. Each loads through `EventStore.open` and passes `checkLogEntry` line by line. Together the files hold every event type the schema knows. Each projects to the statuses, verdicts, bindings and links it had when it was written | `s-old-logs` |
| time zones | The process switches `TZ` to UTC+14, UTC−10 and Kyiv, and the test checks that the offset really changed. The seeded demo, the benchmark workload and seven API answers are byte-identical to UTC. The demo's 30 days span both the European (25 Oct) and the US (1 Nov) clock change, so summer time is exercised too. A zone-less `asOf` is refused | `s-time-zones` |
| co-existence | Two apps in one process: writing to one leaves the other's answer unchanged byte for byte. With no settings, the demo and the dogfood servers default to different logs and ports | `s-coexist` |
| the documented API | The README's API table and the routes in `app.ts` are the same set, and each one is served. The command list matches `CommandSchema`. The README's webhook example is accepted as written | `s-api-contract` |

There are two frozen logs:

- **v1 is the oldest shape** the schema promises to load: `node.created` with
  no `binding` and no `dashboardUrl`. It was written by hand, deliberately not
  from today's code.
- **v2 is the shape written today.** It was generated once through today's
  `decide`, then frozen. It holds:
  - a PromQL binding to a source, and a probe binding without one;
  - dashboard links set on create, changed and cleared on edit;
  - a binding removed by a redefinition;
  - a pulled reading.

  Generating it from the current writer is right for v2, because it *is*
  today's writer. Freezing is what makes it a test: every later version must
  read it as it reads now.

**The fixtures are frozen.** When the event format changes, add
`events.v3.jsonl` in the new shape and pin its hash. Never edit an old one.
`.gitattributes` keeps git from rewriting their line endings, so the hashes
hold on every platform.

### 2. The dogfood counts what breaks a promise

These probes are in [`apps/server/src/dogfood/flexibility.ts`](../../apps/server/src/dogfood/flexibility.ts).
All three are static, machine-independent counts over tracked files:

| Probe | Node | Baseline | Target / warning |
|---|---|---|---|
| `config-undocumented` | Settings read from the environment that the README does not name | 0 (11 before this change) | 0 / 0 |
| `seam-crossings` | Imports and network calls that cross a component boundary | 0 | 0 / 0 |
| `theme-literals` | Colours outside the theme tokens | 7 | 0 / 10 |

**`config-undocumented`** collects the environment variables read by name in
the apps, core, the smoke test and the Vite config, and counts those that the
README never mentions. The README now has a configuration table. PATH is left
out because the platform defines it. A dynamic read such as
`env[s.tokenEnv]` is left out because the source file names that variable.

**`seam-crossings`** resolves every source import against four boundaries:

- core is used only through its entry, `@orrery/core`;
- core depends on no app;
- the UI and the server share only core and HTTP;
- only the collector talks to a source adapter (ADR 0002, decision 4).

A network call in the UI outside `api.ts` also counts as a crossing. Each
crossing is a place where a component can no longer be replaced on its own.

**`theme-literals`** counts colour literals in the UI outside the
custom-property declarations that make up the theme. The baseline is 7:
- three in `styles.css`: white text on the accent, a dialog shadow and the
  scrim;
- four glyph colours in the status icons in `bits.tsx`.

The node knowingly starts in warning, as `k-largest` did, so the new goal reads
*warning* from its first run.

### 3. The model gains a goal

The new goal, *It adapts, connects and outlasts its own versions*, rolls up
worst-of. It is a sibling of *Changing it stays safe and cheap*, not a child.
That goal rolls up by quorum, so children added to it would shift its verdict.

| Requirement | Inputs |
|---|---|
| History written today stays readable by every later version | `s-old-logs` |
| It behaves the same wherever it runs, beside whatever else runs there | `s-time-zones`, `s-coexist`, `k-config-undocumented` |
| Other tools plug in through documented contracts and fixed seams | `s-api-contract`, `k-seams` |
| Its look changes in one place | `k-theme-literals` |

### 4. Where each `#flexible` quality is covered

| Quality | Covered by |
|---|---|
| Longevity, evolvability | `s-old-logs` |
| Portability | `s-time-zones`; `k-core-impure` (core runs in Node and in the browser) |
| Co-existence | `s-coexist` |
| Configurability, tailorability | `k-config-undocumented` |
| Integrability | `s-api-contract` |
| Interchangeability, replaceability, independence, composability, reusability | `k-seams`, `k-core-impure` |
| Extensibility | `k-seams`: a new source kind plugs in behind the collector, the one place that talks to an adapter |
| Themability | `k-theme-literals` |
| Adaptability, customizability | The model itself: targets, rollups, priorities and structure change through reasoned events with no code change (ADR 0001), pinned by `s-in-force` and `s-gate-refuses` |
| Changeability, modifiability, mutability | *Changing it stays safe and cheap* (types, module size, verification time) |
| Scalability | ADR 0004: `s-log-passes`, `s-answer-size`, `k-view-week` |

Left out on purpose:

- **Internationalization, localizability.** The UI is English only, and there
  is no message catalogue to keep complete. Labels are already gathered in
  core (`KIND_LABELS`, `STATUS_LABELS`). See the locale finding below.
- **Installability.** The check that the lockfile matches the manifests needs
  registry metadata. Offline, `pnpm install --frozen-lockfile --lockfile-only`
  fails, so the probe could only skip. A frozen install in CI is the natural
  check.
- **Elasticity, distributability.** The PoC is one process by design
  (ADR 0001).
- **Agility, personalization, versatility.**
  - Agility is a process quality. `k-verify` is the nearest proxy.
  - Nothing is per user, because there is no identity.
  - The engine already serves two unrelated domains, the demo shop and this
    repository, and `s-coexist` runs both.

## Consequences

- **Behaviour change: `asOf` must name its zone.** An ISO-8601 date is still
  accepted, read as UTC midnight as ECMAScript reads it. A date-time needs `Z`
  or an offset. Without one, and for non-ISO text such as `10/20/2026`, the
  API now answers 400 where it used to answer in the server's local time. The
  UI always sends `toISOString()`, so it is unaffected. A hand-typed `asOf` in
  the browser's URL bar can now be refused.
- **Fixed by this change:**
  - the missing frozen fixture;
  - eleven undocumented settings;
  - the undocumented health route.
- **The cost:**
  - the suite runs about 1.5 s longer, mostly generating the demo in four time
    zones;
  - the three probes take milliseconds.
- **A new event type now needs a new frozen log** that holds it. So does any
  format change that v2 doesn't show. That is the point: the old
  files stay, and every later version must read them.
- **Finding, not fixed here:** `bits.tsx` formats the pass/fail run tooltip
  with `toLocaleString()`, which follows the viewer's locale. Every other date
  and number format is pinned to `en-US` or `en-GB`. The UI is one language
  now and two locales on hover.

Each test and probe was shown to fail by breaking the code on purpose:

| Deliberate break | What turned red |
|---|---|
| `binding` required in `node.created` | the load and v1-reading tests |
| a binding's `query` renamed | the load and v2-reading tests |
| `dashboardUrl` no longer clearable on edit | the load and v2-reading tests |
| one byte of the v1 fixture changed | the byte-for-byte test |
| a new event type in the schema | the event-type coverage test |
| readings judged by the latest definition | the v1-reading test |
| the `asOf` check reverted to `Date.parse` | the zone refusal test |
| ribbon days aligned to local midnight | the same-answers test |
| one event array shared by every store | the two-universes test |
| the dogfood port defaulting to 4710 | the defaults test |
| the health row removed from the README | the route test |
| `unlink` removed from the README's command list | the command test |
| the webhook example pointing at an unknown node | the example test |
| a new `process.env.ORRERY_BIND` read | `config-undocumented` = 1 |
| an import of `@orrery/core/src/log.js` in the UI | `seam-crossings` = 1 |
| a `fetch` in `route.ts` | `seam-crossings` = 1 |
| `app.ts` importing the Prometheus adapter | `seam-crossings` = 1 |
| an `rgb()` colour in a CSS rule | `theme-literals` = 8 |
| a new colour declared as a token | `theme-literals` unchanged at 7 (correct) |

One break got past frozen history. Renaming the `pull:` prefix leaves both
logs loading and reading the same, because no view reads the prefix. The
collector does read it, so the rename would strand old pulled readings, and
the source suites (`s-sources`) turn red on it: six tests in core and server.

## Not decided here

- **Whether the seven theme colours should become tokens.** Tokens such as
  `--on-status` and `--on-warn` would let a theme change the icon glyphs. The
  glyphs are fixed by design today: white on green and red, near-black on
  amber.
- **Unicode content.** No test sends titles in other scripts, combining marks
  or emoji through the API, the log and back.
- **A self-contained UI.** A probe could count the external origins the built
  UI loads (fonts, scripts). Today it loads none.

## Revisit when

- **The event format changes:** add a v3 fixture.
- **A second source kind lands:** the adapter rule in `SEAMS` names
  Prometheus, so generalize it.
- **The UI gains unit tests:** the theme check could then move into the suite.
- **i18n becomes a requirement.**
