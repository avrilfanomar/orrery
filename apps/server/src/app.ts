// The HTTP shell. It parses, delegates to the pure core, and appends — no
// domain rule lives here.
import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  buildChangeFeed,
  buildNodeDetail,
  buildUniverseView,
  decide,
  DomainError,
  parseCommand,
  project,
  type NewEvent,
} from '@ru/core';
import { Collector } from './sources/collector.js';
import type { EventStore } from './store.js';

export interface AppOptions {
  store: EventStore;
  clock?: () => Date;
  /** When set, `POST /api/readings` requires `Authorization: Bearer <token>`. */
  ingestToken?: string | null;
  /** The built web app to serve, if present. */
  webDist?: string | null;
  logger?: boolean;
  /** Pulls bound metrics from configured sources (ADR 0002). Defaults to one with no sources. */
  collector?: Collector;
}

const HTTP_STATUS = { invalid: 400, not_found: 404, conflict: 409 } as const;
const MAX_READINGS_PER_REQUEST = 5000;

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ? { level: 'warn' } : false, bodyLimit: 4 * 1024 * 1024 });
  const now = () => (opts.clock?.() ?? new Date()).toISOString();
  const { store } = opts;
  const collector = opts.collector ?? new Collector({ store, sources: [] });
  const sources = collector.catalog;

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DomainError) return reply.code(HTTP_STATUS[err.code]).send({ error: err.message, code: err.code });
    const { statusCode: status, message } = err as { statusCode?: number; message?: string };
    if (status && status < 500) return reply.code(status).send({ error: message ?? 'Bad request', code: 'invalid' });
    app.log.error(err);
    return reply.code(500).send({ error: 'Internal error', code: 'internal' });
  });

  const asOfFrom = (query: unknown): string | null => {
    const v = (query as { asOf?: string } | undefined)?.asOf;
    if (!v) return null;
    const t = Date.parse(v);
    if (Number.isNaN(t)) throw new DomainError('invalid', 'asOf must be an ISO-8601 timestamp');
    return new Date(t).toISOString();
  };

  // Identity is out of scope for the PoC: the caller names itself.
  const actorFrom = (headers: Record<string, unknown>): string => {
    const raw = headers['x-actor'];
    const v = typeof raw === 'string' ? raw.trim().slice(0, 80) : '';
    return v || 'you';
  };

  app.get('/api/health', async () => ({ ok: true, events: store.all().length }));

  app.get('/api/universe', async (req) => buildUniverseView(store.all(), { asOf: asOfFrom(req.query), now: now() }));

  app.get<{ Params: { id: string } }>('/api/nodes/:id', async (req) => {
    const detail = buildNodeDetail(store.all(), req.params.id, { asOf: asOfFrom(req.query), now: now() });
    if (!detail) throw new DomainError('not_found', `Node “${req.params.id}” does not exist`);
    return detail;
  });

  app.get('/api/changes', async (req) => {
    const limit = Number((req.query as { limit?: string }).limit ?? 60);
    return buildChangeFeed(store.all(), { asOf: asOfFrom(req.query), now: now(), limit: Math.min(500, Math.max(1, limit || 60)) });
  });

  /** Configured sources (public fields only) and the pull state of every binding to one. */
  app.get('/api/sources', async () => collector.describe(project(store.all())));

  app.post('/api/commands', async (req, reply) => {
    const cmd = parseCommand(req.body);
    const events = decide(project(store.all()), cmd, { now: now(), actor: actorFrom(req.headers), sources });
    return reply.code(201).send({ events: store.append(events) });
  });

  /**
   * The generic ingestion webhook: one reading, or `{ readings: [...] }`.
   * All-or-nothing, so a batch with one bad reading leaves no partial trace.
   */
  app.post('/api/readings', async (req, reply) => {
    if (opts.ingestToken && req.headers.authorization !== `Bearer ${opts.ingestToken}`) {
      return reply.code(401).send({ error: 'A valid ingest token is required', code: 'unauthorized' });
    }
    const body = req.body as { readings?: unknown } | null;
    const list: unknown[] = Array.isArray(body?.readings) ? body.readings : [body];
    if (list.length === 0) throw new DomainError('invalid', 'No readings in the request');
    if (list.length > MAX_READINGS_PER_REQUEST) throw new DomainError('invalid', `At most ${MAX_READINGS_PER_REQUEST} readings per request`);
    const u = project(store.all());
    const t = now();
    const events: NewEvent[] = [];
    list.forEach((r, i) => {
      try {
        events.push(...decide(u, parseCommand({ type: 'reading.record', data: r }), { now: t, actor: 'ingest', sources }));
      } catch (err) {
        if (err instanceof DomainError) throw new DomainError(err.code, `readings[${i}]: ${err.message}`);
        throw err;
      }
    });
    return reply.code(201).send({ accepted: store.append(events).length });
  });

  if (opts.webDist && existsSync(opts.webDist)) {
    await app.register(fastifyStatic, { root: opts.webDist });
    app.setNotFoundHandler((req, reply) =>
      req.method === 'GET' && !req.url.startsWith('/api/')
        ? reply.sendFile('index.html')
        : reply.code(404).send({ error: 'Not found', code: 'not_found' }),
    );
  }

  return app;
}
