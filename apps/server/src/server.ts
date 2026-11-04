// Starting the server: configuration is checked before anything is served —
// a bad sources file is an operator mistake, refused like a corrupt log rather
// than half-applied. Shared by the demo entry (main.ts) and the dogfood one.
import { buildApp } from './app.js';
import { webDist as defaultWebDist } from './paths.js';
import { seedEvents, type SeedKind } from './seeds.js';
import { Collector } from './sources/collector.js';
import { assertSafeToServe, loadSources } from './sources/config.js';
import { EventStore } from './store.js';

export interface ServerConfig {
  dataFile: string;
  host: string;
  port: number;
  /** What an empty log starts as. */
  seed: SeedKind;
  webDist?: string;
  env?: Record<string, string | undefined>;
}

export async function startServer(cfg: ServerConfig): Promise<void> {
  const env = cfg.env ?? process.env;
  const sources = loadSources(env);
  assertSafeToServe(sources, cfg.host, env);

  const store = EventStore.open(cfg.dataFile);
  if (store.isEmpty) {
    store.replaceAll(seedEvents(cfg.seed, new Date()));
    console.log(`Seeded the ${cfg.seed} universe: ${store.all().length} events → ${cfg.dataFile}`);
  }

  const collector = new Collector({ store, sources, log: (m) => console.warn(`collector: ${m}`) });
  const app = await buildApp({ store, logger: true, ingestToken: env.RU_INGEST_TOKEN ?? null, webDist: cfg.webDist ?? defaultWebDist, collector });
  await app.listen({ port: cfg.port, host: cfg.host });
  console.log(`Requirement Universe API on http://${cfg.host}:${cfg.port} — ${store.all().length} events in ${cfg.dataFile}`);
  if (sources.length) {
    collector.start();
    console.log(`Pulling bound metrics from ${sources.map((s) => `${s.id} (every ${s.stepSeconds}s)`).join(', ')}`);
  }
}
