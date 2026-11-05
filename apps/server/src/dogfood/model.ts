// The repository's own requirements, as code (ADR 0003). Edit this file like
// code: `pnpm dogfood` turns the difference against the log into reasoned
// commands, so a tightened target becomes a new definition version and old
// readings keep their old yardstick. Each measured node names the probe that
// measures it (probes.ts); its method is appended to the description.
//
// Anchors: the invariants in CLAUDE.md, ADR 0001, ADR 0002 and the README.
// Thresholds cite the baseline measured on 2026-11-04 when they were set.
import { PASS_FAIL_UNIT, type CommandInput } from '@orrery/core';

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
    id: 'orrery', kind: 'product', title: 'Orrery', priority: 'critical', owner: OWNER,
    description: 'This repository, measured by itself. Definitions live in apps/server/src/dogfood/model.ts; readings come from `pnpm dogfood` (ADR 0003).',
  },

  // --- the model tells the truth ------------------------------------------
  {
    id: 'g-truth', kind: 'goal', parentId: 'orrery', title: 'The model tells the truth', priority: 'critical', dimensions: ['reliable', 'suitable'], owner: OWNER,
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
    id: 's-log-written', kind: 'scenario', parentId: 'c-log', title: 'The store writes only what it would load, and any cut a crash leaves can be recovered', priority: 'critical', dimensions: ['reliable'],
    measure: pass, probe: 'suite-log-written',
    scenario: { stimulus: 'An event the contract refuses is about to be written; the log is cut at any byte; a crash left out the last line break', environment: 'The store on a real file', response: 'The write is refused and nothing changes; every cut loads what came before it or names the line to delete; the next event starts a line of its own' },
    reason: 'ADR 0008: until then the store checked only the schema, so s-log-load read 0',
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
    id: 'r-unknown', kind: 'requirement', parentId: 'g-truth', links: ['r-earned'], title: 'Unknown never rolls up as green', priority: 'critical', dimensions: ['suitable'],
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
    id: 'g-change', kind: 'goal', parentId: 'orrery', title: 'Changing it stays safe and cheap', priority: 'high', dimensions: ['maintainable', 'flexible'], owner: OWNER,
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
    description: 'Every rule that protects the model lives in packages/core (CLAUDE.md invariant 2), so its own tests are the safety net for every change to it. Refined in ADR 0006, once @vitest/coverage-v8 was installed.',
  },
  {
    id: 'k-core-coverage', kind: 'kpi', parentId: 'r-coverage', title: 'Statements of packages/core its own tests execute', priority: 'medium', dimensions: ['maintainable'], measure: m('%', 'higher', 90, 80),
    probe: 'core-coverage', reason: 'Baseline 92.7% (branches 80.6%); format.ts, at 51%, is the gap. Below 80% the domain is no longer thoroughly tested',
  },

  // --- it stays easy to read, test and update ------------------------------
  {
    id: 'g-clear', kind: 'goal', parentId: 'orrery', title: 'Its code stays easy to read, test and update', priority: 'medium', dimensions: ['maintainable'], owner: OWNER,
    description:
      'ADR 0006: analysability, testability, modularity and updateability. The suite pins what must always hold — every status and refusal explains itself, nothing reads a hidden clock, every dependency is declared and locked. Static probes count what makes the code harder to follow: tangled functions, import cycles, copied blocks. A sibling of the quorum goal on change, so its warnings are not outvoted.',
  },
  { id: 'r-simple', kind: 'requirement', parentId: 'g-clear', title: 'Any function can be followed in one reading', priority: 'medium', dimensions: ['maintainable'] },
  {
    id: 'k-complex', kind: 'kpi', parentId: 'r-simple', title: 'Functions above cognitive complexity 15', priority: 'medium', dimensions: ['maintainable'], measure: m('functions', 'lower', 10, 20), probe: 'complex-functions',
    reason: 'Baseline 17 of 679 functions, led by decide (68) and applyEvent (57) — knowingly starts in warning. Fifteen is SonarSource’s default limit; the worst are split as they are next touched, never to hit the number',
  },
  {
    id: 'r-modular', kind: 'requirement', parentId: 'g-clear', title: 'Dependencies point one way, and each piece of logic lives in one place', priority: 'medium', dimensions: ['maintainable'],
    description: 'Modularity and loose coupling. A cycle means no module in it can be understood, tested or replaced without the others; a copied block is a fix that has to be made twice.',
  },
  {
    id: 'k-cycles', kind: 'kpi', parentId: 'r-modular', title: 'Import cycles among source modules', priority: 'medium', dimensions: ['maintainable'], measure: zero('cycles'), probe: 'import-cycles',
    reason: 'Baseline 0 at run time. The dogfood probe modules import types from probes.ts in a loop; types are erased, so that one is not counted',
  },
  {
    id: 'k-duplication', kind: 'kpi', parentId: 'r-modular', title: 'Source lines in blocks repeated elsewhere', priority: 'low', dimensions: ['maintainable'], measure: m('%', 'lower', 3, 5), probe: 'duplicated-lines',
    reason: 'Baseline 0.84% (38 of 4,519 lines). Three percent is SonarSource’s default gate for duplicated lines',
  },
  {
    id: 'r-diagnosable', kind: 'requirement', parentId: 'g-clear', title: 'A status or a refusal leads straight to its cause', priority: 'high', dimensions: ['maintainable', 'usable'],
    description: 'Analysability and debuggability: "why is this red?" is the question the console exists to answer (ADR 0001), and a refused command must say what to fix.',
  },
  {
    id: 's-explained', kind: 'scenario', parentId: 'r-diagnosable', title: 'Every status and every refusal explains itself', priority: 'high', dimensions: ['maintainable', 'usable'], measure: pass, probe: 'suite-explained',
    scenario: { stimulus: 'Every node of the demo on each of its days, the freshly seeded dogfood model, and a catalogue of bad requests', environment: 'API tests', response: 'Each status has a reason, its drivers are its own inputs and never healthy, and following them ends where the signal starts; each refusal has the matching code and names what is wrong' },
  },
  {
    id: 'r-testable', kind: 'requirement', parentId: 'g-clear', title: 'Every part can be tested without faking the world', priority: 'medium', dimensions: ['maintainable'],
    description: 'Testability: the time and any randomness reach the domain and the server as arguments, read only at the composition roots, so a test passes them in instead of mocking globals.',
  },
  {
    id: 's-no-hidden-inputs', kind: 'scenario', parentId: 'r-testable', title: 'Answers depend only on the log and the clock passed in', priority: 'medium', dimensions: ['maintainable', 'reliable'], measure: pass, probe: 'suite-no-hidden-inputs',
    scenario: { stimulus: 'The system clock set to 1999 and then to 2099, Math.random returning different numbers', environment: 'API tests over the seeded demo and dogfood logs, with the server’s clock injected', response: 'The seeds, every view and a decided command are byte-identical' },
  },
  {
    id: 'k-hidden-inputs', kind: 'kpi', parentId: 'r-testable', title: 'Clock and random reads outside the composition roots', priority: 'medium', dimensions: ['maintainable'], measure: zero('reads'), probe: 'hidden-inputs',
    reason: 'A new one must be added to the probe’s allowlist on purpose, with a version bump and a reason. Baseline 0',
  },
  {
    id: 'r-updatable', kind: 'requirement', parentId: 'g-clear', title: 'Its dependencies can be updated without surprises', priority: 'medium', dimensions: ['maintainable', 'secure'],
    description: 'Updateability and upgradeability: every package declares what it imports, the lockfile records exactly what the manifests ask for, and nothing falls far behind its current major.',
  },
  {
    id: 's-dependencies', kind: 'scenario', parentId: 'r-updatable', title: 'Every package declares what it imports, and the lockfile records exactly that', priority: 'medium', dimensions: ['maintainable'], measure: pass, probe: 'suite-dependencies',
    scenario: { stimulus: 'Every bare import in each workspace package, and every importer in pnpm-lock.yaml', environment: 'Tests reading the manifests and the lockfile, offline', response: 'No package relies on another’s dependency, and every locked range is the one its manifest asks for' },
    reason: 'The dogfood probes import the TypeScript compiler, which only the root declared until ADR 0006',
  },
  {
    id: 'k-outdated', kind: 'kpi', parentId: 'r-updatable', title: 'Direct dependencies a major version or more behind', priority: 'low', dimensions: ['maintainable'], measure: m('%', 'lower', 25, 75), probe: 'outdated-majors',
    reason:
      'Baseline 71.4%, 10 of 14: react and react-dom, vite, vitest and its coverage provider, typescript, zod, @fastify/static, @vitejs/plugin-react, concurrently — knowingly starts in warning. A major behind is a migration owed, not a defect (k-vulns covers what is unsafe): one in four in flight is normal, three in four means upgrades have stopped. Releases appear without a commit, so offline runs leave this unknown',
  },

  // --- the console stays fast and frugal ----------------------------------
  {
    id: 'g-fast', kind: 'goal', parentId: 'orrery', title: 'The console stays fast and frugal at realistic scale', priority: 'high', dimensions: ['efficient'], owner: OWNER,
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
    id: 'k-start-week', kind: 'kpi', parentId: 'r-start', links: ['r-recovers'], title: 'Loading a week of live signals to the first view (median)', priority: 'medium', dimensions: ['efficient', 'operable'],
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
    id: 'g-flex', kind: 'goal', parentId: 'orrery', title: 'It adapts, connects and outlasts its own versions', priority: 'medium', dimensions: ['flexible'], owner: OWNER,
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
    description: 'Integrability, interchangeability and replaceability: the README’s API is the API, the UI reaches the server through one module, a package is used through its entry, and only the collector talks to a source adapter (ADR 0002, decision 4). A query language or a source kind is a module: core names none, a module loads only core and the kit, and the server installs modules in one registry (ADR 0013).',
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

  // --- whoever runs it can install, watch and recover it --------------------
  {
    id: 'g-operate', kind: 'goal', parentId: 'orrery', title: 'Whoever runs it can install, start, watch and recover it', priority: 'medium', dimensions: ['operable'], owner: OWNER,
    description:
      'ADR 0007: installability, diagnosability, observability, recovery, auditability and licensing, from the point of view of whoever runs the server. The suite pins the promises — a bad setting or a damaged log stops it at start and says what to fix, a failure leaves a trail, a restart or a source outage heals by itself, every change says who, when and why, and the docs name commands that exist. Probes check a fresh clone, settings read past their checks, and dependency licences.',
  },
  {
    id: 'r-installable', kind: 'requirement', parentId: 'g-operate', title: 'A fresh clone runs with the documented commands', priority: 'medium', dimensions: ['operable', 'flexible'],
    description: 'Installability and deployability: nothing it needs is untracked, ignored or left over in a working copy, and the commands the README and CLAUDE.md give are the ones the scripts define.',
  },
  {
    id: 's-fresh-clone', kind: 'scenario', parentId: 'r-installable', title: 'A fresh clone installs, builds and serves the console', priority: 'medium', dimensions: ['operable'], measure: pass, probe: 'fresh-clone',
    scenario: { stimulus: 'HEAD cloned into an empty directory', environment: 'A frozen, offline install from the package store; no data, no build output, no settings', response: 'The UI builds, and the server starts, seeds the demo and serves the console' },
  },
  {
    id: 's-documented-ops', kind: 'scenario', parentId: 'r-installable', title: 'The commands and the Node floor the docs state are the real ones', priority: 'low', dimensions: ['operable', 'usable'], measure: pass, probe: 'suite-documented-operations',
    scenario: { stimulus: 'Every pnpm command in README.md and CLAUDE.md, the Node floor, and a relative path in a setting', environment: 'Tests reading the docs and the manifests', response: 'Each command names a script that exists; engines, .nvmrc, the README and @types/node agree on the floor; a relative path is read from where the command was typed' },
    reason: 'The README’s `ORRERY_SOURCES_FILE=sources.json pnpm dev` looked for the file in apps/server until ADR 0007',
  },
  {
    id: 'r-start-checked', kind: 'requirement', parentId: 'g-operate', title: 'A bad setting or a damaged log stops it at start, naming what to fix', priority: 'high', dimensions: ['operable', 'reliable'],
    description: 'Diagnosability and controllability: a setting it cannot use is refused before anything is opened or served, never read as something else, and a refusal names the variable, file or line at fault.',
  },
  {
    id: 's-startup-refusals', kind: 'scenario', parentId: 'r-start-checked', title: 'Every setting is taken or refused by name, and a damaged log names its line', priority: 'high', dimensions: ['operable', 'reliable'], measure: pass, probe: 'suite-startup-refusals',
    scenario: { stimulus: 'Malformed, empty and valid settings, a log cut off mid-write, a line that is not an event, a missing or broken sources file', environment: 'API tests, and the real server and simulator entry points', response: 'Each fault is refused before anything is opened or served, naming the variable and value or the file and line; an empty setting takes its default, and a valid one takes effect' },
    reason: 'Until ADR 0007 an empty HOST bound every interface, an empty PORT a random one, an empty ORRERY_DATA_FILE kept the log in memory, and a malformed ORRERY_SIM_TICK_MS pushed readings every millisecond',
  },
  {
    id: 'k-settings-unchecked', kind: 'kpi', parentId: 'r-start-checked', title: 'Settings read outside settings.ts', priority: 'medium', dimensions: ['operable'], measure: zero('reads'), probe: 'settings-unchecked',
    reason: 'A setting read anywhere else skips the empty-means-unset rule and the check. Baseline 0, after ADR 0007 moved eighteen reads in seven files into settings.ts',
  },
  {
    id: 'r-observable', kind: 'requirement', parentId: 'g-operate', title: 'From outside, an operator can tell it is up, what it holds and why a request failed', priority: 'medium', dimensions: ['operable'],
    description: 'Observability: /api/health says how much history it holds and when the last event landed; a failed request gives the caller an id and the log the detail under the same id; a failing source is named in /api/sources (ADR 0002).',
  },
  {
    id: 's-visible', kind: 'scenario', parentId: 'r-observable', title: 'Health tells the truth, and an internal error leaves a trail', priority: 'medium', dimensions: ['operable', 'secure'], measure: pass, probe: 'suite-visible-failures',
    scenario: { stimulus: 'Health checks before and after a write, and a request that fails inside the server', environment: 'API tests reading the server’s log', response: 'Health reports the events held and the last one’s instant; the failed request gets 500 with an id and no internal detail, and the log holds the error and its stack under that id' },
    reason: 'Until ADR 0007 an internal error was logged without its request id, and the caller got no id to quote',
  },
  {
    id: 'r-recovers', kind: 'requirement', parentId: 'g-operate', title: 'It comes back by itself after a restart or a source outage', priority: 'medium', dimensions: ['operable', 'reliable'],
    description: 'Autonomy and time to recover: the log is the only state (ADR 0001), so a restart rebuilds exactly what was there; the collector catches up on what a source missed (ADR 0002). Restart time is linked here from the efficiency goal.',
  },
  {
    id: 's-recovery', kind: 'scenario', parentId: 'r-recovers', title: 'A restart gives back the same universe, and pulls catch up after an outage', priority: 'medium', dimensions: ['operable', 'reliable'], measure: pass, probe: 'suite-recovery',
    scenario: { stimulus: 'The server restarted on its log; a source down for two hours, then back', environment: 'API tests with an injected clock and fetch', response: 'Every answer is byte-identical after the restart; while the source is down nothing is recorded and the node reads unknown, and once it is back every missed instant is recorded once, with the state change logged both ways' },
  },
  {
    id: 'r-audit', kind: 'requirement', parentId: 'g-operate', title: 'Every change can be traced to who made it, when and why', priority: 'high', dimensions: ['operable', 'suitable'],
    description: 'Auditability and traceability: the log keeps an author, an instant and — for every change of meaning, place or lifecycle — a reason (ADR 0001); the change feed shows each; and what was known on a past day is answered the same way however much is written later.',
  },
  {
    id: 's-audit', kind: 'scenario', parentId: 'r-audit', title: 'Every change says who, when and why, and the past stays as it was known', priority: 'high', dimensions: ['operable', 'suitable'], measure: pass, probe: 'suite-on-the-record',
    scenario: { stimulus: 'Both seeded universes, every evolution command sent under a named author, and later writes including a reading backdated before an earlier day', environment: 'API tests', response: 'Every event has an author and an exact instant, every change of meaning has a reason, the feed reports each one faithfully, and the earlier day’s answers do not change' },
  },
  {
    id: 'r-licensed', kind: 'requirement', parentId: 'g-operate', title: 'Everything it ships may be shipped under its licence', priority: 'medium', dimensions: ['operable', 'secure'],
    description: 'Legal requirements: the repository is Apache-2.0, and the server’s runtime and the UI bundle carry their dependencies with them.',
  },
  {
    id: 'k-licences', kind: 'kpi', parentId: 'r-licensed', title: 'Shipped dependencies under a licence not approved', priority: 'medium', dimensions: ['operable'], measure: zero('packages'), probe: 'licences-unapproved',
    reason: 'Baseline 0 of 90. Build and test tools are not shipped and not counted; among them, a platform binary rollup pulls in declares no licence',
  },

  // --- running it exposes nothing it shouldn't -----------------------------
  // --- what it acknowledged survives ---------------------------------------
  {
    id: 'g-rely', kind: 'goal', parentId: 'orrery', title: 'What it acknowledges survives, and a fault stays where it happens', priority: 'high', dimensions: ['reliable'], owner: OWNER,
    description:
      'ADR 0008: durability, fault tolerance, fault isolation and recoverability. The suite pins what must always hold: a failed write changes nothing, one process writes a log, a fault fails one request or one binding, and a stop or a kill is followed by a clean start. The dogfood kills a real server mid-write and runs the suite in an order nobody chose. The log contract itself stays under the model telling the truth. Worst-of, so one broken promise shows.',
  },
  {
    id: 'r-durable', kind: 'requirement', parentId: 'g-rely', title: 'An acknowledged change survives a failed write, a second writer and a kill', priority: 'critical', dimensions: ['reliable'],
    description: 'An event is acknowledged only once it is written and flushed; a write that fails is cut back; a seed or a reset replaces the file in one step; the log’s lock refuses a second writer.',
  },
  {
    id: 's-failed-write', kind: 'scenario', parentId: 'r-durable', title: 'A write the disk refuses changes nothing, and the store stays writable', priority: 'critical', dimensions: ['reliable'], measure: pass, probe: 'suite-failed-write',
    scenario: { stimulus: 'The disk refuses a batch partway; a new log cannot be written; the store is read-only or closed', environment: 'The real server under a file-size limit; the store on a real file', response: 'The request fails with an id; nothing of it is served or kept; the old log stays whole; a write that fits then lands' },
  },
  {
    id: 's-one-writer', kind: 'scenario', parentId: 'r-durable', title: 'One process writes a log, and a lock left by a dead one is taken over', priority: 'high', dimensions: ['reliable', 'operable'], measure: pass, probe: 'suite-one-writer',
    scenario: { stimulus: 'A second store, a reset or another server opens a log a server is writing; a lock names a process that is gone', environment: 'The real server and reset as processes', response: 'Each is refused, naming the writer’s pid and its lock, and the log stays as it was; the dead writer’s lock is taken over' },
  },
  {
    id: 'k-lost-on-kill', kind: 'kpi', parentId: 'r-durable', links: ['r-restartable'], title: 'Acknowledged readings missing after a kill mid-write', priority: 'high', dimensions: ['reliable'], measure: zero('readings'), probe: 'kill-recovery',
    reason: 'Baseline 0 of 13 450 acknowledged readings, back in 0.8 s by itself. Acknowledging a write 50 ms before it is written read 350',
  },
  {
    id: 'r-contained', kind: 'requirement', parentId: 'g-rely', title: 'A fault fails one request or one binding, never the server', priority: 'high', dimensions: ['reliable'],
    description: 'Fault isolation and robustness: hostile input is refused with a reason, a pull that cannot be recorded fails its binding, a source that hangs holds up no other, and a clock that steps back is absorbed.',
  },
  {
    id: 's-contained', kind: 'scenario', parentId: 'r-contained', title: 'Hostile input, a failing pull, a hanging source and a clock step stay contained', priority: 'high', dimensions: ['reliable'], measure: pass, probe: 'suite-contained',
    scenario: { stimulus: 'Malformed, deep, oversized or impossible input; a pull whose answer cannot be recorded; a source that never answers; the clock stepping back an hour', environment: 'The app in-process, with the collector', response: 'Each request is refused with a reason and the log is unchanged; that binding reads failing and the server answers on; other sources pull on; writes land in order' },
  },
  {
    id: 'r-restartable', kind: 'requirement', parentId: 'g-rely', links: ['r-recovers'], title: 'After a stop or a crash it starts again by itself, with everything it acknowledged', priority: 'high', dimensions: ['reliable', 'operable'],
  },
  {
    id: 's-restart', kind: 'scenario', parentId: 'r-restartable', title: 'A SIGTERM lets go cleanly, and a start after a SIGKILL needs no hand', priority: 'high', dimensions: ['reliable', 'operable'], measure: pass, probe: 'suite-restart',
    scenario: { stimulus: 'SIGTERM; SIGKILL', environment: 'The real server as a process', response: 'It exits 0 and releases its lock; the next start takes over the dead writer’s lock and serves every acknowledged write' },
  },
  {
    id: 'r-faultless', kind: 'requirement', parentId: 'g-rely', title: 'Its tests give the same verdict in any order and on a busy machine', priority: 'medium', dimensions: ['reliable', 'maintainable'],
    description: 'Faultlessness of the safety net: a test that passes only in one order, or only on an idle machine, is a check that sometimes lies.',
  },
  {
    id: 'k-order-dependent', kind: 'kpi', parentId: 'r-faultless', title: 'Tests that fail only when the suite runs shuffled', priority: 'medium', dimensions: ['reliable', 'maintainable'], measure: zero('tests'), probe: 'tests-order-dependent',
    reason: 'Baseline 0. Before the slowest tests had explicit timeouts, seed 1 failed two of them on vitest’s 5 s default',
  },

  // --- no one acts on a green it hasn't earned (ADR 0009) -------------------
  {
    id: 'g-harmless', kind: 'goal', parentId: 'orrery', title: 'No one acts on a green it hasn’t earned, and nothing it does destroys the record', priority: 'high', dimensions: ['safe'], owner: OWNER,
    description:
      'ADR 0009: fail safe, hazard warning, safe integration and provability. People decide on what the console shows, so the harm is a green nobody earned, a picture that stopped updating, a made-up reading taken for a real one, or a log a reset wiped. The suite proves the rollup rules over every input and pins the reset and the simulator; the browser smoke test stops the API; the dogfood breaks the core on purpose and counts what no test catches. Worst-of, so one hazard shows.',
  },
  {
    id: 'r-earned', kind: 'requirement', parentId: 'g-harmless', title: 'A green is earned under every rule, and evidence it lacks never reads green', priority: 'critical', dimensions: ['safe', 'reliable'],
    description: 'Fail safe and provability. The invariant that unknown never rolls up as green stays under the model telling the truth, and is linked here.',
  },
  {
    id: 's-rules-proven', kind: 'scenario', parentId: 'r-earned', title: 'The rollup rules keep their safety properties over every input up to four', priority: 'critical', dimensions: ['safe'], measure: pass, probe: 'suite-rules-proven',
    scenario: { stimulus: 'Every multiset of up to four inputs, each status at each priority, under 30 rules that include the edges 0 and 1; a cycle; a reading after the moment', environment: 'packages/core/test/safety.test.ts', response: 'No inputs reads unknown; a green holds however its unknown inputs turn out; a worse input never reads better; a critical breach is a breach; a rule a caller sets can read breach; a cycle and a later reading never read green' },
  },
  {
    id: 'k-false-green-mutants', kind: 'kpi', parentId: 'r-earned', title: 'Deliberate false-green breaks of the core that no test catches', priority: 'high', dimensions: ['safe', 'maintainable'], measure: zero('breaks'), probe: 'false-green-mutants',
    reason: 'Baseline 0 of 15. Before ADR 0009 added two tests, no test caught a cycle reading green or a past moment judged by a later reading',
  },
  {
    id: 'r-not-live', kind: 'requirement', parentId: 'g-harmless', title: 'A console that has stopped updating says so', priority: 'high', dimensions: ['safe', 'usable'],
    description: 'Hazard warning. Kept data looks exactly like fresh data, so the console warns once a refresh fails or hangs. The browser smoke test is linked here.',
  },
  { id: 'r-record-kept', kind: 'requirement', parentId: 'g-harmless', title: 'Nothing it does destroys the record', priority: 'critical', dimensions: ['safe', 'reliable'] },
  {
    id: 's-reset-keeps', kind: 'scenario', parentId: 'r-record-kept', title: 'A reset keeps the log it replaced', priority: 'critical', dimensions: ['safe'], measure: pass, probe: 'suite-reset-keeps',
    scenario: { stimulus: '`pnpm reset` on a log that holds events', environment: 'The real reset script on a temp log', response: 'The old log stays beside the new one byte for byte, named for the moment, and the message says how to undo; a kept log is never written over' },
  },
  { id: 'r-no-fabrication', kind: 'requirement', parentId: 'g-harmless', title: 'Made-up readings never pass for real ones', priority: 'high', dimensions: ['safe'] },
  {
    id: 's-sim-demo-only', kind: 'scenario', parentId: 'r-no-fabrication', title: 'The simulator feeds only the demo', priority: 'high', dimensions: ['safe'], measure: pass, probe: 'suite-sim-demo-only',
    scenario: { stimulus: 'The simulator started against a universe that shares the demo’s ids but is not the demo', environment: 'The real simulator against an in-process server', response: 'It says why and writes nothing, and stays up so `pnpm dev` keeps running' },
  },

  // --- running it exposes nothing it shouldn't (ADR 0002, ADR 0010) ----------
  {
    id: 'g-safe', kind: 'goal', parentId: 'orrery', title: 'Running it exposes nothing it shouldn’t', priority: 'high', dimensions: ['secure'], owner: OWNER,
    description:
      'ADR 0002 and ADR 0010. Commands carry no credentials, so what is left to guard is this: no web page can act through the operator’s browser; a reading needs the ingest token when one is set; no secret leaves the server or enters the history; a request sized to the body limit costs no more to refuse than a small one; every refusal leaves a trace; and no dependency carries a known high advisory. Identity stays a stub, so this reads unknown until commands know who is asking.',
  },
  {
    id: 'c-secrets', kind: 'constraint', parentId: 'g-safe', title: 'No secret enters the log, and no caller chooses the address', priority: 'critical', dimensions: ['secure'],
    description: 'ADR 0002 decisions 1, 3 and 5: tokens by env-var name only, bindings choose among configured sources, pulled readings are reserved to the collector, loopback-only with sources configured.',
  },
  {
    id: 's-sources', kind: 'scenario', parentId: 'c-secrets', title: 'Source configuration and pull guards hold', priority: 'critical', dimensions: ['secure'], measure: pass,
    probe: 'suite-sources',
    scenario: { stimulus: 'Inline tokens, credentialed URLs, a pusher claiming pull provenance, a non-loopback host with sources configured', environment: 'Unit and API tests', response: 'Each is refused before anything is fetched or written' },
  },
  {
    id: 's-no-secret-out', kind: 'scenario', parentId: 'c-secrets', title: 'No source token leaves the server, whatever the source sends back', priority: 'critical', dimensions: ['secure'], measure: pass, probe: 'suite-no-secret-out',
    scenario: { stimulus: 'A source that echoes the server’s token back in errors, pages, series labels and exceptions', environment: 'The collector and API in process, on a real log file', response: 'The token appears in no event, no answer and no line the server prints, and neither does the internal address' },
  },
  {
    id: 'k-secrets-history', kind: 'kpi', parentId: 'c-secrets', title: 'Lines shaped like a credential anywhere in the repository’s history', priority: 'high', dimensions: ['secure'], measure: zero('lines'), probe: 'secrets-in-history',
    reason: 'Baseline 0 in 18 commits. A credential deleted later still counts: every clone keeps it',
  },
  {
    id: 'r-browser', kind: 'requirement', parentId: 'g-safe', title: 'A web page the operator visits cannot act through the API', priority: 'critical', dimensions: ['secure'],
    description: 'ADR 0010, H1 to H3. Loopback alone stopped neither DNS rebinding, which gave any page the server’s origin and with it the source tokens ADR 0002 guards, nor a write sent from another origin. The server answers only to names nobody else’s DNS can point at it, takes writes only from its own origin, and forbids framing and foreign code.',
  },
  {
    id: 's-browser-boundary', kind: 'scenario', parentId: 'r-browser', title: 'Rebound names, other origins and bodies a page sends without asking change nothing', priority: 'critical', dimensions: ['secure'], measure: pass, probe: 'suite-browser-boundary',
    scenario: { stimulus: 'A request naming a host the server does not answer to; a write from another origin or the null origin; a text/plain, form or multipart body; a page that frames the console', environment: 'The API in process, and the real server with ORRERY_ALLOWED_HOSTS', response: 'Each is refused before anything is read or written, every answer forbids framing and foreign code, and the console’s own writes and clients with no Origin go through' },
  },
  { id: 'r-ingest', kind: 'requirement', parentId: 'g-safe', title: 'A reading needs the ingest token, by any route, when one is set', priority: 'high', dimensions: ['secure'] },
  {
    id: 's-ingest-token', kind: 'scenario', parentId: 'r-ingest', title: 'A reading without the token is refused by the webhook and by commands alike', priority: 'high', dimensions: ['secure'], measure: pass, probe: 'suite-ingest-token',
    scenario: { stimulus: 'Readings with no token, a wrong one, a prefix of the right one or another scheme; a caller signing as `ingest` or `collector`', environment: 'The API in process with ORRERY_INGEST_TOKEN set', response: 'Each reading is refused with 401 and nothing is written, whichever route it takes; the reserved names are refused; other commands stay open, as the README says' },
  },
  { id: 'r-traced', kind: 'requirement', parentId: 'g-safe', title: 'A refused request leaves a trace for the operator', priority: 'medium', dimensions: ['secure', 'operable'] },
  {
    id: 's-refusals-traced', kind: 'scenario', parentId: 'r-traced', title: 'Every refusal is logged under its request id, without the credentials offered', priority: 'medium', dimensions: ['secure'], measure: pass, probe: 'suite-refusals-traced',
    scenario: { stimulus: 'A foreign host, a foreign origin and a guessed token', environment: 'The API in process, its log read back', response: 'Each refusal is a warning naming what was refused, where it came from and the request id; neither the guess nor the token appears' },
  },
  { id: 'r-resistant', kind: 'requirement', parentId: 'g-safe', title: 'A request sized to the body limit costs no more to refuse than a small one', priority: 'high', dimensions: ['secure', 'efficient'] },
  {
    id: 's-oversized', kind: 'scenario', parentId: 'r-resistant', title: 'A collection far over its limit is refused at the limit, not element by element', priority: 'high', dimensions: ['secure'], measure: pass, probe: 'suite-oversized',
    scenario: { stimulus: 'A command holding two million links or dimensions, about what fits in the body limit', environment: 'packages/core/test/security.test.ts', response: 'One problem is reported, the limit; under zod 3 the same request held a server for 12.7 s and 1.9 GB' },
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

  // --- everyone can read, operate and follow it (ADR 0011) -------------------
  {
    id: 'g-usable', kind: 'goal', parentId: 'orrery', title: 'Everyone can read, operate and follow it end to end', priority: 'medium', dimensions: ['usable'], owner: OWNER,
    rollup: { strategy: 'weighted', okAt: 0.9, warnAt: 0.6 },
    description: 'ADR 0011. Rolled up by priority-weighted score: the console meets WCAG 2.2 AA wherever a scan can tell, in both schemes; the evolution loop works in a real browser; and the docs lead somewhere.',
  },
  {
    id: 'r-accessible', kind: 'requirement', parentId: 'g-usable', title: 'The console meets WCAG 2.2 AA wherever a scan can tell', priority: 'high', dimensions: ['usable'],
    description: 'ADR 0011, U1 to U5. Muted text and white on the accent read below 4.5:1, the outline’s chevrons and the feed’s links were smaller than 24 px, the outline claimed a tree’s keyboard behaviour it never had, and a select had no name.',
  },
  {
    id: 'k-a11y', kind: 'kpi', parentId: 'r-accessible', title: 'Accessibility checks that fail in a real browser', priority: 'high', dimensions: ['usable'], measure: zero('checks'), probe: 'ui-accessibility',
    reason: 'Baseline 25 of 31 checks before ADR 0011 (contrast, target size, an unnamed select); 0 after',
  },
  {
    id: 's-contrast', kind: 'scenario', parentId: 'r-accessible', title: 'Every text colour reads at 4.5:1 on every surface, in both schemes', priority: 'high', dimensions: ['usable'], measure: pass, probe: 'suite-contrast',
    scenario: { stimulus: 'A theme token edited in styles.css', environment: 'apps/server/test/usability.test.ts, on every pnpm verify', response: 'Each text colour keeps 4.5:1 on each surface and status wash it is drawn on, light and dark, and both ways of asking for dark define it alike' },
  },
  {
    id: 's-smoke', kind: 'scenario', parentId: 'g-usable', links: ['r-not-live'], title: 'The evolution loop works in a real browser', priority: 'high', dimensions: ['usable', 'safe'], measure: pass, probe: 'ui-smoke',
    scenario: { stimulus: 'Refine a stub into a KPI, record a reading, revise its target with and without a reason; then the API refuses, recovers and hangs', environment: 'Headless Chromium against a throwaway demo server running the fresh build', response: 'Each step lands, the reason is enforced, the change heads the feed, no console errors; the console says it is not live while the API fails or hangs, and live again once it answers' },
  },
  {
    id: 'k-links', kind: 'kpi', parentId: 'g-usable', title: 'Broken relative links in Markdown docs', priority: 'low', dimensions: ['usable'], measure: zero('links'), probe: 'doc-links',
    reason: 'Baseline 0',
  },

  // --- it does what the README says it does (ADR 0012) -----------------------
  {
    id: 'g-fit', kind: 'goal', parentId: 'orrery', title: 'It does what the README says it does', priority: 'high', dimensions: ['suitable'], owner: OWNER,
    description: 'ADR 0012. Each need in the README’s “The idea” table is met, and breaking the code that meets it turns a test red. The tour tells the story the demo shows.',
  },
  {
    id: 'r-claims', kind: 'requirement', parentId: 'g-fit', title: 'Breaking any claim in “The idea” turns a test red', priority: 'high', dimensions: ['suitable'],
    description: 'ADR 0012, F1 and F2. Five breaks of a written claim got past the core’s tests, four of them past the whole suite, and the backlog and the breadcrumb the console shows were computed in the UI, where no test reached them.',
  },
  {
    id: 'k-claims', kind: 'kpi', parentId: 'r-claims', title: 'Breaks of a README claim no test catches', priority: 'high', dimensions: ['suitable'], measure: zero('breaks'), probe: 'claim-mutants',
    reason: 'Baseline 5 of the 18 breaks that applied to the code before ADR 0012 escaped the core’s tests; 0 of 21 after',
  },
  {
    id: 's-claims', kind: 'scenario', parentId: 'r-claims', title: 'The backlog, the breadcrumb, the ribbon, the past, the reasons and the signal show what the README says', priority: 'high', dimensions: ['suitable'], measure: pass, probe: 'suite-claims',
    scenario: { stimulus: 'Gaps of every kind below a node, a node three levels down with a link, a change on the day shown, a past day, readings in every status, a breach beside a heavier warning, and a reading that arrives late', environment: 'packages/core/test/suitability.test.ts', response: 'The backlog lists every gap and agrees with coverage; the breadcrumb climbs every primary parent and no link; the ribbon ends at the moment shown; the past holds nothing from after it; reasons name their thresholds; the signal leads to the breach; the latest observation decides' },
  },
  {
    id: 's-story', kind: 'scenario', parentId: 'g-fit', title: 'The demo tells the documented story', priority: 'high', dimensions: ['suitable'], measure: pass, probe: 'suite-demo-story',
    scenario: { stimulus: 'The README’s five-minute tour', environment: 'The seeded demo, pinned by apps/server/test/app.test.ts', response: 'Every status the tour promises is the one the model reports' },
  },
];
