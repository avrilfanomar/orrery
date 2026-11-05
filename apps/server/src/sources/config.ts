// Source configuration (ADR 0002, decisions 1 and 5): how to reach the systems
// metrics are pulled from. It lives beside the log, never in it — a token in an
// append-only log could never be removed — and a binding can only choose among
// these sources, never add a URL of its own. The settings every kind shares,
// and their checks, live here; a kind's module adds only its own fields
// (ADR 0013), so no kind can loosen them.
import { existsSync, readFileSync } from 'node:fs';
import { HttpUrlSchema, SourceIdSchema, type SourceCatalog } from '@orrery/core';
import type { DrillOut, PublicSettings, PublicValue, SourceBasics, SourceKind } from '@orrery/module-kit';
import { z } from 'zod';
import { SOURCE_KINDS } from '../modules.js';

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** What every source has, whatever its kind. */
const SHARED = {
  id: SourceIdSchema,
  /** Where the server fetches from. May be internal; never shown to a browser. */
  url: z.string().url(),
  /** Where a person may be sent to look. Without it there is no drill-out link. */
  publicUrl: HttpUrlSchema.optional(),
  /** The *name* of the environment variable holding a bearer token — never the token itself. */
  tokenEnv: z.string().regex(ENV_NAME, 'tokenEnv names an environment variable, e.g. ORRERY_GRAFANA_TOKEN').optional(),
  stepSeconds: z.number().int().min(10).max(86_400).default(300),
  settleSeconds: z.number().int().min(0).max(3_600).default(60),
  timeoutSeconds: z.number().positive().max(120).default(10),
};

/** Fields no kind may declare as its own. */
export const SHARED_SETTINGS: readonly string[] = ['kind', ...Object.keys(SHARED)];

/**
 * The kind's own fields first, then the shared ones, so a kind can never
 * redefine a shared field. Strict, so an inline `token` (or a typo) is refused
 * rather than ignored.
 */
function schemaFor(k: SourceKind) {
  return z
    .object({ ...k.settings, ...SHARED, kind: z.literal(k.kind) })
    .strict()
    .superRefine((s, ctx) => {
      const u = new URL(s.url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') ctx.addIssue({ code: 'custom', path: ['url'], message: 'must be http(s)' });
      if (u.username || u.password) ctx.addIssue({ code: 'custom', path: ['url'], message: 'must not carry credentials — use tokenEnv' });
      if (u.search || u.hash) ctx.addIssue({ code: 'custom', path: ['url'], message: 'must not carry a query string or fragment' });
      // A request must give up well before the next tick for the same binding is due.
      if (s.timeoutSeconds >= s.stepSeconds / 2) ctx.addIssue({ code: 'custom', path: ['timeoutSeconds'], message: 'must be under half of stepSeconds' });
    });
}

const KindSchema = z.looseObject({
  kind: z.string().refine((k) => SOURCE_KINDS.has(k), { message: `must be one of the installed kinds: ${[...SOURCE_KINDS.keys()].join(', ')}` }),
});

/** A checked source: the shared settings, the token read from `tokenEnv`, and the kind's own fields. */
export type ResolvedSource = SourceBasics & {
  tokenEnv?: string;
  /** A named token that is not set: the source is kept but never queried (fail closed). */
  tokenMissing: boolean;
} & Record<string, unknown>;

/** The module that brings a source's kind. Every parsed source has one: an unknown kind is refused at parse time. */
export function kindOf(s: Pick<ResolvedSource, 'kind'>): SourceKind {
  const k = SOURCE_KINDS.get(s.kind);
  if (!k) throw new Error(`no installed module brings the source kind “${s.kind}”`);
  return k;
}

/** What a kind's public-facing hooks are handed: everything but the token, the env-var name it came from and the URL the server fetches. */
function publicSettings(s: ResolvedSource): PublicSettings {
  const { token: _token, tokenEnv: _tokenEnv, url: _url, ...rest } = s;
  return rest;
}

/** What may leave the server about a source: an allowlist, so a new config field can't leak by default. */
export interface PublicSource {
  id: string;
  kind: string;
  /** The languages it runs. */
  runs: readonly string[];
  publicUrl: string | null;
  stepSeconds: number;
  problem: 'token-missing' | null;
  /** The kind's own allowlisted fields (for Prometheus, whether it is reached directly or through Grafana). */
  details: Record<string, PublicValue>;
}

export function toPublic(s: ResolvedSource): PublicSource {
  const k = kindOf(s);
  return {
    id: s.id,
    kind: s.kind,
    runs: [...k.runs],
    publicUrl: s.publicUrl ?? null,
    stepSeconds: s.stepSeconds,
    problem: s.tokenMissing ? 'token-missing' : null,
    details: k.details(publicSettings(s)),
  };
}

/** A link that opens a query in the source's own UI, built from its public URL only. */
export function drillOutOf(s: ResolvedSource, query: string): DrillOut | null {
  const k = kindOf(s);
  return s.publicUrl && k.drillOut ? k.drillOut(s.publicUrl, publicSettings(s), query) : null;
}

/**
 * Parses and checks a source list. Throws on anything malformed: a bad file is
 * an operator mistake best caught before the server starts, like a corrupt log.
 */
export function parseSources(raw: unknown, env: Record<string, string | undefined>, origin = 'sources'): ResolvedSource[] {
  const fail = (issue: { path: PropertyKey[]; message: string }, at: PropertyKey[] = []) => new Error(`${origin}: ${[...at, ...issue.path].map(String).join('.') || '(root)'}: ${issue.message}`);
  const entries = z.array(KindSchema).safeParse(raw);
  if (!entries.success) throw fail(entries.error.issues[0]!);
  const seen = new Set<string>();
  return entries.data.map((entry, i) => {
    const parsed = schemaFor(kindOf(entry)).safeParse(entry);
    if (!parsed.success) throw fail(parsed.error.issues[0]!, [i]);
    const s = parsed.data;
    if (seen.has(s.id)) throw new Error(`${origin}: duplicate source id “${s.id}”`);
    seen.add(s.id);
    const token = s.tokenEnv ? (env[s.tokenEnv]?.trim() ?? '') : '';
    return { ...s, token: token || null, tokenMissing: !!s.tokenEnv && !token };
  });
}

/** Loads the file `ORRERY_SOURCES_FILE` names (settings.ts). None means no sources — the same as `[]`. */
export function loadSources(file: string | null, env: Record<string, string | undefined>): ResolvedSource[] {
  if (!file) return [];
  if (!existsSync(file)) throw new Error(`ORRERY_SOURCES_FILE: ${file} does not exist`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`ORRERY_SOURCES_FILE: ${file} is not valid JSON — ${(err as Error).message}`);
  }
  return parseSources(raw, env, file);
}

export function catalogOf(sources: readonly ResolvedSource[]): SourceCatalog {
  return new Map(sources.map((s) => [s.id, { kind: s.kind, languages: kindOf(s).runs }]));
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|::1|\[::1\])$/i;

/**
 * Commands are unauthenticated, so whoever can reach the API can bind a query
 * and read its answers back from the log — the server's token turned into an
 * oracle. With sources configured, listen on loopback only unless told otherwise.
 */
export function assertSafeToServe(sources: readonly ResolvedSource[], host: string, allowRemote: boolean): void {
  if (sources.length === 0 || LOOPBACK.test(host) || allowRemote) return;
  throw new Error(
    `Refusing to listen on ${host} with metric sources configured: commands are unauthenticated, so anyone who can reach the API ` +
      'could run queries with the server’s credentials. Listen on 127.0.0.1, or set ORRERY_ALLOW_REMOTE=1 if the network is trusted.',
  );
}
