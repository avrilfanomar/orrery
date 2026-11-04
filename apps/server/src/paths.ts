import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const dataFile = process.env.RU_DATA_FILE ?? resolve(repoRoot, 'data/events.jsonl');
export const webDist = resolve(repoRoot, 'apps/web/dist');
export const port = Number(process.env.PORT ?? 4710);
export const host = process.env.HOST ?? '127.0.0.1';
