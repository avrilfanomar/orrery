// Prometheus, reached directly or through Grafana (ADR 0002, ADR 0013). It
// brings PromQL and one source kind: it turns one range query into samples or a
// failure category, and builds the link that opens a query where people
// already look. Which instants to ask for, and what to do with the answer,
// belongs to the server's collector.
//
// The binding only supplies the query text. Path, method and host are fixed
// here, so a binding can't reach admin endpoints through the Grafana proxy or
// point the server anywhere new.
import { defineSourceKind, type OrreryModule, type PullResult, type RangeQuery, type Sample, type SourceBasics } from '@orrery/module-kit';
import { z } from 'zod';

/** Reach Prometheus through Grafana's datasource proxy instead of directly. Grafana is a route, not a kind. */
const settings = {
  grafana: z.object({ datasourceUid: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'datasourceUid: letters, digits, _ and -') }).strict().optional(),
};
type Source = SourceBasics & { grafana?: { datasourceUid: string } };

/** Joins a fixed API path onto a base URL, keeping any subpath (`https://host/grafana`). */
export function endpoint(source: Pick<Source, 'url' | 'grafana'>): string {
  const base = new URL(source.url);
  const prefix = base.pathname.replace(/\/+$/, '');
  const api = source.grafana ? `/api/datasources/proxy/uid/${encodeURIComponent(source.grafana.datasourceUid)}/api/v1/query_range` : '/api/v1/query_range';
  return `${base.origin}${prefix}${api}`;
}

interface PromResponse {
  status?: string;
  errorType?: string;
  data?: { resultType?: string; result?: { metric?: Record<string, string>; values?: [number, string][] }[] };
}

export async function queryRange(source: Source, q: RangeQuery, fetchImpl: typeof fetch = fetch): Promise<PullResult> {
  const body = new URLSearchParams({
    query: q.query,
    start: String(q.start / 1000),
    end: String(q.end / 1000),
    step: `${q.stepSeconds}s`,
    timeout: `${source.timeoutSeconds}s`,
  });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (source.token) headers.authorization = `Bearer ${source.token}`;

  let res: Response;
  try {
    res = await fetchImpl(endpoint(source), {
      method: 'POST',
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(source.timeoutSeconds * 1000),
    });
  } catch (err) {
    const name = (err as { name?: string }).name;
    return { ok: false, category: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable' };
  }

  const json = (await res.json().catch(() => null)) as PromResponse | null;
  // Upstream error text is never passed on: it can echo internals. The status
  // code and Prometheus's own error type are enough to act on.
  if (!res.ok || json?.status !== 'success') {
    if (res.status === 400 || json?.errorType === 'bad_data') return { ok: false, category: 'bad-query', httpStatus: res.status };
    return { ok: false, category: 'http', httpStatus: res.status };
  }
  const result = json.data?.resultType === 'matrix' ? (json.data.result ?? []) : null;
  if (!result) return { ok: false, category: 'multi-series', detail: `the query returns a ${json.data?.resultType ?? 'non-matrix'} result; it must return one series` };
  if (result.length === 0) return { ok: false, category: 'empty' };
  if (result.length > 1) {
    return { ok: false, category: 'multi-series', detail: `the query returns ${result.length} series; aggregate it to one, e.g. sum(…)` };
  }
  const samples: Sample[] = [];
  let skipped = 0;
  for (const [ts, raw] of result[0]!.values ?? []) {
    const value = Number(raw);
    // NaN and ±Inf are "no answer", never a number to judge (ADR 0002, decision 4).
    if (!Number.isFinite(value) || !Number.isFinite(ts)) {
      skipped++;
      continue;
    }
    samples.push({ t: Math.round(ts * 1000), value });
  }
  return { ok: true, samples, skipped };
}

/** Opens the query itself: Grafana Explore on the datasource, or the Prometheus graph page. */
export function drillOut(publicUrl: string, source: Pick<Source, 'grafana'>, query: string): { href: string; label: string } {
  const base = new URL(publicUrl).href.replace(/\/+$/, '');
  if (source.grafana) {
    const uid = source.grafana.datasourceUid;
    const panes = { orrery: { datasource: uid, queries: [{ refId: 'A', expr: query, datasource: { type: 'prometheus', uid } }], range: { from: 'now-24h', to: 'now' } } };
    return { href: `${base}/explore?schemaVersion=1&panes=${encodeURIComponent(JSON.stringify(panes))}`, label: 'Open in Grafana Explore' };
  }
  return { href: `${base}/graph?g0.expr=${encodeURIComponent(query)}&g0.tab=0&g0.range_input=1d`, label: 'Open in Prometheus' };
}

export const prometheus: OrreryModule = {
  id: 'prometheus',
  languages: [{ id: 'promql', label: 'PromQL', hint: 'Must return one series in the measure’s unit — aggregate with sum(…) if needed. Changing it later starts a new version.' }],
  sources: [
    defineSourceKind({
      kind: 'prometheus',
      runs: ['promql'],
      settings,
      details: (s) => ({ route: s.grafana ? 'grafana' : 'direct' }),
      queryRange,
      drillOut,
    }),
  ],
};
