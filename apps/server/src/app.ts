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
import { z } from 'zod';
import { bearerMatches, guard, refuse, RESERVED_ACTORS } from './guard.js';
import { Collector } from './sources/collector.js';
import type { EventStore } from './store.js';

export interface AppOptions {
  store: EventStore;
  clock?: () => Date;
  /** When set, every reading, by either route, requires `Authorization: Bearer <token>` (ADR 0010). */
  ingestToken?: string | null;
  /** Names besides loopback and IP addresses that a request may address the server by (ADR 0010). */
  allowedHosts?: readonly string[];
  /** The built web app to serve, if present. */
  webDist?: string | null;
  /** Fastify's log of warnings and errors: off, to stdout, or into a stream the caller reads (one JSON line per entry). */
  logger?: boolean | { write(line: string): void };
  /** Pulls bound metrics from configured sources (ADR 0002). Defaults to one with no sources. */
  collector?: Collector;
}

const HTTP_STATUS = { invalid: 400, not_found: 404, conflict: 409 } as const;
/**
 * An instant that means the same on every server: a date (UTC midnight, as
 * ECMAScript reads it) or a date-time with Z or an offset. Without a zone,
 * Date.parse would use the server's own (flexibility.test.ts). An offset
 * beyond ±23:59 is well spelled but names no instant (reliability.test.ts).
 */
const ZonedInstantSchema = z.union([z.string().date(), z.string().datetime({ offset: true })]).refine((v) => !Number.isNaN(Date.parse(v)));
/** The most readings one webhook request may carry; the body limit must leave room for a full batch (efficiency.test.ts). */
export const MAX_READINGS_PER_REQUEST = 5000;

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const logger = opts.logger ? { level: 'warn', ...(typeof opts.logger === 'object' ? { stream: opts.logger } : {}) } : false;
  const app = Fastify({ logger, bodyLimit: 4 * 1024 * 1024 });
  const now = () => (opts.clock?.() ?? new Date()).toISOString();
  const { store } = opts;
  const collector = opts.collector ?? new Collector({ store, sources: [] });
  const sources = collector.catalog;
  guard(app, opts.allowedHosts ?? []);
  const tokenOk = (req: { headers: { authorization?: string } }) => !opts.ingestToken || bearerMatches(req.headers.authorization, opts.ingestToken);
  const NEEDS_TOKEN = 'A valid ingest token is required';

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof DomainError) return reply.code(HTTP_STATUS[err.code]).send({ error: err.message, code: err.code });
    const { statusCode: status, message } = err as { statusCode?: number; message?: string };
    if (status && status < 500) return reply.code(status).send({ error: message ?? 'Bad request', code: 'invalid' });
    // The caller gets an id and no detail; the log gets the detail under the same id (ADR 0007).
    req.log.error({ err }, 'request failed');
    return reply.code(500).send({ error: 'Internal error', code: 'internal', requestId: req.id });
  });

  const asOfFrom = (query: unknown): string | null => {
    const v = (query as { asOf?: string } | undefined)?.asOf;
    if (!v) return null;
    if (!ZonedInstantSchema.safeParse(v).success) throw new DomainError('invalid', 'asOf must be an ISO-8601 date, or a date-time with Z or an offset');
    return new Date(Date.parse(v)).toISOString();
  };

  // Identity is out of scope for the PoC: the caller names itself, but not as one of the server's own writers.
  const actorFrom = (headers: Record<string, unknown>): string => {
    const raw = headers['x-actor'];
    const v = typeof raw === 'string' ? raw.trim().slice(0, 80) : '';
    if (RESERVED_ACTORS.includes(v.toLowerCase())) throw new DomainError('invalid', `“${v}” names one of the server’s own writers (${RESERVED_ACTORS.join(', ')}); sign with another name in x-actor`);
    return v || 'you';
  };

  app.get('/api/health', async () => ({ ok: true, events: store.all().length, lastEventAt: store.all().at(-1)?.at ?? null }));

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
    // The token guards readings, not a route: otherwise a reading refused by the webhook would be accepted here.
    if (cmd.type === 'reading.record' && !tokenOk(req)) return refuse(req, reply, 401, 'ingest token', NEEDS_TOKEN);
    const events = decide(project(store.all()), cmd, { now: now(), actor: actorFrom(req.headers), sources });
    return reply.code(201).send({ events: store.append(events) });
  });

  /**
   * The generic ingestion webhook: one reading, or `{ readings: [...] }`.
   * All-or-nothing, so a batch with one bad reading leaves no partial trace.
   */
  app.post('/api/readings', async (req, reply) => {
    if (!tokenOk(req)) return refuse(req, reply, 401, 'ingest token', NEEDS_TOKEN);
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
