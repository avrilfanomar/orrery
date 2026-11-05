// The installed modules (ADR 0013). Core knows no query language and no source
// kind; the server learns them here and nowhere else, so installing a module is
// one line below and a dependency in package.json.
import type { OrreryModule, QueryLanguage, SourceKind } from '@ru/module-kit';
import { prometheus } from '@ru/prometheus';
import { DOGFOOD_MODULE } from './dogfood/module.js';

export const MODULES: readonly OrreryModule[] = [prometheus, DOGFOOD_MODULE];

export const LANGUAGES: ReadonlyMap<string, QueryLanguage> = new Map(MODULES.flatMap((m) => (m.languages ?? []).map((l) => [l.id, l] as const)));

export const SOURCE_KINDS: ReadonlyMap<string, SourceKind> = new Map(MODULES.flatMap((m) => (m.sources ?? []).map((k) => [k.kind, k] as const)));

/** What the console is told about a language: an allowlist, plus the installed kinds that run it. */
export interface PublicLanguage {
  id: string;
  label: string;
  hint: string;
  provenance: string | null;
  /** Installed source kinds that run it; empty when nothing can pull a query in it. */
  kinds: string[];
}

export function publicLanguages(): PublicLanguage[] {
  return [...LANGUAGES.values()].map((l) => ({
    id: l.id,
    label: l.label,
    hint: l.hint,
    provenance: l.provenance ?? null,
    kinds: [...SOURCE_KINDS.values()].filter((k) => k.runs.includes(l.id)).map((k) => k.kind),
  }));
}

/**
 * What would make the registry ambiguous: two modules claiming one language or
 * kind, or a kind running a language nobody declares. Empty when it is sound;
 * the suite holds the installed modules to it.
 */
export function registryProblems(modules: readonly OrreryModule[]): string[] {
  const problems: string[] = [];
  const claimed = (what: string, ids: string[]) => ids.filter((id, i) => ids.indexOf(id) !== i).forEach((id) => problems.push(`${what} “${id}” is declared twice`));
  const languages = modules.flatMap((m) => (m.languages ?? []).map((l) => l.id));
  claimed('module', modules.map((m) => m.id));
  claimed('language', languages);
  claimed('source kind', modules.flatMap((m) => (m.sources ?? []).map((k) => k.kind)));
  for (const k of modules.flatMap((m) => m.sources ?? [])) {
    for (const l of k.runs) if (!languages.includes(l)) problems.push(`source kind “${k.kind}” runs “${l}”, which no module declares`);
  }
  return problems;
}
