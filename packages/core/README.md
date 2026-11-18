# @avrilfanomar/orrery-core

The pure domain of [Orrery](https://github.com/avrilfanomar/orrery): a graph of
requirements, constraints and KPIs, kept as an append-only event log and
judged by pure rules. No Node or DOM APIs, so it runs in a browser too.

```ts
import { applyEvent, decide, emptyUniverse, evaluateUniverse, parseCommand, type OrreryEvent } from '@avrilfanomar/orrery-core';

const u = emptyUniverse();
const now = new Date().toISOString();
const cmd = parseCommand({ type: 'node.create', data: { id: 'shop', kind: 'product', title: 'Larch Store' } });
let seq = 0;
for (const e of decide(u, cmd, { now, actor: 'me', sources: new Map() })) applyEvent(u, { ...e, seq: ++seq } as OrreryEvent);

evaluateUniverse(u, now).get('shop')?.status; // 'unknown': nothing beneath it is measured yet
```

`decide` is the only gate: it refuses a command that would break the model and
returns the events to append. `project` rebuilds the state from a log, and
`evaluateUniverse` gives every node a status, a reason and its coverage.

Proof of concept, at 0.x: any minor release may break the API
([ADR 0016](https://github.com/avrilfanomar/orrery/blob/main/docs/adr/0016-what-we-publish-and-what-a-version-promises.adoc)).
Apache-2.0.
