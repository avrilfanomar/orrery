// One tag scan (ADR 0014): harvest a repository's tags, plan, check, write. It
// writes only from the tip of the branch the server's configuration names, on
// a clean tree; anything else is a dry run, so CI on every branch cannot add
// and remove the same references in a permanent log. Every write goes through
// the API, so `decide` judges a harvested reference like anyone else's.
import type { Repository, UniverseView } from '@orrery/core';
import type { Transport } from '../dogfood/runner.js';
import { danglingReferences, harvestTags, planTags, type DanglingReference, type ScanOptions, type TagPlan } from './scan.js';

/** The writer a harvested reference is recorded under. */
export const TAG_ACTOR = 'tags';

export interface TagGit {
  /** The commit scanned, short. */
  sha: string;
  dirty: boolean;
  /** Whether HEAD is the tip of `branch` (local, or as last fetched from origin). */
  onTip(branch: string): boolean;
}

export interface TagRunOptions extends ScanOptions {
  repo: string;
  dryRun?: boolean;
  /** Refuse when a hand reference into the repository points at nothing, as a dangling tag always is. */
  strict?: boolean;
}

export interface TagRunDeps {
  transport: Transport;
  git: TagGit;
  /** The repository's tracked files, relative to its root. */
  tracked: readonly string[];
  /** A tracked file's text, or null when it can't be read as text. */
  read(path: string): string | null;
}

export interface TagRunResult {
  repository: Repository;
  plan: TagPlan;
  danglingRefs: DanglingReference[];
  applied: number;
  /** Why nothing was written, when nothing was. */
  notWritten: string | null;
  /** Set when the scan failed its checks: the caller exits non-zero. */
  refused: string | null;
}

export async function runTags(opts: TagRunOptions, deps: TagRunDeps): Promise<TagRunResult> {
  const { transport: api, git } = deps;
  const { repositories } = await api.get<{ repositories: Repository[] }>('/api/repos');
  const repository = repositories.find((r) => r.id === opts.repo);
  if (!repository) throw new Error(`The server has no repository “${opts.repo}” configured (ORRERY_REPOS_FILE); it names the branch a scan may write from`);
  const view = await api.get<UniverseView>('/api/universe');

  const files = deps.tracked.flatMap((path) => {
    const text = deps.read(path);
    return text === null ? [] : [{ path, text }];
  });
  const tags = harvestTags(files, opts);
  const plan = planTags(Object.values(view.nodes), repository.id, tags, { added: `Tagged at ${git.sha}`, removed: `Tag gone at ${git.sha}` }, opts);
  const danglingRefs = danglingReferences(Object.values(view.nodes), repository.id, deps.tracked, deps.read);

  const refused = refusal(plan, danglingRefs, opts.strict ?? false);
  const notWritten = refused ?? whyNotWritten(opts, git, repository);

  let applied = 0;
  if (!notWritten) {
    for (const change of plan.changes) {
      await api.post('/api/commands', change.cmd, TAG_ACTOR);
      applied++;
    }
  }
  return { repository, plan, danglingRefs, applied, notWritten, refused };
}

/** Why the scan failed its checks, if it did: a dangling tag always, a dangling reference under --strict. */
function refusal(plan: TagPlan, danglingRefs: readonly DanglingReference[], strict: boolean): string | null {
  const n = plan.dangling.length;
  if (n) return `${n} tag${n === 1 ? ' names' : 's name'} no node`;
  const m = danglingRefs.length;
  if (strict && m) return `${m} reference${m === 1 ? ' points' : 's point'} at nothing`;
  return null;
}

/** Why a scan that passed its checks still writes nothing: a dry run, uncommitted code, or a revision off the configured branch. */
function whyNotWritten(opts: TagRunOptions, git: TagGit, repository: Repository): string | null {
  if (opts.dryRun) return 'dry run';
  if (git.dirty) return 'the working tree has uncommitted changes — tags are harvested from committed code only';
  if (!git.onTip(repository.branch)) return `HEAD is not the tip of ${repository.branch}, the branch the server names for ${repository.id} — run with --dry-run to check a branch`;
  return null;
}

/** What a person reads after a scan: the plan, the problems, and whether anything was written. */
export function renderTagReport(r: TagRunResult): string {
  const lines = [`${r.repository.id} (${r.repository.branch}): ${r.plan.changes.length} change${r.plan.changes.length === 1 ? '' : 's'} planned, ${r.applied} written`];
  for (const c of r.plan.changes) lines.push(`  · ${c.summary}`);
  for (const t of r.plan.dangling) lines.push(`  ✗ ${t.path}: names “${t.nodeId}”, which is no node`);
  for (const t of r.plan.deprecated) lines.push(`  ! ${t.path}: names “${t.nodeId}”, which is deprecated`);
  // A dangling reference refuses the scan only under --strict, and only when no dangling tag already has.
  const refsRefused = r.refused !== null && r.plan.dangling.length === 0;
  for (const d of r.danglingRefs) lines.push(`  ${refsRefused ? '✗' : '!'} ${d.nodeId}: ${d.problem}`);
  if (r.notWritten) lines.push(`Nothing written: ${r.notWritten}.`);
  return `${lines.join('\n')}\n`;
}
