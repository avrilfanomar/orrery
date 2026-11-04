import type { CommandInput, NodeDetailView, RuEvent, TimelineEntry, UniverseView } from '@ru/core';

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
  command: (cmd: CommandInput, actor: string) =>
    request<{ events: RuEvent[] }>('/api/commands', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor': actor },
      body: JSON.stringify(cmd),
    }),
};
