import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { csrfToken } from '../src/http/session.js';
import { t } from '../src/i18n/index.js';
import { showcase, type Showcase } from './support/pages.js';

let s: Showcase | undefined;
afterEach(() => { s?.h.core.close(); s = undefined; });

const CSS = fs.readFileSync(new URL('../src/static/app.css', import.meta.url), 'utf8');
const dom = (html: string): Document => new JSDOM(html).window.document;

describe('small polish (#100)', () => {
  it('page titles name the product, except the home page, which is the product', async () => {
    s = await showcase();
    const cookie = await s.h.login();
    const title = async (path: string, c = cookie): Promise<string> => dom((await request(s!.h.app).get(path).set('Host', s!.h.host).set('Cookie', c)).text).title;
    expect(await title('/')).toBe('Lager');
    expect(await title('/account')).toBe(`${t('en', 'account.title')} · Lager`);
    expect(await title('/login', '')).toBe(`${t('en', 'login.title')} · Lager`);
  });

  it('signed out, the footer offers the theme next to the languages', async () => {
    s = await showcase();
    const doc = dom((await request(s.h.app).get('/login').set('Host', s.h.host)).text);
    const button = doc.querySelector('footer button[data-theme-toggle]')!;
    expect(button.hasAttribute('hidden')).toBe(true);
    expect(button.textContent).toContain(t('en', 'theme.label'));
  });

  it('"Browser default" forgets the language the top bar left in this browser', async () => {
    s = await showcase();
    const cookie = await s.h.login();
    const res = await request(s.h.app).post('/account/locale').set('Host', s.h.host).set('Cookie', `${cookie}; lager_lang=de`).type('form')
      .send({ csrf: csrfToken(s.h.core, s.h.core.users.get(s.h.adminId)!), locale: '' });
    const set = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
    expect(set.some((c) => /^lager_lang=;/.test(c) && /Expires=Thu, 01 Jan 1970/.test(c))).toBe(true);
    expect(s.h.core.users.get(s.h.adminId)!.locale).toBeNull();
  });

  it('the sharing list shows a person with name and address', async () => {
    s = await showcase();
    const doc = dom((await request(s.h.app).get('/instances/notes').set('Host', s.h.host).set('Cookie', await s.h.login())).text);
    const cell = [...doc.querySelectorAll('#sharing .cell-user')].find((c) => c.textContent!.includes('uwe@x.y'))!;
    expect(cell.querySelector('strong')!.textContent).toBe('Uwe');
    expect(cell.querySelector(':scope > div > span')!.textContent).toBe('uwe@x.y');
  });

  it('a person without a name shows the address once, and a group its name', async () => {
    s = await showcase();
    (s.h.core.users as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db.prepare("UPDATE users SET name = '' WHERE id = ?").run(s.ids.uwe);
    const doc = dom((await request(s.h.app).get('/instances/notes').set('Host', s.h.host).set('Cookie', await s.h.login())).text);
    const cells = [...doc.querySelectorAll('#sharing .cell-user')];
    const uwe = cells.find((c) => c.textContent!.includes('uwe@x.y'))!;
    expect([uwe.querySelector('strong')!.textContent, uwe.textContent!.split('uwe@x.y').length - 1]).toEqual(['uwe@x.y', 1]);
    const group = cells.find((c) => c.textContent!.includes('Team'))!;
    expect(group.querySelector('strong')!.textContent).toBe('Team');
    expect(group.querySelector('.tile, .avatar')).not.toBeNull();
  });

  it('copying is announced through a status line that is in the page before the first copy, and a refusal shows on the button too', async () => {
    const win = new JSDOM('<!doctype html><body><button data-copy="abc" data-copied="Copied" data-copy-failed="Copying did not work." hidden><span data-label>Copy</span></button></body>', { runScripts: 'outside-only', pretendToBeVisual: true }).window;
    let ok = true;
    Object.defineProperty(win.navigator, 'clipboard', { value: { writeText: () => (ok ? Promise.resolve() : Promise.reject(new Error('no'))) } });
    win.eval(fs.readFileSync(new URL('../src/static/app.js', import.meta.url), 'utf8'));
    const doc = win.document;
    // A live region added at the moment of the change is often not read out: it is there, empty, from the start.
    const region = doc.querySelector('[role="status"]');
    expect([region !== null, region?.textContent]).toEqual([true, '']);
    const label = (): string => doc.querySelector('[data-label]')!.textContent!;
    const settle = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 80)); };
    doc.querySelector('button')!.click();
    await settle();
    expect([region!.textContent, label()]).toEqual(['Copied', 'Copied']);
    ok = false;
    doc.querySelector('button')!.click();
    await settle();
    expect([region!.textContent, label()]).toEqual(['Copying did not work.', 'Copying did not work.']);
    expect(doc.querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  it('a page without copy buttons gets no status line', () => {
    const win = new JSDOM('<!doctype html><body><p>Nothing to copy</p></body>', { runScripts: 'outside-only' }).window;
    Object.defineProperty(win.navigator, 'clipboard', { value: { writeText: () => Promise.resolve() } });
    win.eval(fs.readFileSync(new URL('../src/static/app.js', import.meta.url), 'utf8'));
    expect(win.document.querySelector('[role="status"]')).toBeNull();
  });

  it('dark mode marks the current tab with the accent line, long titles hyphenate, and the spacing is in place', () => {
    expect(CSS).toMatch(/\.primary a\[aria-current="page"\] \{[^}]*inset 0 -2px 0 var\(--focus\)/);
    expect(CSS).toMatch(/\.app-title \{[^}]*hyphens: auto/);
    // A shadow token inside a list of shadows must be a shadow: "none" there drops the whole declaration, outline and line included.
    expect(CSS).not.toMatch(/--shadow-sm: none/);
  });
});
