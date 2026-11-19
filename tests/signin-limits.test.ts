import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { MAX_REGISTRATIONS_PER_HOUR } from '../src/http/auth.js';
import { addressKey } from '../src/http/client-address.js';
import { LoginLimiter, loginLimiter } from '../src/http/platform.js';
import { csrfToken, csrfValid } from '../src/http/session.js';
import { MAX_ACCOUNT_MAILS_PER_HOUR, MAX_RESET_MAILS_PER_HOUR } from '../src/platform/accounts.js';
import { MemoryMailer } from '../src/platform/mail.js';
import { MAX_HASHES_IN_FLIGHT, MAX_HASHES_WAITING } from '../src/platform/users.js';
import { LagerError } from '../src/errors.js';
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
  it('pauses at the tenth failure in a row for a fixed time, opens for ten more attempts, and never pauses longer than five minutes', () => {
    vi.useFakeTimers();
    const l = new LoginLimiter();
    let n = 0;
    const attempt = () => l.begin(`10.${n >> 8}.${n++ & 255}.1`, 'a@x.y', false);
    for (const pause of [30_000, 60_000, 120_000, 300_000, 300_000, 300_000]) {
      // A fresh allowance: nine failures leave the account open, the tenth pauses it.
      for (let i = 0; i < 9; i++) expect(attempt()).toBeTypeOf('object');
      expect(l.accountPaused('a@x.y')).toBe(false);
      expect(attempt()).toBeTypeOf('object');
      expect(l.accountPaused('a@x.y')).toBe(true);
      expect(l.accountPaused('b@x.y')).toBe(false);
      // Attempts during the pause are turned away, are not counted and do not move its end.
      vi.advanceTimersByTime(pause - 1);
      for (let i = 0; i < 50; i++) expect(attempt()).toBe('paused');
      expect(l.accountPaused('a@x.y'), `still paused after ${pause - 1} ms`).toBe(true);
      // A browser the account knows is not paused, and its failures do not move the end either.
      for (let i = 0; i < 12; i++) expect(l.begin('10.9.9.9', 'a@x.y', true)).not.toBe('paused');
      vi.advanceTimersByTime(1);
      expect(l.accountPaused('a@x.y'), `open again after ${pause} ms`).toBe(false);
    }
  });

  it('a correct password ends pause and count; quiet time takes the next pause back a step', () => {
    vi.useFakeTimers();
    const l = new LoginLimiter();
    let n = 0;
    const fail = () => l.begin(`10.${n >> 8}.${n++ & 255}.1`, 'a@x.y', false);
    const pauseLength = (): number => {
      for (let i = 0; i < 10; i++) fail();
      let ms = 0;
      while (l.accountPaused('a@x.y')) { vi.advanceTimersByTime(1000); ms += 1000; }
      return ms;
    };
    expect(pauseLength()).toBe(30_000);
    expect(pauseLength()).toBe(60_000);
    expect(pauseLength()).toBe(120_000);
    // One quiet window after the pause: one step back. Three more: back at the start.
    vi.advanceTimersByTime(15 * 60_000);
    expect(pauseLength()).toBe(120_000);
    vi.advanceTimersByTime(3 * 15 * 60_000);
    expect(pauseLength()).toBe(30_000);
    // A released attempt with the right password clears everything, also in the middle of a pause.
    for (let i = 0; i < 9; i++) fail();
    const right = fail();
    expect(l.accountPaused('a@x.y')).toBe(true);
    l.release(right as Exclude<typeof right, string>, true);
    expect(l.accountPaused('a@x.y')).toBe(false);
    expect(pauseLength()).toBe(30_000);
    // Failures that lie more than a window apart are not in a row.
    vi.advanceTimersByTime(4 * 15 * 60_000);
    for (let i = 0; i < 9; i++) fail();
    vi.advanceTimersByTime(15 * 60_000);
    fail();
    expect(l.accountPaused('a@x.y')).toBe(false);
  });

  it('a flood of made-up names pushes out neither a pause nor the difference between a real account and a guessed name', async () => {
    h = makeHarness({ trustProxy: 1 });
    const limiter = loginLimiter(h.core);
    const check = vi.spyOn(h.core.users, 'checkLogin');
    const names = ['admin@x.y', 'nobody@x.y'];
    // Nine failures on an account that exists and on a name that does not; a third name is paused outright.
    for (const email of names) for (let i = 0; i < 9; i++) await form(h, '/login', `5.${email.length}.7.${i}`, { email, password: 'nope' });
    for (let i = 0; i < 10; i++) limiter.fail(`6.0.0.${i}`, 'paused@x.y');
    for (let i = 0; i < 10_001; i++) limiter.fail(`11.${i >> 16}.${(i >> 8) & 255}.${i & 255}`, `junk${i}@x.y`);
    // The pause outlived the flood: entries that are not paused went first.
    expect(limiter.accountPaused('paused@x.y')).toBe(true);
    // One more failure on each, then an attempt with a password: whatever the flood did to the counts, it did the same to both
    // names. Both are answered alike, and both passwords are looked at (or neither), so timing tells nothing either.
    const outcome: Array<{ status: number; text: string; checked: number; paused: boolean }> = [];
    for (const email of names) {
      await form(h, '/login', `5.${email.length}.8.1`, { email, password: 'nope' });
      check.mockClear();
      const res = await form(h, '/login', `5.${email.length}.8.2`, { email, password: 'nope again' });
      outcome.push({ status: res.status, text: res.text, checked: check.mock.calls.length, paused: limiter.accountPaused(email) });
    }
    expect(outcome[0]).toEqual(outcome[1]);
  }, 60_000);

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

  it(`mail budgets: ${MAX_ACCOUNT_MAILS_PER_HOUR} confirmation and notice mails and ${MAX_RESET_MAILS_PER_HOUR} reset mails an hour, each on its own; invitations are still sent`, async () => {
    const mailer = new MemoryMailer();
    h = makeHarness({ trustProxy: 1, mailer });
    h.core.settings.setRegistration('open');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Registration and "already registered" notices spend the account budget...
    for (let i = 0; i < MAX_ACCOUNT_MAILS_PER_HOUR; i++) h.core.accounts.noticeExistingAccount('admin@x.y');
    expect(mailer.sent).toHaveLength(MAX_ACCOUNT_MAILS_PER_HOUR);
    expect(h.core.accounts.mailBudgetSpent('account')).toBe(true);
    for (const email of ['admin@x.y', 'nobody@x.y']) {
      const resend = await form(h, '/verify/resend', '40.0.0.1', { email });
      expect(resend.status).toBe(429);
      expect(resend.text).toContain(t('en', 'error.tooMany.title'));
      expect((await form(h, '/register', '40.0.0.2', { name: 'A', email, password: PW })).status).toBe(429);
    }
    expect(h.core.users.getByEmail('nobody@x.y')).toBeNull();
    h.core.accounts.noticeExistingAccount('admin@x.y');
    expect(mailer.sent).toHaveLength(MAX_ACCOUNT_MAILS_PER_HOUR);
    expect(warn).toHaveBeenCalled();
    // ...but not the reset mails: the way back in for an owner cannot be used up through the registration form.
    expect(h.core.accounts.mailBudgetSpent('reset')).toBe(false);
    expect((await form(h, '/forgot', '40.0.0.3', { email: 'admin@x.y' })).status).toBe(200);
    expect(mailer.sent).toHaveLength(MAX_ACCOUNT_MAILS_PER_HOUR + 1);
    for (let i = 1; i < MAX_RESET_MAILS_PER_HOUR; i++) await h.core.accounts.requestPasswordReset('admin@x.y');
    expect(mailer.sent).toHaveLength(MAX_ACCOUNT_MAILS_PER_HOUR + MAX_RESET_MAILS_PER_HOUR);
    for (const email of ['admin@x.y', 'nobody@x.y']) expect((await form(h, '/forgot', '40.0.0.4', { email })).status).toBe(429);
    await h.core.accounts.requestPasswordReset('admin@x.y');
    expect(mailer.sent).toHaveLength(MAX_ACCOUNT_MAILS_PER_HOUR + MAX_RESET_MAILS_PER_HOUR);
    // An invitation is the administrator's own act.
    await h.core.accounts.createInvite({ email: 'guest@example.org', role: 'user', createdBy: h.adminId });
    expect(mailer.sent.at(-1)!.to).toBe('guest@example.org');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 3600_000 + 1);
    expect((await form(h, '/forgot', '40.0.0.5', { email: 'admin@x.y' })).status).toBe(200);
    expect(h.core.accounts.mailBudgetSpent('account')).toBe(false);
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
      // A single label is no domain a cookie can be set for: no Set-Cookie names one.
      expect(cleared.some((c) => /Domain=lan;/i.test(c)), header).toBe(false);
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

describe('attempts that arrive at the same time', () => {
  const statuses = (list: Array<{ status: number }>): Record<number, number> =>
    list.reduce<Record<number, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});

  it('60 wrong passwords at once from one address: ten are checked, the rest refused; a right one sent last does not get in', async () => {
    h = makeHarness({ trustProxy: 1 });
    const check = vi.spyOn(h.core.users, 'checkLogin');
    const burst = await Promise.all(Array.from({ length: 60 }, (_, i) =>
      form(h!, '/login', '9.9.9.9', { email: `u${i}@x.y`, password: 'nope' })));
    expect(statuses(burst)).toEqual({ 401: 10, 429: 50 });
    expect(check).toHaveBeenCalledTimes(10);
    // Another address, 59 guesses and the right password as the 60th: it is refused like the 49 before it.
    const mixed = await Promise.all(Array.from({ length: 60 }, (_, i) =>
      form(h!, '/login', '9.9.9.8', { email: i === 59 ? 'admin@x.y' : `u${i}@x.y`, password: i === 59 ? 'admin-password-1' : 'nope' })));
    expect(mixed[59].status).toBe(429);
    expect(statuses(mixed)).toEqual({ 401: 10, 429: 50 });
  });

  it('60 guesses at one account at once from 60 addresses: ten are checked, then the account is paused', async () => {
    h = makeHarness({ trustProxy: 1 });
    const check = vi.spyOn(h.core.users, 'checkLogin');
    const burst = await Promise.all(Array.from({ length: 60 }, (_, i) =>
      form(h!, '/login', `7.7.${i}.1`, { email: 'admin@x.y', password: i === 59 ? 'admin-password-1' : 'nope' })));
    expect(statuses(burst)).toEqual({ 401: 60 });
    expect(check).toHaveBeenCalledTimes(10);
  });

  it('a right password among parallel attempts gives its place back', async () => {
    h = makeHarness({ trustProxy: 1 });
    // Ten correct sign-ins at once from one address are not ten failures: an eleventh still gets in.
    const burst = await Promise.all(Array.from({ length: 10 }, () => form(h!, '/login', '9.9.9.9', { email: 'admin@x.y', password: 'admin-password-1' })));
    expect(statuses(burst)).toEqual({ 302: 10 });
    expect((await form(h, '/login', '9.9.9.9', { email: 'admin@x.y', password: 'admin-password-1' })).status).toBe(302);
  });

  it('registrations at once cannot exceed the hourly cap', async () => {
    h = makeHarness({ trustProxy: 1 });
    h.core.settings.setRegistration('open');
    const before = h.core.users.count();
    const burst = await Promise.all(Array.from({ length: 40 }, (_, i) =>
      form(h!, '/register', `20.1.${i}.1`, { name: 'A', email: `p${i}@example.org`, password: PW })));
    expect(statuses(burst)).toEqual({ 302: MAX_REGISTRATIONS_PER_HOUR, 429: 40 - MAX_REGISTRATIONS_PER_HOUR });
    expect(h.core.users.count() - before).toBe(MAX_REGISTRATIONS_PER_HOUR);
  }, 30_000);

  it('guesses at once at the password of a confirmation link: ten are checked', async () => {
    const mailer = new MemoryMailer();
    h = makeHarness({ trustProxy: 1, mailer });
    h.core.settings.setRegistration('open');
    await h.core.accounts.register({ name: 'N', email: 'n@x.y', password: PW });
    const token = new URL(/https?:\/\/\S+/.exec(mailer.sent[0].text)![0]).searchParams.get('token')!;
    const verify = vi.spyOn(h.core.accounts, 'verifyEmail');
    const burst = await Promise.all(Array.from({ length: 30 }, (_, i) => form(h!, '/verify', `8.1.${i}.1`, { token, password: `guess number ${i}` })));
    expect(statuses(burst)).toEqual({ 400: 10, 429: 20 });
    expect(verify).toHaveBeenCalledTimes(10);
  });

  it('too many password hashes at once: two run, 32 wait, the rest are told to come back, and none of them counts as a failure', async () => {
    h = makeHarness({ trustProxy: 1 });
    const all = await Promise.allSettled(Array.from({ length: MAX_HASHES_IN_FLIGHT + MAX_HASHES_WAITING + 6 }, (_, i) => h!.core.users.checkLogin(`u${i}@x.y`, 'nope')));
    const refused = all.filter((r) => r.status === 'rejected');
    expect(refused).toHaveLength(6);
    for (const r of refused) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'rate_limited', reason: 'busy' });
    expect(all.filter((r) => r.status === 'fulfilled')).toHaveLength(MAX_HASHES_IN_FLIGHT + MAX_HASHES_WAITING);
    // The queue drains: afterwards a password is checked as usual.
    expect((await h.core.users.checkLogin('admin@x.y', 'admin-password-1')).ok).toBe(true);
    // Over HTTP the busy server answers 429, and the attempt it never looked at is not held against address or account.
    const busy = vi.spyOn(h.core.users, 'checkLogin').mockRejectedValue(new LagerError('rate_limited', 'busy', 'busy'));
    for (let i = 0; i < 12; i++) expect((await form(h, '/login', '9.9.9.9', { email: 'admin@x.y', password: 'admin-password-1' })).status).toBe(429);
    busy.mockRestore();
    expect((await form(h, '/login', '9.9.9.9', { email: 'admin@x.y', password: 'admin-password-1' })).status).toBe(302);
  });
});

describe('the browser that proved control of the account is remembered', () => {
  const deviceOf = (res: request.Response): string | undefined =>
    ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('lager_device='))?.split(';')[0];
  const attack = async (hh: Harness, net: number, email = 'owner@example.org'): Promise<void> => {
    for (let i = 0; i < 10; i++) await form(hh, '/login', `5.${net}.7.${i}`, { email, password: 'nope' });
  };

  it('after a reset by mail the owner stays in although the attack goes on; an older password\'s cookie stops counting', async () => {
    const mailer = new MemoryMailer();
    h = makeHarness({ trustProxy: 1, mailer });
    const owner = h.core.users.create({ email: 'owner@example.org', name: 'O', password: PW, role: 'user' });
    await attack(h, 1);
    // A new browser, the right password: turned away while the account is paused.
    expect((await form(h, '/login', '8.8.8.8', { email: owner.email, password: PW })).status).toBe(401);
    // The way out: the reset mail. Setting the password through its link marks this browser.
    await form(h, '/forgot', '8.8.8.8', { email: owner.email });
    const token = new URL(/https?:\/\/\S+/.exec(mailer.sent.at(-1)!.text)![0]).searchParams.get('token')!;
    const reset = await form(h, '/reset', '8.8.8.8', { token, password: 'a brand new password' });
    expect(reset.status).toBe(200);
    const device = deviceOf(reset)!;
    expect(device).toBeDefined();
    expect(reset.headers['set-cookie'].join()).not.toContain('lager_session=');
    // The attacker goes on and pauses the account again: the marked browser signs in all the same, every time.
    for (const net of [2, 3]) {
      await attack(h, net);
      expect((await form(h, '/login', '8.8.4.4', { email: owner.email, password: 'a brand new password' })).status).toBe(401);
      expect((await form(h, '/login', '8.8.8.8', { email: owner.email, password: 'a brand new password' }).set('Cookie', device)).status).toBe(302);
    }
    // The password is changed elsewhere: whoever holds the cookie made under the old one is a stranger again.
    await h.core.users.setPassword(owner.id, 'yet another password');
    await attack(h, 4);
    expect((await form(h, '/login', '8.8.8.8', { email: owner.email, password: 'yet another password' }).set('Cookie', device)).status).toBe(401);
    // A sign-out alone does not end it: the cookie follows the password, not the session.
    const again = deviceOf(await form(h, '/reset', '8.8.8.8', { token: new URL(h.core.accounts.createResetLink(owner.id)).searchParams.get('token')!, password: 'the fourth password' }))!;
    h.core.users.bumpEpoch(owner.id);
    await attack(h, 5);
    expect((await form(h, '/login', '8.8.8.8', { email: owner.email, password: 'the fourth password' }).set('Cookie', again)).status).toBe(302);
  });

  it('is set by sign-in, confirmation with the password, a password change and a direct registration, never by a failure', async () => {
    const mailer = new MemoryMailer();
    h = makeHarness({ trustProxy: 1, mailer });
    h.core.settings.setRegistration('open');
    expect(deviceOf(await form(h, '/login', '1.1.1.1', { email: 'admin@x.y', password: 'nope' }))).toBeUndefined();
    const signedIn = await form(h, '/login', '1.1.1.1', { email: 'admin@x.y', password: 'admin-password-1' });
    expect(deviceOf(signedIn)).toBeDefined();
    // Registration that waits for the mail sets nothing (a taken address must look the same); the confirmation does.
    const registered = await form(h, '/register', '1.1.1.2', { name: 'N', email: 'n@example.org', password: PW });
    expect(registered.headers['set-cookie']).toBeUndefined();
    const token = new URL(/https?:\/\/\S+/.exec(mailer.sent[0].text)![0]).searchParams.get('token')!;
    expect(deviceOf(await form(h, '/verify', '1.1.1.2', { token, password: 'not the password' }))).toBeUndefined();
    expect(deviceOf(await form(h, '/verify', '1.1.1.2', { token, password: PW }))).toBeDefined();
    // Through an invitation sent to the address the account is signed in at once, and the browser marked.
    const { url } = await h.core.accounts.createInvite({ email: 'i@example.org', role: 'user', createdBy: h.adminId });
    const invited = await form(h, '/register', '1.1.1.3', { name: 'I', email: 'i@example.org', password: PW, invite: new URL(url).searchParams.get('invite')! });
    expect(invited.status).toBe(302);
    expect(deviceOf(invited)).toBeDefined();
    // A password change on the account page marks the browser under the new password.
    const session = ([] as string[]).concat(signedIn.headers['set-cookie']).find((c) => c.startsWith('lager_session='))!.split(';')[0];
    const changed = await request(h.app).post('/account/password').set('Host', h.host).set('Cookie', session).type('form')
      .send({ csrf: csrfToken(h.core, h.core.users.get(h.adminId)!), current: 'admin-password-1', password: 'a brand new password' });
    expect(changed.status).toBe(200);
    const fresh = deviceOf(changed)!;
    expect(fresh).not.toBe(deviceOf(signedIn));
    await attack(h, 9, 'admin@x.y');
    expect((await form(h, '/login', '1.1.1.9', { email: 'admin@x.y', password: 'a brand new password' }).set('Cookie', deviceOf(signedIn)!)).status).toBe(401);
    expect((await form(h, '/login', '1.1.1.9', { email: 'admin@x.y', password: 'a brand new password' }).set('Cookie', fresh)).status).toBe(302);
  });
});

describe('registration does not tell a taken address from a free one', () => {
  it('through the hourly cap: a taken address takes a place like a new account', async () => {
    const mailer = new MemoryMailer();
    h = makeHarness({ trustProxy: 1, mailer });
    h.core.settings.setRegistration('open');
    h.core.users.create({ email: 'taken@example.org', name: 'T', password: PW, role: 'user' });
    for (let i = 0; i < MAX_REGISTRATIONS_PER_HOUR; i++) {
      expect((await form(h, '/register', `21.0.${i}.1`, { name: 'A', email: 'taken@example.org', password: PW })).status).toBe(200);
    }
    // Had the taken address cost nothing, this one would still go through, and the difference would show which kind it was.
    expect((await form(h, '/register', '21.1.0.1', { name: 'A', email: 'free@example.org', password: PW })).status).toBe(429);
    expect((await form(h, '/register', '21.1.0.2', { name: 'A', email: 'taken@example.org', password: PW })).status).toBe(429);
  }, 30_000);

  it('a mail that cannot even be prepared is logged and does not end the process', async () => {
    const mailer = new MemoryMailer();
    h = makeHarness({ mailer });
    h.core.settings.setRegistration('open');
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const user = h.core.users.create({ email: 'u@example.org', name: 'U', password: PW, role: 'user', verified: false });
      // The token of the mail cannot be stored (a full disk, a locked database).
      vi.spyOn(h.core.accounts as unknown as { issue: () => never }, 'issue').mockImplementation(() => { throw new Error('database or disk is full'); });
      const { needsVerification } = await h.core.accounts.register({ name: 'N', email: 'n@example.org', password: PW });
      expect(needsVerification).toBe(true);
      await h.core.accounts.resendVerification(user.email);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(unhandled).toEqual([]);
      expect(logged).toHaveBeenCalledTimes(2);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('what must get through while guesses flood the server', () => {
  it('setting a password and a known browser go ahead of the queue of ordinary sign-ins', async () => {
    const mailer = new MemoryMailer();
    h = makeHarness({ trustProxy: 1, mailer });
    const { users, accounts } = h.core;
    const order: string[] = [];
    // The ordinary lane is full: two hashes run, 32 wait.
    const flood = Array.from({ length: MAX_HASHES_IN_FLIGHT + MAX_HASHES_WAITING }, (_, i) => users.checkLogin(`u${i}@x.y`, 'nope').then(() => { order.push('guess'); }));
    await expect(users.checkLogin('admin@x.y', 'admin-password-1')).rejects.toMatchObject({ code: 'rate_limited' });
    // The reset link (the documented way back in), a password change and a sign-in that is marked as known are still served,
    // and before the guesses that were already waiting.
    const link = new URL(accounts.createResetLink(h.adminId)).searchParams.get('token')!;
    const urgent = [
      accounts.resetPassword(link, 'a brand new password').then(() => { order.push('reset'); }),
      users.checkLogin('admin@x.y', 'admin-password-1', true).then(() => { order.push('known'); }),
      accounts.register({ name: 'N', email: 'n@x.y', password: PW, inviteToken: new URL((await accounts.createInvite({ role: 'user', createdBy: h.adminId })).url).searchParams.get('invite')! }).then(() => { order.push('register'); }),
    ];
    await Promise.all([...urgent, ...flood]);
    expect(order.slice(0, 5).filter((o) => o !== 'guess').sort()).toEqual(['known', 'register', 'reset']);
    expect(order.filter((o) => o === 'guess')).toHaveLength(MAX_HASHES_IN_FLIGHT + MAX_HASHES_WAITING);
    expect((await users.checkLogin('admin@x.y', 'a brand new password')).ok).toBe(true);
  });

  it('the sign-in route asks for priority only with the device cookie of the account, and says "busy" rather than "failed"', async () => {
    h = makeHarness({ trustProxy: 1 });
    const first = await form(h, '/login', '1.1.1.1', { email: 'admin@x.y', password: 'admin-password-1' });
    const device = ([] as string[]).concat(first.headers['set-cookie']).find((c) => c.startsWith('lager_device='))!.split(';')[0];
    const other = h.core.users.create({ email: 'o@x.y', name: 'O', password: PW, role: 'user' });
    const check = vi.spyOn(h.core.users, 'checkLogin');
    await form(h, '/login', '1.1.1.2', { email: 'admin@x.y', password: 'admin-password-1' }).set('Cookie', device);
    await form(h, '/login', '1.1.1.3', { email: 'admin@x.y', password: 'admin-password-1' });
    await form(h, '/login', '1.1.1.4', { email: other.email, password: PW }).set('Cookie', device);
    expect(check.mock.calls.map((c) => c[2])).toEqual([true, false, false]);
    check.mockRejectedValue(new LagerError('rate_limited', 'busy', 'busy'));
    const busy = await form(h, '/login', '1.1.1.5', { email: 'admin@x.y', password: 'admin-password-1' });
    expect(busy.status).toBe(429);
    expect(busy.text).toContain(t('en', 'login.busy'));
    expect(busy.text).not.toContain(t('en', 'login.tooMany'));
  });

  it('a paused account still gets its reset mail when the hourly reset mails are spent, and the form answers alike for a name without an account', async () => {
    const mailer = new MemoryMailer();
    h = makeHarness({ trustProxy: 1, mailer });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const victim = h.core.users.create({ email: 'victim@example.org', name: 'V', password: PW, role: 'user' });
    for (let i = 0; i < MAX_RESET_MAILS_PER_HOUR; i++) await h.core.accounts.requestPasswordReset('admin@x.y');
    mailer.sent.length = 0;
    const forgot = (ip: string, email: string) => form(h!, '/forgot', ip, { email });
    // Not paused: the budget holds, for a real and for a made-up address.
    const refused = [await forgot('40.1.0.1', victim.email), await forgot('40.1.0.2', 'ghost@example.org')];
    expect(refused.map((r) => r.status)).toEqual([429, 429]);
    expect(refused[0].text).toBe(refused[1].text);
    // Both names are under attack and paused.
    for (const email of [victim.email, 'ghost@example.org']) for (let i = 0; i < 10; i++) loginLimiter(h.core).fail(`41.${email.length}.0.${i}`, email);
    const answered = [await forgot('40.1.0.3', victim.email), await forgot('40.1.0.4', 'ghost@example.org')];
    expect(answered.map((r) => r.status)).toEqual([200, 200]);
    expect(answered[0].text).toBe(answered[1].text);
    expect(mailer.sent.map((m) => m.to)).toEqual([victim.email]);
    // The limit per address stays: three an hour, the fourth request is answered and sends nothing.
    for (let i = 0; i < 3; i++) expect((await forgot(`40.2.0.${i}`, victim.email)).status).toBe(200);
    expect(mailer.sent).toHaveLength(3);
    // Another account that is not paused is still held to the budget.
    expect((await forgot('40.3.0.1', 'admin@x.y')).status).toBe(429);
  });
});
