// The repository's own requirements, as code (ADR 0003). Edit this file like
// code: `pnpm dogfood` turns the difference against the log into reasoned
// commands, so a tightened target becomes a new definition version and old
// readings keep their old yardstick. Each measured node names the probe that
// measures it (probes.ts); its method is appended to the description.
//
// Anchors: the invariants in CLAUDE.md, ADR 0001, ADR 0002 and the README.
// Thresholds cite the baseline measured on 2026-11-04 when they were set.
import { PASS_FAIL_UNIT, type CommandInput } from '@ru/core';

type CreateData = Extract<CommandInput, { type: 'node.create' }>['data'];
export type ModelNode = Omit<CreateData, 'id' | 'binding' | 'description'> & {
  id: string;
  description?: string;
  /** The probe that measures this node; required exactly when it has a measure. */
  probe?: string;
};

/** Measured after every merge to main and at least weekly; a day of slack before a reading counts as stale. */
const STALE_HOURS = 8 * 24;
const m = (unit: string, direction: 'higher' | 'lower', target: number, warn: number) => ({ unit, direction, target, warn, staleAfterHours: STALE_HOURS });
const pass = m(PASS_FAIL_UNIT, 'higher', 1, 1);
const zero = (unit: string) => m(unit, 'lower', 0, 0);
const OWNER = 'Maintainer';

export const DOGFOOD_MODEL: readonly ModelNode[] = [
  {
    id: 'ru', kind: 'product', title: 'Requirement Universe', priority: 'critical', owner: OWNER,
    description: 'This repository, measured by itself. Definitions live in apps/server/src/dogfood/model.ts; readings come from `pnpm dogfood` (ADR 0003).',
  },

  // --- the model tells the truth ------------------------------------------
  {
    id: 'g-truth', kind: 'goal', parentId: 'ru', title: 'The model tells the truth', priority: 'critical', dimensions: ['reliable', 'suitable'], owner: OWNER,
    description: 'The four invariants every view rests on (CLAUDE.md 1–4, ADR 0001). If one breaks, every status above it is suspect.',
  },
  {
    id: 'c-log', kind: 'constraint', parentId: 'g-truth', title: 'The event log is the only state, and its contract holds', priority: 'critical', dimensions: ['reliable'],
    description: 'CLAUDE.md invariant 1; ADR 0001 decision 4. packages/core/src/log.ts states the contract and says the store enforces it on write and on load.',
  },
  {
    id: 's-log-load', kind: 'scenario', parentId: 'c-log', title: 'A log that breaks the contract is refused on load', priority: 'critical', dimensions: ['reliable'], measure: pass,
    probe: 'log-load-refuses',
    scenario: { stimulus: 'A stored log has a gap or a repeat in its sequence numbers, or an event recorded before its predecessor', environment: 'The server opens the log at start', response: 'The store refuses to load it, naming the line, instead of serving a history it would never have written' },
    reason: 'Checks the enforcement path itself: a passing log.test.ts proves the contract is right, not that the store applies it',
  },
  {
    id: 's-log-contract', kind: 'scenario', parentId: 'c-log', title: 'The log contract’s own tests pass', priority: 'high', dimensions: ['reliable'], measure: pass, probe: 'suite-log-contract',
    scenario: { stimulus: 'The contract check meets gaps, repeats, reordering and non-canonical instants', environment: 'Unit tests', response: 'Each is refused with a reason' },
  },
  {
    id: 'c-gate', kind: 'constraint', parentId: 'g-truth', title: '`decide` is the only gate', priority: 'critical', dimensions: ['reliable'],
    description: 'CLAUDE.md invariant 2: every rule that protects the model lives in packages/core/src/decide.ts, and the API, the seed and any importer go through it.',
  },
  {
    id: 'k-gate-writes', kind: 'kpi', parentId: 'c-gate', title: 'Log writes outside the sanctioned call sites', priority: 'high', dimensions: ['reliable', 'maintainable'],
    measure: zero('call sites'), probe: 'log-writes-outside-gate', reason: 'A new write path must be added to the probe’s allowlist on purpose, with a version bump and a reason. Baseline 0',
  },
  {
    id: 's-gate-refuses', kind: 'scenario', parentId: 'c-gate', title: '`decide` refuses what would corrupt the model', priority: 'high', dimensions: ['reliable'], measure: pass,
    probe: 'suite-decide',
    scenario: { stimulus: 'Commands with no reason, a cycle, a reading without a measure, an out-of-range timestamp', environment: 'Unit tests', response: 'Each is refused with the matching error code' },
  },
  {
    id: 'r-unknown', kind: 'requirement', parentId: 'g-truth', title: 'Unknown never rolls up as green', priority: 'critical', dimensions: ['suitable'],
    description: 'CLAUDE.md invariant 3; ADR 0001 decision 2.',
  },
  {
    id: 's-unknown', kind: 'scenario', parentId: 'r-unknown', title: 'The evaluation and rollup tests pass', priority: 'critical', dimensions: ['suitable'], measure: pass, probe: 'suite-rollup',
    scenario: { stimulus: 'Unmeasured, stale and stub inputs under worst-of, weighted and quorum', environment: 'Unit tests', response: 'No parent reports on target because of an input nobody measures' },
  },
  {
    id: 'r-in-force', kind: 'requirement', parentId: 'g-truth', title: 'Readings are judged against the definition in force when observed', priority: 'high', dimensions: ['suitable'],
    description: 'CLAUDE.md invariant 4; ADR 0001 decision 4; ADR 0002 decision 2 (a new query is a new yardstick).',
  },
  {
    id: 's-in-force', kind: 'scenario', parentId: 'r-in-force', title: 'The evolution and history tests pass', priority: 'high', dimensions: ['suitable'], measure: pass, probe: 'suite-in-force',
    scenario: { stimulus: 'A target is tightened, a unit, direction or query changes', environment: 'Unit tests', response: 'Earlier readings keep their verdict; incomparable ones read unknown, never green' },
  },
  {
    id: 'k-tests', kind: 'kpi', parentId: 'g-truth', title: 'Automated test pass rate (core + server)', priority: 'high', dimensions: ['reliable'], measure: m('%', 'higher', 100, 95),
    probe: 'test-pass-rate', reason: 'Every failing test is a claim the code no longer keeps. Baseline 100%',
  },

  // --- changing it stays safe and cheap ------------------------------------
  {
    id: 'g-change', kind: 'goal', parentId: 'ru', title: 'Changing it stays safe and cheap', priority: 'high', dimensions: ['maintainable', 'flexible'], owner: OWNER,
    rollup: { strategy: 'quorum', okShare: 0.75, warnShare: 0.5 }, description: 'Rolled up by quorum: healthy when three in four of its inputs are.',
  },
  {
    id: 'c-pure', kind: 'constraint', parentId: 'g-change', title: 'packages/core stays pure', priority: 'critical', dimensions: ['flexible', 'maintainable'],
    description: 'CLAUDE.md invariant 5: no Node or DOM APIs, so the UI can import the domain.',
  },
  {
    id: 'k-core-impure', kind: 'kpi', parentId: 'c-pure', title: 'Node or DOM dependencies in packages/core', priority: 'critical', dimensions: ['flexible'], measure: zero('references'),
    probe: 'core-impurities', reason: 'Baseline 0',
  },
  { id: 'r-types', kind: 'requirement', parentId: 'g-change', title: 'The code typechecks under strict settings', priority: 'high', dimensions: ['maintainable'] },
  {
    id: 'k-type-errors', kind: 'kpi', parentId: 'r-types', title: 'TypeScript errors across packages', priority: 'high', dimensions: ['maintainable'], measure: zero('errors'),
    probe: 'type-errors', reason: 'Baseline 0',
  },
  { id: 'r-small', kind: 'requirement', parentId: 'g-change', title: 'Modules stay small enough to review in one sitting', priority: 'medium', dimensions: ['maintainable'] },
  {
    id: 'k-largest', kind: 'kpi', parentId: 'r-small', title: 'Largest source module', priority: 'medium', dimensions: ['maintainable'], measure: m('lines', 'lower', 400, 600),
    probe: 'largest-module', reason: 'Baseline 535 lines (apps/web/src/components/ActionDialog.tsx) — knowingly starts in warning',
  },
  { id: 'r-feedback', kind: 'requirement', parentId: 'g-change', title: 'Verification gives fast feedback', priority: 'medium', dimensions: ['maintainable'] },
  {
    id: 'k-verify', kind: 'kpi', parentId: 'r-feedback', title: 'Verification wall time', priority: 'medium', dimensions: ['maintainable'], measure: m('s', 'lower', 60, 120),
    probe: 'verify-seconds', reason: 'A minute keeps verification something people run before every commit. Baseline ≈ 15 s on the maintainer’s machine',
  },
  {
    id: 'r-coverage', kind: 'requirement', parentId: 'g-change', title: 'The domain core is thoroughly tested', priority: 'medium', dimensions: ['maintainable'],
    description: 'Not yet refined. Candidate measure: statement coverage of packages/core.', reason: 'Left as a stub: coverage needs @vitest/coverage-v8, which the repo does not install yet',
  },

  // --- the console stays fast and frugal ----------------------------------
  {
    id: 'g-fast', kind: 'goal', parentId: 'ru', title: 'The console stays fast and frugal at realistic scale', priority: 'high', dimensions: ['efficient'], owner: OWNER,
    description:
      'ADR 0001 recomputes the projection per request and names reading volume as its revisit trigger; this goal watches that trigger. ADR 0004: the suite pins how cost scales (machine-independent), the probes measure how big it is on one machine — time behaviour, resource use and capacity, at demo scale and after a week of live signals.',
  },
  { id: 'r-view', kind: 'requirement', parentId: 'g-fast', title: 'A full view answers within interactive time', priority: 'high', dimensions: ['efficient'] },
  {
    id: 'k-view-demo', kind: 'kpi', parentId: 'r-view', title: 'Universe view at demo scale (median)', priority: 'high', dimensions: ['efficient'], measure: m('ms', 'lower', 100, 250),
    probe: 'view-ms-demo', reason: 'ADR 0001 quotes ~40 ms at ~3k events. Baseline 31 ms',
  },
  {
    id: 'k-view-week', kind: 'kpi', parentId: 'r-view', title: 'Universe view after a week of live signals (median)', priority: 'medium', dimensions: ['efficient'],
    measure: m('ms', 'lower', 400, 1000), probe: 'view-ms-week', reason: 'The README’s simulator volume for a week (~124k events). Baseline 246 ms; a breach is ADR 0001’s cue for snapshots',
  },
  { id: 'r-write', kind: 'requirement', parentId: 'g-fast', title: 'A command or a reading lands within interactive time', priority: 'high', dimensions: ['efficient'] },
  {
    id: 'k-write-week', kind: 'kpi', parentId: 'r-write', title: 'Recording one reading after a week of live signals (median)', priority: 'high', dimensions: ['efficient'],
    measure: m('ms', 'lower', 150, 400), probe: 'write-ms-week', reason: 'Every command and webhook push projects the whole log before `decide` sees it. Baseline 68 ms',
  },
  {
    id: 's-capacity', kind: 'scenario', parentId: 'r-write', title: 'A full ingestion batch is accepted in one request', priority: 'medium', dimensions: ['efficient'], measure: pass, probe: 'suite-capacity',
    scenario: { stimulus: 'A batch at the documented limit with every field at its longest, then one reading more', environment: 'API tests', response: 'The full batch is accepted whole; one more is refused with 400 and leaves nothing behind — never cut off first by the body limit' },
  },
  { id: 'r-start', kind: 'requirement', parentId: 'g-fast', title: 'A restart is back within seconds, even with a week of history', priority: 'medium', dimensions: ['efficient', 'operable'] },
  {
    id: 'k-start-week', kind: 'kpi', parentId: 'r-start', title: 'Loading a week of live signals to the first view (median)', priority: 'medium', dimensions: ['efficient'],
    measure: m('s', 'lower', 3, 6), probe: 'start-s-week', reason: '`pnpm dev` restarts the server on every code change. Baseline 1.6 s, most of it checking each stored line against the schema',
  },
  {
    id: 'r-frugal', kind: 'requirement', parentId: 'g-fast', title: 'Cost grows with the log and the model, and no faster', priority: 'high', dimensions: ['efficient'],
    description: 'Re-projecting per request is linear in the log by design (ADR 0001). A second fold per node, per day or per reading, or an answer that grows with the readings, would not be.',
  },
  {
    id: 's-log-passes', kind: 'scenario', parentId: 'r-frugal', title: 'Every request reads the log a fixed number of times', priority: 'high', dimensions: ['efficient'], measure: pass, probe: 'suite-log-passes',
    scenario: { stimulus: 'Ten times the nodes, sixty ribbon days instead of fourteen, a batch of a thousand readings instead of one', environment: 'Unit and API tests that count reads of the event array', response: 'Reads per stored event stay the same, and a batch is decided against one projection' },
  },
  {
    id: 's-answer-size', kind: 'scenario', parentId: 'r-frugal', title: 'Answers grow with the model, not with the readings', priority: 'medium', dimensions: ['efficient'], measure: pass, probe: 'suite-answer-size',
    scenario: { stimulus: 'Ten times the readings under the same nodes; a month of readings every six minutes', environment: 'Unit tests', response: 'The universe view keeps its size; sparklines, series and the change feed stay within their caps' },
  },
  {
    id: 'k-heap-week', kind: 'kpi', parentId: 'r-frugal', title: 'Heap held after loading a week of live signals', priority: 'medium', dimensions: ['efficient'], measure: m('MB', 'lower', 64, 128),
    probe: 'heap-mb-week', reason: 'The whole log lives in memory between requests. Baseline 37 MB (~300 bytes per event)',
  },
  {
    id: 'k-payload-week', kind: 'kpi', parentId: 'r-frugal', title: 'Universe response after a week of live signals (gzip)', priority: 'low', dimensions: ['efficient'], measure: m('kB', 'lower', 16, 32),
    probe: 'universe-gzip-week', reason: 'Every open console fetches it every 5 s. Baseline 6.8 kB',
  },
  {
    id: 's-bench', kind: 'scenario', parentId: 'g-fast', title: 'Timing benchmarks measure the same workload on every run', priority: 'high', dimensions: ['efficient', 'reliable'], measure: pass, probe: 'suite-bench-workload',
    scenario: { stimulus: 'The benchmark workloads are generated twice; the demo or the simulator’s fast signals change', environment: 'Unit tests over the workloads exactly as the probes get them', response: 'Both runs give identical events, and a change in their size fails until every workload probe moves to a new version' },
    reason: 'Without it, an edit to demo.ts would silently change what every timing means (ADR 0004)',
  },
  { id: 'r-light', kind: 'requirement', parentId: 'g-fast', title: 'The console loads light', priority: 'medium', dimensions: ['efficient', 'usable'] },
  {
    id: 'k-bundle', kind: 'kpi', parentId: 'r-light', title: 'UI JavaScript shipped (gzip)', priority: 'medium', dimensions: ['efficient'], measure: m('kB', 'lower', 110, 150),
    probe: 'ui-bundle-gzip', reason: 'Baseline 88.9 kB; the target leaves room for features, not for a second framework',
  },

  // --- it bends without breaking ------------------------------------------
  {
    id: 'g-flex', kind: 'goal', parentId: 'ru', title: 'It adapts, connects and outlasts its own versions', priority: 'medium', dimensions: ['flexible'], owner: OWNER,
    description:
      'ADR 0005: flexibility is a set of promises — old logs keep loading, answers do not depend on where the server runs, the documented API is the API, settings are documented, components meet at fixed seams, and the look changes in one place. The suite pins the promises as contracts; static probes count what breaks them.',
  },
  {
    id: 'r-history', kind: 'requirement', parentId: 'g-flex', title: 'History written today stays readable by every later version', priority: 'high', dimensions: ['flexible', 'maintainable'],
    description: 'Longevity and evolvability: the log is the only state (ADR 0001), so a version that cannot read an old log has lost the product’s past. packages/core/src/log.ts names the frozen fixture this rests on.',
  },
  {
    id: 's-old-logs', kind: 'scenario', parentId: 'r-history', title: 'A log written by an earlier version loads and reads as it did', priority: 'high', dimensions: ['flexible', 'reliable'], measure: pass, probe: 'suite-frozen-history',
    scenario: { stimulus: 'Frozen logs in the oldest shape the schema promises to load and in the shape written today, holding every event type between them', environment: 'API tests over apps/server/test/fixtures, each file pinned by its hash', response: 'Each loads through the store and the log contract, and projects to the statuses, verdicts, bindings and links it had when written' },
    reason: 'log.ts promised this fixture before it existed (ADR 0005)',
  },
  {
    id: 'r-anywhere', kind: 'requirement', parentId: 'g-flex', title: 'It behaves the same wherever it runs, beside whatever else runs there', priority: 'medium', dimensions: ['flexible', 'operable'],
    description: 'Portability, co-existence and configurability: the same log gives the same answers in any time zone, two universes never touch, and every setting is documented.',
  },
  {
    id: 's-time-zones', kind: 'scenario', parentId: 'r-anywhere', title: 'The same log gives the same answers in any time zone', priority: 'medium', dimensions: ['flexible'], measure: pass, probe: 'suite-time-zones',
    scenario: { stimulus: 'The server process runs at UTC+14, UTC−10 and in a zone with summer time', environment: 'API tests that switch TZ in-process and check the switch took', response: 'The seeded demo and every view are byte-identical to UTC; an instant without a zone is refused instead of read in local time' },
    reason: 'An `asOf` without a zone was read in the server’s own time zone until ADR 0005',
  },
  {
    id: 's-coexist', kind: 'scenario', parentId: 'r-anywhere', title: 'Two universes share a process or a machine without touching', priority: 'medium', dimensions: ['flexible'], measure: pass, probe: 'suite-coexistence',
    scenario: { stimulus: 'Writes to one of two apps in one process; the demo and the dogfood servers started with no settings', environment: 'API tests', response: 'The other app answers byte for byte as before; the two servers default to different logs and ports' },
  },
  {
    id: 'k-config-undocumented', kind: 'kpi', parentId: 'r-anywhere', title: 'Settings read from the environment that the README does not name', priority: 'medium', dimensions: ['flexible', 'operable'],
    measure: zero('settings'), probe: 'config-undocumented', reason: 'A setting nobody can find is not configurable. Baseline 0, after the README gained its configuration table',
  },
  {
    id: 'r-plug', kind: 'requirement', parentId: 'g-flex', title: 'Other tools plug in through documented contracts and fixed seams', priority: 'medium', dimensions: ['flexible', 'operable'],
    description: 'Integrability, interchangeability and replaceability: the README’s API is the API, the UI reaches the server through one module, core is used through its entry, and only the collector talks to a source adapter (ADR 0002, decision 4).',
  },
  {
    id: 's-api-contract', kind: 'scenario', parentId: 'r-plug', title: 'The API the README documents is the API the server serves', priority: 'medium', dimensions: ['flexible', 'usable'], measure: pass, probe: 'suite-api-contract',
    scenario: { stimulus: 'The README’s API table, its command list and its webhook example', environment: 'API tests reading README.md', response: 'Every documented route is served and every served route documented, the command list matches the schema, and the example is accepted as written' },
  },
  {
    id: 'k-seams', kind: 'kpi', parentId: 'r-plug', title: 'Imports and network calls that cross a component boundary', priority: 'medium', dimensions: ['flexible', 'maintainable'], measure: zero('crossings'), probe: 'seam-crossings',
    reason: 'Each crossing is a place a component can no longer be replaced on its own. Baseline 0',
  },
  { id: 'r-theme', kind: 'requirement', parentId: 'g-flex', title: 'Its look changes in one place', priority: 'low', dimensions: ['flexible', 'usable'] },
  {
    id: 'k-theme-literals', kind: 'kpi', parentId: 'r-theme', title: 'Colours outside the theme tokens', priority: 'low', dimensions: ['flexible', 'usable'], measure: m('colours', 'lower', 0, 10), probe: 'theme-literals',
    reason: 'Baseline 7: three in styles.css and four in the status icons in bits.tsx — knowingly starts in warning',
  },

  // --- running it exposes nothing it shouldn't -----------------------------
  { id: 'g-safe', kind: 'goal', parentId: 'ru', title: 'Running it exposes nothing it shouldn’t', priority: 'high', dimensions: ['secure'], owner: OWNER },
  {
    id: 'c-secrets', kind: 'constraint', parentId: 'g-safe', title: 'No secret enters the log, and no caller chooses the address', priority: 'critical', dimensions: ['secure'],
    description: 'ADR 0002 decisions 1, 3 and 5: tokens by env-var name only, bindings choose among configured sources, pulled readings are reserved to the collector, loopback-only with sources configured.',
  },
  {
    id: 's-sources', kind: 'scenario', parentId: 'c-secrets', title: 'Source configuration and pull guards hold', priority: 'critical', dimensions: ['secure'], measure: pass,
    probe: 'suite-sources',
    scenario: { stimulus: 'Inline tokens, credentialed URLs, a pusher claiming pull provenance, a non-loopback host with sources configured', environment: 'Unit and API tests', response: 'Each is refused before anything is fetched or written' },
  },
  { id: 'r-deps', kind: 'requirement', parentId: 'g-safe', title: 'No known high or critical advisories in dependencies', priority: 'high', dimensions: ['secure'] },
  {
    id: 'k-vulns', kind: 'kpi', parentId: 'r-deps', title: 'Known high or critical advisories', priority: 'high', dimensions: ['secure'], measure: zero('advisories'), probe: 'audit-high',
    reason: 'Advisories appear without a commit, so offline runs leave this unknown rather than green',
  },
  {
    id: 'r-identity', kind: 'requirement', parentId: 'g-safe', title: 'Commands know who is asking', priority: 'high', dimensions: ['secure'],
    description: 'Not yet refined. The README lists identity as deliberately missing; ADR 0002 keeps sources loopback-only until it exists.',
    reason: 'Left as a stub: there is no authentication to measure yet',
  },

  // --- people can follow it end to end -------------------------------------
  {
    id: 'g-usable', kind: 'goal', parentId: 'ru', title: 'People can follow it end to end', priority: 'medium', dimensions: ['usable', 'suitable', 'operable'], owner: OWNER,
    rollup: { strategy: 'weighted', okAt: 0.9, warnAt: 0.6 }, description: 'Rolled up by priority-weighted score: the README tour, the real browser loop, and docs that lead somewhere.',
  },
  {
    id: 's-story', kind: 'scenario', parentId: 'g-usable', title: 'The demo tells the documented story', priority: 'high', dimensions: ['suitable'], measure: pass, probe: 'suite-demo-story',
    scenario: { stimulus: 'The README’s five-minute tour', environment: 'The seeded demo, pinned by apps/server/test/app.test.ts', response: 'Every status the tour promises is the one the model reports' },
  },
  {
    id: 's-smoke', kind: 'scenario', parentId: 'g-usable', title: 'The evolution loop works in a real browser', priority: 'high', dimensions: ['usable'], measure: pass, probe: 'ui-smoke',
    scenario: { stimulus: 'Refine a stub into a KPI, record a reading, revise its target with and without a reason', environment: 'Headless Chromium against a throwaway demo server running the fresh build', response: 'Each step lands, the reason is enforced, the change heads the feed, no console errors' },
  },
  {
    id: 'k-links', kind: 'kpi', parentId: 'g-usable', title: 'Broken relative links in Markdown docs', priority: 'low', dimensions: ['usable'], measure: zero('links'), probe: 'doc-links',
    reason: 'Baseline 0',
  },
];
