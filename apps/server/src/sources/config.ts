// Source configuration (ADR 0002, decisions 1 and 5): how to reach the systems
// metrics are pulled from. It lives beside the log, never in it — a token in an
// append-only log could never be removed — and a binding can only choose among
// these sources, never add a URL of its own.
import { existsSync, readFileSync } from 'node:fs';
import { HttpUrlSchema, SOURCE_KINDS, SourceIdSchema, type SourceCatalog, type SourceKind } from '@ru/core';
import { z } from 'zod';

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

const SourceConfigSchema = z
  .object({
    id: SourceIdSchema,
    kind: z.enum(SOURCE_KINDS),
    /** Where the server fetches from. May be internal; never shown to a browser. */
    url: z.string().url(),
    /** Where a person may be sent to look. Without it there is no drill-out link. */
    publicUrl: HttpUrlSchema.optional(),
    /** Reach Prometheus through Grafana's datasource proxy instead of directly. */
    grafana: z.object({ datasourceUid: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'datasourceUid: letters, digits, _ and -') }).strict().optional(),
    /** The *name* of the environment variable holding a bearer token — never the token itself. */
    tokenEnv: z.string().regex(ENV_NAME, 'tokenEnv names an environment variable, e.g. RU_GRAFANA_TOKEN').optional(),
    stepSeconds: z.number().int().min(10).max(86_400).default(300),
    settleSeconds: z.number().int().min(0).max(3_600).default(60),
    timeoutSeconds: z.number().positive().max(120).default(10),
  })
  // Strict, so an inline `token` (or a typo) is refused rather than ignored.
  .strict()
  .superRefine((s, ctx) => {
    const u = new URL(s.url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') ctx.addIssue({ code: 'custom', path: ['url'], message: 'must be http(s)' });
    if (u.username || u.password) ctx.addIssue({ code: 'custom', path: ['url'], message: 'must not carry credentials — use tokenEnv' });
    if (u.search || u.hash) ctx.addIssue({ code: 'custom', path: ['url'], message: 'must not carry a query string or fragment' });
    // A request must give up well before the next tick for the same binding is due.
    if (s.timeoutSeconds >= s.stepSeconds / 2) ctx.addIssue({ code: 'custom', path: ['timeoutSeconds'], message: 'must be under half of stepSeconds' });
  });

export type SourceConfig = z.infer<typeof SourceConfigSchema>;

export interface ResolvedSource extends SourceConfig {
  /** Read from `tokenEnv` once, at startup. Only `sources/` ever sees it. */
  token: string | null;
  /** A named token that is not set: the source is kept but never queried (fail closed). */
  tokenMissing: boolean;
}

/** What may leave the server about a source: an allowlist, so a new config field can't leak by default. */
export interface PublicSource {
  id: string;
  kind: SourceKind;
  route: 'direct' | 'grafana';
  publicUrl: string | null;
  /** Only with a public URL, for building a Grafana Explore link. */
  grafanaDatasourceUid: string | null;
  stepSeconds: number;
  problem: 'token-missing' | null;
}

export function toPublic(s: ResolvedSource): PublicSource {
  return {
    id: s.id,
    kind: s.kind,
    route: s.grafana ? 'grafana' : 'direct',
    publicUrl: s.publicUrl ?? null,
    grafanaDatasourceUid: s.publicUrl && s.grafana ? s.grafana.datasourceUid : null,
    stepSeconds: s.stepSeconds,
    problem: s.tokenMissing ? 'token-missing' : null,
  };
}

/**
 * Parses and checks a source list. Throws on anything malformed: a bad file is
 * an operator mistake best caught before the server starts, like a corrupt log.
 */
export function parseSources(raw: unknown, env: Record<string, string | undefined>, origin = 'sources'): ResolvedSource[] {
  const parsed = z.array(SourceConfigSchema).safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0]!;
    throw new Error(`${origin}: ${i.path.join('.') || '(root)'}: ${i.message}`);
  }
  const seen = new Set<string>();
  return parsed.data.map((s) => {
    if (seen.has(s.id)) throw new Error(`${origin}: duplicate source id “${s.id}”`);
    seen.add(s.id);
    const token = s.tokenEnv ? (env[s.tokenEnv]?.trim() ?? '') : '';
    return { ...s, token: token || null, tokenMissing: !!s.tokenEnv && !token };
  });
}

/** Loads the file `RU_SOURCES_FILE` names (settings.ts). None means no sources — the same as `[]`. */
export function loadSources(file: string | null, env: Record<string, string | undefined>): ResolvedSource[] {
  if (!file) return [];
  if (!existsSync(file)) throw new Error(`RU_SOURCES_FILE: ${file} does not exist`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`RU_SOURCES_FILE: ${file} is not valid JSON — ${(err as Error).message}`);
  }
  return parseSources(raw, env, file);
}

export function catalogOf(sources: readonly ResolvedSource[]): SourceCatalog {
  return new Map(sources.map((s) => [s.id, { kind: s.kind }]));
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
      'could run queries with the server’s credentials. Listen on 127.0.0.1, or set RU_ALLOW_REMOTE=1 if the network is trusted.',
  );
}
