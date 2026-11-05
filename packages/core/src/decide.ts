// Commands in, events out. Every rule that protects the model's integrity
// lives here, so the API, the seed and any future importer share one gate.
import { ZodError } from 'zod';
import { PASS_FAIL_UNIT, PULL_SOURCE_PREFIX } from './constants.js';
import { bindingSince, currentDefinition, contributesTo } from './evaluate.js';
import { isCanonicalInstant } from './log.js';
import type { NodeState, Universe } from './model.js';
import { CommandSchema, type Binding, type Command, type MeasureSpec, type NewEvent } from './schema.js';

export type DomainErrorCode = 'invalid' | 'not_found' | 'conflict';

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

/**
 * The sources this server is configured with, by id (ADR 0002), and the
 * languages each runs. Never their URLs or tokens. Core names no kind and no
 * language: the modules that bring them do (ADR 0013).
 */
export type SourceCatalog = ReadonlyMap<string, { kind: string; languages: readonly string[] }>;

export interface DecideContext {
  /** The moment the change happens; it becomes the event's `at` and the definition's `effectiveFrom`. */
  now: string;
  actor: string;
  /**
   * Required, so no caller can skip the check by forgetting it. A caller with
   * no configured sources (the seed, most tests) passes an empty map.
   */
  sources: SourceCatalog;
  /** Set only by the server's collector: the one origin allowed to record `pull:` readings. */
  origin?: 'collector';
}

export function parseCommand(input: unknown): Command {
  try {
    return CommandSchema.parse(input);
  } catch (err) {
    if (err instanceof ZodError) {
      const msg = err.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
      throw new DomainError('invalid', msg);
    }
    throw err;
  }
}

export function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return s || 'node';
}

function uniqueId(u: Universe, base: string): string {
  if (!u.nodes.has(base)) return base;
  for (let i = 2; ; i++) {
    const id = `${base}-${i}`;
    if (!u.nodes.has(id)) return id;
  }
}

function requireNode(u: Universe, id: string, role = 'Node'): NodeState {
  const n = u.nodes.get(id);
  if (!n) throw new DomainError('not_found', `${role} “${id}” does not exist`);
  return n;
}

function requireActive(u: Universe, id: string, role: string): NodeState {
  const n = requireNode(u, id, role);
  if (n.lifecycle !== 'active') throw new DomainError('conflict', `${role} “${n.title}” is deprecated`);
  return n;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function checkBinding(binding: Binding | null, measure: MeasureSpec | null, sources: SourceCatalog): void {
  if (!binding) return;
  if (!measure) throw new DomainError('invalid', 'A binding needs a measure — it says where the measured number comes from');
  if (binding.sourceId === null) return; // provenance only: nothing will run it
  const src = sources.get(binding.sourceId);
  if (!src) throw new DomainError('invalid', `No source “${binding.sourceId}” is configured on this server`);
  if (!src.languages.includes(binding.language)) {
    throw new DomainError('invalid', `Source “${binding.sourceId}” (${src.kind}) cannot run ${binding.language}`);
  }
}

/** Whether the node already has a reading from `source` observed at exactly `observedAt`. */
function hasReading(u: Universe, nodeId: string, source: string, observedAt: string): boolean {
  const list = u.readings.get(nodeId);
  if (!list) return false;
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid]!.observedAt < observedAt) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < list.length && list[i]!.observedAt === observedAt; i++) if (list[i]!.source === source) return true;
  return false;
}

/**
 * The extra rules for a pulled reading (ADR 0002, decision 3): it must come
 * from the collector, from the source the node is bound to *now*, from within
 * the current binding's run, and only once.
 */
function checkPulled(u: Universe, n: NodeState, source: string, observedAt: string, ctx: DecideContext): void {
  if (ctx.origin !== 'collector') {
    throw new DomainError('invalid', `Sources starting with “${PULL_SOURCE_PREFIX}” are reserved for readings the server pulls itself`);
  }
  const sourceId = source.slice(PULL_SOURCE_PREFIX.length);
  if (n.lifecycle !== 'active') throw new DomainError('conflict', `“${n.title}” is deprecated; it is no longer pulled`);
  const binding = currentDefinition(n).binding;
  if (!binding || binding.sourceId !== sourceId) throw new DomainError('conflict', `“${n.title}” is not bound to source “${sourceId}”`);
  if (!ctx.sources.has(sourceId)) throw new DomainError('invalid', `No source “${sourceId}” is configured on this server`);
  const since = bindingSince(n)!;
  if (observedAt < since) {
    throw new DomainError('conflict', `The current query on “${n.title}” has only been in force since ${since}; it cannot vouch for ${observedAt}`);
  }
  if (hasReading(u, n.id, source, observedAt)) throw new DomainError('conflict', `“${n.title}” already has a ${source} reading at ${observedAt}`);
}

export function decide(u: Universe, cmd: Command, ctx: DecideContext): NewEvent[] {
  const at = new Date(ctx.now).toISOString();
  const meta = { at, actor: ctx.actor };

  switch (cmd.type) {
    case 'node.create': {
      const d = cmd.data;
      const id = d.id ?? uniqueId(u, slugify(d.title));
      if (u.nodes.has(id)) throw new DomainError('conflict', `A node with id “${id}” already exists`);
      if (d.parentId) requireActive(u, d.parentId, 'Parent');
      const links = [...new Set(d.links)];
      for (const t of links) {
        requireActive(u, t, 'Link target');
        if (t === d.parentId) throw new DomainError('invalid', 'A node cannot link to its own parent');
      }
      checkBinding(d.binding, d.measure, ctx.sources);
      // A brand-new node has no contributors yet, so it cannot close a cycle.
      return [{ ...meta, type: 'node.created', data: { ...d, id, links } }];
    }

    case 'node.edit': {
      const n = requireNode(u, cmd.data.id);
      const { id: _id, ...changes } = cmd.data;
      const effective = Object.entries(changes).filter(([k, v]) => v !== undefined && !same(v, n[k as keyof NodeState]));
      if (effective.length === 0) throw new DomainError('invalid', 'Nothing to change');
      return [{ ...meta, type: 'node.edited', data: { id: n.id, ...Object.fromEntries(effective) } }];
    }

    case 'node.redefine': {
      const n = requireNode(u, cmd.data.id);
      const cur = currentDefinition(n);
      const { measure, rollup, scenario, binding, reason } = cmd.data;
      const bindingChanged = binding !== undefined && !same(binding, cur.binding);
      const changes =
        (measure !== undefined && !same(measure, cur.measure)) ||
        (rollup !== undefined && !same(rollup, cur.rollup)) ||
        (scenario !== undefined && !same(scenario, cur.scenario)) ||
        bindingChanged;
      if (!changes) throw new DomainError('invalid', 'The new definition is identical to the current one');
      const nextMeasure = measure !== undefined ? measure : cur.measure;
      const nextBinding = binding !== undefined ? binding : cur.binding;
      if (nextBinding && !nextMeasure) {
        throw new DomainError('invalid', 'Removing the measure would leave its binding behind — remove the binding too');
      }
      // Only a binding that changes is checked against today's configuration:
      // a source dropped from config must not block revising a threshold.
      if (bindingChanged) checkBinding(nextBinding, nextMeasure, ctx.sources);
      return [{ ...meta, type: 'node.redefined', data: { id: n.id, measure, rollup, scenario, binding, reason } }];
    }

    case 'node.reprioritize': {
      const n = requireNode(u, cmd.data.id);
      if (n.priority === cmd.data.priority) throw new DomainError('invalid', `“${n.title}” is already ${n.priority}`);
      return [{ ...meta, type: 'node.reprioritized', data: cmd.data }];
    }

    case 'node.move': {
      const n = requireNode(u, cmd.data.id);
      const to = cmd.data.parentId;
      if (to === n.parentId) throw new DomainError('invalid', 'That is already its parent');
      if (to) {
        requireActive(u, to, 'New parent');
        if (to === n.id || contributesTo(u, to, n.id)) {
          throw new DomainError('conflict', 'That move would make the node contribute to itself');
        }
        if (n.links.includes(to)) throw new DomainError('conflict', 'It already contributes there through a link — unlink it first');
      }
      return [{ ...meta, type: 'node.moved', data: cmd.data }];
    }

    case 'node.link': {
      const n = requireNode(u, cmd.data.id);
      const t = requireActive(u, cmd.data.target, 'Link target');
      if (t.id === n.id) throw new DomainError('invalid', 'A node cannot link to itself');
      if (t.id === n.parentId || n.links.includes(t.id)) throw new DomainError('conflict', `“${n.title}” already contributes to “${t.title}”`);
      if (contributesTo(u, t.id, n.id)) throw new DomainError('conflict', 'That link would make the node contribute to itself');
      return [{ ...meta, type: 'node.linked', data: cmd.data }];
    }

    case 'node.unlink': {
      const n = requireNode(u, cmd.data.id);
      if (!n.links.includes(cmd.data.target)) throw new DomainError('invalid', 'There is no such link');
      return [{ ...meta, type: 'node.unlinked', data: cmd.data }];
    }

    case 'node.deprecate': {
      const n = requireNode(u, cmd.data.id);
      if (n.lifecycle === 'deprecated') throw new DomainError('conflict', `“${n.title}” is already deprecated`);
      return [{ ...meta, type: 'node.deprecated', data: cmd.data }];
    }

    case 'node.reactivate': {
      const n = requireNode(u, cmd.data.id);
      if (n.lifecycle === 'active') throw new DomainError('conflict', `“${n.title}” is already active`);
      return [{ ...meta, type: 'node.reactivated', data: cmd.data }];
    }

    case 'reading.record': {
      const d = cmd.data;
      const n = requireNode(u, d.nodeId);
      const spec = currentDefinition(n).measure;
      if (!spec) {
        throw new DomainError('invalid', `“${n.title}” has no measure — define one before sending readings`);
      }
      // A pass/fail check bound to a query returning 99.9 must not read as a pass.
      if (spec.unit === PASS_FAIL_UNIT && d.value !== 0 && d.value !== 1) {
        throw new DomainError('invalid', `“${n.title}” is a pass/fail check; a reading must be 1 (pass) or 0 (fail)`);
      }
      // Compare instants, not strings: an offset can carry a timestamp into a
      // five-digit or negative year, whose ISO spelling sorts wrongly as text.
      const observedMs = d.observedAt ? Date.parse(d.observedAt) : Date.parse(at);
      if (observedMs > Date.parse(at)) throw new DomainError('invalid', 'A reading cannot be observed in the future');
      const observedAt = new Date(observedMs).toISOString();
      if (!isCanonicalInstant(observedAt)) throw new DomainError('invalid', 'observedAt must fall within the years 0000–9999 (UTC)');
      if (d.source.startsWith(PULL_SOURCE_PREFIX)) checkPulled(u, n, d.source, observedAt, ctx);
      return [{ ...meta, type: 'reading.recorded', data: { nodeId: n.id, value: d.value, observedAt, source: d.source } }];
    }
  }
}
