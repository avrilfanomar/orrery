// `pnpm tags --repo <id> [--root <dir>] [--dry-run] [--strict] [--exclude glob,…]`
//
// Harvests a repository's tags into the universe a running server holds
// (ADR 0014). Writes only from the tip of the configured branch on a clean
// tree; anywhere else, or with --dry-run, it prints the plan and the problems
// and writes nothing. Exits 1 when a tag names no node (or, with --strict, a
// reference points at nothing), so a PR check can run it as a gate.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { httpTransport } from '../dogfood/runner.js';
import { tagSettings } from '../settings.js';
import { onBranchTip, readText } from './files.js';
import { DEFAULT_EXCLUDE } from './scan.js';
import { renderTagReport, runTags, type TagGit } from './runner.js';

const { values: args } = parseArgs({
  options: {
    repo: { type: 'string' },
    root: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    strict: { type: 'boolean', default: false },
    exclude: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (args.help || !args.repo) {
  console.log(`pnpm tags --repo <id> [--root <dir>] [--dry-run] [--strict] [--exclude glob,…]

  --repo     the repository's id in the server's ORRERY_REPOS_FILE
  --root     the repository's checkout (default: where the command was typed)
  --dry-run  plan and check, write nothing (what a PR check runs)
  --strict   also fail when a hand reference into the repository points at nothing
  --exclude  globs never scanned, replacing the default ${DEFAULT_EXCLUDE.join(',')}

  ORRERY_API  the server (default http://HOST:PORT)`);
  process.exit(args.help ? 0 : 1);
}

const settings = tagSettings(process.env);
const root = resolve(settings.cwd, args.root ?? '.');
const git = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const repoGit: TagGit = {
  sha: git('rev-parse', '--short', 'HEAD'),
  dirty: git('status', '--porcelain') !== '',
  onTip: (branch) => onBranchTip(root, branch),
};

const result = await runTags(
  { repo: args.repo, dryRun: args['dry-run'], strict: args.strict, ...(args.exclude ? { exclude: args.exclude.split(',').map((s) => s.trim()).filter(Boolean) } : {}) },
  {
    transport: httpTransport(settings.api),
    git: repoGit,
    tracked: git('ls-files', '-z').split('\0').filter(Boolean),
    read: (path) => readText(root, path),
  },
);
process.stdout.write(renderTagReport(result));
if (result.refused) process.exitCode = 1;
