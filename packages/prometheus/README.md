# @avrilfanomar/orrery-prometheus

An [Orrery](https://github.com/avrilfanomar/orrery) module that brings PromQL
and the Prometheus source kind. A source can reach Prometheus directly or
through Grafana's datasource proxy. The published Orrery server ships with it
installed.

```ts
import { prometheus } from '@avrilfanomar/orrery-prometheus';
```

Proof of concept, at 0.x: any minor release may break the API
([ADR 0016](https://github.com/avrilfanomar/orrery/blob/main/docs/adr/0016-what-we-publish-and-what-a-version-promises.adoc)).
Apache-2.0.
