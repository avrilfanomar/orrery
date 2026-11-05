// The rollup rules, checked over every input they can meet (ADR 0009). A person
// acts on a green they see; these properties are what keeps it earned. Each is
// checked for every rule in a grid that includes the edges (0 and 1), on every
// multiset of up to four inputs drawn from each status at each priority.
import { describe, expect, it } from 'vitest';
import {
  PRIORITIES,
  PRIORITY_WEIGHT,
  STATUSES,
  applyEvent,
  checkLogEntry,
  emptyUniverse,
  evaluateUniverse,
  parseCommand,
  rollup,
  type RuEvent,
  type KnownStatus,
  type Priority,
  type RollupRule,
  type Status,
} from '../src/index.js';
import { makeLog, pctHigher } from './helpers.js';

interface In {
  status: Status;
  priority: Priority;
}

const KNOWN: KnownStatus[] = ['ok', 'warn', 'breach'];
const RANK: Record<KnownStatus, number> = { ok: 0, warn: 1, breach: 2 };

const OPTIONS: In[] = STATUSES.flatMap((status) => PRIORITIES.map((priority) => ({ status, priority })));

/** Every multiset of up to `max` inputs: the rules do not depend on the order of their inputs. */
function multisets(max: number): In[][] {
  const out: In[][] = [[]];
  const grow = (prefix: In[], from: number) => {
    if (prefix.length === max) return;
    for (let i = from; i < OPTIONS.length; i++) {
      const next = [...prefix, OPTIONS[i]!];
      out.push(next);
      grow(next, i);
    }
  };
  grow([], 0);
  return out;
}

const SETS = multisets(4);

const RULES: RollupRule[] = [{ strategy: 'worst' }];
for (const okAt of [0, 0.5, 0.9, 1]) {
  for (const warnAt of [0, 0.25, 0.5, 0.6, 0.9, 1]) if (warnAt <= okAt) RULES.push({ strategy: 'weighted', okAt, warnAt });
}
for (const okShare of [0.25, 0.5, 0.75, 1]) {
  for (const warnShare of [0, 0.25, 0.5, 0.75, 1]) if (warnShare <= okShare) RULES.push({ strategy: 'quorum', okShare, warnShare });
}

const label = (r: RollupRule) => (r.strategy === 'weighted' ? `weighted ${r.okAt}/${r.warnAt}` : r.strategy === 'quorum' ? `quorum ${r.okShare}/${r.warnShare}` : 'worst');
const show = (set: In[]) => `[${set.map((i) => `${i.status}:${i.priority}`).join(', ')}]`;

function run(rule: RollupRule, set: In[]): Status {
  return rollup(
    rule,
    set.map((i, k) => ({ id: `i${k}`, title: `Input ${k}`, status: i.status, weight: PRIORITY_WEIGHT[i.priority], critical: i.priority === 'critical' })),
  ).status;
}

/** Whether a caller may set this rule (the stored-event schema is wider, so old logs keep loading). */
function settable(rule: RollupRule): boolean {
  try {
    parseCommand({ type: 'node.create', data: { kind: 'goal', title: 'G', rollup: rule } });
    return true;
  } catch {
    return false;
  }
}

/** Every way the unknown inputs of `set` could turn out once measured. */
function resolutions(set: In[]): In[][] {
  let out: In[][] = [[]];
  for (const i of set) {
    const options = i.status === 'unknown' ? KNOWN : [i.status];
    out = out.flatMap((prefix) => options.map((status) => [...prefix, { ...i, status }]));
  }
  return out;
}

/** Collects counterexamples instead of failing on the first, so a failure shows its pattern. */
function violations(check: (rule: RollupRule, set: In[]) => string | null, rules = RULES): string[] {
  const found: string[] = [];
  for (const rule of rules) {
    for (const set of SETS) {
      const problem = check(rule, set);
      if (problem && found.length < 5) found.push(`${label(rule)} ${show(set)}: ${problem}`);
    }
  }
  return found;
}

describe('rollup rules, checked over every input', () => {
  it('covers the grid it claims', () => {
    expect(SETS).toHaveLength(4845);
    expect(RULES).toHaveLength(30);
  });

  it('reads unknown with no inputs at all, under every rule', () => {
    expect(violations((rule, set) => (set.length === 0 && run(rule, set) !== 'unknown' ? `reads ${run(rule, set)}` : null))).toEqual([]);
  });

  it('keeps a green however its unknown inputs turn out', () => {
    const problems = violations((rule, set) => {
      if (!set.some((i) => i.status === 'unknown') || run(rule, set) !== 'ok') return null;
      const flips = resolutions(set).find((r) => run(rule, r) !== 'ok');
      return flips ? `reads ok, but ${run(rule, flips)} once measured as ${show(flips)}` : null;
    });
    expect(problems).toEqual([]);
  });

  it('never reads better when one input reads worse', () => {
    const problems = violations((rule, set) => {
      if (set.length === 0 || set.some((i) => i.status === 'unknown')) return null;
      const before = run(rule, set);
      if (before === 'unknown') return 'reads unknown although every input is measured';
      for (const [k, i] of set.entries()) {
        for (const worse of KNOWN.filter((s) => RANK[s] > RANK[i.status as KnownStatus])) {
          const after = run(rule, set.map((x, j) => (j === k ? { ...x, status: worse } : x)));
          if (after === 'unknown' || RANK[after] < RANK[before]) return `reads ${before}, then ${after} when input ${k} becomes ${worse}`;
        }
      }
      return null;
    });
    expect(problems).toEqual([]);
  });

  it('reads breach when a critical input is in breach, under every rule', () => {
    expect(violations((rule, set) => (set.some((i) => i.priority === 'critical' && i.status === 'breach') && run(rule, set) !== 'breach' ? `reads ${run(rule, set)}` : null))).toEqual([]);
  });

  it('reads on target when every input is, and breach when every input is, under every rule a caller can set', () => {
    const accepted = RULES.filter(settable);
    const problems = violations((rule, set) => {
      if (set.length === 0) return null;
      for (const s of ['ok', 'breach'] as const) {
        if (set.every((i) => i.status === s) && run(rule, set) !== s) return `every input reads ${s}, it reads ${run(rule, set)}`;
      }
      return null;
    }, accepted);
    expect(problems).toEqual([]);
  });

  it('refuses exactly the rules that could never read breach, and only from callers', () => {
    const cannotBreach = (rule: RollupRule) => SETS.some((set) => set.length > 0 && set.every((i) => i.status === 'breach') && run(rule, set) !== 'breach');
    expect(RULES.filter((r) => settable(r) === cannotBreach(r)).map(label)).toEqual([]);
    expect(() => parseCommand({ type: 'node.create', data: { kind: 'goal', title: 'G', rollup: { strategy: 'quorum', okShare: 0.5, warnShare: 0 } } })).toThrow(/never read breach/);
  });
});

describe('evidence it does not have never reads green', () => {
  it('reads nodes that feed each other, in a hand-edited log, as unknown', () => {
    // decide refuses the cycle, but the log contract checks events, not the graph, so a log can still hold one.
    const at = '2026-01-01T00:00:00.000Z';
    const node = (id: string, parentId: string | null) => ({ id, kind: 'requirement', title: id, description: '', parentId, links: [], priority: 'medium', dimensions: [], owner: null, measure: null, rollup: { strategy: 'worst' }, scenario: null, reason: null });
    const raw = [
      { seq: 1, at, actor: 'hand', type: 'node.created', data: node('a', null) },
      { seq: 2, at, actor: 'hand', type: 'node.created', data: node('b', 'a') },
      { seq: 3, at, actor: 'hand', type: 'node.linked', data: { id: 'a', target: 'b', reason: 'edited by hand' } },
    ];
    const u = emptyUniverse();
    let prev: RuEvent | undefined;
    for (const e of raw) {
      const r = checkLogEntry(e, prev);
      expect(r.ok).toBe(true);
      if (r.ok) applyEvent(u, (prev = r.event));
    }
    const evals = evaluateUniverse(u, at);
    expect([evals.get('a')!.status, evals.get('b')!.status]).toEqual(['unknown', 'unknown']);
  });

  it('judges a moment by the readings taken by then, even when it holds later ones', () => {
    const log = makeLog('2026-03-01T00:00:00.000Z');
    log.run({ type: 'node.create', data: { id: 'k', kind: 'kpi', title: 'K', measure: pctHigher(90, 80) } });
    log.run({ type: 'reading.record', data: { nodeId: 'k', value: 50 } });
    const between = log.now();
    log.advanceHours(1);
    log.run({ type: 'reading.record', data: { nodeId: 'k', value: 95 } });
    expect(evaluateUniverse(log.u, between).get('k')!.status).toBe('breach');
    expect(evaluateUniverse(log.u, '2026-02-28T23:00:00.000Z').get('k')!.reason).toMatch(/Never measured/);
  });
});
