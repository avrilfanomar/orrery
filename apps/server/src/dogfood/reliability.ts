// What it keeps when things go wrong (ADR 0008), measured from outside the
// suite: a real server killed in the middle of writes, and the suite run in an
// order nobody chose. The suite pins the rest as contracts
// (reliability.test.ts). These live apart from probes.ts, which imports them,
// so they may import only types from it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventStore } from '../store.js';
import { isSkip, lastLine, runProgram, runTests, type TestCase } from './collectors.js';
import { spawnServer, type ServerProcess } from './harness.js';
import type { Probe, ProbeContext, ProbeOutcome } from './probes.js';

const V1 = 'First version of this method (ADR 0008)';
const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`;

// ---------------------------------------------------------------------------
// A kill in the middle of writes
// ---------------------------------------------------------------------------

const WRITERS = 4;
const BATCH = 50;
const KILL_AFTER_MS = 1500;

/** Writers that keep posting batches of readings, each at an instant of its own, and note which batches were acknowledged. */
function writeLoad(url: string): { acked: string[]; stop: () => Promise<void> } {
  const base = Date.now() - 86_400_000;
  const acked: string[] = [];
  let next = 0;
  let stopped = false;
  const writer = async () => {
    while (!stopped) {
      const readings = Array.from({ length: BATCH }, () => ({ nodeId: 'k-p95', value: 500, observedAt: new Date(base + next++).toISOString() }));
      const body = JSON.stringify({ readings });
      const ok = await fetch(`${url}/api/readings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).then((r) => r.status === 201, () => false);
      if (ok) acked.push(...readings.map((r) => r.observedAt));
    }
  };
  const running = Promise.all(Array.from({ length: WRITERS }, writer));
  return {
    acked,
    stop: async () => {
      stopped = true;
      await running;
    },
  };
}

/** Starts the server again on the log; if it names a cut last line, does what the message says once, as an operator would. */
async function restart(dir: string, env: Record<string, string | undefined>, file: string): Promise<{ server: ServerProcess; cut: boolean } | { failed: string }> {
  const first = await spawnServer(dir, env);
  if (!('failed' in first)) return { server: first, cut: false };
  if (!/delete that line/.test(first.failed)) return first;
  const text = readFileSync(file, 'utf8');
  writeFileSync(file, text.slice(0, text.lastIndexOf('\n') + 1));
  const second = await spawnServer(dir, env);
  return 'failed' in second ? second : { server: second, cut: true };
}

async function killRecovery(ctx: ProbeContext): Promise<ProbeOutcome> {
  const dir = join(ctx.root, 'apps/server');
  const file = join(ctx.tmp, 'kill-recovery.jsonl');
  writeFileSync(file, ctx.demo().map((e) => `${JSON.stringify(e)}\n`).join(''));
  const env = { PATH: process.env.PATH, RU_DATA_FILE: file, RU_WEB_DIST: join(ctx.tmp, 'no-ui') };
  const first = await spawnServer(dir, env);
  if ('failed' in first) return { skipped: `the server did not start: ${lastLine(first.failed)}` };
  const load = writeLoad(first.url);
  await new Promise((r) => setTimeout(r, KILL_AFTER_MS));
  first.child.kill('SIGKILL');
  await first.exited;
  await load.stop();
  if (load.acked.length === 0) return { skipped: 'no write was acknowledged before the kill' };
  const started = performance.now();
  const back = await restart(dir, env, file);
  if ('failed' in back) return { value: load.acked.length, detail: `it did not start again: ${lastLine(back.failed)}` };
  const ms = performance.now() - started;
  back.server.child.kill('SIGTERM');
  const code = await back.server.exited;
  const kept = new Set(EventStore.open(file, { readOnly: true }).all().flatMap((e) => (e.type === 'reading.recorded' ? [e.data.observedAt] : [])));
  const lost = load.acked.filter((t) => !kept.has(t)).length;
  const how = back.cut ? 'once the cut last line was deleted, as the store asked' : 'by itself';
  return { value: lost, detail: `killed mid-write after ${load.acked.length} acknowledged readings; back in ${seconds(ms)} ${how}${code === 0 ? '' : `; its stop exited ${code}`}` };
}

// ---------------------------------------------------------------------------
// The suite in another order
// ---------------------------------------------------------------------------

const name = (t: TestCase) => `${t.file}: ${[...t.ancestors, t.title].join(' > ')}`;

async function orderDependent(ctx: ProbeContext): Promise<ProbeOutcome> {
  const normal = await ctx.tests();
  if (isSkip(normal)) return normal;
  const sha = await runProgram(ctx.root, 'git', ['rev-parse', 'HEAD'], { cwd: ctx.root });
  // Each commit tries another order, and the detail names the seed that replays it.
  const seed = (Number.parseInt(sha.stdout.trim().slice(0, 8), 16) % 999_983) + 1 || 1;
  const out = join(ctx.tmp, 'shuffled');
  mkdirSync(out, { recursive: true });
  const run = await runTests(ctx.root, out, ['--sequence.shuffle', `--sequence.seed=${seed}`]);
  if (isSkip(run)) return run;
  const failing = (r: typeof run) => [...r.brokenFiles, ...r.tests.filter((t) => t.status === 'failed').map(name)];
  const anyway = new Set(failing(normal));
  const onlyShuffled = failing(run).filter((t) => !anyway.has(t));
  return { value: onlyShuffled.length, detail: `seed ${seed}: ${onlyShuffled.length ? onlyShuffled.slice(0, 3).join('; ') : `${run.tests.length} tests, none failed only out of order`}` };
}

// ---------------------------------------------------------------------------

export const RELIABILITY_PROBES: readonly Probe[] = [
  {
    id: 'kill-recovery',
    version: 1,
    since: V1,
    method: `Writes the benchmark demo to a temp log and starts the server on it (src/main.ts, its own node process, every other setting cleared). ${WRITERS} writers post batches of ${BATCH} readings to /api/readings, each at an instant of its own, for ${KILL_AFTER_MS / 1000} s; then the server is killed with SIGKILL. It is started again on the same log; when it names a cut last line, the probe deletes that line once, as the message asks. The value is the number of acknowledged (201) readings missing from the log afterwards; every one counts when it does not start again. No reading when it does not start at all, or acknowledges nothing.`,
    measure: killRecovery,
  },
  {
    id: 'tests-order-dependent',
    version: 1,
    since: V1,
    method:
      'vitest run (JSON reporter) in packages/core and apps/server with `--sequence.shuffle` and a seed taken from the commit (the first 8 hex digits of its sha, mod 999983, plus 1). The value is the number of tests, and test files that fail to load, that fail in that order but pass in the ordinary run: each depends on what ran before it or on how busy the machine is.',
    measure: orderDependent,
  },
];
