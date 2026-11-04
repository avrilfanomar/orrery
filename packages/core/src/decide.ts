// Commands in, events out. Every rule that protects the model's integrity
// lives here, so the API, the seed and any future importer share one gate.
import { ZodError } from 'zod';
import { currentDefinition, contributesTo } from './evaluate.js';
import { isCanonicalInstant } from './log.js';
import type { NodeState, Universe } from './model.js';
import { CommandSchema, type Command, type NewEvent } from './schema.js';

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

export interface DecideContext {
  /** The moment the change happens; it becomes the event's `at` and the definition's `effectiveFrom`. */
  now: string;
  actor: string;
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
      const { measure, rollup, scenario, reason } = cmd.data;
      const changes =
        (measure !== undefined && !same(measure, cur.measure)) ||
        (rollup !== undefined && !same(rollup, cur.rollup)) ||
        (scenario !== undefined && !same(scenario, cur.scenario));
      if (!changes) throw new DomainError('invalid', 'The new definition is identical to the current one');
      return [{ ...meta, type: 'node.redefined', data: { id: n.id, measure, rollup, scenario, reason } }];
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
      if (!currentDefinition(n).measure) {
        throw new DomainError('invalid', `“${n.title}” has no measure — define one before sending readings`);
      }
      // Compare instants, not strings: an offset can carry a timestamp into a
      // five-digit or negative year, whose ISO spelling sorts wrongly as text.
      const observedMs = d.observedAt ? Date.parse(d.observedAt) : Date.parse(at);
      if (observedMs > Date.parse(at)) throw new DomainError('invalid', 'A reading cannot be observed in the future');
      const observedAt = new Date(observedMs).toISOString();
      if (!isCanonicalInstant(observedAt)) throw new DomainError('invalid', 'observedAt must fall within the years 0000–9999 (UTC)');
      return [{ ...meta, type: 'reading.recorded', data: { nodeId: n.id, value: d.value, observedAt, source: d.source } }];
    }
  }
}
