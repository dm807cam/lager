import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { adminExtension } from '../src/http/admin.js';
import { dashboardExtension } from '../src/http/dashboard.js';
import { csrfToken } from '../src/http/session.js';
import { MAX_CODES_PER_SIGN_IN } from '../src/http/two-factor.js';
import { t } from '../src/i18n/index.js';
import { MemoryMailer } from '../src/platform/mail.js';
import { base32Decode, hotp, MAX_CODE_FAILURES, RECOVERY_CODE_COUNT, timeStep } from '../src/platform/two-factor.js';
import { makeHarness, type Harness } from './support/http.js';

let h: Harness | undefined;
afterEach(() => { h?.core.close(); h = undefined; });

const ADMIN = { email: 'admin@x.y', password: 'admin-password-1' };
const USER = { email: 'ann@example.org', password: 'ann-password-1' };

const cookiesOf = (res: request.Response): string[] => ([] as string[]).concat(res.headers['set-cookie'] ?? []);
const cookieOf = (res: request.Response, name: string): string | undefined =>
  cookiesOf(res).find((c) => c.startsWith(name + '=') && !/=;|Expires=Thu, 01 Jan 1970/i.test(c))?.split(';')[0];
const cleared = (res: request.Response, name: string): boolean => cookiesOf(res).some((c) => c.startsWith(`${name}=;`));

/** The code an authenticator app shows right now, `offset` time steps away. */
const codeFor = (secret: string, offset = 0): string => hotp(base32Decode(secret)!, timeStep(Date.now()) + offset);

function setup(publicUrl?: string) {
  const mailer = new MemoryMailer();
  h = makeHarness({ mailer, extensions: [dashboardExtension, adminExtension], ...(publicUrl ? { publicUrl } : {}) });
  const core = h.core;
  const https = publicUrl?.startsWith('https:') ?? false;
  const names = {
    session: https ? '__Host-lager_session' : 'lager_session',
    pending: https ? '__Host-lager_2fa' : 'lager_2fa',
    device: https ? '__Host-lager_device' : 'lager_device',
  };
  const user = core.users.create({ email: USER.email, name: 'Ann', password: USER.password, role: 'user' });
  const post = (path: string, body: Record<string, string>, extra: { cookie?: string; origin?: string } = {}) => {
    const r = request(h!.app).post(path).set('Host', h!.host).type('form');
    if (extra.cookie) r.set('Cookie', extra.cookie);
    if (extra.origin) r.set('Origin', extra.origin);
    return r.send(body);
  };
  const get = (path: string, cookie?: string) => {
    const r = request(h!.app).get(path).set('Host', h!.host);
    return cookie ? r.set('Cookie', cookie) : r;
  };
  /** Two-step sign-in on for `userId`, straight through the platform layer; returns the secret and the recovery codes. */
  const enable = (userId = user.id): { secret: string; codes: string[] } => {
    const secret = core.twoFactor.startSetup(userId);
    // The setup is confirmed with the previous step, so that the current one is still free for the first sign-in.
    return { secret, codes: core.twoFactor.confirmSetup(userId, codeFor(secret, -1)) };
  };
  /** The password step: returns the response and the pending cookie it set, if any. */
  const password = async (creds = USER, ret?: string) => {
    const res = await post('/login', { ...creds, ...(ret ? { return: ret } : {}) });
    return { res, pending: cookieOf(res, names.pending) };
  };
  const csrf = (userId = user.id): string => csrfToken(core, core.users.get(userId)!);
  return { core, mailer, user, names, post, get, enable, password, csrf };
}

describe('signing in with two-step sign-in on', () => {
  it('the right password alone gives no session and no device cookie, only the way to the code', async () => {
    const s = setup();
    s.enable();
    const { res, pending } = await s.password();
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/login/two-factor');
    expect(cookieOf(res, s.names.session)).toBeUndefined();
    expect(cookieOf(res, s.names.device)).toBeUndefined();
    expect(pending).toBeDefined();
    expect(cookiesOf(res).find((c) => c.startsWith(s.names.pending))).toMatch(/HttpOnly/i);
    // The pending cookie is not a session: the dashboard still sends the browser to sign in.
    const home = await s.get('/', pending);
    expect(home.status).toBe(302);
    expect(home.headers.location).toMatch(/^\/login/);
    const form = await s.get('/login/two-factor', pending);
    expect(form.status).toBe(200);
    expect(form.headers['cache-control']).toBe('no-store');
    expect(form.text).toContain(t('en', 'login.twoFactor.text'));
    expect(form.text).toContain('autocomplete="one-time-code"');
  });

  it('a wrong password never reaches the second step', async () => {
    const s = setup();
    s.enable();
    const { res, pending } = await s.password({ ...USER, password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(pending).toBeUndefined();
  });

  it('the right code finishes the sign-in, at the page it started from, and only once', async () => {
    const s = setup();
    const { secret } = s.enable();
    const { pending } = await s.password(USER, '/account');
    const done = await s.post('/login/two-factor', { code: codeFor(secret) }, { cookie: pending });
    expect(done.status).toBe(302);
    expect(done.headers.location).toBe('/account');
    const session = cookieOf(done, s.names.session)!;
    expect(session).toBeDefined();
    expect(cookieOf(done, s.names.device)).toBeDefined();
    expect(cleared(done, s.names.pending)).toBe(true);
    expect((await s.get('/account', session)).status).toBe(200);
    // The same pending cookie cannot be finished a second time, even with another valid code.
    const again = await s.post('/login/two-factor', { code: codeFor(secret, 1) }, { cookie: pending });
    expect(again.status).toBe(401);
    expect(cookieOf(again, s.names.session)).toBeUndefined();
  });

  it('a used code is not accepted again, not even on a new sign-in', async () => {
    const s = setup();
    const { secret } = s.enable();
    const code = codeFor(secret);
    const first = await s.password();
    expect((await s.post('/login/two-factor', { code }, { cookie: first.pending })).status).toBe(302);
    const second = await s.password();
    const replay = await s.post('/login/two-factor', { code }, { cookie: second.pending });
    expect(replay.status).toBe(401);
    expect(replay.text).toContain(t('en', 'twoFactor.wrong'));
    expect(cookieOf(replay, s.names.session)).toBeUndefined();
  });

  it('a return address that leads off the platform is not followed', async () => {
    const s = setup();
    const { secret } = s.enable();
    const { pending } = await s.password(USER, 'https://evil.example/steal');
    const done = await s.post('/login/two-factor', { code: codeFor(secret) }, { cookie: pending });
    expect(done.headers.location).toBe('/');
  });

  it('a recovery code signs in once and tells the owner by mail', async () => {
    const s = setup();
    const { codes } = s.enable();
    const { pending } = await s.password();
    const done = await s.post('/login/two-factor', { code: codes[0].toLowerCase() }, { cookie: pending });
    expect(cookieOf(done, s.names.session)).toBeDefined();
    await new Promise((r) => setImmediate(r));
    const mail = s.mailer.sent.find((m) => m.subject === t('en', 'mail.twoFactor.recovery.subject'))!;
    expect(mail.to).toBe(USER.email);
    expect(mail.text).toContain(String(RECOVERY_CODE_COUNT - 1));
    const again = await s.password();
    expect((await s.post('/login/two-factor', { code: codes[0] }, { cookie: again.pending })).status).toBe(401);
  });

  it(`after ${MAX_CODES_PER_SIGN_IN} wrong codes the password has to be entered again`, async () => {
    const s = setup();
    const { secret } = s.enable();
    const { pending } = await s.password();
    for (let i = 1; i < MAX_CODES_PER_SIGN_IN; i++) {
      const wrong = await s.post('/login/two-factor', { code: '000000' }, { cookie: pending });
      expect(wrong.status).toBe(401);
      expect(wrong.text).toContain(t('en', 'twoFactor.wrong'));
    }
    const last = await s.post('/login/two-factor', { code: '000000' }, { cookie: pending });
    expect(last.text).toContain(t('en', 'login.twoFactor.again'));
    expect(cleared(last, s.names.pending)).toBe(true);
    const late = await s.post('/login/two-factor', { code: codeFor(secret) }, { cookie: pending });
    expect(cookieOf(late, s.names.session)).toBeUndefined();
  });

  it('wrong codes from many sign-ins pause the account for everyone and warn its owner', async () => {
    const s = setup();
    const { secret } = s.enable();
    let tried = 0;
    let res: request.Response | undefined;
    while (tried < MAX_CODE_FAILURES) {
      const { pending } = await s.password();
      for (let i = 0; i < MAX_CODES_PER_SIGN_IN - 1 && tried < MAX_CODE_FAILURES; i++, tried++) {
        res = await s.post('/login/two-factor', { code: '000000' }, { cookie: pending });
      }
    }
    expect(res!.status).toBe(429);
    expect(res!.text).toContain(t('en', 'twoFactor.locked', { minutes: 1 }));
    await new Promise((r) => setImmediate(r));
    expect(s.mailer.sent.filter((m) => m.subject === t('en', 'mail.twoFactor.locked.subject'))).toHaveLength(1);
    // A fresh sign-in with the right code is turned away as well while the pause lasts.
    const { pending } = await s.password();
    const right = await s.post('/login/two-factor', { code: codeFor(secret) }, { cookie: pending });
    expect(right.status).toBe(429);
    expect(cookieOf(right, s.names.session)).toBeUndefined();
  });

  it('refuses a code posted from another origin, such as an app on this server', async () => {
    const s = setup();
    const { secret } = s.enable();
    const { pending } = await s.password();
    const res = await s.post('/login/two-factor', { code: codeFor(secret) }, { cookie: pending, origin: 'http://notes.apps.localhost:8080' });
    expect(res.status).toBe(403);
    expect(cookieOf(res, s.names.session)).toBeUndefined();
    // Nothing was spent: the same code still works from the platform's own page.
    expect(cookieOf(await s.post('/login/two-factor', { code: codeFor(secret) }, { cookie: pending }), s.names.session)).toBeDefined();
  });

  it('a pending sign-in dies with a new password, a sign-out everywhere and a disabled account', async () => {
    const s = setup();
    const { secret } = s.enable();
    const NEW_PASSWORD = 'another-password-1';
    for (const [current, end] of [
      [USER.password, () => s.core.users.setPassword(s.user.id, NEW_PASSWORD)],
      [NEW_PASSWORD, () => s.core.users.bumpEpoch(s.user.id)],
      [NEW_PASSWORD, () => s.core.users.setDisabled(s.user.id, true)],
    ] as const) {
      const { pending } = await s.password({ email: USER.email, password: current });
      expect(pending).toBeDefined();
      await end();
      const res = await s.post('/login/two-factor', { code: codeFor(secret, 1) }, { cookie: pending });
      expect(res.status).toBe(401);
      expect(res.text).toContain(t('en', 'login.twoFactor.expired'));
      expect(cookieOf(res, s.names.session)).toBeUndefined();
      expect((await s.get('/login/two-factor', pending)).headers.location).toBe('/login');
    }
  });

  it('a pending cookie that arrives twice counts as none', async () => {
    const s = setup();
    const { secret } = s.enable();
    const { pending } = await s.password();
    const res = await s.post('/login/two-factor', { code: codeFor(secret) }, { cookie: `${pending}; ${pending}` });
    expect(res.status).toBe(401);
    expect(cookieOf(res, s.names.session)).toBeUndefined();
  });

  it('a forged or foreign pending cookie is refused', async () => {
    const s = setup();
    s.enable();
    for (const cookie of [`${s.names.pending}=x.y`, `${s.names.pending}=${s.csrf()}`]) {
      expect((await s.post('/login/two-factor', { code: '123456' }, { cookie })).status).toBe(401);
    }
  });

  it('accounts without two-step sign-in sign in as before', async () => {
    const s = setup();
    const { res, pending } = await s.password();
    expect(res.status).toBe(302);
    expect(pending).toBeUndefined();
    expect(cookieOf(res, s.names.session)).toBeDefined();
  });

  it('uses a __Host- cookie over https', async () => {
    const s = setup('https://lager.localhost');
    const { secret } = s.enable();
    const { res, pending } = await s.password();
    expect(pending?.startsWith('__Host-lager_2fa=')).toBe(true);
    expect(cookiesOf(res).find((c) => c.startsWith('__Host-lager_2fa='))).toMatch(/Secure/i);
    const done = await s.post('/login/two-factor', { code: codeFor(secret) }, { cookie: pending });
    expect(cookieOf(done, '__Host-lager_session')).toBeDefined();
  });
});

describe('the account page', () => {
  /** Signed in as Ann without two-step sign-in. */
  const signedIn = async (_s: ReturnType<typeof setup>): Promise<string> => h!.login(USER.email, USER.password);

  it('setting up asks for the password, shows the key, and turns on only with a code from it', async () => {
    const s = setup();
    const cookie = await signedIn(s);
    const account = await s.get('/account', cookie);
    expect(account.text).toContain('action="/account/two-factor/setup"');
    const refused = await s.post('/account/two-factor/setup', { csrf: s.csrf(), current: 'wrong-password' }, { cookie });
    expect(refused.status).toBe(400);
    expect(s.core.twoFactor.pendingSecret(s.user.id)).toBeNull();
    const shown = await s.post('/account/two-factor/setup', { csrf: s.csrf(), current: USER.password }, { cookie });
    expect(shown.status).toBe(200);
    expect(shown.headers['cache-control']).toBe('no-store');
    const uri = /href="(otpauth:\/\/[^"]+)"/.exec(shown.text)![1].replace(/&amp;/g, '&');
    const secret = new URL(uri).searchParams.get('secret')!;
    expect(secret).toBe(s.core.twoFactor.pendingSecret(s.user.id));
    expect(new URL(uri).searchParams.get('issuer')).toBe('Lager (lager.localhost:8080)');
    const wrong = await s.post('/account/two-factor/confirm', { csrf: s.csrf(), code: '000000' }, { cookie });
    expect(wrong.status).toBe(400);
    expect(s.core.twoFactor.isEnabled(s.user.id)).toBe(false);
    const done = await s.post('/account/two-factor/confirm', { csrf: s.csrf(), code: codeFor(secret) }, { cookie });
    expect(done.status).toBe(200);
    expect(s.core.twoFactor.isEnabled(s.user.id)).toBe(true);
    const codes = [...done.text.matchAll(/<li><code>([A-Z2-7-]{14})<\/code><\/li>/g)].map((m) => m[1]);
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    // The browser that turned it on keeps a fresh session; the one from before is over.
    const fresh = cookieOf(done, s.names.session)!;
    expect((await s.get('/account', fresh)).status).toBe(200);
    expect((await s.get('/account', cookie)).status).toBe(302);
    await new Promise((r) => setImmediate(r));
    expect(s.mailer.sent.map((m) => m.subject)).toContain(t('en', 'mail.twoFactor.enabled.subject'));
  });

  it('turning it on signs out other browsers and connected assistants', async () => {
    const s = setup();
    const other = await signedIn(s);
    const cookie = await signedIn(s);
    const secret = s.core.twoFactor.startSetup(s.user.id);
    const done = await s.post('/account/two-factor/confirm', { csrf: s.csrf(), code: codeFor(secret) }, { cookie });
    expect(done.status).toBe(200);
    expect((await s.get('/account', other)).status).toBe(302);
  });

  it('a form without its token changes nothing', async () => {
    const s = setup();
    const cookie = await signedIn(s);
    const res = await s.post('/account/two-factor/setup', { current: USER.password }, { cookie });
    expect(res.status).toBe(403);
    expect(s.core.twoFactor.pendingSecret(s.user.id)).toBeNull();
  });

  it('turning it off needs the password and a code, and tells the owner by mail', async () => {
    const s = setup();
    const { secret } = s.enable();
    const { pending } = await s.password();
    const cookie = cookieOf(await s.post('/login/two-factor', { code: codeFor(secret) }, { cookie: pending }), s.names.session)!;
    const page = await s.get('/account', cookie);
    expect(page.text).toContain('action="/account/two-factor/disable"');
    expect(page.text).toContain(t('en', 'account.twoFactor.recoveryLeft', { count: RECOVERY_CODE_COUNT, total: RECOVERY_CODE_COUNT }));
    // A session and the password are not enough.
    const noCode = await s.post('/account/two-factor/disable', { csrf: s.csrf(), current: USER.password, code: '000000' }, { cookie });
    expect(noCode.status).toBe(400);
    expect(s.core.twoFactor.isEnabled(s.user.id)).toBe(true);
    const noPassword = await s.post('/account/two-factor/disable', { csrf: s.csrf(), current: 'wrong-password', code: codeFor(secret, 1) }, { cookie });
    expect(noPassword.status).toBe(400);
    expect(s.core.twoFactor.isEnabled(s.user.id)).toBe(true);
    const off = await s.post('/account/two-factor/disable', { csrf: s.csrf(), current: USER.password, code: codeFor(secret, 1) }, { cookie });
    expect(off.status).toBe(200);
    expect(off.text).toContain(t('en', 'account.twoFactor.disabled'));
    expect(s.core.twoFactor.isEnabled(s.user.id)).toBe(false);
    await new Promise((r) => setImmediate(r));
    expect(s.mailer.sent.map((m) => m.subject)).toContain(t('en', 'mail.twoFactor.disabled.subject'));
    // Signing in needs only the password again.
    expect(cookieOf((await s.password()).res, s.names.session)).toBeDefined();
  });

  it('new recovery codes need the password and a code, and replace the old ones', async () => {
    const s = setup();
    const { secret, codes } = s.enable();
    const { pending } = await s.password();
    const cookie = cookieOf(await s.post('/login/two-factor', { code: codeFor(secret) }, { cookie: pending }), s.names.session)!;
    const res = await s.post('/account/two-factor/recovery', { csrf: s.csrf(), current: USER.password, code: codes[0] }, { cookie });
    expect(res.status).toBe(200);
    const fresh = [...res.text.matchAll(/<li><code>([A-Z2-7-]{14})<\/code><\/li>/g)].map((m) => m[1]);
    expect(fresh).toHaveLength(RECOVERY_CODE_COUNT);
    expect(s.core.twoFactor.check(s.user.id, codes[1]).ok).toBe(false);
    expect(s.core.twoFactor.check(s.user.id, fresh[0]).ok).toBe(true);
  });
});

describe('administrators', () => {
  it('can turn off the second step of someone who lost it, which signs them out and tells them', async () => {
    const s = setup();
    const { secret } = s.enable();
    const { pending } = await s.password();
    const annSession = cookieOf(await s.post('/login/two-factor', { code: codeFor(secret) }, { cookie: pending }), s.names.session)!;
    const admin = await h!.login(ADMIN.email, ADMIN.password);
    const list = await s.get('/admin/users', admin);
    expect(list.text).toContain(`action="/admin/users/${s.user.id}/two-factor/reset"`);
    const res = await s.post(`/admin/users/${s.user.id}/two-factor/reset`, { csrf: s.csrf(h!.adminId) }, { cookie: admin });
    expect(res.status).toBe(200);
    expect(res.text).toContain(t('en', 'admin.users.twoFactorResetDone', { email: USER.email }));
    expect(s.core.twoFactor.isEnabled(s.user.id)).toBe(false);
    expect((await s.get('/account', annSession)).status).toBe(302);
    await new Promise((r) => setImmediate(r));
    expect(s.mailer.sent.find((m) => m.subject === t('en', 'mail.twoFactor.reset.subject'))?.to).toBe(USER.email);
  });

  it('cannot turn off their own second step from the administration, and others cannot at all', async () => {
    const s = setup();
    const secret = s.core.twoFactor.startSetup(h!.adminId);
    s.core.twoFactor.confirmSetup(h!.adminId, codeFor(secret, -1));
    const { pending } = await s.password(ADMIN);
    const admin = cookieOf(await s.post('/login/two-factor', { code: codeFor(secret) }, { cookie: pending }), s.names.session)!;
    expect((await s.get('/admin/users', admin)).text).not.toContain(`action="/admin/users/${h!.adminId}/two-factor/reset"`);
    const self = await s.post(`/admin/users/${h!.adminId}/two-factor/reset`, { csrf: s.csrf(h!.adminId) }, { cookie: admin });
    expect(self.status).toBe(403);
    expect(s.core.twoFactor.isEnabled(h!.adminId)).toBe(true);
    // An account without the role is turned away before anything happens.
    const ann = await h!.login(USER.email, USER.password);
    const refused = await s.post(`/admin/users/${h!.adminId}/two-factor/reset`, { csrf: s.csrf() }, { cookie: ann });
    expect(refused.status).toBe(403);
    expect(s.core.twoFactor.isEnabled(h!.adminId)).toBe(true);
  });
});

describe('deleting an account', () => {
  it('takes its second factor with it', async () => {
    const s = setup();
    s.enable();
    s.core.users.setDisabled(s.user.id, true);
    s.core.removal.remove(s.user.id, s.core.users.get(h!.adminId)!, { delete: true });
    expect(s.core.twoFactor.status(s.user.id).enabled).toBe(false);
  });
});
