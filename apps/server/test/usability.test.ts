// What the suite can say about usability without a browser (ADR 0011): the
// theme's text colours stay readable on every surface they are drawn on, in
// both schemes. The browser scan (apps/web/e2e/a11y.mjs, the `ui-accessibility`
// probe) checks what is rendered; this checks the tokens it is rendered from,
// on every `pnpm verify`, so a token edit that breaks contrast fails at once.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(join(import.meta.dirname, '../../web/src/styles.css'), 'utf8');

/** The custom properties declared in the first block that follows `selector`. */
function tokens(selector: string): Record<string, string> {
  const at = CSS.indexOf(selector);
  if (at < 0) throw new Error(`styles.css no longer has ${selector}`);
  const body = CSS.slice(CSS.indexOf('{', at) + 1, CSS.indexOf('}', at));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

type Rgba = [number, number, number, number];

function parse(colour: string): Rgba {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(colour);
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map((c) => c + c).join('') : hex[1]!;
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1) as Rgba;
  }
  const rgba = /^rgba?\(([^)]+)\)$/.exec(colour);
  if (rgba) {
    const [r, g, b, a = 1] = rgba[1]!.split(',').map(Number);
    return [r!, g!, b!, a];
  }
  throw new Error(`not a colour this test reads: ${colour}`);
}

/** `top` painted over the opaque `under`. */
const over = (top: Rgba, under: Rgba): Rgba => [0, 1, 2].map((i) => top[i]! * top[3] + under[i]! * (1 - top[3])).concat(1) as Rgba;

/** WCAG 2.2 relative luminance and contrast ratio. */
const luminance = ([r, g, b]: Rgba) => {
  const lin = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a: Rgba, b: Rgba) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

const LIGHT = tokens(':root {');
const DARK_BY_PREFERENCE = tokens(":root:not([data-theme='light'])");
const DARK_BY_CHOICE = tokens(":root[data-theme='dark']");

/** The text colours and every surface they are drawn on: the opaque ones, and the washes over the surface they tint. */
const TEXT = ['ink', 'ink-2', 'muted', 'accent-ink'];
const SURFACES = ['page', 'surface', 'surface-2', 'sunken'];
const WASHES: [string, string][] = [['accent-wash', 'page'], ['wash-ok', 'surface'], ['wash-warn', 'surface'], ['wash-breach', 'surface'], ['wash-unknown', 'surface']];

/** Every pair below 4.5:1 (WCAG 2.2 AA for normal text) in a scheme, as "text on surface: ratio". */
function shortfalls(t: Record<string, string>): string[] {
  const c = (name: string) => parse(t[name] ?? (() => { throw new Error(`no --${name}`); })());
  const grounds: [string, Rgba][] = [...SURFACES.map((s): [string, Rgba] => [s, c(s)]), ...WASHES.map(([w, s]): [string, Rgba] => [`${w} over ${s}`, over(c(w), c(s))])];
  const pairs: [string, string, Rgba, Rgba][] = [
    ...TEXT.flatMap((x) => grounds.map(([g, rgb]): [string, string, Rgba, Rgba] => [x, g, c(x), rgb])),
    ['on-accent', 'accent', c('on-accent'), c('accent')],
    ['on-accent', 'accent-ink', c('on-accent'), c('accent-ink')],
  ];
  return pairs.filter(([, , a, b]) => contrast(a, b) < 4.5).map(([x, g, a, b]) => `--${x} on --${g}: ${contrast(a, b).toFixed(2)}:1`);
}

describe('the theme is readable in both schemes', () => {
  it('gives every text colour at least 4.5:1 on every surface it is drawn on', () => {
    expect(shortfalls(LIGHT), 'light').toEqual([]);
    expect(shortfalls({ ...LIGHT, ...DARK_BY_PREFERENCE }), 'dark').toEqual([]);
  });

  it('defines the dark scheme the same way whether the system asks for it or a page sets it', () => {
    expect(DARK_BY_CHOICE).toEqual(DARK_BY_PREFERENCE);
  });
});
