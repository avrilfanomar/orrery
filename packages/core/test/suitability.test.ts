// The README's claims about what a person sees (ADR 0012), each pinned where
// its logic lives. Every test here was missing until a deliberate break of the
// claim went unnoticed by the whole suite; `claim-mutants` keeps those breaks
// (CLAIM_MUTANTS in apps/server/src/dogfood/suitability.ts) and checks each
// still turns a test red.
import { describe, expect, it } from 'vitest';
import { backlogBelow, breadcrumbTo, buildUniverseView, evaluateUniverse, readingSeries, signalPath } from '../src/index.js';
import { makeLog, msLower } from './helpers.js';

const kpi = (id: string, parentId: string, staleAfterHours = 24) => ({ type: 'node.create' as const, data: { id, kind: 'kpi' as const, title: id, parentId, measure: msLower(500, 700, staleAfterHours) } });

/** A product with one of every kind of gap below `g1`, one through a link, and one deprecated. */
function gapsUniverse() {
  const log = makeLog('2026-04-01T00:00:00.000Z');
  log.run({ type: 'node.create', data: { id: 'p', kind: 'product', title: 'P' } });
  log.run({ type: 'node.create', data: { id: 'g1', kind: 'goal', title: 'G1', parentId: 'p' } });
  log.run({ type: 'node.create', data: { id: 'g2', kind: 'goal', title: 'G2', parentId: 'p' } });
  log.run(kpi('k-stale', 'g1', 2));
  log.run({ type: 'reading.record', data: { nodeId: 'k-stale', value: 400 } });
  log.advanceHours(3);
  log.run(kpi('k-ok', 'g1'));
  log.run({ type: 'reading.record', data: { nodeId: 'k-ok', value: 400 } });
  log.run(kpi('k-never', 'g1'));
  log.run({ type: 'node.create', data: { id: 'r-stub', kind: 'requirement', title: 'Stub', parentId: 'g1' } });
  log.run({ type: 'node.create', data: { id: 'r-old', kind: 'requirement', title: 'Old', parentId: 'g1' } });
  log.run({ type: 'node.deprecate', data: { id: 'r-old', reason: 'Superseded' } });
  log.run({ type: 'node.create', data: { id: 'r-linked', kind: 'requirement', title: 'Linked', parentId: 'g2', links: ['g1'] } });
  return buildUniverseView(log.events, { now: log.now() });
}

describe('the refinement backlog', () => {
  it('lists what nobody can observe below a node, through children and links, and nothing else', () => {
    const view = gapsUniverse();
    const ids = (id: string) => backlogBelow(view, id).map((n) => n.id).sort();
    expect(ids('g1')).toEqual(['k-never', 'k-stale', 'r-linked', 'r-stub']);
    expect(ids('p')).toEqual(['k-never', 'k-stale', 'r-linked', 'r-stub']);
    expect(ids('k-never')).toEqual([]); // the node in focus is not its own backlog
  });

  it('agrees with coverage on every node, so the two numbers the console shows never disagree', () => {
    const view = gapsUniverse();
    for (const n of Object.values(view.nodes).filter((x) => x.lifecycle === 'active')) {
      const { measured, total } = n.evaluation.coverage;
      const self = n.evaluation.measurement ? n.evaluation.measurement.status === 'unknown' : n.evaluation.inputCount === 0;
      expect(backlogBelow(view, n.id).length + (self ? 1 : 0), n.id).toBe(total - measured);
    }
  });
});

describe('the view shows the moment it names', () => {
  it('ends the ribbon at the moment shown, so today’s change is in its last day', () => {
    const log = makeLog('2026-04-01T00:00:00.000Z');
    log.run({ type: 'node.create', data: { id: 'k', kind: 'kpi', title: 'k', measure: msLower(500, 700, 24 * 30) } });
    log.run({ type: 'reading.record', data: { nodeId: 'k', value: 400 } });
    log.advanceHours(24 * 5);
    log.run({ type: 'reading.record', data: { nodeId: 'k', value: 900 } });
    const view = buildUniverseView(log.events, { now: log.now() });
    expect(view.ribbonTimes.at(-1)).toBe(view.asOf);
    expect(view.nodes.k!.ribbon.slice(-2)).toEqual(['ok', 'breach']);
  });

  it('shows the universe as it was known: nothing created or redefined after the moment', () => {
    const log = makeLog('2026-04-01T00:00:00.000Z');
    log.run({ type: 'node.create', data: { id: 'g', kind: 'goal', title: 'G' } });
    log.run(kpi('k', 'g'));
    const then = log.now();
    log.advanceHours(1);
    log.run(kpi('later', 'g'));
    log.run({ type: 'node.redefine', data: { id: 'k', measure: msLower(300, 400), reason: 'Tighter' } });
    const past = buildUniverseView(log.events, { now: log.now(), asOf: then });
    expect(past.live).toBe(false);
    expect(Object.keys(past.nodes).sort()).toEqual(['g', 'k']);
    expect(past.nodes.g!.childIds).toEqual(['k']);
    expect(past.nodes.k!.definitionCount).toBe(1);
  });
});

describe('the reason and the signal point at the cause', () => {
  it('names the thresholds a reading is judged against, in every status', () => {
    const log = makeLog('2026-04-01T00:00:00.000Z');
    log.run({ type: 'node.create', data: { id: 'k', kind: 'kpi', title: 'k', measure: msLower(500, 700) } });
    const reasonFor = (value: number) => {
      log.advanceHours(1);
      log.run({ type: 'reading.record', data: { nodeId: 'k', value } });
      return evaluateUniverse(log.u, log.now()).get('k')!.reason;
    };
    expect(reasonFor(450)).toBe('450 ms meets the target ≤ 500 ms');
    expect(reasonFor(620)).toBe('620 ms misses the target ≤ 500 ms but is within ≤ 700 ms');
    expect(reasonFor(900)).toBe('900 ms is past the warning threshold ≤ 700 ms');
  });

  it('follows the signal to a breach before a heavier warning', () => {
    const log = makeLog('2026-04-01T00:00:00.000Z');
    log.run({ type: 'node.create', data: { id: 'g', kind: 'goal', title: 'G', rollup: { strategy: 'weighted', okAt: 0.9, warnAt: 0.6 } } });
    log.run({ type: 'node.create', data: { id: 'heavy', kind: 'kpi', title: 'Heavy', parentId: 'g', priority: 'high', measure: msLower(500, 700) } });
    log.run({ type: 'node.create', data: { id: 'light', kind: 'kpi', title: 'Light', parentId: 'g', priority: 'low', measure: msLower(500, 700) } });
    log.run({ type: 'reading.record', data: { nodeId: 'heavy', value: 600 } });
    log.run({ type: 'reading.record', data: { nodeId: 'light', value: 900 } });
    const evals = evaluateUniverse(log.u, log.now());
    expect(evals.get('g')!.status).toBe('breach');
    expect(evals.get('g')!.drivers).toEqual(['light', 'heavy']);
    expect(signalPath(evals, 'g')).toEqual(['light']);
  });
});

describe('late readings land in place', () => {
  it('keeps the latest observation as the status when an older one arrives after it', () => {
    const log = makeLog('2026-04-01T00:00:00.000Z');
    log.run({ type: 'node.create', data: { id: 'k', kind: 'kpi', title: 'k', measure: msLower(500, 700, 48) } });
    log.advanceHours(2);
    log.run({ type: 'reading.record', data: { nodeId: 'k', value: 400 } });
    log.run({ type: 'reading.record', data: { nodeId: 'k', value: 900, observedAt: '2026-04-01T01:00:00.000Z' } });
    expect(evaluateUniverse(log.u, log.now()).get('k')!.status).toBe('ok');
    const series = readingSeries(log.u, log.u.nodes.get('k')!, '2026-04-01T00:00:00.000Z', log.now());
    expect(series.map((p) => p.v)).toEqual([900, 400]);
  });
});

describe('the breadcrumb climbs back to the top', () => {
  it('lists every primary parent from the top down, and no link', () => {
    const log = makeLog('2026-04-01T00:00:00.000Z');
    log.run({ type: 'node.create', data: { id: 'p', kind: 'product', title: 'P' } });
    log.run({ type: 'node.create', data: { id: 'g', kind: 'goal', title: 'G', parentId: 'p' } });
    log.run({ type: 'node.create', data: { id: 'g2', kind: 'goal', title: 'G2', parentId: 'p' } });
    log.run({ type: 'node.create', data: { id: 'r', kind: 'requirement', title: 'R', parentId: 'g' } });
    log.run({ type: 'node.create', data: { id: 'k', kind: 'kpi', title: 'K', parentId: 'r', links: ['g2'], measure: msLower(500, 700) } });
    const view = buildUniverseView(log.events, { now: log.now() });
    expect(breadcrumbTo(view, 'k').map((n) => n.id)).toEqual(['p', 'g', 'r']);
    expect(breadcrumbTo(view, 'p')).toEqual([]);
  });
});
