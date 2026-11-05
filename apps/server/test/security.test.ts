// The security promises of the server, pinned as contracts (ADR 0010). Commands
// carry no credentials, so these hold the line that remains: no web page can act
// through the operator's browser, a reading needs the ingest token by any route,
// every refusal leaves a trace, and no secret leaves the server. The parser's
// share is in packages/core/test/security.test.ts. Each outermost `describe` is
// one dogfood scenario.
import { request } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp, type AppOptions } from '../src/app.js';
import { freePort } from '../src/dogfood/harness.js';
import { SECURITY_HEADERS } from '../src/guard.js';
import { startServer } from '../src/server.js';
import { serverSettings } from '../src/settings.js';
import { Collector } from '../src/sources/collector.js';
import { parseSources } from '../src/sources/config.js';
import { EventStore } from '../src/store.js';

const T0 = Date.parse('2026-11-03T10:00:00.000Z');
const TOKEN = 's3cret-ingest-token';
const tmp = mkdtempSync(join(tmpdir(), 'ru-security-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
/** These tests start real servers (reliability.test.ts says why the timeout is explicit). */
const SPAWNS = { timeout: 30_000 };

const KPI = { type: 'node.create', data: { id: 'k', kind: 'kpi', title: 'K', measure: { unit: 'ms', direction: 'lower', target: 500, warn: 800, staleAfterHours: 24 } } };
const GOAL = { type: 'node.create', data: { kind: 'goal', title: 'A goal' } };

/** A universe with one KPI, served in memory. */
async function universe(opts: Partial<AppOptions> = {}) {
  const store = EventStore.open(null);
  const app = await buildApp({ store, clock: () => new Date(T0), ...opts });
  const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url, payload: payload as object, headers: { authorization: `Bearer ${TOKEN}`, ...headers } });
  expect((await post('/api/commands', KPI)).statusCode).toBe(201);
  return { app, store, post };
}

describe('a web page the operator visits cannot act through the API', () => {
  it('answers only to names nobody else’s DNS can point at it, so a rebound page reads and writes nothing', async () => {
    const { app, store } = await universe({ allowedHosts: ['ru.example.org', '.internal'] });
    const at = (host: string, method: 'GET' | 'POST' = 'GET') => app.inject({ method, url: method === 'GET' ? '/api/universe' : '/api/commands', headers: { host }, ...(method === 'POST' ? { payload: GOAL } : {}) });
    for (const host of ['localhost:4710', '127.0.0.1:4710', '[::1]:4710', '10.0.0.7', 'app.localhost', 'ru.example.org', 'RU.Example.org.', 'ru.internal', 'internal', 'a.b.internal:8443']) {
      expect((await at(host)).statusCode, host).toBe(200);
    }
    const before = store.all().length;
    for (const host of ['attacker.example:4710', 'ru.example.org.attacker.example', 'localhost.attacker.example', 'xinternal', 'internal.attacker.example', '127.0.0.1.nip.io', 'evil@localhost', 'localhost/x']) {
      const read = await at(host);
      expect(read.statusCode, host).toBe(403);
      expect(read.json().error).toMatch(/does not answer to the name .*RU_ALLOWED_HOSTS/);
      expect((await at(host, 'POST')).statusCode, host).toBe(403);
    }
    expect(store.all()).toHaveLength(before);
  });

  it('takes no write from a page of another origin, and every write from the console and from clients that are not browsers', async () => {
    const { app, store } = await universe();
    const write = (headers: Record<string, string>) => app.inject({ method: 'POST', url: '/api/commands', payload: GOAL, headers: { host: '127.0.0.1:4710', ...headers } });
    const before = store.all().length;
    for (const origin of ['https://attacker.example', 'http://127.0.0.1:4711', 'http://localhost:4710', 'null', 'not a url']) {
      const res = await write({ origin });
      expect(res.statusCode, origin).toBe(403);
      expect(res.json().code).toBe('forbidden');
    }
    expect(store.all()).toHaveLength(before);
    expect((await write({ origin: 'http://127.0.0.1:4710' })).statusCode).toBe(201);
    expect((await write({})).statusCode).toBe(201);
    // A read it could not see anyway (no CORS) is not refused.
    expect((await app.inject({ url: '/api/health', headers: { origin: 'https://attacker.example' } })).statusCode).toBe(200);
  });

  it('never turns a body a page may send without asking into a change', async () => {
    // Browsers send these content types across origins without a preflight. Even with no Origin (an old browser), none becomes a command.
    const { app, store } = await universe();
    const before = store.all().length;
    const json = JSON.stringify(GOAL);
    const bodies: [string, string][] = [
      ['text/plain', json],
      ['text/plain;charset=UTF-8', json],
      ['application/x-www-form-urlencoded', `type=node.create&data=${encodeURIComponent(json)}`],
      ['application/x-www-form-urlencoded', encodeURIComponent(json)],
      ['multipart/form-data; boundary=x', `--x\r\nContent-Disposition: form-data; name="type"\r\n\r\nnode.create\r\n--x--\r\n`],
    ];
    for (const [type, payload] of bodies) {
      for (const url of ['/api/commands', '/api/readings']) {
        const res = await app.inject({ method: 'POST', url, payload, headers: { 'content-type': type } });
        expect(res.statusCode, `${type} → ${url}`).toBeGreaterThanOrEqual(400);
      }
    }
    expect(store.all()).toHaveLength(before);
  });

  it('tells browsers not to frame it, run anything foreign in it or read an answer as another type', async () => {
    const web = join(tmp, 'web');
    mkdirSync(web, { recursive: true });
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>console</title>');
    const { app } = await universe({ webDist: web });
    for (const [url, host] of [['/', 'localhost'], ['/some/deep/link', 'localhost'], ['/api/universe', 'localhost'], ['/api/nope', 'localhost'], ['/api/universe', 'attacker.example']] as const) {
      const res = await app.inject({ url, headers: { host } });
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(res.headers[name], `${name} on ${url} via ${host}`).toBe(value);
    }
    expect(SECURITY_HEADERS['content-security-policy']).toMatch(/default-src 'self'.*frame-ancestors 'none'/);
  });

  it('holds on the real server, which answers to the names RU_ALLOWED_HOSTS lists', SPAWNS, async () => {
    const port = await freePort();
    const app = await startServer(serverSettings({ RU_DATA_FILE: join(tmp, 'real.jsonl'), PORT: String(port), RU_ALLOWED_HOSTS: 'ru.example.org', RU_WEB_DIST: join(tmp, 'no-ui') }), {});
    // fetch may not set Host, which is the whole point of a rebinding attack; node:http may.
    const status = (host: string) =>
      new Promise<number>((done, fail) => request({ host: '127.0.0.1', port, path: '/api/health', headers: { host } }, (res) => done(res.resume() && res.statusCode!)).on('error', fail).end());
    try {
      expect(await status(`127.0.0.1:${port}`)).toBe(200);
      expect(await status('ru.example.org')).toBe(200);
      expect(await status(`attacker.example:${port}`)).toBe(403);
    } finally {
      await app.close();
    }
  });
});

describe('readings need the ingest token by any route', () => {
  it('refuses a reading without the token, through the webhook and through commands alike', async () => {
    const { store, post } = await universe({ ingestToken: TOKEN });
    const reading = { nodeId: 'k', value: 420 };
    const before = store.all().length;
    for (const authorization of ['', 'Bearer', `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}`, TOKEN, `Basic ${TOKEN}`]) {
      expect((await post('/api/readings', reading, { authorization })).statusCode, `webhook, ${authorization}`).toBe(401);
      const cmd = await post('/api/commands', { type: 'reading.record', data: reading }, { authorization });
      expect(cmd.statusCode, `command, ${authorization}`).toBe(401);
      expect(cmd.json()).toEqual({ error: 'A valid ingest token is required', code: 'unauthorized' });
    }
    expect(store.all()).toHaveLength(before);
    expect((await post('/api/readings', reading)).statusCode).toBe(201);
    expect((await post('/api/commands', { type: 'reading.record', data: reading })).statusCode).toBe(201);
    // It guards readings, not the model: commands stay as open as the README says (identity is a stub).
    expect((await post('/api/commands', GOAL, { authorization: '' })).statusCode).toBe(201);
  });

  it('takes readings by either route without asking when no token is set', async () => {
    const { post } = await universe();
    expect((await post('/api/readings', { nodeId: 'k', value: 1 }, { authorization: '' })).statusCode).toBe(201);
    expect((await post('/api/commands', { type: 'reading.record', data: { nodeId: 'k', value: 1 } }, { authorization: '' })).statusCode).toBe(201);
  });

  it('lets no caller sign as the webhook or the collector', async () => {
    const { store, post } = await universe();
    const before = store.all().length;
    for (const actor of ['ingest', 'Collector', '  INGEST  ']) {
      const res = await post('/api/commands', GOAL, { 'x-actor': actor });
      expect(res.statusCode, actor).toBe(400);
      expect(res.json().error).toMatch(/one of the server’s own writers/);
    }
    expect(store.all()).toHaveLength(before);
    expect((await post('/api/commands', GOAL, { 'x-actor': 'ingestion-team' })).json().events[0].actor).toBe('ingestion-team');
  });
});

describe('a refusal leaves a trace', () => {
  const linesOf = (out: string[]) => out.map((l) => JSON.parse(l) as Record<string, unknown>);

  it('logs every refusal under its request id, with what it named and where it came from, but never the credentials offered', async () => {
    const out: string[] = [];
    const { app, post } = await universe({ ingestToken: TOKEN, logger: { write: (l) => out.push(l) } });
    await app.inject({ url: '/api/universe', headers: { host: 'attacker.example' } });
    await post('/api/commands', GOAL, { origin: 'https://attacker.example' });
    await post('/api/readings', { nodeId: 'k', value: 1 }, { authorization: 'Bearer a-guess-at-the-token' });
    const refusals = linesOf(out).filter((l) => l.refused);
    expect(refusals.map((l) => [l.refused, l.level])).toEqual([['host', 40], ['origin', 40], ['ingest token', 40]]);
    expect(refusals.every((l) => typeof l.reqId === 'string' && l.remote === '127.0.0.1' && typeof l.url === 'string')).toBe(true);
    expect(refusals[0]).toMatchObject({ host: 'attacker.example' });
    expect(refusals[1]).toMatchObject({ origin: 'https://attacker.example' });
    expect(out.join('')).not.toMatch(/a-guess-at-the-token|s3cret/);
  });
});

describe('no secret leaves the server', () => {
  it('never lets a source’s token out: not into the log, an answer, or a line the server prints, whatever the source sends back', async () => {
    const SECRET = 'glsa_canary_9f8e7d6c5b4a';
    // An upstream that echoes the credentials back in every way it can fail, and once in a series label.
    const replies = [
      (auth: string) => new Response(JSON.stringify({ status: 'error', errorType: 'internal', error: `denied ${auth}` }), { status: 500 }),
      (auth: string) => new Response(JSON.stringify({ status: 'error', errorType: 'bad_data', error: `parse error near ${auth}` }), { status: 400 }),
      (auth: string) => new Response(`<html>${auth}</html>`, { status: 502 }),
      (auth: string) => new Response(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [{ metric: { auth }, value: [0, '1'] }] } })),
      (auth: string) => new Response(JSON.stringify({ status: 'success', data: { resultType: 'matrix', result: [{ metric: { auth }, values: [[T0 / 1000, auth]] }, { metric: {}, values: [] }] } })),
      (auth: string) => {
        throw new TypeError(`fetch failed: ${auth}`);
      },
    ];
    let call = 0;
    const fakeFetch = (async (_url: unknown, init?: RequestInit) => replies[call++ % replies.length]!(String((init?.headers as Record<string, string>).authorization))) as typeof fetch;
    const [src] = parseSources([{ id: 'prom', kind: 'prometheus', url: 'http://prometheus.internal:9090', tokenEnv: 'RU_PROM_TOKEN', stepSeconds: 60, settleSeconds: 0, timeoutSeconds: 5 }], { RU_PROM_TOKEN: SECRET });
    let now = T0;
    const file = join(tmp, 'canary.jsonl');
    const store = EventStore.open(file);
    const printed: string[] = [];
    const collector = new Collector({ store, sources: [src!], clock: () => new Date(now), fetch: fakeFetch, log: (m) => printed.push(m) });
    const app = await buildApp({ store, clock: () => new Date(now), collector, logger: { write: (l) => printed.push(l) } });
    const bind = { ...KPI, data: { ...KPI.data, binding: { sourceId: 'prom', language: 'promql', query: 'up' } } };
    const bound = await app.inject({ method: 'POST', url: '/api/commands', payload: bind });
    expect(bound.statusCode, bound.body + printed.join('')).toBe(201);
    const answers: string[] = [];
    for (let i = 0; i < replies.length * 2; i++) {
      now += 60_000;
      await collector.tickSource('prom');
      for (const url of ['/api/sources', '/api/universe', '/api/nodes/k', '/api/changes', '/api/health']) answers.push((await app.inject(url)).body);
    }
    expect(call).toBeGreaterThanOrEqual(replies.length);
    store.close();
    expect(readFileSync(file, 'utf8')).not.toContain(SECRET);
    expect(answers.join('\n')).not.toContain(SECRET);
    expect(printed.length).toBeGreaterThan(0);
    expect(printed.join('\n')).not.toContain(SECRET);
    expect(answers.join('\n')).not.toContain('prometheus.internal'); // nor where the server fetches from
  });
});
