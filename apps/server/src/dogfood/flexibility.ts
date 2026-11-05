// How far the repository bends without breaking (ADR 0005), as static counts:
// settings nobody documented, imports that cross a component boundary, and
// colours the theme does not control. The suite pins the rest as contracts
// (flexibility.test.ts). These live apart from probes.ts, which imports them,
// so they may import only types from it.
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { scrub } from './harness.js';
import type { Probe, ProbeContext } from './probes.js';

const V1 = 'First version of this method (ADR 0005)';
const V2_SEAMS =
  'ADR 0013: the Prometheus adapter left apps/server for the @ru/prometheus module, so the rule keyed to its old path could never fire. The seams now say which package may load which — the UI no package but core, a module only core and the kit, the server a module only through its registry — and a source adapter is reached by calling it, so that rule counts calls';
const read = (ctx: ProbeContext, f: string) => readFileSync(join(ctx.root, f), 'utf8');
const sources = (ctx: ProbeContext, pattern: RegExp) => ctx.tracked().filter((f) => pattern.test(f));
const tally = (hits: readonly string[]) => {
  const counts = new Map<string, number>();
  for (const h of hits) counts.set(h, (counts.get(h) ?? 0) + 1);
  return [...counts].map(([h, n]) => (n > 1 ? `${h} ×${n}` : h)).join(', ');
};

/** Code an operator runs or configures: the apps' sources, the browser smoke test and the dev-server config. */
const CONFIGURABLE = /^(?:apps\/[^/]+\/src\/.+\.tsx?|apps\/web\/e2e\/.+\.m?js|apps\/web\/vite\.config\.ts|packages\/[^/]+\/src\/.+\.ts)$/;
export const ENV_READ = /\b(?:process\.)?env\.([A-Z][A-Z0-9_]*)\b|\benv\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g;
/** Defined by the platform, not by this repository. */
export const PLATFORM_ENV: ReadonlySet<string> = new Set(['PATH']);

/** An import, resolved to a repository path when it is relative (extension dropped), else the bare specifier. */
export function resolveImport(from: string, spec: string): string {
  return spec.startsWith('.') ? posix.normalize(posix.join(posix.dirname(from), spec)).replace(/\.(?:[cm]?js|tsx?|jsx)$/, '') : spec;
}

/** The package a repository path or an `@ru/` specifier belongs to (`packages/core`, `@ru/core` → `core`), or null. */
const packageOf = (t: string) => {
  const [root, name] = t.split('/');
  return root === 'packages' || root === 'apps' || root === '@ru' ? (name ?? null) : null;
};
/** A module (ADR 0013): any workspace package that is not core, the kit or an app. */
const isModule = (t: string) => /^@ru\/(?!core$|module-kit$|server$|web$)[^/]+$/.test(t);

/** Component boundaries no source import may cross, each kept for a reason ADR 0005 or ADR 0013 gives. */
export const SEAMS: readonly { rule: string; crosses(from: string, to: string): boolean }[] = [
  { rule: 'a package is used through its entry', crosses: (f, t) => (t.startsWith('@ru/') && t.split('/').length > 2) || (t.startsWith('packages/') && packageOf(t) !== packageOf(f)) },
  { rule: 'core depends on no other package or app', crosses: (f, t) => f.startsWith('packages/core/') && (t.startsWith('apps/') || /^@ru\/(?!core$)/.test(t)) },
  { rule: 'a module depends only on core and the kit', crosses: (f, t) => f.startsWith('packages/') && !f.startsWith('packages/core/') && (t.startsWith('apps/') || /^@ru\/(?!core$|module-kit$)/.test(t)) },
  { rule: 'the UI and the server share only core and HTTP', crosses: (f, t) => (f.startsWith('apps/web/') && (t.startsWith('apps/server/') || /^@ru\/(?!core$)/.test(t))) || (f.startsWith('apps/server/') && /^(?:apps\/web\/|@ru\/web)/.test(t)) },
  { rule: 'only the registry installs a module', crosses: (f, t) => f.startsWith('apps/') && f !== 'apps/server/src/modules.ts' && isModule(t) },
];
/** A source adapter is reached through its kind (`kindOf(src).queryRange(…)`); only the collector, which schedules pulls and records their answers, may call one. */
const ADAPTER_CALL = /\.queryRange\s*\(/g;
const ADAPTER_CALLER = 'apps/server/src/sources/collector.ts';
const IMPORT = /\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
const UI_NETWORK = /\bfetch\s*\(|\bnew\s+(?:XMLHttpRequest|EventSource|WebSocket)\b/g;

/** The crossings in one source file, its comments already blanked: imports past a seam, adapter calls outside the collector, network calls outside the UI's one module. */
export function crossingsIn(f: string, src: string): string[] {
  const hits: string[] = [];
  for (const [, spec] of src.matchAll(IMPORT)) {
    const broken = SEAMS.find((s) => s.crosses(f, resolveImport(f, spec!)));
    if (broken) hits.push(`${f} → ${spec} (${broken.rule})`);
  }
  const code = scrub(src, true);
  if (f !== ADAPTER_CALLER) for (const [call] of code.matchAll(ADAPTER_CALL)) hits.push(`${f}: ${call.trim()} (only the collector calls a source adapter)`);
  if (f.startsWith('apps/web/src/') && f !== 'apps/web/src/api.ts') for (const [call] of code.matchAll(UI_NETWORK)) hits.push(`${f}: ${call.trim()}`);
  return hits;
}

const COLOUR = /(?<![\w&#])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi;

/** Colour literals in a stylesheet outside custom-property declarations (`--name: …`), which are the theme's tokens. */
export function cssColoursOutsideTokens(css: string): number {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/[;{}]/)
    .filter((chunk) => !/^\s*--[\w-]+\s*:/.test(chunk))
    .reduce((n, chunk) => n + (chunk.match(COLOUR)?.length ?? 0), 0);
}

export const FLEXIBILITY_PROBES: readonly Probe[] = [
  {
    id: 'config-undocumented',
    version: 1,
    since: V1,
    method:
      'Collects the environment variables read by name (`process.env.<NAME>`, `env.<NAME>`, `env["<NAME>"]`; comments ignored) in tracked apps/*/src, packages/*/src, apps/web/e2e and apps/web/vite.config.ts, PATH excepted. The value is the number of distinct names README.md never mentions as a word.',
    measure(ctx) {
      const readme = read(ctx, 'README.md');
      const names = new Set<string>();
      for (const f of sources(ctx, CONFIGURABLE)) for (const [, a, b] of scrub(read(ctx, f), false).matchAll(ENV_READ)) if (!PLATFORM_ENV.has((a ?? b)!)) names.add((a ?? b)!);
      const missing = [...names].filter((n) => !new RegExp(`\\b${n}\\b`).test(readme)).sort();
      return { value: missing.length, detail: missing.length ? missing.join(', ') : `${names.size} names, all documented` };
    },
  },
  {
    id: 'seam-crossings',
    version: 2,
    since: V2_SEAMS,
    method: `Resolves every import in tracked packages/*/src and apps/*/src (comments ignored) and counts those that break a boundary: ${SEAMS.map((s) => s.rule).join('; ')}. A module is any workspace package but core, module-kit and the apps. Calls of a source adapter (\`.queryRange(\`) outside ${ADAPTER_CALLER} count too: only the collector talks to a source. So do network calls (fetch, XMLHttpRequest, EventSource, WebSocket) in apps/web/src outside api.ts: the UI reaches the server through one module.`,
    measure(ctx) {
      const hits = sources(ctx, /^(?:packages|apps)\/[^/]+\/src\/.+\.tsx?$/).flatMap((f) => crossingsIn(f, scrub(read(ctx, f), false)));
      return { value: hits.length, detail: hits.slice(0, 3).join('; ') || undefined };
    },
  },
  {
    id: 'theme-literals',
    version: 1,
    since: V1,
    method:
      'Counts colour literals — #hex, rgb(), hsl() and the other CSS colour functions — in tracked apps/web/src: in *.css outside custom-property declarations (`--name: …`, the theme tokens), and anywhere in *.ts and *.tsx with comments ignored. Each is a colour a theme cannot change.',
    measure(ctx) {
      const hits: string[] = [];
      for (const f of sources(ctx, /^apps\/web\/src\/.+\.(?:css|tsx?)$/)) {
        const src = read(ctx, f);
        const n = f.endsWith('.css') ? cssColoursOutsideTokens(src) : (scrub(src, false).match(COLOUR)?.length ?? 0);
        for (let i = 0; i < n; i++) hits.push(f.replace('apps/web/src/', ''));
      }
      return { value: hits.length, detail: tally(hits) || undefined };
    },
  },
];
