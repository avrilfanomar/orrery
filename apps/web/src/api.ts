import type { CommandInput, NodeDetailView, OrreryEvent, Repository, TimelineEntry, UniverseView } from '@orrery/core';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? res.statusText);
  return body as T;
}

/**
 * Mirrors the server's `GET /api/sources` (apps/server/src/sources, ADR 0013):
 * public fields only. The console knows no kind and no language by name; what
 * it shows about either comes from here.
 */
export interface PublicSource {
  id: string;
  kind: string;
  /** The languages it runs. */
  runs: string[];
  publicUrl: string | null;
  stepSeconds: number;
  problem: 'token-missing' | null;
  details: Record<string, string | number | boolean | null>;
}
export interface BindingStatus {
  nodeId: string;
  sourceId: string;
  state: 'ok' | 'failing' | 'pending';
  category: string | null;
  httpStatus: number | null;
  detail: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  recorded: number;
  /** Opens the query in the source's own UI, built by the server from the public URL. */
  drillOut: { href: string; label: string } | null;
}
/** A language the installed modules bring. */
export interface PublicLanguage {
  id: string;
  label: string;
  hint: string;
  /** How to describe a binding nobody pulls, when the language has its own way in. */
  provenance: string | null;
  /** Installed source kinds that run it; empty when nothing can pull a query in it. */
  kinds: string[];
}
export interface SourcesView {
  sources: PublicSource[];
  bindings: BindingStatus[];
  languages: PublicLanguage[];
}

const withAsOf = (path: string, asOf: string | null, extra = '') => {
  const params = new URLSearchParams(extra);
  if (asOf) params.set('asOf', asOf);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
};

export const api = {
  universe: (asOf: string | null) => request<UniverseView>(withAsOf('/api/universe', asOf)),
  node: (id: string, asOf: string | null) => request<NodeDetailView>(withAsOf(`/api/nodes/${encodeURIComponent(id)}`, asOf)),
  changes: (asOf: string | null, limit = 300) => request<TimelineEntry[]>(withAsOf('/api/changes', asOf, `limit=${limit}`)),
  sources: () => request<SourcesView>('/api/sources'),
  /** The repositories references lead into (ADR 0014): links out are built from their templates, in core. */
  repos: () => request<{ repositories: Repository[] }>('/api/repos').then((r) => r.repositories),
  command: (cmd: CommandInput, actor: string) =>
    request<{ events: OrreryEvent[] }>('/api/commands', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor': actor },
      body: JSON.stringify(cmd),
    }),
};
