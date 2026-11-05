// Where a number comes from (ADR 0002): the query that defines it, the source
// that runs it, how the last pull went, and the way out to the dashboards
// people already use. What is said about a language or a source comes from the
// server's modules (ADR 0013); nothing here names one.
import type { Binding } from '@orrery/core';
import type { ReactNode } from 'react';
import type { BindingStatus, PublicLanguage, PublicSource } from '../api.js';
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

/** A module's sentence with `code` in backticks, rendered without trusting it as markup. */
function withCode(text: string): ReactNode[] {
  return text.split('`').map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));
}

const CATEGORY_TEXT: Record<string, string> = {
  unreachable: 'source unreachable',
  timeout: 'timed out',
  http: 'source returned an error',
  'bad-query': 'the query is invalid',
  empty: 'the query returned no data',
  'multi-series': 'the query returns several series',
  rejected: 'answer refused by the model',
  internal: 'failed inside this server',
  'not-configured': 'source not configured on this server',
  'token-missing': 'token not set on this server',
};

interface Props {
  binding: Binding | null;
  dashboardUrl: string | null;
  source: PublicSource | null;
  status: BindingStatus | null;
  /** The binding's language, as the server's modules describe it; null when none of them declares it. */
  language: PublicLanguage | null;
  asOf: string;
  live: boolean;
}

/** Who runs the query, if anyone: a source, the language's own way in, or nobody. */
function SourceLine({ binding, source, language }: Pick<Props, 'binding' | 'source' | 'language'>) {
  if (!binding) return <span className="muted">no query recorded</span>;
  if (binding.sourceId) {
    return (
      <span>
        pulled from <code>{binding.sourceId}</code>
        {source && <span className="muted"> · every {source.stepSeconds >= 60 ? `${source.stepSeconds / 60} min` : `${source.stepSeconds} s`}</span>}
      </span>
    );
  }
  if (language?.provenance) return <span className="muted">{withCode(language.provenance)}</span>;
  return <span className="muted">documented query — readings arrive by push or by hand</span>;
}

/** How the last pull went. */
function PullState({ status, asOf }: { status: BindingStatus; asOf: string }) {
  const text =
    status.state === 'ok'
      ? `last pull ${status.lastSuccessAt ? ago(status.lastSuccessAt, asOf) : 'ok'}`
      : status.state === 'pending'
        ? 'not pulled yet'
        : `${CATEGORY_TEXT[status.category ?? ''] ?? 'pull failing'}${status.httpStatus ? ` (HTTP ${status.httpStatus})` : ''}`;
  return (
    <span className={`pull pull-${status.state}`} title={status.detail ?? undefined}>
      {text}
    </span>
  );
}

export function Provenance({ binding, dashboardUrl, source, status, language, asOf, live }: Props) {
  const dash = safeHref(dashboardUrl);
  if (!binding && !dash) return null;
  // Built by the server from the source's public URL; checked again here like any link from the API.
  const way = binding ? status?.drillOut : null;
  const href = safeHref(way?.href);

  return (
    <div className="provenance">
      <div className="prov-head">
        <span className="prov-label">Source</span>
        <SourceLine binding={binding} source={source} language={language} />
        {live && binding?.sourceId && status && <PullState status={status} asOf={asOf} />}
      </div>
      {binding && (
        <pre className="query" aria-label={`${binding.language} query`}>
          <code>{binding.query}</code>
        </pre>
      )}
      {((way && href) || dash) && (
        <div className="prov-links">
          {way && href && (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {way.label} ↗
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
