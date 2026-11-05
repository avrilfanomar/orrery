// What keeps a green earned (ADR 0009), measured from outside the suite: the
// core broken on purpose in each way that would show someone a status nobody
// earned, and the core's own tests run against each break. A break that no
// test catches is a false green the suite would let through. The suite checks
// that every break still applies to the code (dogfood.test.ts), so a refactor
// cannot quietly retire one. These live apart from probes.ts, which imports
// them, so they may import only types from it.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lastLine, parseVitestJson, runProgram } from './collectors.js';
import type { Probe, ProbeContext, ProbeOutcome } from './probes.js';

const V1 = 'First version of this method (ADR 0009)';

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

export const FALSE_GREEN_MUTANTS: readonly Mutant[] = [
  {
    id: 'unknown-ranks-below-ok',
    file: 'constants.ts',
    find: 'export const SEVERITY: Record<Status, number> = { ok: 0, unknown: 1, warn: 2, breach: 3 };',
    replace: 'export const SEVERITY: Record<Status, number> = { ok: 1, unknown: 0, warn: 2, breach: 3 };',
    shows: 'worst-of on target with an input nobody measures',
  },
  { id: 'never-measured-ok', file: 'evaluate.ts', find: "status: 'unknown', value: null, observedAt: null, stale: false, reason: 'Never measured", replace: "status: 'ok', value: null, observedAt: null, stale: false, reason: 'Never measured", shows: 'a KPI on target before its first reading' },
  { id: 'stale-reads-fresh', file: 'evaluate.ts', find: 'if (ageMs > spec.staleAfterHours * 3.6e6) {', replace: 'if (ageMs > Infinity) {', shows: 'a reading weeks old still on target' },
  { id: 'incomparable-judged', file: 'evaluate.ts', find: 'const changed = taken?.measure && taken.version !== def.version ? incomparable(taken, def) : null;', replace: 'const changed = null;', shows: 'a number in the old unit judged against the new target' },
  { id: 'warning-reads-ok', file: 'evaluate.ts', find: "if (value >= spec.target) return 'ok';", replace: "if (value >= spec.warn) return 'ok';", shows: 'a value short of its target on target' },
  { id: 'history-judged-today', file: 'evaluate.ts', find: '    if (x.effectiveFrom <= at) d = x;\n    else break;', replace: '    d = x;', shows: 'past readings repainted by today’s target' },
  { id: 'future-readings', file: 'evaluate.ts', find: 'if (readings[mid]!.observedAt <= at) lo = mid + 1;', replace: 'if (readings[mid]) lo = mid + 1;', shows: 'a moment in the past judged by readings taken after it' },
  { id: 'no-inputs-pass', file: 'evaluate.ts', find: "if (inputs.length === 0) return { status: 'unknown'", replace: "if (inputs.length === 0) return { status: 'ok'", shows: 'a rule with nothing to judge on target' },
  { id: 'weighted-ignores-unknown', file: 'evaluate.ts', find: "if (byScore === 'ok' && counts.unknown > 0) {", replace: 'if (false) {', shows: 'a weighted score on target with inputs unmeasured' },
  { id: 'quorum-counts-unknown', file: 'evaluate.ts', find: 'if (share(ok) >= rule.okShare) {', replace: 'if (share(ok + counts.unknown) >= rule.okShare) {', shows: 'a quorum met by inputs nobody measures' },
  { id: 'critical-outvoted', file: 'evaluate.ts', find: 'if (vetoes.length === 0) return null;', replace: 'return null;', shows: 'a critical breach outvoted' },
  { id: 'critical-pending-ignored', file: 'evaluate.ts', find: "if (pending.length === 0) return { status: 'ok'", replace: "if (pending) return { status: 'ok'", shows: 'a quorum on target while an unmeasured critical input could still veto it' },
  { id: 'stub-reads-ok', file: 'evaluate.ts', find: "result = { status: 'unknown', reason, drivers: [], coverage, score: null, measurement, counts, inputCount: 0 };", replace: "result = { status: 'ok', reason, drivers: [], coverage, score: null, measurement, counts, inputCount: 0 };", shows: 'an unrefined stub on target' },
  { id: 'cycle-reads-ok', file: 'evaluate.ts', find: "return { status: 'unknown', reason: 'Cycle in the contribution graph'", replace: "return { status: 'ok', reason: 'Cycle in the contribution graph'", shows: 'a node that feeds itself, in a hand-edited log, on target' },
  { id: 'breachless-rule-accepted', file: 'schema.ts', find: "(r) => !(r.strategy === 'weighted' && r.warnAt === 0) && !(r.strategy === 'quorum' && r.warnShare === 0),", replace: '() => true,', shows: 'a rule that can never read breach' },
];

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

async function falseGreenMutants(ctx: ProbeContext): Promise<ProbeOutcome> {
  const cores = Array.from({ length: COPIES }, (_, k) => copyCore(ctx.root, join(ctx.tmp, `mutants-${k}`)));
  const clean = await runProgram(ctx.root, process.execPath, [join(cores[0]!, 'node_modules/vitest/vitest.mjs'), 'run', '--no-cache', '--reporter=dot'], { cwd: cores[0]!, timeoutMs: 120_000 });
  if (clean.code !== 0) return { skipped: `the core's tests fail on an unbroken copy: ${lastLine(clean.stderr || clean.stdout)}` };
  const gone = FALSE_GREEN_MUTANTS.filter((m) => readFileSync(join(cores[0]!, 'src', m.file), 'utf8').split(m.find).length !== 2);
  if (gone.length) return { skipped: `no longer applies to the code: ${gone.map((m) => m.id).join(', ')}` };
  const queue = [...FALSE_GREEN_MUTANTS];
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
  const unloaded = FALSE_GREEN_MUTANTS.filter((m) => verdicts.get(m) === 'did not load');
  if (unloaded.length) return { skipped: `the break leaves code that does not load, which proves nothing: ${unloaded.map((m) => m.id).join(', ')}` };
  const s = Math.round((performance.now() - started) / 100) / 10;
  const missed = FALSE_GREEN_MUTANTS.filter((m) => verdicts.get(m) === 'missed');
  const detail = missed.length ? `no test catches ${missed.map((m) => `${m.id} (${m.shows})`).join('; ')}` : `the core's tests catch all ${FALSE_GREEN_MUTANTS.length} breaks (${s} s)`;
  return { value: missed.length, detail };
}

export const SAFETY_PROBES: readonly Probe[] = [
  {
    id: 'false-green-mutants',
    version: 1,
    since: V1,
    method: `Copies packages/core into a temp directory and breaks it on purpose, one break at a time, in each of ${FALSE_GREEN_MUTANTS.length} ways that would show someone a status nobody earned: ${FALSE_GREEN_MUTANTS.map((m) => m.id).join(', ')} (FALSE_GREEN_MUTANTS in apps/server/src/dogfood/safety.ts). After each break it runs the core's tests (vitest run --bail=1, JSON report), on three copies side by side. A break is caught only when a test fails. The value is the number of breaks no test catches. No reading when the unbroken copy fails its tests, a break no longer applies to the code, or a break leaves code that does not load.`,
    measure: falseGreenMutants,
  },
];
