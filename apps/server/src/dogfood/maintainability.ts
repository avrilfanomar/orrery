// What keeps the code cheap to read, test and update (ADR 0006), counted on
// the code itself: functions too tangled to follow in one reading, import
// cycles, copied blocks and hidden clocks. Also how much of the domain core its
// own tests run, and how far the dependencies trail their latest majors. The
// suite pins the rest as contracts (maintainability.test.ts). These live apart
// from probes.ts, which imports them, so they may import only types from it.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type TS from 'typescript';
import { isSkip, lastLine, runProgram, type RunOutput, type Skip } from './collectors.js';
import { resolveImport } from './flexibility.js';
import { scrub } from './harness.js';
import type { Probe, ProbeContext } from './probes.js';

type Ts = typeof TS;
const V1 = 'First version of this method (ADR 0006)';
const read = (ctx: ProbeContext, f: string) => readFileSync(join(ctx.root, f), 'utf8');
const SOURCE = /^(?:packages|apps)\/[^/]+\/src\/.+\.tsx?$/;
const sources = (ctx: ProbeContext) => ctx.tracked().filter((f) => SOURCE.test(f));

/** The compiler's own parser, loaded only when a probe needs it: the server's tests import this module and should not pay for it. */
async function loadTypescript(): Promise<Ts | Skip> {
  try {
    const mod = (await import('typescript')) as Ts & { default?: Ts };
    const ts = mod.default ?? mod;
    // A later major may load and still lack the API these probes walk; that is no reading, not a crash.
    if (typeof ts.createSourceFile !== 'function' || typeof ts.forEachChild !== 'function') return { skipped: `typescript ${ts.version ?? '?'} has no compiler API these probes understand` };
    return ts;
  } catch (err) {
    return { skipped: `the TypeScript compiler API could not be loaded: ${(err as Error).message}` };
  }
}

export const parseSource = (ts: Ts, file: string, text: string) =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

// ---------------------------------------------------------------------------
// Cognitive complexity
// ---------------------------------------------------------------------------

export const COMPLEXITY_LIMIT = 15;
export interface FunctionScore {
  name: string;
  line: number;
  score: number;
}

/**
 * Cognitive complexity (after SonarSource's definition) of every function in a
 * file, each scored on its own. The rules are spelled out in the probe's method,
 * and any change to them is a new probe version.
 */
export function cognitiveComplexity(ts: Ts, sf: TS.SourceFile): FunctionScore[] {
  const LOGICAL = new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]);
  const logicalOp = (n: TS.Node) => (ts.isBinaryExpression(n) && LOGICAL.has(n.operatorToken.kind) ? n.operatorToken.kind : null);
  const nameOf = (fn: TS.Node) => {
    const own = (fn as { name?: TS.Node }).name;
    if (own) return own.getText(sf);
    const p = fn.parent;
    if ((ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) && ts.isIdentifier(p.name)) return p.name.text;
    return ts.isConstructorDeclaration(fn) ? 'constructor' : '(anonymous)';
  };
  const scores: FunctionScore[] = [];

  /** Increments that ignore nesting: a labelled jump, and the first operator of a run of like logical operators. */
  const flat = (n: TS.Node) => {
    if ((ts.isBreakStatement(n) || ts.isContinueStatement(n)) && n.label) return 1;
    const op = logicalOp(n);
    return op !== null && logicalOp(n.parent) !== op ? 1 : 0;
  };
  const nests = (n: TS.Node) => ts.isSwitchStatement(n) || ts.isIterationStatement(n, false) || ts.isCatchClause(n);

  const score = (fn: TS.Node) => {
    let total = 0;
    const walkIf = (n: TS.IfStatement, nesting: number) => {
      const elseIf = ts.isIfStatement(n.parent) && n.parent.elseStatement === n;
      total += elseIf ? 1 : 1 + nesting;
      walk(n.expression, nesting);
      walk(n.thenStatement, nesting + 1);
      const alt = n.elseStatement;
      if (!alt) return;
      if (ts.isIfStatement(alt)) return walk(alt, nesting);
      total += 1;
      walk(alt, nesting + 1);
    };
    const walk = (n: TS.Node, nesting: number): void => {
      if (ts.isFunctionLike(n)) return; // scored on its own
      if (ts.isIfStatement(n)) return walkIf(n, nesting);
      if (ts.isConditionalExpression(n)) {
        total += 1 + nesting;
        walk(n.condition, nesting);
        walk(n.whenTrue, nesting + 1);
        walk(n.whenFalse, nesting + 1);
        return;
      }
      const inner = nests(n) ? nesting + 1 : nesting;
      total += nests(n) ? 1 + nesting : flat(n);
      ts.forEachChild(n, (c) => walk(c, inner));
    };
    ts.forEachChild(fn, (c) => walk(c, 0));
    return total;
  };

  const visit = (n: TS.Node): void => {
    if (ts.isFunctionLike(n) && (n as TS.FunctionLikeDeclaration).body) {
      scores.push({ name: nameOf(n), line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, score: score(n) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return scores;
}

// ---------------------------------------------------------------------------
// Import cycles
// ---------------------------------------------------------------------------

/** Module specifiers a file loads when it runs: `import type` and `export type` are erased, everything else (under verbatimModuleSyntax) is kept. */
export function runtimeImports(ts: Ts, sf: TS.SourceFile): string[] {
  const specs: string[] = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && !st.importClause?.isTypeOnly) specs.push(st.moduleSpecifier.text);
    if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) && !st.isTypeOnly) specs.push(st.moduleSpecifier.text);
  }
  return specs;
}

/** Groups of modules that import each other, directly or around a loop (Tarjan's strongly connected components), plus any module importing itself. */
export function importCycles(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  let next = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];
  const connect = (v: string) => {
    index.set(v, next);
    low.set(v, next++);
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) {
        connect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) !== index.get(v)) return;
    const group: string[] = [];
    let w: string;
    do {
      w = stack.pop()!;
      onStack.delete(w);
      group.push(w);
    } while (w !== v);
    if (group.length > 1 || graph.get(v)?.includes(v)) cycles.push(group.sort());
  };
  for (const v of [...graph.keys()].sort()) if (!index.has(v)) connect(v);
  return cycles;
}

// ---------------------------------------------------------------------------
// Duplication
// ---------------------------------------------------------------------------

export const DUPLICATE_WINDOW = 6;
/** Shared by nature, not copied logic: blank lines, lines of only brackets and punctuation, imports, closing JSX tags. */
const TRIVIAL_LINE = /^(?:[\s{}()[\];,]*|import\b.*|export \* from .*|<\/[\w.]*>)$/;

const significantLines = (src: string) =>
  scrub(src, false)
    .split('\n')
    .map((l) => l.trim().replace(/\s+/g, ' '))
    .filter((l) => !TRIVIAL_LINE.test(l));

/** Lines that sit in a run of DUPLICATE_WINDOW significant lines appearing more than once, anywhere in the given files. */
export function duplicatedLines(files: ReadonlyMap<string, string>): { duplicated: number; significant: number; byFile: Map<string, number> } {
  const at = new Map<string, { file: string; start: number }[]>();
  let significant = 0;
  for (const [file, src] of files) {
    const lines = significantLines(src);
    significant += lines.length;
    for (let i = 0; i + DUPLICATE_WINDOW <= lines.length; i++) {
      const key = lines.slice(i, i + DUPLICATE_WINDOW).join('\n');
      at.set(key, [...(at.get(key) ?? []), { file, start: i }]);
    }
  }
  // Positions are indices into a file's significant lines, so overlapping runs count each line once.
  const marked = new Map<string, Set<number>>();
  for (const { file, start } of [...at.values()].filter((p) => p.length > 1).flat()) {
    const set = marked.get(file) ?? marked.set(file, new Set()).get(file)!;
    for (let k = start; k < start + DUPLICATE_WINDOW; k++) set.add(k);
  }
  const byFile = new Map([...marked].map(([f, s]) => [f, s.size] as const));
  return { duplicated: [...byFile.values()].reduce((a, b) => a + b, 0), significant, byFile };
}

// ---------------------------------------------------------------------------
// Hidden inputs
// ---------------------------------------------------------------------------

/** Every place core and the server read the clock or a random source themselves: composition roots, and the default of a clock that can be injected. */
export const SANCTIONED_CLOCKS: Readonly<Record<string, number>> = {
  'apps/server/src/app.ts': 1, // the default of the injectable clock
  'apps/server/src/sources/collector.ts': 1, // the same, for pulls
  'apps/server/src/server.ts': 3, // seeding an empty log at start; timing a repeated stop signal (ADR 0008)
  'apps/server/src/reset.ts': 1, // re-seeding while the server is stopped
  'apps/server/src/simulate.ts': 4, // the simulator plays live time
};
const HIDDEN_INPUT = /\bDate\.now\s*\(|\bnew\s+Date\s*\(\s*\)|\bMath\.random\s*\(|\bperformance\.now\s*\(|\bcrypto\.(?:randomUUID|getRandomValues)\s*\(/g;
const IN_HIDDEN_INPUT_SCOPE = (f: string) => /^(?:packages\/[^/]+|apps\/server)\/src\/.+\.ts$/.test(f) && !f.startsWith('apps/server/src/dogfood/');

// ---------------------------------------------------------------------------
// Outdated dependencies
// ---------------------------------------------------------------------------

/** `5.9.3` → `7.0.2` is a major behind; so is `0.3.1` → `0.4.0`, since a 0.x minor is a breaking release. */
export function majorBehind(current: string, latest: string): boolean {
  const [cMaj = 0, cMin = 0] = current.split('.').map((p) => Number.parseInt(p, 10));
  const [lMaj = 0, lMin = 0] = latest.split('.').map((p) => Number.parseInt(p, 10));
  return lMaj > cMaj || (cMaj === 0 && lMaj === 0 && lMin > cMin);
}

type Manifest = Partial<Record<'dependencies' | 'devDependencies', Record<string, string>>>;
type Outdated = Record<string, { current?: string; latest?: string }>;

/** Direct dependencies named in the tracked manifests; workspace links and @types/* are left out. */
function directDependencies(ctx: ProbeContext): Set<string> {
  const direct = new Set<string>();
  for (const f of ctx.tracked().filter((f) => /^(?:(?:packages|apps)\/[^/]+\/)?package\.json$/.test(f))) {
    const pkg = JSON.parse(read(ctx, f)) as Manifest;
    for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) if (!range.startsWith('workspace:') && !name.startsWith('@types/')) direct.add(name);
  }
  return direct;
}

/** pnpm exits non-zero whenever something is outdated, so only a missing or failed report means nothing was measured. */
function outdatedReport(res: RunOutput): Outdated | Skip {
  if (res.spawnError) return { skipped: `pnpm could not start: ${res.spawnError}` };
  let report: unknown;
  try {
    report = JSON.parse(res.stdout);
  } catch {
    return { skipped: `pnpm outdated gave no report: ${lastLine(res.stderr || res.stdout) || `exit ${res.code}`}` };
  }
  if (!report || typeof report !== 'object' || 'error' in report) return { skipped: `pnpm outdated failed: ${lastLine(res.stderr) || JSON.stringify(report).slice(0, 200)}` };
  return report as Outdated;
}

// ---------------------------------------------------------------------------
// The probes
// ---------------------------------------------------------------------------

export const MAINTAINABILITY_PROBES: readonly Probe[] = [
  {
    id: 'complex-functions',
    version: 1,
    since: V1,
    method: `Parses tracked packages/*/src and apps/*/src (*.ts, *.tsx) with the TypeScript compiler API and scores every function, method and arrow function on its own (a nested function neither adds to its parent nor nests it). Cognitive complexity: +1 for each if, else if, else, ternary, switch, loop (for, for…in, for…of, while, do), catch, labelled break or continue, and each run of like logical operators (&&, ||, ??; a change of operator starts a new run); if, ternary, switch, loops and catch add 1 more per level they are nested in. The value is the number of functions scoring above ${COMPLEXITY_LIMIT}. No reading when the compiler API cannot be loaded.`,
    async measure(ctx) {
      const ts = await loadTypescript();
      if (isSkip(ts)) return ts;
      const over = sources(ctx)
        .flatMap((f) => cognitiveComplexity(ts, parseSource(ts, f, read(ctx, f))).map((s) => ({ ...s, file: f })))
        .filter((s) => s.score > COMPLEXITY_LIMIT)
        .sort((a, b) => b.score - a.score);
      return { value: over.length, detail: over.slice(0, 3).map((s) => `${s.name} ${s.score} (${s.file}:${s.line})`).join(', ') || undefined };
    },
  },
  {
    id: 'import-cycles',
    version: 2,
    since: 'ADR 0013: code now crosses packages — the server loads the module packages, which load the kit — so every `@orrery/<name>` resolves to packages/<name>/src/index.ts, not only `@orrery/core`, and a cycle through a module counts',
    method:
      'Parses tracked packages/*/src and apps/*/src (*.ts, *.tsx) with the TypeScript compiler API and links each file to the source files it loads at run time: relative imports and re-exports, and each workspace package `@orrery/<name>` as packages/<name>/src/index.ts when that file is tracked. `import type` and `export type` are erased and left out; dynamic import() is left out. The value is the number of cycles — groups of modules that reach each other — plus modules importing themselves. No reading when the compiler API cannot be loaded.',
    async measure(ctx) {
      const ts = await loadTypescript();
      if (isSkip(ts)) return ts;
      const files = new Set(sources(ctx));
      const target = (from: string, spec: string) => {
        const entry = /^@orrery\/([\w-]+)$/.exec(spec);
        if (entry) return files.has(`packages/${entry[1]}/src/index.ts`) ? `packages/${entry[1]}/src/index.ts` : null;
        if (!spec.startsWith('.')) return null;
        const base = resolveImport(from, spec);
        return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((c) => files.has(c)) ?? null;
      };
      const graph = new Map([...files].map((f) => [f, runtimeImports(ts, parseSource(ts, f, read(ctx, f))).flatMap((s) => target(f, s) ?? [])]));
      const cycles = importCycles(graph);
      return { value: cycles.length, detail: cycles[0]?.join(' ⇄ ') };
    },
  },
  {
    id: 'duplicated-lines',
    version: 1,
    since: V1,
    method: `Tracked packages/*/src and apps/*/src (*.ts, *.tsx), comments removed, each line trimmed and its whitespace collapsed. Blank lines, lines of only brackets and punctuation, imports and closing JSX tags are left out; the rest are significant. A line is duplicated when it sits in a run of ${DUPLICATE_WINDOW} consecutive significant lines that appears more than once, in the same file or another. The value is duplicated ÷ significant lines × 100.`,
    measure(ctx) {
      const { duplicated, significant, byFile } = duplicatedLines(new Map(sources(ctx).map((f) => [f, read(ctx, f)])));
      if (significant === 0) return { skipped: 'no source lines found' };
      const top = [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 3);
      return { value: Math.round((10_000 * duplicated) / significant) / 100, detail: `${duplicated} of ${significant} lines${top.length ? `: ${top.map(([f, n]) => `${f} ${n}`).join(', ')}` : ''}` };
    },
  },
  {
    id: 'hidden-inputs',
    version: 2,
    since: 'The allowlist grants server.ts two more reads: performance.now() times a repeated stop signal, at the entry point (ADR 0008). ADR 0009 found them unlisted',
    method: `Counts reads of the system clock or a random source — Date.now(), new Date() without arguments, performance.now(), Math.random(), crypto.randomUUID() and crypto.getRandomValues() — outside comments and strings in tracked packages/*/src and apps/server/src (*.ts), apps/server/src/dogfood excepted (it times things on purpose), beyond the allowlist ${Object.entries(SANCTIONED_CLOCKS)
      .map(([f, n]) => `${f.replace('apps/server/src/', '')} ×${n}`)
      .join(', ')}. Everything else takes the time and any randomness as arguments.`,
    measure(ctx) {
      const excess: string[] = [];
      let total = 0;
      for (const f of ctx.tracked().filter(IN_HIDDEN_INPUT_SCOPE)) {
        const over = (scrub(read(ctx, f), true).match(HIDDEN_INPUT)?.length ?? 0) - (SANCTIONED_CLOCKS[f] ?? 0);
        if (over > 0) excess.push(`${f} +${over}`);
        total += Math.max(0, over);
      }
      return { value: total, detail: excess.join(', ') || undefined };
    },
  },
  {
    id: 'core-coverage',
    version: 2,
    since:
      'vitest 4 (ADR 0010) maps V8 coverage back to statements through the syntax tree. On the same code (d338512) it counts 734 statements where vitest 3 counted 1,098, and reads 89.23% where vitest 3 read 93.44%, so the two are not comparable',
    method:
      'vitest run in packages/core with the V8 coverage provider (@vitest/coverage-v8, vitest 4, which maps coverage to statements through the syntax tree), instrumenting packages/core/src only and writing a json-summary report to a temp dir. The value is the share of statements the core’s own tests execute, in %; tests elsewhere that happen to run core code do not count. No reading when a test fails (vitest then writes no coverage) or the provider is not installed.',
    async measure(ctx) {
      const dir = join(ctx.tmp, 'coverage-core');
      const args = ['run', '--coverage.enabled=true', '--coverage.provider=v8', '--coverage.reporter=json-summary', `--coverage.reportsDirectory=${dir}`, '--coverage.include=src/**'];
      const res = await runProgram(ctx.root, 'vitest', args, { cwd: resolve(ctx.root, 'packages/core'), timeoutMs: 300_000 });
      if (res.spawnError) return { skipped: `vitest could not start: ${res.spawnError}` };
      const file = join(dir, 'coverage-summary.json');
      if (!existsSync(file)) return { skipped: `vitest wrote no coverage (exit ${res.code}): ${lastLine(res.stderr || res.stdout)}` };
      const { total } = JSON.parse(readFileSync(file, 'utf8')) as { total: Record<'statements' | 'branches' | 'functions', { pct: number }> };
      return { value: total.statements.pct, detail: `branches ${total.branches.pct}%, functions ${total.functions.pct}%` };
    },
  },
  {
    id: 'outdated-majors',
    version: 1,
    since: V1,
    method:
      '`pnpm -r outdated --format json` over the whole workspace, dev dependencies included. The value is the share, in %, of the direct dependencies named in the tracked package.json files (workspace links excepted) whose latest release is at least one major version ahead of the installed one (for 0.x, one minor). @types/* packages are left out of both counts: they follow the Node and React versions the code targets, not their own releases. No reading when the registry cannot be reached.',
    async measure(ctx) {
      const direct = directDependencies(ctx);
      if (direct.size === 0) return { skipped: 'no direct dependencies found' };
      const report = outdatedReport(await runProgram(ctx.root, 'pnpm', ['-r', 'outdated', '--format', 'json'], { cwd: ctx.root, timeoutMs: 120_000 }));
      if (isSkip(report)) return report;
      const behind = Object.entries(report)
        .filter(([name, v]) => direct.has(name) && v.current && v.latest && majorBehind(v.current, v.latest))
        .map(([name, v]) => `${name} ${v.current} → ${v.latest}`)
        .sort();
      const names = behind.slice(0, 4).join(', ') + (behind.length > 4 ? ` and ${behind.length - 4} more` : '');
      return { value: Math.round((1000 * behind.length) / direct.size) / 10, detail: `${behind.length} of ${direct.size}${behind.length ? `: ${names}` : ''}` };
    },
  },
];
