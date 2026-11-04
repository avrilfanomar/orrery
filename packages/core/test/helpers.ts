import { applyEvent, checkLogEntry, decide, emptyUniverse, parseCommand, type CommandInput, type RuEvent, type Universe } from '../src/index.js';

/**
 * A tiny in-memory log with a controllable clock, driven through the real
 * `decide` and held to the same storage contract as the server's store.
 */
export function makeLog(start = '2026-01-01T00:00:00.000Z') {
  const events: RuEvent[] = [];
  const u: Universe = emptyUniverse();
  let t = Date.parse(start);
  return {
    events,
    u,
    now: () => new Date(t).toISOString(),
    at: (iso: string) => {
      t = Date.parse(iso);
    },
    advanceHours: (h: number) => {
      t += h * 3.6e6;
    },
    run(cmd: CommandInput, actor = 'test') {
      const out = decide(u, parseCommand(cmd), { now: new Date(t).toISOString(), actor });
      for (const e of out) {
        const checked = checkLogEntry({ ...e, seq: events.length + 1 }, events.at(-1));
        if (!checked.ok) throw new Error(`decide produced an event the log would refuse: ${checked.problem}`);
        events.push(checked.event);
        applyEvent(u, checked.event);
      }
      return out;
    },
  };
}

export const pctHigher = (target: number, warn: number, staleAfterHours = 24) => ({
  unit: '%',
  direction: 'higher' as const,
  target,
  warn,
  staleAfterHours,
});

export const msLower = (target: number, warn: number, staleAfterHours = 24) => ({
  unit: 'ms',
  direction: 'lower' as const,
  target,
  warn,
  staleAfterHours,
});
