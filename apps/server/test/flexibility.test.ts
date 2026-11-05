// The flexibility promises of the repository, pinned as contracts (ADR 0005).
// Each outermost `describe` is one dogfood scenario.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildNodeDetail, buildUniverseView, checkLogEntry, CommandSchema, EventSchema, type OrreryEvent, type UniverseView } from '@orrery/core';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { generateDemo } from '../src/demo.js';
import { BENCH_NOW } from '../src/dogfood/probes.js';
import { repoRoot } from '../src/paths.js';
import { generateDogfood } from '../src/seeds.js';
import { dogfoodSettings, serverSettings } from '../src/settings.js';
import { EventStore } from '../src/store.js';

const NOW = new Date('2026-11-03T12:00:00.000Z');
const post = (url: string, payload: object): InjectOptions => ({ method: 'POST', url, payload });
const storeOf = (events: readonly OrreryEvent[]) => {
  const store = EventStore.open(null);
  store.replaceAll(events);
  return store;
};

describe('frozen history', () => {
  const dir = fileURLToPath(new URL('./fixtures/', import.meta.url));
  /**
   * Logs exactly as earlier versions wrote them. Never edit one: when the event
   * format changes, add events.v<n+1>.jsonl in the new shape and pin it here.
   */
  const FROZEN: Readonly<Record<string, string>> = {
    // Before ADR 0002: node.created carries neither binding nor dashboardUrl.
    'events.v1.jsonl': '8eb73ac6ae78c6aa3f867884db07ae4c396a96d7960506bd12f4a5bcae79ff7c',
    // As of ADR 0003: bindings with and without a source, dashboard links set and cleared, a binding removed, a pulled reading.
    'events.v2.jsonl': '1a9443c0d5ab658f2060f7fa3f0d43b15b942705c5acacf89fde9ce62cc97241',
  };
  const lines = (f: string) => readFileSync(join(dir, f), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as unknown);

  it('keeps every frozen log byte for byte', () => {
    expect(readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()).toEqual(Object.keys(FROZEN).sort());
    for (const [f, sha] of Object.entries(FROZEN)) {
      const actual = createHash('sha256').update(readFileSync(join(dir, f))).digest('hex');
      expect(actual, `${f} is frozen history: add a new version beside it instead of editing it`).toBe(sha);
    }
  });

  it('loads each through the store and holds it to the log contract', async () => {
    for (const f of Object.keys(FROZEN)) {
      const raw = lines(f);
      let prev: OrreryEvent | undefined;
      for (const [i, e] of raw.entries()) {
        const check = checkLogEntry(e, prev);
        expect(check.ok ? null : `line ${i + 1} ${check.problem}`, f).toBeNull();
        if (check.ok) prev = check.event;
      }
      const store = EventStore.open(join(dir, f), { readOnly: true });
      expect(store.all()).toHaveLength(raw.length);
      const app = await buildApp({ store, clock: () => NOW });
      expect((await app.inject('/api/universe')).statusCode, f).toBe(200);
    }
  });

  it('holds, between them, every event type the schema knows', () => {
    const seen = new Set(Object.keys(FROZEN).flatMap((f) => lines(f).map((e) => (e as { type: string }).type)));
    const missing = EventSchema.options.map((o) => o.shape.type.value).filter((t) => !seen.has(t));
    expect(missing, 'A new event type needs a frozen log that holds it').toEqual([]);
  });

  it('reads v1 as it read when written: old readings by the old yardstick, the stub unknown', () => {
    const events = EventStore.open(join(dir, 'events.v1.jsonl'), { readOnly: true }).all();
    const now = '2026-01-07T12:00:00.000Z';
    const view = buildUniverseView(events, { now });
    const status = Object.fromEntries(Object.entries(view.nodes).map(([id, n]) => [id, n.evaluation.status]));
    expect(status).toEqual({ shop: 'warn', 'g-checkout': 'warn', 'k-p95': 'warn', 's-outage': 'ok', 'r-search': 'unknown' });
    expect(view.rootIds).toEqual(['shop']);
    const series = buildNodeDetail(events, 'k-p95', { now })!.series!;
    expect(series.map((p) => [p.v, p.s, p.version])).toEqual([
      [450, 'ok', 1],
      [450, 'warn', 2],
    ]);
  });

  it('reads v2 as it read when written: bindings, links and the pulled reading kept', () => {
    const events = EventStore.open(join(dir, 'events.v2.jsonl'), { readOnly: true }).all();
    const now = '2026-06-02T09:00:00.000Z';
    const view = buildUniverseView(events, { now });
    const node = (id: string) => view.nodes[id]!;
    expect(Object.values(view.nodes).map((n) => [n.id, n.evaluation.status])).toEqual([
      ['shop', 'warn'],
      ['g-fast', 'warn'],
      ['k-p95', 'warn'],
      ['k-bundle', 'ok'],
    ]);
    expect([node('shop').dashboardUrl, node('k-p95').dashboardUrl, node('k-bundle').dashboardUrl]).toEqual(['https://grafana.example/d/shop', 'https://grafana.example/d/checkout?viewPanel=2', null]);
    expect(node('k-bundle').definition.binding).toEqual({ sourceId: null, language: 'probe', query: 'ui-bundle-gzip@1' });
    const p95 = buildNodeDetail(events, 'k-p95', { now })!;
    expect(p95.definitions.map((d) => d.binding?.sourceId ?? null)).toEqual(['prom', null]);
    expect(p95.series!.map((p) => [p.v, p.s, p.version])).toEqual([
      [480, 'ok', 1],
      [520, 'warn', 2],
    ]);
    expect(events.find((e) => e.type === 'reading.recorded' && e.data.source === 'pull:prom')).toBeDefined();
  });
});

describe('time zones', () => {
  // UTC+14, UTC−10 (with summer time) and a European zone with summer time.
  const ZONES = ['UTC', 'Pacific/Kiritimati', 'America/Adak', 'Europe/Kyiv'];
  const PAST = new Date(NOW.getTime() - 9 * 24 * 3.6e6).toISOString();
  const URLS = ['/api/universe', `/api/universe?asOf=${PAST}`, '/api/universe?asOf=2026-10-20', '/api/universe?asOf=2026-10-20T15:00:00%2B03:00', '/api/nodes/k-p95', `/api/nodes/k-lcp?asOf=${PAST}`, '/api/changes?limit=500'];
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  /** Everything a zone could leak into: the seeded demo and the answers about it. */
  async function answersIn(zone: string) {
    process.env.TZ = zone;
    const offset = new Date(NOW).getTimezoneOffset();
    const demo = generateDemo(NOW);
    const app = await buildApp({ store: storeOf(demo), clock: () => NOW });
    const answers: Record<string, string> = { bench: JSON.stringify(generateDemo(BENCH_NOW, 7)), demo: JSON.stringify(demo) };
    for (const url of URLS) {
      const res = await app.inject(url);
      expect(res.statusCode, `${url} in ${zone}`).toBe(200);
      answers[url] = res.body;
    }
    return { offset, answers };
  }

  // Seconds of work on a quiet machine: the 5 s default failed it under a shuffled run (ADR 0008).
  it('seeds the same demo and gives the same answers in every zone', { timeout: 30_000 }, async () => {
    const runs = [];
    for (const zone of ZONES) runs.push(await answersIn(zone));
    // If the runtime ignored the switch, the comparison below would prove nothing.
    expect(new Set(runs.map((r) => r.offset)).size).toBe(ZONES.length);
    for (const [i, run] of runs.entries()) {
      for (const [what, body] of Object.entries(run.answers)) expect(body === runs[0]!.answers[what], `${what} differs in ${ZONES[i]}`).toBe(true);
    }
  });

  it('refuses an instant without a zone instead of reading it in the server’s own', async () => {
    process.env.TZ = 'Pacific/Kiritimati';
    const app = await buildApp({ store: storeOf(generateDemo(NOW)), clock: () => NOW });
    for (const asOf of ['2026-10-20T15:00', '2026-10-20T15:00:00.000', '10/20/2026', 'Oct 20 2026']) {
      const res = await app.inject(`/api/universe?asOf=${encodeURIComponent(asOf)}`);
      expect(res.statusCode, asOf).toBe(400);
      expect(res.json().error).toMatch(/offset/);
    }
  });
});

describe('co-existence', () => {
  it('keeps two universes in one process apart', async () => {
    const demo = await buildApp({ store: storeOf(generateDemo(NOW)), clock: () => NOW });
    const dogfood = await buildApp({ store: storeOf(generateDogfood(NOW)), clock: () => NOW });
    const before = (await dogfood.inject('/api/universe')).body;
    const created = await demo.inject(post('/api/commands', { type: 'node.create', data: { id: 'k-only-here', kind: 'kpi', title: 'Only in the demo', parentId: 'larch-store', measure: { unit: 'ms', direction: 'lower', target: 1, warn: 2, staleAfterHours: 24 } } }));
    expect(created.statusCode, created.body).toBe(201);
    expect((await demo.inject(post('/api/readings', { nodeId: 'k-only-here', value: 1 }))).statusCode).toBe(201);
    expect((await demo.inject('/api/universe')).json<UniverseView>().nodes['k-only-here']).toBeDefined();
    expect((await dogfood.inject('/api/universe')).body).toBe(before);
  });

  it('gives the demo and the dogfood servers their own log and port when nothing is set', () => {
    const demo = serverSettings({});
    const dogfood = dogfoodSettings({});
    expect(demo.dataFile).not.toBe(dogfood.file);
    expect(demo.port).not.toBe(dogfood.port);
  });
});

describe('the documented API', () => {
  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
  const section = (heading: string) => {
    const s = readme.split(/^## /m).find((part) => part.startsWith(`${heading}\n`));
    if (!s) throw new Error(`README.md has no “## ${heading}” section`);
    return s;
  };
  const rows = [...section('API').matchAll(/^\|\s*`([A-Z]+)`\s*\|\s*`([^`?]+)[^`]*`\s*\|(.*)\|\s*$/gm)].map(([, method, url, purpose]) => ({ method: method!, url: url!, purpose: purpose! }));

  it('documents every route the server serves, and serves every route it documents', async () => {
    const source = readFileSync(join(repoRoot, 'apps/server/src/app.ts'), 'utf8');
    const served = [...source.matchAll(/\bapp\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*'([^']+)'/g)].map(([, m, url]) => `${m!.toUpperCase()} ${url}`);
    expect(served.length).toBeGreaterThan(0);
    expect(rows.map((r) => `${r.method} ${r.url}`).sort()).toEqual(served.sort());
    const app = await buildApp({ store: EventStore.open(null) });
    for (const r of rows) expect(app.hasRoute({ method: r.method as 'GET', url: r.url }), `${r.method} ${r.url}`).toBe(true);
  });

  it('lists exactly the commands the API accepts', () => {
    const cell = rows.find((r) => r.method === 'POST' && r.url === '/api/commands')!.purpose;
    let prefix = '';
    const documented = [...cell.matchAll(/`([^`]+)`/g)]
      .flatMap(([, list]) => list!.split('·').map((s) => s.trim()))
      .map((name) => {
        if (name.includes('.')) prefix = name.slice(0, name.indexOf('.') + 1);
        return name.includes('.') ? name : prefix + name;
      });
    expect(documented.sort()).toEqual(CommandSchema.options.map((o) => o.shape.type.value).sort());
  });

  it('accepts the webhook example as written', async () => {
    const example = /curl -X POST localhost:\d+(\/\S+)[\s\S]*?-d '([^']+)'/.exec(section('Feeding it data'));
    expect(example, 'the README’s curl example').not.toBeNull();
    const app = await buildApp({ store: storeOf(generateDemo(NOW)), clock: () => NOW });
    const res = await app.inject(post(example![1]!, JSON.parse(example![2]!)));
    expect(res.statusCode, res.body).toBe(201);
  });
});
