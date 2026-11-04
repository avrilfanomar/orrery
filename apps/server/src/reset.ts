// Re-seeds a universe relative to now (the demo unless RU_SEED says otherwise).
// Refuses while the server runs, because the server keeps the log in memory
// and would append to a file whose sequence numbers it no longer matches.
import { rmSync } from 'node:fs';
import { dataFile, host, port } from './paths.js';
import { seedEvents, seedKindFrom } from './seeds.js';
import { EventStore } from './store.js';

const kind = seedKindFrom(process.env.RU_SEED);
const running = await fetch(`http://${host}:${port}/api/health`).then(
  () => true,
  () => false,
);
if (running) {
  console.error(`The server is running on ${host}:${port}. Stop it first, then reset.`);
  process.exit(1);
}

const events = seedEvents(kind, new Date());
rmSync(dataFile, { force: true });
EventStore.open(dataFile).replaceAll(events);
console.log(`Reset the ${kind} universe: ${events.length} events → ${dataFile}`);
