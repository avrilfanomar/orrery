import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Defined by the npm build (build.mjs). Absent under tsx, where the code runs from the repository. */
declare const __ORRERY_BUNDLED__: true | undefined;
const here = dirname(fileURLToPath(import.meta.url));

/** The repository root. Settings that depend on the environment live in settings.ts. */
export const repoRoot = resolve(here, '../../..');
/** Where the npm bundle sits, with its console beside it in `web/` (ADR 0016); null when the code runs from the repository. */
export const bundleDir: string | null = typeof __ORRERY_BUNDLED__ === 'undefined' ? null : here;
