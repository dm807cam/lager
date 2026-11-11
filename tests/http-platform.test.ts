import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { LoginLimiter } from '../src/http/platform.js';
import { csrfToken } from '../src/http/session.js';
import { makeHarness, PLATFORM_HOST, type Harness } from './support/http.js';

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
    const res = await request(h.app).post('/login').set('Host', PLATFORM_HOST).type('form').send({ email: 'admin@x.y', password: 'pw' });
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
    expect(res.text).toContain('E-Mail oder Passwort ist falsch.');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('11th failed login → 429', async () => {
    h = makeHarness();
    for (let i = 0; i < 10; i++) {
      const r = await request(h.app).post('/login').set('Host', PLATFORM_HOST).type('form').send({ email: 'admin@x.y', password: 'nope' });
      expect(r.status).toBe(401);
    }
    const res = await request(h.app).post('/login').set('Host', PLATFORM_HOST).type('form').send({ email: 'admin@x.y', password: 'pw' });
    expect(res.status).toBe(429);
  });

  it('return must be a local path', async () => {
    h = makeHarness();
    for (const ret of ['https://evil.example', '//evil.example', '/\\evil']) {
      const res = await request(h.app).post('/login').set('Host', PLATFORM_HOST).type('form').send({ email: 'admin@x.y', password: 'pw', return: ret });
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/');
    }
    const ok = await request(h.app).post('/login').set('Host', PLATFORM_HOST).type('form').send({ email: 'admin@x.y', password: 'pw', return: '/apps?x=1' });
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
    expect((await request(h.app).post('/logout').set('Host', PLATFORM_HOST)).status).toBe(403);
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
    expect(res.text).toContain('deaktiviert');
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
    expect(page.text).toContain('Seite nicht gefunden.');
    const api = await request(h.app).get('/api/nothing').set('Host', PLATFORM_HOST);
    expect(api.status).toBe(404);
    expect(api.body.error.code).toBe('not_found');
    const host = await request(h.app).get('/').set('Host', 'evil.example');
    expect(host.status).toBe(404);
    expect(host.text).toContain('Seite nicht gefunden.');
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
    const res = await request(h.app).post('/login').set('Host', host).type('form').send({ email: 'admin@x.y', password: 'pw' });
    const cookie = ([] as string[]).concat(res.headers['set-cookie'])[0];
    expect(cookie.startsWith('__Host-lager_session=')).toBe(true);
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toMatch(/Domain=/i);
    const token = cookie.split(';')[0].split('=')[1];
    h.core.apps.deploy({ slug: 'x', html: '<p>x</p>', userId: h.adminId });
    const plain = await request(h.app).get('/auth/instance').query({ slug: 'x' }).set('Host', host).set('Cookie', 'lager_session=' + token);
    expect(plain.headers.location).toContain('/login');
    const proper = await request(h.app).get('/auth/instance').query({ slug: 'x' }).set('Host', host).set('Cookie', '__Host-lager_session=' + token);
    expect(proper.headers.location).toContain('/__lager/callback');
    const cb = await request(h.app).get(new URL(proper.headers.location).pathname + new URL(proper.headers.location).search)
      .set('Host', new URL(proper.headers.location).host);
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

  it('limits per account across different IPs', async () => {
    h = makeHarness({ trustProxy: 1 });
    for (let i = 0; i < 10; i++) expect((await attempt(h, `5.6.7.${i}`)).status).toBe(401);
    expect((await attempt(h, '8.8.8.8', 'admin@x.y', 'pw')).status).toBe(429);
    expect((await attempt(h, '8.8.8.8', 'ADMIN@x.y ', 'pw')).status).toBe(429);
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
