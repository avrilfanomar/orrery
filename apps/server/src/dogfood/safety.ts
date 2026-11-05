// What keeps a green earned (ADR 0009), measured from outside the suite: the
// core broken on purpose in each way that would show someone a status nobody
// earned, and the core's own tests run against each break (mutants.ts). A
// break that no test catches is a false green the suite would let through.
// These live apart from probes.ts, which imports them, so they may import only
// types from it.
import { runMutants, type Mutant } from './mutants.js';
import type { Probe, ProbeContext, ProbeOutcome } from './probes.js';

const V1 = 'First version of this method (ADR 0009)';

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

async function falseGreenMutants(ctx: ProbeContext): Promise<ProbeOutcome> {
  const run = await runMutants(ctx, FALSE_GREEN_MUTANTS, 'mutants');
  if ('skipped' in run) return run;
  const { missed } = run;
  const detail = missed.length ? `no test catches ${missed.map((m) => `${m.id} (${m.shows})`).join('; ')}` : `the core's tests catch all ${FALSE_GREEN_MUTANTS.length} breaks (${run.seconds} s)`;
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
