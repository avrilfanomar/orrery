// The projected state: what the event log means at one moment in time.
import type { Dimension, NodeKind, Priority } from './constants.js';
import type { Binding, MeasureSpec, Reference, RollupRule, ScenarioSpec } from './schema.js';

/**
 * One version of a node's evaluable definition. Versions are never edited:
 * a revision appends a new one, effective from the moment it was made, so a
 * reading is always judged against the definition in force when it was taken
 * (ADR 0001, decision 4).
 */
export interface Definition {
  version: number;
  effectiveFrom: string;
  measure: MeasureSpec | null;
  rollup: RollupRule;
  scenario: ScenarioSpec | null;
  /** Where the number comes from (ADR 0002); null when nobody has said. */
  binding: Binding | null;
  reason: string | null;
}

export type Lifecycle = 'active' | 'deprecated';

export interface NodeState {
  id: string;
  kind: NodeKind;
  title: string;
  description: string;
  /** The primary parent — the path progressive disclosure walks. */
  parentId: string | null;
  /** Further nodes this one also contributes to (a KPI often evidences several requirements). */
  links: string[];
  priority: Priority;
  dimensions: Dimension[];
  owner: string | null;
  /** Where a person looks at this node (a dashboard panel, say). Navigation, not meaning — so it is metadata, not definition. */
  dashboardUrl: string | null;
  /** Pointers to places outside the graph: code, tests, documents, tickets (ADR 0014). Navigation, not meaning, and never evaluated. */
  refs: Reference[];
  lifecycle: Lifecycle;
  createdAt: string;
  updatedAt: string;
  /** Ascending by version; the last one is current. */
  definitions: Definition[];
}

export interface Reading {
  nodeId: string;
  value: number;
  observedAt: string;
  source: string;
}

/** A human-readable line of the model's history, built while folding the log. */
export interface TimelineEntry {
  seq: number;
  at: string;
  actor: string;
  type: string;
  nodeId: string;
  /** Other nodes the change touched (old and new parent, link target). */
  relatedIds: string[];
  summary: string;
  reason: string | null;
}

export interface Universe {
  /** The moment this projection describes; `null` means "everything in the log". */
  asOf: string | null;
  nodes: Map<string, NodeState>;
  /** Per node, ascending by `observedAt`. */
  readings: Map<string, Reading[]>;
  timeline: TimelineEntry[];
  lastSeq: number;
  firstAt: string | null;
  lastAt: string | null;
  readingCount: number;
}
