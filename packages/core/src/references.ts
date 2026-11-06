// References (ADR 0014): what makes one, how two are told apart, and how one
// becomes a link a person can follow. Pure, so the console resolves links with
// exactly the code the tests exercise. Core names no code host: a repository's
// browse link is a template the operator configures. Tag: orrery:r-traceable
import { REFERENCE_KINDS } from './constants.js';
import type { Reference, ReferenceTarget } from './schema.js';

/** A global wherever core runs; core loads no environment's types, so it declares only what it uses. */
declare const URL: new (input: string) => { protocol: string; href: string };

/** A repository as the server publishes it (`GET /api/repos`): public fields only. */
export interface Repository {
  id: string;
  label: string;
  /** The branch the tag scan may write from, and the one `browse` points at. */
  branch: string;
  /** An http(s) URL with `{path}` exactly once. */
  browse: string;
}

export const isUrlTarget = (t: ReferenceTarget): t is { url: string } => 'url' in t;

/**
 * Who a reference is, as a fixed-order tuple: origin, kind, then the target.
 * Computed in memory, never stored, so changing it never strands a logged
 * event; a tuple rather than a joined string, so no character in a path or a
 * symbol can make two references collide. The label is not part of it.
 */
export function refKey(ref: Reference): string {
  return JSON.stringify([ref.origin ?? 'hand', ref.kind, ...targetTuple(ref.target)]);
}

/** Where a reference leads, whoever made it and whatever kind it is: what the reverse lookup groups by. */
export function targetKey(t: ReferenceTarget): string {
  return JSON.stringify(targetTuple(t));
}

function targetTuple(t: ReferenceTarget): string[] {
  return isUrlTarget(t) ? ['url', t.url] : ['repo', t.repo, t.path, t.symbol ?? ''];
}

export function kindLabel(kind: string): string {
  return REFERENCE_KINDS[kind] ?? kind;
}

/** `larch-shop:services/checkout/src/payments.ts › charge`, or the URL. */
export function describeTarget(t: ReferenceTarget): string {
  if (isUrlTarget(t)) return t.url;
  return `${t.repo}:${t.path}${t.symbol ? ` › ${t.symbol}` : ''}`;
}

/**
 * The link out for a target, or null when there is none to give. A repository
 * the server doesn't know still names where the code is; it just has no link.
 * Every path segment is encoded, and the result must parse as http(s), so a
 * `javascript:` URL cannot come out of a template, a path or their sum.
 */
export function referenceHref(t: ReferenceTarget, repos: readonly Repository[]): string | null {
  const href = isUrlTarget(t) ? t.url : repoHref(t, repos);
  if (!href) return null;
  try {
    const u = new URL(href);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

function repoHref(t: Exclude<ReferenceTarget, { url: string }>, repos: readonly Repository[]): string | null {
  const repo = repos.find((r) => r.id === t.repo);
  if (!repo) return null;
  const path = t.path.split('/').map(encodeURIComponent).join('/');
  return repo.browse.replace('{path}', () => path);
}

/** The directories above a repository path, outermost first, each with its trailing `/`: the file page's crumbs. */
export function ancestorDirectories(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  return Array.from({ length: parts.length - 1 }, (_, i) => `${parts.slice(0, i + 1).join('/')}/`);
}

/**
 * How a reference's target relates to the one asked about: the same place, a
 * directory above the file asked about, or a file below the directory asked
 * about. A file asked about matches every symbol in it.
 */
export type TargetMatch = 'exact' | 'directory' | 'file';

export function matchTarget(ref: ReferenceTarget, asked: ReferenceTarget): TargetMatch | null {
  if (isUrlTarget(asked) || isUrlTarget(ref)) return isUrlTarget(asked) && isUrlTarget(ref) && ref.url === asked.url ? 'exact' : null;
  if (ref.repo !== asked.repo) return null;
  if (ref.path === asked.path) return asked.symbol && ref.symbol !== asked.symbol ? null : 'exact';
  if (ref.path.endsWith('/') && asked.path.startsWith(ref.path)) return 'directory';
  if (asked.path.endsWith('/') && ref.path.startsWith(asked.path)) return 'file';
  return null;
}
