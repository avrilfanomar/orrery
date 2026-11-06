// `pnpm dogfood [--reason "…"] [--dry-run] [--allow-dirty] [--only id,…]`
//
// Measures this repository against its own model (ADR 0003). Talks to a
// running dogfood server when there is one (`pnpm dogfood:serve`), otherwise
// opens the dogfood log in-process — one writer per log, either way.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { buildApp } from '../app.js';
import { repoRoot } from '../paths.js';
import { dogfoodSettings } from '../settings.js';
import { onBranchTip, readText } from '../tags/files.js';
import { EventStore } from '../store.js';
import { gitSnapshot, trackedFiles } from './collectors.js';
import { createContext } from './probes.js';
import { renderReport } from './report.js';
import { httpTransport, injectTransport, runDogfood, type Transport } from './runner.js';
import { ReasonRequired } from './sync.js';

const { values: args } = parseArgs({
  options: {
    reason: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'allow-dirty': { type: 'boolean', default: false },
    only: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (args.help) {
  console.log(`pnpm dogfood [--reason "…"] [--dry-run] [--allow-dirty] [--only id,…]

  --reason       why the model changed (otherwise: a probe's own reason, then the model's last commit subject)
  --dry-run      plan and measure, write nothing
  --allow-dirty  record from a tree with uncommitted changes (the source gets a +dirty suffix)
  --only         measure only these node or probe ids

  ORRERY_PROBE_ENV   label for the machine (default local); timings compare only within one label
  ORRERY_DOGFOOD_URL a running dogfood server (default http://127.0.0.1:ORRERY_DOGFOOD_PORT)`);
  process.exit(0);
}

const settings = dogfoodSettings(process.env);

async function open(): Promise<{ transport: Transport; where: string; close: () => Promise<void> }> {
  const { url } = settings;
  const up = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) }).then(
    (r) => r.ok,
    () => false,
  );
  if (up) return { transport: httpTransport(url), where: url, close: async () => {} };
  const store = EventStore.open(settings.file);
  const app = await buildApp({ store });
  return {
    transport: injectTransport(app),
    where: settings.file,
    close: async () => {
      await app.close();
      store.close();
    },
  };
}

/** The tag harvest reads the committed tree, and only from main's tip, as ADR 0014 asks of every scan. */
const tagFiles = () => (onBranchTip(repoRoot, 'main') ? { tracked: trackedFiles(repoRoot), read: (path: string) => readText(repoRoot, path) } : undefined);

const tmp = mkdtempSync(join(tmpdir(), 'orrery-dogfood-'));
const conn = await open();
try {
  const git = gitSnapshot(repoRoot);
  console.error(`dogfood: ${conn.where} · ${git.sha}${git.dirty ? ' (uncommitted changes)' : ''}`);
  const result = await runDogfood(
    { reason: args.reason ?? null, dryRun: args['dry-run'], allowDirty: args['allow-dirty'], only: args.only?.split(',').map((s) => s.trim()).filter(Boolean) },
    { transport: conn.transport, git, context: createContext(repoRoot, tmp), env: settings.probeEnv, progress: (l) => console.error(l), tags: tagFiles() },
  );
  process.stdout.write(renderReport(result, process.stdout.isTTY && settings.colour));
} catch (err) {
  if (!(err instanceof ReasonRequired)) throw err;
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await conn.close();
  rmSync(tmp, { recursive: true, force: true });
}
