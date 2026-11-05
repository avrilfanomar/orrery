// What a module may teach Orrery that core does not know (ADR 0013): the
// languages a binding's query is written in, and the systems the server can
// pull a metric from. Core checks only that a binding is well formed and that
// the source it names runs its language; everything specific to Prometheus,
// Grafana or any other system lives in the module that brings it.
import type { z } from 'zod';

/** A language a binding's query may be written in. Core checks only the id's spelling; this is what people are told about it. */
export interface QueryLanguage {
  /** The id stored in a binding (`promql`). Part of the logged definition, so it never changes meaning. */
  id: string;
  /** How the console names it (`PromQL`). */
  label: string;
  /** What a query must return to make a good reading. */
  hint: string;
  /** How the console describes a binding nobody pulls, when this language has its own way in (the dogfood's probes). */
  provenance?: string;
}

/** Instants are Unix milliseconds on the source's step grid; the collector chooses them. */
export interface RangeQuery {
  query: string;
  start: number;
  end: number;
  stepSeconds: number;
}

export interface Sample {
  /** Evaluation instant, Unix milliseconds. */
  t: number;
  value: number;
}

/** Why an adapter got no samples. The collector adds its own reasons (refused, not configured…) beside these. */
export type PullFailure = 'unreachable' | 'timeout' | 'http' | 'bad-query' | 'empty' | 'multi-series';

export type PullResult = { ok: true; samples: Sample[]; skipped: number } | { ok: false; category: PullFailure; httpStatus?: number; detail?: string };

/** What every source has, whatever its kind: checked by the server before a module sees it. */
export interface SourceBasics {
  id: string;
  kind: string;
  /** Where the server fetches from. May be internal; never shown to a browser. */
  url: string;
  /** Where a person may be sent to look. */
  publicUrl?: string;
  stepSeconds: number;
  settleSeconds: number;
  timeoutSeconds: number;
  /** Read from the environment variable the operator named, once, at startup. */
  token: string | null;
}

/** A value an allowlist may let out. */
export type PublicValue = string | number | boolean | null;

/** What a kind's public-facing hooks see: its settings, never the token nor the URL the server fetches from. */
export type PublicSettings<S extends z.ZodRawShape = z.ZodRawShape> = Omit<SourceBasics, 'token' | 'url'> & z.infer<z.ZodObject<S>>;

export interface DrillOut {
  href: string;
  label: string;
}

/**
 * A system the server can pull from. A module adds only what is its own: the
 * shared settings (URL, token by env-var name, cadence) and their checks stay
 * with the server, so no kind can loosen them.
 */
export interface SourceKind<S extends z.ZodRawShape = z.ZodRawShape> {
  /** The `kind` an operator writes in the sources file. */
  kind: string;
  /** The ids of the languages this kind runs. Each must be a language some installed module declares. */
  runs: readonly string[];
  /** The kind's own settings beside the shared ones. The whole entry is strict, so a typo or an inline token is refused. */
  settings: S;
  /** What may be shown about the kind's own settings: an allowlist, never a spread. It is never handed the credentials. */
  details(source: PublicSettings<S>): Record<string, PublicValue>;
  /** One range query, translated into samples or a failure. The binding supplies only the query text; where it goes is fixed here. */
  queryRange(source: SourceBasics & z.infer<z.ZodObject<S>>, query: RangeQuery, fetchImpl: typeof fetch): Promise<PullResult>;
  /** A link that opens the query in the system's own UI, built from `publicUrl` only. It is never handed the credentials or the URL the server fetches. */
  drillOut?(publicUrl: string, source: PublicSettings<S>, query: string): DrillOut | null;
}

export interface OrreryModule {
  /** A name for messages and for the registry's own checks. */
  id: string;
  languages?: readonly QueryLanguage[];
  sources?: readonly SourceKind[];
}

/** Keeps a kind's settings and its functions in step, so `details` and `queryRange` see the fields `settings` declares. */
export function defineSourceKind<S extends z.ZodRawShape>(kind: SourceKind<S>): SourceKind {
  return kind as unknown as SourceKind;
}
