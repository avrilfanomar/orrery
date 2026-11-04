// What an empty log starts as. The choice is explicit, so pointing RU_DATA_FILE
// at the dogfood log can never plant the Larch Store demo in it (ADR 0003).
import { applyEvent, decide, emptyUniverse, parseCommand, type RuEvent } from '@ru/core';
import { generateDemo } from './demo.js';
import { DOGFOOD_MODEL } from './dogfood/model.js';
import { PROBE_SPECS } from './dogfood/probes.js';
import { planSync, resolveReasons } from './dogfood/sync.js';

export const SEED_KINDS = ['demo', 'dogfood'] as const;
export type SeedKind = (typeof SEED_KINDS)[number];

export function seedKindFrom(raw: string | undefined): SeedKind {
  const v = raw?.trim() || 'demo';
  if (!(SEED_KINDS as readonly string[]).includes(v)) throw new Error(`RU_SEED must be one of ${SEED_KINDS.join(', ')} (got “${v}”)`);
  return v as SeedKind;
}

/** The dogfood model as of now, created through the real `decide` — the same plan `pnpm dogfood` syncs. */
export function generateDogfood(now: Date): RuEvent[] {
  const at = now.toISOString();
  const u = emptyUniverse();
  const events: RuEvent[] = [];
  for (const cmd of resolveReasons(planSync(DOGFOOD_MODEL, new Map(), PROBE_SPECS), {})) {
    for (const e of decide(u, parseCommand(cmd), { now: at, actor: 'dogfood', sources: new Map() })) {
      const ev = { ...e, seq: events.length + 1 } as RuEvent;
      events.push(ev);
      applyEvent(u, ev);
    }
  }
  return events;
}

export function seedEvents(kind: SeedKind, now: Date): RuEvent[] {
  return kind === 'dogfood' ? generateDogfood(now) : generateDemo(now);
}
