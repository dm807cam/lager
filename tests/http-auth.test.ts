import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { dashboardExtension } from '../src/http/dashboard.js';
import { RateLimiter } from '../src/http/ratelimit.js';
import { csrfToken } from '../src/http/session.js';
import { MemoryMailer } from '../src/platform/mail.js';
import { makeHarness, type Harness } from './support/http.js';

let h: Harness | undefined;
afterEach(() => { h?.core.close(); h = undefined; });

const PASSWORD = 'correct horse battery';
const cookieOf = (res: request.Response, name = 'lager_session'): string | undefined =>
  ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(name + '='))?.split(';')[0];

function setup(opts: { mode?: 'open' | 'invite' | 'closed' } = {}) {
  const mailer = new MemoryMailer();
  h = makeHarness({ mailer, extensions: [dashboardExtension] });
  h.core.settings.setRegistration(opts.mode ?? 'open');
  const post = (path: string, body: Record<string, string>, extra: { cookie?: string; origin?: string; ip?: string } = {}) => {
    const r = request(h!.app).post(path).set('Host', h!.host).type('form');
    if (extra.cookie) r.set('Cookie', extra.cookie);
    if (extra.origin) r.set('Origin', extra.origin);
    return r.send(body);
  };
  const get = (path: string, cookie?: string) => {
    const r = request(h!.app).get(path).set('Host', h!.host);
    return cookie ? r.set('Cookie', cookie) : r;
  };
  const linkOf = (i = mailer.sent.length - 1): string => {
    const u = new URL(/https?:\/\/\S+/.exec(mailer.sent[i].text)![0]);
    return u.pathname + u.search;
  };
  const register = (email = 'ann@example.org', extra: Record<string, string> = {}) =>
    post('/register', { name: 'Ann', email, password: PASSWORD, ...extra });
  const registerVerified = async (email = 'ann@example.org'): Promise<string> => {
    await register(email);
    const res = await get(linkOf());
    return cookieOf(res)!;
  };
  return { h, mailer, post, get, linkOf, register, registerVerified };
}

describe('registration and verification', () => {
  it('register → mail → verify → signed in', async () => {
    const s = setup();
    const res = await s.register();
    expect(res.status).toBe(200);
    expect(res.text).toContain('Wir haben dir eine E-Mail geschickt. Bestätige deine Adresse über den Link darin.');
    expect(s.mailer.sent).toHaveLength(1);
    const verify = await s.get(s.linkOf());
    expect(verify.status).toBe(302);
    expect(verify.headers.location).toBe('/');
    const cookie = cookieOf(verify)!;
    expect(cookie).toBeTruthy();
    expect((await s.get('/', cookie)).status).toBe(200);
  });

  it('a bad verify link offers a resend form that always answers the same', async () => {
    const s = setup();
    const bad = await s.get('/verify?token=nope');
    expect(bad.text).toContain('Der Link ist ungültig oder abgelaufen.');
    expect(bad.text).toContain('action="/verify/resend"');
    await s.register();
    const known = await s.post('/verify/resend', { email: 'ann@example.org' });
    const unknown = await s.post('/verify/resend', { email: 'nobody@example.org' });
    const notice = 'Falls die Adresse bei uns registriert und noch nicht bestätigt ist, haben wir eine neue E-Mail geschickt.';
    expect(known.text).toContain(notice);
    expect(unknown.status).toBe(known.status);
    expect(unknown.text).toBe(known.text);
    expect(s.mailer.sent).toHaveLength(2);
  });

  it('login before verification is refused with a hint', async () => {
    const s = setup();
    await s.register();
    const res = await s.post('/login', { email: 'ann@example.org', password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.text).toContain('Bitte bestätige zuerst deine E-Mail-Adresse.');
    expect(res.text).toContain('action="/verify/resend"');
    expect(cookieOf(res)).toBeUndefined();
  });

  it('registration modes', async () => {
    let s = setup({ mode: 'closed' });
    expect((await s.get('/register')).text).toContain('Die Registrierung ist geschlossen.');
    expect((await s.register()).status).toBe(403);
    h!.core.close();

    s = setup({ mode: 'invite' });
    expect((await s.get('/register')).text).toContain('Registrierung nur mit Einladung.');
    expect((await s.get('/register?invite=bogus')).text).toContain('Registrierung nur mit Einladung.');
    expect((await s.register()).status).toBe(403);
    const { url } = await h!.core.accounts.createInvite({ role: 'publisher', createdBy: h!.adminId });
    const invite = new URL(url).searchParams.get('invite')!;
    const form = await s.get(`/register?invite=${invite}`);
    expect(form.text).toContain('action="/register"');
    const res = await s.register('pub@example.org', { invite });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    const cookie = cookieOf(res)!;
    expect(h!.core.users.getByEmail('pub@example.org')?.role).toBe('publisher');
    expect((await s.get('/', cookie)).status).toBe(200);
  });

  it('invite bound to an e-mail pre-fills and enforces it', async () => {
    const s = setup({ mode: 'invite' });
    const { url } = await h!.core.accounts.createInvite({ email: 'bound@example.org', role: 'user', createdBy: h!.adminId });
    const invite = new URL(url).searchParams.get('invite')!;
    const form = await s.get(`/register?invite=${invite}`);
    expect(form.text).toMatch(/<input[^>]*name="email"[^>]*value="bound@example.org"[^>]*readonly/);
    const wrong = await s.register('other@example.org', { invite });
    expect(wrong.status).toBe(403);
    expect(wrong.text).toContain('action="/register"');
    expect(h!.core.users.getByEmail('other@example.org')).toBeNull();
    const ok = await s.register('bound@example.org', { invite });
    expect(ok.status).toBe(302);
  });

  it('duplicate e-mail and short password re-render the form', async () => {
    const s = setup();
    await s.registerVerified('ann@example.org');
    const dup = await s.post('/register', { name: 'Zed', email: 'ann@example.org', password: PASSWORD });
    expect(dup.status).toBe(409);
    expect(dup.text).toContain('Diese E-Mail-Adresse ist bereits registriert.');
    expect(dup.text).toContain('value="Zed"');
    expect(dup.text).toContain('value="ann@example.org"');
    const short = await s.post('/register', { name: 'Bo', email: 'bo@example.org', password: 'kurz' });
    expect(short.status).toBe(400);
    expect(short.text).toContain('Das Passwort braucht mindestens 10 Zeichen.');
    expect(short.text).toContain('value="Bo"');
    expect(short.text).toContain('value="bo@example.org"');
    expect(short.text).not.toContain('kurz');
  });

  it('registration rate limit', async () => {
    const s = setup();
    for (let i = 0; i < 5; i++) expect((await s.post('/register', { name: 'A', email: `u${i}@example.org`, password: 'x' })).status).toBe(400);
    expect((await s.post('/register', { name: 'A', email: 'u6@example.org', password: 'x' })).status).toBe(429);
  });

  it('cross-origin post to a public auth form is refused', async () => {
    const s = setup();
    for (const path of ['/register', '/forgot', '/reset', '/verify/resend']) {
      const res = await s.post(path, { email: 'a@example.org' }, { origin: 'https://evil.example' });
      expect(res.status, path).toBe(403);
    }
    expect(h!.core.users.getByEmail('a@example.org')).toBeNull();
    const same = await s.post('/forgot', { email: 'a@example.org' }, { origin: 'http://lager.localhost:8080' });
    expect(same.status).toBe(200);
  });
});

describe('password reset', () => {
  const FORGOT = 'Falls die Adresse bei uns registriert ist, haben wir eine E-Mail zum Zurücksetzen geschickt.';

  it('forgot answers identically for known and unknown addresses', async () => {
    const s = setup();
    await s.registerVerified();
    s.mailer.sent.length = 0;
    const known = await s.post('/forgot', { email: 'ann@example.org' });
    const unknown = await s.post('/forgot', { email: 'nobody@example.org' });
    expect(known.status).toBe(200);
    expect(known.text).toContain(FORGOT);
    expect(unknown.status).toBe(known.status);
    expect(unknown.text).toBe(known.text);
    expect(s.mailer.sent).toHaveLength(1);
    expect(s.mailer.sent[0].to).toBe('ann@example.org');
    expect((await s.get('/forgot')).text).toContain('action="/forgot"');
  });

  it('forgot per-address limit is silent', async () => {
    const s = setup();
    await s.registerVerified();
    s.mailer.sent.length = 0;
    const bodies: string[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await s.post('/forgot', { email: 'ann@example.org' });
      expect(res.status).toBe(200);
      bodies.push(res.text);
    }
    expect(s.mailer.sent).toHaveLength(3);
    expect(new Set(bodies).size).toBe(1);
  });

  it('forgot per-IP limit answers 429', async () => {
    const s = setup();
    for (let i = 0; i < 5; i++) expect((await s.post('/forgot', { email: `u${i}@example.org` })).status).toBe(200);
    expect((await s.post('/forgot', { email: 'u9@example.org' })).status).toBe(429);
  });

  it('reset flow', async () => {
    const s = setup();
    await s.registerVerified();
    s.mailer.sent.length = 0;
    await s.post('/forgot', { email: 'ann@example.org' });
    const link = s.linkOf();
    const form = await s.get(link);
    expect(form.text).toContain('action="/reset"');
    const token = new URL(link, 'http://x').searchParams.get('token')!;
    const done = await s.post('/reset', { token, password: 'a brand new password' });
    expect(done.status).toBe(200);
    expect(done.text).toContain('Passwort geändert.');
    expect(done.text).toContain('href="/login"');
    expect((await s.post('/login', { email: 'ann@example.org', password: PASSWORD })).status).toBe(401);
    expect((await s.post('/login', { email: 'ann@example.org', password: 'a brand new password' })).status).toBe(302);
    const again = await s.post('/reset', { token, password: 'yet another password' });
    expect(again.status).toBe(400);
    expect(again.text).toContain('Der Link ist ungültig oder abgelaufen.');
  });

  it('reset with a verify token fails', async () => {
    const s = setup();
    await s.register();
    const token = new URL(s.linkOf(), 'http://x').searchParams.get('token')!;
    const res = await s.post('/reset', { token, password: 'a brand new password' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('Der Link ist ungültig oder abgelaufen.');
  });

  it('reset with a short password keeps the form', async () => {
    const s = setup();
    await s.registerVerified();
    const link = h!.core.accounts.createResetLink(h!.core.users.getByEmail('ann@example.org')!.id);
    const token = new URL(link).searchParams.get('token')!;
    const res = await s.post('/reset', { token, password: 'kurz' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('Das Passwort braucht mindestens 10 Zeichen.');
    expect(res.text).toContain(`value="${token}"`);
  });
});

describe('account page and sessions', () => {
  it('account: change name and password', async () => {
    const s = setup();
    const cookie = await s.registerVerified();
    const user = h!.core.users.getByEmail('ann@example.org')!;
    const page = await s.get('/account', cookie);
    expect(page.status).toBe(200);
    expect(page.text).toContain('action="/account/name"');
    expect(page.text).toContain('action="/account/password"');
    expect(page.text).toContain('href="/account"');
    expect(page.text).toContain('Übersicht');

    const csrf = csrfToken(h!.core, user);
    expect((await s.post('/account/name', { name: 'Anna' }, { cookie })).status).toBe(403);
    const renamed = await s.post('/account/name', { name: 'Anna', csrf }, { cookie });
    expect(renamed.status).toBe(200);
    expect(h!.core.users.get(user.id)!.name).toBe('Anna');

    const wrong = await s.post('/account/password', { current: 'not it at all', password: 'a brand new password', csrf }, { cookie });
    expect(wrong.text).toContain('Das aktuelle Passwort ist falsch.');
    expect(wrong.status).toBe(400);
    const short = await s.post('/account/password', { current: PASSWORD, password: 'kurz', csrf }, { cookie });
    expect(short.text).toContain('Das Passwort braucht mindestens 10 Zeichen.');

    const ok = await s.post('/account/password', { current: PASSWORD, password: 'a brand new password', csrf }, { cookie });
    expect(ok.status).toBe(200);
    expect(ok.text).toContain('Passwort geändert.');
    const fresh = cookieOf(ok)!;
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(cookie);
    expect((await s.get('/account', fresh)).status).toBe(200);
    expect((await s.post('/login', { email: 'ann@example.org', password: 'a brand new password' })).status).toBe(302);
  });

  it('password change ends other sessions', async () => {
    const s = setup();
    const first = await s.registerVerified();
    const second = await h!.login('ann@example.org', PASSWORD);
    const user = h!.core.users.getByEmail('ann@example.org')!;
    expect((await s.get('/', second)).status).toBe(200);
    await s.post('/account/password', { current: PASSWORD, password: 'a brand new password', csrf: csrfToken(h!.core, user) }, { cookie: first });
    const after = await s.get('/', second);
    expect(after.status).toBe(302);
    expect(after.headers.location).toContain('/login');
  });

  it('logout ends every session', async () => {
    const s = setup();
    const first = await s.registerVerified();
    const second = await h!.login('ann@example.org', PASSWORD);
    const user = h!.core.users.getByEmail('ann@example.org')!;
    const out = await s.post('/logout', { csrf: csrfToken(h!.core, user) }, { cookie: first });
    expect(out.status).toBe(302);
    for (const c of [first, second]) {
      const res = await s.get('/', c);
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('/login');
    }
  });

  it('a session without an epoch is rejected', async () => {
    const s = setup();
    const { signToken } = await import('../src/http/tokens.js');
    const user = h!.core.users.getByEmail('admin@x.y')!;
    const legacy = `lager_session=${signToken({ uid: user.id }, 'test-secret', 60)}`;
    expect((await s.get('/', legacy)).status).toBe(302);
    const current = `lager_session=${signToken({ uid: user.id, ep: user.sessionEpoch }, 'test-secret', 60)}`;
    expect((await s.get('/', current)).status).toBe(200);
  });

  it('login page links', async () => {
    let s = setup({ mode: 'open' });
    const open = (await s.get('/login')).text;
    expect(open).toContain('Passwort vergessen?');
    expect(open).toContain('Konto erstellen');
    h!.core.close();
    s = setup({ mode: 'closed' });
    const closed = (await s.get('/login')).text;
    expect(closed).toContain('Passwort vergessen?');
    expect(closed).not.toContain('Konto erstellen');
  });
});

describe('RateLimiter', () => {
  it('allows the budget, refuses beyond it, forgets after the window and on reset', () => {
    const l = new RateLimiter(2, 1000);
    expect([l.hit('a'), l.hit('a'), l.hit('a'), l.hit('b')]).toEqual([true, true, false, true]);
    l.reset('a');
    expect(l.hit('a')).toBe(true);
    vi.useFakeTimers();
    try {
      const w = new RateLimiter(1, 1000);
      expect(w.hit('k')).toBe(true);
      expect(w.hit('k')).toBe(false);
      vi.advanceTimersByTime(1001);
      expect(w.hit('k')).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('caps the number of tracked keys', () => {
    const l = new RateLimiter(1, 60_000, 3);
    for (const k of ['a', 'b', 'c', 'd']) l.hit(k);
    expect(l.hit('a')).toBe(true); // oldest key was evicted
    expect(l.hit('d')).toBe(false);
  });
});
