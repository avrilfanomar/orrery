// The npm package (ADR 0016): the server bundled into dist/, with the built
// console beside it in dist/web. npm dependencies stay external, so the build
// fails if the bundle loads one this package does not depend on: inside the
// workspace it would still resolve, and only an installed copy would crash.
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const web = '../web/dist';
if (!existsSync(`${web}/index.html`)) {
  console.error(`No console in ${web}: build @avrilfanomar/orrery-web first.`);
  process.exit(1);
}

rmSync('dist', { recursive: true, force: true });
const { metafile } = await build({
  entryPoints: { cli: 'src/cli.ts' },
  outdir: 'dist',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node20.19',
  packages: 'external',
  banner: { js: '#!/usr/bin/env node' },
  define: { __ORRERY_BUNDLED__: 'true', __ORRERY_VERSION__: JSON.stringify(pkg.version) },
  metafile: true,
  logLevel: 'warning',
});

const declared = new Set(Object.keys(pkg.dependencies ?? {}));
/** Loaded with import() only by code the package never runs, which already reports a skip when it is missing. */
const OPTIONAL = new Set(['typescript']); // the dogfood's compiler-API probes, reached through the dogfood seed's probe specs
const packageOf = (spec) => spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/');
const undeclared = new Set(
  Object.values(metafile.outputs)
    .flatMap((o) => o.imports)
    .filter((i) => i.external && !isBuiltin(i.path))
    .filter((i) => !declared.has(packageOf(i.path)) && !(i.kind === 'dynamic-import' && OPTIONAL.has(packageOf(i.path))))
    .map((i) => packageOf(i.path)),
);
if (undeclared.size > 0) {
  console.error(`The bundle loads packages ${pkg.name} does not depend on: ${[...undeclared].join(', ')}`);
  process.exit(1);
}

cpSync(web, 'dist/web', { recursive: true });
console.log(`Bundled ${Object.keys(metafile.outputs).length} files into dist/, the console into dist/web`);
