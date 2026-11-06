// What a tag scan reads from a checkout (ADR 0014), shared by `pnpm tags`, the
// dogfood run and its `references-dangling` probe, so all three see the same
// files the same way.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 1024 * 1024;

/** A file's text under `root`, or null when it is missing, over a megabyte or binary: a scan reads only what a person could have typed a tag into. */
export function readText(root: string, path: string): string | null {
  try {
    const file = join(root, path);
    if (statSync(file).size > MAX_BYTES) return null;
    const text = readFileSync(file, 'utf8');
    return text.includes('\0') ? null : text;
  } catch {
    return null;
  }
}

const git = (root: string, args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function revision(root: string, ref: string): string | null {
  try {
    return git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) || null;
  } catch {
    return null;
  }
}

/** Whether HEAD is the tip of `branch`, locally or as last fetched from origin: CI checks out a detached HEAD. */
export function onBranchTip(root: string, branch: string): boolean {
  const head = revision(root, 'HEAD');
  return head !== null && [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`].some((ref) => revision(root, ref) === head);
}
