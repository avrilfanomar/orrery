// What whoever runs it can rely on (ADR 0007), measured from outside the suite:
// a fresh clone that installs, builds and serves; settings read only through
// the module that checks them; and dependency licences it may ship under.
// The suite pins the rest as contracts (operability.test.ts). These live apart
// from probes.ts, which imports them, so they may import only types from it.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSkip, lastLine, runProgram, type RunOutput, type Skip } from './collectors.js';
import { ENV_READ, PLATFORM_ENV } from './flexibility.js';
import { freePort, scrub } from './harness.js';
import type { Probe, ProbeContext, ProbeOutcome } from './probes.js';

const V1 = 'First version of this method (ADR 0007)';
const read = (ctx: ProbeContext, f: string) => readFileSync(join(ctx.root, f), 'utf8');
const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`;

// ---------------------------------------------------------------------------
// A fresh clone
// ---------------------------------------------------------------------------

type Step = { ms: number } | Skip | { value: 0; detail: string };
const failed = (step: Step): step is { value: 0; detail: string } => 'value' in step;

/** The first line pnpm marks as an error, else its last line. */
const pnpmError = (r: RunOutput) => (r.stdout + r.stderr).match(/ERR_PNPM_\w+[^\n]*/)?.[0] ?? lastLine(r.stderr || r.stdout);

/** Clones HEAD and installs exactly the lockfile from the repository's own package store, offline. */
async function cloneAndInstall(ctx: ProbeContext, dir: string): Promise<Step> {
  const clone = await runProgram(ctx.root, 'git', ['clone', '--quiet', '--local', '--shared', ctx.root, dir], { cwd: ctx.tmp, timeoutMs: 60_000 });
  if (clone.code !== 0) return { skipped: `git clone failed: ${lastLine(clone.stderr) || clone.spawnError}` };
  // pnpm keeps one store per filesystem; a clone in the temp dir would otherwise look for an empty one.
  const store = await runProgram(ctx.root, 'pnpm', ['store', 'path'], { cwd: ctx.root, timeoutMs: 30_000 });
  if (store.code !== 0) return { skipped: `pnpm store path failed: ${lastLine(store.stderr) || store.spawnError}` };
  const install = await runProgram(dir, 'pnpm', ['install', '--frozen-lockfile', '--offline', '--store-dir', store.stdout.trim(), '--reporter=append-only'], { cwd: dir, timeoutMs: 180_000 });
  if (install.code === 0) return { ms: install.ms };
  const why = pnpmError(install);
  if (/ERR_PNPM_NO_OFFLINE/.test(why)) return { skipped: `the package store lacks a locked package; run pnpm install online once (${why})` };
  return { value: 0, detail: `pnpm install --frozen-lockfile failed: ${why}` };
}

/** What `pnpm start` builds, with the clone's own vite, so nothing resolves from the original checkout. */
async function build(dir: string): Promise<Step> {
  const web = join(dir, 'apps/web');
  const res = await runProgram(dir, join(web, 'node_modules/.bin/vite'), ['build', '--logLevel', 'error'], { cwd: web, timeoutMs: 180_000 });
  if (res.spawnError) return { value: 0, detail: `vite did not start: ${res.spawnError}` };
  return res.code === 0 ? { ms: res.ms } : { value: 0, detail: `the UI build failed: ${lastLine(res.stderr || res.stdout)}` };
}

/** Starts the clone's server with every setting cleared but its log and port, and waits for the UI, the API and the seeded demo. */
async function serve(ctx: ProbeContext, dir: string): Promise<Step> {
  const port = await freePort();
  const cleared = { ORRERY_WEB_DIST: '', ORRERY_SOURCES_FILE: '', ORRERY_INGEST_TOKEN: '', ORRERY_ALLOW_REMOTE: '', INIT_CWD: '' };
  const env = { ...process.env, ...cleared, ORRERY_DATA_FILE: join(ctx.tmp, 'fresh-clone.jsonl'), PORT: String(port), HOST: '127.0.0.1', ORRERY_SEED: 'demo' };
  const server = join(dir, 'apps/server');
  const started = performance.now();
  const child = spawn(join(server, 'node_modules/.bin/tsx'), ['src/main.ts'], { cwd: server, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  let exited = false;
  child.stderr.on('data', (d: Buffer) => (err += d));
  child.on('exit', () => (exited = true));
  child.on('error', (e) => (err += e.message));
  try {
    const base = `http://127.0.0.1:${port}`;
    const get = (path: string) => fetch(`${base}${path}`).then(async (r) => (r.ok ? r.text() : null), () => null);
    let health: string | null = null;
    while (!health && !exited && performance.now() - started < 30_000) {
      health = await get('/api/health');
      if (!health) await new Promise((r) => setTimeout(r, 250));
    }
    if (!health) return { value: 0, detail: `the server did not start: ${lastLine(err) || 'no answer within 30 s'}` };
    const ms = performance.now() - started;
    const [page, universe] = await Promise.all([get('/'), get('/api/universe')]);
    if (!page?.includes('<script type="module"')) return { value: 0, detail: 'the server answers, but does not serve the built UI' };
    if (!universe || Object.keys((JSON.parse(universe) as { nodes: object }).nodes).length === 0) return { value: 0, detail: 'the server answers, but the demo was not seeded' };
    return { ms };
  } finally {
    child.kill('SIGTERM');
  }
}

async function freshClone(ctx: ProbeContext): Promise<ProbeOutcome> {
  const dir = join(ctx.tmp, 'fresh-clone');
  const steps: { name: string; run: () => Promise<Step> }[] = [
    { name: 'install', run: () => cloneAndInstall(ctx, dir) },
    { name: 'build', run: () => build(dir) },
    { name: 'first answer', run: () => serve(ctx, dir) },
  ];
  const took: string[] = [];
  for (const s of steps) {
    const r = await s.run();
    if (isSkip(r) || failed(r)) return r;
    took.push(`${s.name} ${seconds(r.ms)}`);
  }
  const sha = await runProgram(dir, 'git', ['rev-parse', '--short', 'HEAD'], { cwd: dir });
  return { value: 1, detail: `${sha.stdout.trim()}: ${took.join(', ')}` };
}

// ---------------------------------------------------------------------------
// Licences
// ---------------------------------------------------------------------------

/** Licences that let a dependency ship inside an Apache-2.0 project without further conditions beyond notice. */
export const APPROVED_LICENCES: ReadonlySet<string> = new Set(['MIT', 'MIT-0', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'BlueOak-1.0.0', 'CC0-1.0', 'Unlicense', 'CC-BY-4.0']);

/**
 * Whether an SPDX expression is approved. OR offers a choice and AND needs both; with parentheses,
 * every licence named must be approved, which is never more permissive than the expression.
 */
export function licenceApproved(expression: string): boolean {
  const ids = (expression.match(/[A-Za-z0-9.+-]+/g) ?? []).filter((t) => !['OR', 'AND', 'WITH'].includes(t));
  if (ids.length === 0) return false;
  const ok = (id: string) => APPROVED_LICENCES.has(id.replace(/\+$/, ''));
  if (expression.includes('(')) return ids.every(ok);
  return expression.split(/\s+OR\s+/).some((alt) => alt.split(/\s+AND\s+/).every((id) => ok(id.trim())));
}

async function unapprovedLicences(ctx: ProbeContext): Promise<ProbeOutcome> {
  const res = await runProgram(ctx.root, 'pnpm', ['licenses', 'list', '--json', '--prod'], { cwd: ctx.root, timeoutMs: 60_000 });
  let report: Record<string, { name: string; versions: string[] }[]>;
  try {
    report = JSON.parse(res.stdout) as typeof report;
  } catch {
    return { skipped: `pnpm licenses gave no report: ${lastLine(res.stderr || res.stdout) || res.spawnError || `exit ${res.code}`}` };
  }
  const all = Object.values(report).flat();
  if (all.length === 0) return { skipped: 'pnpm licenses listed no packages' };
  const bad = Object.entries(report)
    .filter(([licence]) => !licenceApproved(licence))
    .flatMap(([licence, pkgs]) => pkgs.flatMap((p) => p.versions.map((v) => `${p.name}@${v} (${licence})`)))
    .sort();
  return { value: bad.length, detail: bad.length ? bad.slice(0, 4).join(', ') : `${all.length} packages, all approved` };
}

// ---------------------------------------------------------------------------

export const OPERABILITY_PROBES: readonly Probe[] = [
  {
    id: 'fresh-clone',
    version: 1,
    since: V1,
    method:
      'Clones HEAD (committed code only) into a temp dir, runs `pnpm install --frozen-lockfile --offline` against the repository’s own package store, builds the UI with the clone’s vite, and starts the clone’s server (src/main.ts) with a throwaway demo log and every other setting cleared. Pass when the server answers /api/health within 30 s, serves the built UI at /, and has seeded the demo; fail when a step fails; no reading when the store lacks a locked package or git cannot clone.',
    measure: freshClone,
  },
  {
    id: 'settings-unchecked',
    version: 1,
    since: V1,
    method:
      'Counts the environment variables read by name (`process.env.<NAME>`, `env.<NAME>`, `env["<NAME>"]`; comments ignored) in tracked apps/server/src/**/*.ts outside settings.ts, PATH excepted. Each is a setting read without the rule settings.ts applies: empty means unset, and anything else must parse or the process stops before it serves, naming the variable.',
    measure(ctx) {
      const hits: string[] = [];
      for (const f of ctx.tracked().filter((f) => f.startsWith('apps/server/src/') && f.endsWith('.ts') && f !== 'apps/server/src/settings.ts')) {
        for (const [, a, b] of scrub(read(ctx, f), false).matchAll(ENV_READ)) if (!PLATFORM_ENV.has((a ?? b)!)) hits.push(`${f.replace('apps/server/src/', '')}: ${a ?? b}`);
      }
      return { value: hits.length, detail: hits.slice(0, 3).join('; ') || undefined };
    },
  },
  {
    id: 'licences-unapproved',
    version: 1,
    since: V1,
    method: `\`pnpm licenses list --json --prod\`: every package a workspace package depends on at run time, transitively — the server's runtime and what the UI bundle ships; build and test tools are left out. The value is the number of package versions whose licence is not ${[...APPROVED_LICENCES].join(', ')} (or an SPDX expression of them); Unknown counts. No reading when pnpm gives no report.`,
    measure: unapprovedLicences,
  },
];
