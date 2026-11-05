// Whether the product does what the README says it does (ADR 0012), measured
// from outside the suite: for each need in "The idea", the core broken on
// purpose so the claim stops holding, and the core's own tests run against
// each break (mutants.ts). A break no test catches is a claim nothing defends.
// The breaks whose whole harm is a false green are kept in safety.ts.
// These live apart from probes.ts, which imports them, so they may import only
// types from it.
import { runMutants, type Mutant } from './mutants.js';
import type { Probe, ProbeContext, ProbeOutcome } from './probes.js';

const V12 = 'First version of this method (ADR 0012)';

/** The rows of the README's "The idea" table, each a need the product claims to meet. */
export const NEEDS = ['Build and manage requirements & constraints', 'Business + quality KPIs', 'High-level monitoring', 'Progressive disclosure', 'Iterative refinement', 'Dynamic evolution'] as const;

export interface ClaimMutant extends Mutant {
  need: (typeof NEEDS)[number];
}

const [MANAGE, KPIS, MONITOR, DISCLOSE, REFINE, EVOLVE] = NEEDS;

export const CLAIM_MUTANTS: readonly ClaimMutant[] = [
  { need: MANAGE, id: 'links-ignored', file: 'evaluate.ts', find: 'for (const cid of [...(idx.children.get(id) ?? []), ...(idx.linkedFrom.get(id) ?? [])]) {', replace: 'for (const cid of [...(idx.children.get(id) ?? [])]) {', shows: 'a node that evidences two parents counted in only one' },
  { need: MANAGE, id: 'move-cycle', file: 'decide.ts', find: 'if (to === n.id || contributesTo(u, to, n.id)) {', replace: 'if (to === n.id) {', shows: 'a move that makes a node contribute to itself accepted' },
  { need: MANAGE, id: 'link-cycle', file: 'decide.ts', find: "if (contributesTo(u, t.id, n.id)) throw new DomainError('conflict', 'That link", replace: "if (false) throw new DomainError('conflict', 'That link", shows: 'a link that makes a node contribute to itself accepted' },
  { need: KPIS, id: 'on-target-warns', file: 'evaluate.ts', find: "if (value <= spec.target) return 'ok';", replace: "if (value < spec.target) return 'ok';", shows: 'a value exactly on its target shown as a warning' },
  { need: KPIS, id: 'at-warning-breaches', file: 'evaluate.ts', find: "if (value >= spec.warn) return 'warn';", replace: "if (value > spec.warn) return 'warn';", shows: 'a value exactly at its warning threshold shown as a breach' },
  { need: KPIS, id: 'fresh-reads-stale', file: 'evaluate.ts', find: 'if (ageMs > spec.staleAfterHours * 3.6e6) {', replace: 'if (ageMs > spec.staleAfterHours * 3.6e3) {', shows: 'a reading minutes old shown as stale' },
  { need: MONITOR, id: 'warn-reason-wrong', file: 'evaluate.ts', find: "but is within ${formatThreshold(spec, 'warn')}", replace: "but is within ${formatThreshold(spec, 'target')}", shows: 'a warning whose reason names the wrong threshold' },
  { need: MONITOR, id: 'coverage-overstated', file: 'evaluate.ts', find: "myLeaves.set(id, measurement.status !== 'unknown');", replace: 'myLeaves.set(id, true);', shows: 'a KPI nobody has measured counted as observable' },
  { need: MONITOR, id: 'ribbon-ends-yesterday', file: 'views.ts', find: '(ribbonDays - 1 - i) * DAY', replace: '(ribbonDays - i) * DAY', shows: 'a ribbon that ends the day before the moment shown' },
  { need: DISCLOSE, id: 'signal-one-step', file: 'evaluate.ts', find: 'for (let i = 0; i < maxDepth; i++) {', replace: 'for (let i = 0; i < 1; i++) {', shows: 'Follow the signal stopping one level down' },
  { need: DISCLOSE, id: 'drivers-by-weight', file: 'evaluate.ts', find: '.sort((a, b) => SEVERITY[b.status] - SEVERITY[a.status] || b.weight - a.weight)', replace: '.sort((a, b) => b.weight - a.weight)', shows: 'Follow the signal leading to a warning while a breach sits beside it' },
  { need: DISCLOSE, id: 'breadcrumb-one-step', file: 'views.ts', find: '    cur = view.nodes[cur]!.parentId;', replace: '    cur = null;', shows: 'a breadcrumb that climbs one level and stops' },
  { need: DISCLOSE, id: 'backlog-skips-links', file: 'views.ts', find: 'const inputs = [...n.childIds, ...n.linkedFromIds].filter(', replace: 'const inputs = [...n.childIds].filter(', shows: 'a gap reached through a link missing from the backlog' },
  { need: REFINE, id: 'backlog-misses-stubs', file: 'views.ts', find: "if (nid !== id && (m ? m.status === 'unknown' : inputs.length === 0)) out.set(nid, n);", replace: "if (nid !== id && m?.status === 'unknown') out.set(nid, n);", shows: 'an unrefined stub missing from the Not yet observable backlog' },
  { need: EVOLVE, id: 'reason-optional', file: 'schema.ts', find: ".min(3, 'Give a reason", replace: ".min(0, 'Give a reason", shows: 'a change kept without its why' },
  { need: EVOLVE, id: 'deprecated-counts', file: 'evaluate.ts', find: "if (u.nodes.get(cid)?.lifecycle === 'active') out.push(cid);", replace: 'out.push(cid);', shows: 'a deprecated node still deciding its parent’s status' },
  { need: EVOLVE, id: 'time-travel-leaks', file: 'project.ts', find: 'if (asOf && e.at > asOf) break;', replace: 'if (false) break;', shows: 'the past shown with nodes created after it' },
  { need: EVOLVE, id: 'new-target-waits', file: 'evaluate.ts', find: 'const status = judge(r.value, spec);', replace: 'const status = judge(r.value, taken?.measure ?? spec);', shows: 'a published target ignored until the next reading' },
  { need: EVOLVE, id: 'diff-misses-target', file: 'project.ts', find: "parts.push(`target ${formatThreshold(a, 'target')} → ${formatThreshold(b, 'target')}`);", replace: '', shows: 'a revision whose change-feed entry leaves out its new target' },
  { need: EVOLVE, id: 'late-reading-out-of-order', file: 'project.ts', find: 'if (list[mid]!.observedAt <= r.observedAt) lo = mid + 1;', replace: 'if (list[mid]) lo = mid + 1;', shows: 'a late, back-dated reading replacing today’s status' },
  { need: EVOLVE, id: 'backfill-unjudged', file: 'evaluate.ts', find: 'return n.definitions.find((x) => x.version > d.version && x.measure) ?? null;', replace: 'return null;', shows: 'a reading back-filled from before the node had a measure left unjudged' },
];

async function claimMutants(ctx: ProbeContext): Promise<ProbeOutcome> {
  const run = await runMutants(ctx, CLAIM_MUTANTS, 'claims');
  if ('skipped' in run) return run;
  const missed = run.missed as ClaimMutant[];
  const detail = missed.length
    ? `no test catches ${missed.map((m) => `${m.id} (${m.need}: ${m.shows})`).join('; ')}`
    : `the core's tests catch all ${CLAIM_MUTANTS.length} breaks, across all ${NEEDS.length} needs (${run.seconds} s)`;
  return { value: missed.length, detail };
}

export const SUITABILITY_PROBES: readonly Probe[] = [
  {
    id: 'claim-mutants',
    version: 1,
    since: V12,
    method: `Copies packages/core into a temp directory and breaks it on purpose, one break at a time, in each of ${CLAIM_MUTANTS.length} ways that would leave a need in the README’s “The idea” table unmet (the false greens are false-green-mutants’ list): ${CLAIM_MUTANTS.map((m) => m.id).join(', ')} (CLAIM_MUTANTS in apps/server/src/dogfood/suitability.ts). After each break it runs the core's tests (vitest run --bail=1, JSON report), on three copies side by side. A break is caught only when a test fails. The value is the number of breaks no test catches. No reading when the unbroken copy fails its tests, a break no longer applies to the code, or a break leaves code that does not load.`,
    measure: claimMutants,
  },
];
