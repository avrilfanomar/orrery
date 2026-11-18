// The one command the npm package installs (ADR 0016). It runs the entry
// points `pnpm start`, `pnpm reset` and `pnpm simulate` run in the repository;
// the build tells settings.ts there is no repository around them.
declare const __ORRERY_VERSION__: string | undefined;
export {}; // a module, so the command it runs can be awaited at the top level

const COMMANDS: Readonly<Record<string, () => Promise<unknown>>> = {
  serve: () => import('./main.js'),
  reset: () => import('./reset.js'),
  simulate: () => import('./simulate.js'),
};

const USAGE = `Usage: orrery [serve|reset|simulate]

  serve     the API and the console on http://127.0.0.1:4710 (the default)
  reset     re-seed the demo relative to now; stop the server first, the old log is kept
  simulate  keep the demo's signals moving; run it beside serve

The log is orrery-data/events.jsonl in the directory you run it from.
Every ORRERY_* setting in the README applies: https://github.com/avrilfanomar/orrery#configuration`;

const [command = 'serve', ...extra] = process.argv.slice(2);
if (command === '--version' || command === '-v') console.log(typeof __ORRERY_VERSION__ === 'string' ? __ORRERY_VERSION__ : 'unbundled');
else if (command === '--help' || command === '-h') console.log(USAGE);
else if (extra.length > 0 || !Object.hasOwn(COMMANDS, command)) {
  console.error(`Unknown command: ${[command, ...extra].join(' ')}\n\n${USAGE}`);
  process.exitCode = 2;
} else await COMMANDS[command]!();
