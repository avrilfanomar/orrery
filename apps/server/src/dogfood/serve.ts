// `pnpm dogfood:serve`: the repository's own universe in the console, on its
// own log and port, seeded with the model (never the demo) and fed by
// `pnpm dogfood` rather than the simulator (ADR 0003).
import { startServer, stopOnSignals } from '../server.js';
import { dogfoodSettings, serverSettings } from '../settings.js';

const dogfood = dogfoodSettings(process.env);
stopOnSignals(await startServer({ ...serverSettings(process.env), dataFile: dogfood.file, port: dogfood.port, seed: 'dogfood' }));
