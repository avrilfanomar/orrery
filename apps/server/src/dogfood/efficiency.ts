// What the console costs on this machine once a week of live signals has
// piled up (ADR 0004): a write, a restart, the heap, the answer. The suite pins
// how those costs scale (the efficiency tests); these probes measure how big
// they are. They live apart from probes.ts, which imports them, so they may
// import only types from it.
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { gzipSync } from 'node:zlib';
import type { RuEvent } from '@ru/core';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { EventStore } from '../store.js';
import { medianMsAsync } from './collectors.js';
import { FAST_SIGNALS } from './harness.js';
import type { BenchWeek, Probe } from './probes.js';

const V1 = 'First version of this method (ADR 0004)';
const MACHINE = 'Machine-bound: compare readings from one RU_PROBE_ENV only.';
const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;

/** How many events of each type a workload holds, and in all. Wording edits keep it; a new node, signal or cadence changes it. */
export function workloadShape(events: readonly RuEvent[]): Record<string, number> {
  const shape: Record<string, number> = { total: events.length };
  for (const e of events) shape[e.type] = (shape[e.type] ?? 0) + 1;
  return shape;
}

/**
 * The size of the fixed workloads the current versions of the workload probes
 * were defined over. If the demo or the simulator's fast signals change, a
 * timing taken afterwards measures something else: bump the version of every
 * probe that declares a `workload`, say why in `since`, then update this.
 * The benchmark-workload tests hold it to what the generators produce.
 */
export const BENCH_SHAPES: Readonly<Record<'demo' | 'week', Readonly<Record<string, number>>>> = {
  demo: { total: 2857, 'node.created': 41, 'node.redefined': 2, 'node.reprioritized': 1, 'node.moved': 1, 'node.linked': 1, 'node.deprecated': 1, 'reading.recorded': 2810 },
  week: { total: 123817, 'node.created': 41, 'node.redefined': 2, 'node.reprioritized': 1, 'node.moved': 1, 'node.linked': 1, 'node.deprecated': 1, 'reading.recorded': 123770 },
};

/** A full collection on demand. The flag is set at run time, as jest's leak detector does, so `pnpm dogfood` needs no node option. */
function collector(): () => void {
  if (typeof globalThis.gc === 'function') return () => globalThis.gc!();
  setFlagsFromString('--expose_gc');
  return runInNewContext('gc') as () => void;
}

/**
 * The server as it starts on the week's log: the store loaded from the file, the app built around it, the clock at the week's end.
 * The shared week file is opened read-only; a probe that writes passes its own copy. Closing the app releases the log (ADR 0008).
 */
const serve = async (week: BenchWeek, copy?: string): Promise<{ app: FastifyInstance; store: EventStore }> => {
  const store = copy ? EventStore.open(copy) : EventStore.open(week.file, { readOnly: true });
  const app = await buildApp({ store, clock: () => new Date(week.now) });
  app.addHook('onClose', async () => store.close());
  return { store, app };
};

async function universe(app: FastifyInstance): Promise<string> {
  const res = await app.inject('/api/universe');
  // A broken view is not a fast one: throwing makes the runner record nothing.
  if (res.statusCode !== 200) throw new Error(`GET /api/universe answered ${res.statusCode}`);
  return res.body;
}

export const EFFICIENCY_PROBES: readonly Probe[] = [
  {
    id: 'write-ms-week',
    version: 1,
    since: V1,
    timing: true,
    workload: 'week',
    method: `In-process, on a copy of the week workload (~124k events) loaded through EventStore.open: POST /api/readings through inject with one reading of the first fast simulator signal, as the webhook receives it — project, decide, append to the file. 2 warm-up requests, then the median of 9. ${MACHINE}`,
    async measure(ctx) {
      const week = ctx.week();
      const signal = FAST_SIGNALS[0];
      if (!signal) return { skipped: 'the demo has no fast signal to record' };
      const file = join(ctx.tmp, 'write-week.jsonl');
      copyFileSync(week.file, file);
      const { app } = await serve(week, file);
      try {
        const ms = await medianMsAsync(async () => {
          const res = await app.inject({ method: 'POST', url: '/api/readings', payload: { nodeId: signal.id, value: signal.base, source: 'probe' } });
          if (res.statusCode !== 201) throw new Error(`POST /api/readings answered ${res.statusCode}: ${res.body}`);
        }, 2, 9);
        return { value: Math.round(ms), detail: `${week.events.length} events` };
      } finally {
        await app.close();
      }
    },
  },
  {
    id: 'start-s-week',
    version: 1,
    since: V1,
    timing: true,
    workload: 'week',
    method: `In-process, from the week workload stored as a JSONL file (~124k events): EventStore.open, buildApp, then GET /api/universe through inject until it answers 200. 1 warm-up run, then the median of 3, in seconds. Process and module start-up are left out because they do not grow with the log. ${MACHINE}`,
    async measure(ctx) {
      const week = ctx.week();
      const ms = await medianMsAsync(async () => {
        const { app } = await serve(week);
        try {
          await universe(app);
        } finally {
          await app.close();
        }
      }, 1, 3);
      return { value: round(ms / 1000, 2), detail: `${week.events.length} events` };
    },
  },
  {
    id: 'heap-mb-week',
    version: 1,
    since: V1,
    timing: true,
    workload: 'week',
    method:
      'In-process: after a full garbage collection, loads the week workload file (~124k events) through EventStore.open into an app and serves GET /api/universe once, then collects again. The value is the growth of V8’s used heap in MB of 10^6 bytes: what the server keeps between requests, since each projection is freed after its response. Depends on the Node version, not the CPU.',
    async measure(ctx) {
      const week = ctx.week();
      const gc = collector();
      gc();
      gc();
      const before = process.memoryUsage().heapUsed;
      const { app, store } = await serve(week);
      try {
        await universe(app);
        gc();
        gc();
        const after = process.memoryUsage().heapUsed;
        // Touching the store after the reading keeps it reachable until then.
        return { value: round((after - before) / 1e6, 1), detail: `${store.all().length} events held` };
      } finally {
        await app.close();
      }
    },
  },
  {
    id: 'universe-gzip-week',
    version: 1,
    since: V1,
    workload: 'week',
    method: 'GET /api/universe through inject on the week workload (~124k events), at the week’s last instant; the gzip size (zlib default level) of the response body, in kB of 1000 bytes. Not machine-bound.',
    async measure(ctx) {
      const { app } = await serve(ctx.week());
      try {
        const body = await universe(app);
        return { value: round(gzipSync(body).length / 1000, 1), detail: `${round(body.length / 1000, 1)} kB before compression` };
      } finally {
        await app.close();
      }
    },
  },
];
