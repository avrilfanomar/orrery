// The expensive, shared steps behind the probes: one test run, one typecheck,
// one fresh UI build. Each runs at most once per `pnpm dogfood`, sequentially,
// so timings are not skewed by work running alongside them (ADR 0003).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join, relative, resolve } from 'node:path';

export type Skip = { skipped: string };
export const isSkip = (v: unknown): v is Skip => typeof v === 'object' && v !== null && 'skipped' in v;

export interface RunOutput {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  /** Set when the program could not be started at all. */
  spawnError: string | null;
}

/** The package's and the workspace's `node_modules/.bin` ahead of the PATH, as pnpm scripts have it. */
export const binPath = (root: string, cwd: string) => [join(cwd, 'node_modules/.bin'), join(root, 'node_modules/.bin'), process.env.PATH ?? ''].join(delimiter);

export function runProgram(
  root: string,
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string | undefined>; timeoutMs?: number },
): Promise<RunOutput> {
  const path = binPath(root, opts.cwd);
  const started = performance.now();
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env, PATH: path }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let spawnError: string | null = null;
    child.stdout.on('data', (b: Buffer) => (stdout += b));
    child.stderr.on('data', (b: Buffer) => (stderr += b));
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs) : null;
    child.on('error', (err) => (spawnError = err.message));
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      done({ code, stdout, stderr, ms: performance.now() - started, spawnError });
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

export interface TestCase {
  /** Repository-relative path of the test file. */
  file: string;
  /** Enclosing `describe` titles, outermost first. */
  ancestors: string[];
  title: string;
  status: 'passed' | 'failed' | 'skipped';
}

export interface TestRun {
  tests: TestCase[];
  /** Test files that failed without running any test (a syntax error, a failing import). */
  brokenFiles: string[];
  ms: number;
}

interface VitestJson {
  testResults?: { name: string; status: string; assertionResults?: { ancestorTitles: string[]; title: string; status: string }[] }[];
}

export const TEST_PACKAGES = ['packages/core', 'apps/server'] as const;

/** Reads vitest's JSON report into repository-relative test cases. */
export function parseVitestJson(root: string, json: VitestJson): Omit<TestRun, 'ms'> {
  const tests: TestCase[] = [];
  const brokenFiles: string[] = [];
  for (const f of json.testResults ?? []) {
    const file = relative(root, f.name).split('\\').join('/');
    const cases = f.assertionResults ?? [];
    if (cases.length === 0 && f.status === 'failed') brokenFiles.push(file);
    for (const a of cases) {
      const status = a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : 'skipped';
      tests.push({ file, ancestors: a.ancestorTitles, title: a.title, status });
    }
  }
  return { tests, brokenFiles };
}

export async function runTests(root: string, tmp: string): Promise<TestRun | Skip> {
  const run: TestRun = { tests: [], brokenFiles: [], ms: 0 };
  for (const pkg of TEST_PACKAGES) {
    const out = join(tmp, `${pkg.replace(/\W+/g, '-')}.json`);
    const res = await runProgram(root, 'vitest', ['run', '--reporter=json', `--outputFile=${out}`], { cwd: resolve(root, pkg), timeoutMs: 300_000 });
    run.ms += res.ms;
    if (res.spawnError) return { skipped: `vitest could not start in ${pkg}: ${res.spawnError}` };
    // A failing test exits non-zero; only a missing report means nothing was measured.
    if (!existsSync(out)) return { skipped: `vitest wrote no report in ${pkg} (exit ${res.code})` };
    const parsed = parseVitestJson(root, JSON.parse(readFileSync(out, 'utf8')) as VitestJson);
    run.tests.push(...parsed.tests);
    run.brokenFiles.push(...parsed.brokenFiles);
  }
  return run;
}

// ---------------------------------------------------------------------------
// Typecheck and build
// ---------------------------------------------------------------------------

export const TYPECHECK_PACKAGES = ['packages/core', 'apps/server', 'apps/web'] as const;

export interface TypecheckRun {
  errors: number;
  byPackage: Record<string, number>;
  ms: number;
}

export async function runTypecheck(root: string): Promise<TypecheckRun | Skip> {
  const run: TypecheckRun = { errors: 0, byPackage: {}, ms: 0 };
  for (const pkg of TYPECHECK_PACKAGES) {
    const res = await runProgram(root, 'tsc', ['--noEmit', '-p', 'tsconfig.json'], { cwd: resolve(root, pkg), timeoutMs: 300_000 });
    run.ms += res.ms;
    if (res.spawnError) return { skipped: `tsc could not start: ${res.spawnError}` };
    const n = (res.stdout.match(/error TS\d+/g) ?? []).length;
    if (res.code !== 0 && n === 0) return { skipped: `tsc failed in ${pkg} without reporting type errors (exit ${res.code})` };
    run.byPackage[pkg] = n;
    run.errors += n;
  }
  return run;
}

export interface BuildRun {
  outDir: string;
  ms: number;
}

/** A fresh production build into a temporary directory — never whatever happens to sit in apps/web/dist. */
export async function runBuild(root: string, tmp: string): Promise<BuildRun | Skip> {
  const outDir = join(tmp, 'web');
  const res = await runProgram(root, 'vite', ['build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'warn'], { cwd: resolve(root, 'apps/web'), timeoutMs: 300_000 });
  if (res.spawnError) return { skipped: `vite could not start: ${res.spawnError}` };
  if (res.code !== 0) return { skipped: `vite build failed (exit ${res.code}): ${lastLine(res.stderr || res.stdout)}` };
  return { outDir, ms: res.ms };
}

export const lastLine = (s: string) =>
  s
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1)
    ?.slice(0, 200) ?? '';

// ---------------------------------------------------------------------------
// Repository facts
// ---------------------------------------------------------------------------

export interface GitSnapshot {
  sha: string;
  dirty: boolean;
  /** The author's name, for the actor of model changes. */
  userName: string | null;
  /** The subject of the last commit touching the model or the probes — only when both are committed as they stand. */
  modelReason: string | null;
  /** When that commit was made; its subject explains only the changes nobody made to the log since. */
  modelCommittedAt: string | null;
}

const git = (root: string, args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

export const MODEL_FILES = ['apps/server/src/dogfood/model.ts', 'apps/server/src/dogfood/probes.ts'];

export function gitSnapshot(root: string): GitSnapshot {
  const sha = git(root, ['rev-parse', '--short', 'HEAD']);
  const dirty = git(root, ['status', '--porcelain']) !== '';
  let userName: string | null = null;
  try {
    userName = git(root, ['config', 'user.name']) || null;
  } catch {
    // no name configured
  }
  const modelClean = git(root, ['status', '--porcelain', '--', ...MODEL_FILES]) === '';
  const [modelReason, modelCommittedAt] = modelClean ? git(root, ['log', '-1', '--format=%s%x00%cI', '--', ...MODEL_FILES]).split('\0') : [];
  return { sha, dirty, userName, modelReason: modelReason || null, modelCommittedAt: modelCommittedAt || null };
}

/** Tracked files only: the measurement describes committed code, not stray local files. */
export const trackedFiles = (root: string): string[] => git(root, ['ls-files']).split('\n').filter(Boolean);

const median = (t: number[]) => {
  t.sort((a, b) => a - b);
  const mid = t.length >> 1;
  return t.length % 2 ? t[mid]! : (t[mid - 1]! + t[mid]!) / 2;
};

/** Median wall time of `fn` after warm-up runs, so one GC pause or JIT tier-up does not decide the number. */
export function medianMs(fn: () => unknown, warmup: number, runs: number): number {
  for (let i = 0; i < warmup; i++) fn();
  const t: number[] = [];
  for (let i = 0; i < runs; i++) {
    const s = performance.now();
    fn();
    t.push(performance.now() - s);
  }
  return median(t);
}

/** The same for work that crosses an `await`, such as a request through `inject`. */
export async function medianMsAsync(fn: () => Promise<unknown>, warmup: number, runs: number): Promise<number> {
  for (let i = 0; i < warmup; i++) await fn();
  const t: number[] = [];
  for (let i = 0; i < runs; i++) {
    const s = performance.now();
    await fn();
    t.push(performance.now() - s);
  }
  return median(t);
}
