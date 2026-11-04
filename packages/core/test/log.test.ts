import { describe, expect, it } from 'vitest';
import { checkLogEntry, isCanonicalInstant, type RuEvent } from '../src/index.js';

const created = (seq: number, at: string): RuEvent => ({
  seq,
  at,
  actor: 'test',
  type: 'node.created',
  data: {
    id: `n${seq}`,
    kind: 'goal',
    title: `Node ${seq}`,
    description: '',
    parentId: null,
    links: [],
    priority: 'medium',
    dimensions: [],
    owner: null,
    measure: null,
    rollup: { strategy: 'worst' },
    scenario: null,
    reason: null,
  },
});

const problem = (raw: unknown, prev?: RuEvent) => {
  const r = checkLogEntry(raw, prev);
  return r.ok ? null : r.problem;
};

describe('the log contract', () => {
  it('knows the one spelling of an instant core compares as text', () => {
    expect(isCanonicalInstant('2026-11-04T10:00:00.000Z')).toBe(true);
    expect(isCanonicalInstant('2026-11-04T10:00:00Z')).toBe(false);
    expect(isCanonicalInstant('2026-11-04T11:00:00.000+01:00')).toBe(false);
    expect(isCanonicalInstant('+010000-01-01T00:30:00.000Z')).toBe(false);
    expect(isCanonicalInstant('-000001-12-31T23:30:00.000Z')).toBe(false);
    expect(isCanonicalInstant('2026-02-30T00:00:00.000Z')).toBe(false);
  });

  it('accepts a well-formed successor, including one recorded later than any clock', () => {
    const first = created(1, '2026-11-04T10:00:00.000Z');
    expect(problem(first)).toBeNull();
    expect(problem(created(2, '2099-01-01T00:00:00.000Z'), first)).toBeNull();
  });

  it('refuses gaps and repeats in the sequence', () => {
    const first = created(1, '2026-11-04T10:00:00.000Z');
    expect(problem(created(3, '2026-11-04T10:00:00.000Z'), first)).toMatch(/sequence number 3, expected 2/);
    expect(problem(created(1, '2026-11-04T10:00:00.000Z'), first)).toMatch(/sequence number 1, expected 2/);
    expect(problem(created(2, '2026-11-04T10:00:00.000Z'))).toMatch(/expected 1/);
  });

  it('refuses an event recorded before its predecessor', () => {
    const first = created(1, '2026-11-04T10:00:00.000Z');
    expect(problem(created(2, '2026-11-04T09:59:59.999Z'), first)).toMatch(/before the event preceding it/);
  });

  it('refuses non-canonical instants, which would sort wrongly as text', () => {
    expect(problem(created(1, '2026-11-04T11:00:00+01:00'))).toMatch(/not a canonical UTC instant/);
    const reading = { seq: 1, at: '2026-11-04T10:00:00.000Z', actor: 'ingest', type: 'reading.recorded', data: { nodeId: 'k', value: 1, observedAt: '2026-11-04T10:00:00Z', source: 'ci' } };
    expect(problem(reading)).toMatch(/observed at .* not a canonical UTC instant/);
  });

  it('names the field when the schema refuses an event', () => {
    expect(problem({ ...created(1, '2026-11-04T10:00:00.000Z'), actor: '' })).toMatch(/^does not match the event schema — actor:/);
    expect(problem({ seq: 1, at: '2026-11-04T10:00:00.000Z', actor: 'x', type: 'node.exploded', data: {} })).toMatch(/event schema/);
  });
});
