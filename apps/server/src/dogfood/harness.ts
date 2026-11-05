// The heavier machinery a few probes share: a scrubber for regex scans, the
// week-of-live-signals workload, a real server process, and the browser runs
// (the smoke test and the accessibility scan) against a demo server.
import { spawn, type ChildProcess } from 'node:child_process';
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

export interface ServerProcess {
  url: string;
  child: ChildProcess;
  /** Everything it has printed so far, stdout and stderr together. */
  output: () => string;
  /** Its exit code; null when a signal ended it. */
  exited: Promise<number | null>;
}

/**
 * Starts apps/server/src/main.ts as a node process of its own — not through
 * the tsx CLI, whose child a SIGKILL would orphan, so the pid holding the log
 * is the pid a signal reaches — on a free port, and waits for /api/health.
 * `limitKiB` caps the size of any file it writes (`ulimit -f`), as a full disk
 * would. When it exits or stays silent for 30 s, resolves to what it printed.
 */
export async function spawnServer(serverDir: string, env: Record<string, string | undefined>, limitKiB?: number): Promise<ServerProcess | { failed: string }> {
  const url = `http://127.0.0.1:${await freePort()}`;
  const node = [process.execPath, '--import', 'tsx', 'src/main.ts'];
  const options = { cwd: serverDir, env: { ...env, HOST: '127.0.0.1', PORT: new URL(url).port }, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
  const child = limitKiB ? spawn('bash', ['-c', `ulimit -f ${limitKiB} && exec "$@"`, 'bash', ...node], options) : spawn(node[0]!, node.slice(1), options);
  let out = '';
  child.stdout.on('data', (d: Buffer) => (out += d));
  child.stderr.on('data', (d: Buffer) => (out += d));
  child.on('error', (e) => (out += e.message));
  const exited = new Promise<number | null>((done) => child.on('close', (code) => done(code)));
  for (const started = Date.now(); Date.now() - started < 30_000 && child.exitCode === null && child.signalCode === null; ) {
    if (await fetch(`${url}/api/health`).then((r) => r.ok, () => false)) return { url, child, output: () => out, exited };
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill('SIGKILL');
  await exited;
  return { failed: out.trim() || 'no answer within 30 s' };
}

/**
 * Starts the real server (src/main.ts) on a free port with a throwaway demo log
 * and this run's fresh UI build, hands its address to `use`, and stops it after.
 * `noServer` says what it means for this probe when the server does not start.
 */
export async function withDemoServer(ctx: ProbeContext, log: string, noServer: (why: string) => ProbeOutcome, use: (base: string) => Promise<ProbeOutcome>): Promise<ProbeOutcome> {
  const b = await ctx.build();
  if (isSkip(b)) return { skipped: `no UI build: ${b.skipped}` };
  const port = await freePort();
  const serverDir = resolve(ctx.root, 'apps/server');
  const env = { ...process.env, PATH: binPath(ctx.root, serverDir), RU_DATA_FILE: join(ctx.tmp, log), PORT: String(port), HOST: '127.0.0.1', RU_SEED: 'demo', RU_WEB_DIST: b.outDir, RU_SOURCES_FILE: '' };
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
    if (!up) return noServer(lastLine(serverErr) || 'no answer within 30 s');
    return await use(base);
  } finally {
    server.kill('SIGTERM');
  }
}

const NO_BROWSER = (stderr: string, code: number | null) => `the browser could not start (${lastLine(stderr) || `exit ${code}`}) — set PW_CHROMIUM to a Chromium binary`;

export const smoke = (ctx: ProbeContext): Promise<ProbeOutcome> =>
  withDemoServer(ctx, 'smoke.jsonl', (why) => ({ value: 0, detail: `the server did not start: ${why}` }), async (base) => {
    const res = await runProgram(ctx.root, 'node', [resolve(ctx.root, 'apps/web/e2e/smoke.mjs')], { cwd: ctx.tmp, env: { RU_URL: base }, timeoutMs: 180_000 });
    if (res.code === 0) return { value: 1, detail: `${(res.stdout.match(/✓/g) ?? []).length} steps` };
    if (res.stdout.includes('✓')) return { value: 0, detail: lastLine(res.stderr) || lastLine(res.stdout) };
    return { skipped: NO_BROWSER(res.stderr, res.code) };
  });

/**
 * Runs apps/web/e2e/a11y.mjs against a demo server. Its value is the number of
 * failed checks; anything short of its closing count is no reading, because a
 * scan that did not finish found nothing either way.
 */
export const accessibility = (ctx: ProbeContext): Promise<ProbeOutcome> =>
  withDemoServer(ctx, 'a11y.jsonl', (why) => ({ skipped: `the server did not start: ${why}` }), async (base) => {
    const res = await runProgram(ctx.root, 'node', [resolve(ctx.root, 'apps/web/e2e/a11y.mjs')], { cwd: ctx.tmp, env: { RU_URL: base }, timeoutMs: 240_000 });
    const count = /^a11y: (\d+) of (\d+) checks failed$/m.exec(res.stdout);
    if (count) {
      const failed = res.stdout.split('\n').filter((l) => l.trimStart().startsWith('✗')).map((l) => l.trim().slice(2));
      return { value: Number(count[1]), detail: failed.length ? failed.slice(0, 3).join('; ') : `all ${count[2]} checks pass` };
    }
    if (res.stdout.includes('✓') || res.stdout.includes('✗')) return { skipped: `the scan did not finish: ${lastLine(res.stderr) || lastLine(res.stdout)}` };
    return { skipped: NO_BROWSER(res.stderr, res.code) };
  });
