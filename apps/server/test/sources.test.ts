// ADR 0002 end to end: configuration, the Prometheus module's adapter and the
// collector, against an in-process fake Prometheus speaking the real HTTP API
// shape — and the registry that installs the module (ADR 0013).
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { evaluateUniverse, LanguageIdSchema, project, type RuEvent } from '@ru/core';
import { endpoint } from '@ru/prometheus';
import { buildApp } from '../src/app.js';
import { MODULES, registryProblems, SOURCE_KINDS } from '../src/modules.js';
import { Collector } from '../src/sources/collector.js';
import { assertSafeToServe, parseSources, SHARED_SETTINGS, type ResolvedSource } from '../src/sources/config.js';
import { EventStore } from '../src/store.js';

const T0 = Date.parse('2026-11-03T10:00:00.000Z');
const STEP = 60;
const TOKEN = 'glsa_secret_token_value';
const QUERY = '100 * sum(rate(http_requests_total{code=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))';

// ---------------------------------------------------------------------------
// A fake Prometheus: answers query_range with one series over the asked grid,
// unless a test overrides the reply.
// ---------------------------------------------------------------------------

interface Seen {
  path: string;
  method: string;
  auth: string | undefined;
  params: URLSearchParams;
}
type Reply = (p: URLSearchParams) => { status?: number; body: unknown };

const seen: Seen[] = [];
let reply: Reply;
let server: Server;
let base: string;

const grid = (p: URLSearchParams, value: (t: number) => string | number = () => '0.04') => {
  const values: [number, string][] = [];
  const step = Number.parseInt(p.get('step')!, 10);
  for (let t = Number(p.get('start')); t <= Number(p.get('end')); t += step) values.push([t, String(value(t))]);
  return values;
};
const oneSeries: Reply = (p) => ({ body: { status: 'success', data: { resultType: 'matrix', result: [{ metric: {}, values: grid(p) }] } } });

async function readBody(req: IncomingMessage): Promise<string> {
  let s = '';
  for await (const chunk of req) s += chunk;
  return s;
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const params = new URLSearchParams(await readBody(req));
    seen.push({ path: req.url ?? '', method: req.method ?? '', auth: req.headers.authorization, params });
    const r = reply(params);
    res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r.body));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));
beforeEach(() => {
  seen.length = 0;
  reply = oneSeries;
});

// ---------------------------------------------------------------------------

function source(extra: Record<string, unknown> = {}, env: Record<string, string> = {}): ResolvedSource {
  return parseSources([{ id: 'prom', kind: 'prometheus', url: base, stepSeconds: STEP, settleSeconds: 30, timeoutSeconds: 5, ...extra }], env)[0]!;
}

async function setup(src: ResolvedSource = source()) {
  let now = T0;
  const clock = () => new Date(now);
  const store = EventStore.open(null);
  const collector = new Collector({ store, sources: [src], clock });
  const app = await buildApp({ store, clock, collector });
  const command = (body: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/commands', payload: body });
  const res = await command({
    type: 'node.create',
    data: { id: 'k-5xx', kind: 'kpi', title: 'Checkout 5xx rate', measure: { unit: '%', direction: 'lower', target: 0.1, warn: 0.5, staleAfterHours: 1 }, binding: { sourceId: src.id, language: 'promql', query: QUERY } },
  });
  expect(res.statusCode).toBe(201);
  return {
    app,
    store,
    collector,
    command,
    advance: (ms: number) => {
      now += ms;
    },
    pulled: () => store.all().filter((e): e is Extract<RuEvent, { type: 'reading.recorded' }> => e.type === 'reading.recorded'),
    status: () => evaluateUniverse(project(store.all()), clock().toISOString()).get('k-5xx')!,
  };
}

describe('source configuration', () => {
  it('refuses what an operator should fix before the server starts', () => {
    const one = (s: Record<string, unknown>) => () => parseSources([{ id: 'p', kind: 'prometheus', url: 'http://prom:9090', ...s }], {});
    expect(one({ token: 'abc' })).toThrow(/token/);
    expect(one({ url: 'http://user:pw@prom:9090' })).toThrow(/credentials/);
    expect(one({ url: 'http://prom:9090/?x=1' })).toThrow(/query string/);
    expect(one({ kind: 'datadog' })).toThrow(/kind/);
    expect(one({ stepSeconds: 5 })).toThrow(/stepSeconds/);
    expect(one({ stepSeconds: 20, timeoutSeconds: 10 })).toThrow(/half/);
    expect(() => parseSources([{ id: 'p', kind: 'prometheus', url: 'http://a' }, { id: 'p', kind: 'prometheus', url: 'http://b' }], {})).toThrow(/duplicate/);
  });

  it('keeps a source whose token is missing, but marks it so it is never queried', () => {
    const [s] = parseSources([{ id: 'g', kind: 'prometheus', url: 'http://g', tokenEnv: 'RU_TEST_TOKEN' }], {});
    expect(s!.tokenMissing).toBe(true);
    const [t] = parseSources([{ id: 'g', kind: 'prometheus', url: 'http://g', tokenEnv: 'RU_TEST_TOKEN' }], { RU_TEST_TOKEN: TOKEN });
    expect(t!.token).toBe(TOKEN);
  });

  it('refuses to serve beyond loopback with sources configured, unless told the network is trusted', () => {
    const s = [source()];
    expect(() => assertSafeToServe(s, '0.0.0.0', false)).toThrow(/unauthenticated/);
    expect(() => assertSafeToServe(s, '127.0.0.1', false)).not.toThrow();
    expect(() => assertSafeToServe(s, '0.0.0.0', true)).not.toThrow();
    expect(() => assertSafeToServe([], '0.0.0.0', false)).not.toThrow();
  });

  it('installs modules that claim distinct languages and kinds, and leave the shared settings to the server (ADR 0013)', () => {
    expect(registryProblems(MODULES)).toEqual([]);
    for (const m of MODULES) for (const l of m.languages ?? []) expect(LanguageIdSchema.safeParse(l.id).success, `${m.id}: ${l.id}`).toBe(true);
    for (const k of SOURCE_KINDS.values()) expect(Object.keys(k.settings).filter((f) => SHARED_SETTINGS.includes(f)), k.kind).toEqual([]);
    // A second module may not take over a language or a kind already installed.
    expect(registryProblems([...MODULES, { id: 'copy', languages: [{ id: 'promql', label: 'PromQL', hint: '' }], sources: [...SOURCE_KINDS.values()] }])).toEqual([
      'language “promql” is declared twice',
      'source kind “prometheus” is declared twice',
    ]);
  });

  it('builds fixed API paths, keeping a base subpath, directly or through Grafana', () => {
    expect(endpoint(source({ url: 'http://prom:9090/' }))).toBe('http://prom:9090/api/v1/query_range');
    expect(endpoint(source({ url: 'https://ops.example.com/grafana', grafana: { datasourceUid: 'P18' } }))).toBe(
      'https://ops.example.com/grafana/api/datasources/proxy/uid/P18/api/v1/query_range',
    );
  });
});

describe('the collector', () => {
  it('records settled grid instants as pulled readings, once each', async () => {
    const t = await setup();
    t.advance(10 * 60_000);
    await t.collector.tickSource('prom');

    const r = t.pulled();
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((e) => e.actor === 'collector' && e.data.source === 'pull:prom')).toBe(true);
    // Settled: nothing newer than now − settle, and every instant on the step grid.
    const newest = Date.parse(r.at(-1)!.data.observedAt);
    expect(newest).toBeLessThanOrEqual(T0 + 10 * 60_000 - 30_000);
    expect(r.every((e) => Date.parse(e.data.observedAt) % (STEP * 1000) === 0)).toBe(true);
    // Never before the binding existed.
    expect(r.every((e) => Date.parse(e.data.observedAt) >= T0)).toBe(true);
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.path).toBe('/api/v1/query_range');
    expect(seen[0]!.params.get('query')).toBe(QUERY);
    expect(t.status().status).toBe('ok');

    // A second tick at the same moment adds nothing.
    const before = t.store.all().length;
    await t.collector.tickSource('prom');
    expect(t.store.all().length).toBe(before);
  });

  it.each([
    ['an HTTP error', () => ({ status: 500, body: { status: 'error', error: 'internal detail: /var/lib/prometheus' } }), 'http'],
    ['a bad query', () => ({ status: 400, body: { status: 'error', errorType: 'bad_data', error: 'parse error' } }), 'bad-query'],
    ['an empty result', () => ({ body: { status: 'success', data: { resultType: 'matrix', result: [] } } }), 'empty'],
    [
      'two series',
      (p: URLSearchParams) => ({ body: { status: 'success', data: { resultType: 'matrix', result: [{ metric: { a: '1' }, values: grid(p) }, { metric: { a: '2' }, values: grid(p) }] } } }),
      'multi-series',
    ],
  ] as [string, Reply, string][])('writes nothing on %s, and the node goes unknown once stale', async (_name, r, category) => {
    const t = await setup();
    // One good reading first, so "unknown" below means stale, not never-measured.
    await t.app.inject({ method: 'POST', url: '/api/readings', payload: { nodeId: 'k-5xx', value: 0.05 } });
    expect(t.status().status).toBe('ok');
    reply = r;
    t.advance(2 * 3.6e6);
    await t.collector.tickSource('prom');
    expect(t.pulled().filter((e) => e.data.source === 'pull:prom')).toHaveLength(0);
    const view = t.collector.describe(project(t.store.all()));
    expect(view.bindings[0]).toMatchObject({ nodeId: 'k-5xx', state: 'failing', category });
    expect(JSON.stringify(view)).not.toContain('/var/lib');
    expect(t.status().status).toBe('unknown');
    expect(t.status().measurement?.stale).toBe(true);
  });

  it('skips NaN and infinite samples instead of recording them', async () => {
    const t = await setup();
    reply = (p) => ({ body: { status: 'success', data: { resultType: 'matrix', result: [{ metric: {}, values: grid(p, (s) => (s % 120 === 0 ? 'NaN' : '+Inf')) }] } } });
    t.advance(10 * 60_000);
    await t.collector.tickSource('prom');
    expect(t.pulled()).toHaveLength(0);
  });

  it('refuses a pass/fail reading that is not 0 or 1 and says why', async () => {
    const t = await setup();
    await t.command({ type: 'node.redefine', data: { id: 'k-5xx', measure: { unit: 'pass/fail', direction: 'higher', target: 1, warn: 1, staleAfterHours: 1 }, reason: 'turned into a check' } });
    t.advance(10 * 60_000);
    await t.collector.tickSource('prom');
    expect(t.pulled()).toHaveLength(0);
    expect(t.collector.describe(project(t.store.all())).bindings[0]).toMatchObject({ category: 'rejected' });
  });

  it('never runs a new query for instants when the old one was in force', async () => {
    const t = await setup();
    t.advance(60 * 60_000); // the collector lags an hour…
    const redefinedAt = T0 + 60 * 60_000;
    const res = await t.command({ type: 'node.redefine', data: { id: 'k-5xx', binding: { sourceId: 'prom', language: 'promql', query: `${QUERY} > 0` }, reason: 'only count real errors' } });
    expect(res.statusCode).toBe(201);
    t.advance(10 * 60_000);
    await t.collector.tickSource('prom'); // …and catches up only from the redefinition on
    const r = t.pulled();
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((e) => Date.parse(e.data.observedAt) >= redefinedAt)).toBe(true);
  });

  it('reaches Prometheus through Grafana with the token, which never leaves the server', async () => {
    const src = source({ url: `${base}/grafana`, grafana: { datasourceUid: 'P18' }, tokenEnv: 'RU_TEST_TOKEN', publicUrl: 'https://grafana.example.com' }, { RU_TEST_TOKEN: TOKEN });
    const t = await setup(src);
    t.advance(5 * 60_000);
    await t.collector.tickSource('prom');
    expect(seen[0]!.path).toBe('/grafana/api/datasources/proxy/uid/P18/api/v1/query_range');
    expect(seen[0]!.auth).toBe(`Bearer ${TOKEN}`);

    const res = await t.app.inject('/api/sources');
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(TOKEN);
    expect(res.body).not.toContain(base); // the internal URL stays internal
    expect(res.json().sources[0]).toEqual({
      id: 'prom',
      kind: 'prometheus',
      runs: ['promql'],
      publicUrl: 'https://grafana.example.com',
      stepSeconds: STEP,
      problem: null,
      details: { route: 'grafana' },
    });
    // The way out opens this query in Grafana Explore, built from the public URL only.
    const { drillOut } = res.json().bindings[0];
    expect(drillOut.label).toBe('Open in Grafana Explore');
    expect(drillOut.href.startsWith('https://grafana.example.com/explore?')).toBe(true);
    expect(JSON.parse(new URL(drillOut.href).searchParams.get('panes')!).ru.queries[0]).toMatchObject({ expr: QUERY, datasource: { uid: 'P18' } });
  });

  it('realigns to the new grid when stepSeconds changes', async () => {
    const t = await setup();
    t.advance(10 * 60_000);
    await t.collector.tickSource('prom');
    const before = t.pulled().length;
    expect(before).toBeGreaterThan(0);

    // Restart with a coarser step on the same log.
    const coarse = new Collector({ store: t.store, sources: [source({ stepSeconds: 300, timeoutSeconds: 5 })], clock: () => new Date(T0 + 30 * 60_000) });
    await coarse.tickSource('prom');
    const added = t.pulled().slice(before);
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((e) => Date.parse(e.data.observedAt) % 300_000 === 0)).toBe(true);
  });

  it('does not query a source whose token is missing', async () => {
    const t = await setup(source({ tokenEnv: 'RU_TEST_TOKEN' }));
    t.advance(5 * 60_000);
    await t.collector.tickSource('prom');
    expect(seen).toHaveLength(0);
    expect(t.collector.describe(project(t.store.all())).bindings[0]).toMatchObject({ category: 'token-missing' });
  });
});

describe('the API', () => {
  it('refuses a pushed reading that claims pull provenance, and a binding to an unknown source', async () => {
    const t = await setup();
    const push = await t.app.inject({ method: 'POST', url: '/api/readings', payload: { nodeId: 'k-5xx', value: 0.01, source: 'pull:prom' } });
    expect(push.statusCode).toBe(400);
    const cmd = await t.command({ type: 'node.redefine', data: { id: 'k-5xx', binding: { sourceId: 'elsewhere', language: 'promql', query: 'up' }, reason: 'try another source' } });
    expect(cmd.statusCode).toBe(400);
  });

  it('reports a binding to a source this server does not have', async () => {
    const store = EventStore.open(null);
    const app = await buildApp({ store, clock: () => new Date(T0), collector: new Collector({ store, sources: [source()] }) });
    await app.inject({ method: 'POST', url: '/api/commands', payload: { type: 'node.create', data: { id: 'k', kind: 'kpi', title: 'K', measure: { unit: '%', direction: 'lower', target: 1, warn: 2, staleAfterHours: 1 }, binding: { sourceId: 'prom', language: 'promql', query: 'up' } } } });
    // The same log, served by a server configured without that source.
    const bare = await buildApp({ store, clock: () => new Date(T0) });
    expect((await bare.inject('/api/sources')).json().bindings[0]).toMatchObject({ nodeId: 'k', category: 'not-configured' });
  });
});
