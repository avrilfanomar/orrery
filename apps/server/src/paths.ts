import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root. Settings that depend on the environment live in settings.ts. */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
