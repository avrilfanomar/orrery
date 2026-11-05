// Re-seeds a universe relative to now (the demo unless RU_SEED says otherwise).
// Refuses while a server writes the log: it keeps the log in memory and would
// append to a file whose sequence numbers it no longer matches. The new log is
// renamed over the old one only once it is complete (ADR 0008).
import { seedEvents } from './seeds.js';
import { baseUrl, serverSettings } from './settings.js';
import { EventStore } from './store.js';

const { dataFile, host, port, seed: kind } = serverSettings(process.env);
const running = await fetch(`${baseUrl(host, port)}/api/health`).then(
  () => true,
  () => false,
);
if (running) {
  console.error(`The server is running on ${host}:${port}. Stop it first, then reset.`);
  process.exit(1);
}

const events = seedEvents(kind, new Date());
try {
  // `fresh`: the log is not read, so a damaged one can be reset; its lock still refuses a server on another port.
  const store = EventStore.open(dataFile, { fresh: true });
  store.replaceAll(events);
  store.close();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
console.log(`Reset the ${kind} universe: ${events.length} events → ${dataFile}`);
