// ADR 0003: the repository measured by itself. These pin the contract between
// the model, the probe registry and the log — with stub probes, so no tsc,
// vite or benchmark runs inside `pnpm verify`.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildUniverseView, evaluateUniverse, PASS_FAIL_UNIT, project, type OrreryEvent } from '@orrery/core';
import { buildApp } from '../src/app.js';
import { parseVitestJson, type GitSnapshot } from '../src/dogfood/collectors.js';
import { crossingsIn } from '../src/dogfood/flexibility.js';
import { scrub } from '../src/dogfood/harness.js';
import { cognitiveComplexity, duplicatedLines, importCycles, majorBehind, parseSource } from '../src/dogfood/maintainability.js';
import { DOGFOOD_MODEL, type ModelNode } from '../src/dogfood/model.js';
import { licenceApproved } from '../src/dogfood/operability.js';
import { judgeSuite, PROBE_SPECS, PROBES, type Probe, type ProbeContext } from '../src/dogfood/probes.js';
import { FALSE_GREEN_MUTANTS } from '../src/dogfood/safety.js';
import { CLAIM_MUTANTS, NEEDS } from '../src/dogfood/suitability.js';
import { findSecrets, SECRET_SHAPES } from '../src/dogfood/security.js';
import { injectTransport, runDogfood } from '../src/dogfood/runner.js';
import { currentFromView, DOGFOOD_REPO, modelReferences, planSync, probeQuery, ReasonRequired, resolveReasons, type ProbeSpec } from '../src/dogfood/sync.js';
import { danglingReferences, harvestTags } from '../src/tags/scan.js';
import { repoRoot } from '../src/paths.js';
import { generateDogfood, seedKindFrom } from '../src/seeds.js';
import { EventStore } from '../src/store.js';

const NOW = new Date('2026-11-04T12:00:00.000Z');
const measured = DOGFOOD_MODEL.filter((n) => n.measure);
const stateOf = (events: readonly OrreryEvent[], now = NOW) => currentFromView(buildUniverseView(events, { now: now.toISOString() }));
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

  it('select only test files and outermost describes that exist, so a rename fails here rather than going unknown', () => {
    const missing: string[] = [];
    for (const p of PROBES) {
      for (const s of p.selectors ?? []) {
        let src: string;
        try {
          src = readFileSync(join(repoRoot, s.file), 'utf8');
        } catch {
          missing.push(`${p.id}: ${s.file}`);
          continue;
        }
        for (const title of s.describe ?? []) if (!src.includes(`\ndescribe('${title}'`)) missing.push(`${p.id}: ${s.file} › ${title}`);
      }
    }
    expect(missing).toEqual([]);
    expect(PROBES.filter((p) => p.selectors).length).toBeGreaterThan(10);
  });

  it('seeds through decide as its own universe, with each probe as a provenance-only binding', () => {
    const u = project(generateDogfood(NOW));
    expect([...u.nodes.values()].filter((n) => n.parentId === null).map((n) => n.id)).toEqual(['orrery']);
    expect(u.nodes.has('larch-store')).toBe(false);
    for (const n of measured) {
      const def = u.nodes.get(n.id)!.definitions.at(-1)!;
      expect(def.binding, n.id).toEqual({ sourceId: null, language: 'probe', query: probeQuery(PROBE_SPECS.get(n.probe!)!) });
      expect(u.nodes.get(n.id)!.description).toContain(`How it is measured (${def.binding!.query})`);
    }
    const ev = evaluateUniverse(u, NOW.toISOString());
    expect(ev.get('r-identity')!.status).toBe('unknown'); // an honest stub
    expect(ev.get('k-core-coverage')!.status).toBe('unknown'); // defined, not yet measured
    expect(ev.get('orrery')!.status).toBe('unknown'); // nothing measured yet is never green
    expect(u.nodes.get('k-start-week')!.links).toEqual(['r-recovers']); // restart time evidences recovery too
  });

  it('keeps every false-green break applicable to the code, so a refactor cannot retire one quietly', () => {
    const gone = FALSE_GREEN_MUTANTS.filter((m) => readFileSync(join(repoRoot, 'packages/core/src', m.file), 'utf8').split(m.find).length !== 2);
    expect(gone.map((m) => `${m.id}: its text no longer occurs exactly once in packages/core/src/${m.file}. Rewrite the break for the new code and bump false-green-mutants`)).toEqual([]);
    expect(new Set(FALSE_GREEN_MUTANTS.map((m) => m.id)).size).toBe(FALSE_GREEN_MUTANTS.length);
  });

  it('keeps every claim break applicable, apart from the false greens, and covers every need the README claims', () => {
    const gone = CLAIM_MUTANTS.filter((m) => readFileSync(join(repoRoot, 'packages/core/src', m.file), 'utf8').split(m.find).length !== 2);
    expect(gone.map((m) => `${m.id}: its text no longer occurs exactly once in packages/core/src/${m.file}. Rewrite the break for the new code and bump claim-mutants`)).toEqual([]);
    const ids = [...FALSE_GREEN_MUTANTS, ...CLAIM_MUTANTS].map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    const both = CLAIM_MUTANTS.filter((c) => FALSE_GREEN_MUTANTS.some((f) => f.file === c.file && f.find === c.find && f.replace === c.replace));
    expect(both.map((m) => m.id)).toEqual([]);
    const idea = readFileSync(join(repoRoot, 'README.md'), 'utf8').split('## The idea')[1]!.split('\n## ')[0]!;
    const rows = [...idea.matchAll(/^\| ([^|]+?) \| /gm)].map((r) => r[1]).filter((r) => r !== 'Need' && !/^-+$/.test(r!));
    expect(rows).toEqual([...NEEDS]);
    expect(NEEDS.filter((n) => !CLAIM_MUTANTS.some((m) => m.need === n))).toEqual([]);
  });

  it('chooses the seed explicitly, so the dogfood log never gets the demo', () => {
    expect(seedKindFrom(undefined)).toBe('demo');
    expect(seedKindFrom('dogfood')).toBe('dogfood');
    expect(() => seedKindFrom('larch')).toThrow(/ORRERY_SEED/);
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

  it('reconciles hand references without a reason, and never touches a harvested one (ADR 0014)', () => {
    const doc = { kind: 'doc', target: { repo: DOGFOOD_REPO, path: 'docs/dogfood.md' } } as const;
    const plan = planSync(edit('c-gate', { refs: [doc] }), seeded, PROBE_SPECS);
    expect(plan.map((p) => [p.cmd.type, p.needsReason])).toEqual([
      ['node.unreference', false],
      ['node.reference', false],
    ]);
    expect(plan[0]!.cmd.data).toMatchObject({ id: 'c-gate', ref: { target: { path: 'packages/core/src/decide.ts' } } });
    const harvested = new Map(seeded);
    const gate = harvested.get('c-gate')!;
    harvested.set('c-gate', { ...gate, refs: [...(gate.refs ?? []), { kind: 'code', target: { repo: DOGFOOD_REPO, path: 'packages/core/src/decide.ts' }, origin: 'tag' }] });
    expect(planSync(DOGFOOD_MODEL, harvested, PROBE_SPECS)).toEqual([]);
  });

  it('gives a suite probe’s node a test reference for each describe title it judges', () => {
    const node = DOGFOOD_MODEL.find((n) => n.probe === 'suite-decide')!;
    expect(modelReferences(node, PROBE_SPECS.get('suite-decide'))).toContainEqual({ kind: 'test', target: { repo: DOGFOOD_REPO, path: 'packages/core/test/decide.test.ts', symbol: 'decide' } });
  });
});

describe('the dogfood’s references', () => {
  // Every file in the working tree git would commit: a new file is referenced before it is committed.
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: repoRoot, encoding: 'utf8' }).split('\n').filter(Boolean);
  const read = (f: string) => {
    try {
      return readFileSync(join(repoRoot, f), 'utf8');
    } catch {
      return null;
    }
  };

  it('all lead somewhere: every path a file, every symbol in it', () => {
    const nodes = DOGFOOD_MODEL.map((n) => ({ id: n.id, title: n.title, lifecycle: 'active' as const, refs: modelReferences(n, n.probe ? PROBE_SPECS.get(n.probe) : undefined) }));
    expect(nodes.reduce((k, n) => k + n.refs.length, 0)).toBeGreaterThan(20);
    expect(danglingReferences(nodes, DOGFOOD_REPO, files, read)).toEqual([]);
  });

  it('are named back by tags in the code, and every tag names a node in the model', () => {
    const tags = harvestTags(files.filter((f) => /\.(?:ts|tsx|mjs)$/.test(f)).map((path) => ({ path, text: read(path) ?? '' })));
    expect(tags.length).toBeGreaterThan(0);
    const ids = new Set(DOGFOOD_MODEL.map((n) => n.id));
    expect(tags.filter((t) => !ids.has(t.nodeId))).toEqual([]);
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

  it('score cognitive complexity by the rules the probe states', async () => {
    const ts = (await import('typescript')).default;
    const src = `
      function sumOfPrimes(max: number) {
        let total = 0;
        OUT: for (let i = 1; i <= max; ++i) {
          for (let j = 2; j < i; ++j) {
            if (i % j === 0) continue OUT;
          }
          total += i;
        }
        return total;
      }
      function getWords(n: number) {
        switch (n) {
          case 1: return 'one';
          case 2: return 'a couple';
          default: return 'lots';
        }
      }
      function branches(a: boolean, b: boolean, c: boolean) {
        if (a && b && c) return 1;
        else if (a || (b && c)) return 2;
        else return a ? 3 : 4;
      }
      const outer = (xs: number[]) => xs.map((x) => (x > 0 ? x : -x));
      class Store { load(v?: string) { try { if (v) return v ?? 'none'; } catch { return null; } return ''; } }`;
    const scores = Object.fromEntries(cognitiveComplexity(ts, parseSource(ts, 'x.ts', src)).map((s) => [`${s.name}@${s.line}`, s.score]));
    expect(scores).toEqual({
      'sumOfPrimes@2': 7, // SonarSource's own example: loop +1, nested loop +2, nested if +3, labelled continue +1
      'getWords@12': 1, // a switch counts once, however many cases
      'branches@19': 8, // if +1 and its && run +1; else if +1, || +1, && +1; else +1, ternary nested once +2
      'outer@24': 0, // a nested function neither adds to its parent…
      '(anonymous)@24': 1, // …nor escapes being scored itself
      'load@25': 3, // if +1 (a try block nests nothing), ?? +1, catch +1
    });
  });

  it('count the imports and calls that cross a seam, and none of the ones the layout allows (ADR 0013)', () => {
    const crossings = (f: string, src: string) => crossingsIn(f, scrub(src, false)).length;
    const imports = (f: string, ...specs: string[]) => crossings(f, specs.map((s) => `import { x } from '${s}';`).join('\n'));
    // What the layout allows.
    expect(imports('apps/server/src/modules.ts', '@orrery/prometheus', '@orrery/module-kit', './dogfood/module.js')).toBe(0);
    expect(imports('packages/prometheus/src/index.ts', '@orrery/module-kit', '@orrery/core', 'zod')).toBe(0);
    expect(imports('apps/web/src/api.ts', '@orrery/core')).toBe(0);
    expect(imports('packages/core/src/decide.ts', './constants.js', 'zod')).toBe(0);
    expect(crossings('apps/server/src/sources/collector.ts', 'await kindOf(src).queryRange(src, q, f);')).toBe(0);
    // Each seam, crossed once.
    expect(imports('apps/server/src/app.ts', '@orrery/core/src/decide.js')).toBe(1); // around a package's entry
    expect(imports('apps/server/src/app.ts', '../../../packages/module-kit/src/index.js')).toBe(1);
    expect(imports('packages/core/src/decide.ts', '@orrery/module-kit')).toBe(1); // core reaching out
    expect(imports('packages/prometheus/src/index.ts', '@orrery/server')).toBe(1); // a module reaching past the kit
    expect(imports('packages/module-kit/src/index.ts', '@orrery/prometheus')).toBe(1);
    expect(imports('apps/web/src/components/Provenance.tsx', '@orrery/prometheus')).toBe(1); // the UI loading a module
    expect(imports('apps/web/src/components/Provenance.tsx', '@orrery/module-kit')).toBe(1);
    expect(imports('apps/server/src/sources/config.ts', '@orrery/prometheus')).toBe(1); // installed past the registry
    expect(crossings('apps/server/src/app.ts', 'const r = await kind.queryRange(src, q, fetch); // not in a comment: .queryRange(')).toBe(1);
  });

  it('find import cycles, copied blocks and majors behind', () => {
    const graph = new Map([['a', ['b']], ['b', ['c']], ['c', ['a']], ['d', ['d']], ['e', ['a']]]);
    expect(importCycles(graph)).toEqual([['a', 'b', 'c'], ['d']]);
    expect(importCycles(new Map([['a', ['b']], ['b', []]]))).toEqual([]);

    const block = ['const a = 1;', 'const b = a + 1;', 'if (b > a) log(b);', 'const c = b * 2;', 'send(c);', 'return c;'].join('\n');
    const files = new Map([['x.ts', `import { y } from './y.js';\n${block}\n}`], ['y.ts', `// copied\n${block}`], ['z.ts', block.split('\n').slice(1).join('\n')]]);
    expect(duplicatedLines(files)).toMatchObject({ duplicated: 12, significant: 17 });
    expect(duplicatedLines(new Map([['x.ts', block], ['y.ts', block.replace('send', 'post')]])).duplicated).toBe(0);

    expect(majorBehind('5.9.3', '7.0.2')).toBe(true);
    expect(majorBehind('1.62.1', '1.64.1')).toBe(false);
    expect(majorBehind('0.3.1', '0.4.0')).toBe(true);
    expect(majorBehind('0.3.1', '0.3.9')).toBe(false);
  });

  it('approve a licence only when an SPDX expression leaves no unapproved choice', () => {
    for (const ok of ['MIT', 'Apache-2.0', '(MIT OR Apache-2.0)', 'MIT OR GPL-3.0', 'BSD-3-Clause AND MIT', 'BlueOak-1.0.0']) expect(licenceApproved(ok), ok).toBe(true);
    for (const no of ['Unknown', 'GPL-3.0', 'MIT AND GPL-3.0', '(MIT OR GPL-3.0) AND Apache-2.0', 'SEE LICENSE IN LICENSE.md', '']) expect(licenceApproved(no), no).toBe(false);
  });

  it('scan code, not comments or strings', () => {
    const src = "// store.append(x)\nconst s = 'fetch(url)'; /* window.x */ fetch(u);";
    expect(scrub(src, true)).not.toMatch(/append|window|'fetch/);
    expect(scrub(src, true)).toContain('fetch(u)');
    expect(scrub(src, false)).toContain("'fetch(url)'");
  });

  it('find added lines shaped like a credential, naming the commit and file but never the value', () => {
    // Built here, so the repository never holds a line its own probe would flag.
    const fakes: Record<string, string> = {
      'private key': `-----BEGIN ${'OPENSSH '}PRIVATE KEY-----`,
      'AWS access key': `AKIA${'Q'.repeat(16)}`,
      'GitHub token': `ghp_${'a1'.repeat(18)}`,
      'Grafana token': `glsa_${'A'.repeat(32)}_${'0f'.repeat(4)}`,
      'Slack token': `xoxb-${'1'.repeat(12)}`,
      'Stripe live key': `sk_live_${'z'.repeat(24)}`,
      'Google API key': `AIza${'x'.repeat(35)}`,
      'npm token': `npm_${'n'.repeat(36)}`,
      'Anthropic or OpenAI key': `sk-ant-${'k'.repeat(24)}`,
      'JSON web token': `eyJ${'h'.repeat(12)}.eyJ${'p'.repeat(12)}.${'s'.repeat(12)}`,
    };
    expect(Object.keys(fakes).sort()).toEqual(SECRET_SHAPES.map((s) => s.id).sort());
    const patch = (line: string, sign = '+') => `\0abc1234\ndiff --git a/x b/x\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n${sign}const token = '${line}';\n`;
    for (const [shape, value] of Object.entries(fakes)) {
      const found = findSecrets(patch(value));
      expect(found, shape).toEqual([{ shape, commit: 'abc1234', file: 'src/x.ts' }]);
      expect(JSON.stringify(found)).not.toContain(value);
      expect(findSecrets(patch(value, '-')), `${shape} removed`).toEqual([]); // the line that added it is what counts
    }
    for (const madeUp of ['glsa_secret_token_value', 'glsa_canary_9f8e7d6c5b4a', 's3cret-ingest-token', 'Bearer s3cret', 'sk_test_123']) expect(findSecrets(patch(madeUp)), madeUp).toEqual([]);
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
    expect(first.view.nodes['orrery']!.evaluation.status).toBe('unknown'); // the two stubs keep it honest
    expect(first.view.nodes['k-bundle']!.evaluation.status).toBe('ok');

    advance(60);
    const second = await run();
    expect(second.plan).toEqual([]);
    expect(second.applied).toBe(0);
  });

  it('harvests the repository’s tags after the sync, sets aside one naming no node, and still records', async () => {
    const { store, run, advance } = await setup();
    const T = ['orrery', ':'].join('');
    const files: Record<string, string> = { 'packages/core/src/decide.ts': `// ${T}c-gate`, 'src/stray.ts': `// ${T}no-such-node` };
    const tags = { tracked: Object.keys(files), read: (p: string) => files[p] ?? null };
    const first = await run({}, { tags });
    expect([first.harvested, first.tagPlan!.dangling.length, first.recorded]).toEqual([1, 1, measured.length]);
    expect(store.all().find((e) => e.type === 'node.referenced')).toMatchObject({ actor: 'tags', data: { id: 'c-gate', ref: { origin: 'tag' } } });
    advance(60);
    const second = await run({}, { tags });
    expect([second.plan, second.tagPlan!.changes]).toEqual([[], []]);
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
