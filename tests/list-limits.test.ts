import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { t } from '../src/i18n/index.js';
import { showcase, type Showcase } from './support/pages.js';

let s: Showcase | undefined;
afterEach(() => { s?.h.core.close(); s = undefined; });

const page = async (sc: Showcase, path: string): Promise<Document> =>
  new JSDOM((await request(sc.h.app).get(path).set('Host', sc.h.host).set('Cookie', await sc.h.login())).text).window.document;

describe('long lists', () => {
  it('get a filter field from eight entries on, on home, Users and Apps; shorter lists none', async () => {
    s = await showcase();
    const { core } = s.h;
    expect((await page(s, '/')).querySelector('input[data-filter]')).toBeNull();
    const notes = core.apps.getApp('notes')!;
    for (let i = 1; i <= 6; i++) core.apps.createInstance({ appId: notes.id, slug: `notes-${i}`, ownerId: s.h.adminId });
    for (let i = 1; i <= 6; i++) core.users.create({ email: `u${i}@x.y`, name: `User ${i}`, password: 'password-123', role: 'user' });
    for (let i = 1; i <= 6; i++) core.apps.deploy({ slug: `app-${i}`, html: '<p>a</p>', title: `App ${i}`, userId: s.h.adminId });
    const cases: Array<[string, string]> = [['/', '#mine .app-card, #shared .app-card'], ['/admin/users', 'main .table-users tbody tr'], ['/admin/apps', 'main .app-group']];
    for (const [path, targets] of cases) {
      const doc = await page(s, path);
      const input = doc.querySelector('input[data-filter]')!;
      expect(input.getAttribute('data-filter'), path).toBe(targets);
      expect(input.closest('.filter')!.hasAttribute('hidden'), path).toBe(true);
      expect(doc.querySelectorAll(targets).length, path).toBeGreaterThanOrEqual(8);
      expect(doc.querySelector(`label[for="${input.id}"]`), path).not.toBeNull();
    }
  });

  it('the catalog gets one too, from eight entries on', async () => {
    s = await showcase();
    const { core } = s.h;
    const catalog = async (): Promise<Document> =>
      new JSDOM((await request(s!.h.app).get('/catalog').set('Host', s!.h.host).set('Cookie', await s!.h.login('uwe@x.y', 'password-123'))).text).window.document;
    expect((await catalog()).querySelector('input[data-filter]')).toBeNull();
    for (let i = 1; i <= 8; i++) {
      core.apps.deploy({ slug: `tool-${i}`, html: '<p>t</p>', title: `Tool ${i}`, userId: s.h.adminId });
      core.apps.setSelfInstances(core.apps.getApp(`tool-${i}`)!.id, 'users', s.h.adminId);
    }
    const doc = await catalog();
    const input = doc.querySelector('input[data-filter]')!;
    expect(input.getAttribute('data-filter')).toBe('#catalog .app-card');
    expect(doc.querySelectorAll('#catalog .app-card').length).toBeGreaterThanOrEqual(8);
  });

  it('the script shows the field and hides what does not match while typing, and says when nothing does', () => {
    const win = new JSDOM(`<!doctype html><body><div class="filter" hidden><input type="search" id="f" data-filter="li"><p class="filter-none" hidden>None</p></div>
      <ul><li>Notes</li><li>Groceries</li><li>Pin board</li></ul></body>`, { runScripts: 'outside-only' }).window;
    win.eval(fs.readFileSync(new URL('../src/static/app.js', import.meta.url), 'utf8'));
    const doc = win.document;
    const input = doc.getElementById('f') as HTMLInputElement;
    expect(input.parentElement!.hidden).toBe(false);
    const type = (v: string): string[] => {
      input.value = v;
      input.dispatchEvent(new win.Event('input'));
      return [...doc.querySelectorAll('li')].filter((li) => !li.hidden).map((li) => li.textContent!);
    };
    expect(type('BOARD')).toEqual(['Pin board']);
    expect(doc.querySelector<HTMLElement>('.filter-none')!.hidden).toBe(true);
    expect(type('xyz')).toEqual([]);
    expect(doc.querySelector<HTMLElement>('.filter-none')!.hidden).toBe(false);
    expect(type('')).toEqual(['Notes', 'Groceries', 'Pin board']);
  });

  it('a version list shows the five newest and the active one; the rest behind "Show all"', async () => {
    s = await showcase();
    const { core } = s.h;
    for (let i = 3; i <= 12; i++) core.apps.deploy({ slug: 'notes', html: `<p>${i}</p>`, userId: s.h.adminId });
    core.apps.activate(core.apps.getInstanceBySlug('notes')!.id, 2, s.h.adminId);
    const doc = await page(s, '/instances/notes');
    const first = [...doc.querySelectorAll('#versions > ol.timeline > li')].map((li) => li.getAttribute('data-version'));
    expect(first).toEqual(['12', '11', '10', '9', '8', '2']);
    const more = doc.querySelector('#versions details.more-versions')!;
    expect(more.querySelector('summary')!.textContent).toBe(t('en', 'instance.versions.all', { count: 12 }));
    expect([...more.querySelectorAll('li')].map((li) => li.getAttribute('data-version'))).toEqual(['7', '6', '5', '4', '3', '1']);
  });

  it('Users lists active administrators first, then by name, and says how many accounts there are', async () => {
    s = await showcase();
    const { core } = s.h;
    core.users.create({ email: 'zed@x.y', name: 'Zed', password: 'password-123', role: 'admin' });
    const doc = await page(s, '/admin/users');
    const emails = [...doc.querySelectorAll('main .table-users tbody tr')].map((tr) => tr.querySelector('td')!.textContent);
    const admins = core.users.list().filter((u) => u.role === 'admin');
    expect(emails.slice(0, admins.length).every((text) => admins.some((a) => text!.includes(a.email)))).toBe(true);
    // Everyone else follows by name.
    const others = core.users.list().filter((u) => u.role !== 'admin').sort((a, b) => a.name.localeCompare(b.name, 'en'));
    expect(emails.slice(admins.length).map((text) => others.find((u) => text!.includes(u.email))?.email)).toEqual(others.map((u) => u.email));
    const n = core.users.list().length;
    expect(doc.querySelector('main .hint')!.textContent).toBe(t('en', 'admin.users.count.other', { count: n }));
  });

  it('Administration › Apps gives every app’s table the same columns', async () => {
    s = await showcase();
    const doc = await page(s, '/admin/apps');
    const tables = [...doc.querySelectorAll('main .app-group table')];
    expect(tables.length).toBeGreaterThan(1);
    for (const table of tables) expect(table.classList.contains('table-instances')).toBe(true);
    const css = fs.readFileSync(new URL('../src/static/app.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.table-instances \{ table-layout: fixed; width: 100%; \}/);
  });
});
