# ADR 0014 — Traceability: one step from a requirement to its metrics and its code, and back

**Status:** Accepted (PoC) · **Date:** 2026-11-06 · **Builds on:**
[ADR 0001](0001-one-graph-append-only-evolution.md),
[ADR 0003](0003-the-repository-measures-itself.md),
[ADR 0013](0013-modules-bring-what-core-does-not-know.md)

## Context

A person reading a universe moves between four kinds of thing:

- **requirements**: goals, requirements and constraints;
- **metrics**: KPIs and scenarios, and the query behind each;
- **code**: the files and tests that implement or verify a requirement;
- **everything else**: tickets, documents, decisions, runbooks, dashboards,
  designs.

From any one of them they should reach the others in one step, and get back.
Only the first two are in the graph today, and even those are joined one level
at a time:

| From → to | Today |
|---|---|
| requirement → metric | The contributor tiles, one level down. *Follow the signal*, which follows only the first driver |
| metric → requirement | The breadcrumb (primary parent only) and the *Also counts toward* chips (direct links only) |
| metric → its source | The query, and a drill-out link for a live, pulled binding (ADR 0002, ADR 0013) |
| node → elsewhere | One `dashboardUrl` |
| node → code | Nothing |
| code → node | Nothing |
| anything → a node | The outline's filter. It matches titles and ids, and narrows the tree rather than jumping |

Three gaps stand out:

- **The dogfood knows its code and doesn't show it.** The dogfood knows which
  code backs each of its nodes, but nobody can follow it there. Probe selectors
  and allowlists stay in TypeScript, and file paths sit in descriptions as prose
  (*c-log*: "packages/core/src/log.ts states the contract…").
- **Depth hides the connections.** A requirement whose metrics sit two levels
  down (requirement → scenario → KPI) shows them only by drilling. A KPI linked
  under two requirements shows its direct parents, not the goals above them.
- **The feed's related nodes are hidden.** `relatedIds` (the old and new parent,
  the link target) are computed for the feed and never shown.

**Words.** Here a **link** is a contribution edge: `node.link`, *Also counts
toward*. It rolls up. This ADR keeps the word for that edge. It calls a pointer
from a node to something outside the graph a **reference**.

**Constraints:**

- The log is permanent (invariant 1). A pointer that changes often would add
  events to it for ever.
- A stub stays unknown until something observes it (ADR 0001, decision 2).
  Code that exists observes nothing.
- Core names no integration (invariant 6). A code host is one.

## Decision

### 1. The navigation contract

This matrix is the acceptance check. Each cell is one step, from the focus view
or from a single search.

| From \ to | Requirement | Metric | Code | Elsewhere |
|---|---|---|---|---|
| **Requirement** | breadcrumb, tiles | *Metrics beneath*, all levels, through links | *Implementation*, its own and beneath | *References* |
| **Metric** | *Counts toward*, all levels, through links | tiles | *Implementation* | *References*, the query and its drill-out |
| **Code** (a file or directory) | its reference page | its reference page | the code host's job | — |
| **Elsewhere** (a URL) | its reference page; a permalink back | its reference page | — | — |

From anywhere, **Jump to** finds:

- a node, by title, id or description;
- a metric, by the text of its query;
- a file, by path.

### 2. Three kinds of edge, one rule each

| Edge | Between | Rolls up | Reason | Written by |
|---|---|---|---|---|
| **link** (exists) | node → node | yes | required | a person, the dogfood sync |
| **reference** (new) | node → a place outside the graph | never | optional | a person, the dogfood sync, the tag scan |
| **tag** (new) | code → node | no: it becomes a reference | — | whoever writes the code |

**References are inert.**

- They change no status, coverage, backlog, signal or ribbon.
- A stub with ten code references is still an unknown stub, because
  implemented is not observed (ADR 0009).
- Evidence arrives only as readings. A test suite verifies a requirement
  through a scenario's pass/fail reading, as the dogfood's suite probes
  already do.

**Code does not become nodes.** A node with nothing to measure is a stub, and a
stub is unknown. If every file were a node, each would sit in the backlog of
everything above it and keep its parent from reading green. Code has no status
here. It has a place.

### 3. What a reference is

```ts
Reference = {
  kind: string,               // code, test, doc, adr, ticket, dashboard, runbook, design, or a team's own
  target:
    | { repo: string, path: string, symbol?: string }  // a place in a repository
    | { url: string },                                  // anywhere else
  label?: string,             // at most 140 characters
  origin?: 'tag',             // harvested from a tag (decision 5); absent means added by hand
}
```

**Kind** is an open id, spelled like a query language (ADR 0013):
`^[a-z][a-z0-9-]{0,31}$`.

- Core suggests eight kinds, with labels, in `REFERENCE_KINDS`.
- The console shows `code` and `test` under *Implementation*, and the rest
  under *References*, grouped by kind.
- A kind decides only how a reference is grouped and labelled, never what it
  does. A team's own kind (`incident`, `contract`) therefore needs no change to
  core. This covers the custom links.

**A repository target** names a configured repository by id (spelled like a
source id) and a path in it.

- The path is relative and `/`-separated, at most 400 characters. It has no
  leading `/`, no `.` or `..` segment, no backslash and no control character.
- A trailing `/` names a directory ("the checkout service implements this").
- `symbol` is a name to find in the file, such as a function or a `describe`
  title. It has at most 120 characters and no line break.

**No line numbers.** The log is permanent, and lines move with every edit, so a
stored line would either add an event at every edit or go stale. A path and a
symbol survive a refactor, and both can be checked (decision 6).

**A URL target** is http(s) only. The schema checks it with `HttpUrlSchema`, as
it checks `dashboardUrl`. The server never fetches it.

**The repository need not be configured.** The log never depends on the
server's configuration. A reference to a repository the server does not know
still says where the code is; it just has no browse link. This is ADR 0013's
rule for a binding nobody pulls.

**Identity** is decided by `refKey(ref)`, a fixed-order tuple: origin (`hand`
when absent), kind, then either repository, path and symbol, or the URL.

- It is computed in memory and never stored. Events carry the reference itself
  (decision 4), so a later change to the key leaves every logged event
  replayable.
- It is a tuple, not a joined string, so no path or symbol character can make
  two references collide.
- It does not compare whole objects with `JSON.stringify`, which is what
  `decide`'s `same()` does: that depends on the order of keys.
- The label is not part of the key. To relabel a reference, remove it and add
  it again.
- A harvested and a hand-added reference to the same file are two references,
  so a vanished tag never removes what a person added. The console shows them
  as one row.

**`dashboardUrl` stays.** Frozen logs carry it (ADR 0005), and it remains the
dashboard a measured node's *Source* block opens. Further dashboards are
references of kind `dashboard`. Nothing is migrated.

**A reference is not part of the definition.** It doesn't change what a number
means; the binding does (ADR 0002, decision 2). So references are not
versioned with the definition, and no reading is judged differently because one
changed (invariant 4).

### 4. Events and the gate

| Command | Event | `decide` refuses |
|---|---|---|
| `node.create`, with optional `refs` (at most 100) | `node.created` | duplicate keys (400) |
| `node.reference { id, ref, reason? }` | `node.referenced` | an unknown node (404); a key already on it (409); a 101st reference (400) |
| `node.unreference { id, ref, reason? }` | `node.unreferenced` | an unknown node (404); no reference with that key on it (409) |

`node.unreferenced` carries the reference it removes (origin, kind and target;
the label is ignored), as `node.unlinked` carries its target. It never carries
an encoded key.

- **Separate add and remove events, not a list on `node.edit`.** A person and
  the tag scan could each write a full list, and each would overwrite the
  other's. Separate events give the same result in either order. This mirrors
  `node.linked` and `node.unlinked`.
- **A deprecated node may be referenced**, as it may be edited.
- **The reason is optional.** A reason is required where a change can move a
  status or a yardstick (ADR 0001, decision 4; `NEEDS_REASON` in
  `operability.test.ts`).
  - A reference moves neither, so it ranks with a wording edit.
  - The timeline still records who made the change and when.
  - The tag scan writes `Tagged at <sha>` or `Tag gone at <sha>`.
- **Timeline lines** read `“Checkout server errors (5xx rate)” now references
  code larch-shop:services/checkout/src/payments.ts`, and `… no longer
  references …`.
- **`origin: 'tag'` cannot be enforced** without authentication, and there is
  none (ADR 0010).
  - The console never sends it.
  - It never offers to remove a harvested reference, which would come back at
    the next scan. The tag is removed instead.

### 5. Tags: the reference written next to the code

A tag is a reference written in the code. It moves with the code and is
reviewed with it.

**Grammar.**

- A tag is `orrery:` followed at once by node ids, comma-separated:
  `orrery:k-5xx` or `orrery:r-checkout,k-5xx`.
- The token must not follow a letter, a digit, `/`, `.`, `-` or `@`, so
  `@orrery/core` and URLs don't match.
- Ids are checked by `NodeIdSchema`.
- The scanner doesn't parse comments. It works the same in every language, so a
  tag inside a string counts too.

**What a tag records.** One reference per node and file:
`{ kind, target: { repo, path }, origin: 'tag' }`.

- The kind is `test` when the path matches a test pattern (`**/*.test.*`,
  `**/*.spec.*`, `**/test/**`, `**/tests/**`, `**/e2e/**`), else `code`.
- There is no symbol and no line.

**What it scans.** The tracked text files of one repository, at a committed
revision, minus exclusion patterns.

- By default the patterns are `**/*.md` and `**/fixtures/**`, so prose that
  shows the syntax (this ADR included) and frozen logs are never harvested.
- A test that needs a tag builds its text at runtime, as tests already build
  credentials.

**Which revision.** The scan writes only from the tip of the branch the
repository is configured with, on a clean tree.

- Anything else, such as a feature branch or a PR check, runs with
  `--dry-run`, which prints the plan and writes nothing.
- Otherwise CI on every branch would add and remove the same references in a
  permanent log.
- The scan learns the branch from `GET /api/repos` (decision 7), so the
  server's configuration is the one place that names it.

**Reconciling.** A scan of repository *A* compares the tags it finds with only
those references whose `origin` is `tag` and whose repository is *A*.

- It sends `node.reference` for each new tag and `node.unreference` for each
  vanished one.
- They go through the API, and so through `decide` (invariant 2).
- **Each importer owns one origin.** The scan reconciles harvested references
  only. The dogfood sync (decision 9) reconciles hand references only. Neither
  ever removes the other's, so they cannot undo each other at every run.

**Strictness.**

- A tag that names no node in the universe fails the scan. The scan prints each
  one with its file and writes nothing. Like a batch of readings, the scan is
  all or nothing.
- A tag that names a deprecated node is harvested, as any reference to a
  deprecated node is, and reported as a warning.
- A hand reference into the scanned repository whose path or symbol is missing
  is reported. With `--strict` it fails the scan too.

**Where it lives.** In `apps/server/src/tags/`, run as
`pnpm tags --repo <id> [--root <dir>] [--dry-run] [--strict]`.

- It sits beside the dogfood runner, which is also a client of the API.
- It loads only core and reaches the server over HTTP (`ORRERY_API`), so
  `seam-crossings` v2 needs no new rule.
- A package of its own waits until another repository's CI runs it (*Not
  decided here*).

### 6. References that rot are counted

- **Tags** cannot dangle unnoticed: the scan refuses them (decision 5).
- **Hand references into a repository** are checked where the code is. The scan
  checks every reference into the repository it scans: the path must exist, and
  the symbol must occur in the file as a whole word.
- **URLs** are never fetched, so never checked. The console shows each with its
  host, so a reader sees where it leads.
- **This repository** gets a new dogfood probe, `references-dangling` v1, with a
  target of 0, under *Its code stays easy to read, test and update*. It counts:
  - dogfood references into this repository whose path or symbol is missing
    from the committed tree;
  - tags naming no node, the same test the scan applies.

  In the dogfood run, the harvest is a step of the sync rather than a separate
  scan. Tags naming no node are left out of its plan and counted here, the rest
  are harvested, and the run goes on to record its readings. So a dangling tag
  shows as a breach of this KPI instead of stopping the run.

### 7. Where references resolve

**Repositories are server settings**, like sources. `ORRERY_REPOS_FILE` names a
JSON file:

```json
[{ "id": "larch-shop", "label": "Larch shop", "branch": "main",
   "browse": "https://git.larch.example/larch/shop/src/branch/main/{path}" }]
```

- `browse` is an http(s) URL with `{path}` exactly once and nothing else in
  braces.
- It carries no credentials, because every browser sees it.
- `settings.ts` parses it strictly. A bad file stops the server with a message
  naming the variable (ADR 0007).

**`GET /api/repos` returns that list.** The universe view stays a function of
the log and the time. What depends on configuration comes from its own route,
as with `GET /api/sources`.

**Core builds the link**, in `referenceHref(ref, repos)`.

- It encodes each path segment, substitutes the path, and returns the URL only
  if it parses as http(s), else null.
- The console renders the result through `safeHref`, like every other link.
- A `javascript:` URL cannot get in through any of the three ways a link is
  built: not from the log (the schema), not from the template (the startup
  check), and not from the substitution (the encoding and the final check).
- Core names no code host (invariant 6). GitHub, GitLab and Gitea differ only
  in the template.

### 8. What the console shows

The logic that decides what is shown lives in core, with tests there. The
console only renders it.

**Connections** sit in the focus view, under the head, as four collapsed
sections with a count each. The focus view still shows one level, and crossing
levels is one click away, like *Follow the signal*.

- *Counts toward*: `countsToward(view, id)`.
  - Every node this one contributes to, through primary parents and links,
    nearest first, each marked with the edge it came by.
  - A KPI linked under two requirements lists both, and the goals above them.
- *Metrics beneath*: `metricsBelow(view, id)`.
  - Every active measured node beneath, through children and links, with its
    status, value and target.
  - The promise is stated on each node's own measurement,
    `evaluation.measurement.status`, not on its rolled-up status. A measured
    node with children can roll up to unknown while its own measurement is
    known.
  - The ones whose own measurement is known, plus the node itself if its own
    is, are exactly the leaves its coverage counts as measured. The ones whose
    own measurement reads unknown are in its backlog.
  - So coverage, backlog and this list never disagree. `evaluateUniverse`
    counts a leaf as measured when `measurement.status !== 'unknown'`, and
    `backlogBelow` already reads the same field for the unmeasured ones.
- *Implementation*.
  - The node's own `code` and `test` references.
  - `referencesBelow(view, id)` adds those on nodes beneath, grouped by file,
    each naming the nodes that hold it.
- *References*: every other kind, grouped by kind. `dashboardUrl` comes first
  among dashboards.

Every node listed is a button that focuses it. Every target leads two ways:

- out, with `↗`, to its browse link or URL when it has one;
- in, to its reference page.

**The reference page** is at `?repo=<id>&path=<path>` or `?url=<url>`.

- It shows the target, its link out, and `referencedBy(view, target)`, with each
  node's status and the top of its *Counts toward*.
- `referencedBy` lists every node that references the target. For a file it adds
  those that reference a directory above it. For a directory it adds those that
  reference a file below it.
- The URL is a permalink. A code review, an editor, a PR template or a CI job
  can link a file to its requirements.

**Jump to** sits in the top bar. Ctrl+K (⌘K on a Mac) moves focus to it.

- The shortcut takes a modifier on purpose. A bare `/` is a shortcut of one
  printable character. WCAG 2.2 SC 2.1.4 (Character Key Shortcuts, Level A)
  then requires that it can be turned off or remapped, or that it works only
  while the control has focus. ADR 0011 claims AA.

- `searchUniverse(view, q)` ranks results in this order:
  1. an exact id;
  2. a title prefix;
  3. a word in a title;
  4. a reference's path, symbol or label;
  5. the text of a binding's query;
  6. a description.
- A metric name such as `http_requests_total` finds every KPI whose query uses
  it.
- It is a combobox with a listbox popup, and it does what that role promises:
  the arrow keys move, Enter opens and Escape closes (ADR 0011).
- The outline's filter stays: it narrows the tree, while Jump to goes straight
  to a node.

**Permalinks in.**

- `?focus=<id>` already deep-links. The console now sets the page title to the
  node's title, so a tab or bookmark says where it leads.
- A Grafana panel, a ticket or a runbook links back to its node this way.
- The tag in the code names the node id, which Jump to opens.

**The feed** shows `relatedIds` as buttons: the old and new parent of a move, and
the target of a link.

**+ Reference** is a dialog on every node in a live view.

- It asks for:
  - a kind, suggested or typed;
  - a repository, path and symbol, or a URL;
  - a label;
  - an optional reason.
- Hand references get a remove button. Harvested ones say to remove the tag in
  the code instead.

**Time travel** projects references at `asOf`, like everything else, so a past
view shows the references known then. Browse links still point at the
configured branch, not at the code as it was.

### 9. The demo and the dogfood adopt it

**The demo.**

- Larch Store gets a fictional repository, `larch-shop`, as it already has a
  fictional Grafana:
  - the 5xx KPI and *Checkout is short and dependable* reference the checkout
    service and its tests;
  - the EU residency constraint references a legal memo and its ticket;
  - availability references its runbook.
- The references go on the existing create steps, so the workload's event
  counts stay as they are and `BENCH_SHAPES` is unchanged (ADR 0004).
- `apps/server/repos.example.json` configures the repository.
- The tour gains a step: from the 5xx KPI, open the payments file's page and
  see both requirements it backs.

**The dogfood.**

- `ModelNode` takes `refs` from the `node.create` command, so `model.ts` can
  declare them.
- `planSync` turns differences in hand references into reference and
  unreference commands, with no reason.
  - It compares only references with no `origin`. `model.ts` never declares a
    harvested reference, so treating those as drift would remove at every run
    what the harvest adds back (decision 5).
  - Today its diff keys are a hard-coded list, so a new field would drift
    unnoticed.
  - `dogfood.test.ts` gains the case.
- File paths and ADRs cited as prose in descriptions become references, of kind
  `code` and `adr`.
- A suite probe's selectors become `test` references, which the sync generates
  the way it generates a probe's binding. The path is the test file and the
  symbol is the `describe` title.
- The dogfood run harvests this repository's tags under the repository id
  `orrery`, on the same terms as its readings: committed code only, from
  `main`.

## Where it will be pinned

| Pinned by | What it holds |
|---|---|
| `decide.test.ts` (core) | The refusals in decision 4. A harvested and a hand reference to one file coexist. Unreferencing finds the reference by its key, whatever its label |
| `evaluate.test.ts`, `safety.test.ts` (core) | References are inert: adding and removing them leaves every evaluation identical, across the safety grid |
| `suitability.test.ts` (core) | `metricsBelow` agrees with coverage and the backlog. `countsToward` crosses links. `referencedBy` crosses directories. `searchUniverse` ranks as listed. `referenceHref` encodes and returns nothing but http(s) |
| `security.test.ts` (core) | A path with `..`, a leading `/`, a backslash or a control character is refused. A 101st reference is one `too_big` issue |
| `flexibility.test.ts` | `events.v3.jsonl` (both new events, references on create, a harvested reference), with its hash in `FROZEN`. The README's API table gains `GET /api/repos`, and its command list gains `node.reference · unreference` |
| `operability.test.ts` | `ORRERY_REPOS_FILE` in `SETTINGS`, with a README configuration row, read only in `settings.ts`. The `ORRERY_API` row lists `tags` among its users |
| `app.test.ts` | The demo's references, and the story around them |
| `dogfood.test.ts` | `planSync` plans nothing when hand references match, reference or unreference when they don't, and never touches a harvested one. Every dogfood reference into the repository resolves, as describe titles already must |
| the tag scan's tests (server) | The grammar's boundaries, the exclusions and test patterns, and that a reconcile touches one repository and harvested references only. A dangling tag is refused, and so is a write off the configured branch or from a dirty tree |
| `efficiency.test.ts` | The universe view grows linearly in references, and the reverse index is built once per view. Counted, never timed |
| `smoke.mjs`, `a11y.mjs` | From the 5xx KPI to the payments file's page and back to a requirement, then Jump to. The reference page, an open Jump to and the + Reference dialog join `VIEWS` |
| `references-dangling` v1 (dogfood) | The dogfood's references and tags all point at something |
| `claim-mutants` (version bump) | A new row in the README's *The idea* table, *Traceability*, joins `NEEDS`, with breaks that leave it unmet: `metricsBelow` skipping links, `referencedBy` ignoring directories |
| `docs/tour.gif` | Re-recorded with the new tour step |

## Consequences

- **Both directions work.** Every node can be reached from the code that names
  it, and every file from the requirements it serves. This needs no new kind of
  node and no change to evaluation.
- **The log gains two event types.** Frozen v1 and v2 logs load unchanged.
- **References ride every universe poll**, every 5 s while live. At most 100
  per node is negligible at PoC scale, and the efficiency suite counts the
  growth.
- **Repositories need configuring for links out.** Without them, references
  still navigate inside the console, but have no link out.
- **The tag scan is a second importer**, beside the dogfood sync. Both go
  through `decide`.
- **`origin: 'tag'` is a convention**, not a guarantee, until there is
  authentication.

## Not decided here

- **Line-level anchors, and code as it was at `asOf`.** These need a revision
  per moment.
- **Editor links** (`vscode://`). They are not http(s), so the schema and
  `safeHref` refuse them.
- **Checking URLs.** The server fetches nothing a person follows.
- **Relations between nodes that don't roll up**, such as "depends on" or
  "conflicts with". Only links join nodes.
- **Harvesting from elsewhere**: ticket mentions, PR descriptions, commit
  trailers.
- **The tag scan as a package** that other repositories' CI installs, and
  authentication for it.
- **The order of scans.** A scan of an older commit after a newer one would undo
  the newer one. The reason records the commit, so it can be seen.

## Revisit when

- a product's CI runs the scan (package it, and version the grammar);
- people need line anchors, or the code as it was;
- references per node grow enough to matter in the universe payload;
- a code host needs more than a template, such as an authenticated browse link.
