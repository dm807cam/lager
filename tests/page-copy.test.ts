import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { adminExtension } from '../src/http/admin.js';
import { consentPage, esc, levelLabel, noticeText, visibilityLabel } from '../src/http/pages.js';
import { formatSize, LOCALES, t } from '../src/i18n/index.js';
import { MemoryMailer } from '../src/platform/mail.js';
import { makeHarness, type Harness } from './support/http.js';

let h: Harness | undefined;
afterEach(() => { h?.core.close(); h = undefined; });

const W = 'wk.apps.localhost';

describe('not found on an instance host', () => {
  it('serves the localized page to browser navigations, JSON to the instance API and a plain line to other requests', async () => {
    h = makeHarness();
    const r = h.core.apps.deploy({ slug: 'wk', html: '<p>1</p>', userId: h.adminId });
    h.core.apps.setVisibility(r.instances[0].id, 'public', h.adminId);
    const nav = await request(h.app).get('/nope.html').set('Host', W).set('Accept', 'text/html,application/xhtml+xml').set('Accept-Language', 'de');
    expect(nav.status).toBe(404);
    expect(nav.headers['content-type']).toContain('text/html');
    expect(nav.text).toContain(esc(t('de', 'error.notFound.text')));
    const api = await request(h.app).get('/__lager/nothing').set('Host', W).set('Accept', 'text/html');
    expect(api.status).toBe(404);
    expect(api.body).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
    const other = await request(h.app).get('/nope.png').set('Host', W).set('Accept', 'image/*');
    expect(other.status).toBe(404);
    expect(other.headers['content-type']).toContain('text/plain');
  });
});

describe('consent page emphasis', () => {
  it('wraps the client name and the redirect host in strong, escaping both', () => {
    for (const locale of LOCALES) {
      const html = consentPage(locale, '<script>alert(1)</script>', 'claude.ai', 'Ann <i>', {});
      expect(html, locale).toContain('<strong>&lt;script&gt;alert(1)&lt;/script&gt;</strong>');
      expect(html, locale).toContain('<strong>claude.ai</strong>');
      expect(html, locale).not.toContain('<script>');
      expect(html, locale).toContain('Ann &lt;i&gt;');
      expect(html, locale).not.toContain('\u0001');
    }
  });
});

describe('one-time tokens stay out of language links', () => {
  it('the reset, verify and invited-register pages have no /lang link and never repeat the token in a URL', async () => {
    const mailer = new MemoryMailer();
    h = makeHarness({ mailer });
    h.core.settings.setRegistration('open');
    await request(h.app).post('/register').set('Host', h.host).type('form').send({ name: 'U', email: 'u@x.y', password: 'password-123' });
    const verify = new URL(/https?:\/\/\S+/.exec(mailer.sent[0].text)![0]).searchParams.get('token')!;
    const user = h.core.users.getByEmail('u@x.y')!;
    const reset = new URL(h.core.accounts.createResetLink(user.id)).searchParams.get('token')!;
    const invite = (await h.core.accounts.createInvite({ role: 'user', createdBy: h.adminId, locale: 'en' }));
    const pages = [`/reset?token=${reset}`, `/verify?token=${verify}`, new URL(invite.url).pathname + new URL(invite.url).search];
    for (const page of pages) {
      const res = await request(h.app).get(page).set('Host', h.host);
      expect(res.status, page).toBe(200);
      expect(res.text, page).not.toContain('/lang/');
      expect(res.text, page).not.toMatch(/href="[^"]*(token|invite)=/);
    }
    // The plain register page still has the switcher.
    expect((await request(h.app).get('/register').set('Host', h.host)).text).toContain('/lang/de?return=%2Fregister');
  });
});

describe('limits quoted by catalog texts', () => {
  it('slug, token name and group name limits come from the enforced constants in every locale', () => {
    for (const locale of LOCALES) {
      expect(noticeText(locale, 'notice.slugInvalid'), locale).toContain('63');
      expect(noticeText(locale, 'dash.tokens.nameInvalid'), locale).toContain('100');
      expect(noticeText(locale, 'admin.groups.nameInvalid'), locale).toContain('60');
      for (const key of ['notice.slugInvalid', 'dash.tokens.nameInvalid', 'admin.groups.nameInvalid'] as const) expect(noticeText(locale, key), `${locale} ${key}`).not.toContain('{');
    }
  });

  it('an invalid group name renders its limit on the page', async () => {
    h = makeHarness({ extensions: [adminExtension] });
    const cookie = await h.login();
    const page = await request(h.app).get('/admin/groups').set('Host', h.host).set('Cookie', cookie);
    expect(page.text).toContain('maxlength="60"');
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.text)![1];
    const res = await request(h.app).post('/admin/groups').set('Host', h.host).set('Cookie', cookie).type('form').send({ csrf, name: 'x'.repeat(61) });
    expect(res.status).toBe(400);
    expect(res.text).toContain('The name must be 1 to 60 characters long.');
  });
});

describe('labels', () => {
  it('a value that is also an Object property name is shown as it is', () => {
    expect(levelLabel('en', 'constructor')).toBe('constructor');
    expect(visibilityLabel('de', '__proto__')).toBe('__proto__');
    expect(levelLabel('en', 'view')).toBe('Viewer');
  });
});

describe('formatSize', () => {
  it('French uses o, Kio, Mio and Gio; the others use B, KiB, MiB and GiB', () => {
    expect(formatSize('fr', 10)).toBe('10 o');
    expect(formatSize('fr', 1536)).toMatch(/^1,5\s?Kio$/);
    expect(formatSize('fr', 5 * 1024 * 1024)).toMatch(/Mio$/);
    expect(formatSize('fr', 3 * 1024 ** 3)).toMatch(/Gio$/);
    expect(formatSize('en', 10)).toBe('10 B');
    expect(formatSize('en', 1536)).toBe('1.5 KiB');
    expect(formatSize('de', 1536)).toBe('1,5 KiB');
    expect(formatSize('es', 5 * 1024 * 1024)).toMatch(/MiB$/);
    expect(formatSize('en', 3 * 1024 ** 3)).toBe('3.0 GiB');
  });
});
