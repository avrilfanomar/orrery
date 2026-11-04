import { dataFile, host, port } from './paths.js';
import { seedKindFrom } from './seeds.js';
import { startServer } from './server.js';

await startServer({ dataFile, host, port, seed: seedKindFrom(process.env.RU_SEED) });
