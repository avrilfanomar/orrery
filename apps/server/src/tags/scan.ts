// Tags (ADR 0014): a reference written next to the code it points from, so it
// moves with the code and is reviewed with it. This file is the pure part: find
// tags in text, turn them into references, and plan the commands that bring one
// repository's harvested references in line with its tags. Applying the plan is
// the caller's job, through the API and so through `decide`. Tag: orrery:r-traceable
import { NodeIdSchema, refKey, type CommandInput, type Reference } from '@orrery/core';

/** Never harvested: prose that shows the syntax, and frozen logs. */
export const DEFAULT_EXCLUDE: readonly string[] = ['**/*.md', '**/fixtures/**'];
/** A tag in a file matching one of these is a `test` reference; anywhere else, `code`. */
export const DEFAULT_TESTS: readonly string[] = ['**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**', '**/e2e/**'];

const PREFIX = 'orrery';
const ID = '[a-z0-9][a-z0-9-]{0,63}';
/**
 * The token, then node ids, comma-separated. It must not follow a letter, digit,
 * `/`, `.`, `-` or `@`, so a package name (`@orrery/core`) or a URL never
 * matches. No comment syntax is parsed: a tag counts in any language, strings
 * included, which is why tests build their tag text at runtime.
 */
const TAG = new RegExp(`(?<![A-Za-z0-9/.@-])${PREFIX}:(${ID}(?:,${ID})*)(?![a-z0-9-])`, 'g');

/** The node ids every tag in `text` names, in order, each once. */
export function tagsIn(text: string): string[] {
  const ids = new Set<string>();
  for (const [, list] of text.matchAll(TAG)) for (const id of list!.split(',')) if (NodeIdSchema.safeParse(id).success) ids.add(id);
  return [...ids];
}

/** `**` crosses directories, `*` stays within one segment, `?` is one character; a leading `**\/` also matches at the root. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      re += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export interface ScanOptions {
  exclude?: readonly string[];
  tests?: readonly string[];
}

/** One tag: a node named in a file. */
export interface Tag {
  nodeId: string;
  path: string;
}

const anyOf = (globs: readonly string[]) => {
  const res = globs.map(globToRegExp);
  return (path: string) => res.some((r) => r.test(path));
};

/** Every (node, file) a tag names, once each, in the files not excluded. A file is anything with `path` and its text. */
export function harvestTags(files: Iterable<{ path: string; text: string }>, opts: ScanOptions = {}): Tag[] {
  const excluded = anyOf(opts.exclude ?? DEFAULT_EXCLUDE);
  const out: Tag[] = [];
  for (const f of files) {
    if (excluded(f.path)) continue;
    for (const nodeId of tagsIn(f.text)) out.push({ nodeId, path: f.path });
  }
  return out;
}

/** What a tag records: the file, never a line (lines move with every edit) and never a symbol. */
export function tagReference(repo: string, path: string, opts: ScanOptions = {}): Reference {
  return { kind: anyOf(opts.tests ?? DEFAULT_TESTS)(path) ? 'test' : 'code', target: { repo, path }, origin: 'tag' };
}

/** A node as the plan needs it: from a universe view or a projection. */
export interface TaggableNode {
  id: string;
  title: string;
  lifecycle: 'active' | 'deprecated';
  refs: readonly Reference[];
}

export interface TagChange {
  cmd: Extract<CommandInput, { type: 'node.reference' | 'node.unreference' }>;
  summary: string;
}

export interface TagPlan {
  changes: TagChange[];
  /** Tags naming no node: the scan refuses to write while there is one. */
  dangling: Tag[];
  /** Tags naming a deprecated node: harvested, as any reference to one is, and reported. */
  deprecated: Tag[];
}

/**
 * The commands that bring repository `repo`'s harvested references in line
 * with its tags: a reference for each new tag, an unreference for each one
 * gone. It reads and touches only references whose origin is `tag` and whose
 * repository is `repo`, so hand references and other repositories' tags are
 * never removed. `reason` goes on every command (`Tagged at <sha>`).
 */
export function planTags(nodes: Iterable<TaggableNode>, repo: string, tags: readonly Tag[], reasons: { added: string; removed: string }, opts: ScanOptions = {}): TagPlan {
  const byId = new Map([...nodes].map((n) => [n.id, n]));
  const plan: TagPlan = { changes: [], dangling: [], deprecated: [] };
  const wanted = wantedReferences(byId, repo, tags, plan, opts);
  for (const node of byId.values()) {
    for (const ref of node.refs) {
      if (ref.origin !== 'tag' || !('repo' in ref.target) || ref.target.repo !== repo) continue;
      if (wanted.delete(`${node.id} ${refKey(ref)}`)) continue; // already harvested
      plan.changes.push({ cmd: { type: 'node.unreference', data: { id: node.id, ref, reason: reasons.removed } }, summary: `untag “${node.title}” from ${ref.target.path}` });
    }
  }
  for (const { node, ref } of wanted.values()) {
    plan.changes.push({ cmd: { type: 'node.reference', data: { id: node.id, ref, reason: reasons.added } }, summary: `tag “${node.title}” in ${'path' in ref.target ? ref.target.path : ''}` });
  }
  return plan;
}

/** The reference each tag asks for, keyed by node and reference; tags naming no node or a deprecated one are noted in `plan`. */
function wantedReferences(byId: ReadonlyMap<string, TaggableNode>, repo: string, tags: readonly Tag[], plan: TagPlan, opts: ScanOptions): Map<string, { node: TaggableNode; ref: Reference }> {
  const wanted = new Map<string, { node: TaggableNode; ref: Reference }>();
  for (const tag of tags) {
    const node = byId.get(tag.nodeId);
    if (!node) {
      plan.dangling.push(tag);
      continue;
    }
    if (node.lifecycle !== 'active') plan.deprecated.push(tag);
    const ref = tagReference(repo, tag.path, opts);
    wanted.set(`${node.id} ${refKey(ref)}`, { node, ref });
  }
  return wanted;
}

/** A hand reference into the scanned repository that points at nothing. */
export interface DanglingReference {
  nodeId: string;
  ref: Reference;
  problem: string;
}

/**
 * Hand references into `repo` whose path is missing, or whose symbol does not
 * occur in the file as a whole word. `read` gives a tracked file's text, or
 * null when there is no such file; a directory exists when a tracked file is under it.
 */
export function danglingReferences(nodes: Iterable<TaggableNode>, repo: string, tracked: readonly string[], read: (path: string) => string | null): DanglingReference[] {
  const files = new Set(tracked);
  const out: DanglingReference[] = [];
  for (const node of nodes) {
    for (const ref of node.refs) {
      if (ref.origin === 'tag' || !('repo' in ref.target) || ref.target.repo !== repo) continue;
      const problem = targetProblem(ref.target, files, tracked, read);
      if (problem) out.push({ nodeId: node.id, ref, problem });
    }
  }
  return out;
}

function targetProblem(t: { path: string; symbol?: string }, files: ReadonlySet<string>, tracked: readonly string[], read: (path: string) => string | null): string | null {
  if (t.path.endsWith('/')) return tracked.some((f) => f.startsWith(t.path)) ? null : `no tracked file under ${t.path}`;
  if (!files.has(t.path)) return `${t.path} is not a tracked file`;
  if (!t.symbol) return null;
  const text = read(t.path) ?? '';
  const word = new RegExp(`(?<![\\w$])${t.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`);
  return word.test(text) ? null : `“${t.symbol}” does not occur in ${t.path}`;
}
