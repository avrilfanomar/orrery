// Records docs/tour.gif, the README's picture of the tour, and docs/tour-still.png,
// its first frame for readers who ask for less motion, against a running
// app (default http://127.0.0.1:4710, i.e. `pnpm start`) holding a freshly
// seeded demo: the story's statuses move with the clock (`pnpm reset` first).
// It only reads. A click is shown by outlining its target first, because a
// headless browser draws no cursor. Captions are drawn on a blank page beside
// the screenshots, so the console in the picture is exactly the console.
// Needs ffmpeg on PATH.
//
//   pnpm --filter @ru/web readme-gif
//   RU_URL=http://127.0.0.1:5710 PW_CHROMIUM=/path/to/chrome pnpm --filter @ru/web readme-gif
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const BASE = process.env.RU_URL?.trim() || 'http://127.0.0.1:4710';
const OUT = fileURLToPath(new URL('../../../docs/tour.gif', import.meta.url));
const STILL = fileURLToPath(new URL('../../../docs/tour-still.png', import.meta.url));
const VIEW = { width: 1280, height: 820 }; // the narrowest the header keeps to one line
const HOUR = 36e5;
const DAY = 24 * HOUR;

const dir = mkdtempSync(join(tmpdir(), 'ru-gif-'));
const frames = [];
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const page = await browser.newPage({ viewport: VIEW, colorScheme: 'light' });
const card = await browser.newPage({ viewport: { width: VIEW.width, height: 100 } });

/** Screenshots the console and keeps it, captioned, for `seconds`. */
async function shot(caption, seconds) {
  await page.waitForTimeout(350); // let a re-render and its transitions settle
  const png = (await page.screenshot()).toString('base64');
  // GitHub shows the picture at about two thirds of its width: the caption is sized for that,
  // and one line high on every frame, because the encoder needs frames of one size.
  await card.setContent(`<body style="margin:0;font:24px/1 system-ui,'Noto Sans',sans-serif">
    <img src="data:image/png;base64,${png}" style="display:block">
    <div style="background:#1d2430;color:#fff;height:64px;padding:0 24px;display:flex;align-items:center;white-space:nowrap"><span>${caption}</span></div></body>`);
  const file = join(dir, `f${String(frames.length).padStart(3, '0')}.png`);
  await card.locator('body').screenshot({ path: file });
  frames.push({ file, seconds });
}

/** Outlines a control, so the picture shows where the move was. */
const mark = (locator) =>
  locator.evaluate((el) => {
    el.style.outline = '3px solid #e8590c';
    el.style.outlineOffset = '3px';
  });

async function point(locator, caption) {
  await locator.scrollIntoViewIfNeeded();
  await mark(locator);
  await shot(caption, 1.5);
  await locator.click();
}

/** Back to the breadcrumb: the focus pane scrolls, not the window. */
const top = () => page.locator('.main').evaluate((el) => el.scrollTo(0, 0));

async function open(focus) {
  await page.goto(`${BASE}/${focus ? `?focus=${focus}` : ''}`);
  await page.locator('.verdict').first().waitFor();
}

async function drill() {
  await open(null);
  const badge = await page.locator('.verdict .badge').first().innerText();
  if (badge !== 'Breach') throw new Error(`The top level reads “${badge}”, not Breach: record against a freshly seeded demo (pnpm reset)`);
  await shot('<b>1 · One graph, one status.</b> Larch Store is in breach, and says why.', 2.8);
  await point(page.locator('.tile', { hasText: 'Customers find and buy' }).first(), '<b>2 · Open a tile</b> to go one level deeper…');
  await page.getByRole('heading', { name: /Customers find and buy/ }).waitFor();
  await top();
  await shot('<b>2 · …one node, exactly one level below.</b> The breadcrumb climbs back.', 2.6);
}

async function signal() {
  await point(page.locator('.signal button').last(), '<b>3 · Follow the signal</b> from the red goal…');
  await page.getByRole('heading', { name: /5xx/ }).waitFor();
  await top();
  await shot('<b>3 · …straight to the reading behind it.</b> Linked, it counts under checkout too.', 2.6);
}

async function yardstick() {
  await open('k-p95');
  await page.locator('.panel svg').first().scrollIntoViewIfNeeded();
  await shot('<b>4 · Targets evolve, with a reason.</b> Older readings keep the old yardstick.', 3.2);
}

async function unknown() {
  await open('g-safe');
  await shot('<b>5 · Unmeasured is unknown, never green.</b> The EU audit has never run.', 2.6);
}

async function timeTravel() {
  await open('k-p95');
  const slider = page.getByRole('slider', { name: /another moment/ });
  const [min, max] = await slider.evaluate((el) => [Number(el.min), Number(el.max)]);
  // The slider steps by the hour from its start; a value off the step is never accepted.
  const at = (t) => String(min + Math.round((t - min) / HOUR) * HOUR);
  const target = Math.max(min, max - 21 * DAY);
  await mark(slider);
  for (const t of [0.35, 0.7]) {
    await slider.fill(at(max - (max - target) * t));
    await shot('<b>6 · Time travel.</b> Drag back through the log…', 0.7);
  }
  await slider.fill(at(target));
  await page.locator('.past-banner').first().waitFor();
  await shot('<b>6 · …to the universe as known three weeks ago.</b> The KPI is green; <i>Search</i> is not there yet.', 3.2);
}

function encode() {
  const list = frames.map((f) => `file '${f.file}'\nduration ${f.seconds}`).join('\n');
  writeFileSync(join(dir, 'frames.txt'), `${list}\nfile '${frames.at(-1).file}'\n`);
  const palette = 'split[a][b];[a]palettegen=stats_mode=diff:max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle';
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'frames.txt'), '-vf', palette, '-fps_mode', 'vfr', '-loop', '0', OUT], { stdio: 'inherit' });
}

try {
  await drill();
  await signal();
  await yardstick();
  await unknown();
  await timeTravel();
  encode();
  copyFileSync(frames[0].file, STILL);
  console.log(`  ✓ ${OUT}: ${frames.length} frames, ${(statSync(OUT).size / 1024).toFixed(0)} KiB`);
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
