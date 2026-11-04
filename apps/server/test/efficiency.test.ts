// The efficiency shape of the HTTP shell and of the dogfood's own benchmarks
// (ADR 0004). Machine-independent: reads are counted, limits are exercised,
// workloads are compared — nothing here is timed.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildUniverseView, type RuEvent } from '@ru/core';
import type { InjectOptions } from 'fastify';
import { buildApp, MAX_READINGS_PER_REQUEST } from '../src/app.js';
import { generateDemo } from '../src/demo.js';
import { BENCH_SHAPES, workloadShape } from '../src/dogfood/efficiency.js';
import { withLiveWeek } from '../src/dogfood/harness.js';
import { BENCH_NOW, createContext, PROBES } from '../src/dogfood/probes.js';
import { probeQuery } from '../src/dogfood/sync.js';
import { repoRoot } from '../src/paths.js';
import { EventStore } from '../src/store.js';

const NOW = new Date('2026-11-03T12:00:00.000Z');
const post = (url: string, payload: object): InjectOptions => ({ method: 'POST', url, payload });

describe('log passes per request', () => {
  /** The demo behind an app whose store counts reads of the log's elements. */
  async function counted() {
    const store = EventStore.open(null);
    store.replaceAll(generateDemo(NOW));
    const log = store.all() as RuEvent[];
    let reads = 0;
    const proxy = new Proxy(log, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      },
    });
    vi.spyOn(store, 'all').mockReturnValue(proxy);
    const app = await buildApp({ store, clock: () => NOW });
    /** Reads per stored event while `request` runs. */
    const folds = async (request: InjectOptions) => {
      const n = log.length;
      reads = 0;
      const res = await app.inject(request);
      expect(res.statusCode, res.body).toBeLessThan(300);
      return reads / n;
    };
    return { folds };
  }
  const batch = (n: number) => ({ readings: Array.from({ length: n }, (_, i) => ({ nodeId: 'k-p95', value: 480, observedAt: new Date(NOW.getTime() - i * 1000).toISOString() })) });

  it('decides a whole batch against one projection, however many readings it carries', async () => {
    const { folds } = await counted();
    const one = await folds(post('/api/readings', batch(1)));
    expect(await folds(post('/api/readings', batch(1000)))).toBeCloseTo(one, 2);
  });

  it('projects a command against the same single fold', async () => {
    const { folds } = await counted();
    const one = await folds(post('/api/readings', batch(1)));
    expect(await folds(post('/api/commands', { type: 'node.edit', data: { id: 'k-p95', title: 'Product page latency (p95), renamed' } }))).toBeCloseTo(one, 2);
  });
});

describe('capacity', () => {
  // Every field at its longest: the longest id the schema allows, an 80-character
  // source, a 24-character number and an instant written with an offset.
  const ID = `k${'x'.repeat(63)}`;
  const reading = { nodeId: ID, value: -Number.MAX_VALUE, observedAt: '2026-11-03T13:59:59.999+02:00', source: 's'.repeat(80) };

  async function setup() {
    const store = EventStore.open(null);
    const app = await buildApp({ store, clock: () => NOW });
    await app.inject(post('/api/commands', { type: 'node.create', data: { id: ID, kind: 'kpi', title: 'Longest id', measure: { unit: 'ms', direction: 'lower', target: 500, warn: 700, staleAfterHours: 24 } } }));
    return { app, store };
  }

  it('accepts a batch at the limit whole, with every field at its longest', async () => {
    const { app, store } = await setup();
    const res = await app.inject(post('/api/readings', { readings: new Array(MAX_READINGS_PER_REQUEST).fill(reading) }));
    expect(res.statusCode, res.body).toBe(201); // not 413: the body limit leaves room for the batch limit
    expect(res.json().accepted).toBe(MAX_READINGS_PER_REQUEST);
    expect(store.all().filter((e) => e.type === 'reading.recorded')).toHaveLength(MAX_READINGS_PER_REQUEST);
  });

  it('refuses one reading more as a bad request, and writes none of it', async () => {
    const { app, store } = await setup();
    const before = store.all().length;
    const res = await app.inject(post('/api/readings', { readings: new Array(MAX_READINGS_PER_REQUEST + 1).fill(reading) }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain(String(MAX_READINGS_PER_REQUEST));
    expect(store.all()).toHaveLength(before);
  });
});

describe('benchmark workload', () => {
  // The workloads exactly as the probes get them.
  let tmp: string;
  let demo: RuEvent[];
  let week: RuEvent[];
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ru-efficiency-'));
    const ctx = createContext(repoRoot, tmp);
    demo = ctx.demo();
    week = ctx.week().events;
  }, 60_000);
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('generates the same events on every run', () => {
    expect(JSON.stringify(generateDemo(BENCH_NOW, 7))).toBe(JSON.stringify(demo));
    const day = (d: readonly RuEvent[]) => JSON.stringify(withLiveWeek(d, BENCH_NOW.getTime(), 1));
    expect(day(generateDemo(BENCH_NOW, 7))).toBe(day(demo));
    expect(week.slice(0, demo.length)).toEqual(demo);
  });

  it('builds the same view from the same log at the same instant', () => {
    const now = BENCH_NOW.toISOString();
    expect(JSON.stringify(buildUniverseView(demo, { now }))).toBe(JSON.stringify(buildUniverseView(demo, { now })));
  });

  it('keeps the size the workload probes were defined over', () => {
    const bound = PROBES.filter((p) => p.workload);
    expect(bound.length).toBeGreaterThan(0);
    const why = `The benchmark workload changed size, so the numbers of ${bound.map(probeQuery).join(', ')} would mean something else. Bump each version with a \`since\` reason, then update BENCH_SHAPES in apps/server/src/dogfood/efficiency.ts`;
    expect(workloadShape(demo), why).toEqual(BENCH_SHAPES.demo);
    expect(workloadShape(week), why).toEqual(BENCH_SHAPES.week);
  });
});
