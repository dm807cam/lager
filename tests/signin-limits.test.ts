import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { MAX_REGISTRATIONS_PER_HOUR } from '../src/http/auth.js';
import { addressKey } from '../src/http/client-address.js';
import { LoginLimiter } from '../src/http/platform.js';
import { csrfToken, csrfValid } from '../src/http/session.js';
import { MAX_ACCOUNT_MAILS_PER_HOUR } from '../src/platform/accounts.js';
import { MemoryMailer } from '../src/platform/mail.js';
import { t } from '../src/i18n/index.js';
import { makeHarness, type Harness } from './support/http.js';

let h: Harness | undefined;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); h?.core.close(); h = undefined; });

const PW = 'correct horse battery';
const form = (hh: Harness, path: string, ip: string, body: Record<string, string>) =>
  request(hh.app).post(path).set('Host', hh.host).set('X-Forwarded-For', ip).type('form').send(body);

describe('the key of a client address', () => {
  it('keeps IPv4, unwraps IPv4-mapped IPv6 and cuts IPv6 to its /64', () => {
    expect(addressKey('203.0.113.7')).toBe('203.0.113.7');
    expect(addressKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(addressKey('::FFFF:cb00:7107')).toBe('203.0.113.7');
    expect(addressKey('0:0:0:0:0:ffff:203.0.113.7')).toBe('203.0.113.7');
    // Every address of one /64 has one key, however it is written; the neighbouring /64 has another.
    const key = addressKey('2001:db8:1:2::1');
    expect(key).toBe('2001:db8:1:2::/64');
    for (const same of ['2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:0DB8:0001:0002:0000:0000:0000:0042', '2001:db8:1:2:a:b:c:d%eth0']) expect(addressKey(same), same).toBe(key);
    expect(addressKey('2001:db8:1:3::1')).toBe('2001:db8:1:3::/64');
    expect(addressKey('::1')).toBe('0:0:0:0::/64');
    expect(addressKey('fe80::1')).toBe('fe80:0:0:0::/64');
    for (const bad of [undefined, '', 'unknown', 'not an address', '1.2.3', '2001:db8::1::2']) expect(addressKey(bad), String(bad)).toBe('unknown');
  });

  it('sign-in: rotating addresses inside one IPv6 /64 does not buy more guesses', async () => {
    h = makeHarness({ trustProxy: 1 });
    for (let i = 0; i < 10; i++) {
      expect((await form(h, '/login', `2001:db8:aa:bb::${(i + 1).toString(16)}`, { email: `u${i}@x.y`, password: 'nope' })).status).toBe(401);
    }
    expect((await form(h, '/login', '2001:db8:aa:bb:1234:5678:9abc:def0', { email: 'other@x.y', password: 'nope' })).status).toBe(429);
    // Another /64 is another client.
    expect((await form(h, '/login', '2001:db8:aa:bc::1', { email: 'other@x.y', password: 'nope' })).status).toBe(401);
  });

  it('registration, password reset and resending count the /64 too', async () => {
    h = makeHarness({ trustProxy: 1, mailer: new MemoryMailer() });
    h.core.settings.setRegistration('open');
    for (const [path, body] of [['/register', { name: 'A', password: 'x' }], ['/forgot', {}], ['/verify/resend', {}]] as const) {
      for (let i = 0; i < 5; i++) {
        expect((await form(h, path, `2001:db8:1:1::${i + 1}`, { ...body, email: `u${i}@example.org` })).status, path).not.toBe(429);
      }
      expect((await form(h, path, '2001:db8:1:1:ffff::9', { ...body, email: 'z@example.org' })).status, path).toBe(429);
      expect((await form(h, path, '2001:db8:1:2::1', { ...body, email: 'z@example.org' })).status, path).not.toBe(429);
    }
  });
});

describe('the pause of an account under attack', () => {
  it('starts at the tenth consecutive failure, doubles with each further one and stops growing at 15 minutes', () => {
    vi.useFakeTimers();
    const l = new LoginLimiter();
    const fail = (): void => l.fail(`10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, 'a@x.y');
    for (let i = 0; i < 9; i++) fail();
    expect(l.accountPaused('a@x.y')).toBe(false);
    fail();
    let pause = 30_000;
    for (let i = 0; i < 8; i++) {
      expect(l.accountPaused('a@x.y')).toBe(true);
      expect(l.accountPaused('b@x.y')).toBe(false);
      vi.advanceTimersByTime(pause - 1);
      expect(l.accountPaused('a@x.y'), `still paused after ${pause - 1} ms`).toBe(true);
      vi.advanceTimersByTime(1);
      expect(l.accountPaused('a@x.y'), `open again after ${pause} ms`).toBe(false);
      // The one guess the pause left room for fails as well.
      fail();
      pause = Math.min(pause * 2, 15 * 60_000);
    }
    expect(pause).toBe(15 * 60_000);
  });

  it('ends with a correct password, and the count starts again after 15 quiet minutes', () => {
    vi.useFakeTimers();
    const l = new LoginLimiter();
    for (let i = 0; i < 12; i++) l.fail(`10.0.0.${i}`, 'a@x.y');
    expect(l.accountPaused('a@x.y')).toBe(true);
    l.succeed('a@x.y');
    expect(l.accountPaused('a@x.y')).toBe(false);
    // Nine more failures do not pause again: the count started over.
    for (let i = 0; i < 9; i++) l.fail(`10.0.1.${i}`, 'a@x.y');
    expect(l.accountPaused('a@x.y')).toBe(false);
    // Failures that lie more than the window apart are not consecutive.
    vi.advanceTimersByTime(15 * 60_000);
    l.fail('10.0.2.1', 'a@x.y');
    expect(l.accountPaused('a@x.y')).toBe(false);
  });

  it('answers a paused account that does not exist exactly like one that does', async () => {
    h = makeHarness({ trustProxy: 1 });
    const results: string[] = [];
    for (const email of ['admin@x.y', 'nobody@x.y']) {
      for (let i = 0; i < 10; i++) await form(h, '/login', `5.6.${email.length}.${i}`, { email, password: 'nope' });
      const res = await form(h, '/login', '8.8.8.8', { email, password: 'admin-password-1' });
      expect(res.status).toBe(401);
      expect(res.text).toContain(t('en', 'login.invalid'));
      results.push(res.text);
    }
    expect(results[0]).toBe(results[1]);
  });

  it('a turned-away attempt does not stretch the pause, and a new password ends it', async () => {
    h = makeHarness({ trustProxy: 1 });
    const login = (ip: string, password: string) => form(h!, '/login', ip, { email: 'admin@x.y', password });
    for (let i = 0; i < 10; i++) await login(`5.6.7.${i}`, 'nope');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 29_000);
    // Hammering a paused account changes nothing: it opens when the 30 seconds are over.
    for (let i = 0; i < 5; i++) expect((await login(`6.6.6.${i}`, 'admin-password-1')).status).toBe(401);
    vi.setSystemTime(Date.now() + 1_000);
    expect((await login('8.8.8.8', 'admin-password-1')).status).toBe(302);
    // Paused again; the owner sets a new password (through the reset mail, for one) and is let in at once.
    for (let i = 0; i < 10; i++) await login(`5.6.8.${i}`, 'nope');
    expect((await login('8.8.4.4', 'admin-password-1')).status).toBe(401);
    await h.core.users.setPassword(h.adminId, 'a brand new password');
    expect((await login('8.8.4.4', 'a brand new password')).status).toBe(302);
  });
});

describe('hourly limits of the whole server', () => {
  it(`at most ${MAX_REGISTRATIONS_PER_HOUR} self-registrations an hour, whatever the address; invitations are exempt`, async () => {
    h = makeHarness({ trustProxy: 1 });
    h.core.settings.setRegistration('open');
    const register = (i: number, extra: Record<string, string> = {}) =>
      form(h!, '/register', `20.0.${i}.1`, { name: 'A', email: `u${i}@example.org`, password: PW, ...extra });
    // Attempts that create nothing do not use up the budget.
    for (let i = 0; i < 5; i++) expect((await form(h, '/register', `30.0.${i}.1`, { name: 'A', email: 'not-an-address', password: PW })).status).toBe(400);
    for (let i = 0; i < MAX_REGISTRATIONS_PER_HOUR; i++) expect((await register(i)).status, String(i)).toBe(302);
    const over = await register(99);
    expect(over.status).toBe(429);
    expect(over.text).toContain(t('en', 'error.tooMany.text'));
    expect(h.core.users.getByEmail('u99@example.org')).toBeNull();
    const { url } = await h.core.accounts.createInvite({ role: 'user', createdBy: h.adminId });
    expect((await register(100, { invite: new URL(url).searchParams.get('invite')! })).status).toBe(302);
    // An hour later there is room again.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 3600_000 + 1);
    expect((await register(99)).status).toBe(302);
  }, 30_000);

  it(`at most ${MAX_ACCOUNT_MAILS_PER_HOUR} verification, reset and notice mails an hour; invitations are still sent`, async () => {
    const mailer = new MemoryMailer();
    h = makeHarness({ trustProxy: 1, mailer });
    h.core.settings.setRegistration('open');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < MAX_ACCOUNT_MAILS_PER_HOUR; i++) await h.core.accounts.requestPasswordReset('admin@x.y');
    expect(mailer.sent).toHaveLength(MAX_ACCOUNT_MAILS_PER_HOUR);
    expect(h.core.accounts.mailBudgetSpent).toBe(true);
    // Whatever would send another one answers with the rate-limit page, for known and unknown addresses alike, and sends nothing.
    for (const email of ['admin@x.y', 'nobody@x.y']) {
      for (const path of ['/forgot', '/verify/resend']) {
        const res = await form(h, path, '40.0.0.1', { email });
        expect(res.status, path).toBe(429);
        expect(res.text).toContain(t('en', 'error.tooMany.title'));
      }
      expect((await form(h, '/register', '40.0.0.2', { name: 'A', email, password: PW })).status).toBe(429);
    }
    expect(h.core.users.getByEmail('nobody@x.y')).toBeNull();
    // Below the pages the mail itself is dropped as well.
    await h.core.accounts.requestPasswordReset('admin@x.y');
    h.core.accounts.noticeExistingAccount('admin@x.y');
    expect(mailer.sent).toHaveLength(MAX_ACCOUNT_MAILS_PER_HOUR);
    expect(warn).toHaveBeenCalled();
    // An invitation is the administrator's own act.
    await h.core.accounts.createInvite({ email: 'guest@example.org', role: 'user', createdBy: h.adminId });
    expect(mailer.sent).toHaveLength(MAX_ACCOUNT_MAILS_PER_HOUR + 1);
    expect(mailer.sent.at(-1)!.to).toBe('guest@example.org');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 3600_000 + 1);
    expect((await form(h, '/forgot', '40.0.0.3', { email: 'admin@x.y' })).status).toBe(200);
    expect(mailer.sent).toHaveLength(MAX_ACCOUNT_MAILS_PER_HOUR + 2);
  });
});

describe('password hashing', () => {
  it('does not hold up the process: other work runs while a password is checked or set', async () => {
    h = makeHarness();
    h.core.settings.setRegistration('open');
    for (const work of [
      () => h!.core.users.checkLogin('admin@x.y', 'admin-password-1'),
      () => h!.core.users.checkLogin('nobody@x.y', 'admin-password-1'),
      () => h!.core.users.setPassword(h!.adminId, 'another long password'),
      () => h!.core.accounts.register({ name: 'N', email: 'n@x.y', password: PW }),
    ]) {
      let ran = false;
      const pending = work();
      setImmediate(() => { ran = true; });
      await pending;
      expect(ran).toBe(true);
    }
    expect((await h.core.users.checkLogin('admin@x.y', 'another long password')).ok).toBe(true);
    expect((await h.core.users.checkLogin('n@x.y', PW)).ok).toBe(true);
  });

  it('a sign-in that was being checked while the account got disabled or a new password does not go through', async () => {
    h = makeHarness();
    const pending = h.core.users.checkLogin('admin@x.y', 'admin-password-1');
    const other = h.core.users.create({ email: 'second@x.y', name: 'S', password: PW, role: 'admin' });
    h.core.users.setDisabled(h.adminId, true);
    expect(await pending).toEqual({ ok: false, reason: 'disabled' });
    // The stored password is replaced before the check of the old one has come back.
    const racing = h.core.users.checkLogin(other.email, PW);
    const db = new DatabaseSync(path.join(h.core.config.dataDir, 'platform.sqlite'));
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run('scrypt$00$00', other.id);
    db.close();
    expect(await racing).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('form tokens', () => {
  it('die with the session epoch: sign-out and a new password end them', async () => {
    h = makeHarness();
    const user = h.core.users.get(h.adminId)!;
    const token = csrfToken(h.core, user);
    expect(csrfValid(h.core, user, token)).toBe(true);
    const cookie = await h.login();
    h.core.users.bumpEpoch(user.id);
    expect(csrfValid(h.core, h.core.users.get(user.id)!, token)).toBe(false);
    // Over HTTP: the old token is refused in the next session, a fresh one works.
    const fresh = await h.login();
    const post = (csrf: string) => request(h!.app).post('/account/name').set('Host', h!.host).set('Cookie', fresh).type('form').send({ csrf, name: 'Renamed' });
    expect((await post(token)).status).toBe(403);
    expect(h.core.users.get(user.id)!.name).not.toBe('Renamed');
    expect((await post(csrfToken(h.core, h.core.users.get(user.id)!))).status).toBe(200);
    expect(cookie).not.toBe(fresh);
  });
});

describe('plain http', () => {
  const home = (hh: Harness, cookie: string) => request(hh.app).get('/account').set('Host', hh.host).set('Cookie', cookie);

  it('a request that carries the session cookie twice is signed out and the cookies are cleared', async () => {
    h = makeHarness({ publicUrl: 'http://lager.home.lan:8080' });
    const own = await h.login();
    expect((await home(h, own)).status).toBe(200);
    // An app on a sibling host planted a session of its author's account for the parent domain.
    const attacker = h.core.users.create({ email: 'evil@x.y', name: 'Evil', password: PW, role: 'user' });
    const planted = await h.login(attacker.email, PW);
    for (const header of [`${planted}; ${own}`, `${own}; ${planted}`, `other=1;lager_session=x;  ${own}`]) {
      const res = await home(h, header);
      expect(res.status, header).toBe(302);
      expect(res.headers.location, header).toBe('/login?return=%2Faccount');
      const cleared = ([] as string[]).concat(res.headers['set-cookie']).filter((c) => c.startsWith('lager_session=;'));
      expect(cleared.some((c) => !/Domain=/i.test(c)), header).toBe(true);
      for (const domain of ['lager.home.lan', 'home.lan']) expect(cleared.some((c) => c.includes(`Domain=${domain};`)), domain).toBe(true);
    }
    // Other cookies may repeat, and one session cookie is one session.
    expect((await home(h, `lager_lang=de; lager_lang=en; ${own}`)).status).toBe(200);
  });

  it('over https the cookie name itself keeps a second one out, so nothing is checked', async () => {
    h = makeHarness({ publicUrl: 'https://lager.example.com' });
    const own = await h.login();
    expect(own.startsWith('__Host-lager_session=')).toBe(true);
    expect((await home(h, `lager_session=a; lager_session=b; ${own}`)).status).toBe(200);
  });

  it('warns once at startup when the public URL is plain http on a name other machines use', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h = makeHarness({ publicUrl: 'http://lager.home.lan:8080' });
    const said = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('plain http'));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('http://lager.home.lan:8080');
    h.core.close();
    warn.mockClear();
    for (const publicUrl of ['http://lager.localhost:8080', 'http://localhost:8080', 'http://127.0.0.1:8080', 'https://lager.example.com']) {
      h = makeHarness({ publicUrl });
      h.core.close();
    }
    h = undefined;
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('plain http'))).toEqual([]);
  });
});
