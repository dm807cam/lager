import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { loadConfig } from '../src/config.js';
import { LagerError } from '../src/errors.js';
import { esc } from '../src/http/pages.js';
import { csrfToken } from '../src/http/session.js';
import { t } from '../src/i18n/index.js';
import { MemoryMailer } from '../src/platform/mail.js';
import { makeHarness, type Harness } from './support/http.js';

let h: Harness | undefined;
afterEach(() => { h?.core.close(); h = undefined; });

const PASSWORD = 'correct horse battery';
const cookieOf = (res: request.Response, name: string): string | undefined =>
  ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(name + '='));

function setup(opts: { defaultLocale?: 'en' | 'de' | 'fr' | 'es'; mailer?: MemoryMailer } = {}) {
  const mailer = opts.mailer ?? new MemoryMailer();
  h = makeHarness({ mailer, defaultLocale: opts.defaultLocale });
  h.core.settings.setRegistration('open');
  const get = (p: string, headers: Record<string, string> = {}) => request(h!.app).get(p).set('Host', h!.host).set(headers);
  const post = (p: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
    request(h!.app).post(p).set('Host', h!.host).set(headers).type('form').send(body);
  return { h, mailer, get, post };
}

describe('page language', () => {
  it('login page is English by default with lang="en" and the tagline', async () => {
    const s = setup();
    const res = await s.get('/login');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<html lang="en"');
    expect(res.text).toContain(esc(t('en', 'brand.tagline')));
    expect(res.text).toContain(esc(t('en', 'brand.pitch')));
    // The tagline is the heading above the form, the pitch comes after it.
    expect(res.text.indexOf(esc(t('en', 'brand.tagline')))).toBeLessThan(res.text.indexOf('<form method="post" action="/login"'));
    expect(res.text.indexOf('<form method="post" action="/login"')).toBeLessThan(res.text.indexOf(esc(t('en', 'brand.pitch'))));
    expect(res.text).not.toMatch(/Anmelden|Passwort/);
  });

  it('Accept-Language selects French, Spanish, German', async () => {
    const s = setup();
    for (const [header, locale] of [['fr-CA,fr;q=0.9,en;q=0.8', 'fr'], ['es-ES,es;q=0.8', 'es'], ['de-DE,de;q=0.9', 'de'], ['ja', 'en']] as const) {
      const res = await s.get('/login', { 'Accept-Language': header });
      expect(res.text, header).toContain(`<html lang="${locale}"`);
      expect(res.text, header).toContain(esc(t(locale, 'login.title')));
      expect(res.text, header).toContain(esc(t(locale, 'brand.tagline')));
    }
    expect(t('fr', 'login.title')).not.toBe(t('en', 'login.title'));
  });

  it('language switcher sets the cookie and wins over Accept-Language', async () => {
    const s = setup();
    const page = await s.get('/login');
    for (const l of ['en', 'de', 'fr', 'es']) expect(page.text).toContain(`href="/lang/${l}?return=%2Flogin"`);
    const sw = await s.get('/lang/fr?return=%2Fregister', { 'Accept-Language': 'de' });
    expect(sw.status).toBe(302);
    expect(sw.headers.location).toBe('/register');
    const cookie = cookieOf(sw, 'lager_lang')!;
    expect(cookie).toMatch(/^lager_lang=fr;/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Max-Age=31536000/i);
    expect(cookie).not.toMatch(/Domain=/i);
    const res = await s.get('/login', { Cookie: 'lager_lang=fr', 'Accept-Language': 'de' });
    expect(res.text).toContain('<html lang="fr"');
    // An invalid cookie value is ignored.
    expect((await s.get('/login', { Cookie: 'lager_lang=xx', 'Accept-Language': 'de' })).text).toContain('<html lang="de"');
  });

  it('a signed-in user\'s stored locale wins over the cookie', async () => {
    const s = setup();
    const admin = await s.h.login();
    const user = s.h.core.users.get(s.h.adminId)!;
    const account = await s.get('/account', { Cookie: admin });
    expect(account.text).toContain('action="/account/locale"');
    for (const name of ['English', 'Deutsch', 'Français', 'Español']) expect(account.text).toContain(name);
    expect(account.text).toContain(esc(t('en', 'account.locale.browser')));
    const csrf = csrfToken(s.h.core, user);
    expect((await s.post('/account/locale', { locale: 'es' }, { Cookie: admin })).status).toBe(403);
    const saved = await s.post('/account/locale', { csrf, locale: 'es' }, { Cookie: admin });
    expect(saved.status).toBe(302);
    // The account page then answers in the language just chosen, and says so in it.
    const after = await s.get(saved.headers.location, { Cookie: admin });
    expect(after.text).toContain('<html lang="es"');
    expect(after.text).toContain(esc(t('es', 'account.locale.saved')));
    expect(s.h.core.users.get(user.id)!.locale).toBe('es');
    const res = await s.get('/account', { Cookie: `${admin}; lager_lang=fr`, 'Accept-Language': 'de' });
    expect(res.text).toContain('<html lang="es"');
    // "Browser default" clears the choice again.
    await s.post('/account/locale', { csrf, locale: '' }, { Cookie: admin });
    expect(s.h.core.users.get(user.id)!.locale).toBeNull();
    expect((await s.post('/account/locale', { csrf, locale: 'xx' }, { Cookie: admin })).status).toBe(400);
    // The footer switcher stores the choice for a signed-in user too.
    await s.get('/lang/de', { Cookie: admin });
    expect(s.h.core.users.get(user.id)!.locale).toBe('de');
  });

  it('unknown locale in /lang → 404; return is sanitised', async () => {
    const s = setup();
    expect((await s.get('/lang/xx')).status).toBe(404);
    expect((await s.get('/lang/%2e%2e')).status).toBe(404);
    for (const bad of ['//evil.example', 'https://evil.example/', '/\\evil.example']) {
      const res = await s.get('/lang/de').query({ return: bad });
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/');
    }
    expect((await s.get('/lang/de')).headers.location).toBe('/');
  });
});

describe('mail language', () => {
  it('registration mail is sent in the request locale; later mails in the stored locale', async () => {
    const s = setup();
    const reg = await s.post('/register', { name: 'Ann', email: 'ann@example.org', password: PASSWORD }, { 'Accept-Language': 'fr' });
    expect(reg.text).toContain(esc(t('fr', 'auth.register.sent.text')));
    expect(s.mailer.sent[0].subject).toBe(t('fr', 'mail.verify.subject'));
    expect(s.mailer.sent[0].text).toContain(t('fr', 'mail.verify.intro'));
    expect(s.h.core.users.getByEmail('ann@example.org')!.locale).toBe('fr');
    // A later request in another language does not change the language of the recipient's mail.
    await s.post('/forgot', { email: 'ann@example.org' }, { 'Accept-Language': 'de' });
    await new Promise((r) => setTimeout(r, 20));
    expect(s.mailer.sent[1].subject).toBe(t('fr', 'mail.reset.subject'));
    // A user without a stored locale gets the locale of the request.
    s.h.core.users.setLocale(s.h.core.users.getByEmail('ann@example.org')!.id, null);
    await s.post('/forgot', { email: 'ann@example.org' }, { 'Accept-Language': 'es' });
    await new Promise((r) => setTimeout(r, 20));
    expect(s.mailer.sent[2].subject).toBe(t('es', 'mail.reset.subject'));
    expect(s.mailer.sent[2].text).toContain(t('es', 'mail.validity.reset'));
  });

  it('invitation mail uses the locale given by the caller', async () => {
    const s = setup();
    await s.h.core.accounts.createInvite({ email: 'new@example.org', role: 'user', createdBy: s.h.adminId, locale: 'de' });
    expect(s.mailer.sent[0].subject).toBe(t('de', 'mail.invite.subject'));
    await s.h.core.accounts.createInvite({ email: 'other@example.org', role: 'user', createdBy: s.h.adminId });
    expect(s.mailer.sent[1].subject).toBe(t('en', 'mail.invite.subject'));
  });
});

describe('instance host', () => {
  it('instance-host error pages follow Accept-Language', async () => {
    const s = setup();
    const res = await request(s.h.app).get('/').set('Host', 'nope.apps.localhost:8080').set('Accept-Language', 'es');
    expect(res.status).toBe(404);
    expect(res.text).toContain('<html lang="es"');
    expect(res.text).toContain(esc(t('es', 'error.notFound.title')));
    const en = await request(s.h.app).get('/').set('Host', 'nope.apps.localhost:8080');
    expect(en.text).toContain('<html lang="en"');
    const r = s.h.core.apps.deploy({ slug: 'off', html: '<p>x</p>', userId: s.h.adminId });
    s.h.core.apps.setInstanceDisabled(r.instances[0].id, true);
    const dis = await request(s.h.app).get('/').set('Host', 'off.apps.localhost:8080').set('Accept-Language', 'de');
    expect(dis.status).toBe(403);
    expect(dis.text).toContain(esc(t('de', 'error.disabled.text')));
  });

  it('session reports viewer.locale', async () => {
    const s = setup();
    const r = s.h.core.apps.deploy({ slug: 'loc', html: '<p>x</p>', userId: s.h.adminId });
    s.h.core.apps.setVisibility(r.instances[0].id, 'public', s.h.adminId);
    const anon = await request(s.h.app).get('/__lager/session').set('Host', 'loc.apps.localhost:8080').set('Accept-Language', 'fr-FR,fr;q=0.9');
    expect(anon.body.viewer.locale).toBe('fr');
    const inst = await s.h.enter('loc', await s.h.login());
    const stored = await request(s.h.app).get('/__lager/session').set('Host', 'loc.apps.localhost:8080').set('Cookie', inst).set('Accept-Language', 'fr');
    expect(stored.body.viewer.locale).toBe('fr');
    s.h.core.users.setLocale(s.h.adminId, 'de');
    const after = await request(s.h.app).get('/__lager/session').set('Host', 'loc.apps.localhost:8080').set('Cookie', inst).set('Accept-Language', 'fr');
    expect(after.body.viewer.locale).toBe('de');
    const plain = await request(s.h.app).get('/__lager/session').set('Host', 'loc.apps.localhost:8080');
    expect(plain.body.viewer.locale).toBe('en');
  });
});

describe('configuration', () => {
  it('LAGER_DEFAULT_LOCALE changes the fallback; invalid value is refused', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-cfg-'));
    const env = { LAGER_PUBLIC_URL: 'http://lager.localhost:8080', LAGER_APPS_DOMAIN: 'apps.localhost', LAGER_DATA_DIR: dir };
    expect(loadConfig(env).defaultLocale).toBe('en');
    expect(loadConfig({ ...env, LAGER_DEFAULT_LOCALE: 'fr' }).defaultLocale).toBe('fr');
    expect(loadConfig({ ...env, LAGER_DEFAULT_LOCALE: ' DE ' }).defaultLocale).toBe('de');
    expect(() => loadConfig({ ...env, LAGER_DEFAULT_LOCALE: 'klingon' })).toThrow(/LAGER_DEFAULT_LOCALE/);
    const s = setup({ defaultLocale: 'fr' });
    const res = await s.get('/login');
    expect(res.text).toContain('<html lang="fr"');
    // Accept-Language still wins over the configured default.
    expect((await s.get('/login', { 'Accept-Language': 'es' })).text).toContain('<html lang="es"');
  });
});

describe('notices', () => {
  it('map by reason code, not by message text', async () => {
    const s = setup();
    // Registration errors carry a stable reason; the page shows the catalog text in the request locale.
    const bad = await s.get('/register', { 'Accept-Language': 'fr' }).query({ invite: 'nonsense' });
    expect(bad.text).toContain(esc(t('fr', 'auth.register.inviteInvalid')));
    s.h.core.settings.setRegistration('invite');
    const closed = await s.post('/register', { name: 'A', email: 'a@x.y', password: PASSWORD, invite: 'nonsense' }, { 'Accept-Language': 'es' });
    expect(closed.status).toBe(403);
    expect(closed.text).toContain(esc(t('es', 'auth.register.inviteInvalid')));
    s.h.core.settings.setRegistration('open');
    // Only a server without mail names a taken address on the page; with mail the owner is told by mail instead.
    s.mailer.enabled = false;
    const dup = await s.post('/register', { name: 'Admin', email: 'admin@x.y', password: PASSWORD }, { 'Accept-Language': 'de' });
    expect(dup.status).toBe(409);
    expect(dup.text).toContain(esc(t('de', 'auth.register.exists')));
    // Domain errors expose a reason code next to the English message; pages and tools branch on the code only.
    const reasonOf = (fn: () => unknown): string | undefined => {
      try { fn(); } catch (e) { if (e instanceof LagerError) return e.reason; throw e; }
      return undefined;
    };
    const apps = s.h.core.apps;
    const first = s.h.core.users.create({ email: 'p@x.y', name: 'P', password: PASSWORD, role: 'publisher' });
    const second = s.h.core.users.create({ email: 'q@x.y', name: 'Q', password: PASSWORD, role: 'publisher' });
    const { instances } = apps.deploy({ slug: 'notes', html: '<p>x</p>', userId: first.id });
    const mine = apps.deploy({ slug: 'mine', html: '<p>x</p>', userId: second.id }).app;
    expect(reasonOf(() => apps.createInstance({ appId: mine.id, slug: 'notes', ownerId: second.id }))).toBe('slug_taken');
    apps.deleteInstance(instances[0].id, first.id);
    expect(reasonOf(() => apps.createInstance({ appId: mine.id, slug: 'notes', ownerId: second.id }))).toBe('slug_retired');
    expect(reasonOf(() => apps.createInstance({ appId: mine.id, slug: 'Not Valid', ownerId: second.id }))).toBe('slug_invalid');
    expect(reasonOf(() => apps.createInstance({ appId: mine.id, slug: 'admin', ownerId: second.id }))).toBe('slug_reserved');
    expect(reasonOf(() => s.h.core.domains.add(apps.getInstanceBySlug('mine')!, 'not a host', s.h.core.users.get(s.h.adminId)!, true))).toBe('host_invalid');
  });
});
