// Starting the server: configuration is checked before anything is served —
// a bad sources file is an operator mistake, refused like a corrupt log rather
// than half-applied. Shared by the demo entry (main.ts) and the dogfood one.
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { seedEvents } from './seeds.js';
import type { Env, ServerSettings } from './settings.js';
import { Collector } from './sources/collector.js';
import { assertSafeToServe, loadSources } from './sources/config.js';
import { EventStore } from './store.js';

/** `env` is only where the sources' tokens are looked up, by the names the sources file gives. Resolves once it listens. */
export async function startServer(cfg: ServerSettings, env: Env = process.env): Promise<FastifyInstance> {
  const sources = loadSources(cfg.sourcesFile, env);
  assertSafeToServe(sources, cfg.host, cfg.allowRemote);

  const store = EventStore.open(cfg.dataFile);
  if (store.isEmpty) {
    store.replaceAll(seedEvents(cfg.seed, new Date()));
    console.log(`Seeded the ${cfg.seed} universe: ${store.all().length} events → ${cfg.dataFile}`);
  }

  const collector = new Collector({ store, sources, log: (m) => console.warn(`collector: ${m}`) });
  const app = await buildApp({ store, logger: true, ingestToken: cfg.ingestToken, webDist: cfg.webDist, collector });
  await app.listen({ port: cfg.port, host: cfg.host });
  console.log(`Requirement Universe API on http://${cfg.host}:${cfg.port} — ${store.all().length} events in ${cfg.dataFile}`);
  if (sources.length) {
    collector.start();
    console.log(`Pulling bound metrics from ${sources.map((s) => `${s.id} (every ${s.stepSeconds}s)`).join(', ')}`);
  }
  return app;
}
