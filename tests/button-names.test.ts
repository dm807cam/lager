import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { cookies, pageVisits, showcase, visit, type Showcase } from './support/pages.js';

let s: Showcase | undefined;
afterEach(() => { s?.h.core.close(); s = undefined; });

/** The accessible name of a control, as a screen reader's list of buttons and links shows it: aria-label, else the visible text. */
function nameOf(el: Element): string {
  const label = el.getAttribute('aria-label');
  if (label) return label.trim();
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Where a control leads or what it sends: two controls with the same target do the same thing. */
function targetOf(el: Element): string {
  if (el.tagName === 'A') return `link ${el.getAttribute('href')}`;
  const form = el.closest('form');
  if (!form) return `button ${el.outerHTML}`;
  const hidden = [...form.querySelectorAll('input[type="hidden"]:not([name="csrf"])')].map((i) => `${i.getAttribute('name')}=${i.getAttribute('value')}`);
  return `form ${form.getAttribute('action')} ${el.getAttribute('name') ?? ''}=${el.getAttribute('value') ?? ''} ${hidden.join('&')}`;
}

describe('every control on a page has a name of its own', () => {
  it('no two buttons or links that do different things share an accessible name', async () => {
    s = await showcase();
    // A second token and a second invitation, so their rows repeat too.
    s.h.core.tokens.create(s.h.adminId, 'desktop');
    await s.h.core.accounts.createInvite({ role: 'publisher', createdBy: s.h.adminId, locale: 'en' });
    const cookieOf = cookies(s);
    const clashes: string[] = [];
    const notInName: string[] = [];
    for (const v of pageVisits(s)) {
      if (v.method === 'post' || (v.status ?? 200) !== 200) continue;
      const doc = new JSDOM((await visit(s, v, cookieOf)).text).window.document;
      const main = doc.querySelector('main');
      if (!main) continue;
      const byName = new Map<string, Set<string>>();
      for (const el of main.querySelectorAll('a[href], button, summary')) {
        if (el.getAttribute('aria-hidden') === 'true' || el.getAttribute('tabindex') === '-1') continue;
        const name = nameOf(el);
        // Label in Name (WCAG 2.5.3): a name of its own still holds the words on screen, so a voice command by what is seen works.
        const shown = (() => { const copy = el.cloneNode(true) as Element; copy.querySelectorAll('[aria-hidden="true"], .sr-only').forEach((n) => n.remove()); return (copy.textContent ?? '').replace(/\s+/g, ' ').trim(); })();
        if (el.hasAttribute('aria-label') && shown && !name.toLowerCase().includes(shown.toLowerCase())) notInName.push(`${v.name}: "${shown}" not in "${name}"`);
        if (!byName.has(name)) byName.set(name, new Set());
        byName.get(name)!.add(targetOf(el));
      }
      for (const [name, targets] of byName) if (targets.size > 1) clashes.push(`${v.name}: "${name}" ×${targets.size}`);
    }
    expect(clashes).toEqual([]);
    expect(notInName).toEqual([]);
  });
});
