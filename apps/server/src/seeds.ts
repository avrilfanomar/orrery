// What an empty log starts as. The choice is explicit, so pointing ORRERY_DATA_FILE
// at the dogfood log can never plant the Larch Store demo in it (ADR 0003).
import { applyEvent, decide, emptyUniverse, parseCommand, type OrreryEvent } from '@orrery/core';
import { generateDemo } from './demo.js';
import { DOGFOOD_MODEL } from './dogfood/model.js';
import { PROBE_SPECS } from './dogfood/probes.js';
import { planSync, resolveReasons } from './dogfood/sync.js';
import type { SeedKind } from './settings.js';

export { SEED_KINDS, seedKindFrom, type SeedKind } from './settings.js';

/** The dogfood model as of now, created through the real `decide` — the same plan `pnpm dogfood` syncs. */
export function generateDogfood(now: Date): OrreryEvent[] {
  const at = now.toISOString();
  const u = emptyUniverse();
  const events: OrreryEvent[] = [];
  for (const cmd of resolveReasons(planSync(DOGFOOD_MODEL, new Map(), PROBE_SPECS), {})) {
    for (const e of decide(u, parseCommand(cmd), { now: at, actor: 'dogfood', sources: new Map() })) {
      const ev = { ...e, seq: events.length + 1 } as OrreryEvent;
      events.push(ev);
      applyEvent(u, ev);
    }
  }
  return events;
}

export function seedEvents(kind: SeedKind, now: Date): OrreryEvent[] {
  return kind === 'dogfood' ? generateDogfood(now) : generateDemo(now);
}
