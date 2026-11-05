// The safety promises of the server, pinned as contracts (ADR 0009): nothing
// it does destroys the record, and made-up readings never pass for real ones.
// The rollup's promises are in packages/core/test/safety.test.ts; the console's
// "not live" warning is in the browser smoke test. Each outermost `describe`
// is one dogfood scenario.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { decide, parseCommand, project, type CommandInput, type OrreryEvent } from '@orrery/core';
import { buildApp } from '../src/app.js';
import { DEMO_PRODUCT, generateDemo, simulatorRefusal } from '../src/demo.js';
import { freePort } from '../src/dogfood/harness.js';
import { repoRoot } from '../src/paths.js';
import { generateDogfood } from '../src/seeds.js';
import { EventStore } from '../src/store.js';

const NOW = new Date('2026-11-03T12:00:00.000Z');
const tmp = mkdtempSync(join(tmpdir(), 'orrery-safety-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const SERVER_DIR = join(repoRoot, 'apps/server');
/** These tests start real processes (reliability.test.ts says why the timeout is explicit). */
const SPAWNS = { timeout: 30_000 };
const text = (events: readonly OrreryEvent[]) => events.map((e) => `${JSON.stringify(e)}\n`).join('');

/** Runs an entry point of apps/server with only the environment given, collecting what it prints. */
function entry(script: string, env: Record<string, string>) {
  const child = spawn(process.execPath, ['--import', 'tsx', script], { cwd: SERVER_DIR, env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d: Buffer) => (output += d));
  child.stderr.on('data', (d: Buffer) => (output += d));
  const exited = new Promise<number | null>((done) => child.on('exit', done));
  return { child, exited, output: () => output };
}

/** A universe in memory, built through `decide` as the API would. */
function universeOf(cmds: CommandInput[]): EventStore {
  const store = EventStore.open(null);
  for (const cmd of cmds) store.append(decide(project(store.all()), parseCommand(cmd), { now: NOW.toISOString(), actor: 'test', sources: new Map() }));
  return store;
}

describe('a reset keeps what it replaced', () => {
  it('keeps the old log beside the new one, byte for byte, and says how to undo', SPAWNS, async () => {
    const file = join(tmp, 'reset.jsonl');
    writeFileSync(file, text(generateDemo(NOW).slice(0, 60)));
    const before = readFileSync(file);
    const run = entry('src/reset.ts', { ORRERY_DATA_FILE: file, PORT: String(await freePort()), HOST: '127.0.0.1' });
    expect(await run.exited, run.output()).toBe(0);
    const kept = readdirSync(tmp).filter((f) => f.startsWith('reset.jsonl.') && f.endsWith('.bak'));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^reset\.jsonl\.\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.bak$/);
    expect(readFileSync(join(tmp, kept[0]!))).toEqual(before);
    expect(run.output()).toContain(`The log it replaced is kept as ${join(tmp, kept[0]!)}. To undo the reset, stop the server and move it back.`);
    expect(EventStore.open(file, { readOnly: true }).all().length).toBeGreaterThan(60);
  });

  it('keeps nothing when there is nothing to keep, and never writes over a kept log', () => {
    const file = join(tmp, 'keep.jsonl');
    const keep = `${file}.kept.bak`;
    const demo = generateDemo(NOW);
    const first = EventStore.open(file, { fresh: true });
    expect(first.replaceAll(demo.slice(0, 3), keep)).toEqual({ kept: null });
    first.close();
    expect(existsSync(keep)).toBe(false);

    writeFileSync(keep, 'an earlier backup\n');
    const before = readFileSync(file);
    const second = EventStore.open(file, { fresh: true });
    expect(() => second.replaceAll(demo.slice(0, 5), keep)).toThrow(/EEXIST/);
    second.close();
    expect(readFileSync(file)).toEqual(before);
    expect(readFileSync(keep, 'utf8')).toBe('an earlier backup\n');
    expect(readdirSync(tmp).filter((f) => f.startsWith(basename(file)) && f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('the simulator feeds only the demo', () => {
  const roots = (events: readonly OrreryEvent[]) => [...project(events).nodes.values()].filter((n) => n.parentId === null).map((n) => n.id);

  it('feeds the demo, and names why it refuses any other universe', () => {
    expect(roots(generateDemo(NOW))).toEqual([DEMO_PRODUCT]);
    expect(simulatorRefusal([DEMO_PRODUCT])).toBeNull();
    expect(simulatorRefusal(roots(generateDogfood(NOW)))).toBe('this universe is not the demo (its top level is orrery, not larch-store), and made-up readings would pass for real ones there');
    expect(simulatorRefusal([])).toMatch(/its top level is empty/);
    expect(simulatorRefusal([DEMO_PRODUCT, 'my-shop'])).toMatch(/its top level is larch-store, my-shop/);
  });

  it('writes nothing into a universe that only shares the demo’s ids', SPAWNS, async () => {
    // k-p95 is the demo's id for the same kind of KPI: without the guard, the simulator would backfill it.
    const store = universeOf([
      { type: 'node.create', data: { id: 'my-shop', kind: 'product', title: 'My shop' } },
      { type: 'node.create', data: { id: 'k-p95', kind: 'kpi', title: 'p95', parentId: 'my-shop', measure: { unit: 'ms', direction: 'lower', target: 800, warn: 1200, staleAfterHours: 3 } } },
    ]);
    const app = await buildApp({ store });
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    const sim = entry('src/simulate.ts', { ORRERY_API: url, ORRERY_SIM_TICK_MS: '1000' });
    try {
      await expect.poll(sim.output, { timeout: 20_000 }).toContain('sim: streaming');
      expect(sim.output()).toContain('sim: feeding nothing — this universe is not the demo (its top level is my-shop, not larch-store)');
      expect(store.all().filter((e) => e.type === 'reading.recorded')).toEqual([]);
    } finally {
      sim.child.kill('SIGTERM');
      await sim.exited;
      await app.close();
    }
  });
});
