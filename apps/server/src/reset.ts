// Re-seeds the demo universe relative to now. Refuses while the server runs,
// because the server keeps the log in memory and would append to a file whose
// sequence numbers it no longer matches.
import { rmSync } from 'node:fs';
import { generateDemo } from './demo.js';
import { dataFile, host, port } from './paths.js';
import { EventStore } from './store.js';

const running = await fetch(`http://${host}:${port}/api/health`).then(
  () => true,
  () => false,
);
if (running) {
  console.error(`The server is running on ${host}:${port}. Stop it first, then reset.`);
  process.exit(1);
}

const events = generateDemo(new Date());
rmSync(dataFile, { force: true });
EventStore.open(dataFile).replaceAll(events);
console.log(`Reset the demo universe: ${events.length} events → ${dataFile}`);
