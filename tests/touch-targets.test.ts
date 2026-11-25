import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CSS = fs.readFileSync(path.resolve(import.meta.dirname, '../src/static/app.css'), 'utf8');

/** Everything inside the `@media (pointer: coarse)` blocks of the stylesheet. */
function coarse(): string {
  const out: string[] = [];
  for (let at = CSS.indexOf('@media (pointer: coarse)'); at >= 0; at = CSS.indexOf('@media (pointer: coarse)', at + 1)) {
    let depth = 0; let i = CSS.indexOf('{', at);
    const start = i;
    for (; i < CSS.length; i++) { if (CSS[i] === '{') depth++; else if (CSS[i] === '}' && --depth === 0) break; }
    out.push(CSS.slice(start + 1, i));
  }
  return out.join('\n');
}

describe('touch targets', () => {
  it('on touch screens the controls the audit measured below 44 px get 44 px', () => {
    const rules = coarse();
    for (const selector of ['.pills a', '.brand', 'td > a:only-child', '.cell-user a:only-child', '.hero a.url', '.notice > a', '.btn-sm']) {
      const rule = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&')}[^{]*\\{[^}]*min-height: 44px`);
      expect(rules, selector).toMatch(rule);
    }
  });

  it('a link that fills a table cell stays within its column, and only a linked address grows', () => {
    const rules = coarse();
    // Without a width limit an inline-flex link takes its text's full width: a long group name would lose its "…" and leave the cell.
    expect(rules).toMatch(/\.cell-user a:only-child \{[^}]*display: inline-flex;[^}]*max-width: 100%;/);
    // The address is text, not a target, on a disabled instance and on the app page.
    expect(rules).not.toMatch(/\.hero \.url\b/);
  });

  it('the section pills keep 44 px although their base rule comes later in the file', () => {
    expect(CSS.indexOf('@media (pointer: coarse) { .pills a { min-height: 44px; } }')).toBeGreaterThan(CSS.indexOf('.pills a {'));
  });
});
