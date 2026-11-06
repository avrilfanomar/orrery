// How the cost of a request scales (ADR 0004). These pin the shape —
// machine-independent, no clocks — and `pnpm dogfood` measures the size.
// Each request re-projects the whole log by design (ADR 0001); what must not
// happen is a second fold per node, per ribbon day or per reading.
import { describe, expect, it } from 'vitest';
import { buildChangeFeed, buildNodeDetail, buildUniverseView, referencedBy, type OrreryEvent } from '../src/index.js';
import { makeLog, msLower } from './helpers.js';

const START = '2026-01-01T00:00:00.000Z';
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** A goal over `kpis` measured nodes, each read every `stepMinutes` for `days`, recorded as it happens. */
function history({ kpis, days, stepMinutes }: { kpis: number; days: number; stepMinutes: number }) {
  const log = makeLog(START);
  log.run({ type: 'node.create', data: { id: 'g', kind: 'goal', title: 'Goal' } });
  for (let k = 0; k < kpis; k++) {
    log.run({ type: 'node.create', data: { id: `k${k}`, kind: 'kpi', title: `KPI ${k}`, parentId: 'g', measure: msLower(500, 700, 48) } });
  }
  const end = Date.parse(START) + days * DAY;
  for (let t = Date.parse(START) + stepMinutes * MIN, i = 0; t <= end; t += stepMinutes * MIN, i++) {
    log.at(new Date(t).toISOString());
    // Values keep the same number of digits, so a size difference can only come from structure.
    for (let k = 0; k < kpis; k++) log.run({ type: 'reading.record', data: { nodeId: `k${k}`, value: 400 + ((i + k) % 7) * 50 } });
  }
  return { events: log.events, now: log.now() };
}

/** Reads of the log's elements per stored event: how many times `use` folds the log, whatever it does with each event. */
function foldsOf(events: readonly OrreryEvent[], use: (events: readonly OrreryEvent[]) => unknown): number {
  let reads = 0;
  const counted = new Proxy(events as OrreryEvent[], {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  use(counted);
  return reads / events.length;
}

/** Equal up to a few reads at the edges (one per ribbon day, say), far from a second fold. */
const expectSameFolds = (actual: number, expected: number) => expect(Math.abs(actual - expected) / expected).toBeLessThan(0.1);

describe('log passes per request', () => {
  const small = history({ kpis: 3, days: 70, stepMinutes: 360 });
  const large = history({ kpis: 30, days: 70, stepMinutes: 360 });

  it('folds the log as often for the universe view whatever the node count or ribbon length', () => {
    const view = (h: typeof small, ribbonDays?: number) => foldsOf(h.events, (e) => buildUniverseView(e, { now: h.now, ribbonDays }));
    const base = view(small);
    expectSameFolds(view(large), base);
    expectSameFolds(view(small, 60), base);
  });

  it('folds it as often for a node’s detail whatever the node count, and for the change feed whatever the limit', () => {
    const detail = (h: typeof small) => foldsOf(h.events, (e) => buildNodeDetail(e, 'k0', { now: h.now }));
    expectSameFolds(detail(large), detail(small));
    const feed = (limit: number) => foldsOf(large.events, (e) => buildChangeFeed(e, { now: large.now, limit }));
    expectSameFolds(feed(500), feed(10));
  });
});

describe('answer size', () => {
  it('keeps the universe view the same size when the readings grow tenfold', () => {
    const hourly = history({ kpis: 5, days: 7, stepMinutes: 60 });
    const dense = history({ kpis: 5, days: 7, stepMinutes: 6 });
    expect(dense.events.length).toBeGreaterThan(9 * hourly.events.length);
    const a = buildUniverseView(hourly.events, { now: hourly.now });
    const b = buildUniverseView(dense.events, { now: dense.now });
    expect(b.nodes['k0']!.spark!.length).toBe(a.nodes['k0']!.spark!.length);
    expect(JSON.stringify(b).length / JSON.stringify(a).length).toBeLessThan(1.05);
  });

  it('caps sparklines and series, so a long history never ships whole', () => {
    const h = history({ kpis: 1, days: 30, stepMinutes: 6 });
    const view = buildUniverseView(h.events, { now: h.now });
    expect(view.nodes['k0']!.spark!.length).toBeLessThanOrEqual(42);
    const detail = buildNodeDetail(h.events, 'k0', { now: h.now })!;
    expect(h.events.length).toBeGreaterThan(7000);
    expect(detail.series!.length).toBeLessThanOrEqual(360);
    expect(buildChangeFeed(h.events, { now: h.now, limit: 60 }).length).toBeLessThanOrEqual(60);
  });
});

describe('references cost what they weigh (ADR 0014)', () => {
  /** A goal over `kpis` nodes, each holding `refs` references. */
  const referenced = (kpis: number, refs: number) => {
    const log = makeLog(START);
    log.run({ type: 'node.create', data: { id: 'g', kind: 'goal', title: 'Goal' } });
    for (let k = 0; k < kpis; k++) {
      const list = Array.from({ length: refs }, (_, r) => ({ kind: 'code', target: { repo: 'shop', path: `src/k${String(k).padStart(3, '0')}/f${String(r).padStart(3, '0')}.ts` } }));
      log.run({ type: 'node.create', data: { id: `k${k}`, kind: 'kpi', title: `KPI ${k}`, parentId: 'g', refs: list } });
    }
    return buildUniverseView(log.events, { now: log.now() });
  };

  it('grows the universe view by the same amount for every reference added', () => {
    const size = (refs: number) => JSON.stringify(referenced(10, refs)).length;
    const perRef = (size(20) - size(10)) / 100;
    expect(perRef).toBeGreaterThan(0);
    expect((size(40) - size(20)) / 200).toBeCloseTo(perRef, 5);
  });

  it('reads every node’s references once to answer what references a file, whatever it finds', () => {
    const view = referenced(30, 20);
    let reads = 0;
    const counted = { ...view, nodes: Object.fromEntries(Object.entries(view.nodes).map(([id, n]) => [id, new Proxy(n, { get: (t, k, r) => (k === 'refs' && reads++, Reflect.get(t, k, r)) })])) };
    expect(referencedBy(counted, { repo: 'shop', path: 'src/k007/' })).toHaveLength(20);
    expect(reads).toBe(Object.keys(view.nodes).length);
  });
});
