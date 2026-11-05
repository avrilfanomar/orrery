// Whether everyone can read and operate the console (ADR 0011), measured in a
// real browser: apps/web/e2e/a11y.mjs scans the views the tour walks through
// with axe-core, in both schemes, and checks focus rings and reflow. The suite
// checks the theme tokens the console is drawn from (usability.test.ts). These
// live apart from probes.ts, which imports them, so they may import only types
// from it.
import { accessibility } from './harness.js';
import type { Probe } from './probes.js';

const V11 = 'First version of this method (ADR 0011)';

export const USABILITY_PROBES: readonly Probe[] = [
  {
    id: 'ui-accessibility',
    version: 1,
    since: V11,
    method:
      'Starts the real server (src/main.ts) on a free port with a throwaway demo log and this run’s fresh UI build, then runs apps/web/e2e/a11y.mjs against it. It runs axe-core (WCAG 2.2 A and AA, and best practices) on eight views — the top level, a measured KPI, an unrefined stub, the refine, record and revise dialogs, the change feed and a past day — in the light and the dark scheme. It also tabs through the first two checking that every stop shows a focus ring, and loads them 320 CSS px wide checking that nothing scrolls sideways. A check is one rule in one view in one scheme, one page’s focus rings, or one page at one width; the value is the number of checks that fail. No reading when the server or the browser cannot start, or the scan does not finish.',
    measure: accessibility,
  },
];
