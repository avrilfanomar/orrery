// ADR 0002: metrics bound to sources. The rules that keep a pulled number
// honest live in `decide`, so they are pinned here, without any network.
import { describe, expect, it } from 'vitest';
import { bindingSince, DomainError, EventSchema, evaluateUniverse, project, PASS_FAIL_UNIT, type SourceCatalog } from '../src/index.js';
import { makeLog, pctHigher } from './helpers.js';

const PROM: SourceCatalog = new Map([['prom', { kind: 'prometheus' }]]);
const Q1 = 'sum(rate(errors_total[5m])) / sum(rate(requests_total[5m])) * 100';
const Q2 = 'sum(rate(errors_total[1h])) / sum(rate(requests_total[1h])) * 100';
const bound = (sourceId: string | null, query = Q1) => ({ sourceId, language: 'promql' as const, query });

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
  return 'accepted';
};

function boundKpi() {
  const log = makeLog();
  log.run({ type: 'node.create', data: { id: 'k', kind: 'kpi', title: 'Error rate', measure: pctHigher(99, 95), binding: bound('prom') } }, 'sre', { sources: PROM });
  return log;
}

const pulled = (value: number, observedAt: string) => ({ type: 'reading.record' as const, data: { nodeId: 'k', value, observedAt, source: 'pull:prom' } });
const asCollector = { sources: PROM, origin: 'collector' as const };

describe('bindings', () => {
  it('needs a measure, and a measure cannot be removed from under one', () => {
    const log = makeLog();
    expect(code(() => log.run({ type: 'node.create', data: { id: 'g', kind: 'goal', title: 'G', binding: bound(null) } }))).toBe('invalid');
    log.run({ type: 'node.create', data: { id: 'k', kind: 'kpi', title: 'K', measure: pctHigher(99, 95), binding: bound(null) } });
    expect(code(() => log.run({ type: 'node.redefine', data: { id: 'k', measure: null, reason: 'no longer measured' } }))).toBe('invalid');
    expect(code(() => log.run({ type: 'node.redefine', data: { id: 'k', measure: null, binding: null, reason: 'no longer measured' } }))).toBe('accepted');
  });

  it('may only name a source this server has configured, but provenance-only needs none', () => {
    const log = makeLog();
    const create = (id: string, sourceId: string | null, sources: SourceCatalog) =>
      code(() => log.run({ type: 'node.create', data: { id, kind: 'kpi', title: id, measure: pctHigher(99, 95), binding: bound(sourceId) } }, 'sre', { sources }));
    expect(create('a', 'grafana2', PROM)).toBe('invalid');
    expect(create('b', 'prom', new Map())).toBe('invalid');
    expect(create('c', 'prom', PROM)).toBe('accepted');
    expect(create('d', null, new Map())).toBe('accepted');
  });

  it('does not re-check an unchanged binding when only a threshold is revised', () => {
    const log = boundKpi();
    // The source has since left the configuration; revising the target must still work.
    expect(code(() => log.run({ type: 'node.redefine', data: { id: 'k', measure: pctHigher(99.5, 95), reason: 'tighter SLO' } }))).toBe('accepted');
  });

  it('starts a new version when the query changes, and records why', () => {
    const log = boundKpi();
    log.advanceHours(1);
    log.run({ type: 'node.redefine', data: { id: 'k', binding: bound('prom', Q2), reason: 'a 1 h window matches the SLO' } }, 'sre', { sources: PROM });
    const n = log.u.nodes.get('k')!;
    expect(n.definitions.map((d) => d.binding?.query)).toEqual([Q1, Q2]);
    expect(log.u.timeline.at(-1)!.summary).toContain('query revised');
  });

  it('keeps logs written before bindings existed loading, with no binding and no dashboard', () => {
    const old = {
      seq: 1,
      at: '2026-01-01T00:00:00.000Z',
      actor: 'x',
      type: 'node.created',
      data: { id: 'k', kind: 'kpi', title: 'K', description: '', parentId: null, links: [], priority: 'medium', dimensions: [], owner: null, measure: null, rollup: { strategy: 'worst' }, scenario: null, reason: null },
    };
    const u = project([EventSchema.parse(old)]);
    expect(u.nodes.get('k')!.definitions[0]!.binding).toBeNull();
    expect(u.nodes.get('k')!.dashboardUrl).toBeNull();
  });
});

describe('dashboard links', () => {
  it('accept only http(s), in commands and in the stored log alike', () => {
    const log = makeLog();
    const create = (dashboardUrl: string) => code(() => log.run({ type: 'node.create', data: { kind: 'kpi', title: 'K', dashboardUrl } }));
    expect(create('javascript:alert(1)')).toBe('invalid');
    expect(create('data:text/html,hi')).toBe('invalid');
    expect(create('https://grafana.example.com/d/abc?viewPanel=2')).toBe('accepted');
    const forged = { seq: 1, at: '2026-01-01T00:00:00.000Z', actor: 'x', type: 'node.edited', data: { id: 'k', dashboardUrl: 'javascript:alert(1)' } };
    expect(EventSchema.safeParse(forged).success).toBe(false);
  });

  it('change by a plain edit, without a new definition version', () => {
    const log = makeLog();
    log.run({ type: 'node.create', data: { id: 'k', kind: 'kpi', title: 'K', measure: pctHigher(99, 95) } });
    log.run({ type: 'node.edit', data: { id: 'k', dashboardUrl: 'https://grafana.example.com/d/new' } });
    const n = log.u.nodes.get('k')!;
    expect(n.dashboardUrl).toBe('https://grafana.example.com/d/new');
    expect(n.definitions).toHaveLength(1);
  });
});

describe('a new query is a new yardstick', () => {
  it('leaves the latest reading not comparable until one arrives under the new query — never a false green', () => {
    const log = boundKpi();
    log.run({ type: 'reading.record', data: { nodeId: 'k', value: 99.5 } });
    expect(evaluateUniverse(log.u, log.now()).get('k')!.status).toBe('ok');

    log.advanceHours(1);
    log.run({ type: 'node.redefine', data: { id: 'k', binding: bound('prom', Q2), reason: 'a 1 h window matches the SLO' } }, 'sre', { sources: PROM });
    const after = evaluateUniverse(log.u, log.now()).get('k')!;
    expect(after.status).toBe('unknown');
    expect(after.reason).toContain('the query');

    log.run({ type: 'reading.record', data: { nodeId: 'k', value: 99.6 } });
    expect(evaluateUniverse(log.u, log.now()).get('k')!.status).toBe('ok');
  });

  it('keeps readings comparable when only the source changes (same query, another route)', () => {
    const log = makeLog();
    log.run({ type: 'node.create', data: { id: 'k', kind: 'kpi', title: 'K', measure: pctHigher(99, 95), binding: bound(null) } });
    log.run({ type: 'reading.record', data: { nodeId: 'k', value: 99.5 } });
    log.advanceHours(1);
    log.run({ type: 'node.redefine', data: { id: 'k', binding: bound('prom'), reason: 'now pulled from Prometheus' } }, 'sre', { sources: PROM });
    expect(evaluateUniverse(log.u, log.now()).get('k')!.status).toBe('ok');
  });
});

describe('pulled readings', () => {
  it('are reserved to the collector — a pusher cannot claim pull provenance', () => {
    const log = boundKpi();
    log.advanceHours(1);
    const at = log.now();
    expect(code(() => log.run(pulled(99.5, at), 'ingest', { sources: PROM }))).toBe('invalid');
    expect(code(() => log.run(pulled(99.5, at), 'collector', asCollector))).toBe('accepted');
    // A plain source name stays free for pushers.
    expect(code(() => log.run({ type: 'reading.record', data: { nodeId: 'k', value: 99.4, source: 'prom' } }))).toBe('accepted');
  });

  it('are recorded once per instant', () => {
    const log = boundKpi();
    log.advanceHours(1);
    const at = log.now();
    log.run(pulled(99.5, at), 'collector', asCollector);
    expect(code(() => log.run(pulled(99.5, at), 'collector', asCollector))).toBe('conflict');
  });

  it('never reach back before the current query was in force', () => {
    const log = boundKpi();
    log.advanceHours(2);
    const before = log.now();
    log.advanceHours(1);
    log.run({ type: 'node.redefine', data: { id: 'k', binding: bound('prom', Q2), reason: 'a 1 h window matches the SLO' } }, 'sre', { sources: PROM });
    log.advanceHours(1);
    expect(code(() => log.run(pulled(99.5, before), 'collector', asCollector))).toBe('conflict');
    expect(code(() => log.run(pulled(99.5, log.now()), 'collector', asCollector))).toBe('accepted');
  });

  it('keep the binding’s start across a threshold-only revision', () => {
    const log = boundKpi();
    const start = log.now();
    log.advanceHours(1);
    log.run({ type: 'node.redefine', data: { id: 'k', measure: pctHigher(99.5, 95), reason: 'tighter SLO' } });
    expect(bindingSince(log.u.nodes.get('k')!)).toBe(start);
  });

  it('are refused for a source the node is not bound to, or once it is deprecated', () => {
    const log = boundKpi();
    log.advanceHours(1);
    const other: SourceCatalog = new Map([...PROM, ['other', { kind: 'prometheus' }]]);
    expect(code(() => log.run({ ...pulled(1, log.now()), data: { ...pulled(1, log.now()).data, source: 'pull:other' } }, 'collector', { sources: other, origin: 'collector' }))).toBe('conflict');
    log.run({ type: 'node.deprecate', data: { id: 'k', reason: 'replaced by an SLO burn rate' } });
    expect(code(() => log.run(pulled(99.5, log.now()), 'collector', asCollector))).toBe('conflict');
  });
});

describe('pass/fail checks', () => {
  it('take only 1 or 0, so a bound query returning 99.9 is refused rather than read as a pass', () => {
    const log = makeLog();
    log.run({ type: 'node.create', data: { id: 's', kind: 'scenario', title: 'S', measure: { unit: PASS_FAIL_UNIT, direction: 'higher', target: 1, warn: 1, staleAfterHours: 24 } } });
    expect(code(() => log.run({ type: 'reading.record', data: { nodeId: 's', value: 99.9 } }))).toBe('invalid');
    expect(code(() => log.run({ type: 'reading.record', data: { nodeId: 's', value: 0 } }))).toBe('accepted');
  });
});
