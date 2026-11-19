import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** Colour contrast of the design tokens in both themes, read from the stylesheet itself so later edits cannot regress it. */
const CSS = fs.readFileSync(path.resolve(import.meta.dirname, '../src/static/app.css'), 'utf8');

type RGB = [number, number, number];

/** The custom properties declared in the first block that starts with `selector {`. */
function tokens(selector: string): Record<string, string> {
  const start = CSS.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = CSS.slice(start + selector.length + 2, CSS.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

/** A hex or `rgb(r g b / a)` colour, with transparency composited over `under`. */
function rgb(value: string, under?: RGB): RGB {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)) as RGB;
  const m = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(value);
  if (!m || !under) throw new Error(`unsupported colour ${value}`);
  const a = Number(m[4]);
  return [1, 2, 3].map((i, k) => Number(m[i]) * a + under[k] * (1 - a)) as RGB;
}

const luminance = (c: RGB): number => {
  const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: RGB, b: RGB): number => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const LIGHT = tokens(':root');
const DARK = { ...LIGHT, ...tokens(':root[data-theme="dark"]') };

const TEXT = ['ink', 'ink-2', 'ink-3', 'link', 'success', 'danger', 'warning'];
const SURFACES = ['surface', 'surface-2', 'canvas'];

describe.each([['light', LIGHT], ['dark', DARK]] as const)('%s theme', (_name, theme) => {
  const colour = (token: string, under = 'surface'): RGB => rgb(theme[token], rgb(theme[under]));
  const check = (fg: string, bg: string, min: number, fgUnder = 'surface'): [string, number, number] =>
    [`${fg} on ${bg}`, ratio(colour(fg, fgUnder), colour(bg)), min];

  it('every text colour reaches 4.5:1 on every surface', () => {
    const pairs = TEXT.flatMap((fg) => SURFACES.map((bg) => check(fg, bg, 4.5)));
    pairs.push(check('accent-ink', 'accent', 4.5), check('accent-ink', 'accent-hover', 4.5), check('on-navy', 'navy', 4.5), check('on-navy-2', 'navy', 4.5, 'navy'));
    // Tinted backgrounds of badges, notices and callouts, composited over the surface.
    pairs.push(check('success', 'success-soft', 4.5), check('danger', 'danger-soft', 4.5), check('warning', 'warning-soft', 4.5), check('ink', 'accent-soft', 4.5));
    const failing = pairs.filter(([, r, min]) => r < min).map(([pair, r]) => `${pair}: ${r.toFixed(2)}`);
    expect(failing).toEqual([]);
  });

  it('control borders and the focus ring reach 3:1 against what they sit on', () => {
    const pairs = SURFACES.flatMap((bg) => [check('control-line', bg, 3), check('focus', bg, 3)]);
    // On the navy panel the focus ring is the accent.
    pairs.push(check('accent', 'navy', 3));
    const failing = pairs.filter(([, r, min]) => r < min).map(([pair, r]) => `${pair}: ${r.toFixed(2)}`);
    expect(failing).toEqual([]);
  });
});

it('form controls draw their boundary with the control border token', () => {
  expect(CSS).toMatch(/select, textarea \{[^}]*border: 1px solid var\(--control-line\)/);
  expect(CSS).toMatch(/\.switch \{[^}]*background: var\(--control-line\)/);
  expect(CSS).toMatch(/\.copyfield code \{[^}]*border: 1px solid var\(--control-line\)/);
});
