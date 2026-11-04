// The closed vocabularies of the domain. ADR 0001 explains why there is one
// recursive node type and why `kind` is a label rather than a separate table.

export const NODE_KINDS = ['product', 'goal', 'requirement', 'constraint', 'kpi', 'scenario'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const KIND_LABELS: Record<NodeKind, string> = {
  product: 'Product',
  goal: 'Goal',
  requirement: 'Requirement',
  constraint: 'Constraint',
  kpi: 'KPI',
  scenario: 'Scenario',
};

/**
 * What the UI offers first when a node is refined. A suggestion, never a rule:
 * any kind may contribute to any other, because real refinement is messy.
 */
export const SUGGESTED_CHILD_KINDS: Record<NodeKind, NodeKind[]> = {
  product: ['goal', 'constraint'],
  goal: ['requirement', 'constraint', 'kpi', 'goal'],
  requirement: ['kpi', 'scenario', 'requirement', 'constraint'],
  constraint: ['kpi', 'scenario', 'constraint'],
  kpi: ['kpi', 'scenario'],
  scenario: ['kpi', 'scenario'],
};

export const PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Weights used by the `weighted` rollup. Doubling per step keeps one critical item heavier than two highs. */
export const PRIORITY_WEIGHT: Record<Priority, number> = { critical: 8, high: 4, medium: 2, low: 1 };

/**
 * The nine quality dimensions of the arc42 Quality Model (https://quality.arc42.org/,
 * Gernot Starke, CC BY-SA 4.0), plus `business` for outcome KPIs. Only the
 * dimension names are cited; the characteristic catalogue is not vendored.
 */
export const DIMENSIONS = [
  'business',
  'efficient',
  'flexible',
  'maintainable',
  'operable',
  'reliable',
  'safe',
  'secure',
  'suitable',
  'usable',
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const STATUSES = ['ok', 'warn', 'breach', 'unknown'] as const;
export type Status = (typeof STATUSES)[number];
export type KnownStatus = Exclude<Status, 'unknown'>;

/**
 * Severity used by worst-of. `unknown` ranks above `ok` on purpose: an input
 * nobody measures can never make its parent look green (ADR 0001, decision 2).
 */
export const SEVERITY: Record<Status, number> = { ok: 0, unknown: 1, warn: 2, breach: 3 };

export const STATUS_LABELS: Record<Status, string> = {
  ok: 'On target',
  warn: 'Warning',
  breach: 'Breach',
  unknown: 'Unknown',
};

/** The unit that turns a measure into a pass/fail check (1 = pass, 0 = fail). */
export const PASS_FAIL_UNIT = 'pass/fail';

/**
 * Systems a metric can be pulled from (ADR 0002). Grafana is not a kind: it is
 * a route to a Prometheus data source, chosen in server configuration.
 */
export const SOURCE_KINDS = ['prometheus'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/**
 * What a binding's query is written in — independent of who runs it, so re-pointing a source can't silently reinterpret logged queries.
 * `probe` names a repository probe as `<probe-id>@<version>` (ADR 0003). No source kind can run it, so a probe binding is always
 * provenance only; bumping the version is a new query, hence a new yardstick.
 */
export const QUERY_LANGUAGES = ['promql', 'probe'] as const;
export type QueryLanguage = (typeof QUERY_LANGUAGES)[number];

export const LANGUAGES_BY_KIND: Record<SourceKind, readonly QueryLanguage[]> = { prometheus: ['promql'] };

/** Readings whose source starts with this were pulled by the server's collector; nobody else may claim it (ADR 0002, decision 3). */
export const PULL_SOURCE_PREFIX = 'pull:';
