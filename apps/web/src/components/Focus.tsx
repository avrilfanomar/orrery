// One node at a time, with exactly one level of detail below it. From the top
// you see goals; each step down trades breadth for depth, ending at a KPI's
// raw readings. "Follow the signal" jumps the whole way in one move.
import { useQuery } from '@tanstack/react-query';
import {
  DIMENSIONS,
  KIND_LABELS,
  PRIORITY_WEIGHT,
  SEVERITY,
  describeRollup,
  formatThreshold,
  formatValue,
  signalPath,
  type Evaluation,
  type NodeView,
  type UniverseView,
} from '@ru/core';
import { useMemo } from 'react';
import { api } from '../api.js';
import type { Action } from './ActionDialog.js';
import { Counts, Coverage, KindTag, PriorityTag, Ribbon, StatusBadge, StatusDot, ago, fmtDate, fmtDateTime } from './bits.js';
import { NodeTile } from './NodeTile.js';
import { Provenance, safeHref } from './Provenance.js';
import { ReadingChart } from './ReadingChart.js';

interface Props {
  view: UniverseView;
  id: string;
  asOf: string | null;
  onFocus: (id: string) => void;
  onAction: (action: Action, extra?: string) => void;
}

const bySeverity = (view: UniverseView) => (a: string, b: string) => {
  const x = view.nodes[a]!;
  const y = view.nodes[b]!;
  return (
    SEVERITY[y.evaluation.status] - SEVERITY[x.evaluation.status] ||
    PRIORITY_WEIGHT[y.priority] - PRIORITY_WEIGHT[x.priority] ||
    x.title.localeCompare(y.title)
  );
};

function trail(view: UniverseView, id: string): NodeView[] {
  const out: NodeView[] = [];
  let cur: string | null = view.nodes[id]?.parentId ?? null;
  while (cur && view.nodes[cur] && !out.some((n) => n.id === cur)) {
    out.unshift(view.nodes[cur]!);
    cur = view.nodes[cur]!.parentId;
  }
  return out;
}

/** Unobservable endpoints below a node — the refinement backlog for this part of the universe. */
function gaps(view: UniverseView, id: string): NodeView[] {
  const out = new Map<string, NodeView>();
  const seen = new Set<string>();
  const walk = (nid: string) => {
    if (seen.has(nid)) return;
    seen.add(nid);
    const n = view.nodes[nid];
    if (!n || n.lifecycle !== 'active') return;
    const inputs = [...n.childIds, ...n.linkedFromIds].filter((c) => view.nodes[c]?.lifecycle === 'active');
    // A gap is a measure nobody feeds (never measured, or stale), or a stub with nothing beneath it.
    const isGap = n.evaluation.measurement?.status === 'unknown' || (inputs.length === 0 && !n.evaluation.measurement);
    if (isGap && nid !== id) out.set(nid, n);
    inputs.forEach(walk);
  };
  walk(id);
  return [...out.values()];
}

export function Focus({ view, id, asOf, onFocus, onAction }: Props) {
  const node = view.nodes[id]!;
  const ev = node.evaluation;
  const live = view.live;
  const detail = useQuery({
    queryKey: ['node', id, asOf, live ? view.stats.events : 0],
    queryFn: () => api.node(id, asOf),
    placeholderData: (prev) => (prev?.id === id ? prev : undefined),
  });

  const evals = useMemo(() => new Map<string, Evaluation>(Object.entries(view.nodes).map(([k, n]) => [k, n.evaluation])), [view]);
  const path = signalPath(evals, id);
  const sort = bySeverity(view);
  const children = node.childIds.filter((c) => view.nodes[c]?.lifecycle === 'active').sort(sort);
  const deprecated = node.childIds.filter((c) => view.nodes[c]?.lifecycle === 'deprecated');
  const linked = node.linkedFromIds.filter((c) => view.nodes[c]?.lifecycle === 'active' && !node.childIds.includes(c)).sort(sort);
  const backlog = useMemo(() => gaps(view, id), [view, id]);
  const spec = node.definition.measure;
  const scenario = node.definition.scenario;
  const hasInputs = children.length + linked.length > 0;
  const m = ev.measurement;
  const binding = node.definition.binding;
  const pulled = live && !!binding?.sourceId;
  const sources = useQuery({ queryKey: ['sources', view.stats.events], queryFn: api.sources, enabled: pulled });
  const source = sources.data?.sources.find((s) => s.id === binding?.sourceId) ?? null;
  const pullStatus = sources.data?.bindings.find((b) => b.nodeId === id && b.sourceId === binding?.sourceId) ?? null;
  const dashboard = safeHref(node.dashboardUrl);

  return (
    <article className="focus">
      <nav className="crumbs" aria-label="Path to this node">
        {trail(view, id).map((n) => (
          <span key={n.id} className="crumb">
            <button type="button" onClick={() => onFocus(n.id)}>
              <StatusDot status={n.evaluation.status} />
              {n.title}
            </button>
            <span className="sep" aria-hidden="true">›</span>
          </span>
        ))}
        <span className="crumb is-current">{node.title}</span>
      </nav>

      <header className={`focus-head edge-${ev.status}`}>
        <div className="eyebrow">
          <KindTag kind={node.kind} />
          <PriorityTag priority={node.priority} />
          {node.dimensions.map((d) => (
            <span key={d} className="dim" title={d === 'business' ? 'Business outcome' : `arc42 quality dimension: ${d}`}>
              {d}
            </span>
          ))}
          {node.lifecycle === 'deprecated' && <span className="tag">deprecated</span>}
        </div>
        <h1>{node.title}</h1>
        {node.description && <p className="desc">{node.description}</p>}

        <div className="verdict">
          <StatusBadge status={ev.status} size="lg" />
          <p className="verdict-reason">{ev.reason}</p>
        </div>

        <dl className="facts">
          <div>
            <dt>Observable</dt>
            <dd>
              <Coverage {...ev.coverage} wide />
            </dd>
          </div>
          {ev.inputCount > 1 && (
            <div>
              <dt>Inputs</dt>
              <dd>
                <Counts counts={ev.counts} />
              </dd>
            </div>
          )}
          {(hasInputs || !spec) && (
            <div>
              <dt>Rollup rule</dt>
              <dd>{describeRollup(node.definition.rollup)}</dd>
            </div>
          )}
          <div>
            <dt>Last {node.ribbon.length} days</dt>
            <dd>
              <Ribbon ribbon={node.ribbon} times={view.ribbonTimes} />
            </dd>
          </div>
          <div>
            <dt>Definition</dt>
            <dd>
              v{node.definition.version} since {fmtDate.format(new Date(node.definition.effectiveFrom))}
            </dd>
          </div>
          <div>
            <dt>Owner</dt>
            <dd>{node.owner ?? '—'}</dd>
          </div>
          {dashboard && !spec && (
            <div>
              <dt>Dashboard</dt>
              <dd>
                <a href={dashboard} target="_blank" rel="noopener noreferrer">
                  {new URL(dashboard).host} ↗
                </a>
              </dd>
            </div>
          )}
          {node.links.length > 0 && (
            <div>
              <dt>Also counts toward</dt>
              <dd className="links">
                {node.links.map((t) => (
                  <span key={t} className="chip">
                    <button type="button" onClick={() => onFocus(t)}>
                      {view.nodes[t]?.title ?? t}
                    </button>
                    {live && (
                      <button type="button" className="chip-x" aria-label={`Unlink from ${view.nodes[t]?.title ?? t}`} onClick={() => onAction('unlink', t)}>
                        ×
                      </button>
                    )}
                  </span>
                ))}
              </dd>
            </div>
          )}
        </dl>

        {live ? (
          <div className="actions" role="toolbar" aria-label="Evolve this node">
            <button type="button" className="btn btn-primary" onClick={() => onAction('refine')}>
              + Refine
            </button>
            {spec && (
              <button type="button" className="btn" onClick={() => onAction('reading')}>
                Record reading
              </button>
            )}
            <button type="button" className="btn" onClick={() => onAction('redefine')}>
              Revise definition
            </button>
            <button type="button" className="btn" onClick={() => onAction('priority')}>
              Priority
            </button>
            <button type="button" className="btn" onClick={() => onAction('edit')}>
              Edit
            </button>
            {node.parentId !== null && (
              <button type="button" className="btn" onClick={() => onAction('move')}>
                Move
              </button>
            )}
            <button type="button" className="btn" onClick={() => onAction('link')}>
              Link
            </button>
            {node.lifecycle === 'active' ? (
              <button type="button" className="btn btn-quiet" onClick={() => onAction('deprecate')}>
                Deprecate
              </button>
            ) : (
              <button type="button" className="btn" onClick={() => onAction('reactivate')}>
                Reactivate
              </button>
            )}
          </div>
        ) : (
          <p className="hint">You are looking at the past — go back to live to change the model.</p>
        )}
      </header>

      {path.length > 0 && (
        <section className="signal" aria-label="Follow the signal">
          <span className="signal-label">{ev.status === 'unknown' ? 'Why unknown' : 'Follow the signal'}</span>
          {path.map((pid, i) => {
            const p = view.nodes[pid]!;
            return (
              <span key={pid} className="signal-step">
                {i > 0 && <span className="sep">→</span>}
                <button type="button" onClick={() => onFocus(pid)}>
                  <StatusDot status={p.evaluation.status} />
                  {p.title}
                </button>
              </span>
            );
          })}
        </section>
      )}

      {(spec || scenario) && (
        <section className="panel">
          <div className="panel-head">
            <h2>{scenario ? 'Scenario' : 'Measurement'}</h2>
            {m?.observedAt && (
              <span className="muted">
                last reading {ago(m.observedAt, view.asOf)} · {fmtDateTime.format(new Date(m.observedAt))}
              </span>
            )}
          </div>
          {scenario && (
            <dl className="scenario">
              <div>
                <dt>Stimulus</dt>
                <dd>{scenario.stimulus}</dd>
              </div>
              {scenario.environment && (
                <div>
                  <dt>Environment</dt>
                  <dd>{scenario.environment}</dd>
                </div>
              )}
              <div>
                <dt>Expected response</dt>
                <dd>{scenario.response}</dd>
              </div>
            </dl>
          )}
          {spec && (
            <>
              <Provenance binding={binding} dashboardUrl={node.dashboardUrl} source={source} status={pullStatus} asOf={view.asOf} live={live} />
              <div className="figure-row">
                <div className="figure">
                  <span className="figure-value">{m?.value !== null && m?.value !== undefined ? formatValue(m.value, spec.unit) : '—'}</span>
                  <span className="figure-label">latest</span>
                </div>
                <div className="figure">
                  <span className="figure-value small">{formatThreshold(spec, 'target')}</span>
                  <span className="figure-label">target</span>
                </div>
                <div className="figure">
                  <span className="figure-value small">{formatThreshold(spec, 'warn')}</span>
                  <span className="figure-label">warning until</span>
                </div>
                <div className="figure">
                  <span className="figure-value small">{spec.staleAfterHours} h</span>
                  <span className="figure-label">unknown when older than</span>
                </div>
              </div>
              {detail.data?.series ? (
                <ReadingChart series={detail.data.series} definitions={detail.data.definitions} from={detail.data.seriesRange.from} to={detail.data.seriesRange.to} />
              ) : (
                <div className="chart-placeholder">{detail.isError ? 'Could not load readings.' : 'Loading readings…'}</div>
              )}
            </>
          )}
        </section>
      )}

      {hasInputs && (
        <section className="panel">
          <div className="panel-head">
            <h2>Contributors</h2>
            <span className="muted">sorted by severity, then priority — open one to go a level deeper</span>
          </div>
          <div className="tiles">
            {children.map((c) => (
              <NodeTile key={c} node={view.nodes[c]!} ribbonTimes={view.ribbonTimes} onOpen={onFocus} />
            ))}
            {linked.map((c) => (
              <NodeTile key={c} node={view.nodes[c]!} ribbonTimes={view.ribbonTimes} via="link" onOpen={onFocus} />
            ))}
          </div>
        </section>
      )}

      {!hasInputs && !spec && (
        <section className="panel empty">
          <h2>Not refined yet</h2>
          <p>
            This {KIND_LABELS[node.kind].toLowerCase()} is a legitimate first draft, but nothing below it can be observed, so its status is
            unknown rather than assumed fine. Refine it into requirements, constraints, KPIs or scenarios.
          </p>
          {live && (
            <button type="button" className="btn btn-primary" onClick={() => onAction('refine')}>
              + Refine this {KIND_LABELS[node.kind].toLowerCase()}
            </button>
          )}
        </section>
      )}

      {backlog.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <h2>Not yet observable ({backlog.length})</h2>
            <span className="muted">the refinement backlog below this node</span>
          </div>
          <ul className="gaps">
            {backlog.map((g) => (
              <li key={g.id}>
                <button type="button" onClick={() => onFocus(g.id)}>
                  <StatusDot status="unknown" />
                  <span className="gap-title">{g.title}</span>
                  <span className="gap-reason">{g.evaluation.measurement?.reason ?? g.evaluation.reason}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {deprecated.length > 0 && (
        <details className="panel deprecated">
          <summary>Deprecated contributors ({deprecated.length}) — kept for history, excluded from the rollup</summary>
          <div className="tiles">
            {deprecated.map((c) => (
              <NodeTile key={c} node={view.nodes[c]!} ribbonTimes={view.ribbonTimes} onOpen={onFocus} />
            ))}
          </div>
        </details>
      )}

      <section className="panel">
        <div className="panel-head">
          <h2>How this evolved</h2>
          <span className="muted">every change is kept with its reason; nothing is rewritten</span>
        </div>
        {detail.data ? (
          <ol className="history">
            {detail.data.timeline.map((e) => (
              <li key={e.seq}>
                <time dateTime={e.at}>{fmtDateTime.format(new Date(e.at))}</time>
                <div>
                  <span className="who">{e.actor}</span> {e.summary}
                  {e.reason && <q className="why">{e.reason}</q>}
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">Loading…</p>
        )}
        {detail.data && detail.data.definitions.length > 1 && (
          <table className="versions">
            <caption>Definition versions</caption>
            <thead>
              <tr>
                <th>Version</th>
                <th>Effective from</th>
                <th>Target</th>
                <th>Warning</th>
                <th>Rollup</th>
                <th>Source</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {[...detail.data.definitions].reverse().map((d) => (
                <tr key={d.version}>
                  <td>v{d.version}</td>
                  <td>{fmtDateTime.format(new Date(d.effectiveFrom))}</td>
                  <td>{d.measure ? formatThreshold(d.measure, 'target') : '—'}</td>
                  <td>{d.measure ? formatThreshold(d.measure, 'warn') : '—'}</td>
                  <td>{d.rollup.strategy}</td>
                  <td title={d.binding?.query}>{d.binding ? (d.binding.sourceId ?? 'documented') : '—'}</td>
                  <td className="why-cell">{d.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <p className="footnote">
        Quality dimensions follow the{' '}
        <a href="https://quality.arc42.org/" target="_blank" rel="noreferrer">
          arc42 Quality Model
        </a>{' '}
        ({DIMENSIONS.filter((d) => d !== 'business').join(', ')}).
      </p>
    </article>
  );
}
