import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { LoginLimiter } from '../src/http/platform.js';
import { csrfToken } from '../src/http/session.js';
import { makeHarness, NONCE, NONCE_COOKIE_HTTPS, PLATFORM_HOST, type Harness, withoutNonce } from './support/http.js';
import { t } from '../src/i18n/index.js';

let h: Harness | undefined;
afterEach(() => { h?.core.close(); h = undefined; });

describe('platform host', () => {
  it('healthz', async () => {
    h = makeHarness();
    const res = await request(h.app).get('/healthz').set('Host', PLATFORM_HOST);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('login sets an HttpOnly host-only cookie', async () => {
    h = makeHarness();
    const res = await request(h.app).post('/login').set('Host', PLATFORM_HOST).type('form').send({ email: 'admin@x.y', password: 'admin-password-1' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    const cookie = ([] as string[]).concat(res.headers['set-cookie']).find((c) => c.startsWith('lager_session='))!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toMatch(/Domain=/i);
    expect(cookie).not.toContain('Secure');
  });

  it('wrong password → 401', async () => {
    h = makeHarness();
    const res = await request(h.app).post('/login').set('Host', PLATFORM_HOST).type('form').send({ email: 'admin@x.y', password: 'nope' });
    expect(res.status).toBe(401);
    expect(res.text).toContain(t('en', 'login.invalid'));
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('a failed sign-in keeps the typed address in the field, never the password, and answers alike for a known and an unknown name', async () => {
    h = makeHarness();
    const hh = h;
    const attempt = (email: string, password: string) => request(hh.app).post('/login').set('Host', PLATFORM_HOST).type('form').send({ email, password });
    const fresh = await request(h.app).get('/login').set('Host', PLATFORM_HOST);
    expect(fresh.text).toContain('<input id="email" name="email" type="email" autocomplete="username" required autofocus>');
    expect(fresh.text).toContain('<input id="password" name="password" type="password" autocomplete="current-password" required>');

    const secret = 'Wrong-password-that-must-not-come-back';
    const known = await attempt('  Admin@X.y ', secret);
    expect(known.status).toBe(401);
    // As typed (trimmed), escaped, with the cursor now in the password field.
    // Both fields are marked invalid and point at the message, which a screen reader then reads with the field.
    const invalid = ' aria-invalid="true" aria-describedby="login-error"';
    expect(known.text).toContain(`<input id="email" name="email" type="email" autocomplete="username" required value="Admin@X.y"${invalid}>`);
    expect(known.text).toContain(`<input id="password" name="password" type="password" autocomplete="current-password" required autofocus${invalid}>`);
    expect(known.text).toContain('<div id="login-error" class="notice notice-danger" role="alert">');
    expect(known.text).not.toContain(secret);
    expect(known.text).not.toMatch(/type="password"[^>]*value=/);

    const hostile = await attempt('"><script>alert(1)</script>@x.y', secret);
    expect(hostile.text).toContain('value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;@x.y"');
    expect(hostile.text).not.toContain('<script>alert(1)');
    expect((await attempt('a'.repeat(400) + '@x.y', secret)).text).toContain(`value="${'a'.repeat(254)}"`);
    expect((await request(h.app).post('/login').set('Host', PLATFORM_HOST).type('form').send('email=a%40x.y&email=b%40x.y&password=x')).text).not.toContain('value="a@x.y');

    // The same page for a name with an account and one without, apart from the address each visitor typed themselves.
    const same = (html: string, email: string): string => withoutNonce(html).split(`value="${email}"`).join('value="…"');
    const unknown = await attempt('Nobdy@X.y', secret);
    expect(unknown.status).toBe(401);
    expect(same(unknown.text, 'Nobdy@X.y')).toBe(same(known.text, 'Admin@X.y'));
    expect(unknown.text.length).toBe(known.text.length);

    // The answers that are not about the password keep it as well: too many attempts.
    for (let i = 0; i < 12; i++) await attempt('admin@x.y', 'nope');
    const blocked = await attempt('admin@x.y', 'admin-password-1');
    expect(blocked.status).toBe(429);
    expect(blocked.text).toContain('required value="admin@x.y" aria-invalid="true" aria-describedby="login-error">');
  });

  it('the sign-in page offers "Create account" only while anyone may register', async () => {
    h = makeHarness();
    const link = `<a href="/register">${t('en', 'login.register')}</a>`;
    const pages = async (): Promise<string[]> => [
      (await request(h!.app).get('/login').set('Host', PLATFORM_HOST)).text,
      (await request(h!.app).post('/login').set('Host', PLATFORM_HOST).type('form').send({ email: 'x@x.y', password: 'nope' })).text,
    ];
    h.core.settings.setRegistration('open');
    for (const html of await pages()) expect(html).toContain(link);
    for (const mode of ['invite', 'closed'] as const) {
      h.core.settings.setRegistration(mode);
      for (const html of await pages()) {
        expect(html, mode).not.toContain('href="/register"');
        expect(html, mode).toContain('href="/forgot"');
      }
      // The page itself still answers and explains; an invitation link leads there directly.
      expect((await request(h.app).get('/register').set('Host', PLATFORM_HOST)).status, mode).toBe(200);
    }
  });

  it('11th failed login → 429', async () => {
    h = makeHarness();
    for (let i = 0; i < 10; i++) {
      const r = await request(h.app).post('/login').set('Host', PLATFORM_HOST).type('form').send({ email: 'admin@x.y', password: 'nope' });
      expect(r.status).toBe(401);
    }
    const res = await request(h.app).post('/login').set('Host', PLATFORM_HOST).type('form').send({ email: 'admin@x.y', password: 'admin-password-1' });
    expect(res.status).toBe(429);
  });

  it('return must be a local path', async () => {
    h = makeHarness();
    for (const ret of ['https://evil.example', '//evil.example', '/\\evil']) {
      const res = await request(h.app).post('/login').set('Host', PLATFORM_HOST).type('form').send({ email: 'admin@x.y', password: 'admin-password-1', return: ret });
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/');
    }
    const ok = await request(h.app).post('/login').set('Host', PLATFORM_HOST).type('form').send({ email: 'admin@x.y', password: 'admin-password-1', return: '/apps?x=1' });
    expect(ok.headers.location).toBe('/apps?x=1');
  });

  it('logout clears the cookie when the csrf token is sent', async () => {
    h = makeHarness();
    const cookie = await h.login();
    const csrf = csrfToken(h.core, h.core.users.list()[0]);
    const res = await request(h.app).post('/logout').set('Host', PLATFORM_HOST).set('Cookie', cookie).type('form').send({ csrf });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
    expect(([] as string[]).concat(res.headers['set-cookie']).join(';')).toContain('lager_session=;');
  });

  it('logout without a valid csrf token → 403 and keeps the session', async () => {
    h = makeHarness();
    const cookie = await h.login();
    const none = await request(h.app).post('/logout').set('Host', PLATFORM_HOST).set('Cookie', cookie);
    expect(none.status).toBe(403);
    expect(none.headers['set-cookie']).toBeUndefined();
    const bad = await request(h.app).post('/logout').set('Host', PLATFORM_HOST).set('Cookie', cookie).type('form').send({ csrf: 'nope' });
    expect(bad.status).toBe(403);
    // Without a session there is nothing to sign out of: on to the sign-in page.
    const anon = await request(h.app).post('/logout').set('Host', PLATFORM_HOST);
    expect(anon.status).toBe(302);
    expect(anon.headers.location).toBe('/login');
  });

  it('auth/instance: anonymous goes to login, unknown slug 404, none level 403', async () => {
    h = makeHarness();
    const r = h.core.apps.deploy({ slug: 'workout', html: '<p>x</p>', userId: h.adminId });
    const anon = await request(h.app).get('/auth/instance').query({ slug: 'workout', return: '/' }).set('Host', PLATFORM_HOST);
    expect(anon.status).toBe(302);
    expect(anon.headers.location).toBe('/login?return=' + encodeURIComponent('/auth/instance?slug=workout&return=%2F'));
    const cookie = await h.login();
    expect((await request(h.app).get('/auth/instance').query({ slug: 'nope' }).set('Host', PLATFORM_HOST).set('Cookie', cookie)).status).toBe(404);
    const other = h.core.users.create({ email: 'u@x.y', name: 'U', password: 'pw', role: 'user' });
    expect(other.id).toBeTruthy();
    const ucookie = await h.login('u@x.y', 'pw');
    const denied = await request(h.app).get('/auth/instance').query({ slug: r.instances[0].slug }).set('Host', PLATFORM_HOST).set('Cookie', ucookie);
    expect(denied.status).toBe(403);
  });

  it('platform admins get no special rights on foreign instances', async () => {
    h = makeHarness();
    const publisher = h.core.users.create({ email: 'p@x.y', name: 'P', password: 'pw', role: 'publisher' });
    h.core.apps.deploy({ slug: 'theirs', html: '<p>x</p>', userId: publisher.id });
    const cookie = await h.login(); // bootstrap admin, not the owner
    const res = await request(h.app).get('/auth/instance').query({ slug: 'theirs' }).set('Host', PLATFORM_HOST).set('Cookie', cookie);
    expect(res.status).toBe(403);
    expect(res.headers.location).toBeUndefined();
  });

  it('an instance code is not a platform session', async () => {
    h = makeHarness();
    h.core.apps.deploy({ slug: 'workout', html: '<p>x</p>', userId: h.adminId });
    const cookie = await h.login();
    const auth = await request(h.app).get('/auth/instance').query({ slug: 'workout' }).set('Host', PLATFORM_HOST).set('Cookie', cookie);
    const code = new URL(auth.headers.location).searchParams.get('code')!;
    const res = await request(h.app).get('/auth/instance').query({ slug: 'workout' }).set('Host', PLATFORM_HOST).set('Cookie', 'lager_session=' + code);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/login');
  });

  it('disabled account cannot sign in and loses its session', async () => {
    h = makeHarness();
    const user = h.core.users.create({ email: 'dis@x.y', name: 'Dis', password: 'long enough pw', role: 'user' });
    const cookie = await h.login('dis@x.y', 'long enough pw');
    expect((await request(h.app).get('/auth/instance').query({ slug: 'nope' }).set('Host', PLATFORM_HOST).set('Cookie', cookie)).status).toBe(404);
    h.core.users.setDisabled(user.id, true);
    const res = await request(h.app).post('/login').set('Host', PLATFORM_HOST).type('form').send({ email: 'dis@x.y', password: 'long enough pw' });
    expect(res.status).toBe(401);
    expect(res.text).toContain(t('en', 'login.disabled'));
    expect(res.headers['set-cookie']).toBeUndefined();
    const after = await request(h.app).get('/auth/instance').query({ slug: 'nope' }).set('Host', PLATFORM_HOST).set('Cookie', cookie);
    expect(after.status).toBe(302);
    expect(after.headers.location).toContain('/login');
  });

  it('unknown host → 404', async () => {
    h = makeHarness();
    for (const host of ['evil.example', 'apps.localhost', 'a.b.apps.localhost']) {
      const res = await request(h.app).get('/healthz').set('Host', host);
      expect(res.status).toBe(404);
    }
  });

  it('unknown platform path → 404 German page; unknown api path keeps the JSON error', async () => {
    h = makeHarness();
    const page = await request(h.app).get('/nothing').set('Host', PLATFORM_HOST);
    expect(page.status).toBe(404);
    expect(page.type).toBe('text/html');
    expect(page.text).toContain(t('en', 'error.notFound.text'));
    const api = await request(h.app).get('/api/nothing').set('Host', PLATFORM_HOST);
    expect(api.status).toBe(404);
    expect(api.body.error.code).toBe('not_found');
    const host = await request(h.app).get('/').set('Host', 'evil.example');
    expect(host.status).toBe(404);
    expect(host.text).toContain(t('en', 'error.notFound.text'));
  });

  it('platform responses cannot be framed', async () => {
    const { dashboardExtension } = await import('../src/http/dashboard.js');
    const { apiExtension } = await import('../src/http/api.js');
    h = makeHarness({ extensions: [apiExtension, dashboardExtension] });
    const cookie = await h.login();
    for (const path of ['/login', '/', '/api/apps', '/nothing', '/register', '/forgot', '/reset', '/verify', '/account']) {
      const res = await request(h.app).get(path).set('Host', PLATFORM_HOST).set('Cookie', cookie);
      expect(res.headers['x-frame-options'], path).toBe('DENY');
      expect(res.headers['content-security-policy'], path).toBe("frame-ancestors 'none'");
    }
  });

  it('__Host- cookie names on https, plain-named cookies are ignored there', async () => {
    h = makeHarness({ publicUrl: 'https://lager.example.org' });
    const host = h.host;
    const res = await request(h.app).post('/login').set('Host', host).type('form').send({ email: 'admin@x.y', password: 'admin-password-1' });
    const cookie = ([] as string[]).concat(res.headers['set-cookie'])[0];
    expect(cookie.startsWith('__Host-lager_session=')).toBe(true);
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toMatch(/Domain=/i);
    const token = cookie.split(';')[0].split('=')[1];
    h.core.apps.deploy({ slug: 'x', html: '<p>x</p>', userId: h.adminId });
    const plain = await request(h.app).get('/auth/instance').query({ slug: 'x' }).set('Host', host).set('Cookie', 'lager_session=' + token);
    expect(plain.headers.location).toContain('/login');
    const proper = await request(h.app).get('/auth/instance').query({ slug: 'x', n: NONCE }).set('Host', host).set('Cookie', '__Host-lager_session=' + token);
    expect(proper.headers.location).toContain('/__lager/callback');
    const cb = await request(h.app).get(new URL(proper.headers.location).pathname + new URL(proper.headers.location).search)
      .set('Host', new URL(proper.headers.location).host).set('Cookie', NONCE_COOKIE_HTTPS);
    expect(([] as string[]).concat(cb.headers['set-cookie'])[0].startsWith('__Host-lager_inst=')).toBe(true);
  });

});

describe('login rate limit behind a proxy', () => {
  const attempt = (hh: Harness, xff: string, email = 'admin@x.y', password = 'nope') =>
    request(hh.app).post('/login').set('Host', PLATFORM_HOST).set('X-Forwarded-For', xff).type('form').send({ email, password });

  it('limits by the last X-Forwarded-For entry; rotating the first one does not reset it', async () => {
    h = makeHarness({ trustProxy: 1 });
    for (let i = 0; i < 10; i++) {
      expect((await attempt(h, `1.2.3.${i}, 5.6.7.8`, `u${i}@x.y`)).status).toBe(401);
    }
    expect((await attempt(h, '9.9.9.9, 5.6.7.8', 'other@x.y')).status).toBe(429);
    // a different last entry is a different client
    expect((await attempt(h, '1.2.3.4, 5.6.7.9', 'other@x.y')).status).toBe(401);
  });

  it('an account under attack from many addresses pauses, stays open to a browser its owner used before, and guessers are cut short', async () => {
    h = makeHarness({ trustProxy: 1 });
    // The owner signed in from this browser before the attack: it carries the device cookie.
    const before = await attempt(h, '7.7.7.7', 'admin@x.y', 'admin-password-1');
    const device = ([] as string[]).concat(before.headers['set-cookie']).find((c) => c.startsWith('lager_device='))!;
    expect(device).toContain('HttpOnly');
    const wrong = await attempt(h, '5.6.7.0');
    for (let i = 1; i < 10; i++) expect((await attempt(h, `5.6.7.${i}`)).status).toBe(401);
    // Ten failures from ten addresses: the account pauses. A browser it does not know is turned away with the answer a wrong
    // password gets, also with the right password, and the password is not even looked at.
    const check = vi.spyOn(h.core.users, 'checkLogin');
    const paused = await attempt(h, '8.8.8.8', 'admin@x.y', 'admin-password-1');
    expect(paused.status).toBe(wrong.status);
    expect(withoutNonce(paused.text)).toBe(withoutNonce(wrong.text));
    expect(paused.headers['set-cookie']).toBeUndefined();
    expect(check).not.toHaveBeenCalled();
    // A device cookie of another account does not help.
    const other = h.core.users.create({ email: 'o@x.y', name: 'O', password: 'other-password-1', role: 'user' });
    const foreign = ([] as string[]).concat((await attempt(h, '7.7.7.8', other.email, 'other-password-1')).headers['set-cookie']).find((c) => c.startsWith('lager_device='))!;
    check.mockClear();
    expect((await attempt(h, '8.8.8.8', 'admin@x.y', 'admin-password-1').set('Cookie', foreign.split(';')[0])).status).toBe(401);
    expect(check).not.toHaveBeenCalled();
    // The owner's own browser still gets in: guessing does not lock the owner out. That success also ends the pause.
    expect((await attempt(h, '8.8.4.4', 'admin@x.y', 'admin-password-1').set('Cookie', device.split(';')[0])).status).toBe(302);
    check.mockRestore();
    // A new address gets three guesses on the hot account instead of ten, however the e-mail is spelled.
    for (let i = 0; i < 3; i++) expect((await attempt(h, '9.9.9.9', i === 1 ? 'ADMIN@x.y ' : 'admin@x.y')).status).toBe(401);
    expect((await attempt(h, '9.9.9.9', 'admin@x.y', 'admin-password-1')).status).toBe(429);
    expect((await attempt(h, '9.9.9.9', 'ADMIN@x.y ', 'admin-password-1')).status).toBe(429);
    // The same address is still free to sign in to another account.
    expect((await attempt(h, '9.9.9.9', 'nobody@x.y')).status).toBe(401);
  });

  it('LoginLimiter drops expired entries', () => {
    vi.useFakeTimers();
    try {
      const l = new LoginLimiter();
      for (let i = 0; i < 50; i++) l.fail(`10.0.0.${i}`, `u${i}@x.y`);
      expect(l.size).toBe(100);
      vi.advanceTimersByTime(16 * 60 * 1000);
      l.fail('10.1.1.1', 'new@x.y');
      expect(l.size).toBe(2);
      expect(l.blocked('10.0.0.1', 'u1@x.y')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
