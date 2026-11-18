# @avrilfanomar/orrery-module-kit

The contract an [Orrery](https://github.com/avrilfanomar/orrery) module
implements: the query languages a metric binding may be written in, and the
source kinds the server can pull readings from. A module depends on this kit
and on `@avrilfanomar/orrery-core`, and on nothing else of Orrery's
([ADR 0013](https://github.com/avrilfanomar/orrery/blob/main/docs/adr/0013-modules-bring-what-core-does-not-know.adoc)).

```ts
import { defineSourceKind, type OrreryModule } from '@avrilfanomar/orrery-module-kit';
```

See [`@avrilfanomar/orrery-prometheus`](https://www.npmjs.com/package/@avrilfanomar/orrery-prometheus)
for a complete module. The types mention `fetch`, so a consumer needs the
`DOM` lib or `@types/node`.

The server still installs modules in one file of its own, so a module written
elsewhere can't be plugged into the published app yet.

Proof of concept, at 0.x: any minor release may break the API
([ADR 0016](https://github.com/avrilfanomar/orrery/blob/main/docs/adr/0016-what-we-publish-and-what-a-version-promises.adoc)).
Apache-2.0.
