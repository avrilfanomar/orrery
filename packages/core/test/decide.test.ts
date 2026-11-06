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

  it('refuses a timestamp whose offset names no instant, rather than failing on it', () => {
    const log = tree();
    log.run({ type: 'node.create', data: { id: 'k', kind: 'kpi', title: 'K', parentId: 'r', measure: pctHigher(90, 80) } });
    // Well spelled for zod, but Date.parse gives NaN for an offset past ±23:59.
    for (const observedAt of ['2025-12-31T22:30:00+99:00', '2025-12-31T22:30:00-24:00']) {
      expect(() => log.run({ type: 'reading.record', data: { nodeId: 'k', value: 95, observedAt } })).toThrow(/a UTC offset runs from -23:59 to \+23:59/);
    }
    expect(log.run({ type: 'reading.record', data: { nodeId: 'k', value: 95, observedAt: '2025-12-31T22:30:00+23:59' } })).toHaveLength(1);
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

describe('references', () => {
  const code_ = (path: string, extra: Record<string, unknown> = {}) => ({ kind: 'code', target: { repo: 'shop', path }, ...extra });

  it('refuses what would break a node’s references, and only that', () => {
    const log = tree();
    expect(code(() => log.run({ type: 'node.reference', data: { id: 'nope', ref: code_('src/a.ts') } }))).toBe('not_found');
    expect(code(() => log.run({ type: 'node.reference', data: { id: 'r', ref: code_('src/a.ts') } }))).toBe('accepted');
    expect(code(() => log.run({ type: 'node.reference', data: { id: 'r', ref: code_('src/a.ts', { label: 'renamed' }) } }))).toBe('conflict');
    expect(code(() => log.run({ type: 'node.unreference', data: { id: 'r', ref: code_('src/b.ts') } }))).toBe('conflict');
    expect(code(() => log.run({ type: 'node.reference', data: { id: 'r', ref: { kind: 'ticket', target: { url: 'javascript:alert(1)' } } } }))).toBe('invalid');
    expect(code(() => log.run({ type: 'node.create', data: { kind: 'goal', title: 'Twice', refs: [code_('x.ts'), code_('x.ts', { label: 'again' })] } }))).toBe('invalid');
  });

  it('keeps a harvested and a hand reference to one file apart, and removes one by its key whatever its label', () => {
    const log = tree();
    log.run({ type: 'node.reference', data: { id: 'r', ref: code_('src/a.ts', { label: 'Payments' }), reason: 'Where the charge happens' } });
    log.run({ type: 'node.reference', data: { id: 'r', ref: code_('src/a.ts', { origin: 'tag' }) } });
    expect(log.u.nodes.get('r')!.refs).toHaveLength(2);
    const [removed] = log.run({ type: 'node.unreference', data: { id: 'r', ref: code_('src/a.ts') } });
    // The event records what was held, label included.
    expect(removed).toMatchObject({ type: 'node.unreferenced', data: { ref: { label: 'Payments' }, reason: null } });
    expect(log.u.nodes.get('r')!.refs).toEqual([code_('src/a.ts', { origin: 'tag' })]);
  });

  it('accepts a reference on a deprecated node, and refuses the one past the limit', () => {
    const log = tree();
    log.run({ type: 'node.deprecate', data: { id: 'r', reason: 'Superseded' } });
    for (let i = 0; i < 100; i++) log.run({ type: 'node.reference', data: { id: 'r', ref: code_(`src/f${i}.ts`) } });
    expect(code(() => log.run({ type: 'node.reference', data: { id: 'r', ref: code_('src/one-more.ts') } }))).toBe('invalid');
  });

  it('writes a create without references as it was written before references existed, and tells the timeline what changed', () => {
    const log = tree();
    const charge = { kind: 'code', target: { repo: 'shop', path: 'src/pay.ts', symbol: 'charge' } };
    expect('refs' in log.events[0]!.data).toBe(false);
    log.run({ type: 'node.create', data: { id: 'k', kind: 'kpi', title: 'Errors', parentId: 'r', refs: [charge] } });
    expect(log.u.nodes.get('k')!.refs).toEqual([charge]);
    log.run({ type: 'node.reference', data: { id: 'k', ref: { kind: 'runbook', target: { url: 'https://wiki.example/runbooks/errors' } } } });
    expect(log.u.timeline.at(-1)!.summary).toBe('“Errors” now references runbook https://wiki.example/runbooks/errors');
    log.run({ type: 'node.unreference', data: { id: 'k', ref: charge, reason: 'Moved to the gateway' } });
    expect(log.u.timeline.at(-1)).toMatchObject({ summary: '“Errors” no longer references code shop:src/pay.ts › charge', reason: 'Moved to the gateway' });
  });
});
