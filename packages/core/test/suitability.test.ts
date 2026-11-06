// The README's claims about what a person sees (ADR 0012), each pinned where
// its logic lives. Every test here was missing until a deliberate break of the
// claim went unnoticed by the whole suite; `claim-mutants` keeps those breaks
// (CLAIM_MUTANTS in apps/server/src/dogfood/suitability.ts) and checks each
// still turns a test red.
import { describe, expect, it } from 'vitest';
import { backlogBelow, breadcrumbTo, ancestorDirectories, buildUniverseView, countsToward, describeTarget, evaluateUniverse, metricsBelow, readingSeries, referenceHref, referencedBy, referencesBelow, referencesOn, searchUniverse, signalPath, splitReferences, type UniverseView } from '../src/index.js';
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

/**
 * A requirement whose metrics sit at every depth: one two levels down, one
 * linked in from another goal, and one measured node with an unrefined child
 * (its own measurement known, its rolled-up status not). References lead to a
 * file, the directory above it, a ticket and a file elsewhere.
 */
function traceUniverse(): UniverseView {
  const log = makeLog('2026-04-01T00:00:00.000Z');
  const pay = { kind: 'code', target: { repo: 'shop', path: 'services/checkout/pay.ts', symbol: 'charge' } };
  log.run({ type: 'node.create', data: { id: 'p', kind: 'product', title: 'Shop' } });
  log.run({ type: 'node.create', data: { id: 'g', kind: 'goal', title: 'Customers buy', parentId: 'p', refs: [{ kind: 'ticket', target: { url: 'https://tracker.example/T-1' } }] } });
  log.run({ type: 'node.create', data: { id: 'r', kind: 'requirement', title: 'Pay at checkout', parentId: 'g', refs: [{ kind: 'code', target: { repo: 'shop', path: 'services/checkout/' } }] } });
  log.run({ type: 'node.create', data: { id: 's', kind: 'scenario', title: 'Card declined', parentId: 'r' } });
  log.run({ type: 'node.create', data: { id: 'k1', kind: 'kpi', title: 'Checkout errors', parentId: 's', measure: msLower(500, 700), binding: { sourceId: null, language: 'promql', query: 'rate(http_requests_total[5m])' }, refs: [pay, { ...pay, origin: 'tag' }] } });
  log.run({ type: 'reading.record', data: { nodeId: 'k1', value: 400 } });
  log.run({ type: 'node.create', data: { id: 'kself', kind: 'kpi', title: 'Payment time', parentId: 'r', measure: msLower(500, 700) } });
  log.run({ type: 'reading.record', data: { nodeId: 'kself', value: 450 } });
  log.run({ type: 'node.create', data: { id: 'kself-stub', kind: 'scenario', title: 'Slow bank', parentId: 'kself' } });
  log.run({ type: 'node.create', data: { id: 'dep', kind: 'kpi', title: 'Old metric', parentId: 'r', measure: msLower(500, 700) } });
  log.run({ type: 'node.deprecate', data: { id: 'dep', reason: 'Superseded' } });
  log.run({ type: 'node.create', data: { id: 'g2', kind: 'goal', title: 'Customers find', parentId: 'p' } });
  log.run({ type: 'node.create', data: { id: 'k5', kind: 'kpi', title: 'Search latency', parentId: 'g2', links: ['r'], measure: msLower(500, 700), description: 'Slow search costs checkout too', refs: [{ kind: 'code', target: { repo: 'shop', path: 'services/search/find.ts' } }] } });
  return buildUniverseView(log.events, { now: log.now() });
}

const ids = (nodes: { id: string }[]) => nodes.map((n) => n.id).sort();

describe('every connection of a node is one step away', () => {
  it('lists a requirement’s metrics at every depth, through links, without the deprecated', () => {
    const view = traceUniverse();
    expect(ids(metricsBelow(view, 'r'))).toEqual(['k1', 'k5', 'kself']);
    expect(ids(metricsBelow(view, 'p'))).toEqual(['k1', 'k5', 'kself']);
    expect(metricsBelow(view, 'k1')).toEqual([]);
  });

  it('agrees with coverage and the backlog on every node, judged on each node’s own measurement', () => {
    for (const view of [traceUniverse(), gapsUniverse()]) {
      for (const n of Object.values(view.nodes).filter((x) => x.lifecycle === 'active')) {
        const known = (x: typeof n) => x.evaluation.measurement !== null && x.evaluation.measurement.status !== 'unknown';
        const metrics = metricsBelow(view, n.id);
        expect(metrics.filter(known).length + (known(n) ? 1 : 0), n.id).toBe(n.evaluation.coverage.measured);
        const backlog = new Set(backlogBelow(view, n.id).map((x) => x.id));
        for (const m of metrics.filter((x) => !known(x))) expect(backlog.has(m.id), `${n.id} → ${m.id}`).toBe(true);
      }
    }
    // The case the promise is stated for: a known measurement under an unknown rollup.
    const view = traceUniverse();
    expect(view.nodes.kself!.evaluation.status).toBe('unknown');
    expect(view.nodes.kself!.evaluation.measurement!.status).toBe('ok');
  });

  it('lists everything a metric counts toward, nearest first, through every parent and link', () => {
    const view = traceUniverse();
    expect(countsToward(view, 'k5').map((c) => [c.node.id, c.via, c.depth])).toEqual([
      ['g2', 'parent', 1],
      ['r', 'link', 1],
      ['p', 'parent', 2],
      ['g', 'parent', 2],
    ]);
    expect(countsToward(view, 'p')).toEqual([]);
  });

  it('leads from a file, a directory or a URL back to every node that references it', () => {
    const view = traceUniverse();
    const by = (target: Parameters<typeof referencedBy>[1]) => referencedBy(view, target).map((r) => [r.node.id, r.match, r.ref.origin ?? 'hand']);
    expect(by({ repo: 'shop', path: 'services/checkout/pay.ts' })).toEqual([['k1', 'exact', 'hand'], ['k1', 'exact', 'tag'], ['r', 'directory', 'hand']]);
    expect(by({ repo: 'shop', path: 'services/checkout/' })).toEqual([['r', 'exact', 'hand'], ['k1', 'file', 'hand'], ['k1', 'file', 'tag']]);
    expect(by({ url: 'https://tracker.example/T-1' })).toEqual([['g', 'exact', 'hand']]);
    expect(by({ repo: 'other', path: 'services/checkout/pay.ts' })).toEqual([]);
  });

  it('groups the references on and beneath a node by place, a harvested and a hand one as one row', () => {
    const view = traceUniverse();
    expect(referencesOn(view, 'k1')).toMatchObject([{ kinds: ['code'], tagged: true, byHand: true, holders: ['k1'] }]);
    const below = referencesBelow(view, 'g').map((g) => [g.target, g.holders]);
    expect(below).toEqual([
      [{ repo: 'shop', path: 'services/checkout/' }, ['r']],
      [{ repo: 'shop', path: 'services/checkout/pay.ts', symbol: 'charge' }, ['k1']],
      [{ repo: 'shop', path: 'services/search/find.ts' }, ['k5']],
    ]);
  });

  it('shows code and tests under Implementation and everything else under References, code winning a tie', () => {
    const view = traceUniverse();
    const { implementation, other } = splitReferences(referencesBelow(view, 'p'));
    expect(implementation.map((g) => describeTarget(g.target))).toEqual(['shop:services/checkout/', 'shop:services/checkout/pay.ts › charge', 'shop:services/search/find.ts']);
    expect(other.map((g) => describeTarget(g.target))).toEqual(['https://tracker.example/T-1']);
    const both = { target: { repo: 'shop', path: 'README.md' }, kinds: ['doc', 'code'], label: null, tagged: false, byHand: true, holders: ['p'] };
    expect(splitReferences([both]).implementation).toEqual([both]);
  });

  it('climbs a file page’s crumbs one directory at a time, never naming the page itself', () => {
    expect(ancestorDirectories('services/checkout/src/pay.ts')).toEqual(['services/', 'services/checkout/', 'services/checkout/src/']);
    expect(ancestorDirectories('services/checkout/')).toEqual(['services/']);
    expect(ancestorDirectories('README.md')).toEqual([]);
  });

  it('finds a node by id, title, query or description, and a place by path, best first', () => {
    const view = traceUniverse();
    const find = (q: string) => searchUniverse(view, q).map((h) => (h.type === 'node' ? h.id : describeTarget(h.target).split(' › ')[0]!));
    expect(find('k1')[0]).toBe('k1');
    expect(find('checkout')).toEqual(['k1', 'r', 'shop:services/checkout/', 'shop:services/checkout/pay.ts', 'k5']);
    expect(find('http_requests_total')).toEqual(['k1']);
    expect(find('find.ts')).toEqual(['shop:services/search/find.ts']);
    expect(find('  ')).toEqual([]);
  });

  it('builds a link out only to http(s), encoding every path segment', () => {
    const repos = [{ id: 'shop', label: 'Shop', branch: 'main', browse: 'https://git.example/shop/blob/main/{path}' }];
    expect(referenceHref({ repo: 'shop', path: 'src/a b/#1?.ts' }, repos)).toBe('https://git.example/shop/blob/main/src/a%20b/%231%3F.ts');
    expect(referenceHref({ repo: 'shop', path: 'services/checkout/' }, repos)).toBe('https://git.example/shop/blob/main/services/checkout/');
    expect(referenceHref({ repo: 'nowhere', path: 'a.ts' }, repos)).toBeNull();
    expect(referenceHref({ repo: 'shop', path: 'a.ts' }, [{ ...repos[0]!, browse: 'javascript:alert(1)//{path}' }])).toBeNull();
    expect(referenceHref({ url: 'javascript:alert(1)' }, repos)).toBeNull();
    expect(referenceHref({ url: 'https://tracker.example/T-1' }, repos)).toBe('https://tracker.example/T-1');
  });
});
