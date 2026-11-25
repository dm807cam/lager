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
    for (const selector of ['.pills a', '.brand', 'td > a:only-child', '.cell-user a:only-child', '.hero .url', '.notice > a', '.btn-sm']) {
      const rule = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&')}[^{]*\\{[^}]*min-height: 44px`);
      expect(rules, selector).toMatch(rule);
    }
  });

  it('the section pills keep 44 px although their base rule comes later in the file', () => {
    expect(CSS.indexOf('@media (pointer: coarse) { .pills a { min-height: 44px; } }')).toBeGreaterThan(CSS.indexOf('.pills a {'));
  });
});
