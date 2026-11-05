// The storage contract of the event log. One check serves both directions:
// the store runs it before writing an event and again when loading the log,
// so the server can never write a line it would later refuse.
//
// The contract is strict on purpose (ADR 0001, decision 4): a log that breaks
// it is refused, never repaired in place. Tightening a rule here can strand an
// existing log — apps/server/test/fixtures/events.v1.jsonl is frozen history
// that must keep loading, so such a change fails a test instead of a deploy.
import { EventSchema, type OrreryEvent } from './schema.js';

const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * True for the one spelling of an instant that core may compare as text:
 * UTC, milliseconds, a four-digit year (what `toISOString` gives for 0000–9999).
 */
export function isCanonicalInstant(s: string): boolean {
  if (!CANONICAL_INSTANT.test(s)) return false;
  const t = Date.parse(s);
  return !Number.isNaN(t) && new Date(t).toISOString() === s;
}

export type LogEntryCheck = { ok: true; event: OrreryEvent } | { ok: false; problem: string };

/**
 * Checks one stored event against the contract, given the event before it:
 * it matches the event schema, its sequence number follows on, its instants
 * are canonical, and it was not recorded before its predecessor (projection
 * stops at the first event past an `asOf`, so order is load-bearing).
 * A recording time later than the clock is allowed: refusing it would turn a
 * clock step into an outage.
 */
export function checkLogEntry(raw: unknown, prev: OrreryEvent | undefined): LogEntryCheck {
  const parsed = EventSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    return { ok: false, problem: `does not match the event schema — ${where}${issue?.message ?? 'invalid'}` };
  }
  const e = parsed.data;
  const expected = (prev?.seq ?? 0) + 1;
  if (e.seq !== expected) return { ok: false, problem: `has sequence number ${e.seq}, expected ${expected}` };
  if (!isCanonicalInstant(e.at)) return { ok: false, problem: `was recorded at “${e.at}”, which is not a canonical UTC instant` };
  if (e.type === 'reading.recorded' && !isCanonicalInstant(e.data.observedAt)) {
    return { ok: false, problem: `was observed at “${e.data.observedAt}”, which is not a canonical UTC instant` };
  }
  if (prev && e.at < prev.at) return { ok: false, problem: `was recorded at ${e.at}, before the event preceding it (${prev.at})` };
  return { ok: true, event: e };
}
