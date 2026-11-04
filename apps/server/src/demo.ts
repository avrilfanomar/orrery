// The demo universe: a fictional online shop ("Larch Store") with thirty days
// of history. Every event is produced through the real `decide`, so the seed
// obeys the same rules as the API. The story it tells:
//   d-30  the model is drafted top-down: product → goals → requirements → KPIs
//   d-21  "Pages feel instant" is refined with a mobile KPI
//   d-18  the p95 latency target is tightened 800 → 500 ms (old readings stay green)
//   d-15  "Pages feel instant" is raised to high priority
//   d-12  the average-order-value target is raised; a CVE spike breaches security for 3 days
//   d-10  "Search finds relevant products" is added as an unrefined stub
//   d-8   legal adds an EU data-residency constraint, refined into evidence on d-5
//   d-6   "Support IE11" is deprecated
//   d-4   the 5xx error rate is linked to checkout as well as availability
//   d-3   the flash-sale scenario moves to the SRE-owned availability requirement
//   now   a checkout incident: 5xx errors breach, conversion and availability warn
import {
  applyEvent,
  decide,
  emptyUniverse,
  parseCommand,
  PASS_FAIL_UNIT,
  type CommandInput,
  type RuEvent,
} from '@ru/core';

const H = 3.6e6;
const D = 24 * H;

export interface Profile {
  id: string;
  source: string;
  cadenceHours: number;
  /** How long before "now" the newest seeded reading is taken. */
  offsetHours: number;
  fromDays: number;
  base: number;
  noise: number;
  decimals: number;
  min?: number;
  max?: number;
  /**
   * Deviation from `base` by hours before the seed moment. Negative hours are
   * the live future: the simulator keeps following the same script, which is
   * how the incident lasts a while after seeding and then recovers.
   */
  shape?: (hoursAgo: number) => number;
  /** For pass/fail checks: whether the run at this moment passed. */
  pass?: (hoursAgo: number) => boolean;
}

/** Hours the seeded incident keeps going after the seed moment before it recovers. */
export const INCIDENT_TAIL_HOURS = 3;
const incident = (h: number) => h < 6 && h > -INCIDENT_TAIL_HOURS;
const days = (h: number) => h / 24;

export const PROFILES: Profile[] = [
  { id: 'k-conversion', source: 'analytics', cadenceHours: 6, offsetHours: 0.5, fromDays: 30, base: 3.36, noise: 0.08, decimals: 2, shape: (h) => (incident(h) ? -0.36 : 0) },
  { id: 'k-abandonment', source: 'analytics', cadenceHours: 6, offsetHours: 0.5, fromDays: 30, base: 63, noise: 1.2, decimals: 1, shape: (h) => (incident(h) ? 4.6 : 0) },
  { id: 'k-p95', source: 'prometheus', cadenceHours: 1, offsetHours: 0.2, fromDays: 30, base: 610, noise: 28, decimals: 0, shape: (h) => (incident(h) ? 110 : 0) - (days(h) > 10 ? 0 : (10 - Math.max(0, days(h))) * 8.5) },
  { id: 'k-lcp', source: 'rum', cadenceHours: 6, offsetHours: 1, fromDays: 21, base: 2330, noise: 150, decimals: 0 },
  { id: 'k-availability', source: 'prometheus', cadenceHours: 1, offsetHours: 0.2, fromDays: 30, base: 99.965, noise: 0.012, decimals: 3, max: 100, shape: (h) => (incident(h) ? -0.29 : days(h) > 24.85 && days(h) < 25 ? -0.18 : 0) },
  { id: 'k-5xx', source: 'prometheus', cadenceHours: 1, offsetHours: 0.2, fromDays: 30, base: 0.05, noise: 0.014, decimals: 2, min: 0, shape: (h) => (incident(h) ? 1.5 + (6 - Math.max(0, h)) * 0.06 : days(h) > 24.85 && days(h) < 25 ? 0.62 : 0) },
  { id: 'k-pii-eu', source: 'data-catalog', cadenceHours: 24, offsetHours: 3, fromDays: 4, base: 100, noise: 0, decimals: 1, shape: (h) => (days(h) > 1.5 && days(h) < 2.5 ? -0.4 : 0) },
  { id: 'k-crit-cve', source: 'scanner', cadenceHours: 24, offsetHours: 4, fromDays: 30, base: 0, noise: 0, decimals: 0, shape: (h) => (days(h) <= 12 && days(h) > 9 ? 2 : 0) },
  { id: 'k-patch-days', source: 'scanner', cadenceHours: 168, offsetHours: 30, fromDays: 30, base: 6, noise: 1.4, decimals: 1, min: 1 },
  { id: 'k-deploy-freq', source: 'ci', cadenceHours: 24, offsetHours: 2, fromDays: 30, base: 12, noise: 1.8, decimals: 0, min: 0 },
  { id: 'k-lead-time', source: 'ci', cadenceHours: 24, offsetHours: 2, fromDays: 30, base: 19, noise: 3.5, decimals: 1, min: 1 },
  { id: 'k-cfr', source: 'ci', cadenceHours: 24, offsetHours: 2, fromDays: 30, base: 10.5, noise: 2, decimals: 1, min: 0 },
  { id: 'k-coverage', source: 'ci', cadenceHours: 24, offsetHours: 2, fromDays: 30, base: 82, noise: 0.5, decimals: 1, shape: (h) => -Math.max(0, days(h)) * 0.1 },
  { id: 'k-dep-cycles', source: 'ci', cadenceHours: 24, offsetHours: 2, fromDays: 30, base: 0, noise: 0, decimals: 0, shape: (h) => (days(h) > 7 ? 1 : 0) },
  { id: 'k-cloud-cost', source: 'finops', cadenceHours: 24, offsetHours: 3, fromDays: 30, base: 11300, noise: 200, decimals: 0 },
  { id: 'k-cost-per-order', source: 'finops', cadenceHours: 24, offsetHours: 3, fromDays: 30, base: 0.128, noise: 0.005, decimals: 3 },
  { id: 'k-aov', source: 'analytics', cadenceHours: 24, offsetHours: 3, fromDays: 30, base: 49.2, noise: 1.1, decimals: 2 },
  { id: 's-guest-checkout', source: 'e2e', cadenceHours: 24, offsetHours: 5, fromDays: 30, base: 1, noise: 0, decimals: 0, pass: (h) => !(days(h) > 12 && days(h) < 13) },
  { id: 's-flash-sale', source: 'load-test', cadenceHours: 168, offsetHours: 50, fromDays: 30, base: 1, noise: 0, decimals: 0, pass: () => true },
  { id: 's-cred-stuffing', source: 'attack-sim', cadenceHours: 168, offsetHours: 30, fromDays: 30, base: 1, noise: 0, decimals: 0, pass: () => true },
];

/** Deterministic PRNG so the seed tells the same story every time. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Roughly normal noise in [-2, 2]. */
export const jitter = (rnd: () => number) => rnd() + rnd() + rnd() + rnd() - 2;

export function clampRound(p: Profile, v: number): number {
  let x = v;
  if (p.min !== undefined) x = Math.max(p.min, x);
  if (p.max !== undefined) x = Math.min(p.max, x);
  const f = 10 ** p.decimals;
  return Math.round(x * f) / f;
}

type Measure = { unit: string; direction: 'higher' | 'lower'; target: number; warn: number; staleAfterHours: number };
const m = (unit: string, direction: 'higher' | 'lower', target: number, warn: number, staleAfterHours: number): Measure => ({ unit, direction, target, warn, staleAfterHours });
const pf = (staleAfterHours: number): Measure => m(PASS_FAIL_UNIT, 'higher', 1, 1, staleAfterHours);

interface Step {
  daysAgo: number;
  actor: string;
  cmd: CommandInput;
}

type CreateData = Extract<CommandInput, { type: 'node.create' }>['data'];
const create = (daysAgo: number, actor: string, data: CreateData): Step => ({ daysAgo, actor, cmd: { type: 'node.create', data } });

const STRUCTURE: Step[] = [
  create(30, 'product-owner', { id: 'larch-store', kind: 'product', title: 'Larch Store', priority: 'critical', owner: 'Head of Product', description: 'A fictional online shop for outdoor gear — web storefront, checkout API, search and back office. Demo data for the proof of concept.' }),

  create(30, 'product-owner', { id: 'g-buy', kind: 'goal', parentId: 'larch-store', title: 'Customers find and buy what they want, quickly', priority: 'critical', dimensions: ['business', 'usable'], owner: 'Product', rollup: { strategy: 'weighted', okAt: 0.9, warnAt: 0.6 }, description: 'The commercial heart of the shop. Rolled up by priority-weighted score: a critical breach anywhere below still turns it red.' }),
  create(30, 'product-owner', { id: 'r-checkout', kind: 'requirement', parentId: 'g-buy', title: 'Checkout is short and dependable', priority: 'high', dimensions: ['suitable', 'usable'], owner: 'Checkout team' }),
  create(30, 'product-owner', { id: 'k-conversion', kind: 'kpi', parentId: 'r-checkout', title: 'Checkout conversion rate', priority: 'critical', dimensions: ['business'], measure: m('%', 'higher', 3.2, 2.8, 18), description: 'Share of sessions with a cart that end in a placed order, rolling 24 h.' }),
  create(30, 'product-owner', { id: 'k-abandonment', kind: 'kpi', parentId: 'r-checkout', title: 'Cart abandonment rate', priority: 'medium', dimensions: ['business', 'usable'], measure: m('%', 'lower', 65, 70, 18) }),
  create(30, 'qa-lead', { id: 's-guest-checkout', kind: 'scenario', parentId: 'r-checkout', title: 'Guest checkout without forced sign-up', priority: 'high', dimensions: ['usable'], measure: pf(36), scenario: { stimulus: 'A first-time visitor adds three items and checks out', environment: 'Nightly end-to-end run against staging', response: 'The order is placed in at most four steps without creating an account' } }),
  create(30, 'product-owner', { id: 'r-instant', kind: 'requirement', parentId: 'g-buy', title: 'Pages feel instant', priority: 'medium', dimensions: ['efficient'], owner: 'Web platform team' }),
  create(30, 'sre-lead', { id: 'k-p95', kind: 'kpi', parentId: 'r-instant', title: 'Product page latency (p95)', priority: 'high', dimensions: ['efficient'], measure: m('ms', 'lower', 800, 1200, 3), description: 'Server-side p95 for product detail pages, hourly.' }),
  create(30, 'sre-lead', { id: 's-flash-sale', kind: 'scenario', parentId: 'r-instant', title: 'Flash-sale peak load', priority: 'high', dimensions: ['efficient', 'reliable'], measure: pf(240), scenario: { stimulus: 'Traffic rises to ten times the normal peak within five minutes', environment: 'Weekly load test against a production-sized staging stack', response: 'p95 latency stays under one second and the error rate under 0.5%' } }),

  create(30, 'product-owner', { id: 'g-open', kind: 'goal', parentId: 'larch-store', title: 'The store is always open', priority: 'critical', dimensions: ['reliable', 'operable'], owner: 'SRE' }),
  create(30, 'sre-lead', { id: 'r-availability', kind: 'requirement', parentId: 'g-open', title: 'Checkout API stays available', priority: 'critical', dimensions: ['reliable'], owner: 'SRE' }),
  create(30, 'sre-lead', { id: 'k-availability', kind: 'kpi', parentId: 'r-availability', title: 'Checkout availability (rolling 24 h)', priority: 'critical', dimensions: ['reliable'], measure: m('%', 'higher', 99.9, 99.5, 3) }),
  create(30, 'sre-lead', { id: 'k-5xx', kind: 'kpi', parentId: 'r-availability', title: 'Checkout server errors (5xx rate)', priority: 'high', dimensions: ['reliable'], measure: m('%', 'lower', 0.1, 0.5, 3) }),
  create(30, 'sre-lead', { id: 'r-recover', kind: 'requirement', parentId: 'g-open', title: 'Recover quickly from failures', priority: 'high', dimensions: ['operable'], owner: 'SRE' }),
  create(30, 'sre-lead', { id: 'k-mttr', kind: 'kpi', parentId: 'r-recover', title: 'Mean time to recovery', priority: 'high', dimensions: ['operable'], measure: m('min', 'lower', 30, 60, 24 * 60), description: 'Recorded after each incident review.' }),
  create(30, 'sre-lead', { id: 's-db-failover', kind: 'scenario', parentId: 'r-recover', title: 'Primary database failover', priority: 'high', dimensions: ['reliable'], measure: pf(24 * 45), scenario: { stimulus: 'The primary database node is lost', environment: 'Monthly game day in production', response: 'Writes resume within two minutes with no data loss' } }),

  create(30, 'product-owner', { id: 'g-safe', kind: 'goal', parentId: 'larch-store', title: 'Customer data is safe', priority: 'critical', dimensions: ['secure', 'safe'], owner: 'Security' }),
  create(30, 'security', { id: 'r-vulns', kind: 'requirement', parentId: 'g-safe', title: 'No known critical vulnerabilities in production', priority: 'high', dimensions: ['secure'], owner: 'Security' }),
  create(30, 'security', { id: 'k-crit-cve', kind: 'kpi', parentId: 'r-vulns', title: 'Open critical CVEs in production', priority: 'critical', dimensions: ['secure'], measure: m('CVEs', 'lower', 0, 0, 48) }),
  create(30, 'security', { id: 'k-patch-days', kind: 'kpi', parentId: 'r-vulns', title: 'Time to patch high-severity CVEs', priority: 'medium', dimensions: ['secure'], measure: m('days', 'lower', 7, 14, 240) }),
  create(30, 'security', { id: 's-cred-stuffing', kind: 'scenario', parentId: 'g-safe', title: 'Credential-stuffing attack is contained', priority: 'high', dimensions: ['secure'], measure: pf(240), scenario: { stimulus: 'A botnet tries 1,000 logins per minute with leaked credentials', environment: 'Weekly automated attack simulation', response: 'Attempts are rate-limited and no account is taken over' } }),

  create(30, 'product-owner', { id: 'g-ship', kind: 'goal', parentId: 'larch-store', title: 'The team ships changes safely and often', priority: 'medium', dimensions: ['maintainable', 'flexible'], owner: 'Engineering', rollup: { strategy: 'quorum', okShare: 0.75, warnShare: 0.5 }, description: 'Rolled up by quorum: healthy when three in four of its requirements are.' }),
  create(30, 'tech-lead', { id: 'r-flow', kind: 'requirement', parentId: 'g-ship', title: 'Changes reach production quickly', priority: 'medium', dimensions: ['flexible'] }),
  create(30, 'tech-lead', { id: 'k-deploy-freq', kind: 'kpi', parentId: 'r-flow', title: 'Deployment frequency', priority: 'medium', dimensions: ['flexible'], measure: m('deploys/wk', 'higher', 10, 5, 48) }),
  create(30, 'tech-lead', { id: 'k-lead-time', kind: 'kpi', parentId: 'r-flow', title: 'Lead time for changes', priority: 'medium', dimensions: ['flexible'], measure: m('h', 'lower', 24, 72, 48) }),
  create(30, 'tech-lead', { id: 'r-stable', kind: 'requirement', parentId: 'g-ship', title: 'Changes rarely break production', priority: 'high', dimensions: ['maintainable', 'reliable'] }),
  create(30, 'tech-lead', { id: 'k-cfr', kind: 'kpi', parentId: 'r-stable', title: 'Change failure rate', priority: 'high', dimensions: ['reliable'], measure: m('%', 'lower', 15, 25, 48) }),
  create(30, 'tech-lead', { id: 'k-coverage', kind: 'kpi', parentId: 'r-stable', title: 'Test coverage of the checkout module', priority: 'low', dimensions: ['maintainable'], measure: m('%', 'higher', 80, 70, 48) }),
  create(30, 'tech-lead', { id: 'r-modular', kind: 'requirement', parentId: 'g-ship', title: 'The codebase stays modular', priority: 'low', dimensions: ['maintainable'] }),
  create(30, 'tech-lead', { id: 'k-dep-cycles', kind: 'kpi', parentId: 'r-modular', title: 'Package dependency cycles', priority: 'low', dimensions: ['maintainable'], measure: m('cycles', 'lower', 0, 3, 48) }),
  create(30, 'tech-lead', { id: 'c-ie11', kind: 'constraint', parentId: 'g-ship', title: 'Support Internet Explorer 11', priority: 'low', dimensions: ['suitable'] }),

  create(30, 'product-owner', { id: 'g-economics', kind: 'goal', parentId: 'larch-store', title: 'Unit economics stay sustainable', priority: 'high', dimensions: ['business'], owner: 'Finance', rollup: { strategy: 'weighted', okAt: 0.85, warnAt: 0.5 } }),
  create(30, 'finance', { id: 'c-cloud-budget', kind: 'constraint', parentId: 'g-economics', title: 'Cloud spend stays within €12k a month', priority: 'high', dimensions: ['business', 'efficient'] }),
  create(30, 'finance', { id: 'k-cloud-cost', kind: 'kpi', parentId: 'c-cloud-budget', title: 'Projected monthly cloud spend', priority: 'high', dimensions: ['business'], measure: m('€', 'lower', 12000, 13000, 48) }),
  create(30, 'finance', { id: 'k-cost-per-order', kind: 'kpi', parentId: 'c-cloud-budget', title: 'Infrastructure cost per order', priority: 'medium', dimensions: ['business', 'efficient'], measure: m('€', 'lower', 0.15, 0.2, 48) }),
  create(30, 'finance', { id: 'k-aov', kind: 'kpi', parentId: 'g-economics', title: 'Average order value', priority: 'high', dimensions: ['business'], measure: m('€', 'higher', 45, 40, 48) }),

  // --- evolution ---------------------------------------------------------
  create(21, 'ux-lead', { id: 'k-lcp', kind: 'kpi', parentId: 'r-instant', title: 'Mobile Largest Contentful Paint (p75)', priority: 'medium', dimensions: ['efficient', 'usable'], measure: m('ms', 'lower', 2500, 4000, 18), reason: 'Refining “Pages feel instant” for mobile visitors — server latency alone missed slow phones' }),
  { daysAgo: 18, actor: 'sre-lead', cmd: { type: 'node.redefine', data: { id: 'k-p95', measure: m('ms', 'lower', 500, 700, 3), reason: 'SLO review: the main competitor’s product pages answer in about 450 ms at p95' } } },
  { daysAgo: 15, actor: 'product-owner', cmd: { type: 'node.reprioritize', data: { id: 'r-instant', priority: 'high', reason: 'Mobile share of traffic passed 60% in the Q3 review' } } },
  { daysAgo: 12, actor: 'finance', cmd: { type: 'node.redefine', data: { id: 'k-aov', measure: m('€', 'higher', 48, 42, 48), reason: 'Bundle offers launched; the FY plan now assumes €48 per order' } } },
  create(10, 'product-owner', { id: 'r-search', kind: 'requirement', parentId: 'g-buy', title: 'Search finds relevant products', priority: 'high', dimensions: ['suitable', 'usable'], reason: 'Top complaint in the Q3 customer interviews — to be refined into KPIs and scenarios', description: 'Not yet refined. Candidate measures: zero-result rate, click-through on the first page, search-to-cart rate.' }),
  create(8, 'legal', { id: 'c-gdpr', kind: 'constraint', parentId: 'g-safe', title: 'Personal data stays in the EU', priority: 'critical', dimensions: ['secure', 'safe'], owner: 'Legal', reason: 'New enterprise contracts require contractual EU data residency', description: 'Every store holding personal data runs in an EU region (GDPR; enterprise contract annex 3).' }),
  { daysAgo: 6, actor: 'tech-lead', cmd: { type: 'node.deprecate', data: { id: 'c-ie11', reason: 'IE11 traffic has been below 0.1% for 90 days' } } },
  create(5, 'security', { id: 'k-pii-eu', kind: 'kpi', parentId: 'c-gdpr', title: 'Share of personal data stored in EU regions', priority: 'critical', dimensions: ['secure'], measure: m('%', 'higher', 100, 99, 48), reason: 'Refining the residency constraint into evidence' }),
  create(5, 'security', { id: 's-residency-audit', kind: 'scenario', parentId: 'c-gdpr', title: 'Data residency audit', priority: 'high', dimensions: ['secure', 'safe'], measure: pf(24 * 100), reason: 'Refining the residency constraint into evidence', scenario: { stimulus: 'An auditor asks where every personal-data store lives', environment: 'Quarterly compliance review', response: 'Each store is traced to an EU region, with evidence produced within one day' } }),
  { daysAgo: 4, actor: 'sre-lead', cmd: { type: 'node.link', data: { id: 'k-5xx', target: 'r-checkout', reason: 'A failing checkout API is a failing checkout — count it on both sides' } } },
  { daysAgo: 3, actor: 'sre-lead', cmd: { type: 'node.move', data: { id: 's-flash-sale', parentId: 'r-availability', reason: 'Load testing is now owned by the SRE team' } } },
];

const ONE_OFF_READINGS: { id: string; daysAgo: number; value: number; source: string }[] = [
  { id: 'k-mttr', daysAgo: 29.9, value: 26, source: 'incident-review' },
  { id: 'k-mttr', daysAgo: 25, value: 42, source: 'incident-review' },
  { id: 's-db-failover', daysAgo: 29.9, value: 1, source: 'game-day' },
  { id: 'k-mttr', daysAgo: 14, value: 18, source: 'incident-review' },
  { id: 's-db-failover', daysAgo: 20, value: 1, source: 'game-day' },
];

export function generateDemo(now: Date, seed = 7): RuEvent[] {
  const nowMs = now.getTime();
  const rnd = mulberry32(seed);
  const items: { at: number; order: number; actor: string; cmd: CommandInput }[] = [];

  STRUCTURE.forEach((s, i) => items.push({ at: nowMs - s.daysAgo * D, order: i, actor: s.actor, cmd: s.cmd }));

  const reading = (id: string, at: number, value: number, source: string) =>
    items.push({ at, order: 1e6, actor: 'ingest', cmd: { type: 'reading.record', data: { nodeId: id, value, observedAt: new Date(at).toISOString(), source } } });

  for (const p of PROFILES) {
    const start = nowMs - p.fromDays * D;
    for (let t = nowMs - p.offsetHours * H; t > start + 60_000; t -= p.cadenceHours * H) {
      const hoursAgo = (nowMs - t) / H;
      const value = p.pass ? (p.pass(hoursAgo) ? 1 : 0) : clampRound(p, p.base + (p.shape?.(hoursAgo) ?? 0) + p.noise * jitter(rnd));
      reading(p.id, t, value, p.source);
    }
    // Slow checks also ran once when they were set up, so their early history is not blank.
    if (p.cadenceHours > 24) {
      const first = start + 2 * H;
      reading(p.id, first, p.pass ? (p.pass((nowMs - first) / H) ? 1 : 0) : clampRound(p, p.base + p.noise * jitter(rnd)), p.source);
    }
  }
  for (const r of ONE_OFF_READINGS) reading(r.id, nowMs - r.daysAgo * D, r.value, r.source);

  items.sort((a, b) => a.at - b.at || a.order - b.order);

  const u = emptyUniverse();
  const events: RuEvent[] = [];
  for (const it of items) {
    for (const e of decide(u, parseCommand(it.cmd), { now: new Date(it.at).toISOString(), actor: it.actor })) {
      const ev = { ...e, seq: events.length + 1 } as RuEvent;
      events.push(ev);
      applyEvent(u, ev);
    }
  }
  return events;
}
