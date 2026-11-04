// `pnpm dogfood:serve`: the repository's own universe in the console, on its
// own log and port, seeded with the model (never the demo) and fed by
// `pnpm dogfood` rather than the simulator (ADR 0003).
import { dogfoodFile, dogfoodPort, host } from '../paths.js';
import { startServer } from '../server.js';

await startServer({ dataFile: dogfoodFile, host, port: dogfoodPort, seed: 'dogfood' });
