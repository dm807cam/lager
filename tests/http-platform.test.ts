import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
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

  it('logout clears the cookie', async () => {
    h = makeHarness();
    const res = await request(h.app).post('/logout').set('Host', PLATFORM_HOST);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
    expect(([] as string[]).concat(res.headers['set-cookie']).join(';')).toContain('lager_session=;');
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

  it('unknown host → 404', async () => {
    h = makeHarness();
    for (const host of ['evil.example', 'apps.localhost', 'a.b.apps.localhost']) {
      const res = await request(h.app).get('/healthz').set('Host', host);
      expect(res.status).toBe(404);
    }
  });

  it('unknown platform path → 404', async () => {
    h = makeHarness();
    expect((await request(h.app).get('/nothing').set('Host', PLATFORM_HOST)).status).toBe(404);
  });
});
