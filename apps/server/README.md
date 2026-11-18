# @avrilfanomar/orrery

[Orrery](https://github.com/avrilfanomar/orrery) keeps requirements,
constraints and business + quality KPIs in one living, observable graph. You
see it whole from the top, explore it one level at a time, and it evolves
without rewriting its past. This package is the server with its console, in
one command.

```bash
npx @avrilfanomar/orrery             # the console on http://127.0.0.1:4710
npx @avrilfanomar/orrery simulate    # in a second terminal: keep the demo's signals moving
npx @avrilfanomar/orrery reset       # stop the server first: re-seed the demo relative to now
```

On first start it seeds **Larch Store**, a fictional online shop with thirty
days of history and an incident in progress. The log goes to
`orrery-data/events.jsonl` in the directory you run it from, and it is only
ever appended to. A reset keeps the log it replaced beside the new one.

Node ≥ 20.19. Every setting is an environment variable, listed in the
[configuration table](https://github.com/avrilfanomar/orrery#configuration).
It binds to loopback unless `HOST` says otherwise. The
[README](https://github.com/avrilfanomar/orrery#readme) has a five-minute tour.

Proof of concept, at 0.x: the event format, the API and the console may all
change in any minor release
([ADR 0016](https://github.com/avrilfanomar/orrery/blob/main/docs/adr/0016-what-we-publish-and-what-a-version-promises.adoc)).
Apache-2.0.
