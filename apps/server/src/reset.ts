// Re-seeds a universe relative to now (the demo unless ORRERY_SEED says otherwise).
// Refuses while a server writes the log: it keeps the log in memory and would
// append to a file whose sequence numbers it no longer matches. The new log is
// renamed over the old one only once it is complete (ADR 0008), and the old one
// stays beside it, named for the moment of the reset (ADR 0009): a reset typed
// in the wrong shell, or with the wrong ORRERY_DATA_FILE, can be undone.
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

const now = new Date();
const events = seedEvents(kind, now);
const keep = `${dataFile}.${now.toISOString().replace(/[:.]/g, '-')}.bak`;
let kept: string | null;
try {
  // `fresh`: the log is not read, so a damaged one can be reset; its lock still refuses a server on another port.
  const store = EventStore.open(dataFile, { fresh: true });
  ({ kept } = store.replaceAll(events, keep));
  store.close();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
console.log(`Reset the ${kind} universe: ${events.length} events → ${dataFile}`);
if (kept) console.log(`The log it replaced is kept as ${kept}. To undo the reset, stop the server and move it back.`);
