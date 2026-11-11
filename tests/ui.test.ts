import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { dashboardExtension } from '../src/http/dashboard.js';
import { esc, notFoundPage } from '../src/http/pages.js';
import { staticUrls } from '../src/http/static.js';
import { t, type MessageKey } from '../src/i18n/index.js';
import { makeHarness, type Harness } from './support/http.js';
import { consentHtml, cookies, formsOf, idNames, pageVisits, PASSWORD, showcase, visit, type PageVisit, type Showcase } from './support/pages.js';

const FIXTURE = path.resolve(import.meta.dirname, 'fixtures/forms.json');
const STATIC = path.resolve(import.meta.dirname, '../src/static');
const en = (key: MessageKey, params?: Record<string, string | number>): string => esc(t('en', key, params));
const dom = (html: string): Document => new JSDOM(html).window.document;

let s: Showcase | undefined;
let h: Harness | undefined;
afterEach(() => { s?.h.core.close(); s = undefined; h?.core.close(); h = undefined; });

async function pages(sc: Showcase, only?: (v: PageVisit) => boolean): Promise<Array<{ name: string; html: string }>> {
  const cookieOf = cookies(sc);
  const out: Array<{ name: string; html: string }> = [];
  for (const v of pageVisits(sc).filter(only ?? (() => true))) {
    const res = await visit(sc, v, cookieOf);
    expect(res.status, v.name).toBe(v.status ?? 200);
    out.push({ name: v.name, html: res.text });
  }
  out.push({ name: 'consent', html: await consentHtml(sc) });
  return out;
}

describe('static assets', () => {
  it('static assets are served with a content hash and immutable caching; a wrong hash is 404', async () => {
    h = makeHarness();
    const { css, js } = staticUrls();
    for (const [url, file, type] of [[css, 'app.css', 'text/css'], [js, 'app.js', 'text/javascript']] as const) {
      expect(url).toMatch(/^\/static\/app\.[0-9a-f]{12}\.(css|js)$/);
      const res = await request(h.app).get(url).set('Host', h.host);
      expect(res.status, url).toBe(200);
      expect(res.headers['content-type']).toContain(type);
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.text ?? res.body.toString()).toBe(fs.readFileSync(path.join(STATIC, file), 'utf8'));
      const wrong = url.replace(/\.[0-9a-f]{12}\./, '.000000000000.');
      expect((await request(h.app).get(wrong).set('Host', h.host)).status, wrong).toBe(404);
    }
    expect(fs.statSync(path.join(STATIC, 'app.js')).size).toBeLessThan(6 * 1024);
  });

  it('every page links the stylesheet and has no inline <style> block beyond the pre-paint theme snippet', async () => {
    s = await showcase();
    const { css, js } = staticUrls();
    for (const { name, html } of await pages(s)) {
      expect(html, name).toContain(`<link rel="stylesheet" href="${css}">`);
      expect(html, name).toContain(`<script src="${js}" defer></script>`);
      expect(html, name).not.toMatch(/<style[\s>]/);
      const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>/g)].map((m) => m[0]);
      expect(inline, name).toEqual(['<script id="theme-init">']);
    }
    // Pages on instance hosts take the stylesheet from the platform host by absolute URL and carry no script at all.
    const ghost = await request(s.h.app).get('/').set('Host', 'ghost.apps.localhost').set('Accept', 'text/html');
    expect(ghost.status).toBe(404);
    expect(ghost.text).toContain(`<link rel="stylesheet" href="http://localhost:8080${css}">`);
    expect(ghost.text).not.toContain('<script');
  });
});

describe('shell', () => {
  it('shell has a skip link, one <main>, one <h1>, and landmarks for banner and navigation', async () => {
    s = await showcase();
    const wanted = new Set(['home (administrator)', 'instance', 'app (owner)', 'admin users', 'admin settings', 'login', 'account']);
    for (const { name, html } of await pages(s, (v) => wanted.has(v.name))) {
      if (name === 'consent') continue;
      const doc = dom(html);
      const first = doc.querySelector('body a[href], body button, body input:not([type="hidden"]), body select, body summary');
      expect(first?.getAttribute('href'), name).toBe('#main');
      expect(first?.textContent, name).toBe(t('en', 'nav.skip'));
      expect(doc.querySelectorAll('main'), name).toHaveLength(1);
      expect(doc.querySelector('main')!.id, name).toBe('main');
      expect(doc.querySelectorAll('h1'), name).toHaveLength(1);
      expect(doc.querySelector('body > header'), name).not.toBeNull();
      expect(doc.querySelectorAll('nav').length, name).toBeGreaterThan(0);
      // Headings never skip a level.
      const levels = [...doc.querySelectorAll('h1, h2, h3, h4')].map((e) => Number(e.tagName[1]));
      levels.forEach((l, i) => { if (i > 0) expect(l - levels[i - 1], `${name} heading order`).toBeLessThanOrEqual(1); });
    }
  });

  it('the primary navigation marks the current item and offers Administration to administrators only', async () => {
    s = await showcase();
    const cookieOf = cookies(s);
    const nav = async (who: PageVisit['as'], path: string): Promise<Element | null> =>
      dom((await visit(s!, { name: path, path, as: who }, cookieOf)).text).querySelector('nav.primary');
    const home = await nav('admin', '/');
    expect([...home!.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['/', '/#catalog', '/admin']);
    expect(home!.querySelector('[aria-current="page"]')!.getAttribute('href')).toBe('/');
    expect((await nav('admin', '/admin/users'))!.querySelector('[aria-current="page"]')!.getAttribute('href')).toBe('/admin');
    const user = await nav('uwe', '/');
    expect([...user!.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['/', '/#catalog']);
  });

  it('account menu and language menu are <details> and work as plain links/forms without script', async () => {
    s = await showcase();
    const res = await visit(s, { name: 'home', path: '/instances/notes', as: 'admin' }, cookies(s));
    const doc = dom(res.text);
    const account = doc.querySelector('details.account-menu')!;
    expect(account.querySelector('summary')!.textContent).toContain(t('en', 'nav.account'));
    expect(account.textContent).toContain('admin@x.y');
    expect(account.querySelector('a[href="/account"]')).not.toBeNull();
    const logout = account.querySelector('form[action="/logout"][method="post"]')!;
    expect(logout.querySelector('input[name="csrf"]')!.getAttribute('value')).toBeTruthy();
    expect(logout.querySelector('button[type="submit"]')!.textContent).toContain(t('en', 'nav.signOut'));
    // The theme switch needs the script, so it stays hidden without it.
    expect(account.querySelector('[data-theme-toggle]')!.hasAttribute('hidden')).toBe(true);
    const lang = doc.querySelector('details.lang-menu')!;
    expect([...lang.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(
      ['en', 'de', 'fr', 'es'].map((l) => `/lang/${l}?return=${encodeURIComponent('/instances/notes')}`));
    expect(lang.querySelector('[aria-current="true"]')!.getAttribute('lang')).toBe('en');
    // The footer keeps the switcher for narrow screens, where the language menu is hidden.
    expect(doc.querySelectorAll('footer a[href^="/lang/"]')).toHaveLength(4);
  });

  it('theme snippet sets data-theme before paint and the stylesheet defines both themes', async () => {
    s = await showcase();
    const html = (await visit(s, { name: 'login', path: '/login', as: null }, cookies(s))).text;
    const head = html.slice(0, html.indexOf('</head>'));
    const snippet = /<script id="theme-init">([\s\S]*?)<\/script>/.exec(head)![1];
    expect(head.indexOf('theme-init')).toBeLessThan(head.indexOf('rel="stylesheet"'));
    expect(snippet.length).toBeLessThan(200);
    const run = (stored: string | null, throws = false): string | null => {
      const window = new JSDOM('<!doctype html><html><head></head></html>').window;
      const storage = throws ? new Proxy({}, { get() { throw new Error('blocked'); } }) : { getItem: () => stored };
      new window.Function('localStorage', 'document', snippet)(storage, window.document);
      return window.document.documentElement.getAttribute('data-theme');
    };
    expect(run('dark')).toBe('dark');
    expect(run('light')).toBe('light');
    expect(run(null)).toBeNull();
    expect(run('"><x')).toBeNull();
    expect(run(null, true)).toBeNull();
    const css = fs.readFileSync(path.join(STATIC, 'app.css'), 'utf8');
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{/);
    expect(css).toContain(':root[data-theme="dark"] {');
    expect(css).toContain('prefers-reduced-motion: reduce');
    // Both dark blocks set the same tokens.
    const blocks = [...css.matchAll(/(?::root:not\(\[data-theme="light"\]\)|:root\[data-theme="dark"\]) \{([^}]*)\}/g)].map((m) => m[1].replace(/\s+/g, ' ').trim());
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toBe(blocks[1]);
  });
});

describe('home', () => {
  it('home shows cards with the app icon, title, description and badges', async () => {
    s = await showcase();
    const app = s.h.core.apps.getApp('notes')!;
    const doc = dom((await visit(s, { name: 'home', path: '/', as: 'admin' }, cookies(s))).text);
    expect(doc.querySelector('h1')!.textContent).toBe(t('en', 'home.title'));
    expect(doc.querySelector('.lede')!.textContent).toBe(`${t('en', 'home.summary.apps.other', { count: 2 })} · ${t('en', 'home.summary.shared.one', { count: 1 })}`);
    const card = [...doc.querySelectorAll('#mine .app-card')].find((c) => c.querySelector('.slug')!.textContent === 'notes')!;
    expect(card.querySelector('img')!.getAttribute('src')).toBe(`/app-icons/${app.id}/${app.iconVersion}/192.png`);
    expect(card.querySelector('h3')!.textContent).toBe('Notes');
    expect(card.querySelector('.app-desc')!.textContent).toBe('Quick notes that sync between your devices.');
    const badges = [...card.querySelectorAll('.badge')].map((b) => b.textContent);
    expect(badges).toEqual([t('en', 'visibility.private'), 'v2']);
    // The disabled instance says so and cannot be opened.
    const old = [...doc.querySelectorAll('#mine .app-card')].find((c) => c.querySelector('.slug')!.textContent === 'old-notes')!;
    expect([...old.querySelectorAll('.badge')].map((b) => b.textContent)).toContain(t('en', 'common.disabled'));
    expect(old.querySelector('a[href^="http://old-notes."]')).toBeNull();
    // A card without a description has no empty placeholder.
    const tasks = doc.querySelector('#catalog .app-card')!;
    expect(tasks.querySelector('.app-desc')).toBeNull();
    const shared = doc.querySelector('#shared .app-card')!;
    expect([...shared.querySelectorAll('.badge')].map((b) => b.textContent)).toContain(t('en', 'badge.shared', { level: t('en', 'level.interact') }));
    // My apps: same card shape with latest version and instance count.
    const mine = doc.querySelector('#apps .app-card')!;
    expect(mine.querySelector('.badges')!.textContent).toContain('v2');
    expect(mine.querySelector('.badges')!.textContent).toContain(t('en', 'dash.instanceCount.other', { count: 2 }));
    expect(mine.querySelector('a[href="/apps/notes"]')).not.toBeNull();
  });

  it('cards offer Open for everyone with access and Manage only to managers', async () => {
    s = await showcase();
    const cookieOf = cookies(s);
    const cardOf = async (who: PageVisit['as'], section: string, slug: string): Promise<Element> => {
      const doc = dom((await visit(s!, { name: 'home', path: '/', as: who }, cookieOf)).text);
      return [...doc.querySelectorAll(`#${section} .app-card`)].find((c) => c.querySelector('.slug')!.textContent === slug)!;
    };
    const links = (c: Element): string[] => [...c.querySelectorAll('.card-actions a')].map((a) => a.getAttribute('href')!);
    // Uwe views notes (shared at "view"): Open only. The administrator owns it: Open and Manage.
    expect(links(await cardOf('uwe', 'shared', 'notes'))).toEqual(['http://notes.apps.localhost:8080']);
    expect(links(await cardOf('admin', 'mine', 'notes'))).toEqual(['http://notes.apps.localhost:8080', '/instances/notes']);
    // Pia shared tasks with the administrator as a contributor: no Manage.
    expect(links(await cardOf('admin', 'shared', 'tasks'))).toEqual(['http://tasks.apps.localhost:8080']);
    s.h.core.access.setGrant(s.h.core.apps.getInstanceBySlug('tasks')!, 'user', s.h.adminId, 'admin', s.h.core.users.get(s.ids.pia)!);
    expect(links(await cardOf('admin', 'shared', 'tasks'))).toEqual(['http://tasks.apps.localhost:8080', '/instances/tasks']);
    // Each card is two explicit actions, never one big link.
    const card = await cardOf('admin', 'mine', 'notes');
    expect(card.closest('a')).toBeNull();
    // Self-service apps in the catalog reveal the create form in place.
    const doc = dom((await visit(s, { name: 'home', path: '/', as: 'uwe' }, cookieOf)).text);
    const own = [...doc.querySelectorAll('#catalog details.getown')];
    expect(own).toHaveLength(1);
    expect(own[0].querySelector('summary')!.textContent).toContain(t('en', 'dash.getOwn'));
    expect(own[0].querySelector('form[action="/ui/apps/tasks/instances"] input[name="slug"]')).not.toBeNull();
  });

  it('empty home shows the tagline and the three steps', async () => {
    h = makeHarness({ extensions: [dashboardExtension] });
    const res = await request(h.app).get('/').set('Host', h.host).set('Cookie', await h.login());
    const doc = dom(res.text);
    const hero = doc.querySelector('.empty-hero')!;
    expect(hero.querySelector('h1')!.textContent).toBe(t('en', 'brand.tagline'));
    expect(hero.textContent).toContain(t('en', 'brand.pitch'));
    const steps = [...hero.querySelectorAll('ol.steps > li')];
    expect(steps.map((li) => li.querySelector('strong')!.textContent)).toEqual([t('en', 'dash.connect'), t('en', 'home.step.ask'), t('en', 'home.step.appears')]);
    expect(steps[0].querySelector('code')!.textContent).toBe('http://lager.localhost:8080/mcp');
    expect(steps[0].querySelector('button[data-copy="http://lager.localhost:8080/mcp"]')).not.toBeNull();
    // Publishers still find their API tokens below.
    expect(doc.querySelector('#tokens form[action="/ui/tokens"]')).not.toBeNull();
    // Plain users get the tagline without the steps they cannot take.
    h.core.users.create({ email: 'plain@x.y', name: 'Plain', password: PASSWORD, role: 'user' });
    const plain = dom((await request(h.app).get('/').set('Host', h.host).set('Cookie', await h.login('plain@x.y', PASSWORD))).text);
    expect(plain.querySelector('.empty-hero h1')!.textContent).toBe(t('en', 'brand.tagline'));
    expect(plain.querySelector('.empty-hero ol.steps')).toBeNull();
    expect(plain.querySelector('.empty-hero')!.textContent).toContain(t('en', 'home.empty.user'));
  });

  it('the connector panel and a new token offer copy buttons with the catalog labels', async () => {
    s = await showcase();
    const csrf = /name="csrf" value="([^"]+)"/.exec((await visit(s, { name: 'home', path: '/', as: 'admin' }, cookies(s))).text)![1];
    const res = await request(s.h.app).post('/ui/tokens').set('Host', s.h.host).set('Cookie', await s.h.login()).type('form').send({ name: 'phone', csrf });
    const doc = dom(res.text);
    const token = /lgr_[A-Za-z0-9_-]+/.exec(res.text)![0];
    const callout = doc.querySelector('.callout')!;
    expect(callout.textContent).toContain(t('en', 'dash.tokens.created', { name: 'phone' }));
    expect(callout.textContent).toContain(t('en', 'dash.tokens.copyNow'));
    const copy = callout.querySelector('button[data-copy]')!;
    expect(copy.getAttribute('data-copy')).toBe(token);
    expect(copy.getAttribute('data-copied')).toBe(t('en', 'common.copied'));
    expect(copy.hasAttribute('hidden')).toBe(true);
    expect(doc.querySelector('#connect.panel-navy button[data-copy="http://localhost:8080/mcp"]')).not.toBeNull();
  });
});

describe('management and administration', () => {
  it('tables carry data-label attributes for the stacked layout', async () => {
    s = await showcase();
    const wanted = (v: PageVisit): boolean => v.as !== null;
    let cells = 0;
    for (const { name, html } of await pages(s, wanted)) {
      if (name === 'consent') continue;
      const doc = dom(html);
      for (const table of doc.querySelectorAll('table')) {
        const heads = [...table.querySelectorAll('thead th')].map((th) => (th.querySelector('.sr-only') ? '' : th.textContent));
        for (const row of table.querySelectorAll('tbody tr')) {
          [...row.querySelectorAll('td')].forEach((td, i) => {
            expect(td.getAttribute('data-label'), `${name} column ${i}`).toBe(heads[i]);
            cells++;
          });
        }
      }
    }
    expect(cells).toBeGreaterThan(50);
  });

  it('the instance page has the header band, a version timeline, the details card and a danger zone', async () => {
    s = await showcase();
    const doc = dom((await visit(s, { name: 'instance', path: '/instances/notes', as: 'admin' }, cookies(s))).text);
    const hero = doc.querySelector('.hero')!;
    expect(hero.querySelector('h1')!.textContent).toBe('Notes');
    expect(hero.querySelector('a.url')!.getAttribute('href')).toBe('http://notes.apps.localhost:8080');
    expect(hero.querySelector('.hero-actions a[href="http://notes.apps.localhost:8080"]')).not.toBeNull();
    const versions = [...doc.querySelectorAll('.timeline > li')];
    expect(versions.map((li) => li.getAttribute('data-version'))).toEqual(['2', '1']);
    expect(versions[0].classList.contains('is-active')).toBe(true);
    expect(versions[0].querySelector('form')).toBeNull();
    expect(versions[1].querySelector('form[action="/ui/instances/notes/activate"]')).not.toBeNull();
    const side = doc.querySelector('aside.side-col')!;
    expect(side.querySelector('input[type="checkbox"].switch[name="on"]')).not.toBeNull();
    expect(side.querySelector('select[name="visibility"]')).not.toBeNull();
    expect(side.textContent).toContain(t('en', 'instance.storage'));
    const danger = doc.querySelector('.main-col > .card-danger:last-child')!;
    expect(danger.querySelector('input[name="confirm"]')!.getAttribute('data-confirm')).toBe('notes');
    // A manager who does not own the instance cannot delete it, so there is no danger zone.
    s.h.core.access.setGrant(s.h.core.apps.getInstanceBySlug('notes')!, 'user', s.ids.uwe, 'admin', s.h.core.users.get(s.h.adminId)!);
    const managed = dom((await visit(s, { name: 'instance', path: '/instances/notes', as: 'uwe' }, cookies(s))).text);
    expect(managed.querySelector('.card-danger')).toBeNull();
  });

  it('administration sections are pills, the users show avatars and status badges, one-time links use the callout', async () => {
    s = await showcase();
    const cookie = await s.h.login();
    const doc = dom((await request(s.h.app).get('/admin/users').set('Host', s.h.host).set('Cookie', cookie)).text);
    const pills = doc.querySelector('nav.pills')!;
    expect(pills.querySelector('[aria-current="page"]')!.getAttribute('href')).toBe('/admin/users');
    const nova = [...doc.querySelectorAll('tbody tr')].find((tr) => tr.textContent!.includes('nova@x.y'))!;
    expect(nova.querySelector('.avatar')!.textContent).toBe('N');
    expect(nova.querySelector('.badge-warning')!.textContent).toBe(t('en', 'common.unverified'));
    const csrf = doc.querySelector('input[name="csrf"]')!.getAttribute('value')!;
    const reset = await request(s.h.app).post(`/admin/users/${s.ids.uwe}/reset-link`).set('Host', s.h.host).set('Cookie', cookie).type('form').send({ csrf });
    const callout = dom(reset.text).querySelector('.callout')!;
    expect(callout.textContent).toContain(t('en', 'admin.users.resetLinkTitle'));
    expect(callout.querySelector('code')!.textContent).toMatch(/\/reset\?token=/);
    expect(callout.textContent).toContain(t('en', 'admin.oneTime'));
    // The apps overview groups instances under their app with its icon.
    const apps = dom((await request(s.h.app).get('/admin/apps').set('Host', s.h.host).set('Cookie', cookie)).text);
    const notes = [...apps.querySelectorAll('.app-group')].find((g) => g.querySelector('h3')!.textContent === 'Notes')!;
    expect(notes.querySelector('.tile img')!.getAttribute('src')).toMatch(/^\/app-icons\//);
    expect([...notes.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td')!.textContent)).toEqual(['notes', 'old-notes']);
  });
});

describe('signed-out pages', () => {
  it('consent page: client name and redirect host emphasised, Deny precedes Allow in the DOM', async () => {
    s = await showcase();
    const doc = dom(await consentHtml(s, 'Claude Desktop'));
    const strong = [...doc.querySelectorAll('main strong')].map((e) => e.textContent);
    expect(strong).toContain('Claude Desktop');
    expect(strong).toContain('claude.ai');
    const buttons = [...doc.querySelectorAll('form[action="/authorize"] button[name="decision"]')].map((b) => b.getAttribute('value'));
    expect(buttons).toEqual(['deny', 'approve']);
    expect(doc.querySelector('button[value="deny"]')!.textContent).toBe(t('en', 'consent.deny'));
  });

  it('the sign-in page shows the large icon and the tagline above the card and the pitch below', async () => {
    s = await showcase();
    const html = (await visit(s, { name: 'login', path: '/login', as: null }, cookies(s))).text;
    const doc = dom(html);
    expect(doc.querySelector('header img')!.getAttribute('width')).toBe('64');
    expect(doc.querySelector('main h1')!.textContent).toBe(t('en', 'brand.tagline'));
    expect(html.indexOf(en('brand.tagline'))).toBeLessThan(html.indexOf('action="/login"'));
    expect(html.indexOf('action="/login"')).toBeLessThan(html.indexOf(en('brand.pitch')));
    // Errors and confirmations are banners with their own roles.
    const failed = await request(s.h.app).post('/login').set('Host', s.h.host).type('form').send({ email: 'admin@x.y', password: 'wrong' });
    expect(dom(failed.text).querySelector('.notice-danger[role="alert"]')!.textContent).toBe(t('en', 'login.invalid'));
    const verified = dom((await request(s.h.app).get('/login?verified=1').set('Host', s.h.host)).text);
    expect(verified.querySelector('.notice-success[role="status"]')!.textContent).toBe(t('en', 'login.verified'));
  });
});

describe('behaviour of the forms', () => {
  // The fixture was generated from the pages before the redesign; the markup may change, what the forms send may not.
  it('forms post the same fields to the same routes as before', async () => {
    s = await showcase();
    const expected = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;
    const names = idNames(s);
    const cookieOf = cookies(s);
    const actual: Record<string, unknown> = {};
    for (const v of pageVisits(s)) {
      const res = await visit(s, v, cookieOf);
      expect(res.status, v.name).toBe(v.status ?? 200);
      actual[v.name] = formsOf(res.text, names);
    }
    actual.consent = formsOf(await consentHtml(s), names);
    expect(actual).toEqual(expected);
  });
});

describe('no external resources', () => {
  it('no external URLs in any page or static asset', async () => {
    s = await showcase();
    const { core } = s.h;
    const own = new Set([core.config.publicUrl.origin]);
    for (const i of core.apps.listAllApps().flatMap((a) => core.apps.listInstances(a.id))) {
      own.add(new URL(`http://${i.slug}.apps.localhost:8080`).origin);
      for (const host of core.domains.list(i.id)) own.add(new URL(`http://${host}:8080`).origin);
    }
    const foreign = (text: string): string[] => [...text.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]).filter((u) => !own.has(new URL(u).origin));
    // Form values are data the page sends back (the consent form carries the client's redirect address), not something it loads.
    for (const { name, html } of await pages(s)) expect(foreign(html.replace(/ value="[^"]*"/g, '')), name).toEqual([]);
    for (const file of fs.readdirSync(STATIC)) expect(foreign(fs.readFileSync(path.join(STATIC, file), 'utf8')), file).toEqual([]);
    // Also no protocol-relative or data: references to load from elsewhere.
    for (const file of fs.readdirSync(STATIC)) expect(fs.readFileSync(path.join(STATIC, file), 'utf8'), file).not.toMatch(/url\(\s*['"]?(?:\/\/|https?:)/);
    expect(notFoundPage('en', { origin: 'http://localhost:8080', switcher: false })).not.toMatch(/https?:\/\/(?!localhost:8080)/);
  });
});
