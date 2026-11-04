// Folding the append-only log into state. Projecting to an earlier `asOf`
// is how time travel works: the model *as it was known then*, including the
// targets and priorities in force at that moment.
import { KIND_LABELS } from './constants.js';
import { formatThreshold, formatValue, shortRollup } from './format.js';
import type { Definition, NodeState, Reading, Universe } from './model.js';
import type { RuEvent } from './schema.js';

export function emptyUniverse(): Universe {
  return {
    asOf: null,
    nodes: new Map(),
    readings: new Map(),
    timeline: [],
    lastSeq: 0,
    firstAt: null,
    lastAt: null,
    readingCount: 0,
  };
}

/**
 * Projects the log up to and including `asOf`. The store guarantees events are
 * ordered by `at` (it never stamps an event earlier than its predecessor), so
 * the fold can stop at the first event past the horizon.
 */
export function project(events: readonly RuEvent[], asOf?: string | null): Universe {
  const u = emptyUniverse();
  u.asOf = asOf ?? null;
  for (const e of events) {
    if (asOf && e.at > asOf) break;
    applyEvent(u, e);
  }
  return u;
}

function titleOf(u: Universe, id: string | null): string {
  if (!id) return 'the top level';
  return u.nodes.get(id)?.title ?? id;
}

/** Inserts keeping ascending `observedAt` order; late, back-dated readings land in place. */
function insertReading(list: Reading[], r: Reading): void {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid]!.observedAt <= r.observedAt) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, r);
}

function describeBinding(b: { sourceId: string | null; language: string }): string {
  return b.sourceId ? `a ${b.language} query on ${b.sourceId}` : `a documented ${b.language} query`;
}

export function diffDefinitions(prev: Definition, next: Definition): string[] {
  const parts: string[] = [];
  const a = prev.measure;
  const b = next.measure;
  if (!a && b) parts.push(`measure defined — target ${formatThreshold(b, 'target')}`);
  else if (a && !b) parts.push('measure removed');
  else if (a && b) {
    if (a.unit !== b.unit || a.direction !== b.direction || a.target !== b.target) {
      parts.push(`target ${formatThreshold(a, 'target')} → ${formatThreshold(b, 'target')}`);
    }
    if (a.unit !== b.unit || a.direction !== b.direction || a.warn !== b.warn) {
      parts.push(`warning ${formatThreshold(a, 'warn')} → ${formatThreshold(b, 'warn')}`);
    }
    if (a.staleAfterHours !== b.staleAfterHours) {
      parts.push(`stale after ${a.staleAfterHours} h → ${b.staleAfterHours} h`);
    }
  }
  if (JSON.stringify(prev.rollup) !== JSON.stringify(next.rollup)) {
    parts.push(`rollup ${shortRollup(prev.rollup)} → ${shortRollup(next.rollup)}`);
  }
  const a1 = prev.binding;
  const b1 = next.binding;
  if (!a1 && b1) parts.push(`bound to ${describeBinding(b1)}`);
  else if (a1 && !b1) parts.push('binding removed');
  else if (a1 && b1) {
    if (a1.language !== b1.language || a1.query !== b1.query) parts.push('query revised');
    if (a1.sourceId !== b1.sourceId) parts.push(`source ${a1.sourceId ?? 'none'} → ${b1.sourceId ?? 'none'}`);
  }
  if (JSON.stringify(prev.scenario) !== JSON.stringify(next.scenario)) {
    parts.push(next.scenario ? 'scenario wording revised' : 'scenario removed');
  }
  return parts;
}

export function applyEvent(u: Universe, e: RuEvent): void {
  u.lastSeq = e.seq;
  u.firstAt ??= e.at;
  u.lastAt = e.at;

  if (e.type === 'reading.recorded') {
    const r: Reading = { ...e.data };
    let list = u.readings.get(r.nodeId);
    if (!list) u.readings.set(r.nodeId, (list = []));
    insertReading(list, r);
    u.readingCount++;
    return;
  }

  const entry = (nodeId: string, summary: string, reason: string | null, relatedIds: string[] = []) =>
    u.timeline.push({ seq: e.seq, at: e.at, actor: e.actor, type: e.type, nodeId, relatedIds, summary, reason });

  switch (e.type) {
    case 'node.created': {
      const d = e.data;
      const node: NodeState = {
        id: d.id,
        kind: d.kind,
        title: d.title,
        description: d.description,
        parentId: d.parentId,
        links: [...d.links],
        priority: d.priority,
        dimensions: [...d.dimensions],
        owner: d.owner,
        dashboardUrl: d.dashboardUrl ?? null,
        lifecycle: 'active',
        createdAt: e.at,
        updatedAt: e.at,
        definitions: [
          {
            version: 1,
            effectiveFrom: e.at,
            measure: d.measure,
            rollup: d.rollup,
            scenario: d.scenario,
            binding: d.binding ?? null,
            reason: d.reason,
          },
        ],
      };
      u.nodes.set(d.id, node);
      const where = d.parentId ? ` under “${titleOf(u, d.parentId)}”` : '';
      entry(d.id, `Created ${KIND_LABELS[d.kind].toLowerCase()} “${d.title}”${where}`, d.reason, [
        ...(d.parentId ? [d.parentId] : []),
        ...d.links,
      ]);
      return;
    }
    case 'node.edited': {
      const n = u.nodes.get(e.data.id);
      if (!n) return;
      const { id: _id, ...changes } = e.data;
      const oldTitle = n.title;
      const fields = Object.keys(changes).filter((k) => changes[k as keyof typeof changes] !== undefined);
      if (changes.title !== undefined) n.title = changes.title;
      if (changes.description !== undefined) n.description = changes.description;
      if (changes.owner !== undefined) n.owner = changes.owner;
      if (changes.dimensions !== undefined) n.dimensions = [...changes.dimensions];
      if (changes.dashboardUrl !== undefined) n.dashboardUrl = changes.dashboardUrl;
      n.updatedAt = e.at;
      const summary =
        changes.title !== undefined && changes.title !== oldTitle
          ? `Renamed “${oldTitle}” to “${n.title}”`
          : `Edited ${fields.join(', ')} of “${n.title}”`;
      entry(n.id, summary, null);
      return;
    }
    case 'node.redefined': {
      const n = u.nodes.get(e.data.id);
      if (!n) return;
      const prev = n.definitions[n.definitions.length - 1]!;
      const next: Definition = {
        version: prev.version + 1,
        effectiveFrom: e.at,
        measure: e.data.measure !== undefined ? e.data.measure : prev.measure,
        rollup: e.data.rollup ?? prev.rollup,
        scenario: e.data.scenario !== undefined ? e.data.scenario : prev.scenario,
        binding: e.data.binding !== undefined ? e.data.binding : prev.binding,
        reason: e.data.reason,
      };
      n.definitions.push(next);
      n.updatedAt = e.at;
      const diff = diffDefinitions(prev, next);
      entry(n.id, `Revised “${n.title}” to v${next.version}: ${diff.join('; ') || 'no effective change'}`, e.data.reason);
      return;
    }
    case 'node.reprioritized': {
      const n = u.nodes.get(e.data.id);
      if (!n) return;
      const old = n.priority;
      n.priority = e.data.priority;
      n.updatedAt = e.at;
      entry(n.id, `Priority of “${n.title}”: ${old} → ${n.priority}`, e.data.reason);
      return;
    }
    case 'node.moved': {
      const n = u.nodes.get(e.data.id);
      if (!n) return;
      const from = n.parentId;
      n.parentId = e.data.parentId;
      n.updatedAt = e.at;
      entry(n.id, `Moved “${n.title}” from “${titleOf(u, from)}” to “${titleOf(u, n.parentId)}”`, e.data.reason, [
        ...(from ? [from] : []),
        ...(n.parentId ? [n.parentId] : []),
      ]);
      return;
    }
    case 'node.linked': {
      const n = u.nodes.get(e.data.id);
      if (!n) return;
      if (!n.links.includes(e.data.target)) n.links.push(e.data.target);
      n.updatedAt = e.at;
      entry(n.id, `“${n.title}” now also contributes to “${titleOf(u, e.data.target)}”`, e.data.reason, [e.data.target]);
      return;
    }
    case 'node.unlinked': {
      const n = u.nodes.get(e.data.id);
      if (!n) return;
      n.links = n.links.filter((t) => t !== e.data.target);
      n.updatedAt = e.at;
      entry(n.id, `“${n.title}” no longer contributes to “${titleOf(u, e.data.target)}”`, e.data.reason, [e.data.target]);
      return;
    }
    case 'node.deprecated':
    case 'node.reactivated': {
      const n = u.nodes.get(e.data.id);
      if (!n) return;
      n.lifecycle = e.type === 'node.deprecated' ? 'deprecated' : 'active';
      n.updatedAt = e.at;
      entry(n.id, `${e.type === 'node.deprecated' ? 'Deprecated' : 'Reactivated'} “${n.title}”`, e.data.reason, [
        ...(n.parentId ? [n.parentId] : []),
      ]);
      return;
    }
  }
}

/** A short line for a reading, used by feeds and tooltips. */
export function describeReading(u: Universe, r: Reading): string {
  const n = u.nodes.get(r.nodeId);
  const unit = n?.definitions[n.definitions.length - 1]?.measure?.unit ?? '';
  return `${n?.title ?? r.nodeId}: ${formatValue(r.value, unit)} (${r.source})`;
}
