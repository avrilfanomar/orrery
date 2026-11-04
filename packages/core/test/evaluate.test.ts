import { describe, expect, it } from 'vitest';
import { evaluateUniverse, judge, project, readingSeries, rollup, signalPath } from '../src/index.js';
import { makeLog, msLower, pctHigher } from './helpers.js';

describe('judge', () => {
  it('treats the target and warning thresholds as inclusive, in both directions', () => {
    const up = pctHigher(99.9, 99.5);
    expect(judge(99.9, up)).toBe('ok');
    expect(judge(99.5, up)).toBe('warn');
    expect(judge(99.49, up)).toBe('breach');
    const down = msLower(500, 700);
    expect(judge(500, down)).toBe('ok');
    expect(judge(700, down)).toBe('warn');
    expect(judge(701, down)).toBe('breach');
  });
});

describe('measured nodes', () => {
  it('is unknown until the first reading, judged while fresh, and unknown again once stale', () => {
    const log = makeLog();
    log.run({ type: 'node.create', data: { id: 'k', kind: 'kpi', title: 'Latency', measure: msLower(500, 700, 2) } });
    expect(evaluateUniverse(log.u, log.now()).get('k')!.status).toBe('unknown');

    log.run({ type: 'reading.record', data: { nodeId: 'k', value: 620 } });
    const fresh = evaluateUniverse(log.u, log.now()).get('k')!;
    expect(fresh.status).toBe('warn');
    expect(fresh.drivers).toEqual(['k']);

    log.advanceHours(3);
    const stale = evaluateUniverse(log.u, log.now()).get('k')!;
    expect(stale.status).toBe('unknown');
    expect(stale.measurement?.stale).toBe(true);
  });
});

describe('rollup', () => {
  it('reports an unrefined stub as unknown with zero coverage, never as fine', () => {
    const log = makeLog();
    log.run({ type: 'node.create', data: { id: 'g', kind: 'goal', title: 'Search finds things' } });
    const e = evaluateUniverse(log.u, log.now()).get('g')!;
    expect(e.status).toBe('unknown');
    expect(e.reason).toMatch(/Not refined yet/);
    expect(e.coverage).toEqual({ measured: 0, total: 1 });
  });

  it('never rolls an unknown input up as green under worst-of', () => {
    const log = makeLog();
    log.run({ type: 'node.create', data: { id: 'r', kind: 'requirement', title: 'R' } });
    log.run({ type: 'node.create', data: { id: 'a', kind: 'kpi', title: 'A', parentId: 'r', measure: pctHigher(90, 80) } });
    log.run({ type: 'node.create', data: { id: 'b', kind: 'kpi', title: 'B', parentId: 'r', measure: pctHigher(90, 80) } });
    log.run({ type: 'reading.record', data: { nodeId: 'a', value: 95 } });

    let e = evaluateUniverse(log.u, log.now()).get('r')!;
    expect(e.status).toBe('unknown');
    expect(e.coverage).toEqual({ measured: 1, total: 2 });

    log.run({ type: 'reading.record', data: { nodeId: 'b', value: 50 } });
    e = evaluateUniverse(log.u, log.now()).get('r')!;
    expect(e.status).toBe('breach');
    expect(e.drivers).toEqual(['b']);
  });

  const input = (id: string, status: 'ok' | 'warn' | 'breach' | 'unknown', weight = 2, critical = false) => ({ id, title: id, status, weight, critical });

  it('scores weighted inputs by priority, lets a critical breach veto, and keeps unknown from scoring green', () => {
    const rule = { strategy: 'weighted' as const, okAt: 0.9, warnAt: 0.6 };
    expect(rollup(rule, [input('a', 'ok', 8), input('b', 'warn', 1)]).status).toBe('ok'); // 8.5/9 ≈ 0.94
    expect(rollup(rule, [input('a', 'ok', 1), input('b', 'warn', 8)]).status).toBe('breach'); // 5/9 ≈ 0.56
    const veto = rollup(rule, [input('a', 'ok', 4), input('b', 'ok', 4), input('c', 'breach', 8, true)]);
    expect(veto.status).toBe('breach');
    expect(veto.drivers).toEqual(['c']);
    expect(rollup(rule, [input('a', 'ok', 8), input('b', 'unknown', 1)]).status).toBe('unknown');
  });

  it('decides quorum only when the unknown inputs could not change the outcome', () => {
    const rule = { strategy: 'quorum' as const, okShare: 0.75, warnShare: 0.5 };
    expect(rollup(rule, [input('a', 'ok'), input('b', 'ok'), input('c', 'ok'), input('d', 'breach')]).status).toBe('ok');
    expect(rollup(rule, [input('a', 'ok'), input('b', 'ok'), input('c', 'unknown'), input('d', 'breach')]).status).toBe('unknown');
    expect(rollup(rule, [input('a', 'ok'), input('b', 'warn'), input('c', 'breach'), input('d', 'breach')]).status).toBe('warn');
    expect(rollup(rule, [input('a', 'ok'), input('b', 'breach'), input('c', 'breach'), input('d', 'breach')]).status).toBe('breach');
  });

  it('counts a linked contributor in every parent it contributes to', () => {
    const log = makeLog();
    log.run({ type: 'node.create', data: { id: 'checkout', kind: 'requirement', title: 'Checkout' } });
    log.run({ type: 'node.create', data: { id: 'availability', kind: 'requirement', title: 'Availability' } });
    log.run({ type: 'node.create', data: { id: 'errors', kind: 'kpi', title: '5xx', parentId: 'availability', measure: { unit: '%', direction: 'lower', target: 0.1, warn: 0.5, staleAfterHours: 2 } } });
    log.run({ type: 'node.link', data: { id: 'errors', target: 'checkout', reason: 'A failing API is a failing checkout' } });
    log.run({ type: 'reading.record', data: { nodeId: 'errors', value: 2 } });
    const evals = evaluateUniverse(log.u, log.now());
    expect(evals.get('availability')!.status).toBe('breach');
    expect(evals.get('checkout')!.status).toBe('breach');
  });

  it('drops a deprecated contributor out of its parent’s rollup', () => {
    const log = makeLog();
    log.run({ type: 'node.create', data: { id: 'g', kind: 'goal', title: 'G' } });
    log.run({ type: 'node.create', data: { id: 'ok', kind: 'kpi', title: 'Fine', parentId: 'g', measure: pctHigher(90, 80) } });
    log.run({ type: 'node.create', data: { id: 'old', kind: 'constraint', title: 'Support IE11', parentId: 'g' } });
    log.run({ type: 'reading.record', data: { nodeId: 'ok', value: 99 } });
    expect(evaluateUniverse(log.u, log.now()).get('g')!.status).toBe('unknown');
    log.run({ type: 'node.deprecate', data: { id: 'old', reason: 'IE11 traffic below 0.1%' } });
    expect(evaluateUniverse(log.u, log.now()).get('g')!.status).toBe('ok');
  });

  it('follows the drivers down to where a signal originates', () => {
    const log = makeLog();
    log.run({ type: 'node.create', data: { id: 'p', kind: 'product', title: 'P' } });
    log.run({ type: 'node.create', data: { id: 'g', kind: 'goal', title: 'G', parentId: 'p' } });
    log.run({ type: 'node.create', data: { id: 'r', kind: 'requirement', title: 'R', parentId: 'g' } });
    log.run({ type: 'node.create', data: { id: 'k', kind: 'kpi', title: 'K', parentId: 'r', measure: pctHigher(90, 80) } });
    log.run({ type: 'reading.record', data: { nodeId: 'k', value: 10 } });
    const evals = evaluateUniverse(log.u, log.now());
    expect(signalPath(evals, 'p')).toEqual(['g', 'r', 'k']);
  });
});

describe('evolution', () => {
  it('judges the present against the current target while time travel shows the old one', () => {
    const log = makeLog('2026-03-01T00:00:00.000Z');
    log.run({ type: 'node.create', data: { id: 'p95', kind: 'kpi', title: 'p95', measure: msLower(800, 1200, 48) } });
    log.run({ type: 'reading.record', data: { nodeId: 'p95', value: 610 } });
    const before = log.now();
    log.advanceHours(1);
    log.run({ type: 'node.redefine', data: { id: 'p95', measure: msLower(500, 700, 48), reason: 'SLO review' } });

    expect(evaluateUniverse(log.u, log.now()).get('p95')!.status).toBe('warn');
    const past = project(log.events, before);
    expect(evaluateUniverse(past, before).get('p95')!.status).toBe('ok');
    expect(log.u.nodes.get('p95')!.definitions.map((d) => d.version)).toEqual([1, 2]);
    expect(log.u.timeline.at(-1)!.summary).toContain('target ≤ 800 ms → ≤ 500 ms');
  });

  it('makes the latest reading unknown, not green, when a new unit makes it incomparable', () => {
    const log = makeLog('2026-03-01T00:00:00.000Z');
    log.run({ type: 'node.create', data: { id: 'av', kind: 'kpi', title: 'Availability', measure: pctHigher(99.9, 99.5) } });
    log.run({ type: 'reading.record', data: { nodeId: 'av', value: 99.3 } });
    expect(evaluateUniverse(log.u, log.now()).get('av')!.status).toBe('breach');
    log.advanceHours(1);
    const ratio = { unit: 'ratio', direction: 'higher' as const, target: 0.999, warn: 0.995, staleAfterHours: 24 };
    log.run({ type: 'node.redefine', data: { id: 'av', measure: ratio, reason: 'Report availability as a ratio' } });

    // 99.3 ≥ 0.999 would read as green; the old number simply no longer means anything.
    const m = evaluateUniverse(log.u, log.now()).get('av')!.measurement!;
    expect(m.status).toBe('unknown');
    expect(m.value).toBeNull();
    expect(m.reason).toContain('unit (% → ratio)');

    log.advanceHours(1);
    log.run({ type: 'reading.record', data: { nodeId: 'av', value: 0.993 } });
    expect(evaluateUniverse(log.u, log.now()).get('av')!.status).toBe('breach');
  });

  it('makes the latest reading unknown when the direction flips', () => {
    const log = makeLog('2026-03-01T00:00:00.000Z');
    log.run({ type: 'node.create', data: { id: 'e', kind: 'kpi', title: 'Errors', measure: pctHigher(10, 5) } });
    log.run({ type: 'reading.record', data: { nodeId: 'e', value: 2 } });
    log.advanceHours(1);
    log.run({ type: 'node.redefine', data: { id: 'e', measure: { ...pctHigher(10, 5), direction: 'lower', target: 5, warn: 10 }, reason: 'Fewer errors are better' } });
    const m = evaluateUniverse(log.u, log.now()).get('e')!.measurement!;
    expect(m.status).toBe('unknown');
    expect(m.reason).toContain('direction (higher → lower is better)');
  });

  it('judges a reading back-filled from before the node had a measure by its first measure', () => {
    const log = makeLog('2026-03-01T00:00:00.000Z');
    log.run({ type: 'node.create', data: { id: 'k', kind: 'kpi', title: 'K' } });
    log.advanceHours(48);
    log.run({ type: 'node.redefine', data: { id: 'k', measure: pctHigher(90, 80, 24 * 30), reason: 'Now measurable' } });
    log.run({ type: 'reading.record', data: { nodeId: 'k', value: 70, observedAt: '2026-03-02T00:00:00.000Z' } });

    expect(evaluateUniverse(log.u, log.now()).get('k')!.status).toBe('breach');
    const series = readingSeries(log.u, log.u.nodes.get('k')!, '2026-02-01T00:00:00.000Z', log.now());
    expect(series.map((p) => [p.s, p.version])).toEqual([['breach', 2]]);
  });
});
