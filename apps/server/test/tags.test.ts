// The tag scan (ADR 0014): what a tag is, what it records, and that a scan of
// one repository reconciles only its own harvested references. Tag text is
// built at runtime, so a scan of this repository never harvests this file.
import { describe, expect, it } from 'vitest';
import { buildUniverseView, type OrreryEvent, type Reference } from '@orrery/core';
import { buildApp } from '../src/app.js';
import { injectTransport } from '../src/dogfood/runner.js';
import { EventStore } from '../src/store.js';
import { runTags, TAG_ACTOR, type TagGit } from '../src/tags/runner.js';
import { danglingReferences, globToRegExp, harvestTags, planTags, tagReference, tagsIn, type TaggableNode } from '../src/tags/scan.js';

const T = ['orrery', ':'].join('');
const reasons = { added: 'Tagged at abc1234', removed: 'Tag gone at abc1234' };

describe('the tag grammar', () => {
  it('finds node ids after the token, comma-separated, in any language', () => {
    expect(tagsIn(`// ${T}k-5xx`)).toEqual(['k-5xx']);
    expect(tagsIn(`# ${T}r-checkout,k-5xx\n/* ${T}k-5xx */`)).toEqual(['r-checkout', 'k-5xx']);
    expect(tagsIn(`const s = "${T}g-buy";`)).toEqual(['g-buy']);
  });

  it('ignores the token inside a package name, a URL or a word, and an id that is not one', () => {
    for (const text of [`@${T}core`, `https://x.example/${T}k-1`, `x${T}k-1`, `file.${T}k-1`, `${T}`, `${T} k-1`, `${T}K-1`, `${T}-k`, `${T}${'a'.repeat(65)}`]) expect(tagsIn(text), text).toEqual([]);
  });

  it('matches globs as people write them', () => {
    const matches = (glob: string, path: string) => globToRegExp(glob).test(path);
    expect(matches('**/*.md', 'README.md')).toBe(true);
    expect(matches('**/*.md', 'docs/adr/0014.md')).toBe(true);
    expect(matches('**/fixtures/**', 'apps/server/test/fixtures/events.v3.jsonl')).toBe(true);
    expect(matches('**/*.test.*', 'apps/server/test/tags.test.ts')).toBe(true);
    expect(matches('**/test/**', 'test/a.ts')).toBe(true);
    expect(matches('src/*.ts', 'src/a/b.ts')).toBe(false);
    expect(matches('**/*.md', 'README.mdx')).toBe(false);
  });

  it('harvests every file but prose and frozen logs, one reference per node and file, a test where tests live', () => {
    const tags = harvestTags([
      { path: 'src/pay.ts', text: `// ${T}k-5xx\n// ${T}k-5xx,r-checkout` },
      { path: 'docs/guide.md', text: `Write ${T}k-5xx to tag a file.` },
      { path: 'test/fixtures/log.jsonl', text: `${T}k-5xx` },
      { path: 'src/pay.test.ts', text: `${T}k-5xx` },
    ]);
    expect(tags).toEqual([
      { nodeId: 'k-5xx', path: 'src/pay.ts' },
      { nodeId: 'r-checkout', path: 'src/pay.ts' },
      { nodeId: 'k-5xx', path: 'src/pay.test.ts' },
    ]);
    expect(tagReference('shop', 'src/pay.ts')).toEqual({ kind: 'code', target: { repo: 'shop', path: 'src/pay.ts' }, origin: 'tag' });
    expect(tagReference('shop', 'src/pay.test.ts').kind).toBe('test');
  });
});

describe('a tag plan', () => {
  const tagged = (repo: string, path: string): Reference => ({ kind: 'code', target: { repo, path }, origin: 'tag' });
  const node = (id: string, refs: Reference[] = [], lifecycle: TaggableNode['lifecycle'] = 'active'): TaggableNode => ({ id, title: id, lifecycle, refs });

  it('adds new tags, removes vanished ones, and touches nothing but its own repository’s harvest', () => {
    const hand: Reference = { kind: 'code', target: { repo: 'shop', path: 'src/old.ts' } };
    const nodes = [node('k', [tagged('shop', 'src/kept.ts'), tagged('shop', 'src/gone.ts'), tagged('other', 'src/gone.ts'), hand]), node('r')];
    const plan = planTags(nodes, 'shop', [
      { nodeId: 'k', path: 'src/kept.ts' },
      { nodeId: 'r', path: 'src/new.ts' },
    ], reasons);
    expect(plan.changes.map((c) => [c.cmd.type, c.cmd.data.id, 'path' in c.cmd.data.ref.target ? c.cmd.data.ref.target.path : '', c.cmd.data.reason])).toEqual([
      ['node.unreference', 'k', 'src/gone.ts', reasons.removed],
      ['node.reference', 'r', 'src/new.ts', reasons.added],
    ]);
    expect(plan.changes.find((c) => c.cmd.data.ref === hand)).toBeUndefined();
  });

  it('sets apart a tag naming no node, and reports one naming a deprecated node while harvesting it', () => {
    const plan = planTags([node('old', [], 'deprecated')], 'shop', [
      { nodeId: 'ghost', path: 'src/a.ts' },
      { nodeId: 'old', path: 'src/b.ts' },
    ], reasons);
    expect(plan.dangling).toEqual([{ nodeId: 'ghost', path: 'src/a.ts' }]);
    expect(plan.deprecated).toEqual([{ nodeId: 'old', path: 'src/b.ts' }]);
    expect(plan.changes.map((c) => c.cmd.data.id)).toEqual(['old']);
  });

  it('finds the hand references into the repository that point at nothing', () => {
    const refs: Reference[] = [
      { kind: 'code', target: { repo: 'shop', path: 'src/pay.ts', symbol: 'charge' } },
      { kind: 'code', target: { repo: 'shop', path: 'src/pay.ts', symbol: 'refund' } },
      { kind: 'code', target: { repo: 'shop', path: 'src/gone.ts' } },
      { kind: 'code', target: { repo: 'shop', path: 'src/' } },
      { kind: 'code', target: { repo: 'shop', path: 'lib/' } },
      { kind: 'code', target: { repo: 'other', path: 'src/gone.ts' } },
      tagged('shop', 'src/also-gone.ts'),
    ];
    const found = danglingReferences([node('k', refs)], 'shop', ['src/pay.ts'], (p) => (p === 'src/pay.ts' ? 'export function charge() {}\nconst refunded = 1;' : null));
    expect(found.map((d) => d.problem)).toEqual(['“refund” does not occur in src/pay.ts', 'src/gone.ts is not a tracked file', 'no tracked file under lib/']);
  });
});

describe('a tag scan', () => {
  const REPO = { id: 'shop', label: 'Shop', branch: 'main', browse: 'https://git.example/shop/blob/main/{path}' };
  const NOW = new Date('2026-11-06T09:00:00.000Z');

  async function setup() {
    const store = EventStore.open(null);
    const app = await buildApp({ store, clock: () => NOW, repos: [REPO] });
    const api = injectTransport(app);
    await api.post('/api/commands', { type: 'node.create', data: { id: 'g', kind: 'goal', title: 'Goal' } });
    await api.post('/api/commands', { type: 'node.create', data: { id: 'k', kind: 'kpi', title: 'KPI', parentId: 'g', measure: { unit: '%', direction: 'lower', target: 1, warn: 2, staleAfterHours: 24 } } });
    const files: Record<string, string> = { 'src/pay.ts': `// ${T}k\n`, 'src/pay.test.ts': `// ${T}k,g\n`, 'README.md': `${T}ghost` };
    const git = (over: Partial<TagGit> = {}): TagGit => ({ sha: 'abc1234', dirty: false, onTip: (b) => b === 'main', ...over });
    const scan = (opts: { dryRun?: boolean; strict?: boolean } = {}, g = git()) =>
      runTags({ repo: 'shop', ...opts }, { transport: api, git: g, tracked: Object.keys(files), read: (p) => files[p] ?? null });
    const refsOf = (id: string) => buildUniverseView(store.all(), { now: NOW.toISOString() }).nodes[id]!.refs;
    return { api, store, files, git, scan, refsOf };
  }

  it('writes the harvest from the configured branch’s tip, under its own name, and then has nothing left to do', async () => {
    const { store, scan, refsOf } = await setup();
    const first = await scan();
    expect([first.applied, first.notWritten, first.refused]).toEqual([3, null, null]);
    expect(refsOf('k').map((r) => [r.kind, 'path' in r.target && r.target.path])).toEqual([
      ['code', 'src/pay.ts'],
      ['test', 'src/pay.test.ts'],
    ]);
    expect(store.all().filter((e: OrreryEvent) => e.type === 'node.referenced').every((e) => e.actor === TAG_ACTOR)).toBe(true);
    expect((await scan()).plan.changes).toEqual([]);
  });

  it('writes nothing off the branch, from a dirty tree or on a dry run', async () => {
    const { scan, git, refsOf } = await setup();
    expect((await scan({}, git({ onTip: () => false }))).notWritten).toMatch(/not the tip of main/);
    expect((await scan({}, git({ dirty: true }))).notWritten).toMatch(/uncommitted/);
    const dry = await scan({ dryRun: true });
    expect([dry.notWritten, dry.plan.changes.length]).toEqual(['dry run', 3]);
    expect(refsOf('k')).toEqual([]);
  });

  it('refuses, writing nothing, while a tag names no node, and under --strict while a reference points at nothing', async () => {
    const { api, files, scan, refsOf } = await setup();
    files['src/search.ts'] = `// ${T}ghost`;
    const refused = await scan();
    expect([refused.refused, refused.applied]).toEqual(['1 tag names no node', 0]);
    expect(refsOf('k')).toEqual([]);
    delete files['src/search.ts'];
    expect((await scan()).applied).toBe(3);
    await api.post('/api/commands', { type: 'node.reference', data: { id: 'g', ref: { kind: 'code', target: { repo: 'shop', path: 'src/moved.ts' } } } });
    const lenient = await scan();
    expect([lenient.refused, lenient.danglingRefs.map((d) => d.problem)]).toEqual([null, ['src/moved.ts is not a tracked file']]);
    expect((await scan({ strict: true })).refused).toBe('1 reference points at nothing');
  });

  it('refuses to scan a repository the server has not configured, since it names the branch', async () => {
    const { git } = await setup();
    const app = await buildApp({ store: EventStore.open(null), clock: () => NOW });
    await expect(runTags({ repo: 'shop' }, { transport: injectTransport(app), git: git(), tracked: [], read: () => null })).rejects.toThrow(/no repository “shop” configured/);
  });
});
