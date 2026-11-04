// ADR 0003: the repository measured by itself. These pin the contract between
// the model, the probe registry and the log — with stub probes, so no tsc,
// vite or benchmark runs inside `pnpm verify`.
import { describe, expect, it } from 'vitest';
import { buildUniverseView, evaluateUniverse, PASS_FAIL_UNIT, project, type RuEvent } from '@ru/core';
import { buildApp } from '../src/app.js';
import { parseVitestJson, type GitSnapshot } from '../src/dogfood/collectors.js';
import { scrub } from '../src/dogfood/harness.js';
import { DOGFOOD_MODEL, type ModelNode } from '../src/dogfood/model.js';
import { judgeSuite, PROBE_SPECS, PROBES, type Probe, type ProbeContext } from '../src/dogfood/probes.js';
import { injectTransport, runDogfood } from '../src/dogfood/runner.js';
import { currentFromView, planSync, probeQuery, ReasonRequired, resolveReasons, type ProbeSpec } from '../src/dogfood/sync.js';
import { generateDogfood, seedKindFrom } from '../src/seeds.js';
import { EventStore } from '../src/store.js';

const NOW = new Date('2026-11-04T12:00:00.000Z');
const measured = DOGFOOD_MODEL.filter((n) => n.measure);
const stateOf = (events: readonly RuEvent[], now = NOW) => currentFromView(buildUniverseView(events, { now: now.toISOString() }));
const edit = (id: string, patch: Partial<ModelNode>) => DOGFOOD_MODEL.map((n) => (n.id === id ? { ...n, ...patch } : n));
const withVersion = (id: string, version: number, since = 'measured differently now'): Map<string, ProbeSpec> =>
  new Map([...PROBE_SPECS].map(([k, p]) => [k, k === id ? { ...p, version, since } : p]));

describe('the dogfood model and its probes', () => {
  it('pair one probe with every measured node, and each probe with exactly one node', () => {
    expect(measured.filter((n) => !n.probe).map((n) => n.id)).toEqual([]);
    expect(DOGFOOD_MODEL.filter((n) => n.probe && !n.measure).map((n) => n.id)).toEqual([]);
    expect(measured.map((n) => n.probe).sort()).toEqual(PROBES.map((p) => p.id).sort());
    for (const p of PROBES) {
      expect(p.since.trim().length, p.id).toBeGreaterThanOrEqual(3);
      expect(Number.isInteger(p.version) && p.version >= 1, p.id).toBe(true);
    }
    expect(DOGFOOD_MODEL.filter((n) => n.kind === 'scenario' && n.measure?.unit !== PASS_FAIL_UNIT).map((n) => n.id)).toEqual([]);
  });

  it('seeds through decide as its own universe, with each probe as a provenance-only binding', () => {
    const u = project(generateDogfood(NOW));
    expect([...u.nodes.values()].filter((n) => n.parentId === null).map((n) => n.id)).toEqual(['ru']);
    expect(u.nodes.has('larch-store')).toBe(false);
    for (const n of measured) {
      const def = u.nodes.get(n.id)!.definitions.at(-1)!;
      expect(def.binding, n.id).toEqual({ sourceId: null, language: 'probe', query: probeQuery(PROBE_SPECS.get(n.probe!)!) });
      expect(u.nodes.get(n.id)!.description).toContain(`How it is measured (${def.binding!.query})`);
    }
    const ev = evaluateUniverse(u, NOW.toISOString());
    expect(ev.get('r-coverage')!.status).toBe('unknown'); // honest stubs
    expect(ev.get('r-identity')!.status).toBe('unknown');
    expect(ev.get('ru')!.status).toBe('unknown'); // nothing measured yet is never green
  });

  it('chooses the seed explicitly, so the dogfood log never gets the demo', () => {
    expect(seedKindFrom(undefined)).toBe('demo');
    expect(seedKindFrom('dogfood')).toBe('dogfood');
    expect(() => seedKindFrom('larch')).toThrow(/RU_SEED/);
  });
});

describe('planSync', () => {
  const seeded = stateOf(generateDogfood(NOW));

  it('plans nothing once the log matches the model', () => {
    expect(planSync(DOGFOOD_MODEL, seeded, PROBE_SPECS)).toEqual([]);
  });

  it('turns a tightened target into a redefinition that needs the author’s reason', () => {
    const plan = planSync(edit('k-bundle', { measure: { ...measured.find((n) => n.id === 'k-bundle')!.measure!, target: 100 } }), seeded, PROBE_SPECS);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ cmd: { type: 'node.redefine', data: { id: 'k-bundle' } }, needsReason: true, defaultReason: null });
    expect(() => resolveReasons(plan, {})).toThrow(ReasonRequired);
    expect(resolveReasons(plan, { fallback: 'Tighten the bundle budget' })[0]).toMatchObject({ data: { reason: 'Tighten the bundle budget' } });
  });

  it('moves a node onto a new probe version with the probe’s own reason', () => {
    const plan = planSync(DOGFOOD_MODEL, seeded, withVersion('ui-bundle-gzip', 2, 'Brotli now, as the CDN serves it'));
    const redefine = plan.find((p) => p.cmd.type === 'node.redefine')!;
    expect(redefine).toMatchObject({ cmd: { data: { id: 'k-bundle', binding: { query: 'ui-bundle-gzip@2' } } }, defaultReason: 'Brotli now, as the CDN serves it' });
    expect(plan.find((p) => p.cmd.type === 'node.edit')?.cmd.data).toMatchObject({ id: 'k-bundle' }); // the description names the version
  });

  it('creates and edits without a reason, deprecates what left the model, and refuses a new kind', () => {
    const added: ModelNode = { id: 'k-new', kind: 'kpi', parentId: 'r-light', title: 'CSS shipped', measure: { unit: 'kB', direction: 'lower', target: 10, warn: 20, staleAfterHours: 192 }, probe: 'ui-bundle-gzip' };
    const model = [...edit('g-fast', { title: 'Fast' }).filter((n) => n.id !== 'k-links'), added];
    const plan = planSync(model, seeded, PROBE_SPECS);
    const byType = (t: string) => plan.filter((p) => p.cmd.type === t);
    expect(byType('node.create')[0]).toMatchObject({ needsReason: false, cmd: { data: { id: 'k-new' } } });
    expect(byType('node.edit')[0]).toMatchObject({ needsReason: false, cmd: { data: { id: 'g-fast', title: 'Fast' } } });
    expect(byType('node.deprecate')[0]).toMatchObject({ needsReason: true, cmd: { data: { id: 'k-links' } } });
    expect(() => planSync(edit('k-links', { kind: 'scenario' }), seeded, PROBE_SPECS)).toThrow(/kind never changes/);
  });
});

describe('measurement helpers', () => {
  const run = {
    tests: [
      { file: 'a.test.ts', ancestors: ['x'], title: 'one', status: 'passed' as const },
      { file: 'a.test.ts', ancestors: ['y'], title: 'two', status: 'failed' as const },
    ],
    brokenFiles: [] as string[],
  };

  it('judge a suite as pass, fail, or not measured when the selector matches nothing', () => {
    expect(judgeSuite(run, [{ file: 'a.test.ts', describe: ['x'] }])).toMatchObject({ value: 1 });
    expect(judgeSuite(run, [{ file: 'a.test.ts' }])).toMatchObject({ value: 0 });
    expect(judgeSuite(run, [{ file: 'a.test.ts', describe: ['renamed'] }])).toHaveProperty('skipped');
    expect(judgeSuite({ ...run, brokenFiles: ['a.test.ts'] }, [{ file: 'a.test.ts', describe: ['x'] }])).toMatchObject({ value: 0 });
  });

  it('read vitest’s report into repository-relative cases', () => {
    const parsed = parseVitestJson('/r', {
      testResults: [
        { name: '/r/packages/core/test/a.test.ts', status: 'passed', assertionResults: [{ ancestorTitles: ['d'], title: 't', status: 'passed' }] },
        { name: '/r/apps/server/test/b.test.ts', status: 'failed', assertionResults: [] },
      ],
    });
    expect(parsed.tests[0]).toEqual({ file: 'packages/core/test/a.test.ts', ancestors: ['d'], title: 't', status: 'passed' });
    expect(parsed.brokenFiles).toEqual(['apps/server/test/b.test.ts']);
  });

  it('scan code, not comments or strings', () => {
    const src = "// store.append(x)\nconst s = 'fetch(url)'; /* window.x */ fetch(u);";
    expect(scrub(src, true)).not.toMatch(/append|window|'fetch/);
    expect(scrub(src, true)).toContain('fetch(u)');
    expect(scrub(src, false)).toContain("'fetch(url)'");
  });
});

describe('a dogfood run', () => {
  // Stub probes: the registry's identities with canned numbers — on target for every measure.
  const stubs = (overrides: Record<string, Partial<Probe>> = {}): Probe[] =>
    PROBES.map((p) => {
      const node = measured.find((n) => n.probe === p.id)!;
      return { ...p, measure: () => ({ value: node.measure!.target }), ...overrides[p.id] };
    });
  const git = (patch: Partial<GitSnapshot> = {}): GitSnapshot => ({ sha: 'abc1234', dirty: false, userName: 'tester', modelReason: null, modelCommittedAt: null, ...patch });

  async function setup() {
    let t = NOW.getTime();
    const clock = () => new Date(t);
    const store = EventStore.open(null);
    const app = await buildApp({ store, clock });
    const api = injectTransport(app);
    const run = (opts: Parameters<typeof runDogfood>[0] = {}, deps: Partial<Parameters<typeof runDogfood>[1]> = {}) =>
      runDogfood(opts, { transport: api, git: git(), context: {} as ProbeContext, probes: stubs(), env: 'test', clock, ...deps });
    return { store, api, run, clock, advance: (min: number) => (t += min * 60_000) };
  }

  it('syncs the model, then records one coherent snapshot through the webhook', async () => {
    const { store, run, advance } = await setup();
    const first = await run();
    expect(first.applied).toBe(DOGFOOD_MODEL.length);
    expect(first.recorded).toBe(measured.length);
    const readings = store.all().filter((e) => e.type === 'reading.recorded');
    expect(new Set(readings.map((e) => e.data.observedAt)).size).toBe(1);
    expect(new Set(readings.map((e) => e.data.source))).toEqual(new Set(['probe:test@abc1234']));
    expect(first.view.nodes['ru']!.evaluation.status).toBe('unknown'); // the two stubs keep it honest
    expect(first.view.nodes['k-bundle']!.evaluation.status).toBe('ok');

    advance(60);
    const second = await run();
    expect(second.plan).toEqual([]);
    expect(second.applied).toBe(0);
  });

  it('treats a new probe version as a new yardstick: unknown until measured under it', async () => {
    const { run, advance } = await setup();
    await run();
    advance(60);
    const bumped = stubs({ 'ui-bundle-gzip': { version: 2, since: 'Brotli now, as the CDN serves it', measure: () => ({ skipped: 'not yet' }) } });
    const r = await run({}, { probes: bumped });
    expect(r.plan.map((p) => p.cmd.type).sort()).toEqual(['node.edit', 'node.redefine']);
    expect(r.view.nodes['k-bundle']!.evaluation.status).toBe('unknown');
    expect(r.view.nodes['k-bundle']!.definition.reason).toBe('Brotli now, as the CDN serves it');

    advance(60);
    const again = await run({}, { probes: stubs({ 'ui-bundle-gzip': { version: 2, since: 'Brotli now, as the CDN serves it' } }) });
    expect(again.view.nodes['k-bundle']!.evaluation.status).toBe('ok');
  });

  it('writes nothing from a dirty tree, and nothing at all when a change lacks its reason', async () => {
    const { store, run, advance } = await setup();
    await run();
    const before = store.all().length;
    advance(60);
    const dirty = await run({}, { git: git({ dirty: true }) });
    expect(dirty.notWritten).toMatch(/uncommitted/);
    expect(dirty.source).toBe('probe:test@abc1234+dirty');
    expect(store.all().length).toBe(before);

    const tightened = edit('k-bundle', { measure: { ...measured.find((n) => n.id === 'k-bundle')!.measure!, target: 100 } });
    await expect(run({}, { model: tightened })).rejects.toThrow(ReasonRequired);
    expect(store.all().length).toBe(before);

    const ok = await run({ reason: 'Tighten the bundle budget' }, { model: tightened });
    expect(ok.applied).toBe(1);
    expect(ok.view.nodes['k-bundle']!.definition).toMatchObject({ version: 2, reason: 'Tighten the bundle budget' });
  });

  it('never reverts an edit made in the console under an unrelated commit subject', async () => {
    const { api, run, clock, advance } = await setup();
    const committed = (await run()).observedAt;
    advance(60);
    const target = measured.find((n) => n.id === 'k-bundle')!.measure!;
    await api.post('/api/commands', { type: 'node.redefine', data: { id: 'k-bundle', measure: { ...target, target: 100 }, reason: 'tightened by hand' } }, 'someone');
    advance(60);
    // The model's last commit predates the console edit: its subject cannot explain reverting it.
    await expect(run({}, { git: git({ modelReason: 'Add dogfood probes', modelCommittedAt: committed }) })).rejects.toThrow(/changed after the model’s last commit/);
    // A commit made after the edit (one that decided to keep 110 kB) does explain it.
    const later = await run({}, { git: git({ modelReason: 'Keep the 110 kB budget', modelCommittedAt: clock().toISOString() }) });
    expect(later.view.nodes['k-bundle']!.definition).toMatchObject({ version: 3, reason: 'Keep the 110 kB budget' });
    expect(later.view.nodes['k-bundle']!.definition.measure!.target).toBe(110);
  });
});
