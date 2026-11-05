# ADR 0013 — Modules bring what core does not know: query languages and source kinds

**Status:** Accepted (PoC) · **Date:** 2026-11-05 · **Builds on:**
[ADR 0002](0002-metrics-bind-to-configured-sources.md),
[ADR 0003](0003-the-repository-measures-itself.md),
[ADR 0005](0005-flexibility-is-tested-as-promises.md)

## Context

ADR 0002 drew a seam between the collector and a source adapter, and named
"a second source kind or query language is needed" as a reason to revisit it.
The seam held for the collector. Everything around it still knew Prometheus by
name:

- **Core** held the closed lists `SOURCE_KINDS = ['prometheus']` and
  `QUERY_LANGUAGES = ['promql', 'probe']`, and a table saying which kind runs
  which language. The event schema took a binding's language from that enum.
  So a new kind meant a change to the pure domain and to the shape of the log.
  The dogfood's `probe` language (ADR 0003) sat in the same enum.
- **The server** checked one schema for all sources, and Grafana's
  `datasourceUid` was a field in it. The adapter lived in
  `apps/server/src/sources`.
- **The console** built the Grafana Explore and Prometheus graph links itself.
  It labelled every query field "PromQL" and special-cased `probe` in two
  places. `GET /api/sources` exposed `route` and `grafanaDatasourceUid` for it
  to do so.

So adding a second system would have meant editing core, its event schema,
the server's config and the console, in step.

## Decision

### 1. Core names no kind and no language

- A binding's `language` is an open id (`LanguageIdSchema`: 1–32 lowercase
  letters, digits and dashes, starting with a letter). Every log written so far
  loads unchanged, since `promql` and `probe` both match.
- The `SourceCatalog` that `decide` receives says, for each configured source,
  its kind and the languages it runs. A binding that names a source must be in
  a language that source runs. That is the same rule as before, now read from
  the catalog instead of a table in core.
- A binding with no source only documents where the number comes from, and may
  be in any language. A SQL query behind a KPI that a nightly job pushes is
  worth recording, even with no SQL module installed. Nothing runs it, and a
  pulled reading still needs a source that runs its language (ADR 0002,
  decision 3).

### 2. A module implements the kit

`@orrery/module-kit` (`packages/module-kit`) is the contract. It is types plus one
helper, `defineSourceKind`. A module may bring:

- **Query languages:** an id, a label, a hint saying what a query must return,
  and optionally a sentence describing a binding nobody pulls.
- **Source kinds:** a kind name, the languages it runs, its own settings, an
  allowlisted `details` view of them, `queryRange` (one range query to samples
  or a failure), and optionally `drillOut` (a link into the system's own UI,
  built from the public URL only).

Only `queryRange` is handed the token and the URL the server fetches. `details`
and `drillOut` feed `GET /api/sources`, so they get `PublicSettings`: the
settings without `token`, `tokenEnv` or `url`. Their type says so, and
`config.ts` strips those fields before calling either. A kind cannot leak a
credential it was never given.

### 3. Prometheus is a module; the dogfood brings `probe`

- `@orrery/prometheus` (`packages/prometheus`) brings PromQL and the `prometheus`
  kind. Grafana stays what ADR 0002 made it: a route to Prometheus, now a
  setting of this kind rather than of every source.
- The dogfood brings the `probe` language from
  `apps/server/src/dogfood/module.ts`. It is not a package, because it
  measures this repository and lives with it (ADR 0003). No kind runs `probe`,
  so a probe binding stays provenance only.

### 4. One registry

`apps/server/src/modules.ts` lists the installed modules. Installing one is a
dependency in `apps/server/package.json` and one line there.
- `registryProblems` flags two modules claiming one language or one kind, and
  a kind running a language nobody declares.
- The suite holds the installed modules to that, and also refuses a language
  id core would refuse and a kind that declares a shared setting.

### 5. The shared settings and their checks stay with the server

These stay in `apps/server/src/sources/config.ts`, so no kind can loosen them:
- the fields every source has (`id`, `url`, `publicUrl`, `tokenEnv`,
  `stepSeconds`, `settleSeconds`, `timeoutSeconds`);
- an http(s) URL with no credentials and no query string;
- the token named by its environment variable, never given inline;
- a timeout under half the step;
- strict parsing;
- the loopback guard (`assertSafeToServe`).

The checks work like this:
- A kind's own fields are spread first and the shared ones after, so a kind
  that declared `url` would be overridden. The registry test refuses it anyway.
- What leaves the server about a source is the allowlist in `toPublic` plus
  the kind's own allowlist, `details`. It is never a spread of the
  configuration, and `details` never sees the credentials (decision 2).

### 6. The console loads no module

`GET /api/sources` now carries:
- `languages`: each installed language's label, hint and provenance sentence,
  and the installed kinds that run it;
- `drillOut`: a link on each live binding's status, built by the server.

Each source carries `runs` and `details` instead of `route` and
`grafanaDatasourceUid`. The console asks for this view whenever a node has a
binding. It labels the query field, the hint and the provenance line from it,
and offers a source only for a language some installed kind runs.

Which languages the form offers is decided in core (`languageChoices`), with a
test there, because the console has no unit tests:
- a new binding may take any language an installed kind can pull;
- a binding already in a language nothing pulls, a probe say, keeps it and is
  offered nothing else, so it is never re-labelled by accident (ADR 0003).

A language picker appears only when more than one language is on offer. With
Prometheus alone the dialogs are unchanged.

Drill-out links were shown only for live, pulled bindings, the only ones whose
source the console fetched. So building them per live binding on the server
loses none.

### 7. Where it is pinned

Both new packages live under `packages/`, so every probe that scans
`packages/*/src` covers them.

| Pinned by | What it holds |
|---|---|
| `seam-crossings` v2 | Its rules now say which package may load which: <ul><li>a package is used through its entry;</li><li>core depends on no other package or app;</li><li>a module depends only on core and the kit;</li><li>the UI and the server share only core and HTTP;</li><li>only the registry installs a module.</li></ul> A call of `.queryRange(` outside the collector counts as well. The v1 rule was keyed to the adapter's old path and could no longer fire. |
| `import-cycles` v2 | Resolves every `@orrery/<name>` to its entry, so a cycle through a module counts. |
| `type-errors` v2 | Checks every workspace package with a tsconfig, so a new module is checked without anyone listing it. |
| `dogfood.test.ts` | Each seam, crossed once, is counted, and each import the layout allows is not. |
| `sources.test.ts` (server) | The registry is sound; Prometheus is reached directly and through Grafana; the Explore link carries the query. |
| `sources.test.ts` (core) | `decide` takes a source's languages from the catalog, and takes any well-formed language when nothing runs it. |

## Consequences

- A new source kind is a package that implements the kit, plus one registry
  line. Core, the event schema and the console do not change.
- The event schema no longer refuses an unknown language. The closed enum was
  the only thing that did. A hand-edited log with `language: "sql"` now loads.
  Nothing can pull it unless a source declares `sql`.
- `GET /api/sources` changed shape. In each source, `route` and
  `grafanaDatasourceUid` gave way to `runs` and `details` (Prometheus:
  `{ route }`). Each binding gained `drillOut`, and the view gained `languages`.
  The Grafana datasource uid now leaves the server only inside the Explore
  link, and only when the source has a public URL, as before.
- The console needs that view to name a language. Until it answers, a binding
  shows its raw language id.

## Not decided here

- **The demo and the dogfood as packages.** Both are specific: the Larch Store
  seed and simulator, and the self-measurement. Both read the store, the
  settings and the app from `apps/server`, and the probes pin their paths. A
  seed registry, beside this one, would be the seam.
- **Tests that ship with a module.** The Prometheus module is tested through the
  registry in `apps/server/test/sources.test.ts`, against a fake Prometheus.
  The dogfood's test run (`TEST_PACKAGES`) does not reach into `packages/prometheus`.
- **Loading modules from configuration** instead of from code.
- **Modules outside this repository.** The kit is unversioned, because every
  module is in this workspace.

## Revisit when

- a second source kind or query language lands;
- the demo or the dogfood has to run without the server package;
- someone outside this repository writes a module, so the kit needs a version.
