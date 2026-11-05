// Accessibility scan against a running app (default http://127.0.0.1:4710,
// i.e. `pnpm start`), ADR 0011. It visits the views the tour walks through, in
// the light and the dark scheme, and runs axe-core against each for WCAG 2.2
// A and AA plus axe's best practices. Then it tabs through two pages checking
// that every stop shows where focus is, and loads them 320 CSS px wide
// checking that nothing scrolls sideways. It only reads: dialogs are opened
// and closed, never submitted.
//
// A check is one rule in one view in one scheme, one page's focus rings, or one
// page at one width. The value is the number of checks that fail, not of
// elements, so it does not grow with the demo data (ADR 0004).
//
//   pnpm --filter @orrery/web a11y
//   ORRERY_URL=http://127.0.0.1:5710 PW_CHROMIUM=/path/to/chrome pnpm --filter @orrery/web a11y
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';

const BASE = process.env.ORRERY_URL?.trim() || 'http://127.0.0.1:4710';
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const PAST = new Date(Date.now() - 5 * 864e5).toISOString();

/** Each view: where it is, and how to get there from a fresh page. */
const VIEWS = [
  { name: 'the top level', open: (p) => p.goto(`${BASE}/`).then(() => p.locator('.tile').first().waitFor()) },
  { name: 'a measured KPI', open: (p) => p.goto(`${BASE}/?focus=k-p95`).then(() => p.locator('.verdict').waitFor()) },
  { name: 'an unrefined stub', open: (p) => p.goto(`${BASE}/?focus=r-search`).then(() => p.getByRole('heading', { name: 'Search finds relevant products' }).waitFor()) },
  { name: 'the refine dialog', open: (p) => dialog(p, 'r-search', '+ Refine') },
  { name: 'the record dialog', open: (p) => dialog(p, 'k-p95', 'Record reading') },
  { name: 'the revise dialog', open: (p) => dialog(p, 'k-p95', 'Revise definition') },
  { name: 'the change feed', open: (p) => p.goto(`${BASE}/`).then(() => p.getByRole('button', { name: /Changes/ }).click()).then(() => p.locator('.drawer .change-summary').first().waitFor()) },
  { name: 'a past day', open: (p) => p.goto(`${BASE}/?asOf=${encodeURIComponent(PAST)}`).then(() => p.locator('.past-banner').first().waitFor()) },
];

async function dialog(page, focus, button) {
  await page.goto(`${BASE}/?focus=${focus}`);
  await page.getByRole('button', { name: button, exact: true }).click();
  await page.locator('dialog[open]').waitFor();
}

const failed = [];
let checks = 0;
const report = (ok, what) => {
  checks++;
  if (!ok) failed.push(what);
  console.log(`  ${ok ? '✓' : '✗'} ${what}`);
};

async function axeViolations(page) {
  await page.evaluate(AXE);
  const result = await page.evaluate((tags) => window.axe.run(document, { runOnly: { type: 'tag', values: tags } }), TAGS);
  return result.violations;
}

/** The tab stops on the page that show no outline or ring when focused, up to `max` stops. */
async function stopsWithoutRing(page, max = 80) {
  const missing = new Set();
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const e = document.activeElement;
      if (!e || e === document.body) return null;
      const s = getComputedStyle(e);
      const ring = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || (s.boxShadow && s.boxShadow !== 'none');
      return ring ? '' : `${e.tagName.toLowerCase()} “${(e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 40)}”`;
    });
    if (stop) missing.add(stop);
  }
  return [...missing];
}

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
try {
  for (const scheme of ['light', 'dark']) {
    // axe is injected as a script, which the console's own policy forbids; this context alone sets the policy aside (never the smoke test's, ADR 0010).
    const context = await browser.newContext({ bypassCSP: true, colorScheme: scheme, viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    for (const view of VIEWS) {
      await view.open(page);
      const violations = await axeViolations(page);
      if (violations.length === 0) report(true, `${view.name} (${scheme}): no WCAG 2.2 AA or best-practice violation`);
      for (const v of violations) report(false, `${view.name} (${scheme}): ${v.id} on ${v.nodes.length} element${v.nodes.length === 1 ? '' : 's'}, e.g. ${v.nodes[0].target.join(' ')} — ${v.help}`);
    }
    await context.close();
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  for (const view of VIEWS.slice(0, 2)) {
    await view.open(page);
    const missing = await stopsWithoutRing(page);
    report(missing.length === 0, `${view.name}: every tab stop shows where focus is${missing.length ? ` — not ${missing.slice(0, 3).join(', ')}` : ''}`);
  }
  await page.setViewportSize({ width: 320, height: 800 });
  for (const view of VIEWS.slice(0, 2)) {
    await view.open(page);
    const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    report(scroll <= client, `${view.name} at 320 px: nothing scrolls sideways${scroll > client ? ` — ${scroll} px wide` : ''}`);
  }
  console.log(`a11y: ${failed.length} of ${checks} checks failed`);
  process.exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.error('a11y: could not finish —', err.message);
  process.exitCode = 2;
} finally {
  await browser.close();
}
