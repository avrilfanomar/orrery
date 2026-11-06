// Starting the server: configuration is checked before anything is served —
// a bad sources file is an operator mistake, refused like a corrupt log rather
// than half-applied. Shared by the demo entry (main.ts) and the dogfood one.
import { isIP } from 'node:net';
import { constants } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { loadRepos } from './repos.js';
import { seedEvents } from './seeds.js';
import type { Env, ServerSettings } from './settings.js';
import { Collector } from './sources/collector.js';
import { assertSafeToServe, loadSources } from './sources/config.js';
import { EventStore } from './store.js';

/** `env` is only where the sources' tokens are looked up, by the names the sources file gives. Resolves once it listens. */
export async function startServer(cfg: ServerSettings, env: Env = process.env): Promise<FastifyInstance> {
  const sources = loadSources(cfg.sourcesFile, env);
  assertSafeToServe(sources, cfg.host, cfg.allowRemote);
  const repos = loadRepos(cfg.reposFile);

  const store = EventStore.open(cfg.dataFile);
  if (store.isEmpty) {
    store.replaceAll(seedEvents(cfg.seed, new Date()));
    console.log(`Seeded the ${cfg.seed} universe: ${store.all().length} events → ${cfg.dataFile}`);
  }

  const collector = new Collector({ store, sources, log: (m) => console.warn(`collector: ${m}`) });
  // A server bound to a name answers to that name; a wildcard or an address adds none.
  const allowedHosts = isIP(cfg.host) ? cfg.allowedHosts : [...cfg.allowedHosts, cfg.host.toLowerCase()];
  const app = await buildApp({ store, logger: true, ingestToken: cfg.ingestToken, allowedHosts, webDist: cfg.webDist, collector, repos });
  // Closing the app stops pulling and releases the log, so a clean stop leaves the next start nothing to clear (ADR 0008).
  app.addHook('onClose', async () => {
    collector.stop();
    store.close();
  });
  try {
    await app.listen({ port: cfg.port, host: cfg.host });
  } catch (err) {
    await app.close();
    throw err;
  }
  console.log(`Orrery API on http://${cfg.host}:${cfg.port} — ${store.all().length} events in ${cfg.dataFile}`);
  if (sources.length) {
    collector.start();
    console.log(`Pulling bound metrics from ${sources.map((s) => `${s.id} (every ${s.stepSeconds}s)`).join(', ')}`);
  }
  return app;
}

/** A repeat of the signal sooner than this is the same request: a terminal signals the whole process group, and `tsx` relays the signal to its child as well. */
const ECHO_MS = 1000;

/**
 * SIGINT or SIGTERM closes the app (Fastify lets the requests in flight
 * finish), stops pulling and releases the log, then exits 0. A second signal
 * later than an echo stops the process at once; the log is still released on
 * the way out. The listeners stay registered while it closes, so neither
 * Node's default nor tsx's own handler ends it half-closed.
 */
export function stopOnSignals(app: FastifyInstance): void {
  let since: number | null = null;
  const onSignal = (signal: NodeJS.Signals) => {
    if (since !== null) {
      if (performance.now() - since >= ECHO_MS) {
        console.log(`${signal} again: stopping now`);
        process.exit(128 + constants.signals[signal]);
      }
      return;
    }
    since = performance.now();
    console.log(`${signal}: stopping once the requests in flight finish`);
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error(err);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}
