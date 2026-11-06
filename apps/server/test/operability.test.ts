// The operability promises of the repository, pinned as contracts (ADR 0007):
// what whoever runs it can rely on when it starts, fails, restarts or is asked
// who changed what. Each outermost `describe` is one dogfood scenario.
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildChangeFeed, evaluateUniverse, project, type OrreryEvent, type TimelineEntry, type UniverseView } from '@orrery/core';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { generateDemo } from '../src/demo.js';
import { scrub } from '../src/dogfood/harness.js';
import { repoRoot } from '../src/paths.js';
import { generateDogfood } from '../src/seeds.js';
import { freePort } from '../src/dogfood/harness.js';
import { startServer } from '../src/server.js';
import { loadRepos, parseRepos } from '../src/repos.js';
import { dogfoodSettings, serverSettings, simulatorSettings, tagSettings, type Env } from '../src/settings.js';
import { Collector } from '../src/sources/collector.js';
import { loadSources, parseSources } from '../src/sources/config.js';
import { EventStore } from '../src/store.js';

const NOW = new Date('2026-11-03T12:00:00.000Z');
const H = 3.6e6;
const DAY = 24 * H;
const post = (url: string, payload: object, headers: Record<string, string> = {}): InjectOptions => ({ method: 'POST', url, payload, headers });
const storeOf = (events: readonly OrreryEvent[]) => {
  const store = EventStore.open(null);
  store.replaceAll(events);
  return store;
};
const tmp = mkdtempSync(join(tmpdir(), 'orrery-operability-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const read = (f: string) => readFileSync(join(repoRoot, f), 'utf8');

/** Runs an entry point of apps/server the way its pnpm script does, with only the settings given. */
function runEntry(file: string, env: Env): Promise<{ code: number | null; stderr: string }> {
  const tsx = join(repoRoot, 'apps/server/node_modules/.bin/tsx');
  return new Promise((done) => {
    const child = execFile(tsx, [file], { cwd: join(repoRoot, 'apps/server'), env: { PATH: process.env.PATH, ...env }, timeout: 20_000 }, (err, _out, stderr) => done({ code: err ? (child.exitCode ?? -1) : 0, stderr }));
  });
}

describe('startup refusals explain themselves', () => {
  const READERS = { serverSettings, simulatorSettings, dogfoodSettings, tagSettings } as const;
  /** Every setting each reader takes. A setting read without a row here fails the completeness test below. */
  const SETTINGS: Record<keyof typeof READERS, string[]> = {
    serverSettings: ['ORRERY_DATA_FILE', 'ORRERY_WEB_DIST', 'HOST', 'PORT', 'ORRERY_SEED', 'ORRERY_INGEST_TOKEN', 'ORRERY_SOURCES_FILE', 'ORRERY_REPOS_FILE', 'ORRERY_ALLOW_REMOTE', 'ORRERY_ALLOWED_HOSTS'],
    simulatorSettings: ['HOST', 'PORT', 'ORRERY_API', 'ORRERY_SIM_TICK_MS', 'ORRERY_INGEST_TOKEN'],
    dogfoodSettings: ['ORRERY_DOGFOOD_FILE', 'ORRERY_DOGFOOD_PORT', 'ORRERY_DOGFOOD_URL', 'ORRERY_PROBE_ENV', 'NO_COLOR'],
    tagSettings: ['HOST', 'PORT', 'ORRERY_API'],
  };
  const BAD: [keyof typeof READERS, string, string][] = [
    ['serverSettings', 'PORT', 'abc'],
    ['serverSettings', 'PORT', '0'],
    ['serverSettings', 'PORT', '70000'],
    ['serverSettings', 'PORT', '4710.5'],
    ['serverSettings', 'ORRERY_SEED', 'production'],
    ['serverSettings', 'ORRERY_ALLOW_REMOTE', 'yes'],
    ['serverSettings', 'ORRERY_ALLOWED_HOSTS', 'https://orrery.example.org'],
    ['serverSettings', 'ORRERY_ALLOWED_HOSTS', 'orrery.example.org,,'],
    ['simulatorSettings', 'PORT', '-1'],
    ['simulatorSettings', 'ORRERY_SIM_TICK_MS', 'abc'],
    ['simulatorSettings', 'ORRERY_SIM_TICK_MS', '0'],
    ['simulatorSettings', 'ORRERY_SIM_TICK_MS', '3000000000'],
    ['simulatorSettings', 'ORRERY_API', 'localhost:4710'],
    ['simulatorSettings', 'ORRERY_API', 'ftp://example.org'],
    ['dogfoodSettings', 'ORRERY_DOGFOOD_PORT', 'eleven'],
    ['dogfoodSettings', 'ORRERY_DOGFOOD_URL', 'not a url'],
    ['tagSettings', 'ORRERY_API', 'localhost:4710'],
  ];

  it('covers every setting the settings module reads', () => {
    const src = scrub(read('apps/server/src/settings.ts'), false);
    const names = new Set([...src.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)].map(([, n]) => n!));
    names.delete('INIT_CWD'); // pnpm's, not ours: where the command was typed
    expect([...names].sort()).toEqual([...new Set(Object.values(SETTINGS).flat())].sort());
  });

  /** One non-default value for every setting, and what it must become: a setting read but ignored fails here. */
  const GOOD: [keyof typeof READERS, string, string, string, unknown][] = [
    ['serverSettings', 'ORRERY_DATA_FILE', '/srv/orrery/events.jsonl', 'dataFile', '/srv/orrery/events.jsonl'],
    ['serverSettings', 'ORRERY_WEB_DIST', '/srv/orrery/web', 'webDist', '/srv/orrery/web'],
    ['serverSettings', 'HOST', '0.0.0.0', 'host', '0.0.0.0'],
    ['serverSettings', 'PORT', '8080', 'port', 8080],
    ['serverSettings', 'ORRERY_SEED', 'dogfood', 'seed', 'dogfood'],
    ['serverSettings', 'ORRERY_INGEST_TOKEN', 's3cret', 'ingestToken', 's3cret'],
    ['serverSettings', 'ORRERY_SOURCES_FILE', '/etc/orrery/sources.json', 'sourcesFile', '/etc/orrery/sources.json'],
    ['serverSettings', 'ORRERY_REPOS_FILE', '/etc/orrery/repos.json', 'reposFile', '/etc/orrery/repos.json'],
    ['serverSettings', 'ORRERY_ALLOW_REMOTE', '1', 'allowRemote', true],
    ['serverSettings', 'ORRERY_ALLOW_REMOTE', '0', 'allowRemote', false],
    ['serverSettings', 'ORRERY_ALLOWED_HOSTS', 'Orrery.example.org, .internal', 'allowedHosts', ['orrery.example.org', '.internal']],
    ['simulatorSettings', 'HOST', '::1', 'api', 'http://[::1]:4710'],
    ['simulatorSettings', 'PORT', '8080', 'api', 'http://127.0.0.1:8080'],
    ['simulatorSettings', 'ORRERY_API', 'https://orrery.example.org/', 'api', 'https://orrery.example.org'],
    ['simulatorSettings', 'ORRERY_SIM_TICK_MS', '5000', 'tickMs', 5000],
    ['simulatorSettings', 'ORRERY_INGEST_TOKEN', 's3cret', 'ingestToken', 's3cret'],
    ['dogfoodSettings', 'ORRERY_DOGFOOD_FILE', '/srv/orrery/dogfood.jsonl', 'file', '/srv/orrery/dogfood.jsonl'],
    ['dogfoodSettings', 'ORRERY_DOGFOOD_PORT', '9000', 'port', 9000],
    ['dogfoodSettings', 'ORRERY_DOGFOOD_URL', 'http://orrery.internal:4711', 'url', 'http://orrery.internal:4711'],
    ['dogfoodSettings', 'ORRERY_PROBE_ENV', 'ci', 'probeEnv', 'ci'],
    ['dogfoodSettings', 'NO_COLOR', '1', 'colour', false],
    ['tagSettings', 'HOST', '::1', 'api', 'http://[::1]:4710'],
    ['tagSettings', 'PORT', '8080', 'api', 'http://127.0.0.1:8080'],
    ['tagSettings', 'ORRERY_API', 'https://orrery.example.org/', 'api', 'https://orrery.example.org'],
  ];

  it('takes every valid setting it is given', () => {
    const pairs = (rows: [string, string][]) => [...new Set(rows.map(([r, n]) => `${r} ${n}`))].sort();
    expect(pairs(GOOD.map(([r, n]) => [r, n]))).toEqual(pairs(Object.entries(SETTINGS).flatMap(([r, names]) => names.map((n): [string, string] => [r, n]))));
    for (const [reader, name, value, field, expected] of GOOD) {
      const got = READERS[reader]({ [name]: value }) as unknown as Record<string, unknown>;
      expect(got[field], `${reader} ${name}=${value}`).toEqual(expected);
    }
  });

  // Real processes and sockets: the 5 s default is too tight on a busy machine (ADR 0008).
  it('starts the server with the settings it was given: its log, its seed and its ingest token', { timeout: 30_000 }, async () => {
    const dataFile = join(tmp, 'started.jsonl');
    const port = await freePort();
    const app = await startServer(serverSettings({ ORRERY_DATA_FILE: dataFile, PORT: String(port), ORRERY_SEED: 'dogfood', ORRERY_INGEST_TOKEN: 's3cret', ORRERY_WEB_DIST: join(tmp, 'no-ui') }), {});
    try {
      const reading = { nodeId: 'k-links', value: 0 };
      const at = `http://127.0.0.1:${port}/api/readings`;
      const send = (headers: Record<string, string>) => fetch(at, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(reading) });
      expect((await send({})).status).toBe(401);
      expect((await send({ authorization: 'Bearer s3cret' })).status).toBe(201);
      const stored = readFileSync(dataFile, 'utf8').trim().split('\n');
      expect(JSON.parse(stored[0]!).actor).toBe('dogfood'); // seeded as asked, never the demo
      expect(JSON.parse(stored.at(-1)!)).toMatchObject({ actor: 'ingest', data: { nodeId: 'k-links' } });
    } finally {
      await app.close();
    }
    const sources = join(tmp, 'one-source.json');
    writeFileSync(sources, JSON.stringify([{ id: 'prom', kind: 'prometheus', url: 'http://prometheus.invalid:9090' }]));
    await expect(startServer(serverSettings({ ORRERY_DATA_FILE: dataFile, HOST: '0.0.0.0', ORRERY_SOURCES_FILE: sources, ORRERY_ALLOW_REMOTE: '0' }), {})).rejects.toThrow(/ORRERY_ALLOW_REMOTE=1/);
  });

  it('refuses a repositories file it cannot use, naming the file and what to fix (ADR 0014)', () => {
    const browse = 'https://git.example/shop/blob/main/{path}';
    expect(parseRepos([{ id: 'shop', browse }])).toEqual([{ id: 'shop', label: 'shop', branch: 'main', browse }]);
    const bad: [unknown, RegExp][] = [
      [[{ id: 'shop', browse: 'https://git.example/shop' }], /\{path\} exactly once/],
      [[{ id: 'shop', browse: 'https://git.example/{path}/{path}' }], /\{path\} exactly once/],
      [[{ id: 'shop', browse: 'https://git.example/{rev}/{path}' }], /no placeholder but/],
      [[{ id: 'shop', browse: 'javascript:alert(1)//{path}' }], /http\(s\)/],
      [[{ id: 'shop', browse: 'https://user:pw@git.example/{path}' }], /no credentials/],
      [[{ id: 'Shop!', browse }], /Repository ids/],
      [[{ id: 'shop', browse, token: 'x' }], /token/],
      [[{ id: 'shop', browse }, { id: 'shop', browse }], /duplicate repository id/],
    ];
    for (const [raw, message] of bad) expect(() => parseRepos(raw, 'repos.json'), JSON.stringify(raw)).toThrow(message);
    expect(() => loadRepos(join(tmp, 'missing.json'))).toThrow(/^ORRERY_REPOS_FILE: .* does not exist/);
    const broken = join(tmp, 'broken-repos.json');
    writeFileSync(broken, '[{');
    expect(() => loadRepos(broken)).toThrow(/^ORRERY_REPOS_FILE: .* is not valid JSON/);
  });

  it.each(BAD)('%s refuses %s=%j, naming the variable and the value', (reader, name, value) => {
    expect(() => READERS[reader]({ [name]: value })).toThrow(new RegExp(`^${name} must .*“${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}”`));
  });

  it('reads an empty or blank setting as unset, so it never means port 0, every interface or no log file', () => {
    for (const [reader, names] of Object.entries(SETTINGS) as [keyof typeof READERS, string[]][]) {
      for (const name of names) for (const blank of ['', '   ']) expect(READERS[reader]({ [name]: blank }), `${reader} ${name}=${JSON.stringify(blank)}`).toEqual(READERS[reader]({}));
    }
    const defaults = serverSettings({ HOST: '', PORT: '', ORRERY_DATA_FILE: '' });
    expect(defaults).toMatchObject({ host: '127.0.0.1', port: 4710, dataFile: join(repoRoot, 'data/events.jsonl') });
    expect(simulatorSettings({ ORRERY_SIM_TICK_MS: '' }).tickMs).toBe(30_000);
  });

  it('refuses a damaged log, naming the file and the line, and says what to do with a cut-off last write', () => {
    const event = (seq: number) => JSON.stringify(generateDemo(NOW)[seq - 1]);
    const cases: [string, string, RegExp][] = [
      ['torn.jsonl', `${event(1)}\n${event(2).slice(0, 40)}`, /torn\.jsonl:2: not a complete JSON event — .*back up the file, then delete that line/],
      ['middle.jsonl', `${event(1)}\n{oops\n${event(2)}\n`, /middle\.jsonl:2: not a complete JSON event — [^]*\.$/],
      ['schema.jsonl', `${JSON.stringify({ seq: 1, at: 'yesterday', actor: 'x', type: 'node.created', data: {} })}\n`, /schema\.jsonl:1: the event does not match the event schema — /],
    ];
    for (const [name, text, message] of cases) {
      const file = join(tmp, name);
      writeFileSync(file, text);
      expect(() => EventStore.open(file), name).toThrow(message);
    }
    expect(() => EventStore.open(join(tmp, 'middle.jsonl'))).not.toThrow(/delete that line/);
  });

  it('refuses a missing or malformed sources file, naming it', () => {
    const broken = join(tmp, 'sources.json');
    writeFileSync(broken, '[{ "id": ');
    expect(() => loadSources(join(tmp, 'nope.json'), {})).toThrow(/^ORRERY_SOURCES_FILE: .*nope\.json does not exist/);
    expect(() => loadSources(broken, {})).toThrow(/^ORRERY_SOURCES_FILE: .*sources\.json is not valid JSON/);
  });

  // Real processes and sockets: the 5 s default is too tight on a busy machine (ADR 0008).
  it('stops the real entry points before they open or serve anything', { timeout: 30_000 }, async () => {
    const dataFile = join(tmp, 'never-created.jsonl');
    const server = await runEntry('src/main.ts', { PORT: 'abc', ORRERY_DATA_FILE: dataFile });
    expect(server.code, server.stderr).not.toBe(0);
    expect(server.stderr).toContain('PORT must be a whole number from 1 to 65535 (got “abc”)');
    expect(existsSync(dataFile)).toBe(false);
    const sim = await runEntry('src/simulate.ts', { ORRERY_SIM_TICK_MS: 'fast', ORRERY_API: 'http://127.0.0.1:9' });
    expect(sim.code, sim.stderr).not.toBe(0);
    expect(sim.stderr).toContain('ORRERY_SIM_TICK_MS must be a whole number');
  });
});

describe('failures are visible', () => {
  it('reports how many events the log holds and when the last one was recorded', async () => {
    const store = storeOf(generateDemo(NOW));
    const app = await buildApp({ store, clock: () => NOW });
    const before = (await app.inject('/api/health')).json<{ ok: boolean; events: number; lastEventAt: string | null }>();
    expect(before).toEqual({ ok: true, events: store.all().length, lastEventAt: store.all().at(-1)!.at });
    expect((await app.inject(post('/api/readings', { nodeId: 'k-p95', value: 420 }))).statusCode).toBe(201);
    expect((await app.inject('/api/health')).json()).toEqual({ ok: true, events: before.events + 1, lastEventAt: NOW.toISOString() });
    const empty = await buildApp({ store: EventStore.open(null) });
    expect((await empty.inject('/api/health')).json()).toEqual({ ok: true, events: 0, lastEventAt: null });
  });

  it('answers an internal error with an id and no detail, and logs the detail under the same id', async () => {
    const real = storeOf(generateDemo(NOW));
    let broken = false;
    const store = Object.assign(Object.create(real) as EventStore, {
      all: () => {
        if (broken) throw new Error('disk on fire at /var/lib/orrery/events.jsonl');
        return real.all();
      },
    });
    const lines: string[] = [];
    const app = await buildApp({ store, clock: () => NOW, logger: { write: (l) => lines.push(l) } });
    expect((await app.inject('/api/universe')).statusCode).toBe(200);
    expect(lines).toEqual([]); // nothing to say while it works
    broken = true;
    const res = await app.inject('/api/universe');
    expect(res.statusCode).toBe(500);
    const body = res.json<{ error: string; code: string; requestId: string }>();
    expect(body).toEqual({ error: 'Internal error', code: 'internal', requestId: expect.any(String) });
    expect(res.body).not.toMatch(/disk|var\/lib/);
    const logged = lines.map((l) => JSON.parse(l) as { reqId?: string; level: number; err?: { message: string; stack: string } });
    const entry = logged.find((l) => l.reqId === body.requestId);
    expect(entry, lines.join('')).toBeDefined();
    expect(entry!.level).toBe(50); // error
    expect(entry!.err?.message).toContain('disk on fire');
    expect(entry!.err?.stack).toContain('operability.test.ts');
  });
});

describe('recovery', () => {
  it('gives back the same universe after a restart', async () => {
    const file = join(tmp, 'restart.jsonl');
    rmSync(file, { force: true });
    const first = EventStore.open(file);
    first.replaceAll(generateDemo(NOW));
    const clock = () => NOW;
    const app = await buildApp({ store: first, clock });
    expect((await app.inject(post('/api/commands', { type: 'node.reprioritize', data: { id: 'r-search', priority: 'critical', reason: 'Search drives a third of revenue' } }))).statusCode).toBe(201);
    expect((await app.inject(post('/api/readings', { nodeId: 'k-p95', value: 610 }))).statusCode).toBe(201);
    const URLS = ['/api/universe', '/api/changes?limit=500', '/api/nodes/k-p95', '/api/health'];
    const answers = async (a: typeof app) => Promise.all(URLS.map(async (u) => (await a.inject(u)).body));
    const before = await answers(app);
    first.close(); // the stopped server lets go of its log
    const restarted = await buildApp({ store: EventStore.open(file), clock });
    expect(await answers(restarted)).toEqual(before);
  });

  it('backfills what a source missed during an outage once it answers again, and says so on the way', async () => {
    const T0 = Date.parse('2026-11-03T10:00:00.000Z');
    let now = T0;
    let down = false;
    const clock = () => new Date(now);
    const fakeFetch: typeof fetch = async (_url, init) => {
      if (down) throw new TypeError('fetch failed');
      const p = new URLSearchParams(String(init?.body));
      const values: [number, string][] = [];
      for (let t = Number(p.get('start')); t <= Number(p.get('end')); t += Number.parseInt(p.get('step')!, 10)) values.push([t, '0.04']);
      return new Response(JSON.stringify({ status: 'success', data: { resultType: 'matrix', result: [{ metric: {}, values }] } }), { headers: { 'content-type': 'application/json' } });
    };
    const [source] = parseSources([{ id: 'prom', kind: 'prometheus', url: 'http://prometheus.invalid:9090', stepSeconds: 60, settleSeconds: 30, timeoutSeconds: 5 }], {});
    const store = EventStore.open(null);
    const said: string[] = [];
    const collector = new Collector({ store, sources: [source!], clock, fetch: fakeFetch, log: (m) => said.push(m) });
    const app = await buildApp({ store, clock, collector });
    const created = await app.inject(
      post('/api/commands', { type: 'node.create', data: { id: 'k-5xx', kind: 'kpi', title: 'Checkout 5xx rate', measure: { unit: '%', direction: 'lower', target: 0.1, warn: 0.5, staleAfterHours: 1 }, binding: { sourceId: 'prom', language: 'promql', query: 'up' } } }),
    );
    expect(created.statusCode, created.body).toBe(201);
    const pulled = () => store.all().flatMap((e) => (e.type === 'reading.recorded' ? [Date.parse(e.data.observedAt)] : []));
    const binding = async () => (await app.inject('/api/sources')).json<{ bindings: { state: string; category: string | null }[] }>().bindings[0]!;
    const status = () => evaluateUniverse(project(store.all()), clock().toISOString()).get('k-5xx')!.status;

    now += 10 * 60_000;
    await collector.tickSource('prom');
    expect(await binding()).toMatchObject({ state: 'ok' });
    const beforeOutage = pulled().length;

    down = true;
    now += 2 * H;
    await collector.tickSource('prom');
    expect(pulled()).toHaveLength(beforeOutage);
    expect(await binding()).toMatchObject({ state: 'failing', category: 'unreachable' });
    expect(status()).toBe('unknown'); // stale, never green
    expect(said).toHaveLength(1);

    down = false;
    now += 60_000;
    await collector.tickSource('prom');
    expect(await binding()).toMatchObject({ state: 'ok' });
    expect(status()).toBe('ok');
    expect(said).toHaveLength(2);
    // Every settled minute from the first pull to now, each once: the outage left no gap and no repeat.
    const at = pulled();
    expect(new Set(at).size).toBe(at.length);
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBe(60_000);
    expect(at.at(-1)).toBe(Math.floor((now - 30_000) / 60_000) * 60_000);
  });
});

describe('on the record', () => {
  /** Event types that change what a node means, where it sits or whether it counts: each must say why. */
  const NEEDS_REASON = new Set(['node.redefined', 'node.reprioritized', 'node.moved', 'node.linked', 'node.unlinked', 'node.deprecated', 'node.reactivated']);

  /** Every way a log fails to say who changed what, when and why, as readable problems. */
  function untraced(events: readonly OrreryEvent[], feed: readonly TimelineEntry[]): string[] {
    const problems: string[] = [];
    for (const e of events) {
      if (!e.actor.trim()) problems.push(`#${e.seq} names no author`);
      if (new Date(e.at).toISOString() !== e.at) problems.push(`#${e.seq} has no exact instant: ${e.at}`);
      const reason = (e.data as { reason?: string | null }).reason;
      if (NEEDS_REASON.has(e.type) && !(reason && reason.trim().length >= 3)) problems.push(`#${e.seq} ${e.type} gives no reason`);
    }
    const changes = events.filter((e) => e.type !== 'reading.recorded');
    if (feed.length !== changes.length) problems.push(`the change feed holds ${feed.length} entries for ${changes.length} changes`);
    [...feed].reverse().forEach((f, i) => {
      const e = changes[i];
      const reason = (e?.data as { reason?: string | null } | undefined)?.reason ?? null;
      if (!e || f.seq !== e.seq || f.actor !== e.actor || f.at !== e.at || f.reason !== reason) problems.push(`feed entry #${f.seq} does not match the event it reports`);
    });
    return problems;
  }

  it('says who changed what, when and why for every change in both seeded universes', () => {
    for (const events of [generateDemo(NOW), generateDogfood(NOW)]) {
      const changes = events.filter((e) => e.type !== 'reading.recorded').length;
      expect(changes).toBeLessThan(500);
      expect(untraced(events, buildChangeFeed(events, { now: NOW.toISOString(), limit: 500 }))).toEqual([]);
    }
  });

  it('records the author each request names, and the source of every reading', async () => {
    const store = storeOf(generateDemo(NOW));
    const app = await buildApp({ store, clock: () => NOW });
    const as = { 'x-actor': 'ops-alice' };
    const COMMANDS = [
      { type: 'node.create', data: { id: 'k-audit', kind: 'kpi', title: 'Audit KPI', parentId: 'r-search', measure: { unit: 'ms', direction: 'lower', target: 100, warn: 200, staleAfterHours: 24 } } },
      { type: 'node.redefine', data: { id: 'k-audit', measure: { unit: 'ms', direction: 'lower', target: 80, warn: 200, staleAfterHours: 24 }, reason: 'Tightened after the search launch' } },
      { type: 'node.reprioritize', data: { id: 'k-audit', priority: 'high', reason: 'Search drives a third of revenue' } },
      { type: 'node.link', data: { id: 'k-audit', target: 'larch-store', reason: 'It also evidences the product goal' } },
      { type: 'node.unlink', data: { id: 'k-audit', target: 'larch-store', reason: 'Counted twice by mistake' } },
      { type: 'node.deprecate', data: { id: 'k-audit', reason: 'Replaced by the search p95' } },
      { type: 'node.reactivate', data: { id: 'k-audit', reason: 'The replacement was rolled back' } },
    ];
    for (const cmd of COMMANDS) {
      const res = await app.inject(post('/api/commands', cmd, as));
      expect(res.statusCode, `${cmd.type}: ${res.body}`).toBe(201);
    }
    expect((await app.inject(post('/api/readings', { nodeId: 'k-audit', value: 75, source: 'ci-nightly' }))).statusCode).toBe(201);
    const written = store.all().slice(-(COMMANDS.length + 1));
    expect(written.slice(0, -1).map((e) => e.actor)).toEqual(COMMANDS.map(() => 'ops-alice'));
    expect(written.at(-1)).toMatchObject({ actor: 'ingest', data: { source: 'ci-nightly' } });
    expect(untraced(store.all(), (await app.inject('/api/changes?limit=500')).json<TimelineEntry[]>())).toEqual([]);
  });

  it('keeps answering what was known on a past day the same way, whatever is written later', async () => {
    let now = NOW;
    const store = storeOf(generateDemo(NOW));
    const app = await buildApp({ store, clock: () => now });
    const T = new Date(NOW.getTime() - 5 * DAY).toISOString();
    const URLS = [`/api/universe?asOf=${T}`, `/api/changes?asOf=${T}&limit=500`, `/api/nodes/k-p95?asOf=${T}`, `/api/nodes/r-search?asOf=${T}`];
    /** The slider's range grows with the log by design; everything else must stay put. */
    const answers = async () =>
      Promise.all(
        URLS.map(async (u) => {
          const body = (await app.inject(u)).json<UniverseView>();
          return JSON.stringify({ ...body, range: undefined });
        }),
      );
    const before = await answers();
    now = new Date(NOW.getTime() + H);
    const later = [
      post('/api/commands', { type: 'node.reprioritize', data: { id: 'r-search', priority: 'critical', reason: 'Search is the launch theme' } }),
      post('/api/commands', { type: 'node.redefine', data: { id: 'k-p95', measure: { unit: 'ms', direction: 'lower', target: 300, warn: 600, staleAfterHours: 2 }, reason: 'Tightened again' } }),
      // Recorded now about a moment before T: it was not known on T, so T's answers must not show it.
      post('/api/readings', { nodeId: 'k-p95', value: 9999, observedAt: new Date(Date.parse(T) - H).toISOString() }),
    ];
    for (const req of later) {
      const res = await app.inject(req);
      expect(res.statusCode, res.body).toBe(201);
    }
    expect(await answers()).toEqual(before);
  });
});

describe('documented operations', () => {
  const manifest = (dir: string) => JSON.parse(read(join(dir, 'package.json'))) as { name: string; scripts?: Record<string, string>; engines?: { node?: string }; devDependencies?: Record<string, string> };
  const PACKAGES = ['.', 'packages/core', 'apps/server', 'apps/web'].map(manifest);
  /** pnpm's own commands, which the docs may name without a script behind them. */
  const BUILTIN = new Set(['install', 'exec', 'audit', 'outdated', 'licenses', 'store', 'why']);

  /** Every `pnpm [--filter <pkg>] <script>` in a document's code — fenced blocks and inline spans — including `pnpm a | b | c` shorthands. */
  function commandsIn(markdown: string): { filter: string | null; script: string }[] {
    const code = [...markdown.matchAll(/^```[^\n]*\n([\s\S]*?)^```|`([^`\n]+)`/gm)].map(([, block, span]) => block ?? span).join('\n');
    const out: { filter: string | null; script: string }[] = [];
    for (const [, filter, first, rest] of code.matchAll(/\bpnpm\s+(?:--filter\s+(\S+)\s+)?([a-z][\w:-]*)((?:\s*\|\s*[a-z][\w:-]*)*)/g)) {
      for (const script of [first!, ...rest!.split('|').map((s) => s.trim()).filter(Boolean)]) out.push({ filter: filter ?? null, script });
    }
    return out;
  }

  it('names only pnpm scripts that exist', () => {
    const seen = new Set<string>();
    const missing: string[] = [];
    for (const doc of ['README.md', 'CLAUDE.md']) {
      for (const { filter, script } of commandsIn(read(doc))) {
        if (BUILTIN.has(script)) continue;
        const pkg = filter ? PACKAGES.find((p) => p.name === filter) : PACKAGES[0];
        const where = `${doc}: pnpm ${filter ? `--filter ${filter} ` : ''}${script}`;
        seen.add(where.slice(doc.length + 2));
        if (!pkg?.scripts?.[script]) missing.push(where);
      }
    }
    expect(missing).toEqual([]);
    for (const known of ['pnpm dev', 'pnpm start', 'pnpm reset', 'pnpm verify', 'pnpm dogfood', 'pnpm dogfood:serve', 'pnpm --filter @orrery/web e2e', 'pnpm --filter @orrery/server test']) expect(seen).toContain(known);
  });

  it('states one Node floor: in engines, .nvmrc, the README and the Node types the code is checked against', () => {
    const floor = /^>=\s*(\d+)\.(\d+)/.exec(PACKAGES[0]!.engines?.node ?? '');
    expect(floor, 'engines.node in package.json').not.toBeNull();
    const [, major, minor] = floor!;
    expect(read('.nvmrc').trim().split('.')[0]).toBe(major);
    expect(read('README.md')).toContain(`Node ≥ ${major}.${minor}`);
    // Types newer than the floor would let code use APIs the floor lacks.
    expect(PACKAGES[0]!.devDependencies?.['@types/node']).toMatch(new RegExp(`^\\^${major}\\.`));
  });

  it('reads a relative path from the directory the command was typed in, as the README’s examples assume', () => {
    const fromRoot = serverSettings({ ORRERY_SOURCES_FILE: 'sources.json', ORRERY_DATA_FILE: 'data/mine.jsonl', INIT_CWD: repoRoot });
    expect(fromRoot.sourcesFile).toBe(join(repoRoot, 'sources.json'));
    expect(fromRoot.dataFile).toBe(join(repoRoot, 'data/mine.jsonl'));
    expect(serverSettings({ ORRERY_SOURCES_FILE: '/etc/orrery/sources.json', INIT_CWD: repoRoot }).sourcesFile).toBe('/etc/orrery/sources.json');
    expect(serverSettings({ ORRERY_SOURCES_FILE: 'sources.json' }).sourcesFile).toBe(join(process.cwd(), 'sources.json'));
  });
});
