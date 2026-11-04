// Evaluation: from readings to a status per node, and from contributors to a
// rolled-up status per parent. Pure — the same universe and moment always
// give the same answer, which is what makes time travel and tests cheap.
import {
  PASS_FAIL_UNIT,
  PRIORITY_WEIGHT,
  SEVERITY,
  STATUSES,
  type KnownStatus,
  type Status,
} from './constants.js';
import { formatDuration, formatThreshold, formatValue } from './format.js';
import type { Definition, NodeState, Reading, Universe } from './model.js';
import type { MeasureSpec, RollupRule } from './schema.js';

export interface MeasureEvaluation {
  status: Status;
  value: number | null;
  observedAt: string | null;
  stale: boolean;
  reason: string;
  definitionVersion: number;
  spec: MeasureSpec;
}

export interface Evaluation {
  status: Status;
  /** One sentence a person can read: why this node has this status. */
  reason: string;
  /** The inputs that decided the status — the next step down the "why" path. May include the node itself (its own measure). */
  drivers: string[];
  /** Observable endpoints below this node: how much of it is actually measured. */
  coverage: { measured: number; total: number };
  /** The weighted score (0–1) when the rule is `weighted`, else null. */
  score: number | null;
  measurement: MeasureEvaluation | null;
  /** Statuses of the inputs (contributors plus own measure). */
  counts: Record<Status, number>;
  inputCount: number;
}

export function currentDefinition(n: NodeState): Definition {
  return n.definitions[n.definitions.length - 1]!;
}

/** The definition in force at `at`. Before the first version, the first one applies. */
export function definitionAt(n: NodeState, at: string): Definition {
  let d = n.definitions[0]!;
  for (const x of n.definitions) {
    if (x.effectiveFrom <= at) d = x;
    else break;
  }
  return d;
}

/**
 * The definition a reading was taken under: the one in force when it was
 * observed. A reading back-filled from before the node had any measure has no
 * yardstick of its own and takes the first measure the node got.
 */
export function yardstickAt(n: NodeState, observedAt: string): Definition | null {
  const d = definitionAt(n, observedAt);
  if (d.measure) return d;
  return n.definitions.find((x) => x.version > d.version && x.measure) ?? null;
}

/**
 * What changed between the yardstick a reading was taken under and today's, if
 * the change makes the old number meaningless rather than merely judged by a
 * new threshold (a new unit, or a flipped direction).
 */
function incomparable(then: MeasureSpec, now: MeasureSpec): string | null {
  const parts: string[] = [];
  if (then.unit !== now.unit) parts.push(`the unit (${then.unit} → ${now.unit})`);
  if (then.direction !== now.direction) parts.push(`the direction (${then.direction} → ${now.direction} is better)`);
  return parts.length ? parts.join(' and ') : null;
}

export function judge(value: number, spec: MeasureSpec): KnownStatus {
  if (spec.direction === 'higher') {
    if (value >= spec.target) return 'ok';
    if (value >= spec.warn) return 'warn';
    return 'breach';
  }
  if (value <= spec.target) return 'ok';
  if (value <= spec.warn) return 'warn';
  return 'breach';
}

/** The latest reading observed at or before `at` (binary search). */
export function latestReadingAt(readings: readonly Reading[] | undefined, at: string): Reading | null {
  if (!readings || readings.length === 0) return null;
  let lo = 0;
  let hi = readings.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (readings[mid]!.observedAt <= at) lo = mid + 1;
    else hi = mid;
  }
  return lo === 0 ? null : readings[lo - 1]!;
}

export function evaluateMeasure(u: Universe, n: NodeState, asOf: string): MeasureEvaluation | null {
  const def = definitionAt(n, asOf);
  const spec = def.measure;
  if (!spec) return null;
  const base = { definitionVersion: def.version, spec };
  const r = latestReadingAt(u.readings.get(n.id), asOf);
  if (!r) {
    return { ...base, status: 'unknown', value: null, observedAt: null, stale: false, reason: 'Never measured — no reading has arrived yet' };
  }
  const ageMs = Date.parse(asOf) - Date.parse(r.observedAt);
  if (ageMs > spec.staleAfterHours * 3.6e6) {
    return {
      ...base,
      status: 'unknown',
      value: r.value,
      observedAt: r.observedAt,
      stale: true,
      reason: `Stale — last reading ${formatDuration(ageMs)} ago; one is expected every ${spec.staleAfterHours} h`,
    };
  }
  // A new threshold re-judges the latest reading at once (the present status
  // answers "are we meeting today's target?"). A new unit or direction does
  // not: the old number means something else now, so it is unknown until a
  // reading arrives under today's definition — never a false green.
  const taken = yardstickAt(n, r.observedAt);
  const changed = taken?.measure && taken.version !== def.version ? incomparable(taken.measure, spec) : null;
  if (changed) {
    return {
      ...base,
      status: 'unknown',
      value: null,
      observedAt: r.observedAt,
      stale: false,
      reason: `Not comparable — v${def.version} changed ${changed} after the latest reading (${formatValue(r.value, taken!.measure!.unit)}); waiting for one under v${def.version}`,
    };
  }
  const status = judge(r.value, spec);
  if (spec.unit === PASS_FAIL_UNIT) {
    return { ...base, status, value: r.value, observedAt: r.observedAt, stale: false, reason: status === 'ok' ? 'The latest run passed' : 'The latest run failed' };
  }
  const v = formatValue(r.value, spec.unit);
  const reason =
    status === 'ok'
      ? `${v} meets the target ${formatThreshold(spec, 'target')}`
      : status === 'warn'
        ? `${v} misses the target ${formatThreshold(spec, 'target')} but is within ${formatThreshold(spec, 'warn')}`
        : `${v} is past the warning threshold ${formatThreshold(spec, 'warn')}`;
  return { ...base, status, value: r.value, observedAt: r.observedAt, stale: false, reason };
}

// ---------------------------------------------------------------------------
// Graph structure
// ---------------------------------------------------------------------------

export interface ContributorIndex {
  /** Primary children, any lifecycle, in creation order. */
  children: Map<string, string[]>;
  /** Nodes that link to this one as an additional parent. */
  linkedFrom: Map<string, string[]>;
}

export function indexContributors(u: Universe): ContributorIndex {
  const children = new Map<string, string[]>();
  const linkedFrom = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, k: string, v: string) => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };
  for (const n of u.nodes.values()) {
    if (n.parentId) push(children, n.parentId, n.id);
    for (const t of n.links) push(linkedFrom, t, n.id);
  }
  return { children, linkedFrom };
}

/** The contributors that count toward a node's rollup: active primary children plus active linked nodes. */
export function activeInputs(u: Universe, idx: ContributorIndex, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const cid of [...(idx.children.get(id) ?? []), ...(idx.linkedFrom.get(id) ?? [])]) {
    if (seen.has(cid)) continue;
    seen.add(cid);
    if (u.nodes.get(cid)?.lifecycle === 'active') out.push(cid);
  }
  return out;
}

/** Whether `from` already contributes, directly or transitively, to `to`. Used to refuse cycles. */
export function contributesTo(u: Universe, from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const x = stack.pop()!;
    if (x === to) return true;
    if (seen.has(x)) continue;
    seen.add(x);
    const n = u.nodes.get(x);
    if (!n) continue;
    if (n.parentId) stack.push(n.parentId);
    stack.push(...n.links);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Rollup
// ---------------------------------------------------------------------------

interface Input {
  id: string;
  title: string;
  status: Status;
  weight: number;
  critical: boolean;
}

const STATUS_WORDS: Record<Status, string> = { ok: 'on target', warn: 'warning', breach: 'in breach', unknown: 'unknown' };
const SCORE: Record<KnownStatus, number> = { ok: 1, warn: 0.5, breach: 0 };

function emptyCounts(): Record<Status, number> {
  return Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
}

/** "3 inputs: 1 in breach, 2 on target" */
function countsPhrase(counts: Record<Status, number>, total: number): string {
  const order: Status[] = ['breach', 'warn', 'unknown', 'ok'];
  const parts = order.filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${STATUS_WORDS[s]}`);
  return `${total} input${total === 1 ? '' : 's'}: ${parts.join(', ')}`;
}

/** Inputs with the given status, heaviest first. */
function withStatus(inputs: Input[], statuses: Status[]): string[] {
  return inputs
    .filter((i) => statuses.includes(i.status))
    .sort((a, b) => SEVERITY[b.status] - SEVERITY[a.status] || b.weight - a.weight)
    .map((i) => i.id);
}

export function rollup(rule: RollupRule, inputs: Input[]): Pick<Evaluation, 'status' | 'reason' | 'drivers' | 'score'> {
  const counts = emptyCounts();
  for (const i of inputs) counts[i.status]++;
  const n = inputs.length;
  const tally = countsPhrase(counts, n);

  if (rule.strategy === 'worst') {
    const status = inputs.reduce<Status>((w, i) => (SEVERITY[i.status] > SEVERITY[w] ? i.status : w), 'ok');
    const reason = status === 'ok' ? (n === 1 ? 'Its only input is on target' : `All ${n} inputs on target`) : `Worst of ${tally}`;
    return { status, reason, drivers: status === 'ok' ? [] : withStatus(inputs, [status]), score: null };
  }

  if (rule.strategy === 'weighted') {
    const vetoes = inputs.filter((i) => i.critical && i.status === 'breach');
    const known = inputs.filter((i): i is Input & { status: KnownStatus } => i.status !== 'unknown');
    const totalW = known.reduce((s, i) => s + i.weight, 0);
    const score = totalW > 0 ? known.reduce((s, i) => s + i.weight * SCORE[i.status], 0) / totalW : null;
    if (vetoes.length > 0) {
      return { status: 'breach', reason: `A critical input is in breach, which overrides the weighted score (${tally})`, drivers: vetoes.map((i) => i.id), score };
    }
    if (score === null) {
      return { status: 'unknown', reason: `Nothing measurable yet (${tally})`, drivers: withStatus(inputs, ['unknown']), score };
    }
    const byScore: KnownStatus = score >= rule.okAt ? 'ok' : score >= rule.warnAt ? 'warn' : 'breach';
    const pctText = `Weighted score ${Math.round(score * 100)}%`;
    if (byScore === 'ok' && counts.unknown > 0) {
      return { status: 'unknown', reason: `${pctText}, but ${counts.unknown} input${counts.unknown === 1 ? ' is' : 's are'} unmeasured — unknown never rolls up as green`, drivers: withStatus(inputs, ['unknown']), score };
    }
    return { status: byScore, reason: `${pctText} across ${tally}`, drivers: byScore === 'ok' ? [] : withStatus(inputs, ['breach', 'warn']), score };
  }

  // quorum
  const share = (c: number) => (n === 0 ? 0 : c / n);
  const ok = counts.ok;
  const okText = `${ok} of ${n} input${n === 1 ? '' : 's'} on target; quorum needs ${Math.round(rule.okShare * 100)}%`;
  if (share(ok) >= rule.okShare) return { status: 'ok', reason: okText, drivers: [], score: null };
  if (share(ok + counts.unknown) >= rule.okShare) {
    return { status: 'unknown', reason: `${okText} — undecided until the unknown inputs are measured`, drivers: withStatus(inputs, ['unknown']), score: null };
  }
  if (share(ok + counts.warn) >= rule.warnShare) {
    return { status: 'warn', reason: okText, drivers: withStatus(inputs, ['breach', 'warn']), score: null };
  }
  if (share(ok + counts.warn + counts.unknown) >= rule.warnShare) {
    return { status: 'unknown', reason: `${okText} — undecided until the unknown inputs are measured`, drivers: withStatus(inputs, ['unknown']), score: null };
  }
  return { status: 'breach', reason: okText, drivers: withStatus(inputs, ['breach', 'warn']), score: null };
}

/**
 * Evaluates every node at `asOf`. A node's inputs are its own measure (if it
 * has one) plus its active contributors. A node with no inputs at all is a
 * legitimate stub of iterative refinement, and is reported as unknown rather
 * than hidden or assumed fine.
 */
export function evaluateUniverse(u: Universe, asOf: string): Map<string, Evaluation> {
  const idx = indexContributors(u);
  const memo = new Map<string, Evaluation>();
  const leaves = new Map<string, Map<string, boolean>>();
  const visiting = new Set<string>();

  const evalNode = (id: string): Evaluation => {
    const hit = memo.get(id);
    if (hit) return hit;
    const n = u.nodes.get(id)!;
    if (visiting.has(id)) {
      // Unreachable while `decide` refuses cycles; kept so a hand-edited log cannot hang the server.
      return { status: 'unknown', reason: 'Cycle in the contribution graph', drivers: [], coverage: { measured: 0, total: 1 }, score: null, measurement: null, counts: emptyCounts(), inputCount: 0 };
    }
    visiting.add(id);

    const measurement = evaluateMeasure(u, n, asOf);
    const inputs: Input[] = [];
    const myLeaves = new Map<string, boolean>();
    if (measurement) {
      inputs.push({ id, title: n.title, status: measurement.status, weight: PRIORITY_WEIGHT[n.priority], critical: n.priority === 'critical' });
      myLeaves.set(id, measurement.status !== 'unknown');
    }
    for (const cid of activeInputs(u, idx, id)) {
      const c = u.nodes.get(cid)!;
      const ce = evalNode(cid);
      inputs.push({ id: cid, title: c.title, status: ce.status, weight: PRIORITY_WEIGHT[c.priority], critical: c.priority === 'critical' });
      for (const [lid, measured] of leaves.get(cid) ?? []) myLeaves.set(lid, measured);
    }
    if (myLeaves.size === 0) myLeaves.set(id, false);
    leaves.set(id, myLeaves);

    const counts = emptyCounts();
    for (const i of inputs) counts[i.status]++;
    const coverage = { measured: [...myLeaves.values()].filter(Boolean).length, total: myLeaves.size };

    let result: Evaluation;
    if (inputs.length === 0) {
      const reason = n.kind === 'kpi' || n.kind === 'scenario'
        ? 'No measure defined yet — define how this is checked'
        : 'Not refined yet — add requirements, KPIs or scenarios beneath it';
      result = { status: 'unknown', reason, drivers: [], coverage, score: null, measurement, counts, inputCount: 0 };
    } else if (inputs.length === 1 && measurement) {
      // A pure measured node: its status is its measurement.
      result = { status: measurement.status, reason: measurement.reason, drivers: measurement.status === 'ok' ? [] : [id], coverage, score: null, measurement, counts, inputCount: 1 };
    } else {
      const r = rollup(definitionAt(n, asOf).rollup, inputs);
      result = { ...r, coverage, measurement, counts, inputCount: inputs.length };
    }
    visiting.delete(id);
    memo.set(id, result);
    return result;
  };

  for (const id of u.nodes.keys()) evalNode(id);
  return memo;
}

/**
 * Follows the first driver from `id` down to where the signal originates —
 * "why is this red?" answered as a path, one level of disclosure per step.
 */
export function signalPath(evals: Map<string, Evaluation>, id: string, maxDepth = 12): string[] {
  const path: string[] = [];
  let cur = id;
  for (let i = 0; i < maxDepth; i++) {
    const e = evals.get(cur);
    const next = e?.drivers.find((d) => d !== cur);
    if (!e || !next || path.includes(next)) break;
    path.push(next);
    cur = next;
  }
  return path;
}
