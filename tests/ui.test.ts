import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { dashboardExtension } from '../src/http/dashboard.js';
import { esc, notFoundPage } from '../src/http/pages.js';
import { staticUrls } from '../src/http/static.js';
import { LOCALES, t, type MessageKey } from '../src/i18n/index.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../src/platform/ai.js';
import { makeHarness, type Harness } from './support/http.js';
import { consentHtml, cookies, emptyHomes, formDetailsOf, formsOf, idNames, pageVisits, PASSWORD, showcase, visit, type PageVisit, type Showcase } from './support/pages.js';

const FIXTURE = path.resolve(import.meta.dirname, 'fixtures/forms.json');
const DETAIL_FIXTURE = path.resolve(import.meta.dirname, 'fixtures/forms-detail.json');
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
    // Every page works without the script; it only adds conveniences (menus, copy, theme, the question before a change that cannot
    // be taken back, show password, the busy state of a form being sent) and stays small: about 3.5 KB compressed, cached for good
    // under its hashed address. The comments that explain it count too.
    expect(fs.statSync(path.join(STATIC, 'app.js')).size).toBeLessThan(12 * 1024);
  });

  it('every page links the stylesheet and has no inline <style> block beyond the pre-paint theme snippet', async () => {
    s = await showcase();
    const { css, js } = staticUrls();
    for (const { name, html } of await pages(s)) {
      expect(html, name).toContain(`<link rel="stylesheet" href="${css}">`);
      expect(html, name).toContain(`<script src="${js}" defer></script>`);
      expect(html, name).not.toMatch(/<style[\s>]/);
      const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>/g)].map((m) => m[0]);
      expect(inline.map((tag) => tag.replace(/ nonce="[^"]*"/, '')), name).toEqual(['<script id="theme-init">']);
    }
    // Pages on instance hosts take the stylesheet from the platform host by absolute URL and carry no script at all.
    const ghost = await request(s.h.app).get('/').set('Host', 'ghost.apps.localhost').set('Accept', 'text/html');
    expect(ghost.status).toBe(404);
    expect(ghost.text).toContain(`<link rel="stylesheet" href="http://localhost:8080${css}">`);
    expect(ghost.text).not.toContain('<script');
    // Nothing on such a page refers to the instance host itself: no platform manifest or touch icon, every asset absolute.
    expect(ghost.text).not.toContain('manifest');
    expect(ghost.text).not.toContain('apple-touch-icon');
    expect(ghost.text).not.toMatch(/(?:src|href)="\/(?!\/)/);
    expect(ghost.text).toContain('<link rel="icon" type="image/webp" href="http://localhost:8080/icon.webp">');
  });
});

describe('response hardening', () => {
  const policyIn = (doc: Document): string => doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '';
  const policyOf = (html: string): string => policyIn(dom(html));

  it('every platform page carries a content security policy, and no inline script lacks its nonce', async () => {
    s = await showcase();
    const cookieOf = cookies(s);
    const nonces = new Set<string>();
    const visits: PageVisit[] = [...pageVisits(s), { name: 'not found', path: '/no/such/page', as: null, status: 404 }, { name: 'not found (signed in)', path: '/no/such/page', as: 'admin', status: 404 }];
    const rendered: Array<{ name: string; html: string }> = [{ name: 'consent', html: await consentHtml(s) }];
    for (const v of visits) {
      const res = await visit(s, v, cookieOf);
      expect(res.status, v.name).toBe(v.status ?? 200);
      expect(res.headers['x-content-type-options'], v.name).toBe('nosniff');
      // Framing is refused by a header: a policy inside the page cannot say that.
      expect(res.headers['content-security-policy'], v.name).toBe("frame-ancestors 'none'");
      rendered.push({ name: v.name, html: res.text });
    }
    let shells = 0;
    for (const { name, html } of rendered) {
      const doc = dom(html);
      const signedIn = doc.querySelector('header.topbar') !== null;
      if (signedIn) shells++;
      const policy = policyIn(doc);
      const nonce = /'nonce-([A-Za-z0-9+/]{22}==)'/.exec(policy)?.[1];
      expect(nonce, name).toBeDefined();
      expect(policy, name).toBe(`script-src 'self' 'nonce-${nonce}'; object-src 'none'; base-uri 'none'${signedIn ? "; form-action 'self'" : ''}`);
      expect(policy, name).not.toMatch(/unsafe-inline|unsafe-eval/);
      // The policy comes before anything it governs.
      expect(html.indexOf('http-equiv="Content-Security-Policy"'), name).toBeLessThan(html.indexOf('<script'));
      const scripts = [...doc.querySelectorAll('script')];
      expect(scripts.length, name).toBeGreaterThan(0);
      for (const script of scripts) {
        if (script.hasAttribute('src')) expect(script.getAttribute('src'), name).toMatch(/^\/static\//);
        else expect(script.getAttribute('nonce'), name).toBe(nonce);
      }
      // What the policy would silently switch off must not be relied on anywhere: inline handlers, javascript: links, <base>, plug-ins.
      expect(html, name).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
      expect(doc.querySelectorAll('a[href^="javascript:" i], base, object, embed').length, name).toBe(0);
      if (signedIn) for (const form of doc.querySelectorAll('form')) expect(form.getAttribute('action'), name).toMatch(/^\/(?!\/)/);
      nonces.add(nonce!);
    }
    expect(shells).toBeGreaterThan(10);
    expect(shells).toBeLessThan(rendered.length - 5);
    // One nonce per response, never reused.
    expect(nonces.size).toBe(rendered.length);
  }, 20_000);

  it('the sign-in and consent pages leave form-action open, because their posts end on another origin', async () => {
    s = await showcase();
    // Signing in on behalf of an instance: the post to /login is answered with a redirect chain that ends on the instance host.
    const login = await request(s.h.app).post('/login').set('Host', s.h.host).type('form')
      .send({ email: 'admin@x.y', password: 'admin-password-1', return: '/auth/instance?slug=notes&return=%2F' });
    expect(login.status).toBe(302);
    const next = await request(s.h.app).get(login.headers.location).set('Host', s.h.host).set('Cookie', await s.h.login());
    expect(new URL(next.headers.location).host).toBe('notes.apps.localhost:8080');
    expect(policyOf((await request(s.h.app).get('/login').set('Host', s.h.host)).text)).not.toContain('form-action');
    expect(policyOf(await consentHtml(s))).not.toContain('form-action');
  });

  it('pages on instance hosts carry no script and so no script policy', async () => {
    s = await showcase();
    const ghost = await request(s.h.app).get('/').set('Host', 'ghost.apps.localhost').set('Accept', 'text/html');
    expect(ghost.text).not.toContain('<script');
    expect(ghost.text).not.toContain('nonce');
  });

  it('robots.txt keeps crawlers away from the platform', async () => {
    h = makeHarness();
    const res = await request(h.app).get('/robots.txt').set('Host', h.host);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.text).toBe('User-agent: *\nDisallow: /\n');
    // An instance host has no such file of its own: what an app is indexed as is the app's business.
    h.core.apps.deploy({ slug: 'open', html: '<p>1</p>', userId: h.adminId });
    expect((await request(h.app).get('/robots.txt').set('Host', 'open.apps.localhost:8080')).text ?? '').not.toContain('Disallow');
  });
});

describe('reflow', () => {
  it('button labels wrap instead of pushing out of their card at 320 px; short row buttons stay on one line', () => {
    const css = fs.readFileSync(path.join(STATIC, 'app.css'), 'utf8');
    const rule = (selector: string): string => new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';
    const button = rule('.btn, button');
    expect(button).toContain('white-space: normal');
    expect(button).not.toContain('white-space: nowrap');
    expect(button).toContain('max-width: 100%');
    expect(rule('.btn-sm')).toContain('white-space: nowrap');
  });
});

describe('shell', () => {
  it('shell has a skip link, one <main>, one <h1>, and landmarks for banner and navigation', async () => {
    s = await showcase();
    const wanted = new Set(['home (administrator)', 'publish (publisher)', 'instance', 'app (owner)', 'admin users', 'admin settings', 'login', 'account']);
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

  it('error pages keep the navigation for a signed-in viewer and stay bare for everyone else', async () => {
    s = await showcase();
    const cookieOf = cookies(s);
    const at = async (path: string, as: PageVisit['as'], status: number): Promise<{ doc: Document; res: request.Response }> => {
      const res = await visit(s!, { name: path, path, as, status }, cookieOf);
      expect(res.status, path).toBe(status);
      return { doc: dom(res.text), res };
    };
    // An address that does not exist, a thing that does not exist, a thing that is not theirs, an area that is not theirs.
    const cases: Array<[string, PageVisit['as'], number, MessageKey]> = [
      ['/no/such/page', 'admin', 404, 'error.notFound.text'],
      ['/no/such/page', 'uwe', 404, 'error.notFound.text'],
      ['/instances/nope', 'admin', 404, 'notice.instanceMissing'],
      ['/apps/nope', 'pia', 404, 'notice.appMissing'],
      ['/instances/notes', 'pia', 403, 'forbidden.instance'],
      ['/apps/tasks', 'uwe', 403, 'forbidden.app'],
      ['/admin/users', 'pia', 403, 'forbidden.admin'],
      [`/admin/users/${s.ids.uwe}`, 'pia', 403, 'forbidden.admin'],
      [`/admin/users/${s.ids.pia}`, 'uwe', 403, 'forbidden.admin'],
      ['/admin/users/nope', 'admin', 404, 'admin.users.notFound'],
      ['/admin/groups/nope', 'admin', 404, 'admin.groups.missing'],
      ['/admin/instances/nope/domains', 'admin', 404, 'admin.instances.notFound'],
    ];
    for (const [path, as, status, key] of cases) {
      const { doc, res } = await at(path, as, status);
      const where = `${path} as ${as}`;
      expect(doc.querySelector('header.topbar'), where).not.toBeNull();
      expect(doc.querySelector('.account-menu form[action="/logout"] input[name="csrf"]')?.getAttribute('value'), where).toBeTruthy();
      // Uwe has a catalog and so a navigation of two; the others have more.
      expect(doc.querySelectorAll('nav.primary a').length, where).toBeGreaterThanOrEqual(2);
      expect(doc.querySelector('nav.primary [aria-current="page"]'), where).toBeNull();
      expect(doc.querySelectorAll('main#main').length, where).toBe(1);
      expect(doc.querySelector('main .auth-card h1'), where).not.toBeNull();
      expect(doc.querySelector('main')!.textContent, where).toContain(t('en', key));
      expect(res.headers['cache-control'], where).toBe('no-store');
    }
    // Signed out: the plain page, as before, and nothing that names an account.
    const anonymous = await at('/no/such/page', null, 404);
    expect(anonymous.doc.querySelector('header.topbar')).toBeNull();
    expect(anonymous.doc.querySelector('header.auth-top')).not.toBeNull();
    expect(anonymous.doc.querySelector('main')!.textContent).toContain(t('en', 'error.notFound.text'));
    // A session that ended is signed out.
    const stale = await cookieOf('uwe');
    s.h.core.users.bumpEpoch(s.ids.uwe);
    const ended = await request(s.h.app).get('/no/such/page').set('Host', s.h.host).set('Cookie', stale);
    expect(ended.status).toBe(404);
    expect(ended.text).not.toContain('topbar');
    // The API keeps answering in JSON, signed in or not, and other methods are "not found" as well.
    const api = await request(s.h.app).get('/api/no/such').set('Host', s.h.host).set('Cookie', await cookieOf('admin'));
    expect(api.status).toBe(404);
    expect(api.body).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
    expect((await request(s.h.app).post('/no/such/page').set('Host', s.h.host).set('Cookie', await cookieOf('admin'))).status).toBe(404);
  });

  it('a form sent from an out-of-date page says so inside the shell, and its one button reopens the page the form was on', async () => {
    s = await showcase();
    const cookie = await s.h.login();
    const cases: Array<[string, string]> = [
      ['/ui/instances/notes/delete', '/instances/notes'], ['/ui/apps/notes/collaborators', '/apps/notes'], ['/admin/groups', '/admin/groups'],
      [`/admin/users/${s.ids.uwe}/role`, `/admin/users/${s.ids.uwe}`], ['/admin/mail/test', '/admin/mail'], ['/ui/tokens', '/publish'],
      ['/account/name', '/account'], ['/logout', '/'],
    ];
    for (const [path, back] of cases) {
      const res = await request(s.h.app).post(path).set('Host', s.h.host).set('Cookie', cookie).type('form').send({ csrf: 'stale' });
      expect(res.status, path).toBe(403);
      const doc = dom(res.text);
      expect(doc.querySelector('header.topbar'), path).not.toBeNull();
      expect(doc.querySelector('main h1')!.textContent, path).toBe(t('en', 'error.stale.title'));
      expect(doc.querySelector('main p')!.textContent, path).toBe(t('en', 'error.stale.text'));
      const button = doc.querySelector('main .auth-card a.btn')!;
      expect([button.getAttribute('href'), button.textContent], path).toEqual([back, t('en', 'error.stale.back')]);
      // Nothing suggests reloading, which would send the same out-of-date form again.
      expect(res.text.toLowerCase(), path).not.toContain('reload');
      // The language switcher returns to that page too.
      expect(doc.querySelector('.lang-menu a')!.getAttribute('href'), path).toBe(`/lang/en?return=${encodeURIComponent(back)}`);
    }
    // Nothing was changed by any of them.
    const { core } = s.h;
    expect(core.apps.getInstanceBySlug('notes')).not.toBeNull();
    expect(core.apps.listCollaborators(core.apps.getApp('notes')!.id).map((u) => u.id)).toEqual([s.ids.pia]);
    expect(core.users.get(s.ids.uwe)!.role).toBe('user');
    expect(core.groups.list().map((g) => g.name)).toEqual(['Team']);
    // The session survived: the stale sign-out signed nobody out.
    expect((await request(s.h.app).get('/').set('Host', s.h.host).set('Cookie', cookie)).status).toBe(200);
  });

  it('the primary navigation marks the current item and offers Administration to administrators only', async () => {
    s = await showcase();
    const cookieOf = cookies(s);
    const nav = async (who: PageVisit['as'], path: string): Promise<Element | null> =>
      dom((await visit(s!, { name: path, path, as: who }, cookieOf)).text).querySelector('nav.primary');
    const home = await nav('admin', '/');
    expect([...home!.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['/', '/catalog', '/publish', '/admin']);
    expect(home!.querySelector('[aria-current="page"]')!.getAttribute('href')).toBe('/');
    expect((await nav('admin', '/admin/users'))!.querySelector('[aria-current="page"]')!.getAttribute('href')).toBe('/admin');
    // Every item is a page of its own that marks itself as current, the catalog included.
    expect((await nav('admin', '/catalog'))!.querySelector('[aria-current="page"]')!.getAttribute('href')).toBe('/catalog');
    const user = await nav('uwe', '/');
    expect([...user!.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['/', '/catalog']);
    const publisher = await nav('pia', '/publish');
    expect([...publisher!.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['/', '/catalog', '/publish']);
    expect(publisher!.querySelector('[aria-current="page"]')!.getAttribute('href')).toBe('/publish');
    expect(publisher!.querySelector('a[href="/publish"] .nav-full')!.textContent).toBe(t('en', 'nav.publish'));
  });

  it('the phone tab bar uses the short labels, and each link is named by the label on screen at either width', async () => {
    s = await showcase();
    const cookie = await s.h.login();
    for (const locale of LOCALES) {
      const html = (await request(s.h.app).get('/').set('Host', s.h.host).set('Cookie', `${cookie}; lager_lang=${locale}`)).text;
      const links = [...dom(html).querySelectorAll('nav.primary a')];
      const expected: Array<[string, MessageKey, MessageKey]> = [['/', 'nav.apps', 'nav.tab.apps'], ['/catalog', 'dash.catalog', 'dash.catalog'], ['/publish', 'nav.publish', 'nav.tab.publish'], ['/admin', 'nav.admin', 'nav.tab.admin']];
      expect(links.map((a) => [a.getAttribute('href'), a.querySelector('.nav-full')!.textContent, a.querySelector('.nav-short')!.textContent])).toEqual(
        expected.map(([href, full, tab]) => [href, t(locale, full), t(locale, tab)]));
      // No name of its own and no hidden text: a link's accessible name is whichever label is displayed (WCAG 2.5.3, Label in Name).
      for (const a of links) {
        expect(a.hasAttribute('aria-label')).toBe(false);
        expect(a.querySelectorAll('[aria-hidden="true"]:not(svg)')).toHaveLength(0);
      }
      expect(links.filter((a) => a.getAttribute('aria-current') === 'page').map((a) => a.getAttribute('href'))).toEqual(['/']);
    }
    // Exactly one of the two labels is displayed at each width, so the name never holds both.
    const css = fs.readFileSync(path.join(STATIC, 'app.css'), 'utf8');
    expect(css).toContain('.primary a .nav-short { display: none; }');
    // Only the phone block itself: a matching rule in a later block (print, forced colours) must not count.
    const start = css.indexOf('@media (max-width: 720px) {');
    const phone = css.slice(start, css.indexOf('\n}\n', start));
    expect(phone).toContain('.primary a .nav-full { display: none; }');
    expect(phone).toContain('.primary a .nav-short { display: block; }');
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
    // Signed-in pages have one language navigation: the menu, which works without script. Signed-out pages use the footer.
    expect(doc.querySelectorAll('a[href^="/lang/"]')).toHaveLength(4);
    expect(doc.querySelector('footer')).toBeNull();
    const login = dom((await visit(s, { name: 'login', path: '/login', as: null }, cookies(s))).text);
    expect(login.querySelectorAll('footer nav a[href^="/lang/"]')).toHaveLength(4);
  });

  it('theme snippet sets data-theme before paint and the stylesheet defines both themes', async () => {
    s = await showcase();
    const html = (await visit(s, { name: 'login', path: '/login', as: null }, cookies(s))).text;
    const head = html.slice(0, html.indexOf('</head>'));
    const snippet = /<script id="theme-init"[^>]*>([\s\S]*?)<\/script>/.exec(head)![1];
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
    // Badge text sits in a span that truncates, so a long value cannot widen the card.
    expect([...card.querySelectorAll('.badge > .badge-text')].map((b) => b.textContent)).toEqual([t('en', 'visibility.private'), 'v2']);
    // The card's actions name the app for screen readers ("Open Notes", not a row of identical "Open").
    expect(card.querySelector('a[href="http://notes.apps.localhost:8080"]')!.getAttribute('aria-label')).toBe(t('en', 'card.open', { title: 'Notes' }));
    expect(card.querySelector('a[href="/instances/notes"]')!.getAttribute('aria-label')).toBe(t('en', 'card.manage', { title: 'Notes' }));
    // The disabled instance says so and cannot be opened.
    const old = [...doc.querySelectorAll('#mine .app-card')].find((c) => c.querySelector('.slug')!.textContent === 'old-notes')!;
    expect([...old.querySelectorAll('.badge')].map((b) => b.textContent)).toContain(t('en', 'common.disabled'));
    expect(old.querySelector('a[href^="http://old-notes."]')).toBeNull();
    // A card without a description has no empty placeholder.
    const catalog = dom((await visit(s, { name: 'catalog', path: '/catalog', as: 'admin' }, cookies(s))).text);
    const tasks = catalog.querySelector('#catalog .app-card')!;
    expect(tasks.querySelector('.app-desc')).toBeNull();
    const shared = doc.querySelector('#shared .app-card')!;
    expect([...shared.querySelectorAll('.badge')].map((b) => b.textContent)).toContain(t('en', 'badge.shared', { level: t('en', 'level.interact') }));
    // Publishing lives on its own page: the home page shows no apps section, connector or tokens.
    for (const id of ['apps', 'connect', 'tokens']) expect(doc.getElementById(id), id).toBeNull();
    // My apps on the publish page: same card shape with latest version and instance count.
    const publish = dom((await visit(s, { name: 'publish', path: '/publish', as: 'admin' }, cookies(s))).text);
    const mine = publish.querySelector('#apps .app-card')!;
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
    // On phones Manage shows only its icon; its text stays for assistive technology.
    expect(card.querySelector('a[href="/instances/notes"] .btn-label')!.textContent).toBe(t('en', 'common.manage'));
    // Self-service apps in the catalog reveal the create form in place.
    const doc = dom((await visit(s, { name: 'catalog', path: '/catalog', as: 'uwe' }, cookieOf)).text);
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
    // Publishers are pointed to the publish page, which holds the connector and the API tokens.
    expect(hero.querySelector('a[href="/publish"]')!.textContent).toBe(t('en', 'nav.publish'));
    expect(doc.querySelector('form[action="/ui/tokens"]')).toBeNull();
    const publish = dom((await request(h.app).get('/publish').set('Host', h.host).set('Cookie', await h.login())).text);
    expect(publish.querySelector('#tokens form[action="/ui/tokens"]')).not.toBeNull();
    expect(publish.querySelector('#apps .empty')!.textContent).toBe(t('en', 'dash.noApps'));
    // Plain users get the tagline without the steps they cannot take.
    h.core.users.create({ email: 'plain@x.y', name: 'Plain', password: PASSWORD, role: 'user' });
    const plain = dom((await request(h.app).get('/').set('Host', h.host).set('Cookie', await h.login('plain@x.y', PASSWORD))).text);
    expect(plain.querySelector('.empty-hero h1')!.textContent).toBe(t('en', 'brand.tagline'));
    expect(plain.querySelector('.empty-hero ol.steps')).toBeNull();
    expect(plain.querySelector('.empty-hero')!.textContent).toContain(t('en', 'home.empty.user'));
    expect(plain.querySelector('a[href="/publish"]')).toBeNull();
    // The publish page sends people who do not deploy home.
    const away = await request(h.app).get('/publish').set('Host', h.host).set('Cookie', await h.login('plain@x.y', PASSWORD));
    expect(away.status).toBe(302);
    expect(away.headers.location).toBe('/');
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
        // Explicit roles keep the semantics when the stacked layout turns rows into blocks; action columns have a real header.
        expect(table.getAttribute('role'), name).toBe('table');
        expect([...table.querySelectorAll('thead, tbody')].every((g) => g.getAttribute('role') === 'rowgroup'), name).toBe(true);
        expect([...table.querySelectorAll('tr')].every((r) => r.getAttribute('role') === 'row'), name).toBe(true);
        expect([...table.querySelectorAll('th')].every((c) => c.getAttribute('role') === 'columnheader' && c.textContent !== ''), name).toBe(true);
        expect([...table.querySelectorAll('td')].every((c) => c.getAttribute('role') === 'cell'), name).toBe(true);
        for (const th of table.querySelectorAll('th .sr-only')) expect(th.textContent, name).toBe(t('en', 'common.actions'));
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

  it('names and addresses in tables are cut with an ellipsis, never broken inside a word, and keep their full text as a tooltip', async () => {
    s = await showcase();
    const long = 'a-very-long-first-name.and-an-even-longer-family-name@department.subsidiary.example.org';
    s.h.core.users.create({ email: long, name: 'Maximiliane Alexandra von Hohenstein-Wolkenburg', password: PASSWORD, role: 'user' });
    const doc = dom((await visit(s, { name: 'admin users', path: '/admin/users', as: 'admin' }, cookies(s))).text);
    const row = [...doc.querySelectorAll('tbody tr')].find((tr) => tr.textContent!.includes(long))!;
    const cell = row.querySelector('td:first-child .cell-user')!;
    expect(cell.querySelector('strong')!.getAttribute('title')).toBe('Maximiliane Alexandra von Hohenstein-Wolkenburg');
    expect(cell.querySelector('span[title]')!.getAttribute('title')).toBe(long);
    // The whole text stays in the page for screen readers and for copying; only its display is shortened.
    expect(cell.querySelector('span[title]')!.textContent).toBe(long);
    for (const path of [`/admin/groups/${s.ids.group}`, '/instances/notes']) {
      const page = dom((await visit(s, { name: path, path, as: 'admin' }, cookies(s))).text);
      for (const text of page.querySelectorAll('.cell-user strong, .cell-user > div > span')) expect(text.getAttribute('title'), path).toBe(text.textContent);
    }
    const css = fs.readFileSync(path.join(STATIC, 'app.css'), 'utf8');
    const rule = (selector: string): string => new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';
    const text = rule('.cell-user strong, .cell-user > div > span');
    for (const part of ['overflow: hidden', 'text-overflow: ellipsis', 'white-space: nowrap']) expect(text).toContain(part);
    // The column is bounded, so a long address cannot push the other columns out; nothing lets it break between any two letters.
    expect(rule('.cell-user > div')).toMatch(/max-width: clamp\(/);
    expect(css).not.toMatch(/\.cell-user[^{}]*\{[^}]*(overflow-wrap: anywhere|word-break: break-all)/);
    // As cards on a phone the person gets the full width of the card.
    expect(css).toMatch(/\.table-stack \.cell-user > div \{ flex: 1; max-width: none; \}/);
  });

  it('only the users table is "dense": between 641 and 1100 px it stacks by the same rules as every table does on a phone', async () => {
    s = await showcase();
    const all = await pages(s);
    const dense = all.filter((p) => dom(p.html).querySelector('table.table-dense')).map((p) => p.name);
    expect(dense).toEqual(['admin users']);
    const users = dom(all.find((p) => p.name === 'admin users')!.html).querySelectorAll('table');
    expect([...users].map((table) => table.className)).toEqual(['table-stack table-dense table-users']);
    // Every other table of the interface is there to compare with, and none of them carries the class.
    expect(all.filter((p) => dom(p.html).querySelector('table.table-stack')).length).toBeGreaterThan(5);
    const css = fs.readFileSync(path.join(STATIC, 'app.css'), 'utf8');
    /** The body of the one media block with this query that starts with the rule for the table head. */
    const block = (query: string, cls: string): string => {
      const start = `@media ${query} {\n  .${cls} thead {`;
      expect(css.split(start), query).toHaveLength(2);
      const from = css.indexOf(start) + `@media ${query} {\n`.length;
      return css.slice(from, css.indexOf('\n}\n', from));
    };
    const phone = block('(max-width: 640px)', 'table-stack');
    const wide = block('(min-width: 641px) and (max-width: 1100px)', 'table-dense');
    expect(phone.split('\n').length).toBeGreaterThan(15);
    // The two blocks are one rule set under two names: a change to one that misses the other fails here.
    expect(wide).toBe(phone.replaceAll('.table-stack', '.table-dense'));
    expect(wide).not.toContain('.table-stack');
    // Nothing else styles the class: outside its block it would also apply on a phone or on a wide screen.
    expect(css.split('.table-dense').length - 1).toBe(wide.split('.table-dense').length - 1);
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
    // Both switches in one form with one Save; who may open the instance is part of Sharing.
    const settings = side.querySelector('form[action="/ui/instances/notes/settings"]')!;
    expect([...settings.querySelectorAll('input[type="checkbox"].switch')].map((i) => i.getAttribute('name'))).toEqual(['auto_update', 'badge']);
    expect(settings.querySelectorAll('button[type="submit"]')).toHaveLength(1);
    expect(side.querySelector('select[name="visibility"]')).toBeNull();
    expect(doc.querySelector('#sharing select[name="visibility"]')).not.toBeNull();
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
  /** Every page the fixtures cover, as `[name, html]`, in the fixtures' order. */
  async function formPages(sc: Showcase): Promise<Array<[string, string]>> {
    const cookieOf = cookies(sc);
    const out: Array<[string, string]> = [];
    for (const v of pageVisits(sc)) {
      const res = await visit(sc, v, cookieOf);
      expect(res.status, v.name).toBe(v.status ?? 200);
      out.push([v.name, res.text]);
    }
    out.push(['consent', await consentHtml(sc)]);
    for (const { name, html } of await emptyHomes()) out.push([name, html]);
    return out;
  }

  // forms.json was generated from the pages before the redesign (the token forms moved with their page to /publish):
  // the markup may change, the action, method and field names of every form may not. The forms of the instance page's
  // "Data from outside" card (ingest/switch, ingest/token) were added with that card.
  // The storage forms of a group page and of every app in the apps overview (quota) were added with storage per group and app.
  // The forms of each account (role, ai-group, disabled, reset-link) moved from the users list to the account's own page (#73).
  // The auto-update and badge forms of the instance page became one settings form (#83); their old routes still work.
  // The share form of the instance page became one for a person and one for a group (#84), to the same route.
  // The catalog moved from the home page to a page of its own (#89), and its copy forms with it; they send from=catalog.
  it('forms post the same fields to the same routes as before', async () => {
    s = await showcase();
    const expected = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;
    const names = idNames(s);
    const actual = Object.fromEntries((await formPages(s)).map(([name, html]) => [name, formsOf(html, names)]));
    expect(actual).toEqual(expected);
  });

  // forms-detail.json is the current state in more depth: field types, required, maxlength and the fixed hidden values.
  it('fields keep their types, limits and fixed values', async () => {
    s = await showcase();
    const expected = JSON.parse(fs.readFileSync(DETAIL_FIXTURE, 'utf8')) as Record<string, unknown>;
    const names = idNames(s);
    const actual = Object.fromEntries((await formPages(s)).map(([name, html]) => [name, formDetailsOf(html, names)]));
    expect(actual).toEqual(expected);
  });
});

describe('a form being sent', () => {
  const SCRIPT = fs.readFileSync(path.join(STATIC, 'app.js'), 'utf8');
  function page(body: string) {
    const win = new JSDOM(`<!doctype html><body>${body}</body>`, { runScripts: 'outside-only' }).window;
    // jsdom does not navigate: a stand-in that records what a yes in the dialog sends.
    const sent: string[] = [];
    win.HTMLFormElement.prototype.submit = function (this: HTMLFormElement) { sent.push(this.id); };
    win.HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
    win.HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new win.Event('close')); };
    // Timers the script sets, run by hand.
    const timers: Array<{ fn: () => void; ms: number; cleared?: boolean }> = [];
    const w = win as unknown as { setTimeout: (fn: () => void, ms: number) => number; clearTimeout: (id?: number) => void };
    // As a browser does, a cleared timer's callback does nothing when its time comes.
    w.setTimeout = (fn, ms) => { const entry: { fn: () => void; ms: number; cleared?: boolean } = { fn: () => { if (!entry.cleared) fn(); }, ms }; return timers.push(entry); };
    w.clearTimeout = (id) => { if (id) timers[id - 1].cleared = true; };
    win.eval(SCRIPT);
    /** Sends `form` as the browser would; returns whether the browser goes on to send it. */
    const submit = (form: HTMLFormElement, submitter?: HTMLElement): boolean =>
      form.dispatchEvent(new win.SubmitEvent('submit', { cancelable: true, bubbles: true, submitter: submitter ?? null }));
    return { win, doc: win.document, sent, submit, timers };
  }

  it('marks the pressed button busy, sends once, and is back to normal when the page is shown again', () => {
    const { win, doc, submit } = page(`<form id="f"><input name="a"><button type="submit" name="go" value="test" id="test">Test</button>
      <button type="submit" name="go" value="save" id="save"><svg class="i"></svg>Save</button></form>`);
    const form = doc.getElementById('f') as HTMLFormElement;
    const save = doc.getElementById('save')!;
    expect(submit(form, save)).toBe(true);
    expect(save.getAttribute('aria-busy')).toBe('true');
    expect(doc.getElementById('test')!.hasAttribute('aria-busy')).toBe(false);
    // Not disabled: the pressed button's own name and value still go with the form.
    expect((save as HTMLButtonElement).disabled).toBe(false);
    // A second press while the first is on its way sends nothing.
    expect(submit(form, save)).toBe(false);
    expect(submit(form, doc.getElementById('test')!)).toBe(false);
    // Back to the page (back button, page cache): a normal button that sends again.
    win.dispatchEvent(new win.Event('pageshow'));
    expect(save.hasAttribute('aria-busy')).toBe(false);
    expect(submit(form, save)).toBe(true);
  });

  it('a form that asks first is busy only once the answer is yes', () => {
    const { doc, sent, submit } = page(`<form id="del" data-confirm="Delete?" data-confirm-ok="Delete"><button type="submit" id="go">Delete</button></form>`);
    const form = doc.getElementById('del') as HTMLFormElement;
    expect(submit(form, doc.getElementById('go')!)).toBe(false);
    expect(doc.getElementById('go')!.hasAttribute('aria-busy')).toBe(false);
    doc.querySelector<HTMLButtonElement>('dialog .btn-danger')!.click();
    expect(sent).toEqual(['del']);
    expect(doc.getElementById('go')!.getAttribute('aria-busy')).toBe('true');
    // A second press while the yes is on its way asks nothing and sends nothing.
    expect(submit(form, doc.getElementById('go')!)).toBe(false);
    expect(doc.querySelector('dialog[open]')).toBeNull();
    expect(sent).toEqual(['del']);
  });

  it('a form with two buttons, sent through its question, cannot be sent again by the other one', () => {
    const { doc, sent, submit } = page(`<form id="f" data-confirm="Restore?" data-confirm-ok="Restore">
      <button type="submit" name="act" value="restore" id="restore">Restore</button><button type="submit" name="act" value="other" id="other">Other</button></form>`);
    const form = doc.getElementById('f') as HTMLFormElement;
    submit(form, doc.getElementById('restore')!);
    doc.querySelector<HTMLButtonElement>('dialog .btn-danger')!.click();
    expect(doc.getElementById('restore')!.getAttribute('aria-busy')).toBe('true');
    expect(submit(form, doc.getElementById('other')!)).toBe(false);
    expect(doc.querySelector('dialog[open]')).toBeNull();
    expect(sent).toEqual(['f']);
  });

  it('a load that was stopped leaves the form busy for 100 seconds, longer than any answer takes, then it can be sent again', () => {
    const { doc, submit, timers } = page(`<form id="f"><button type="submit" id="save">Save</button></form>`);
    const form = doc.getElementById('f') as HTMLFormElement;
    expect(submit(form, doc.getElementById('save')!)).toBe(true);
    expect(submit(form, doc.getElementById('save')!)).toBe(false);
    // Longer than the slowest answer: the AI test waits up to DEFAULT_REQUEST_TIMEOUT_MS for the provider.
    expect(timers.map((x) => x.ms)).toEqual([100000]);
    expect(timers[0].ms).toBeGreaterThan(DEFAULT_REQUEST_TIMEOUT_MS);
    timers[0].fn();
    expect(doc.getElementById('save')!.hasAttribute('aria-busy')).toBe(false);
    expect(submit(form, doc.getElementById('save')!)).toBe(true);
  });

  it('a timer left from before the page came back from the cache does not end a newer send early', () => {
    const { win, doc, submit, timers } = page(`<form id="f"><button type="submit" id="save">Save</button></form>`);
    const form = doc.getElementById('f') as HTMLFormElement;
    submit(form, doc.getElementById('save')!);
    win.dispatchEvent(new win.Event('pageshow'));
    expect(timers[0].cleared).toBe(true);
    // The old timer was cancelled when the page came back: when its time comes, the new send is still busy.
    submit(form, doc.getElementById('save')!);
    timers[0].fn();
    expect(form.hasAttribute('data-busy')).toBe(true);
    expect(timers.filter((x) => !x.cleared)).toHaveLength(1);
  });

  it('the busy button shows a spinner instead of its icon, and a still ellipsis without motion', () => {
    const css = fs.readFileSync(path.join(STATIC, 'app.css'), 'utf8');
    expect(css).toMatch(/button\[aria-busy="true"\] > \.i \{ display: none; \}/);
    expect(css).toMatch(/button\[aria-busy="true"\]::before \{[^}]*animation: spin/);
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/button\[aria-busy="true"\]::before \{ content: "…";/);
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
    // Any address under the apps domain is this server's (a new instance's name shows the address it will get).
    const ours = (u: string): boolean => own.has(new URL(u).origin) || new URL(u).host.endsWith('.apps.localhost:8080');
    const foreign = (text: string): string[] => [...text.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]).filter((u) => !ours(u));
    // Form values are data the page sends back (the consent form carries the client's redirect address), not something it loads.
    for (const { name, html } of await pages(s)) expect(foreign(html.replace(/ value="[^"]*"/g, '')), name).toEqual([]);
    for (const file of fs.readdirSync(STATIC)) expect(foreign(fs.readFileSync(path.join(STATIC, file), 'utf8')), file).toEqual([]);
    // Also no protocol-relative or data: references to load from elsewhere.
    for (const file of fs.readdirSync(STATIC)) expect(fs.readFileSync(path.join(STATIC, file), 'utf8'), file).not.toMatch(/url\(\s*['"]?(?:\/\/|https?:)/);
    expect(notFoundPage('en', { origin: 'http://localhost:8080', switcher: false })).not.toMatch(/https?:\/\/(?!localhost:8080)/);
  });
});
