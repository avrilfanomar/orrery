import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const dataFile = process.env.RU_DATA_FILE ?? resolve(repoRoot, 'data/events.jsonl');
export const webDist = process.env.RU_WEB_DIST ?? resolve(repoRoot, 'apps/web/dist');
export const port = Number(process.env.PORT ?? 4710);
export const host = process.env.HOST ?? '127.0.0.1';

/** The repository's own universe (ADR 0003): its own log and port, so it never mixes with the demo. */
export const dogfoodFile = process.env.RU_DOGFOOD_FILE ?? resolve(repoRoot, 'data/dogfood.jsonl');
export const dogfoodPort = Number(process.env.RU_DOGFOOD_PORT ?? 4711);
