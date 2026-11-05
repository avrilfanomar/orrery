// The maintainability promises of the repository, pinned as contracts (ADR 0006).
// Each outermost `describe` is one dogfood scenario.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildUniverseView, signalPath, type RuEvent, type UniverseView } from '@ru/core';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { generateDemo } from '../src/demo.js';
import { scrub } from '../src/dogfood/harness.js';
import { repoRoot } from '../src/paths.js';
import { generateDogfood } from '../src/seeds.js';
import { EventStore } from '../src/store.js';

const NOW = new Date('2026-11-03T12:00:00.000Z');
const DAY = 24 * 3.6e6;
const post = (url: string, payload: object): InjectOptions => ({ method: 'POST', url, payload });
const storeOf = (events: readonly RuEvent[]) => {
  const store = EventStore.open(null);
  store.replaceAll(events);
  return store;
};

/** Every way a view can fail to explain a status, as readable problems; empty when it explains them all. */
function unexplained(view: UniverseView): string[] {
  const evals = new Map(Object.entries(view.nodes).map(([id, n]) => [id, n.evaluation]));
  const problems: string[] = [];
  for (const [id, n] of Object.entries(view.nodes)) {
    const e = n.evaluation;
    const where = `${id} at ${view.asOf}`;
    if (!e.reason.trim()) problems.push(`${where} has no reason`);
    const inputs = new Set([id, ...n.childIds, ...n.linkedFromIds]);
    for (const d of e.drivers) {
      if (!inputs.has(d)) problems.push(`${where} names ${d} as a driver, which is not one of its inputs`);
      else if (d !== id && view.nodes[d]!.evaluation.status === 'ok') problems.push(`${where} names ${d} as a driver, which is on target`);
    }
    if (e.status === 'ok') continue;
    const end = view.nodes[[id, ...signalPath(evals, id)].at(-1)!]!;
    if (end.evaluation.status === 'ok') problems.push(`${where}: its why-path ends at ${end.id}, which is on target`);
    if (!end.evaluation.drivers.includes(end.id) && end.evaluation.inputCount > 0) problems.push(`${where}: its why-path stops at ${end.id}, which is neither measured nor a stub`);
  }
  return problems;
}

describe('statuses explain themselves', () => {
  it('leads every status that is not on target to where it starts, on every day of the demo', () => {
    const events = generateDemo(NOW, 7);
    const live = buildUniverseView(events, { now: NOW.toISOString() });
    const statuses = new Set<string>();
    let checked = 0;
    for (let t = Date.parse(live.range.from) + DAY; t <= NOW.getTime(); t += DAY) {
      const view = buildUniverseView(events, { asOf: new Date(t).toISOString(), now: NOW.toISOString() });
      expect(unexplained(view)).toEqual([]);
      for (const n of Object.values(view.nodes)) statuses.add(n.evaluation.status);
      checked++;
    }
    // The walk only means something if it met every status, on most of the demo's month.
    expect(checked).toBeGreaterThanOrEqual(28);
    expect([...statuses].sort()).toEqual(['breach', 'ok', 'unknown', 'warn']);
  });

  it('explains a model nothing has measured yet: every why-path ends at an unmeasured node or a stub', () => {
    const view = buildUniverseView(generateDogfood(NOW), { now: NOW.toISOString() });
    expect(view.nodes.ru!.evaluation.status).toBe('unknown');
    expect(unexplained(view)).toEqual([]);
  });
});

describe('refusals explain themselves', () => {
  const HTTP: Record<string, number> = { invalid: 400, not_found: 404, conflict: 409 };
  const earlier = new Date(NOW.getTime() - 3.6e6).toISOString();
  const CASES: { what: string; req: InjectOptions | string; code: keyof typeof HTTP; names: RegExp }[] = [
    { what: 'a node that does not exist', req: '/api/nodes/no-such-node', code: 'not_found', names: /no-such-node/ },
    { what: 'an instant without a zone', req: '/api/universe?asOf=2026-10-20T15:00', code: 'invalid', names: /asOf/ },
    { what: 'a command nobody knows', req: post('/api/commands', { type: 'node.explode', data: { id: 'k-p95' } }), code: 'invalid', names: /type/ },
    { what: 'a step that needs a reason', req: post('/api/commands', { type: 'node.reprioritize', data: { id: 'k-p95', priority: 'low' } }), code: 'invalid', names: /reason/ },
    { what: 'an id already taken', req: post('/api/commands', { type: 'node.create', data: { id: 'k-p95', kind: 'kpi', title: 'Again', parentId: 'r-checkout' } }), code: 'conflict', names: /k-p95/ },
    { what: 'a move into its own subtree', req: post('/api/commands', { type: 'node.move', data: { id: 'r-checkout', parentId: 's-guest-checkout', reason: 'Testing the gate' } }), code: 'conflict', names: /contribute to itself/ },
    { what: 'a pass/fail reading that is neither', req: post('/api/readings', { nodeId: 's-guest-checkout', value: 0.5, observedAt: earlier, source: 'e2e' }), code: 'invalid', names: /Guest checkout.*pass\/fail/ },
    { what: 'one bad reading in a batch', req: post('/api/readings', { readings: [{ nodeId: 'k-p95', value: 640, observedAt: earlier, source: 'test' }, { nodeId: 'no-such-node', value: 1, source: 'test' }] }), code: 'not_found', names: /readings\[1\].*no-such-node/ },
    { what: 'a body that is not JSON', req: { method: 'POST', url: '/api/commands', headers: { 'content-type': 'application/json' }, payload: '{"type":' }, code: 'invalid', names: /JSON/ },
  ];

  it('answers each with the matching code and names what is wrong, leaving the log as it was', async () => {
    const store = storeOf(generateDemo(NOW, 7));
    const app = await buildApp({ store, clock: () => NOW });
    const before = store.all().length;
    for (const c of CASES) {
      const res = await app.inject(c.req);
      const body = res.json<{ error: string; code: string }>();
      expect({ what: c.what, status: res.statusCode, code: body.code }).toEqual({ what: c.what, status: HTTP[c.code], code: c.code });
      expect(body.error, c.what).toMatch(c.names);
    }
    expect(store.all()).toHaveLength(before);
  });
});

describe('no hidden inputs', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** The seeds, every read route and a decided command, by name — with the server's clock injected and nothing else. */
  async function answers(): Promise<Record<string, string>> {
    const demo = generateDemo(NOW, 7);
    const app = await buildApp({ store: storeOf(demo), clock: () => NOW });
    const parts: Record<string, string> = { demo: JSON.stringify(demo), dogfood: JSON.stringify(generateDogfood(NOW)) };
    for (const url of ['/api/universe', '/api/universe?asOf=2026-10-20T00:00:00Z', '/api/nodes/k-p95', '/api/changes?limit=500', '/api/sources']) parts[url] = (await app.inject(url)).body;
    parts.command = (await app.inject(post('/api/commands', { type: 'node.reprioritize', data: { id: 'k-p95', priority: 'critical', reason: 'Checking for hidden inputs' } }))).body;
    parts.reading = (await app.inject(post('/api/readings', { nodeId: 'k-p95', value: 640, source: 'test' }))).body;
    parts.after = (await app.inject('/api/universe')).body;
    return parts;
  }
  /** Short digests, so a failure names the answer that moved instead of printing megabytes of JSON. */
  const digests = (parts: Record<string, string>) => Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, createHash('sha256').update(v).digest('hex').slice(0, 16)]));

  it('gives byte-identical answers whatever the system clock and Math.random say', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('1999-01-01T00:00:00.000Z') });
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.01);
    expect(new Date().getUTCFullYear()).toBe(1999); // the fake took
    const first = await answers();
    vi.setSystemTime(new Date('2099-06-30T23:59:59.000Z'));
    random.mockReturnValue(0.99);
    expect(new Date().getUTCFullYear()).toBe(2099);
    expect(digests(await answers())).toEqual(digests(first));
    expect(first.command).toContain(`"at":"${NOW.toISOString()}"`); // the command took the injected time
  });
});

describe('declared dependencies', () => {
  const read = (f: string) => readFileSync(join(repoRoot, f), 'utf8');
  /** The workspace root and every package pnpm-workspace.yaml's `dir/*` globs match. */
  const MEMBERS = [
    '.',
    ...[...read('pnpm-workspace.yaml').matchAll(/^\s*-\s*['"]?([\w.-]+)\/\*['"]?\s*$/gm)].flatMap(([, dir]) =>
      readdirSync(join(repoRoot, dir!))
        .map((m) => `${dir}/${m}`)
        .filter((m) => existsSync(join(repoRoot, m, 'package.json'))),
    ),
  ];
  type Manifest = Partial<Record<'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies', Record<string, string>>>;
  const manifest = (m: string) => JSON.parse(read(join(m, 'package.json'))) as Manifest;
  const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.vite']);
  /** A member's own code; the root's is its top-level files only, since every other directory belongs to a member or holds no code. */
  function codeOf(member: string): string[] {
    const out: string[] = [];
    const walk = (dir: string, deep: boolean) => {
      for (const name of readdirSync(join(repoRoot, dir))) {
        const rel = join(dir, name);
        if (statSync(join(repoRoot, rel)).isDirectory()) {
          if (deep && !SKIP_DIRS.has(name)) walk(rel, true);
        } else if (/\.(?:[cm]?[jt]s|tsx)$/.test(name)) out.push(rel);
      }
    };
    walk(member, member !== '.');
    return out;
  }
  const BUILTIN = new Set(builtinModules);
  /** Import and export-from statements at the start of a statement, and dynamic import() — not a string that happens to end in "from". */
  const IMPORTS = /(?:^|[;\n])\s*(?:import|export)\s+(?:[\w$*{}\s,]+?\s+from\s+)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const packageOf = (spec: string) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!);

  it('finds the members it checks', () => {
    expect(MEMBERS.sort()).toEqual(['.', 'apps/server', 'apps/web', 'packages/core', 'packages/module-kit', 'packages/prometheus']);
  });

  it('declares every package a member imports in that member’s own manifest', () => {
    const undeclared: string[] = [];
    const seen = new Set<string>();
    for (const m of MEMBERS) {
      const own = manifest(m);
      const declared = new Set(Object.keys({ ...own.dependencies, ...own.devDependencies, ...own.optionalDependencies, ...own.peerDependencies }));
      for (const f of codeOf(m)) {
        for (const [, fixed, dynamic] of scrub(read(f), false).matchAll(IMPORTS)) {
          const spec = (fixed ?? dynamic)!;
          if (/^[./]/.test(spec) || spec.startsWith('node:') || BUILTIN.has(spec)) continue;
          seen.add(`${m} ${packageOf(spec)}`);
          if (!declared.has(packageOf(spec))) undeclared.push(`${f} imports ${spec}, which ${m}/package.json does not declare`);
        }
      }
    }
    expect(undeclared).toEqual([]);
    // The scan sees static, type-only, dynamic and .mjs imports alike, or it would pass by seeing nothing.
    for (const used of ['packages/core zod', 'packages/prometheus @ru/module-kit', 'apps/server fastify', 'apps/server typescript', 'apps/web react', 'apps/web playwright-core', 'apps/web vite']) expect(seen).toContain(used);
  });

  it('records in the lockfile exactly the ranges the manifests ask for', () => {
    const unquote = (s: string) => s.replace(/^'(.*)'$|^"(.*)"$/, '$1$2');
    const locked = new Map<string, Record<string, string>>();
    let inImporters = false;
    let importer = '';
    let section = '';
    let name = '';
    for (const line of read('pnpm-lock.yaml').split('\n')) {
      let m: RegExpExecArray | null;
      if (/^\S/.test(line)) inImporters = line.startsWith('importers:');
      else if (!inImporters) continue;
      else if ((m = /^ {2}(\S.*):$/.exec(line))) locked.set((importer = unquote(m[1]!)), {});
      else if ((m = /^ {4}(\w+):$/.exec(line))) section = m[1]!;
      else if ((m = /^ {6}(\S.*):$/.exec(line))) name = unquote(m[1]!);
      else if ((m = /^ {8}specifier: (.+)$/.exec(line))) locked.get(importer)![`${section} ${name}`] = unquote(m[1]!);
    }
    expect([...locked.keys()].sort()).toEqual(MEMBERS.sort());
    for (const m of MEMBERS) {
      const own = manifest(m);
      const asked = Object.fromEntries(
        (['dependencies', 'devDependencies', 'optionalDependencies'] as const).flatMap((s) => Object.entries(own[s] ?? {}).map(([n, range]) => [`${s} ${n}`, range])),
      );
      expect(locked.get(m), `${m}: run pnpm install and commit pnpm-lock.yaml`).toEqual(asked);
    }
  });
});
