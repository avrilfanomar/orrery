import { buildApp } from './app.js';
import { generateDemo } from './demo.js';
import { dataFile, host, port, webDist } from './paths.js';
import { EventStore } from './store.js';

const store = EventStore.open(dataFile);
if (store.isEmpty) {
  store.replaceAll(generateDemo(new Date()));
  console.log(`Seeded the demo universe: ${store.all().length} events → ${dataFile}`);
}

const app = await buildApp({ store, logger: true, ingestToken: process.env.RU_INGEST_TOKEN ?? null, webDist });
await app.listen({ port, host });
console.log(`Requirement Universe API on http://${host}:${port} — ${store.all().length} events in ${dataFile}`);
