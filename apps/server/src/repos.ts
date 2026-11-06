// The repositories references lead into (ADR 0014): where each one's files can
// be browsed, and the branch the tag scan may write from. Configuration, never
// the log: a reference names a repository by id, so re-pointing one changes no
// logged event. Everything here is public — every browser is shown it — so a
// browse template may carry no credentials.
import { existsSync, readFileSync } from 'node:fs';
import { RepoIdSchema, type Repository } from '@orrery/core';
import { z } from 'zod';

const PLACEHOLDER = '{path}';

/** An http(s) URL with `{path}` exactly once, nothing else in braces, and no user or password. */
const BrowseSchema = z
  .string()
  .trim()
  .max(1000)
  .superRefine((v, ctx) => {
    if (v.split(PLACEHOLDER).length !== 2) ctx.addIssue({ code: 'custom', message: `must contain ${PLACEHOLDER} exactly once` });
    if (/[{}]/.test(v.replace(PLACEHOLDER, ''))) ctx.addIssue({ code: 'custom', message: `may contain no placeholder but ${PLACEHOLDER}` });
    const filled = v.replace(PLACEHOLDER, 'x');
    const u = URL.canParse(filled) ? new URL(filled) : null;
    if (u?.protocol !== 'http:' && u?.protocol !== 'https:') ctx.addIssue({ code: 'custom', message: 'must be an http(s) URL' });
    else if (u.username || u.password) ctx.addIssue({ code: 'custom', message: 'must carry no credentials: every browser is shown it' });
  });

const RepositorySchema = z.strictObject({
  id: RepoIdSchema,
  label: z.string().trim().min(1).max(80).optional(),
  branch: z.string().trim().min(1).max(200).default('main'),
  browse: BrowseSchema,
});

/** Parses and checks a repository list. Throws on anything malformed, before the server serves. */
export function parseRepos(raw: unknown, origin = 'repos'): Repository[] {
  const parsed = z.array(RepositorySchema).max(100).safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`${origin}: ${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`);
  }
  const seen = new Set<string>();
  return parsed.data.map((r) => {
    if (seen.has(r.id)) throw new Error(`${origin}: duplicate repository id “${r.id}”`);
    seen.add(r.id);
    return { id: r.id, label: r.label ?? r.id, branch: r.branch, browse: r.browse };
  });
}

/** Loads the file `ORRERY_REPOS_FILE` names (settings.ts). None means no repositories: references still navigate, without links out. */
export function loadRepos(file: string | null): Repository[] {
  if (!file) return [];
  if (!existsSync(file)) throw new Error(`ORRERY_REPOS_FILE: ${file} does not exist`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`ORRERY_REPOS_FILE: ${file} is not valid JSON — ${(err as Error).message}`);
  }
  return parseRepos(raw, file);
}
