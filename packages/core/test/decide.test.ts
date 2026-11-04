import { describe, expect, it } from 'vitest';
import { DomainError, readingSeries, statusHistory } from '../src/index.js';
import { makeLog, msLower, pctHigher } from './helpers.js';

function tree() {
  const log = makeLog();
  log.run({ type: 'node.create', data: { id: 'p', kind: 'product', title: 'Shop' } });
  log.run({ type: 'node.create', data: { id: 'g', kind: 'goal', title: 'Goal', parentId: 'p' } });
  log.run({ type: 'node.create', data: { id: 'r', kind: 'requirement', title: 'Req', parentId: 'g' } });
  return log;
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
  return 'accepted';
};

describe('decide', () => {
  it('derives a unique id from the title when none is given', () => {
    const log = tree();
    log.run({ type: 'node.create', data: { kind: 'kpi', title: 'Checkout conversion rate', parentId: 'r' } });
    log.run({ type: 'node.create', data: { kind: 'kpi', title: 'Checkout conversion rate', parentId: 'r' } });
    expect([...log.u.nodes.keys()]).toContain('checkout-conversion-rate-2');
  });

  it('requires a reason for every evolutionary change', () => {
    const log = tree();
    expect(code(() => log.run({ type: 'node.reprioritize', data: { id: 'r', priority: 'high', reason: '' } }))).toBe('invalid');
    expect(code(() => log.run({ type: 'node.reprioritize', data: { id: 'r', priority: 'high', reason: 'Mobile share passed 60%' } }))).toBe('accepted');
  });

  it('refuses moves and links that would make a node contribute to itself', () => {
    const log = tree();
    expect(code(() => log.run({ type: 'node.move', data: { id: 'g', parentId: 'r', reason: 'try a cycle' } }))).toBe('conflict');
    expect(code(() => log.run({ type: 'node.link', data: { id: 'p', target: 'r', reason: 'try a cycle' } }))).toBe('conflict');
    expect(code(() => log.run({ type: 'node.move', data: { id: 'r', parentId: 'p', reason: 'flatten the tree' } }))).toBe('accepted');
  });

  it('refuses readings for nodes without a measure, and readings from the future', () => {
    const log = tree();
    expect(code(() => log.run({ type: 'reading.record', data: { nodeId: 'r', value: 1 } }))).toBe('invalid');
    log.run({ type: 'node.create', data: { id: 'k', kind: 'kpi', title: 'K', parentId: 'r', measure: pctHigher(90, 80) } });
    expect(code(() => log.run({ type: 'reading.record', data: { nodeId: 'k', value: 95, observedAt: '2030-01-01T00:00:00Z' } }))).toBe('invalid');
  });

  it('refuses timestamps whose offset carries them out of the four-digit years', () => {
    const log = tree();
    log.run({ type: 'node.create', data: { id: 'k', kind: 'kpi', title: 'K', parentId: 'r', measure: pctHigher(90, 80) } });
    // Both are valid ISO-8601 with an offset, but normalise to +010000-… and -000001-…,
    // which sort wrongly as text and which the stored-event schema refuses.
    for (const observedAt of ['9999-12-31T23:30:00-01:00', '0000-01-01T00:30:00+01:00']) {
      expect(code(() => log.run({ type: 'reading.record', data: { nodeId: 'k', value: 95, observedAt } }))).toBe('invalid');
    }
    const [e] = log.run({ type: 'reading.record', data: { nodeId: 'k', value: 95, observedAt: '2025-12-31T22:30:00-01:00' } });
    expect(e!.type === 'reading.recorded' && e!.data.observedAt).toBe('2025-12-31T23:30:00.000Z');
  });

  it('refuses a warning threshold on the good side of the target', () => {
    const log = tree();
    expect(code(() => log.run({ type: 'node.create', data: { kind: 'kpi', title: 'Bad', measure: msLower(500, 400) } }))).toBe('invalid');
  });
});

describe('history', () => {
  it('colours each past reading by the definition in force when it was taken', () => {
    const log = makeLog('2026-03-01T00:00:00.000Z');
    log.run({ type: 'node.create', data: { id: 'p95', kind: 'kpi', title: 'p95', measure: msLower(800, 1200, 48) } });
    log.run({ type: 'reading.record', data: { nodeId: 'p95', value: 610 } });
    log.advanceHours(1);
    log.run({ type: 'node.redefine', data: { id: 'p95', measure: msLower(500, 700, 48), reason: 'SLO review' } });
    log.advanceHours(1);
    log.run({ type: 'reading.record', data: { nodeId: 'p95', value: 610 } });

    const series = readingSeries(log.u, log.u.nodes.get('p95')!, '2026-02-01T00:00:00.000Z', log.now());
    expect(series.map((p) => [p.s, p.version])).toEqual([['ok', 1], ['warn', 2]]);
  });

  it('reports null for moments before a node existed', () => {
    const log = makeLog('2026-03-01T00:00:00.000Z');
    log.run({ type: 'node.create', data: { id: 'a', kind: 'goal', title: 'A' } });
    log.advanceHours(48);
    log.run({ type: 'node.create', data: { id: 'b', kind: 'goal', title: 'B' } });
    const h = statusHistory(log.events, ['2026-03-01T12:00:00.000Z', '2026-03-03T12:00:00.000Z']);
    expect(h.get('a')).toEqual(['unknown', 'unknown']);
    expect(h.get('b')).toEqual([null, 'unknown']);
  });
});
