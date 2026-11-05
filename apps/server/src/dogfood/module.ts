// The dogfood's part of the registry (ADR 0013): the `probe` language. A probe
// binding names a repository probe as `<probe-id>@<version>` (ADR 0003). No
// source kind runs it, so a probe binding is always provenance only; bumping
// the version is a new query, hence a new yardstick.
import type { OrreryModule } from '@ru/module-kit';

export const DOGFOOD_MODULE: OrreryModule = {
  id: 'dogfood',
  languages: [
    {
      id: 'probe',
      label: 'Probe',
      hint: 'A probe’s id@version, measured by `pnpm dogfood` and never pulled. A new version is a new method, so it starts a new yardstick.',
      provenance: 'measured by a repository probe (`pnpm dogfood`)',
    },
  ],
};
