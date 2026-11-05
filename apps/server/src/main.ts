import { startServer, stopOnSignals } from './server.js';
import { serverSettings } from './settings.js';

stopOnSignals(await startServer(serverSettings(process.env)));
