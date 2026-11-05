// The parser's share of the security promises (ADR 0010). Every command an API
// caller sends passes through this schema before anything else reads it, so a
// request sized to the server's body limit must cost no more to refuse than a
// small one.
import { describe, expect, it } from 'vitest';
import { CommandSchema } from '../src/index.js';

/** About what fits in the server's 4 MiB body limit: one character and a comma each. */
const MANY = 2_000_000;

describe('an oversized request is refused at its first limit', () => {
  it('reports one problem for a collection far over its limit, without reading its elements', () => {
    // A parser that checks each element first keeps one problem per element: millions of objects, seconds of a blocked server, gigabytes of memory.
    const cases = [
      { type: 'node.create', data: { kind: 'goal', title: 'G', links: new Array(MANY).fill(0) } },
      { type: 'node.create', data: { kind: 'goal', title: 'G', dimensions: new Array(MANY).fill('nope') } },
      { type: 'node.edit', data: { id: 'g', dimensions: new Array(MANY).fill(0) } },
    ];
    for (const input of cases) {
      const parsed = CommandSchema.safeParse(input);
      expect(parsed.success, input.type).toBe(false);
      expect(parsed.error!.issues.map((i) => [i.code, i.path.join('.')]), input.type).toEqual([['too_big', `data.${Object.keys(input.data).find((k) => Array.isArray((input.data as Record<string, unknown>)[k]))}`]]);
    }
  });
});
