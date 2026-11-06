// The reliability promises of the repository, pinned as contracts (ADR 0008):
// what it acknowledged survives a crash, a full disk or a second writer, and a
// fault stays in the request or the binding where it happened. Each outermost
// `describe` is one dogfood scenario.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { decide, parseCommand, project, type NewEvent, type OrreryEvent } from '@orrery/core';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { generateDemo } from '../src/demo.js';
import { freePort, spawnServer, type ServerProcess } from '../src/dogfood/harness.js';
import { repoRoot } from '../src/paths.js';
import { Collector } from '../src/sources/collector.js';
import { startServer, stopOnSignals } from '../src/server.js';
import { serverSettings } from '../src/settings.js';
import { parseSources } from '../src/sources/config.js';
import { EventStore } from '../src/store.js';

const NOW = new Date('2026-11-03T12:00:00.000Z');
const tmp = mkdtempSync(join(tmpdir(), 'orrery-reliability-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const DEMO = generateDemo(NOW);
const text = (events: readonly OrreryEvent[]) => events.map((e) => `${JSON.stringify(e)}\n`).join('');
const fresh = (name: string) => {
  const file = join(tmp, name);
  rmSync(file, { force: true });
  rmSync(`${file}.lock`, { force: true });
  return file;
};
/** A log on disk holding `events`, written the way the store writes one. */
const logOf = (name: string, events: readonly OrreryEvent[]) => {
  const file = fresh(name);
  writeFileSync(file, text(events));
  return file;
};
const reading = (nodeId: string, value: number, observedAt: string) => ({ nodeId, value, observedAt });
const create = (events: readonly OrreryEvent[], id: string): NewEvent[] =>
  decide(project(events), parseCommand({ type: 'node.create', data: { id, kind: 'product', title: id } }), { now: NOW.toISOString(), actor: 'test', sources: new Map() });

// ---------------------------------------------------------------------------
// The real server, as a process
// ---------------------------------------------------------------------------

const SERVER_DIR = join(repoRoot, 'apps/server');
const posix = process.platform !== 'win32';
/** Starting real processes takes seconds on a quiet machine and more on a busy one: vitest's 5 s default failed under a shuffled run. */
const SPAWNS = { timeout: 30_000 };

/** The real server on `file`, as its own process (see spawnServer). */
async function serve(file: string, limitKiB?: number): Promise<ServerProcess> {
  const server = await spawnServer(SERVER_DIR, { PATH: process.env.PATH, ORRERY_DATA_FILE: file, ORRERY_WEB_DIST: join(tmp, 'no-ui') }, limitKiB);
  if ('failed' in server) throw new Error(`the server did not start:\n${server.failed}`);
  return server;
}

const health = async (s: ServerProcess) => (await (await fetch(`${s.url}/api/health`)).json()) as { events: number };
const postReadings = (s: ServerProcess, readings: object[]) =>
  fetch(`${s.url}/api/readings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ readings }) });
/** Readings for the demo's p95 KPI, each a minute apart and before the real clock. */
const minutes = (count: number, from: number) => Array.from({ length: count }, (_, i) => reading('k-p95', 400 + i, new Date(Date.now() - (from + i) * 60_000).toISOString()));

/** Runs reset the way `pnpm reset` does, on `file`, with no server at the address it checks. */
async function reset(file: string): Promise<{ code: number | null; output: string }> {
  const env = { PATH: process.env.PATH, ORRERY_DATA_FILE: file, PORT: String(await freePort()), HOST: '127.0.0.1' };
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/reset.ts'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d: Buffer) => (output += d));
  child.stderr.on('data', (d: Buffer) => (output += d));
  const code = await new Promise<number | null>((done) => child.on('exit', done));
  return { code, output };
}

// ---------------------------------------------------------------------------

describe('the store keeps the log contract', () => {
  const ev = (i: number, patch: object = {}) => ({ ...DEMO[i]!, ...patch });
  it('refuses on load a log that breaks the contract, naming the line an editor shows and what is wrong', () => {
    // Events sit on lines 1, 3, 5: blank lines count, as in an editor.
    const cases: [string, object[], RegExp][] = [
      ['gap', [ev(0), ev(2)], /gap\.jsonl:3: the event has sequence number 3, expected 2/],
      ['repeat', [ev(0), ev(1), ev(1)], /repeat\.jsonl:5: the event has sequence number 2, expected 3/],
      ['reordered', [ev(0), ev(1, { at: '2026-01-01T00:00:00.000Z' })], /reordered\.jsonl:3: the event was recorded at 2026-01-01T00:00:00\.000Z, before the event preceding it/],
      ['zoned', [ev(0, { at: '2026-10-04T12:00:00+00:00' })], /zoned\.jsonl:1: the event was recorded at “2026-10-04T12:00:00\+00:00”, which is not a canonical UTC instant/],
    ];
    for (const [name, events, message] of cases) {
      const file = fresh(`${name}.jsonl`);
      writeFileSync(file, `${events.map((e) => JSON.stringify(e)).join('\n\n')}\n`);
      expect(() => EventStore.open(file, { readOnly: true }), name).toThrow(message);
      expect(existsSync(`${file}.lock`), `${name}: a refused log keeps no lock`).toBe(false);
    }
  });

  it('never writes an event it would refuse on load, and keeps the log and its answers as they were', () => {
    const file = logOf('refuse-write.jsonl', DEMO.slice(0, 20));
    const store = EventStore.open(file);
    const before = readFileSync(file, 'utf8');
    const [made] = create(store.all(), 'x-new');
    expect(() => store.append([{ ...made!, at: '2026-11-03T12:00:00Z' }])).toThrow(/Refused to write event 21: the event was recorded at “2026-11-03T12:00:00Z”, which is not a canonical UTC instant/);
    expect(() => store.replaceAll([DEMO[0]!, DEMO[2]!])).toThrow(/Refused to write event 2 of a new log: the event has sequence number 3, expected 2/);
    expect(store.all()).toHaveLength(20);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(store.append([made!])).toHaveLength(1); // still writable
    store.close();
    expect(EventStore.open(file, { readOnly: true }).all()).toHaveLength(21);
  });

  // A load per byte of six events: seconds on a busy machine, so the 5 s default is too tight (it timed out under the full suite).
  it('loads what came before any cut a crash can leave, or names the cut line and says to delete it', SPAWNS, () => {
    const lines = DEMO.slice(0, 6).map((e) => `${JSON.stringify(e)}\n`);
    const whole = Buffer.from(lines.join(''));
    const file = fresh('cut.jsonl');
    for (let cut = 0; cut <= whole.length; cut++) {
      const prefix = whole.subarray(0, cut);
      writeFileSync(file, prefix);
      const done = prefix.toString('utf8').split('\n');
      const rest = done.pop()!;
      const complete = rest === lines[done.length]?.slice(0, -1);
      if (rest === '' || complete) {
        expect(EventStore.open(file, { readOnly: true }).all(), `cut at byte ${cut}`).toHaveLength(done.length + (complete ? 1 : 0));
      } else {
        expect(() => EventStore.open(file, { readOnly: true }), `cut at byte ${cut}`).toThrow(new RegExp(`cut\\.jsonl:${done.length + 1}: not a complete JSON event — .*delete that line`));
        writeFileSync(file, done.map((l) => `${l}\n`).join('')); // what the message says to do
        expect(EventStore.open(file, { readOnly: true }).all(), `cut at byte ${cut}, line deleted`).toHaveLength(done.length);
      }
    }
  });

  it('supplies a line break a crash left out, so the next event starts a line of its own', () => {
    const file = fresh('no-newline.jsonl');
    writeFileSync(file, text(DEMO.slice(0, 3)).slice(0, -1));
    const store = EventStore.open(file);
    store.append(create(store.all(), 'x-after'));
    store.close();
    expect(readFileSync(file, 'utf8').split('\n')).toHaveLength(5); // four lines and the final break
    expect(EventStore.open(file, { readOnly: true }).all().map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });
});

describe('a failed write changes nothing', () => {
  it.skipIf(!posix)('answers a write the disk refuses partway with an error, and keeps exactly what it acknowledged', SPAWNS, async () => {
    const file = logOf('full-disk.jsonl', DEMO);
    // Room for a few readings, not for a batch: the batch's write stops partway, as on a full disk.
    const server = await serve(file, Math.ceil((statSync(file).size + 3000) / 1024));
    try {
      const held = (await health(server)).events;
      const refused = await postReadings(server, minutes(200, 10));
      expect(refused.status, server.output()).toBe(500);
      expect(await refused.json()).toMatchObject({ code: 'internal', requestId: expect.any(String) });
      expect((await health(server)).events, 'nothing of the failed batch is served').toBe(held);
      expect((await postReadings(server, minutes(1, 5))).status, 'the store stays writable once space allows').toBe(201);
      expect((await health(server)).events).toBe(held + 1);
    } finally {
      server.child.kill('SIGTERM');
      await server.exited;
    }
    const kept = EventStore.open(file, { readOnly: true }).all();
    expect(kept.map((e) => e.seq)).toEqual(Array.from({ length: DEMO.length + 1 }, (_, i) => i + 1));
    expect(readFileSync(file, 'utf8').endsWith('\n')).toBe(true);
  });

  it('leaves the old log whole when a new one cannot be written', () => {
    const file = logOf('replace-fails.jsonl', DEMO.slice(0, 10));
    const before = readFileSync(file);
    const store = EventStore.open(file);
    mkdirSync(`${file}.${process.pid}.tmp`); // where the new log would be written
    expect(() => store.replaceAll(DEMO.slice(0, 3))).toThrow(/EISDIR/);
    expect(readFileSync(file)).toEqual(before);
    expect(store.all()).toHaveLength(10);
    rmSync(`${file}.${process.pid}.tmp`, { recursive: true });
    store.replaceAll(DEMO.slice(0, 3));
    expect(EventStore.open(file, { readOnly: true }).all()).toHaveLength(3);
    store.close();
  });

  it('refuses every write once read-only or closed, and answers as before', () => {
    const file = logOf('read-only.jsonl', DEMO.slice(0, 10));
    const before = readFileSync(file, 'utf8');
    const reader = EventStore.open(file, { readOnly: true });
    expect(() => reader.append(create(reader.all(), 'x-ro'))).toThrow(/cannot be written: it was opened read-only/);
    const writer = EventStore.open(file);
    writer.close();
    expect(() => writer.append(create(writer.all(), 'x-closed'))).toThrow(/cannot be written: it was closed/);
    expect([reader.all().length, writer.all().length]).toEqual([10, 10]);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('one writer per log', () => {
  it('refuses a second writer in the same process until the first lets go', () => {
    const file = logOf('twice.jsonl', DEMO.slice(0, 5));
    const first = EventStore.open(file);
    expect(() => EventStore.open(file)).toThrow(/is already open for writing in this process/);
    expect(EventStore.open(file, { readOnly: true }).all()).toHaveLength(5);
    first.close();
    expect(existsSync(`${file}.lock`)).toBe(false);
    EventStore.open(file).close();
  });

  it('lets go of the log when the server closes', SPAWNS, async () => {
    const file = logOf('closed-server.jsonl', DEMO.slice(0, 5));
    const app = await startServer(serverSettings({ ORRERY_DATA_FILE: file, PORT: String(await freePort()), ORRERY_WEB_DIST: join(tmp, 'no-ui') }), {});
    expect(() => EventStore.open(file)).toThrow(/is already open for writing in this process/);
    await app.close();
    EventStore.open(file).close();
  });

  it.skipIf(!posix)('refuses a writer and a reset while a server writes the log, until it stops cleanly', SPAWNS, async () => {
    const file = logOf('held.jsonl', DEMO.slice(0, 50));
    const server = await serve(file);
    try {
      const pid = server.child.pid!;
      expect(() => EventStore.open(file)).toThrow(`${file} is being written by another process (pid ${pid}). Stop it first; if no such process runs, delete ${file}.lock.`);
      const before = readFileSync(file);
      const refused = await reset(file);
      expect(refused.code, refused.output).toBe(1);
      expect(refused.output).toContain(`being written by another process (pid ${pid})`);
      expect(readFileSync(file)).toEqual(before);
    } finally {
      server.child.kill('SIGTERM');
    }
    expect(await server.exited, server.output()).toBe(0);
    expect(server.output()).toContain('SIGTERM: stopping');
    expect(existsSync(`${file}.lock`)).toBe(false);
    const done = await reset(file);
    expect(done.code, done.output).toBe(0);
    expect(EventStore.open(file, { readOnly: true }).all().length).toBeGreaterThan(50);
  });

  it('takes over a lock whose writer is gone, so a crash needs no hand', async () => {
    const file = logOf('stale.jsonl', DEMO.slice(0, 5));
    const gone = spawn(process.execPath, ['-e', '']);
    await new Promise((done) => gone.on('exit', done));
    for (const pid of [gone.pid!, process.pid]) {
      writeFileSync(`${file}.lock`, `${pid}\n`);
      const store = EventStore.open(file);
      expect(readFileSync(`${file}.lock`, 'utf8').trim()).toBe(String(process.pid));
      store.close();
    }
  });
});

describe('faults stay contained', () => {
  const [source] = parseSources([{ id: 'prom', kind: 'prometheus', url: 'http://prometheus.invalid:9090', stepSeconds: 60, settleSeconds: 30, timeoutSeconds: 5 }], {});
  const matrix = (init?: RequestInit) => {
    const p = new URLSearchParams(String(init?.body));
    const values: [number, string][] = [];
    for (let t = Number(p.get('start')); t <= Number(p.get('end')); t += 60) values.push([t, '0.04']);
    return new Response(JSON.stringify({ status: 'success', data: { resultType: 'matrix', result: [{ metric: {}, values }] } }));
  };
  const bound = (id: string, sourceId = 'prom') => ({
    type: 'node.create',
    data: { id, kind: 'kpi', title: id, measure: { unit: '%', direction: 'lower', target: 0.1, warn: 0.5, staleAfterHours: 1 }, binding: { sourceId, language: 'promql', query: `rate_${id.replace(/\W/g, '_')}` } },
  });

  it('fails only the binding whose answer cannot be recorded, never the server', async () => {
    const file = fresh('collector.jsonl');
    const store = EventStore.open(file);
    const collector = new Collector({ store, sources: [source!], clock: () => NOW, fetch: async (_u, init) => matrix(init), log: () => {} });
    const app = await buildApp({ store, clock: () => new Date(NOW.getTime() - 3_600_000), collector });
    expect((await app.inject({ method: 'POST', url: '/api/commands', payload: bound('k-5xx') })).statusCode).toBe(201);
    store.close(); // every write now fails, as on a disk gone read-only
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    try {
      collector.start();
      await new Promise((r) => setTimeout(r, 200));
      collector.stop();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
    const sources = await app.inject('/api/sources');
    expect(sources.json<{ bindings: object[] }>().bindings).toEqual([
      expect.objectContaining({ nodeId: 'k-5xx', state: 'failing', category: 'internal', detail: 'the answer could not be recorded on this server; its log says why' }),
    ]);
    expect(sources.body).not.toContain(tmp); // the cause, with its path, goes to the log only
    expect((await app.inject('/api/universe')).statusCode).toBe(200);
  });

  it('lets a source that hangs hold up no other source', async () => {
    const [slow, quick] = parseSources(
      [
        { id: 'slow', kind: 'prometheus', url: 'http://slow.invalid:9090', stepSeconds: 60, settleSeconds: 30, timeoutSeconds: 5 },
        { id: 'quick', kind: 'prometheus', url: 'http://quick.invalid:9090', stepSeconds: 60, settleSeconds: 30, timeoutSeconds: 5 },
      ],
      {},
    );
    const store = EventStore.open(null);
    let release: () => void = () => {};
    const hanging = new Promise<void>((done) => (release = done));
    const fetchImpl: typeof fetch = async (url, init) => {
      if (String(url).includes('slow')) await hanging;
      return matrix(init);
    };
    const collector = new Collector({ store, sources: [slow!, quick!], clock: () => NOW, fetch: fetchImpl });
    const app = await buildApp({ store, clock: () => new Date(NOW.getTime() - 3_600_000), collector });
    for (const cmd of [bound('k-slow', 'slow'), bound('k-quick', 'quick')]) expect((await app.inject({ method: 'POST', url: '/api/commands', payload: cmd })).statusCode).toBe(201);
    const stuck = collector.tickSource('slow');
    await collector.tickSource('quick');
    const pulled = (id: string) => store.all().filter((e) => e.type === 'reading.recorded' && e.data.nodeId === id).length;
    expect([pulled('k-quick') > 0, pulled('k-slow')]).toEqual([true, 0]);
    await collector.tickSource('slow'); // still in flight: skipped, not queued
    release();
    await stuck;
    expect(pulled('k-slow')).toBeGreaterThan(0);
  });

  it('answers hostile input with a refusal, never a 500, and leaves the log as it was', async () => {
    const store = EventStore.open(null);
    store.replaceAll(DEMO);
    const app = await buildApp({ store, clock: () => NOW });
    const deep = (open: string, close: string) => `${open.repeat(5000)}1${close.repeat(5000)}`;
    const json = (url: string, payload: string, contentType = 'application/json') => ({ method: 'POST' as const, url, payload, headers: { 'content-type': contentType } });
    const posts = [
      ...['null', '0', '"x"', '[]', '{}', '{', '{"type":', '\u0000', deep('{"a":', '}'), deep('[', ']')].flatMap((p) => [json('/api/commands', p), json('/api/readings', p)]),
      json('/api/commands', '{"type":"node.create","data":{"id":"__proto__","kind":"goal","title":"t"}}'),
      json('/api/commands', '{"type":"node.edit","data":{"id":"k-p95","__proto__":{"title":"polluted"},"reason":"probing"}}'),
      json('/api/commands', '{"type":"node.edit","data":{"id":"hasOwnProperty","title":"x","reason":"probing"}}'),
      json('/api/commands', `{"type":"node.create","data":{"id":"${'x'.repeat(100_000)}","kind":"goal","title":"t"}}`),
      json('/api/commands', '{"type":"node.redefine","data":{"id":"k-p95","measure":{"unit":"ms","direction":"lower","target":1e999,"warn":2e999,"staleAfterHours":1},"reason":"infinite"}}'),
      json('/api/commands', '{"type":"node.move","data":{"id":"k-p95","parentId":"k-p95","reason":"a loop"}}'),
      json('/api/readings', '{"nodeId":"k-p95","value":1e999}'),
      json('/api/readings', '{"nodeId":"k-p95","value":1,"observedAt":"2026-11-03T11:00:00+99:00"}'),
      json('/api/readings', '{"readings":[{"nodeId":"k-p95","value":1},{"nodeId":"k-p95","value":1,"observedAt":"2026-11-03T11:00:00-24:00"}]}'),
      json('/api/commands', 'a=b', 'application/x-www-form-urlencoded'),
      json('/api/commands', 'a=b', 'text/plain'),
    ];
    const gets = [
      '/api/universe?asOf=garbage',
      '/api/universe?asOf=2026-11-03T12:00:00%2B99:00',
      '/api/changes?asOf=2026-11-03T12:00:00-30:00',
      '/api/nodes/k-p95?asOf=2026-11-03T12:00:00%2B24:00',
      '/api/universe?asOf=%2B275760-09-13T00:00:00.000Z',
      '/api/changes?limit=-1',
      '/api/changes?limit=1e309',
      '/api/nodes/__proto__',
      '/api/nodes/constructor',
      `/api/nodes/${'x'.repeat(5000)}`,
      '/api/nodes/%E0%A4%A',
    ];
    const before = store.all().length;
    const answers: string[] = [];
    for (const req of [...posts, ...gets]) {
      const res = await app.inject(req);
      const label = typeof req === 'string' ? req : `${req.url} ${req.payload.slice(0, 60)}`;
      if (res.statusCode >= 500 || (res.statusCode >= 400 && !res.json<{ error?: string }>().error)) answers.push(`${res.statusCode} ${label}: ${res.body.slice(0, 120)}`);
    }
    expect(answers).toEqual([]);
    expect(store.all()).toHaveLength(before);
    expect(({} as Record<string, unknown>).title).toBeUndefined();
  });

  it('keeps taking writes, in order, when the clock steps back', async () => {
    const file = logOf('clock.jsonl', DEMO.slice(0, 30));
    const store = EventStore.open(file);
    let now = NOW.getTime();
    const app = await buildApp({ store, clock: () => new Date(now) });
    for (const step of [0, -3_600_000, -60_000]) {
      now += step;
      const res = await app.inject({ method: 'POST', url: '/api/commands', payload: { type: 'node.create', data: { id: `x-${-step}`, kind: 'product', title: 'Clock' } } });
      expect(res.statusCode, res.body).toBe(201);
    }
    store.close();
    const ats = EventStore.open(file, { readOnly: true }).all().map((e) => e.at);
    expect(ats).toEqual([...ats].sort());
  });
});

describe('stops and restarts cleanly', () => {
  it.skipIf(!posix)('lets go of its log on SIGTERM and exits 0, keeping every acknowledged write', SPAWNS, async () => {
    const file = logOf('sigterm.jsonl', DEMO.slice(0, 50));
    const server = await serve(file);
    expect((await postReadings(server, minutes(3, 10))).status).toBe(201);
    server.child.kill('SIGTERM');
    expect(await server.exited, server.output()).toBe(0);
    expect(existsSync(`${file}.lock`)).toBe(false);
    expect(EventStore.open(file, { readOnly: true }).all()).toHaveLength(53);
  });

  it('takes the same signal again within a second as an echo, and a later one as a second request', async () => {
    // A terminal signals the whole process group and tsx relays the signal to its child, so one Ctrl-C can arrive twice.
    let now = 0;
    let finish: () => void = () => {};
    const closing = new Promise<void>((done) => (finish = done));
    const exits: number[] = [];
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => void exits.push(code ?? 0)) as typeof process.exit);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const before = new Set([...process.listeners('SIGINT'), ...process.listeners('SIGTERM')]);
    const added = (s: NodeJS.Signals) => process.listeners(s).filter((l) => !before.has(l)) as ((signal: NodeJS.Signals) => void)[];
    try {
      stopOnSignals({ close: () => closing } as unknown as FastifyInstance);
      // Called directly: emitting the signal would also run the test runner's own listeners.
      const [onInt, onTerm] = [added('SIGINT'), added('SIGTERM')];
      expect([onInt.length, onTerm.length]).toEqual([1, 1]);
      onInt[0]!('SIGINT');
      now += 200;
      onInt[0]!('SIGINT'); // the echo
      expect(exits).toEqual([]);
      finish();
      await closing;
      await new Promise((r) => setImmediate(r));
      expect(exits, 'closed cleanly').toEqual([0]);
      now += 2000;
      onTerm[0]!('SIGTERM'); // a deliberate second request
      expect(exits).toEqual([0, 143]);
    } finally {
      for (const s of ['SIGINT', 'SIGTERM'] as const) for (const l of added(s)) process.off(s, l);
      [clock, exit, log].forEach((m) => m.mockRestore());
    }
  });

  it.skipIf(!posix)('starts again by itself after a kill, with everything it acknowledged', SPAWNS, async () => {
    const file = logOf('sigkill.jsonl', DEMO.slice(0, 50));
    const first = await serve(file);
    expect((await postReadings(first, minutes(3, 10))).status).toBe(201);
    first.child.kill('SIGKILL');
    await first.exited;
    expect(readFileSync(`${file}.lock`, 'utf8').trim(), 'a kill leaves its lock behind').toBe(String(first.child.pid));
    const second = await serve(file);
    try {
      expect((await health(second)).events).toBe(53);
    } finally {
      second.child.kill('SIGTERM');
      await second.exited;
    }
  });
});
