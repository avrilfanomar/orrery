// Where a number comes from (ADR 0002): the query that defines it, the source
// that runs it, how the last pull went, and the way out to the dashboards
// people already use.
import type { Binding } from '@ru/core';
import type { BindingStatus, PublicSource } from '../api.js';
import { ago } from './bits.js';

/** The schema already refuses anything else; checking again here means a hand-edited log can't plant a `javascript:` link. */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** A link that opens the query itself, from the source's public URL — never the internal one. */
export function exploreUrl(src: PublicSource, query: string): { href: string; label: string } | null {
  const base = safeHref(src.publicUrl)?.replace(/\/+$/, '');
  if (!base) return null;
  if (src.route === 'grafana' && src.grafanaDatasourceUid) {
    const uid = src.grafanaDatasourceUid;
    const panes = { ru: { datasource: uid, queries: [{ refId: 'A', expr: query, datasource: { type: 'prometheus', uid } }], range: { from: 'now-24h', to: 'now' } } };
    return { href: `${base}/explore?schemaVersion=1&panes=${encodeURIComponent(JSON.stringify(panes))}`, label: 'Open in Grafana Explore' };
  }
  return { href: `${base}/graph?g0.expr=${encodeURIComponent(query)}&g0.tab=0&g0.range_input=1d`, label: 'Open in Prometheus' };
}

const CATEGORY_TEXT: Record<string, string> = {
  unreachable: 'source unreachable',
  timeout: 'timed out',
  http: 'source returned an error',
  'bad-query': 'the query is invalid',
  empty: 'the query returned no data',
  'multi-series': 'the query returns several series',
  rejected: 'answer refused by the model',
  'not-configured': 'source not configured on this server',
  'token-missing': 'token not set on this server',
};

interface Props {
  binding: Binding | null;
  dashboardUrl: string | null;
  source: PublicSource | null;
  status: BindingStatus | null;
  asOf: string;
  live: boolean;
}

export function Provenance({ binding, dashboardUrl, source, status, asOf, live }: Props) {
  const dash = safeHref(dashboardUrl);
  if (!binding && !dash) return null;
  const explore = binding && source ? exploreUrl(source, binding.query) : null;

  return (
    <div className="provenance">
      <div className="prov-head">
        <span className="prov-label">Source</span>
        {binding?.sourceId ? (
          <span>
            pulled from <code>{binding.sourceId}</code>
            {source && <span className="muted"> · every {source.stepSeconds >= 60 ? `${source.stepSeconds / 60} min` : `${source.stepSeconds} s`}</span>}
          </span>
        ) : binding?.language === 'probe' ? (
          <span className="muted">
            measured by a repository probe (<code>pnpm dogfood</code>)
          </span>
        ) : binding ? (
          <span className="muted">documented query — readings arrive by push or by hand</span>
        ) : (
          <span className="muted">no query recorded</span>
        )}
        {live && binding?.sourceId && status && (
          <span className={`pull pull-${status.state}`} title={status.detail ?? undefined}>
            {status.state === 'ok'
              ? `last pull ${status.lastSuccessAt ? ago(status.lastSuccessAt, asOf) : 'ok'}`
              : status.state === 'pending'
                ? 'not pulled yet'
                : `${CATEGORY_TEXT[status.category ?? ''] ?? 'pull failing'}${status.httpStatus ? ` (HTTP ${status.httpStatus})` : ''}`}
          </span>
        )}
      </div>
      {binding && (
        <pre className="query" aria-label={`${binding.language} query`}>
          <code>{binding.query}</code>
        </pre>
      )}
      {(explore || dash) && (
        <div className="prov-links">
          {explore && (
            <a href={explore.href} target="_blank" rel="noopener noreferrer">
              {explore.label} ↗
            </a>
          )}
          {dash && (
            <a href={dash} target="_blank" rel="noopener noreferrer">
              Dashboard ↗ <span className="muted">{new URL(dash).host}</span>
            </a>
          )}
        </div>
      )}
    </div>
  );
}
