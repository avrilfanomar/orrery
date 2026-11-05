import { startServer } from './server.js';
import { serverSettings } from './settings.js';

await startServer(serverSettings(process.env));
