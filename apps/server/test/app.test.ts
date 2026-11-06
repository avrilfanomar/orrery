import { describe, expect, it } from 'vitest';
import { buildUniverseView, evaluateUniverse, project, referencedBy, signalPath, type UniverseView } from '@orrery/core';
import { buildApp } from '../src/app.js';
import { generateDemo } from '../src/demo.js';
import { EventStore } from '../src/store.js';

const NOW = new Date('2026-11-03T12:00:00.000Z');
const DAY = 24 * 3.6e6;

async function setup() {
  const store = EventStore.open(null);
  store.replaceAll(generateDemo(NOW));
  const app = await buildApp({ store, clock: () => NOW });
  return { app, store };
}

describe('the demo universe', () => {
  it('tells the intended story at "now"', () => {
    const events = generateDemo(NOW);
    const u = project(events, NOW.toISOString());
    const ev = evaluateUniverse(u, NOW.toISOString());
    const status = (id: string) => ev.get(id)!.status;

    expect(status('larch-store')).toBe('breach');
    expect(status('k-5xx')).toBe('breach');
    expect(status('r-checkout')).toBe('breach'); // through the link from k-5xx
    expect(status('k-p95')).toBe('warn'); // tightened target
    expect(status('r-search')).toBe('unknown'); // unrefined stub
    expect(status('s-residency-audit')).toBe('unknown'); // never run
    expect(status('g-safe')).toBe('unknown');
    expect(status('g-ship')).toBe('ok');
    expect(u.nodes.get('c-ie11')!.lifecycle).toBe('deprecated');
    expect(signalPath(ev, 'larch-store').at(-1)).toBe('k-5xx');

    // ADR 0002: the Prometheus KPIs document their query, but nothing pulls
    // them — the simulator keeps pushing, so the story above is unchanged.
    for (const id of ['k-5xx', 'k-p95', 'k-availability']) {
      const n = u.nodes.get(id)!;
      expect(n.definitions.at(-1)!.binding).toMatchObject({ sourceId: null, language: 'promql' });
      expect(n.dashboardUrl).toMatch(/^https:\/\/grafana\.larch\.example\//);
    }
  });

  it('leads from the 5xx KPI to the payments code, and from that file to both requirements it backs (ADR 0014)', () => {
    const view = buildUniverseView(generateDemo(NOW), { now: NOW.toISOString() });
    const payments = { repo: 'larch-shop', path: 'services/checkout/src/payments.ts' };
    expect(view.nodes['k-5xx']!.refs).toContainEqual({ kind: 'code', target: payments, origin: 'tag' });
    expect(referencedBy(view, payments).map((r) => [r.node.id, r.match])).toEqual([
      ['k-5xx', 'exact'],
      ['r-checkout', 'directory'],
    ]);
    // Every reference outside the repository is a fictional link a person follows.
    const urls = Object.values(view.nodes).flatMap((n) => n.refs.flatMap((r) => ('url' in r.target ? [r.target.url] : [])));
    expect(urls.length).toBeGreaterThan(3);
    for (const u of urls) expect(u).toMatch(/^https:\/\/[a-z]+\.larch\.example\//);
  });
});

describe('API', () => {
  it('serves the live universe and the same model as it was three weeks ago', async () => {
    const { app } = await setup();
    const live = (await app.inject('/api/universe')).json<UniverseView>();
    expect(live.live).toBe(true);
    expect(live.nodes['k-p95']!.evaluation.status).toBe('warn');
    expect(live.nodes['k-p95']!.ribbon).toHaveLength(14);

    const asOf = new Date(NOW.getTime() - 20 * DAY).toISOString();
    const past = (await app.inject(`/api/universe?asOf=${asOf}`)).json<UniverseView>();
    expect(past.live).toBe(false);
    expect(past.nodes['k-p95']!.evaluation.status).toBe('ok');
    expect(past.nodes['k-p95']!.definition.measure!.target).toBe(800);
    expect(past.nodes['r-search']).toBeUndefined();
  });

  it('serves the repositories references lead into, and none when none are configured', async () => {
    const { app } = await setup();
    expect((await app.inject('/api/repos')).json()).toEqual({ repositories: [] });
    const store = EventStore.open(null);
    const repos = [{ id: 'larch-shop', label: 'Larch shop', branch: 'main', browse: 'https://git.larch.example/larch/shop/src/branch/main/{path}' }];
    const withRepos = await buildApp({ store, clock: () => NOW, repos });
    expect((await withRepos.inject('/api/repos')).json()).toEqual({ repositories: repos });
  });

  it('serves a node’s definitions, history and series', async () => {
    const { app } = await setup();
    const res = await app.inject('/api/nodes/k-p95');
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.definitions).toHaveLength(2);
    expect(d.timeline[0].summary).toContain('v2');
    expect(d.series.length).toBeGreaterThan(100);
    expect((await app.inject('/api/nodes/nope')).statusCode).toBe(404);
  });

  it('refines a node and refuses an evolution step without a reason', async () => {
    const { app } = await setup();
    const created = await app.inject({
      method: 'POST',
      url: '/api/commands',
      headers: { 'x-actor': 'search-team' },
      payload: { type: 'node.create', data: { kind: 'kpi', title: 'Zero-result search rate', parentId: 'r-search', measure: { unit: '%', direction: 'lower', target: 5, warn: 10, staleAfterHours: 24 } } },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().events[0].data.id).toBe('zero-result-search-rate');
    expect(created.json().events[0].actor).toBe('search-team');

    const refused = await app.inject({ method: 'POST', url: '/api/commands', payload: { type: 'node.reprioritize', data: { id: 'r-search', priority: 'critical', reason: '' } } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatch(/reason/i);
  });

  it('ingests readings all-or-nothing', async () => {
    const { app, store } = await setup();
    const before = store.all().length;
    const bad = await app.inject({ method: 'POST', url: '/api/readings', payload: { readings: [{ nodeId: 'k-5xx', value: 0.04 }, { nodeId: 'no-such-kpi', value: 1 }] } });
    expect(bad.statusCode).toBe(404);
    expect(store.all().length).toBe(before);

    const ok = await app.inject({ method: 'POST', url: '/api/readings', payload: { nodeId: 'k-5xx', value: 0.04, source: 'prometheus' } });
    expect(ok.statusCode).toBe(201);
    const view = (await app.inject('/api/universe')).json<UniverseView>();
    expect(view.nodes['k-5xx']!.evaluation.status).toBe('ok');
  });
});
