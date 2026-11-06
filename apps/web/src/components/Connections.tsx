// Every way out of a node, one step each (ADR 0014): up to everything it counts
// toward, down to every metric beneath it, out to the code and the documents
// behind it. The focus view still shows one level; these lists are the
// shortcut across levels, like Follow the signal. What they hold is decided in
// core (countsToward, metricsBelow, referencesOn, referencesBelow); this file
// only renders it.
import {
  countsToward,
  describeTarget,
  formatThreshold,
  formatValue,
  kindLabel,
  metricsBelow,
  referenceHref,
  referencesBelow,
  referencesOn,
  splitReferences,
  targetKey,
  type NodeView,
  type ReferenceGroup,
  type ReferenceTarget,
  type Repository,
  type UniverseView,
} from '@orrery/core';
import { useMemo, type ReactNode } from 'react';
import type { Action } from './ActionDialog.js';
import { StatusDot } from './bits.js';
import { safeHref } from './Provenance.js';

interface Props {
  view: UniverseView;
  id: string;
  repos: readonly Repository[];
  onFocus: (id: string) => void;
  onTarget: (target: ReferenceTarget) => void;
  onAction: (action: Action, extra?: string) => void;
}

export function Connections({ view, id, repos, onFocus, onTarget, onAction }: Props) {
  const node = view.nodes[id]!;
  const up = useMemo(() => countsToward(view, id), [view, id]);
  const metrics = useMemo(() => metricsBelow(view, id), [view, id]);
  const own = useMemo(() => referencesOn(view, id), [view, id]);
  const below = useMemo(() => referencesBelow(view, id), [view, id]);
  const { implementation: ownImpl, other: others } = splitReferences(own);
  const belowImpl = splitReferences(below).implementation;
  const dashboard = safeHref(node.dashboardUrl);
  // A hand reference can be removed here; a harvested one comes back at the next scan, so its tag is removed instead.
  const remover = (g: ReferenceGroup) => {
    if (!view.live || !g.byHand) return undefined;
    const held = node.refs.find((r) => !r.origin && targetKey(r.target) === targetKey(g.target));
    return held ? () => onAction('unreference', JSON.stringify(held)) : undefined;
  };
  const row = (g: ReferenceGroup, holders?: boolean) => (
    <RefRow key={targetKey(g.target)} group={g} view={view} repos={repos} onTarget={onTarget} onFocus={holders ? onFocus : undefined} onRemove={holders ? undefined : remover(g)} />
  );

  return (
    <section className="panel connections" aria-labelledby="connections-title">
      <div className="panel-head">
        <h2 id="connections-title">Connections</h2>
        <span className="muted">every way from here, at any depth</span>
      </div>

      <Section title="Counts toward" count={up.length} empty={node.parentId ? 'nothing active' : 'nothing — it is the top'}>
        <ul className="conn-list">
          {up.map((c) => (
            <li key={c.node.id} className={`depth-${Math.min(c.depth, 4)}`}>
              <NodeButton node={c.node} onFocus={onFocus} />
              {c.via === 'link' && <span className="tag tag-link">through a link</span>}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Metrics beneath" count={metrics.length} empty={node.definition.measure ? 'none: it is measured itself' : 'none yet'}>
        <ul className="conn-list">
          {metrics.map((n) => (
            <li key={n.id}>
              <NodeButton node={n} onFocus={onFocus} />
              <MetricFigures node={n} />
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Implementation" count={ownImpl.length + belowImpl.length} empty="no code or tests referenced">
        {ownImpl.length > 0 && <ul className="conn-list">{ownImpl.map((g) => row(g))}</ul>}
        {belowImpl.length > 0 && (
          <>
            <h3 className="conn-sub">Beneath it</h3>
            <ul className="conn-list">{belowImpl.map((g) => row(g, true))}</ul>
          </>
        )}
      </Section>

      <Section title="References" count={others.length + (dashboard ? 1 : 0)} empty="no documents, tickets or dashboards">
        <ul className="conn-list">
          {dashboard && (
            <li className="ref-row">
              <span className="ref-kind">Dashboard</span>
              <a className="ref-out" href={dashboard} target="_blank" rel="noopener noreferrer">
                {new URL(dashboard).host} ↗
              </a>
            </li>
          )}
          {others.map((g) => row(g))}
        </ul>
      </Section>
    </section>
  );
}

function Section({ title, count, empty, children }: { title: string; count: number; empty: string; children: ReactNode }) {
  if (count === 0) {
    return (
      <p className="conn-empty">
        <span className="conn-title">{title}</span> <span className="muted">— {empty}</span>
      </p>
    );
  }
  return (
    <details className="conn">
      <summary>
        <span className="conn-title">{title}</span> <span className="pill">{count}</span>
      </summary>
      {children}
    </details>
  );
}

export function NodeButton({ node, onFocus }: { node: NodeView; onFocus: (id: string) => void }) {
  return (
    <button type="button" className="conn-node" onClick={() => onFocus(node.id)}>
      <StatusDot status={node.evaluation.status} />
      {node.title}
    </button>
  );
}

function MetricFigures({ node }: { node: NodeView }) {
  const m = node.evaluation.measurement;
  if (!m) return null;
  return (
    <span className="conn-figures">
      {m.value !== null ? formatValue(m.value, m.spec.unit) : 'no reading'} · target {formatThreshold(m.spec, 'target')}
    </span>
  );
}

interface RefRowProps {
  group: ReferenceGroup;
  view: UniverseView;
  repos: readonly Repository[];
  onTarget: (target: ReferenceTarget) => void;
  /** Given, the row names the nodes holding the reference, each a way there. */
  onFocus?: (id: string) => void;
  onRemove?: () => void;
}

/** One place a reference leads: in to its page, out to the place itself when there is a link. */
export function RefRow({ group, view, repos, onTarget, onFocus, onRemove }: RefRowProps) {
  const text = describeTarget(group.target);
  const href = safeHref(referenceHref(group.target, repos));
  return (
    <li className="ref-row">
      <span className="ref-kind">{group.kinds.map(kindLabel).join(' · ')}</span>
      <button type="button" className="ref-target" onClick={() => onTarget(group.target)} title="Every node that references it">
        {group.label ?? text}
        {group.label && <span className="ref-sub">{text}</span>}
      </button>
      {group.tagged && (
        <span className="tag" title="Harvested from a tag in the code; remove the tag to remove it">
          tagged
        </span>
      )}
      {href && (
        <a className="ref-out" href={href} target="_blank" rel="noopener noreferrer" aria-label={`Open ${text} (new tab)`}>
          open ↗
        </a>
      )}
      {onFocus && (
        <span className="ref-holders">
          in{' '}
          {group.holders.map((h) => (
            <button key={h} type="button" className="link-btn" onClick={() => onFocus(h)}>
              {view.nodes[h]?.title ?? h}
            </button>
          ))}
        </span>
      )}
      {onRemove && (
        <button type="button" className="ref-x" aria-label={`Remove the reference to ${text}`} onClick={onRemove}>
          ×
        </button>
      )}
    </li>
  );
}
