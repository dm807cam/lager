import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Colour contrast of the website (lager.im) in both themes, read from its own styles: the stylesheet of the generated pages and
 * the one inside index.html, which declare the same colours.
 */
const SOURCES = {
  'site.css': fs.readFileSync(path.resolve(import.meta.dirname, '../website/assets/site.css'), 'utf8'),
  'index.html': fs.readFileSync(path.resolve(import.meta.dirname, '../website/index.html'), 'utf8'),
};

type RGB = [number, number, number];

/** The custom properties of the first `:root {` block from `from` on. */
function tokens(css: string, from = 0): Record<string, string> {
  const start = css.indexOf(':root {', from);
  expect(start).toBeGreaterThanOrEqual(0);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

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

describe.each(Object.entries(SOURCES))('%s', (_file, css) => {
  const light = tokens(css);
  const dark = { ...light, ...tokens(css, css.indexOf('prefers-color-scheme: dark')) };

  it.each([['light', light], ['dark', dark]] as const)('%s: text reaches 4.5:1 and the focus ring 3:1 on every background', (_name, theme) => {
    const canvas = rgb(theme.canvas);
    const colour = (token: string): RGB => rgb(theme[token], canvas);
    const backgrounds = ['canvas', 'surface', 'surface-2', 'accent-soft', ...(theme['inline-code'] ? ['inline-code'] : [])];
    const failing: string[] = [];
    for (const bg of backgrounds) {
      for (const fg of ['ink', 'ink-2', 'ink-3', 'accent-text']) {
        const r = ratio(colour(fg), colour(bg));
        if (r < 4.5) failing.push(`${fg} on ${bg}: ${r.toFixed(2)}`);
      }
    }
    const button = ratio(colour('accent-ink'), colour('accent'));
    if (button < 4.5) failing.push(`accent-ink on accent: ${button.toFixed(2)}`);
    expect(failing).toEqual([]);
  });

  it('orange is a fill only on light surfaces: text and the focus ring there use the darker text tone', () => {
    // The exceptions are on dark surfaces, where the bright orange is the one that reaches the contrast (tested below): the "$"
    // prompt in the code box and the ✓ of the install section.
    const rest = css.replace(/\.cmd code \.p \{[^}]*\}/, '').replace(/\.install li::before \{[^}]*\}/, '');
    expect(rest).not.toMatch(/(?<![-\w])color:\s*var\(--accent\)/);
    expect(css).toMatch(/:focus-visible \{ outline: 2px solid var\(--accent-text\)/);
  });

  it.each([['light', light], ['dark', dark]] as const)('%s: on the dark surfaces the bright orange marks focus (3:1) and the ✓ (4.5:1)', (_name, theme) => {
    const navy = rgb(theme.navy);
    // The code box, the navy sections, and the translucent black boxes on navy (install command, the blog's call to action).
    const surfaces: Array<[string, RGB]> = [['code-bg', rgb(theme['code-bg'])], ['navy', navy], ['black .28 on navy', rgb('rgb(0 0 0 / .28)', navy)], ['black .3 on navy', rgb('rgb(0 0 0 / .3)', navy)]];
    const accent = rgb(theme.accent);
    const failing = surfaces.filter(([, bg]) => ratio(accent, bg) < 4.5).map(([name, bg]) => `accent on ${name}: ${ratio(accent, bg).toFixed(2)}`);
    expect(failing).toEqual([]);
    // The darker text tone would not do there in light mode, which is why those surfaces switch back.
    if (_name === 'light') expect(ratio(rgb(theme['accent-text']), navy)).toBeLessThan(3);
  });

  it('switches the focus ring back to the bright orange on every dark surface that can hold a focusable element', () => {
    // Every rule that paints a navy or code background (shorthand or background-color). Those that never hold anything focusable are
    // named here; a code block in a post draws its ring outside itself, on the page background. The stylesheets keep each rule's
    // selector on the line of its "{", which is what this reads.
    const NOTHING_FOCUSABLE = new Set(['ol.steps li::before', '.msg.me', '.prose pre']);
    const dark = [...css.matchAll(/^\s*([^{}\n]+?)\s*\{[^}]*background(?:-color)?:[^;}]*var\(--(?:navy(?:-2)?|code-bg)\)/gm)].map((m) => m[1].trim());
    expect(dark.length).toBeGreaterThan(0);
    // The pattern also sees the other ways of writing a dark background.
    const sample = '.a { background-color: var(--navy); }\n.b { color: #fff; background: var(--navy-2); }';
    expect([...sample.matchAll(/^\s*([^{}\n]+?)\s*\{[^}]*background(?:-color)?:[^;}]*var\(--(?:navy(?:-2)?|code-bg)\)/gm)].map((m) => m[1])).toEqual(['.a', '.b']);
    const switched = [...css.matchAll(/^\s*([^{}\n]+?)\s*\{ outline-color: var\(--accent\); \}/gm)]
      .flatMap((m) => m[1].split(',').map((sel) => sel.trim().replace(/ :focus-visible$/, '')));
    expect(dark.filter((sel) => !NOTHING_FOCUSABLE.has(sel) && !switched.includes(sel))).toEqual([]);
    if (css.includes('.install {')) expect(css).toMatch(/\.install li::before \{[^}]*color: var\(--accent\);/);
  });
});
