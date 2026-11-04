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

  // --- the console stays fast ---------------------------------------------
  {
    id: 'g-fast', kind: 'goal', parentId: 'ru', title: 'The console stays fast at realistic scale', priority: 'high', dimensions: ['efficient'], owner: OWNER,
    description: 'ADR 0001 recomputes the projection per request and names reading volume as its revisit trigger; this goal watches that trigger.',
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
  { id: 'r-light', kind: 'requirement', parentId: 'g-fast', title: 'The console loads light', priority: 'medium', dimensions: ['efficient', 'usable'] },
  {
    id: 'k-bundle', kind: 'kpi', parentId: 'r-light', title: 'UI JavaScript shipped (gzip)', priority: 'medium', dimensions: ['efficient'], measure: m('kB', 'lower', 110, 150),
    probe: 'ui-bundle-gzip', reason: 'Baseline 88.9 kB; the target leaves room for features, not for a second framework',
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
