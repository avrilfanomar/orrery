# ADR 0010 — Security: the operator's browser is the way in, and nothing secret comes out

**Status:** Accepted (PoC) · **Date:** 2026-11-05 · **Builds on:**
[ADR 0002](0002-metrics-bind-to-configured-sources.md),
[ADR 0003](0003-the-repository-measures-itself.md),
[ADR 0007](0007-operability-what-whoever-runs-it-can-rely-on.md),
[ADR 0008](0008-reliability-what-it-acknowledged-survives.md),
[ADR 0009](0009-safety-no-one-acts-on-a-green-it-has-not-earned.md)

## Context

The arc42 quality model tags 28 qualities `#secure`:
- access control, accountability, authenticity, compliance, confidentiality,
  consent management, cyber security;
- data integrity, data localization, data minimization, data protection,
  data sovereignty;
- faultlessness, governability, immunity, injection resistance, integrity;
- intrusion detection, intrusion prevention, non-repudiation, patient safety,
  privacy, resilience, resistance, safety, securability, security and
  vulnerability.

Until now the model's security goal, *Running it exposes nothing it shouldn't*
(`g-safe`), held:
- the source guards of ADR 0002;
- `k-vulns`, which was in breach;
- the identity stub.

The README says it plainly: commands are unauthenticated. ADR 0002 drew the
consequence. With metric sources configured, the server listens on loopback
only, because anyone who can reach the API can bind a query and read the answer
back from the log, which makes the server's token an oracle.

That rested on an assumption: that only the operator can reach a loopback
server. It is false. The operator's own browser reaches it, and so does every
page the operator opens. A page cannot read another origin's answers, but two
things get around that:
- **DNS rebinding.** A name the attacker controls is pointed at 127.0.0.1.
  The page then has the server's own origin, so it can read the answers and
  send writes.
- **Cross-site writes.** Any page can send a write it cannot read.

So the browser is the way in. The rest of this ADR is about what a caller can
get past and what can leak out.

**Risk identification.** H1 to H5 and H7 were reproduced against a running
server before they were fixed. The oracle in H1 follows from what was
reproduced; it was not run with sources configured. H6 is the audit's finding,
and H8 is hardening.

| # | Hazard | What happened |
|---|---|---|
| H1 | **Any Host was answered.** A page on a rebound name reads and writes as if it were the console | `GET /api/universe` with `Host: attacker.example` returned 200; a `node.create` with it returned 201. With sources configured, the page can bind a query and read its answer back from the log: the oracle ADR 0002 meant to close |
| H2 | **Cross-site writes were refused by accident.** A page may send `text/plain`, form or multipart bodies to another origin without asking. Fastify parses `text/plain` into a string, and the command schema then refuses it with 400 | Nothing checked where a write came from. A body parser added later (form, or `text/plain` read as JSON) would have opened every command to every page |
| H3 | **No security headers.** Nothing forbade framing the console, loading code from elsewhere into it, or sniffing a type | A page could frame the console and trick a click on *Publish* or *Record*. No policy stood behind React's escaping |
| H4 | **The ingest token guarded a route, not readings.** `RU_INGEST_TOKEN` was checked only on `POST /api/readings` | A `reading.record` command with no token and `"source": "prometheus"` returned 201. Any caller could also sign as `ingest`, the webhook's actor, in `x-actor` |
| H5 | **One request could stall the server.** zod 3 reads every element of an array before it checks the array's length limit | One 3.8 MB command holding 1.9 million links blocked the event loop for 12.7 s and grew the process to about 1.9 GB. Two at once could exhaust the heap. This is GHSA-mrhx-c7xc-m3w5. The new test, run under zod 3, crashed vitest with "JavaScript heap out of memory" |
| H6 | **Known advisories in what it runs** (`k-vulns` = 4): @fastify/static, path traversal past route guards (high, GHSA-83w8-p2f5-377r); zod (high, H5); tinypool, prototype-pollution gadgets to code execution (2 critical, dev only through vitest) | The server serves its UI through the first and parses every request with the second |
| H7 | **A refusal left no trace.** A 401 was a normal reply, so nothing reached the server's log | An operator could not tell that someone was guessing tokens |
| H8 | **The token was compared with `!==`.** It returns at the first byte that differs | Not shown to be exploitable over a network, but free to fix |

Already in place, and not news here:
- tokens are named by environment variable and never stored, returned or put
  in the log (ADR 0002);
- bindings choose among configured sources, and the request path is fixed;
- upstream error text is never passed on;
- pulled provenance is reserved to the collector;
- links are http(s) only, in the event schema;
- every field a command carries has a length limit, and the body (4 MiB) and
  batch (5,000) are capped;
- a 500 carries a request id and no detail (ADR 0007);
- every change records who, when and why (`s-audit`).

## Decision

### 1. A web page cannot act through the API (H1–H3)

Every request passes `guard` (`apps/server/src/guard.ts`) in an `onRequest`
hook, before its body is read.
- **It answers only to names no one else's DNS can point here.** That means:
  - IP addresses;
  - `localhost` and the names under it, which browsers resolve to loopback
    themselves;
  - the name in `HOST`, when it is a name;
  - the names in the new setting `RU_ALLOWED_HOSTS` (`.example.org` covers
    every name under it).

  Any other `Host` gets a 403 naming the setting. Rebinding needs a name the
  attacker controls, and the browser puts that name in `Host`. The check is on
  the name, not the port, so the Vite proxy and `app.inject` (`localhost:80`)
  pass. A request with no `Host` comes from no browser and is let through.
- **A write from another origin is refused.** A `POST` whose `Origin` names a
  different host and port from its `Host`, or `null`, gets a 403. The console's
  own writes carry its origin. curl, CI, the simulator and the dogfood runner
  send no `Origin`, so nothing changes for them.
  - In development, Vite's proxy sets the target's `Host` but keeps the page's
    `Origin`, so `vite.config.ts` restates the origin for pages Vite itself
    served. A page from anywhere else keeps its own and is refused. The rewrite
    trusts `Host`, so it rests on Vite's own host check, which refuses a
    rebound name ("Blocked request. This host … is not allowed") as long as
    `server.allowedHosts` stays at its default.
- **Every answer carries the security headers:**
  - `Content-Security-Policy: default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
  - `X-Frame-Options: DENY`;
  - `X-Content-Type-Options: nosniff`;
  - `Referrer-Policy: no-referrer`;
  - `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy:
    same-origin`.

  The built console loads only its own files, so the policy allows nothing
  else, `eval` included.
- **The policy found something on its first run.** zod 4 probes for `new
  Function` as each schema is built, and the browser reports the probe as a
  violation even though zod catches it. The smoke test's console-error step
  failed on it. The console now sets zod's `jitless` mode in `no-eval.ts`,
  imported before anything that builds a schema. The server keeps the compiled
  parsers.

### 2. A reading needs the ingest token, by any route (H4, H8)

With `RU_INGEST_TOKEN` set, a `reading.record` command needs the same bearer
token as the webhook. Without it, the command gets the webhook's 401, "A valid
ingest token is required".
- **The token guards readings, not the model.** Other commands stay as open as
  the README says. Guarding them is the identity question, still a stub.
- **The console cannot record a reading by hand while a token is set.** It has
  no way to hold the token. The README says so.
- **Callers may not sign as `ingest` or `collector`** (`RESERVED_ACTORS`).
  Those are the server's own writers. A command with either name in `x-actor`,
  in any case, gets a 400.
- **The comparison takes constant time.** It compares SHA-256 digests with
  `timingSafeEqual`.

### 3. A refusal leaves a trace (H7)

Each refusal goes through `refuse()`, which logs a warning under the request
id. The line says what was refused (`host`, `origin`, `ingest token`), the
method, the URL, the remote address and the Host or Origin it named. It never
holds the `Authorization` header.

### 4. Dependencies without known high advisories (H5, H6)

| Package | From | To | Why |
|---|---|---|---|
| zod | 3.25.76 | 4.6.7 | H5. It now stops at a collection's limit: the same 3.8 MB request is refused in 73 ms |
| @fastify/static | 8.3.0 | 10.1.8 | Path traversal past route guards |
| vitest, @vitest/coverage-v8 | 3.2.7 | 4.1.12 | vitest 4 no longer uses tinypool |

- **`pnpm audit` now counts 0 high and 0 critical.** Two moderate advisories
  remain (glob and minimatch, through @fastify/static); `audit-high` does not
  count them.
- **The suites passed unchanged under the new majors.** zod words its own
  messages a little differently: "Invalid input: expected object, received
  string" where zod 3 said "Expected object, received string". The
  repository's own messages, which the tests pin, are unchanged.
- **One change to core's code.** core loads no environment's types, and zod 3
  had leaked the global `URL` into them. `schema.ts` now declares the one
  constructor it uses.
- **pnpm's release-age policy did its job.** It refused @fastify/static
  10.1.10, published the day before. The lockfile holds 10.1.8 rather than an
  exception to the policy.

### 5. Nothing secret comes out

- **A canary test for source tokens.** An upstream that echoes the server's
  token back sees the token appear in no event, no answer and no line the
  server prints. It echoes the token in a 500, in a `bad_data` error, in an
  HTML page, in a series label and in a thrown exception. The internal address
  does not appear either. ADR 0002 decided this; until now only the happy path
  checked it.
- **A probe for the whole history.** `secrets-in-history` reads every line any
  commit on any ref ever added, and counts the lines shaped like a credential.
  - What it looks for: private keys, and AWS, GitHub, Grafana, Slack, Stripe
    live, Google, npm and Anthropic or OpenAI keys, and JSON web tokens.
  - Why history: a credential deleted later is still in every clone.
  - What it reports: the shape, file and commit, never the value, because the
    report lands in the append-only dogfood log.
  - Why the shapes are strict: the made-up tokens in tests
    (`glsa_secret_token_value`) do not match. Its own test builds its fakes at
    runtime, so the repository never holds a line it would flag.

### 6. The suite pins what must always hold

| `describe` | File | What it pins | Scenario |
|---|---|---|---|
| a web page the operator visits cannot act through the API | `apps/server/test/security.test.ts` | Allowed names, from IP addresses to listed domains, are answered; rebound, look-alike and malformed names get 403 on reads and writes. Writes from other origins and the null origin are refused, and the console's own writes and clients with no Origin go through. `text/plain`, form and multipart bodies never become a change, even with no Origin. The headers are on pages, deep links, API answers and refusals. The real server takes `RU_ALLOWED_HOSTS` | `s-browser-boundary` |
| readings need the ingest token by any route | same | No token, a wrong one, a prefix, a bare token or another scheme gets 401 by either route and writes nothing. The right token works by both. Other commands stay open. Without a token both routes take readings. The reserved actors are refused | `s-ingest-token` |
| a refusal leaves a trace | same | Host, Origin and token refusals are each a warning with the request id, the remote address and what was named; neither the guess nor the token appears | `s-refusals-traced` |
| no secret leaves the server | same | The canary above | `s-no-secret-out` |
| an oversized request is refused at its first limit | `packages/core/test/security.test.ts` | Two million links or dimensions give one problem, the limit, whichever command carries them | `s-oversized` |

The smoke test needed no new step: its console-error step already fails on any
policy violation in the built console. It found the zod probe above.

### 7. The dogfood measures what the suite cannot

| Probe | Node | Baseline | Target / warning |
|---|---|---|---|
| `secrets-in-history` | *Lines shaped like a credential anywhere in the repository's history* | 0 in 18 commits | 0 / 0 |
| `audit-high` | *Known high or critical advisories* | 0, from 4 | 0 / 0 |

### 8. The model

`g-safe` keeps its id and title, gains a description, and still rolls up
worst-of. The identity stub keeps it unknown until commands know who is asking.

| Node | Inputs |
|---|---|
| *No secret enters the log, and no caller chooses the address* (constraint, existing) | `s-sources`; `s-no-secret-out`; `k-secrets-history` |
| *A web page the operator visits cannot act through the API* | `s-browser-boundary` |
| *A reading needs the ingest token, by any route, when one is set* | `s-ingest-token` |
| *A refused request leaves a trace for the operator* | `s-refusals-traced` |
| *A request sized to the body limit costs no more to refuse than a small one* | `s-oversized` |
| *No known high or critical advisories in dependencies* (existing) | `k-vulns` |
| *Commands know who is asking* (stub, existing) | — |

### 9. Where each `#secure` quality is covered

| Quality | Covered by |
|---|---|
| Access control | §1 and §2. Who may change the model is not controlled: the identity stub |
| Intrusion prevention | §1, §2, §5. There is no rate limit or lockout; a long random token makes guessing moot, a short one does not |
| Intrusion detection | §3 |
| Authenticity | Of readings: the ingest token on every route (§2), and pulled provenance reserved to the collector (ADR 0002). Of people: not provided |
| Accountability | Every change records who, when and why (`s-audit`, ADR 0007), and callers cannot sign as the server's own writers (§2). But authors name themselves, so this holds only among people who trust each other |
| Non-repudiation | **Not provided.** Authors are self-declared, nothing is signed, and a hand-edited log that keeps the contract loads (ADR 0009) |
| Confidentiality | Source tokens and internal addresses never leave (§5, ADR 0002); a 500 carries no detail (ADR 0007). The universe itself is readable by anyone who can reach the API; the default is loopback |
| Injection resistance | Commands are parsed against a schema with a limit on every field. Log lines are JSON. There is no SQL and no shell; the dogfood passes argument arrays. A query goes in a form body to a fixed path (ADR 0002). Links are http(s) only. React escapes, and the CSP stands behind it. Bodies a page may send without asking never become commands (§1) |
| Resistance | §4 (H5); the body, batch and field limits; the feed limit is clamped |
| Vulnerability, immunity | §4, `k-vulns`, and pnpm's release-age policy on new versions; §5 |
| Integrity, data integrity | The log contract on write and load, and acknowledged writes that survive (ADR 0008); `decide` as the only gate (ADR 0001). There is no tamper evidence |
| Resilience, faultlessness | ADR 0008 |
| Data protection, privacy, data minimization | The log holds what people type and the names they sign with, and nothing else about them. Nothing is sent to anyone: no telemetry, outbound requests only to sources the operator configured, and a console that loads nothing from elsewhere (the CSP enforces it). The append-only log can never forget a name or a typed value: erasure is impossible by design. The dogfood log holds the maintainer's git user name 50 times; it is gitignored, and `git log --all -- data/` shows it was never committed |
| Data localization, data sovereignty | Everything stays in one local file, on the operator's machine; no third party holds any of it |
| Consent management | Not applicable: nothing tracks people, and nothing is collected beyond what an author types |
| Governability, securability | Exposure is an operator's explicit choice, checked at start (`HOST`, `RU_ALLOWED_HOSTS`, `RU_ALLOW_REMOTE`, `RU_INGEST_TOKEN`; ADR 0007). One choke point, `guard`, holds every check, and CLAUDE.md names it |
| Compliance | The licences of what it ships (ADR 0007). No regulated data, and no compliance is claimed |
| Safety | ADR 0009 (`g-harmless`) |
| Patient safety | Not applicable |
| Security, cyber security | The goal as a whole |

## Consequences

- **Behaviour changes:**
  - A request naming a host the server does not answer to gets 403. If you
    reach it by a name other than `HOST`, set `RU_ALLOWED_HOSTS`.
  - A write whose `Origin` is not the server's own gets 403.
  - With `RU_INGEST_TOKEN` set, a reading recorded through commands needs the
    token. The console cannot record one by hand.
  - `x-actor: ingest` and `x-actor: collector` get 400.
  - Every answer carries the security headers.
- **No stored event changes,** and no status in the past: the change is to who
  may write, not to how anything is judged.
- **The cost:**
  - the core suite gains one test (45 ms) and the server suite thirteen: ten in
    `security.test.ts`, one in `dogfood.test.ts` and two refused settings in
    `operability.test.ts`. `pnpm verify` stays at about 25 to 30 s;
  - the UI ships 103.5 kB gzipped, up from 90.1 kB, because zod 4 is larger.
    `k-bundle` stays on target (110);
  - `model.ts` grows to 516 lines. `k-largest` stays in warning (target 400,
    warning 600);
  - **`core-coverage` is version 2.** vitest 4 maps coverage to statements
    through the syntax tree. On the same code it counts 734 statements where
    vitest 3 counted 1,098, and reads 89.23% where vitest 3 read 93.44%.
    `k-core-coverage` therefore starts the new yardstick in warning (target
    90, warning 80) with no change to the code. The target is kept. The largest
    gap is still `format.ts` (53%), followed by `project.ts` (80%) and
    `decide.ts` (84%). The flags the other
    vitest probes pass still work: a shuffled run's order changes with its seed,
    and `false-green-mutants` measured, so `--bail` and `--no-cache` were
    accepted;
  - `k-outdated` drops from 71.4% to 57.1%. Functions over cognitive
    complexity 15 stay at 16.
- **Findings, not fixed here:**
  - **Reads need no credentials.** Anyone who can reach the server reads the
    whole universe, binding queries included, which name internal metrics.
  - **With `RU_ALLOW_REMOTE=1` the oracle is back** for everyone on that
    network, by design: the setting says the network is trusted.
  - **The server speaks plain HTTP.** Off loopback, put TLS in front of it.
  - **One token, no rotation.** It is changed by restarting with a new value,
    and readings in flight are refused meanwhile.
  - **Nothing limits the rate of requests.**

Each test and probe was shown to fail by breaking the code on purpose:

| Deliberate break | What turned red |
|---|---|
| the Host check removed | the names test, the real-server test and the trace test |
| the Origin check removed | the other-origin test and the trace test |
| the headers not sent; `frame-ancestors` dropped from the policy | the headers test |
| a `text/plain` parser that reads JSON added | the bodies test |
| the token checked on the webhook only | the token test |
| a prefix of the token accepted | the token test |
| the reserved actors emptied | the actor test |
| refusals not logged | the trace test |
| `RU_ALLOWED_HOSTS` not passed to the app by `server.ts` | the real-server test |
| a source's error body passed on as the failure's detail | the canary test |
| zod 3 under the oversized test | vitest ran out of heap |
| zod 4 without `jitless` in the console | the smoke test's console-error step |
| an AWS key pattern made too strict | the scanner test (`dogfood.test.ts`) |

## Not decided here

- **Identity and authorization.** Who may change the model, and who may read it
  (the stub *Commands know who is asking*, README next steps). With it come the
  console holding a token, signed authorship, and non-repudiation.
- **Tamper evidence for the log,** a hash chain or signatures, so a hand edit
  shows.
- **Forgetting.** An append-only log cannot erase a name or a typed value. If
  personal data must be removable, it needs encryption per subject (crypto-
  shredding) or a log that keeps references, not values.
- **Rate limiting and lockout** on refusals.
- **TLS in the server itself,** rather than in front of it.

## Revisit when

- **A route, port or socket is added:** it passes `guard`, and a route that
  records a reading checks the token.
- **The console needs something from elsewhere** (a font, a CDN, an inline
  script): change the policy deliberately, here, not to quiet the smoke test.
- **A body parser is added:** the bodies test must still pass.
- **Identity lands:** the ingest token becomes one credential among several,
  and accountability and non-repudiation get real tests.
- **A secret is found in history:** rotate it first. Rewriting history does not
  reach the clones that already hold it.
