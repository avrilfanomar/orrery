// The probe registry (ADR 0003): one method per measured node of the dogfood
// model. A probe's `id@version` is the node's binding query, so changing what a
// probe measures means bumping its version and saying why in `since` — the sync
// then starts a new definition version and old readings keep their yardstick.
// A probe that cannot measure returns `skipped`, never a made-up number: the
// node goes stale and reads unknown. A failed check is a measurement (0).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { buildUniverseView, EventSchema, type RuEvent } from '@ru/core';
import { generateDemo } from '../demo.js';
import { EventStore } from '../store.js';
import {
  isSkip,
  lastLine,
  medianMs,
  runBuild,
  runProgram,
  runTests,
  runTypecheck,
  trackedFiles,
  type BuildRun,
  type Skip,
  type TestRun,
  type TypecheckRun,
} from './collectors.js';
import { EFFICIENCY_PROBES } from './efficiency.js';
import { FLEXIBILITY_PROBES } from './flexibility.js';
import { MAINTAINABILITY_PROBES } from './maintainability.js';
import { OPERABILITY_PROBES } from './operability.js';
import { scrub, smoke, withLiveWeek } from './harness.js';
import type { ProbeSpec } from './sync.js';

export type ProbeOutcome = { value: number; detail?: string } | Skip;

/** The benchmark demo plus a week of live signals, also stored as a JSONL log for the probes that load one. */
export interface BenchWeek {
  events: RuEvent[];
  /** The week's last instant: every view of it is taken here. */
  now: string;
  /** Opened, never appended to: a probe that writes works on its own copy. */
  file: string;
}

export interface ProbeContext {
  root: string;
  tmp: string;
  tests(): Promise<TestRun | Skip>;
  typecheck(): Promise<TypecheckRun | Skip>;
  build(): Promise<BuildRun | Skip>;
  demo(): RuEvent[];
  week(): BenchWeek;
  tracked(): string[];
}

export interface Probe extends ProbeSpec {
  /** Benchmarks (timings, heap) run last, alone, after every external step has finished. */
  timing?: boolean;
  /** The fixed workload the number depends on. If that workload changes size, the version must change (efficiency.test.ts). */
  workload?: 'demo' | 'week';
  /** For a test-suite scenario: the tests it judges, checked against the test files by dogfood.test.ts. */
  selectors?: readonly SuiteSelector[];
  measure(ctx: ProbeContext): Promise<ProbeOutcome> | ProbeOutcome;
}

/** The fixed workload for timings: the demo as seeded at this instant, seed 7 — the same events on every run. */
export const BENCH_NOW = new Date('2026-11-03T12:00:00.000Z');
const V1 = 'First version of this method (ADR 0003)';
const V4 = 'First version of this method (ADR 0004)';
const V5 = 'First version of this method (ADR 0005)';
const V6 = 'First version of this method (ADR 0006)';
const V7 = 'First version of this method (ADR 0007)';
const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;

export function createContext(root: string, tmp: string): ProbeContext {
  const once = <T>(f: () => T) => {
    let cached: { v: T } | null = null;
    return () => (cached ??= { v: f() }).v;
  };
  const demo = once(() => generateDemo(BENCH_NOW, 7));
  return {
    root,
    tmp,
    tests: once(() => runTests(root, tmp)),
    typecheck: once(() => runTypecheck(root)),
    build: once(() => runBuild(root, tmp)),
    demo,
    week: once(() => {
      const events = withLiveWeek(demo(), BENCH_NOW.getTime());
      const file = join(tmp, 'bench-week.jsonl');
      writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
      return { events, file, now: new Date(BENCH_NOW.getTime() + 7 * 24 * 3.6e6).toISOString() };
    }),
    tracked: once(() => trackedFiles(root)),
  };
}

// ---------------------------------------------------------------------------
// Test-suite scenarios
// ---------------------------------------------------------------------------

export interface SuiteSelector {
  file: string;
  /** Outermost `describe` titles to include; all of the file when omitted. */
  describe?: string[];
}

/** 1 when selected tests ran and all passed, 0 when any failed, no reading when nothing matched (a stale selector is unknown, not green). */
export function judgeSuite(run: Pick<TestRun, 'tests' | 'brokenFiles'>, selectors: readonly SuiteSelector[]): ProbeOutcome {
  const broken = selectors.filter((s) => run.brokenFiles.includes(s.file)).map((s) => s.file);
  if (broken.length) return { value: 0, detail: `${broken.join(', ')} failed to load` };
  const matched = run.tests.filter((t) => t.status !== 'skipped' && selectors.some((s) => s.file === t.file && (!s.describe || s.describe.includes(t.ancestors[0] ?? ''))));
  if (matched.length === 0) return { skipped: 'no test matches the selector — update the probe' };
  const failed = matched.filter((t) => t.status === 'failed');
  return failed.length ? { value: 0, detail: `${failed.length}/${matched.length} failing, e.g. “${failed[0]!.title}”` } : { value: 1, detail: `${matched.length} test${matched.length === 1 ? '' : 's'}` };
}

const describeSelectors = (sel: readonly SuiteSelector[]) => sel.map((s) => (s.describe ? `${s.file} › ${s.describe.join(', ')}` : s.file)).join('; ');

function suite(id: string, selectors: SuiteSelector[], since = V1): Probe {
  return {
    id,
    version: 1,
    since,
    method: `vitest run (JSON reporter) in packages/core and apps/server, selecting ${describeSelectors(selectors)}. Pass when at least one selected test ran and all passed; fail when one failed or a selected file failed to load; no reading when nothing matches.`,
    selectors,
    async measure(ctx) {
      const run = await ctx.tests();
      return isSkip(run) ? run : judgeSuite(run, selectors);
    },
  };
}

const CORE = 'packages/core/test';
const SERVER = 'apps/server/test';

// ---------------------------------------------------------------------------
// Static checks
// ---------------------------------------------------------------------------

/** Every place apps/server writes to an event log. Each must hand over events that came out of `decide`. */
export const SANCTIONED_WRITES: Readonly<Record<string, number>> = {
  'apps/server/src/app.ts': 2, // POST /api/commands and POST /api/readings
  'apps/server/src/sources/collector.ts': 1, // pulled readings
  'apps/server/src/server.ts': 1, // seeding an empty log (seeds.ts goes through decide)
  'apps/server/src/reset.ts': 1, // re-seeding while the server is stopped
};

const NODE_BUILTINS = new Set(builtinModules.flatMap((m) => [m, m.split('/')[0]!]));
const IMPORT = /\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
const HOST_GLOBAL = /(?<![.\w$])(?:process|Buffer|window|document|localStorage|sessionStorage|navigator|require|__dirname|__filename|fetch)\b(?=\s*[.([])/g;

const read = (ctx: ProbeContext, f: string) => readFileSync(join(ctx.root, f), 'utf8');

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export const PROBES: readonly Probe[] = [
  {
    id: 'log-load-refuses',
    version: 1,
    since: V1,
    method:
      'Writes three schema-valid logs to a temp dir — one with a sequence gap, one with a repeated sequence number, one with an event recorded before its predecessor — and opens each with EventStore.open. Pass only when all three are refused.',
    measure(ctx) {
      const ev = (seq: number, at: string, id: string) => ({
        seq,
        at,
        actor: 'probe',
        type: 'node.created',
        data: { id, kind: 'goal', title: id, description: '', parentId: null, links: [], priority: 'medium', dimensions: [], owner: null, measure: null, rollup: { strategy: 'worst' }, scenario: null, reason: null },
      });
      const [t0, t1] = ['2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z'];
      const cases: Record<string, object[]> = {
        'a sequence gap': [ev(1, t0, 'a'), ev(3, t1, 'b')],
        'a repeated sequence number': [ev(1, t0, 'a'), ev(1, t1, 'b')],
        'an event recorded before its predecessor': [ev(1, t1, 'a'), ev(2, t0, 'b')],
      };
      // A fixture the schema refuses would be refused for the wrong reason and pass falsely.
      if (!Object.values(cases).flat().every((e) => EventSchema.safeParse(e).success)) return { skipped: 'the probe’s fixture no longer matches the event schema' };
      const accepted: string[] = [];
      Object.entries(cases).forEach(([name, events], i) => {
        const file = join(ctx.tmp, `contract-${i}.jsonl`);
        writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
        try {
          EventStore.open(file);
          accepted.push(name);
        } catch {
          // refused, as it should be
        }
      });
      return accepted.length ? { value: 0, detail: `loaded a log with ${accepted.join(', ')}` } : { value: 1, detail: 'all three refused' };
    },
  },
  suite('suite-log-contract', [{ file: `${CORE}/log.test.ts` }]),
  {
    id: 'log-writes-outside-gate',
    version: 1,
    since: V1,
    method: `Counts \`.append(\` and \`.replaceAll(\` calls (comments ignored) in tracked apps/server/src/**/*.ts other than store.ts, beyond the allowlist ${Object.entries(SANCTIONED_WRITES)
      .map(([f, n]) => `${f.replace('apps/server/src/', '')} ×${n}`)
      .join(', ')}.`,
    measure(ctx) {
      const excess: string[] = [];
      let total = 0;
      for (const f of ctx.tracked().filter((f) => f.startsWith('apps/server/src/') && f.endsWith('.ts') && f !== 'apps/server/src/store.ts')) {
        const n = (scrub(read(ctx, f), true).match(/\.(?:append|replaceAll)\(/g) ?? []).length;
        const over = n - (SANCTIONED_WRITES[f] ?? 0);
        if (over > 0) excess.push(`${f} +${over}`);
        total += Math.max(0, over);
      }
      return { value: total, detail: excess.join(', ') || undefined };
    },
  },
  suite('suite-decide', [{ file: `${CORE}/decide.test.ts`, describe: ['decide'] }]),
  suite('suite-rollup', [{ file: `${CORE}/evaluate.test.ts`, describe: ['measured nodes', 'rollup'] }]),
  suite('suite-in-force', [
    { file: `${CORE}/evaluate.test.ts`, describe: ['evolution'] },
    { file: `${CORE}/decide.test.ts`, describe: ['history'] },
    { file: `${CORE}/sources.test.ts`, describe: ['a new query is a new yardstick'] },
  ]),
  {
    id: 'test-pass-rate',
    version: 1,
    since: V1,
    method: 'vitest run (JSON reporter) in packages/core and apps/server. Passed ÷ (passed + failed) × 100, where a test file that fails to load counts as one failure; skipped and todo tests are left out.',
    async measure(ctx) {
      const run = await ctx.tests();
      if (isSkip(run)) return run;
      const passed = run.tests.filter((t) => t.status === 'passed').length;
      const failed = run.tests.filter((t) => t.status === 'failed').length + run.brokenFiles.length;
      if (passed + failed === 0) return { skipped: 'no tests ran' };
      return { value: round((100 * passed) / (passed + failed), 2), detail: `${passed}/${passed + failed}` };
    },
  },
  {
    id: 'core-impurities',
    version: 1,
    since: V1,
    method:
      'Scans tracked packages/core/src/**/*.ts, comments ignored: imports of `node:*` or Node built-in modules, plus uses of process, Buffer, window, document, localStorage, sessionStorage, navigator, require, __dirname, __filename or fetch outside strings. The value is the number of occurrences.',
    measure(ctx) {
      const hits: string[] = [];
      for (const f of ctx.tracked().filter((f) => f.startsWith('packages/core/src/') && f.endsWith('.ts'))) {
        const src = read(ctx, f);
        for (const [, spec] of scrub(src, false).matchAll(IMPORT)) if (spec!.startsWith('node:') || NODE_BUILTINS.has(spec!.split('/')[0]!)) hits.push(`${f}: import ${spec}`);
        for (const [g] of scrub(src, true).matchAll(HOST_GLOBAL)) hits.push(`${f}: ${g}`);
      }
      return { value: hits.length, detail: hits.slice(0, 3).join('; ') || undefined };
    },
  },
  {
    id: 'type-errors',
    version: 1,
    since: V1,
    method: '`tsc --noEmit -p tsconfig.json` in packages/core, apps/server and apps/web, one after the other; the value is the number of `error TS…` lines.',
    async measure(ctx) {
      const run = await ctx.typecheck();
      if (isSkip(run)) return run;
      const where = Object.entries(run.byPackage).filter(([, n]) => n > 0);
      return { value: run.errors, detail: where.map(([p, n]) => `${p} ${n}`).join(', ') || undefined };
    },
  },
  {
    id: 'largest-module',
    version: 1,
    since: V1,
    method: 'The line count of the longest tracked *.ts or *.tsx file under packages/*/src and apps/*/src (tests, scripts and docs excluded).',
    measure(ctx) {
      let best = { file: '', lines: 0 };
      for (const f of ctx.tracked().filter((f) => /^(?:packages|apps)\/[^/]+\/src\/.+\.tsx?$/.test(f))) {
        const src = read(ctx, f);
        const lines = src.split('\n').length - (src.endsWith('\n') ? 1 : 0);
        if (lines > best.lines) best = { file: f, lines };
      }
      return best.file ? { value: best.lines, detail: best.file } : { skipped: 'no source files found' };
    },
  },
  {
    id: 'verify-seconds',
    version: 1,
    since: V1,
    method:
      'The summed wall time of this run’s three verification steps — the typecheck of all packages, the core and server test runs, and the production UI build — each run sequentially. Machine-bound: compare readings from one RU_PROBE_ENV only.',
    async measure(ctx) {
      const steps = [await ctx.typecheck(), await ctx.tests(), await ctx.build()];
      const skip = steps.find(isSkip);
      if (skip) return skip;
      const ms = steps.reduce((s, r) => s + (r as { ms: number }).ms, 0);
      return { value: round(ms / 1000, 1), detail: steps.map((r) => `${round((r as { ms: number }).ms / 1000, 1)} s`).join(' + ') };
    },
  },
  {
    id: 'view-ms-demo',
    version: 1,
    since: V1,
    timing: true,
    workload: 'demo',
    method: `buildUniverseView over the demo as seeded at ${BENCH_NOW.toISOString()} with seed 7 (~2.9k events): 3 warm-up runs, then the median of 15. Machine-bound: compare readings from one RU_PROBE_ENV only.`,
    measure(ctx) {
      const events = ctx.demo();
      return { value: round(medianMs(() => buildUniverseView(events, { now: BENCH_NOW.toISOString() }), 3, 15), 1), detail: `${events.length} events` };
    },
  },
  {
    id: 'view-ms-week',
    version: 1,
    since: V1,
    timing: true,
    workload: 'week',
    method:
      'buildUniverseView over the benchmark demo plus seven days of the six fast simulator signals at the default 30 s tick, each reading recorded through decide (~124k events): 2 warm-up runs, then the median of 7. Machine-bound: compare readings from one RU_PROBE_ENV only.',
    measure(ctx) {
      const { events, now } = ctx.week();
      return { value: Math.round(medianMs(() => buildUniverseView(events, { now }), 2, 7)), detail: `${events.length} events` };
    },
  },
  suite('suite-log-passes', [{ file: `${CORE}/efficiency.test.ts`, describe: ['log passes per request'] }, { file: `${SERVER}/efficiency.test.ts`, describe: ['log passes per request'] }], V4),
  suite('suite-answer-size', [{ file: `${CORE}/efficiency.test.ts`, describe: ['answer size'] }], V4),
  suite('suite-capacity', [{ file: `${SERVER}/efficiency.test.ts`, describe: ['capacity'] }], V4),
  suite('suite-bench-workload', [{ file: `${SERVER}/efficiency.test.ts`, describe: ['benchmark workload'] }], V4),
  {
    id: 'ui-bundle-gzip',
    version: 1,
    since: V1,
    method: 'A fresh `vite build` of apps/web into a temp dir; the sum of the gzip sizes (zlib default level) of every built .js asset, in kB of 1000 bytes.',
    async measure(ctx) {
      const b = await ctx.build();
      if (isSkip(b)) return b;
      const dir = join(b.outDir, 'assets');
      const js = readdirSync(dir).filter((f) => f.endsWith('.js'));
      const bytes = js.reduce((s, f) => s + gzipSync(readFileSync(join(dir, f))).length, 0);
      return { value: round(bytes / 1000, 1), detail: `${js.length} file${js.length === 1 ? '' : 's'}` };
    },
  },
  ...EFFICIENCY_PROBES,
  suite('suite-frozen-history', [{ file: `${SERVER}/flexibility.test.ts`, describe: ['frozen history'] }], V5),
  suite('suite-time-zones', [{ file: `${SERVER}/flexibility.test.ts`, describe: ['time zones'] }], V5),
  suite('suite-coexistence', [{ file: `${SERVER}/flexibility.test.ts`, describe: ['co-existence'] }], V5),
  suite('suite-api-contract', [{ file: `${SERVER}/flexibility.test.ts`, describe: ['the documented API'] }], V5),
  ...FLEXIBILITY_PROBES,
  suite('suite-explained', [{ file: `${SERVER}/maintainability.test.ts`, describe: ['statuses explain themselves', 'refusals explain themselves'] }], V6),
  suite('suite-no-hidden-inputs', [{ file: `${SERVER}/maintainability.test.ts`, describe: ['no hidden inputs'] }], V6),
  suite('suite-dependencies', [{ file: `${SERVER}/maintainability.test.ts`, describe: ['declared dependencies'] }], V6),
  ...MAINTAINABILITY_PROBES,
  suite('suite-startup-refusals', [{ file: `${SERVER}/operability.test.ts`, describe: ['startup refusals explain themselves'] }], V7),
  suite('suite-visible-failures', [{ file: `${SERVER}/operability.test.ts`, describe: ['failures are visible'] }], V7),
  suite('suite-recovery', [{ file: `${SERVER}/operability.test.ts`, describe: ['recovery'] }], V7),
  suite('suite-on-the-record', [{ file: `${SERVER}/operability.test.ts`, describe: ['on the record'] }], V7),
  suite('suite-documented-operations', [{ file: `${SERVER}/operability.test.ts`, describe: ['documented operations'] }], V7),
  ...OPERABILITY_PROBES,
  suite('suite-sources', [{ file: `${CORE}/sources.test.ts` }, { file: `${SERVER}/sources.test.ts` }]),
  {
    id: 'audit-high',
    version: 1,
    since: V1,
    method: '`pnpm audit --json` over the whole workspace, dev dependencies included; the value is high + critical advisories. No reading when the registry cannot be reached.',
    async measure(ctx) {
      const res = await runProgram(ctx.root, 'pnpm', ['audit', '--json'], { cwd: ctx.root, timeoutMs: 120_000 });
      if (res.spawnError) return { skipped: `pnpm could not start: ${res.spawnError}` };
      let report: { metadata?: { vulnerabilities?: Record<string, number> }; error?: { message?: string } };
      try {
        report = JSON.parse(res.stdout);
      } catch {
        return { skipped: `pnpm audit gave no report: ${lastLine(res.stderr || res.stdout) || `exit ${res.code}`}` };
      }
      const v = report.metadata?.vulnerabilities;
      if (!v) return { skipped: `pnpm audit gave no counts${report.error?.message ? `: ${report.error.message}` : ''}` };
      return { value: (v.high ?? 0) + (v.critical ?? 0), detail: `${v.moderate ?? 0} moderate and ${v.low ?? 0} low not counted` };
    },
  },
  suite('suite-demo-story', [{ file: `${SERVER}/app.test.ts`, describe: ['the demo universe'] }]),
  {
    id: 'ui-smoke',
    version: 1,
    since: V1,
    method:
      'Starts the real server (src/main.ts) on a free port with a throwaway demo log and this run’s fresh UI build, then runs apps/web/e2e/smoke.mjs against it. Pass on exit 0; fail when a step after the browser started fails, or the server does not start; no reading when the browser cannot start (set PW_CHROMIUM).',
    measure: smoke,
  },
  {
    id: 'doc-links',
    version: 1,
    since: V1,
    method: 'Every relative Markdown link `](path)` in tracked *.md files, outside fenced code and ignoring any #anchor, must point at an existing file or directory. The value is the number that do not.',
    measure(ctx) {
      const broken: string[] = [];
      for (const f of ctx.tracked().filter((f) => f.endsWith('.md'))) {
        const text = read(ctx, f).replace(/^```[\s\S]*?^```/gm, '');
        for (const [, target] of text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
          if (/^[a-z][a-z0-9+.-]*:/i.test(target!) || target!.startsWith('#')) continue;
          const path = decodeURIComponent(target!.split('#')[0]!);
          if (path && !existsSync(resolve(ctx.root, dirname(f), path))) broken.push(`${f} → ${target}`);
        }
      }
      return { value: broken.length, detail: broken.slice(0, 3).join('; ') || undefined };
    },
  },
];

export const PROBE_SPECS: ReadonlyMap<string, ProbeSpec> = new Map(PROBES.map((p) => [p.id, p]));
