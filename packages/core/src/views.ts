// The read models the API serves and the UI renders. Building them here keeps
// the server a thin shell and lets tests exercise exactly what users see.
import type { Status } from './constants.js';
import {
  currentDefinition,
  evaluateUniverse,
  indexContributors,
  type Evaluation,
} from './evaluate.js';
import { readingSeries, statusHistory, timelineFor, type SeriesPoint } from './history.js';
import type { Definition, NodeState, TimelineEntry } from './model.js';
import { project } from './project.js';
import type { RuEvent } from './schema.js';

const DAY = 24 * 3.6e6;

export interface NodeView extends Omit<NodeState, 'definitions'> {
  definition: Definition;
  definitionCount: number;
  childIds: string[];
  linkedFromIds: string[];
  evaluation: Evaluation;
  /** Daily status, oldest first, ending at `asOf`. */
  ribbon: (Status | null)[];
  /** Recent readings for a sparkline, or null when the node has no measure. */
  spark: SeriesPoint[] | null;
}

export interface UniverseView {
  asOf: string;
  live: boolean;
  /** The span time travel can reach. */
  range: { from: string; to: string };
  rootIds: string[];
  nodes: Record<string, NodeView>;
  ribbonTimes: string[];
  stats: { events: number; readings: number; changes: number };
}

export interface NodeDetailView {
  id: string;
  definitions: Definition[];
  timeline: TimelineEntry[];
  series: SeriesPoint[] | null;
  seriesRange: { from: string; to: string };
}

export interface ViewOptions {
  /** The moment to look at; omitted or in the future means live. */
  asOf?: string | null;
  now: string;
}

function resolveAsOf(opts: ViewOptions): { asOf: string; live: boolean } {
  if (!opts.asOf || opts.asOf >= opts.now) return { asOf: opts.now, live: true };
  return { asOf: new Date(opts.asOf).toISOString(), live: false };
}

export function buildUniverseView(
  events: readonly RuEvent[],
  opts: ViewOptions & { ribbonDays?: number; sparkDays?: number },
): UniverseView {
  const { asOf, live } = resolveAsOf(opts);
  const ribbonDays = opts.ribbonDays ?? 14;
  const sparkFrom = new Date(Date.parse(asOf) - (opts.sparkDays ?? 7) * DAY).toISOString();

  const u = project(events, asOf);
  const evals = evaluateUniverse(u, asOf);
  const idx = indexContributors(u);
  const ribbonTimes = Array.from({ length: ribbonDays }, (_, i) =>
    new Date(Date.parse(asOf) - (ribbonDays - 1 - i) * DAY).toISOString(),
  );
  const ribbons = statusHistory(events, ribbonTimes);

  const nodes: Record<string, NodeView> = {};
  for (const n of u.nodes.values()) {
    const { definitions, ...rest } = n;
    const def = currentDefinition(n);
    nodes[n.id] = {
      ...rest,
      definition: def,
      definitionCount: definitions.length,
      childIds: idx.children.get(n.id) ?? [],
      linkedFromIds: idx.linkedFrom.get(n.id) ?? [],
      evaluation: evals.get(n.id)!,
      ribbon: ribbons.get(n.id) ?? new Array(ribbonDays).fill(null),
      spark: def.measure ? readingSeries(u, n, sparkFrom, asOf, 42) : null,
    };
  }

  const rootIds = [...u.nodes.values()].filter((n) => n.parentId === null).map((n) => n.id);
  return {
    asOf,
    live,
    range: { from: events[0]?.at ?? opts.now, to: opts.now },
    rootIds,
    nodes,
    ribbonTimes,
    stats: { events: u.lastSeq, readings: u.readingCount, changes: u.timeline.length },
  };
}

export function buildNodeDetail(
  events: readonly RuEvent[],
  id: string,
  opts: ViewOptions & { seriesDays?: number },
): NodeDetailView | null {
  const { asOf } = resolveAsOf(opts);
  const u = project(events, asOf);
  const n = u.nodes.get(id);
  if (!n) return null;
  const from = new Date(Date.parse(asOf) - (opts.seriesDays ?? 30) * DAY).toISOString();
  const hasMeasure = n.definitions.some((d) => d.measure);
  return {
    id,
    definitions: n.definitions,
    timeline: timelineFor(u, id).reverse(),
    series: hasMeasure ? readingSeries(u, n, from, asOf, 360) : null,
    seriesRange: { from, to: asOf },
  };
}

export function buildChangeFeed(events: readonly RuEvent[], opts: ViewOptions & { limit?: number }): TimelineEntry[] {
  const { asOf } = resolveAsOf(opts);
  const u = project(events, asOf);
  return u.timeline.slice(-(opts.limit ?? 60)).reverse();
}
