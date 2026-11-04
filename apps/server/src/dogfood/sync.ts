// Definitions as code (ADR 0003): the dogfood model lives in model.ts, the log
// keeps its history. `planSync` diffs the two into ordinary commands, which go
// through `decide` like any other change — so editing the model is evolution,
// with a reason wherever the domain demands one, never a rewrite of the past.
import {
  parseCommand,
  type Binding,
  type CommandInput,
  type Dimension,
  type Lifecycle,
  type MeasureSpec,
  type NodeKind,
  type Priority,
  type RollupRule,
  type ScenarioSpec,
  type UniverseView,
} from '@ru/core';
import type { ModelNode } from './model.js';

/** What the planner needs to know about a probe; the measuring part stays in probes.ts. */
export interface ProbeSpec {
  id: string;
  /** Bump when the method changes in a way that changes the number; it is part of the binding's query. */
  version: number;
  /** Why this version exists — the reason a node is redefined onto it with. */
  since: string;
  /** How the number is made, for people. Rewording it is a plain edit. */
  method: string;
}

/** The binding's query for a probe: an identifier, never prose, because comparability keys on the exact string. */
export const probeQuery = (p: Pick<ProbeSpec, 'id' | 'version'>) => `${p.id}@${p.version}`;

/** A node as it stands in the log, from the API's view or a projection. */
export interface CurrentNode {
  id: string;
  kind: NodeKind;
  title: string;
  description: string;
  parentId: string | null;
  links: string[];
  priority: Priority;
  dimensions: Dimension[];
  owner: string | null;
  dashboardUrl: string | null;
  lifecycle: Lifecycle;
  definition: { measure: MeasureSpec | null; rollup: RollupRule; scenario: ScenarioSpec | null; binding: Binding | null };
}

export const currentFromView = (view: UniverseView): Map<string, CurrentNode> => new Map(Object.entries(view.nodes));

export interface PlannedChange {
  cmd: CommandInput;
  summary: string;
  needsReason: boolean;
  /** A reason the change carries by itself (a probe's `since`), used when the caller gives none. */
  defaultReason: string | null;
}

type Desired = Extract<ReturnType<typeof parseCommand>, { type: 'node.create' }>['data'] & { id: string };

/** Key-order-independent equality, so a reordered literal never creates a spurious definition version. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}
const same = (a: unknown, b: unknown) => stable(a) === stable(b);

export function describeWithMethod(description: string, probe: ProbeSpec | undefined): string {
  if (!probe) return description;
  return `${description}${description ? '\n\n' : ''}How it is measured (${probeQuery(probe)}): ${probe.method}`;
}

function desiredOf(node: ModelNode, probes: ReadonlyMap<string, ProbeSpec>): Desired {
  const { probe: probeId, ...rest } = node;
  const probe = probeId ? probes.get(probeId) : undefined;
  if (probeId && !probe) throw new Error(`model: “${node.id}” names probe “${probeId}”, which is not in the registry`);
  const binding = probe ? { sourceId: null, language: 'probe' as const, query: probeQuery(probe) } : null;
  const cmd = parseCommand({ type: 'node.create', data: { ...rest, description: describeWithMethod(node.description ?? '', probe), binding } });
  if (cmd.type !== 'node.create') throw new Error('unreachable');
  return { ...cmd.data, id: node.id };
}

/** Creation order: a node after its parent and its link targets, when those are new too. */
function creationOrder(missing: Desired[]): Desired[] {
  const byId = new Map(missing.map((d) => [d.id, d]));
  const done = new Set<string>();
  const out: Desired[] = [];
  const visit = (d: Desired, path: Set<string>) => {
    if (done.has(d.id)) return;
    if (path.has(d.id)) throw new Error(`model: “${d.id}” contributes to itself`);
    path.add(d.id);
    for (const dep of [d.parentId, ...d.links]) {
      const nd = dep ? byId.get(dep) : undefined;
      if (nd) visit(nd, path);
    }
    path.delete(d.id);
    done.add(d.id);
    out.push(d);
  };
  missing.forEach((d) => visit(d, new Set()));
  return out;
}

/**
 * The commands that bring the log in line with the model, in an order `decide`
 * accepts: reactivations, creations, edits, unlinks, moves, links,
 * redefinitions, priorities, deprecations. Pure; applying it is the caller's job.
 */
export function planSync(model: readonly ModelNode[], current: ReadonlyMap<string, CurrentNode>, probes: ReadonlyMap<string, ProbeSpec>): PlannedChange[] {
  const seen = new Set<string>();
  for (const n of model) {
    if (seen.has(n.id)) throw new Error(`model: duplicate id “${n.id}”`);
    seen.add(n.id);
  }
  const desired = model.map((n) => desiredOf(n, probes));
  const probeOf = new Map(model.filter((n) => n.probe).map((n) => [n.id, probes.get(n.probe!)!]));

  const buckets = {
    reactivate: [] as PlannedChange[],
    create: [] as PlannedChange[],
    edit: [] as PlannedChange[],
    unlink: [] as PlannedChange[],
    move: [] as PlannedChange[],
    link: [] as PlannedChange[],
    redefine: [] as PlannedChange[],
    reprioritize: [] as PlannedChange[],
    deprecate: [] as PlannedChange[],
  };
  const change = (cmd: CommandInput, summary: string, needsReason = true, defaultReason: string | null = null): PlannedChange => ({ cmd, summary, needsReason, defaultReason });

  const missing = desired.filter((d) => !current.has(d.id));
  for (const d of creationOrder(missing)) {
    buckets.create.push(change({ type: 'node.create', data: d }, `create ${d.kind} “${d.title}”`, false));
  }

  for (const d of desired) {
    const c = current.get(d.id);
    if (!c) continue;
    if (c.kind !== d.kind) {
      throw new Error(`model: “${d.id}” is a ${c.kind} in the log and a ${d.kind} in the model — a kind never changes; deprecate it and add a new id`);
    }
    if (c.lifecycle === 'deprecated') buckets.reactivate.push(change({ type: 'node.reactivate', data: { id: d.id, reason: '' } }, `reactivate “${d.title}”`));

    const edits = Object.fromEntries(
      (['title', 'description', 'owner', 'dimensions', 'dashboardUrl'] as const).filter((k) => !same(d[k], c[k])).map((k) => [k, d[k]]),
    );
    if (Object.keys(edits).length) buckets.edit.push(change({ type: 'node.edit', data: { id: d.id, ...edits } }, `edit “${d.title}” (${Object.keys(edits).join(', ')})`, false));

    const want = new Set(d.links);
    const have = new Set(c.links);
    for (const t of have) if (!want.has(t)) buckets.unlink.push(change({ type: 'node.unlink', data: { id: d.id, target: t, reason: '' } }, `unlink “${d.title}” from ${t}`));
    if (d.parentId !== c.parentId) buckets.move.push(change({ type: 'node.move', data: { id: d.id, parentId: d.parentId, reason: '' } }, `move “${d.title}” under ${d.parentId ?? 'the top'}`));
    for (const t of want) if (!have.has(t)) buckets.link.push(change({ type: 'node.link', data: { id: d.id, target: t, reason: '' } }, `link “${d.title}” to ${t}`));

    const fields = (['measure', 'rollup', 'scenario', 'binding'] as const).filter((k) => !same(d[k], c.definition[k]));
    if (fields.length) {
      const probe = probeOf.get(d.id);
      // A move onto a new probe version explains itself; anything else needs the author's why.
      const own = fields.length === 1 && fields[0] === 'binding' && probe && d.binding ? probe.since : null;
      buckets.redefine.push(
        change({ type: 'node.redefine', data: { id: d.id, ...Object.fromEntries(fields.map((k) => [k, d[k]])), reason: '' } }, `redefine “${d.title}” (${fields.join(', ')})`, true, own),
      );
    }
    if (d.priority !== c.priority) buckets.reprioritize.push(change({ type: 'node.reprioritize', data: { id: d.id, priority: d.priority, reason: '' } }, `reprioritize “${d.title}” ${c.priority} → ${d.priority}`));
  }

  for (const c of current.values()) {
    if (!seen.has(c.id) && c.lifecycle === 'active') buckets.deprecate.push(change({ type: 'node.deprecate', data: { id: c.id, reason: '' } }, `deprecate “${c.title}” (no longer in the model)`));
  }

  return Object.values(buckets).flat();
}

export class ReasonRequired extends Error {
  constructor(
    readonly changes: PlannedChange[],
    note = 'pass --reason "…", or commit the model and let its commit subject explain them',
  ) {
    super(`These changes need a reason — ${note}:\n` + changes.map((c) => `  · ${c.summary}`).join('\n'));
    this.name = 'ReasonRequired';
  }
}

/**
 * Fills in reasons: the caller's explicit one first, then a change's own (a
 * probe's `since`), then the fallback (the model's last commit subject).
 * Refuses the whole plan if any change would go without one.
 */
export function resolveReasons(plan: readonly PlannedChange[], reasons: { explicit?: string | null; fallback?: string | null; note?: string }): CommandInput[] {
  const missing: PlannedChange[] = [];
  const out = plan.map((p) => {
    if (!p.needsReason) return p.cmd;
    const reason = reasons.explicit?.trim() || p.defaultReason || reasons.fallback?.trim() || '';
    if (reason.length < 3) missing.push(p);
    return { ...p.cmd, data: { ...p.cmd.data, reason } } as CommandInput;
  });
  if (missing.length) throw new ReasonRequired(missing, reasons.note);
  return out;
}
