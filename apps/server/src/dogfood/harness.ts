// The heavier machinery a few probes share: a scrubber for regex scans, the
// week-of-live-signals workload, and the smoke run against a real server.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { applyEvent, decide, parseCommand, project, type RuEvent } from '@ru/core';
import { PROFILES } from '../demo.js';
import { binPath, isSkip, lastLine, runProgram } from './collectors.js';
import type { ProbeContext, ProbeOutcome } from './probes.js';

/** Blanks out comments, and string contents too when asked, keeping line structure — enough for the regex scans below. */
export function scrub(src: string, strings: boolean): string {
  let out = '';
  for (let i = 0; i < src.length; ) {
    const c = src[i]!;
    const two = src.slice(i, i + 2);
    if (two === '//' || two === '/*') {
      const end = two === '//' ? src.indexOf('\n', i) : src.indexOf('*/', i + 2) + 2;
      const stop = end <= 1 ? src.length : end;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c && !(c !== '`' && src[j] === '\n')) j += src[j] === '\\' ? 2 : 1;
      const lit = src.slice(i, j + 1);
      out += strings ? c + lit.slice(1, -1).replace(/[^\n]/g, ' ') + c : lit;
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The signals the simulator keeps moving at its 30 s tick. */
export const FAST_SIGNALS = PROFILES.filter((p) => p.cadenceHours <= 6 && !p.pass);

/**
 * The demo plus a week of the simulator's fast signals, recorded through `decide` like the real webhook would.
 * Shorter spans exist for the tests; the probes always use the week, which is what their versions were defined over.
 */
export function withLiveWeek(demo: readonly RuEvent[], start: number, days = 7): RuEvent[] {
  const events = [...demo];
  const u = project(events);
  for (let t = start + 30_000; t <= start + days * 24 * 3.6e6; t += 30_000) {
    const at = new Date(t).toISOString();
    for (const p of FAST_SIGNALS) {
      const cmd = parseCommand({ type: 'reading.record', data: { nodeId: p.id, value: p.base, observedAt: at, source: p.source } });
      for (const e of decide(u, cmd, { now: at, actor: 'ingest', sources: new Map() })) {
        const ev = { ...e, seq: events.length + 1 } as RuEvent;
        events.push(ev);
        applyEvent(u, ev);
      }
    }
  }
  return events;
}

export const freePort = () =>
  new Promise<number>((done, fail) => {
    const srv = createServer();
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => done(port));
    });
  });

export async function smoke(ctx: ProbeContext): Promise<ProbeOutcome> {
  const b = await ctx.build();
  if (isSkip(b)) return { skipped: `no UI build: ${b.skipped}` };
  const port = await freePort();
  const serverDir = resolve(ctx.root, 'apps/server');
  const env = { ...process.env, PATH: binPath(ctx.root, serverDir), RU_DATA_FILE: join(ctx.tmp, 'smoke.jsonl'), PORT: String(port), HOST: '127.0.0.1', RU_SEED: 'demo', RU_WEB_DIST: b.outDir, RU_SOURCES_FILE: '' };
  const server = spawn('tsx', ['src/main.ts'], { cwd: serverDir, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let serverErr = '';
  let exited = false;
  server.stderr.on('data', (d: Buffer) => (serverErr += d));
  server.on('exit', () => (exited = true));
  server.on('error', (e) => (serverErr += e.message));
  try {
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30_000;
    let up = false;
    while (!up && !exited && Date.now() < deadline) {
      up = await fetch(`${base}/api/health`).then((r) => r.ok, () => false);
      if (!up) await new Promise((r) => setTimeout(r, 250));
    }
    if (!up) return { value: 0, detail: `the server did not start: ${lastLine(serverErr) || 'no answer within 30 s'}` };
    const res = await runProgram(ctx.root, 'node', [resolve(ctx.root, 'apps/web/e2e/smoke.mjs')], { cwd: ctx.tmp, env: { RU_URL: base }, timeoutMs: 180_000 });
    if (res.code === 0) return { value: 1, detail: `${(res.stdout.match(/✓/g) ?? []).length} steps` };
    if (res.stdout.includes('✓')) return { value: 0, detail: lastLine(res.stderr) || lastLine(res.stdout) };
    return { skipped: `the browser could not start (${lastLine(res.stderr) || `exit ${res.code}`}) — set PW_CHROMIUM to a Chromium binary` };
  } finally {
    server.kill('SIGTERM');
  }
}
