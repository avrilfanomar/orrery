// End-to-end smoke test against a running app (default http://127.0.0.1:4710,
// i.e. `pnpm start`). It walks the evolution loop through the real UI:
// refine an unrefined stub into a KPI, record a reading, revise the target
// (and check the reason is enforced), then find the change in the feed. Then
// it follows a metric into its code and back, and finds it again with Jump to
// (ADR 0014). Last,
// it stops the API's answers and checks the console stops calling itself live.
// It writes to the event log — run `pnpm reset` afterwards for a clean demo.
//
//   pnpm --filter @orrery/web e2e
//   ORRERY_URL=http://127.0.0.1:5710 PW_CHROMIUM=/path/to/chrome pnpm --filter @orrery/web e2e
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const BASE = process.env.ORRERY_URL?.trim() || 'http://127.0.0.1:4710';
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const ok = (s) => console.log(`  ✓ ${s}`);
const title = `Zero-result search rate ${Date.now().toString(36)}`;
const verdict = () => page.locator('.verdict .badge').innerText();

try {
  await page.goto(`${BASE}/?focus=r-search`);
  await page.getByRole('heading', { name: 'Search finds relevant products' }).waitFor();
  ok('an unrefined stub opens in focus');

  await page.getByRole('button', { name: '+ Refine', exact: true }).click();
  const refine = page.locator('dialog[open]');
  await refine.getByLabel('Title').fill(title);
  await refine.getByLabel('Unit').fill('%');
  await refine.getByLabel('Better when').selectOption('lower');
  await refine.getByLabel('Target').fill('5');
  await refine.getByLabel('Warning until').fill('10');
  await refine.getByRole('button', { name: 'Add' }).click();
  await page.getByRole('heading', { name: title }).waitFor();
  assert.equal(await verdict(), 'Unknown');
  ok('refining lands on the new KPI, unknown until measured');

  await page.getByRole('button', { name: 'Record reading' }).click();
  await page.locator('dialog[open]').getByLabel(/Value/).fill('7.5');
  await page.locator('dialog[open]').getByRole('button', { name: 'Record' }).click();
  await page.locator('.verdict .badge', { hasText: 'Warning' }).waitFor();
  ok('a manual reading of 7.5% is judged a warning against ≤ 5%');

  await page.getByRole('button', { name: 'Revise definition' }).click();
  const revise = page.locator('dialog[open]');
  await revise.getByLabel('Target').fill('8');
  await revise.getByLabel('Warning until').fill('12');
  await revise.getByRole('button', { name: /Publish v2/ }).click();
  assert.ok(await revise.isVisible(), 'a revision without a reason must not submit');
  ok('a revision without a reason is refused');
  await revise.getByLabel(/Why\?/).fill('Baseline measured; start realistic and tighten later');
  await revise.getByRole('button', { name: /Publish v2/ }).click();
  await page.locator('.verdict .badge', { hasText: 'On target' }).waitFor();
  ok('publishing v2 (≤ 8%) turns it green from now on');

  await page.goto(`${BASE}/`);
  await page.getByRole('button', { name: /Changes/ }).click();
  const latest = await page.locator('.drawer .change-summary').first().innerText();
  assert.match(latest, /to v2: target ≤ 5% → ≤ 8%/);
  ok('the revision heads the change feed with its diff');

  await page.goto(`${BASE}/?focus=k-5xx`);
  await page.locator('.conn summary', { hasText: 'Implementation' }).click();
  await page.getByRole('button', { name: /services\/checkout\/src\/payments\.ts/ }).click();
  await page.getByRole('heading', { name: /Referenced by 2 nodes/ }).waitFor();
  await page.locator('.referrers .conn-node', { hasText: 'Checkout is short and dependable' }).click();
  await page.getByRole('heading', { level: 1, name: 'Checkout is short and dependable' }).waitFor();
  ok('a metric leads to its code, and the file back to the requirement it backs');

  await page.keyboard.press('Control+k');
  await page.keyboard.type('5xx');
  await page.getByRole('option', { name: /Checkout server errors/ }).waitFor();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { level: 1, name: /5xx rate/ }).waitFor();
  ok('Jump to finds a metric by name and opens it from the keyboard');

  await page.getByRole('button', { name: '+ Reference' }).click();
  const reference = page.locator('dialog[open]');
  await reference.getByLabel('A link').check();
  await reference.getByLabel('Kind').fill('ticket');
  const ticket = `SRE-${Date.now().toString(36)}`;
  await reference.getByLabel('URL').fill(`https://tracker.larch.example/browse/${ticket}`);
  await reference.getByLabel('Label (optional)').fill(ticket);
  await reference.getByRole('button', { name: 'Add reference' }).click();
  await page.locator('.conn summary', { hasText: 'References' }).click();
  await page.locator('.ref-target', { hasText: ticket }).waitFor();
  ok('a reference is added from the console without a reason');

  assert.deepEqual(errors, [], 'no browser console errors');
  ok('no console errors');

  // Last, because the requests it blocks log errors of their own. A console
  // that keeps the last picture up under "Live" is how someone acts on a green
  // that no longer holds (ADR 0009).
  const notLive = page.getByRole('alert').filter({ hasText: 'Not live' });
  await page.route('**/api/universe**', (route) => route.abort());
  await notLive.waitFor({ timeout: 20_000 });
  assert.equal(await page.locator('.tt-label').innerText(), 'Not live');
  ok('when the server stops answering, the console says it is not live');
  await page.unroute('**/api/universe**');
  await notLive.waitFor({ state: 'detached', timeout: 20_000 });
  ok('it says live again once answers return');
  const hung = [];
  await page.route('**/api/universe**', (route) => void hung.push(route));
  await notLive.waitFor({ timeout: 30_000 });
  ok('a server that accepts the request but never answers is not live either');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  console.log('smoke: passed');
} catch (err) {
  await page.screenshot({ path: 'smoke-failure.png', fullPage: true }).catch(() => {});
  console.error('smoke: FAILED —', err.message, '(screenshot: smoke-failure.png)');
  process.exitCode = 1;
} finally {
  await browser.close();
}
