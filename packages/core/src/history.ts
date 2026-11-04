// Looking back: status over time and reading series, each judged against the
// definition that was in force at the time — never repainted by later edits.
import type { KnownStatus, Status } from './constants.js';
import { evaluateUniverse, judge, yardstickAt } from './evaluate.js';
import type { NodeState, Universe } from './model.js';
import { applyEvent, emptyUniverse } from './project.js';
import type { RuEvent } from './schema.js';

export interface SeriesPoint {
  t: string;
  v: number;
  /** Judged against the definition version in force when the reading was observed. */
  s: KnownStatus;
  version: number;
}

/**
 * Readings of one node between `from` and `to`. Above `maxPoints` the series
 * is bucketed and each bucket keeps its *worst* reading, so a short incident
 * survives downsampling instead of being averaged away.
 */
export function readingSeries(u: Universe, n: NodeState, from: string, to: string, maxPoints = 240): SeriesPoint[] {
  const all = (u.readings.get(n.id) ?? []).filter((r) => r.observedAt >= from && r.observedAt <= to);
  const points: SeriesPoint[] = [];
  for (const r of all) {
    const def = yardstickAt(n, r.observedAt);
    if (!def?.measure) continue;
    points.push({ t: r.observedAt, v: r.value, s: judge(r.value, def.measure), version: def.version });
  }
  if (points.length <= maxPoints) return points;

  const t0 = Date.parse(from);
  const span = Math.max(1, Date.parse(to) - t0);
  const buckets = new Map<number, SeriesPoint>();
  for (const p of points) {
    const b = Math.min(maxPoints - 1, Math.floor(((Date.parse(p.t) - t0) / span) * maxPoints));
    const cur = buckets.get(b);
    if (!cur || worse(p, cur, n)) buckets.set(b, p);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);
}

const RANK: Record<KnownStatus, number> = { ok: 0, warn: 1, breach: 2 };

function worse(a: SeriesPoint, b: SeriesPoint, n: NodeState): boolean {
  if (RANK[a.s] !== RANK[b.s]) return RANK[a.s] > RANK[b.s];
  const dir = yardstickAt(n, a.t)?.measure?.direction ?? 'higher';
  return dir === 'higher' ? a.v < b.v : a.v > b.v;
}

/**
 * The status of every node at each of `times` (ascending), folding the log
 * once. `null` marks a moment before the node existed.
 */
export function statusHistory(events: readonly RuEvent[], times: readonly string[]): Map<string, (Status | null)[]> {
  const u = emptyUniverse();
  const out = new Map<string, (Status | null)[]>();
  let i = 0;
  times.forEach((t, k) => {
    while (i < events.length && events[i]!.at <= t) applyEvent(u, events[i++]!);
    u.asOf = t;
    for (const [id, e] of evaluateUniverse(u, t)) {
      let row = out.get(id);
      if (!row) out.set(id, (row = new Array<Status | null>(times.length).fill(null)));
      row[k] = u.nodes.get(id)?.lifecycle === 'deprecated' ? null : e.status;
    }
  });
  return out;
}

/** The history lines that concern a node: its own changes and changes that point at it. */
export function timelineFor(u: Universe, id: string) {
  return u.timeline.filter((e) => e.nodeId === id || e.relatedIds.includes(id));
}
