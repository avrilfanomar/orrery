// The read models the API serves and the UI renders. Building them here keeps
// the server a thin shell and lets tests exercise exactly what users see.
import { IMPLEMENTATION_KINDS, type Status } from './constants.js';
import {
  currentDefinition,
  evaluateUniverse,
  indexContributors,
  type Evaluation,
} from './evaluate.js';
import { readingSeries, statusHistory, timelineFor, type SeriesPoint } from './history.js';
import type { Definition, NodeState, TimelineEntry } from './model.js';
import { project } from './project.js';
import { describeTarget, matchTarget, refKey, targetKey, type TargetMatch } from './references.js';
import type { OrreryEvent, Reference, ReferenceTarget } from './schema.js';

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

/**
 * The refinement backlog below a node: every active node beneath it, through
 * children and links, that nobody can observe yet. That is a measure without a
 * judged reading (never measured, stale, or not comparable), or a stub with
 * nothing beneath it. The backlog plus the node itself, when it is one, are
 * exactly the leaves its coverage counts as unmeasured, so the two numbers
 * the console shows never disagree.
 */
export function backlogBelow(view: UniverseView, id: string): NodeView[] {
  const out = new Map<string, NodeView>();
  const seen = new Set<string>();
  const walk = (nid: string) => {
    const n = view.nodes[nid];
    if (seen.has(nid) || !n || n.lifecycle !== 'active') return;
    seen.add(nid);
    const inputs = [...n.childIds, ...n.linkedFromIds].filter((c) => view.nodes[c]?.lifecycle === 'active');
    const m = n.evaluation.measurement;
    if (nid !== id && (m ? m.status === 'unknown' : inputs.length === 0)) out.set(nid, n);
    inputs.forEach(walk);
  };
  walk(id);
  return [...out.values()];
}

/**
 * The breadcrumb to a node: its primary parents from the top down, ending at
 * its own parent. Links are other routes to a node, not the way back up.
 */
export function breadcrumbTo(view: UniverseView, id: string): NodeView[] {
  const out: NodeView[] = [];
  let cur: string | null = view.nodes[id]?.parentId ?? null;
  while (cur && view.nodes[cur] && !out.some((n) => n.id === cur)) {
    out.unshift(view.nodes[cur]!);
    cur = view.nodes[cur]!.parentId;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Traceability (ADR 0014): every connection of a node, one step away.
// ---------------------------------------------------------------------------

/** A node something contributes to, how far up it is, and the edge the walk arrived by. */
export interface Contribution {
  node: NodeView;
  via: 'parent' | 'link';
  depth: number;
}

/**
 * Everything a node counts toward, through primary parents and links, nearest
 * first: a KPI linked under two requirements lists both, and the goals above
 * them. The breadcrumb climbs one path; this is every path up.
 */
export function countsToward(view: UniverseView, id: string): Contribution[] {
  const out: Contribution[] = [];
  const seen = new Set([id]);
  let frontier = [id];
  for (let depth = 1; frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const nid of frontier) {
      for (const [tid, via] of upEdges(view.nodes[nid])) {
        const t = view.nodes[tid];
        if (!t || seen.has(tid)) continue;
        seen.add(tid);
        out.push({ node: t, via, depth });
        next.push(tid);
      }
    }
    frontier = next;
  }
  return out;
}

function upEdges(n: NodeView | undefined): [string, Contribution['via']][] {
  if (!n) return [];
  return [...(n.parentId ? [[n.parentId, 'parent'] as [string, 'parent']] : []), ...n.links.map((l) => [l, 'link'] as [string, 'link'])];
}

/** Every active node beneath `id`, through children and links, each once, `id` itself excluded. */
function activeBeneath(view: UniverseView, id: string): NodeView[] {
  const found = new Map<string, NodeView>();
  const stack = [id];
  while (stack.length > 0) {
    const cur = view.nodes[stack.pop()!];
    if (!cur) continue;
    for (const cid of [...cur.childIds, ...cur.linkedFromIds]) {
      const c = view.nodes[cid];
      if (!c || c.lifecycle !== 'active' || cid === id || found.has(cid)) continue;
      found.set(cid, c);
      stack.push(cid);
    }
  }
  return [...found.values()];
}

/**
 * Every measured node beneath a node, at any depth, through links too: from a
 * requirement straight to its metrics. Judged on each node's own measurement,
 * not its rolled-up status, so those whose measurement is known, plus the node
 * itself when its own is, are exactly the leaves its coverage counts as
 * measured, and the rest are in its backlog.
 */
export function metricsBelow(view: UniverseView, id: string): NodeView[] {
  return activeBeneath(view, id).filter((n) => n.evaluation.measurement !== null);
}

/** One place many references may lead to, and who holds them. */
export interface ReferenceGroup {
  target: ReferenceTarget;
  kinds: string[];
  /** The first label any holder gave it. */
  label: string | null;
  /** Harvested from a tag in the code by at least one holder. */
  tagged: boolean;
  /** Added by hand by at least one holder. */
  byHand: boolean;
  /** The nodes holding a reference to it, in the order met. */
  holders: string[];
}

function groupReferences(nodes: readonly NodeView[]): ReferenceGroup[] {
  const groups = new Map<string, ReferenceGroup>();
  for (const n of nodes) {
    for (const ref of n.refs) {
      const key = targetKey(ref.target);
      const g = groups.get(key) ?? { target: ref.target, kinds: [], label: null, tagged: false, byHand: false, holders: [] };
      groups.set(key, g);
      addToGroup(g, ref, n.id);
    }
  }
  return [...groups.values()].sort((a, b) => a.kinds[0]!.localeCompare(b.kinds[0]!) || describeTarget(a.target).localeCompare(describeTarget(b.target)));
}

function addToGroup(g: ReferenceGroup, ref: Reference, holder: string): void {
  if (!g.kinds.includes(ref.kind)) g.kinds.push(ref.kind);
  g.label ??= ref.label ?? null;
  if (ref.origin === 'tag') g.tagged = true;
  else g.byHand = true;
  if (!g.holders.includes(holder)) g.holders.push(holder);
}

/**
 * Where a group shows in the console: under *Implementation* when any holder
 * calls it code or a test, under *References* otherwise. One place may be both
 * a doc and code; implementation wins, so code is never hidden among tickets.
 */
export function splitReferences(groups: readonly ReferenceGroup[]): { implementation: ReferenceGroup[]; other: ReferenceGroup[] } {
  const isImpl = (g: ReferenceGroup) => g.kinds.some((k) => IMPLEMENTATION_KINDS.includes(k));
  return { implementation: groups.filter(isImpl), other: groups.filter((g) => !isImpl(g)) };
}

/** A node's own references, one row per place: a harvested and a hand reference to one file show as one. */
export function referencesOn(view: UniverseView, id: string): ReferenceGroup[] {
  const n = view.nodes[id];
  return n ? groupReferences([n]) : [];
}

/** The references held beneath a node, at any depth: the code behind a goal, grouped by place, each naming its holders. */
export function referencesBelow(view: UniverseView, id: string): ReferenceGroup[] {
  return groupReferences(activeBeneath(view, id));
}

/** A node that references a place, through which reference, and how that reference's target relates to the place asked about. */
export interface Referrer {
  node: NodeView;
  ref: Reference;
  match: TargetMatch;
}

const MATCH_ORDER: Record<TargetMatch, number> = { exact: 0, directory: 1, file: 2 };

/**
 * From a file, a directory or a URL back to the nodes that reference it: for a
 * file, also those referencing a directory above it; for a directory, also
 * those referencing a file below it. One pass over every reference.
 */
export function referencedBy(view: UniverseView, target: ReferenceTarget): Referrer[] {
  const out: Referrer[] = [];
  for (const node of Object.values(view.nodes)) {
    for (const ref of node.refs) {
      const match = matchTarget(ref.target, target);
      if (match) out.push({ node, ref, match });
    }
  }
  return out.sort((a, b) => MATCH_ORDER[a.match] - MATCH_ORDER[b.match] || a.node.title.localeCompare(b.node.title) || refKey(a.ref).localeCompare(refKey(b.ref)));
}

export type SearchHit =
  | { type: 'node'; id: string; rank: number; matched: string }
  | { type: 'target'; target: ReferenceTarget; rank: number; matched: string; holders: string[] };

/**
 * One search over the whole universe, best first: an exact id, then a title
 * that starts with the text, then a title or id that contains it, then a
 * place a reference leads to, then a node whose query uses it (so a metric
 * name finds every KPI built on it), then a description.
 */
export function searchUniverse(view: UniverseView, query: string, limit = 12): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: SearchHit[] = [];
  for (const n of Object.values(view.nodes)) {
    const rank = nodeRank(n, q);
    if (rank) hits.push({ type: 'node', id: n.id, rank, matched: n.title });
  }
  for (const g of groupReferences(Object.values(view.nodes))) {
    const text = describeTarget(g.target);
    if (text.toLowerCase().includes(q) || g.label?.toLowerCase().includes(q)) hits.push({ type: 'target', target: g.target, rank: 4, matched: g.label ?? text, holders: g.holders });
  }
  const active = (h: SearchHit) => (h.type === 'node' && view.nodes[h.id]!.lifecycle !== 'active' ? 1 : 0);
  return hits.sort((a, b) => a.rank - b.rank || active(a) - active(b) || a.matched.localeCompare(b.matched)).slice(0, limit);
}

function nodeRank(n: NodeView, q: string): number | null {
  const title = n.title.toLowerCase();
  if (n.id === q) return 1;
  if (title.startsWith(q)) return 2;
  if (title.includes(q) || n.id.includes(q)) return 3;
  if (n.definition.binding?.query.toLowerCase().includes(q)) return 5;
  if (n.description.toLowerCase().includes(q)) return 6;
  return null;
}

function resolveAsOf(opts: ViewOptions): { asOf: string; live: boolean } {
  if (!opts.asOf || opts.asOf >= opts.now) return { asOf: opts.now, live: true };
  return { asOf: new Date(opts.asOf).toISOString(), live: false };
}

export function buildUniverseView(
  events: readonly OrreryEvent[],
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
  events: readonly OrreryEvent[],
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

export function buildChangeFeed(events: readonly OrreryEvent[], opts: ViewOptions & { limit?: number }): TimelineEntry[] {
  const { asOf } = resolveAsOf(opts);
  const u = project(events, asOf);
  return u.timeline.slice(-(opts.limit ?? 60)).reverse();
}

/** A query language as the console learns it from the server: its id and the installed source kinds that run it (ADR 0013). */
export interface LanguageOffer {
  id: string;
  kinds: readonly string[];
}

/**
 * The languages a binding's form offers: those some installed kind can pull.
 * A binding already in a language nothing pulls keeps it, and is offered
 * nothing else: re-labelling a probe as PromQL would log a new, wrong yardstick
 * (ADR 0003).
 */
export function languageChoices<L extends LanguageOffer>(languages: readonly L[], current: string): L[] {
  const pullable = languages.filter((l) => l.kinds.length > 0);
  return current && !pullable.some((l) => l.id === current) ? languages.filter((l) => l.id === current) : pullable;
}

/** The language a binding will be written in: the one chosen, else the first an installed kind can pull, else none. */
export function bindingLanguage(chosen: string, languages: readonly LanguageOffer[]): string {
  return chosen || languageChoices(languages, '')[0]?.id || '';
}
