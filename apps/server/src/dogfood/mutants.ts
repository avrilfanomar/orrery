// Breaking packages/core on purpose and asking whether its tests notice, for
// the probes that keep a list of such breaks: the false greens (safety.ts,
// ADR 0009) and the claims the README makes (suitability.ts, ADR 0012). The
// suite checks that every break still applies to the code (dogfood.test.ts),
// so a refactor cannot quietly retire one. This module may import only types
// from probes.ts, which imports the probes that use it.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lastLine, parseVitestJson, runProgram } from './collectors.js';
import type { ProbeContext } from './probes.js';

export interface Mutant {
  id: string;
  /** Relative to packages/core/src. */
  file: string;
  /** Occurs exactly once in the file (dogfood.test.ts). */
  find: string;
  replace: string;
  /** What a person would be shown if the break shipped. */
  shows: string;
}

/** The ids of the breaks whose text no longer occurs exactly once in the code under `coreSrc`. */
export function inapplicable(coreSrc: string, mutants: readonly Mutant[]): string[] {
  return mutants.filter((m) => readFileSync(join(coreSrc, m.file), 'utf8').split(m.find).length !== 2).map((m) => m.id);
}

/** A copy of packages/core to break: never the checkout itself, which an interrupted run would leave broken. */
function copyCore(root: string, dir: string): string {
  const core = join(dir, 'packages/core');
  for (const part of ['src', 'test', 'package.json', 'tsconfig.json']) cpSync(join(root, 'packages/core', part), join(core, part), { recursive: true });
  cpSync(join(root, 'tsconfig.base.json'), join(dir, 'tsconfig.base.json'));
  // Its own node_modules of links to the real packages, so vitest writes nothing into the checkout's.
  const modules = join(root, 'packages/core/node_modules');
  mkdirSync(join(core, 'node_modules'));
  for (const name of readdirSync(modules).filter((n) => !n.startsWith('.'))) symlinkSync(realpathSync(join(modules, name)), join(core, 'node_modules', name), 'dir');
  return core;
}

/** Copies broken side by side: each run is mostly vitest starting up, which leaves the cores idle. */
const COPIES = 3;

type Verdict = 'caught' | 'missed' | 'did not load';

/**
 * Runs the copy's tests. A break counts as caught only when a test fails: a
 * replacement that does not even load would otherwise read as a catch, a false
 * green in the very probe that looks for them.
 */
async function verdict(root: string, core: string): Promise<Verdict> {
  const report = join(core, 'report.json');
  rmSync(report, { force: true });
  const args = [join(core, 'node_modules/vitest/vitest.mjs'), 'run', '--bail=1', '--no-cache', '--reporter=json', `--outputFile=${report}`];
  const run = await runProgram(root, process.execPath, args, { cwd: core, timeoutMs: 120_000 });
  if (run.code === 0) return 'missed';
  const result = existsSync(report) ? parseVitestJson(core, JSON.parse(readFileSync(report, 'utf8'))) : null;
  return result?.tests.some((t) => t.status === 'failed') ? 'caught' : 'did not load';
}

export interface MutantRun {
  /** The breaks no test caught, in list order. */
  missed: Mutant[];
  seconds: number;
}

/**
 * Applies each break to a copy of packages/core, one at a time, and runs the
 * copy's tests after each. Skips when the unbroken copy fails its tests, a
 * break no longer applies, or a break leaves code that does not load.
 */
export async function runMutants(ctx: ProbeContext, mutants: readonly Mutant[], label: string): Promise<MutantRun | { skipped: string }> {
  const cores = Array.from({ length: COPIES }, (_, k) => copyCore(ctx.root, join(ctx.tmp, `${label}-${k}`)));
  const clean = await runProgram(ctx.root, process.execPath, [join(cores[0]!, 'node_modules/vitest/vitest.mjs'), 'run', '--no-cache', '--reporter=dot'], { cwd: cores[0]!, timeoutMs: 120_000 });
  if (clean.code !== 0) return { skipped: `the core's tests fail on an unbroken copy: ${lastLine(clean.stderr || clean.stdout)}` };
  const gone = inapplicable(join(cores[0]!, 'src'), mutants);
  if (gone.length) return { skipped: `no longer applies to the code: ${gone.join(', ')}` };
  const queue = [...mutants];
  const verdicts = new Map<Mutant, Verdict>();
  const started = performance.now();
  await Promise.all(
    cores.map(async (core) => {
      for (let m = queue.shift(); m; m = queue.shift()) {
        const file = join(core, 'src', m.file);
        const original = readFileSync(file, 'utf8');
        writeFileSync(file, original.replace(m.find, m.replace));
        verdicts.set(m, await verdict(ctx.root, core));
        writeFileSync(file, original);
      }
    }),
  );
  const unloaded = mutants.filter((m) => verdicts.get(m) === 'did not load');
  if (unloaded.length) return { skipped: `the break leaves code that does not load, which proves nothing: ${unloaded.map((m) => m.id).join(', ')}` };
  return { missed: mutants.filter((m) => verdicts.get(m) === 'missed'), seconds: Math.round((performance.now() - started) / 100) / 10 };
}
