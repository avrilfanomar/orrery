// The collector (ADR 0002, decision 4): pulls every bound metric from its
// configured source, through the adapter its kind's module brings (ADR 0013),
// and records the answers through `decide`, like any other reading. A failed
// or ambiguous pull records nothing; the node goes stale and reports unknown.
// Pull outcomes are operational state, held here in memory — a failed pull is
// not a fact about the requirement, its staleness is.
import {
  bindingSince,
  currentDefinition,
  decide,
  DomainError,
  parseCommand,
  project,
  PULL_SOURCE_PREFIX,
  type NewEvent,
  type SourceCatalog,
  type Universe,
} from '@ru/core';
import type { DrillOut, PullFailure } from '@ru/module-kit';
import type { EventStore } from '../store.js';
import { catalogOf, drillOutOf, kindOf, toPublic, type PublicSource, type ResolvedSource } from './config.js';

const H = 3.6e6;
/** Catch-up after downtime reaches back at most this far (or 1 000 steps, whichever is shorter). */
const MAX_CATCH_UP_MS = 24 * H;
const MAX_CATCH_UP_STEPS = 1000;
/** Points per request — far below the caps sources set (Prometheus: 11 000). */
const CHUNK_POINTS = 1000;

/** Why a binding has no fresh readings: the adapter's reasons, and the collector's own. */
export type FailureCategory = PullFailure | 'rejected' | 'internal' | 'not-configured' | 'token-missing';

export interface BindingStatus {
  nodeId: string;
  sourceId: string;
  state: 'ok' | 'failing' | 'pending';
  category: FailureCategory | null;
  httpStatus: number | null;
  /** Our own words, never upstream text. */
  detail: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  /** Readings recorded by the last successful pull. */
  recorded: number;
  /** Where a person can look at the query in the source's own UI, if it has a public URL. */
  drillOut: DrillOut | null;
}

export interface SourcesView {
  sources: PublicSource[];
  bindings: BindingStatus[];
}

export interface CollectorOptions {
  store: EventStore;
  sources: readonly ResolvedSource[];
  clock?: () => Date;
  fetch?: typeof fetch;
  /** Called on state changes only (ok → failing, failing → ok), never per tick. */
  log?: (message: string) => void;
}

const gridCeil = (t: number, step: number) => Math.ceil(t / step) * step;
const gridFloor = (t: number, step: number) => Math.floor(t / step) * step;

export class Collector {
  readonly catalog: SourceCatalog;
  private readonly sources: Map<string, ResolvedSource>;
  private readonly status = new Map<string, BindingStatus>();
  private readonly inFlight = new Set<string>();
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly clock: () => Date;

  constructor(private readonly opts: CollectorOptions) {
    this.sources = new Map(opts.sources.map((s) => [s.id, s]));
    this.catalog = catalogOf(opts.sources);
    this.clock = opts.clock ?? (() => new Date());
  }

  /** One loop per source, so a slow source never holds up another. No sources, no loops. */
  start(): void {
    for (const s of this.sources.values()) {
      if (s.tokenMissing) {
        this.opts.log?.(`source ${s.id}: ${s.tokenEnv} is not set — it will not be queried`);
        continue;
      }
      // A tick never rejects: an unhandled rejection would stop the whole server over one pull (ADR 0008).
      const run = () => void this.tickSource(s.id).catch((err: unknown) => this.opts.log?.(`source ${s.id}: the tick failed — ${(err as Error).message}`));
      run();
      this.timers.push(setInterval(run, s.stepSeconds * 1000));
    }
  }

  stop(): void {
    this.timers.splice(0).forEach(clearInterval);
  }

  /** Pulls every binding to one source. Each binding is single-flight: an unfinished pull skips the tick. */
  async tickSource(sourceId: string): Promise<void> {
    const src = this.sources.get(sourceId);
    if (!src || src.tokenMissing) return;
    const u = project(this.opts.store.all());
    const ids = [...u.nodes.values()]
      .filter((n) => n.lifecycle === 'active' && currentDefinition(n).binding?.sourceId === sourceId && currentDefinition(n).measure)
      .map((n) => n.id);
    await Promise.all(ids.map((id) => this.pullBinding(src, id)));
  }

  private async pullBinding(src: ResolvedSource, nodeId: string): Promise<void> {
    const key = `${src.id}\u0000${nodeId}`;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    try {
      await this.pull(src, nodeId);
    } catch (err) {
      // Anything but a refusal (which `pull` handles) is this server's own fault, a full disk say: it fails this binding, never the others.
      const at = new Date(this.clock().getTime()).toISOString();
      this.fail(src.id, nodeId, at, 'internal', null, 'the answer could not be recorded on this server; its log says why', (err as Error).message);
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async pull(src: ResolvedSource, nodeId: string): Promise<void> {
    const source = `${PULL_SOURCE_PREFIX}${src.id}`;
    const step = src.stepSeconds * 1000;
    const nowMs = this.clock().getTime();
    const attemptAt = new Date(nowMs).toISOString();

    const u = project(this.opts.store.all());
    const n = u.nodes.get(nodeId);
    const binding = n && currentDefinition(n).binding;
    if (!n || !binding || binding.sourceId !== src.id) return;

    // Settled instants only: the newest point waits for the latest scrape to land.
    const end = gridFloor(nowMs - src.settleSeconds * 1000, step);
    const since = Date.parse(bindingSince(n)!);
    const horizon = nowMs - Math.min(MAX_CATCH_UP_MS, MAX_CATCH_UP_STEPS * step);
    const last = lastPulledAt(u, nodeId, source, nowMs);
    // The next grid point after the last pulled reading — on *today's* grid, so
    // a changed stepSeconds realigns instead of asking for off-grid instants.
    const start = Math.max(gridCeil(since, step), gridCeil(horizon, step), last === null ? -Infinity : gridCeil(last + 1, step));
    if (start > end) {
      this.succeed(src.id, nodeId, attemptAt, 0, false);
      return;
    }

    let recorded = 0;
    for (let cs = start; cs <= end; cs += CHUNK_POINTS * step) {
      const ce = Math.min(end, cs + (CHUNK_POINTS - 1) * step);
      const res = await kindOf(src).queryRange(src, { query: binding.query, start: cs, end: ce, stepSeconds: src.stepSeconds }, this.opts.fetch ?? fetch);
      if (!res.ok) {
        this.fail(src.id, nodeId, attemptAt, res.category, res.httpStatus ?? null, res.detail ?? null);
        return;
      }
      // Judge against a fresh projection: the binding may have been redefined
      // while the request was in flight, and then `decide` refuses the chunk.
      const fresh = project(this.opts.store.all());
      const have = new Set((fresh.readings.get(nodeId) ?? []).filter((r) => r.source === source).map((r) => r.observedAt));
      const ctx = { now: new Date(this.clock().getTime()).toISOString(), actor: 'collector', sources: this.catalog, origin: 'collector' as const };
      const events: NewEvent[] = [];
      try {
        for (const s of res.samples) {
          if (s.t < cs || s.t > ce || s.t % step !== 0) continue; // only the instants we asked for
          const observedAt = new Date(s.t).toISOString();
          if (have.has(observedAt)) continue; // already recorded: skip, don't refuse
          events.push(...decide(fresh, parseCommand({ type: 'reading.record', data: { nodeId, value: s.value, observedAt, source } }), ctx));
        }
      } catch (err) {
        if (!(err instanceof DomainError)) throw err;
        this.fail(src.id, nodeId, attemptAt, 'rejected', null, err.message);
        return;
      }
      recorded += this.opts.store.append(events).length;
    }
    this.succeed(src.id, nodeId, attemptAt, recorded, true);
  }

  private entry(sourceId: string, nodeId: string): BindingStatus {
    const key = `${sourceId}\u0000${nodeId}`;
    let s = this.status.get(key);
    if (!s) {
      s = { nodeId, sourceId, state: 'pending', category: null, httpStatus: null, detail: null, lastAttemptAt: null, lastSuccessAt: null, recorded: 0, drillOut: null };
      this.status.set(key, s);
    }
    return s;
  }

  private succeed(sourceId: string, nodeId: string, at: string, recorded: number, queried: boolean): void {
    const s = this.entry(sourceId, nodeId);
    if (s.state === 'failing') this.opts.log?.(`pull ${sourceId} → ${nodeId}: recovered`);
    Object.assign(s, { state: 'ok', category: null, httpStatus: null, detail: null, lastAttemptAt: at });
    if (queried) Object.assign(s, { lastSuccessAt: at, recorded });
  }

  /** `cause` goes to the server's log only: it may name paths the API must not show. */
  private fail(sourceId: string, nodeId: string, at: string, category: FailureCategory, httpStatus: number | null, detail: string | null, cause?: string): void {
    const s = this.entry(sourceId, nodeId);
    if (s.state !== 'failing' || s.category !== category) {
      this.opts.log?.(`pull ${sourceId} → ${nodeId}: ${category}${httpStatus ? ` (HTTP ${httpStatus})` : ''}${detail ? ` — ${detail}` : ''}${cause ? ` (${cause})` : ''}`);
    }
    Object.assign(s, { state: 'failing', category, httpStatus, detail, lastAttemptAt: at });
  }

  /** Every configured source (allowlisted fields only) and every live binding's pull state. */
  describe(u: Universe): SourcesView {
    const bindings: BindingStatus[] = [];
    for (const n of u.nodes.values()) {
      const b = currentDefinition(n).binding;
      if (n.lifecycle !== 'active' || !b?.sourceId) continue;
      const src = this.sources.get(b.sourceId);
      const known = this.status.get(`${b.sourceId}\u0000${n.id}`);
      if (!src) {
        bindings.push(derived(n.id, b.sourceId, 'not-configured', `no source “${b.sourceId}” is configured on this server`, null));
        continue;
      }
      const drillOut = drillOutOf(src, b.query);
      if (src.tokenMissing) bindings.push(derived(n.id, b.sourceId, 'token-missing', `${src.tokenEnv} is not set on this server`, drillOut));
      else bindings.push({ ...(known ?? this.entry(b.sourceId, n.id)), drillOut });
    }
    return { sources: [...this.sources.values()].map(toPublic), bindings };
  }
}

function derived(nodeId: string, sourceId: string, category: FailureCategory, detail: string, drillOut: DrillOut | null): BindingStatus {
  return { nodeId, sourceId, state: 'failing', category, httpStatus: null, detail, lastAttemptAt: null, lastSuccessAt: null, recorded: 0, drillOut };
}

/**
 * The newest reading this source pulled for the node, ignoring any stamped in
 * the future (a clock that stepped back must not freeze pulling).
 */
function lastPulledAt(u: Universe, nodeId: string, source: string, nowMs: number): number | null {
  const list = u.readings.get(nodeId) ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i]!;
    if (r.source !== source) continue;
    const t = Date.parse(r.observedAt);
    if (t <= nowMs) return t;
  }
  return null;
}
