import { buildApp } from './app.js';
import { generateDemo } from './demo.js';
import { dataFile, host, port, webDist } from './paths.js';
import { Collector } from './sources/collector.js';
import { assertSafeToServe, loadSources } from './sources/config.js';
import { EventStore } from './store.js';

// Configuration is checked before anything is served: a bad sources file is
// an operator mistake, refused like a corrupt log rather than half-applied.
const sources = loadSources(process.env);
assertSafeToServe(sources, host, process.env);

const store = EventStore.open(dataFile);
if (store.isEmpty) {
  store.replaceAll(generateDemo(new Date()));
  console.log(`Seeded the demo universe: ${store.all().length} events → ${dataFile}`);
}

const collector = new Collector({ store, sources, log: (m) => console.warn(`collector: ${m}`) });
const app = await buildApp({ store, logger: true, ingestToken: process.env.RU_INGEST_TOKEN ?? null, webDist, collector });
await app.listen({ port, host });
console.log(`Requirement Universe API on http://${host}:${port} — ${store.all().length} events in ${dataFile}`);
if (sources.length) {
  collector.start();
  console.log(`Pulling bound metrics from ${sources.map((s) => `${s.id} (every ${s.stepSeconds}s)`).join(', ')}`);
}
