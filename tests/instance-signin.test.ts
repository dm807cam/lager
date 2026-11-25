import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { LOCALES, t } from '../src/i18n/index.js';
import { esc } from '../src/http/pages.js';
import { csrfToken } from '../src/http/session.js';
import { makeHarness, NONCE, NONCE_COOKIE, type Harness } from './support/http.js';

let h: Harness | undefined;
afterEach(() => { h?.core.close(); h = undefined; });

const W = 'workout.apps.localhost';
const PW = 'visitor-password-1';
const HTML = '<html><head></head><body>v1</body></html>';

function setup(opts: { visibility?: 'private' | 'users' | 'public'; caps?: object } = {}) {
  h = makeHarness();
  const hh = h;
  const r = hh.core.apps.deploy({ slug: 'workout', title: 'Workout <b>', html: HTML, userId: hh.adminId, capabilities: opts.caps ?? { user: {} } });
  const inst = hh.core.apps.setVisibility(r.instances[0].id, opts.visibility ?? 'public', hh.adminId);
  const visitor = hh.core.users.create({ email: 'v@x.y', name: 'Vera', password: PW, role: 'user' });
  const ask = (cookie: string, query: Record<string, string> = {}) =>
    request(hh.app).get('/auth/instance').query({ slug: 'workout', return: '/', n: NONCE, ...query }).set('Host', hh.host).set('Cookie', cookie);
  const fieldsOf = (html: string): Record<string, string> =>
    Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2]]));
  const answer = (cookie: string, body: Record<string, string>) =>
    request(hh.app).post('/auth/instance').set('Host', hh.host).set('Cookie', cookie).type('form').send(body);
  const confirmations = (): Array<{ user_id: string; email: number }> => {
    const db = new DatabaseSync(path.join(hh.core.config.dataDir, 'platform.sqlite'));
    const rows = db.prepare('SELECT user_id, email FROM instance_signins').all() as unknown as Array<{ user_id: string; email: number }>;
    db.close();
    return rows.map((row) => ({ ...row }));
  };
  return { h: hh, app: r.app, inst, visitor, ask, fieldsOf, answer, confirmations };
}

describe('the question before the first sign-in to an instance', () => {
  it('asks a visitor who comes through the visibility alone, and issues no code before the answer', async () => {
    const s = setup();
    const cookie = await s.h.login('v@x.y', PW);
    const res = await s.ask(cookie);
    expect(res.status).toBe(200);
    expect(res.headers.location).toBeUndefined();
    expect(res.text).not.toContain('code=');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-frame-options']).toBe('DENY');
    // App title, host and the visitor's name are named (and escaped); the page says what the app will see.
    expect(res.text).toContain(esc(t('en', 'signin.text', { app: 'Workout <b>', host: 'workout.apps.localhost:8080', user: 'Vera' })));
    expect(res.text).not.toContain('Workout <b>');
    expect(res.text).toContain(t('en', 'signin.sees.name'));
    expect(res.text).not.toContain(t('en', 'signin.sees.email'));
    // Both answers are real buttons of one form; Cancel comes first, so Enter never continues.
    expect(res.text).toMatch(/<form method="post" action="\/auth\/instance">[\s\S]*value="cancel"[\s\S]*value="continue"[\s\S]*<\/form>/);
    expect(s.confirmations()).toEqual([]);
  });

  it('the page lets its form end on the platform and on this instance, and nowhere else', async () => {
    const s = setup();
    const cookie = await s.h.login('v@x.y', PW);
    const policyOf = (html: string): string => /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)![1];
    const page = await s.ask(cookie);
    expect(policyOf(page.text)).toMatch(/; form-action 'self' http:\/\/workout\.apps\.localhost:8080$/);
    // Continue and Cancel both leave the platform for exactly that origin, which a browser checks against the policy.
    const fields = s.fieldsOf(page.text);
    for (const decision of ['cancel', 'continue']) {
      const res = await s.answer(cookie, { ...fields, decision });
      expect(res.status, decision).toBe(302);
      expect(new URL(res.headers.location).origin, decision).toBe('http://workout.apps.localhost:8080');
    }
    // On a custom domain the page names that domain instead.
    s.h.core.domains.add(s.inst, 'workout.example.org', s.h.core.users.get(s.h.adminId)!, true);
    const other = s.h.core.users.create({ email: 'w@x.y', name: 'Wim', password: PW, role: 'user' });
    const custom = await s.ask(await s.h.login(other.email, PW), { host: 'workout.example.org' });
    expect(policyOf(custom.text)).toMatch(/; form-action 'self' http:\/\/workout\.example\.org:8080$/);
    const sent = await s.answer(await s.h.login(other.email, PW), { ...s.fieldsOf(custom.text), decision: 'continue' });
    expect(new URL(sent.headers.location).origin).toBe('http://workout.example.org:8080');
  });

  it('continue signs in and is remembered: the question comes once per instance', async () => {
    const s = setup();
    const cookie = await s.h.login('v@x.y', PW);
    const page = await s.ask(cookie);
    const go = await s.answer(cookie, { ...s.fieldsOf(page.text), decision: 'continue' });
    expect(go.status).toBe(302);
    const loc = new URL(go.headers.location);
    expect(loc.host).toBe('workout.apps.localhost:8080');
    expect(loc.pathname).toBe('/__lager/callback');
    // The code carries the nonce the instance started with, so the callback accepts it.
    const cb = await request(s.h.app).get(loc.pathname + loc.search).set('Host', loc.host).set('Cookie', NONCE_COOKIE);
    expect(cb.status).toBe(302);
    const inst = ([] as string[]).concat(cb.headers['set-cookie']).find((c) => c.startsWith('lager_inst='))!.split(';')[0];
    const session = await request(s.h.app).get('/__lager/session').set('Host', W).set('Cookie', inst);
    expect(session.body.viewer).toMatchObject({ id: s.visitor.id, name: 'Vera', email: null });
    expect(s.confirmations()).toEqual([{ user_id: s.visitor.id, email: 0 }]);
    // The next sign-in goes straight through.
    const again = await s.ask(cookie);
    expect(again.status).toBe(302);
    expect(again.headers.location).toContain('/__lager/callback?code=');
    // Another instance asks for itself.
    const other = s.h.core.apps.deploy({ slug: 'other', html: HTML, userId: s.h.adminId });
    s.h.core.apps.setVisibility(other.instances[0].id, 'users', s.h.adminId);
    expect((await s.ask(cookie, { slug: 'other' })).status).toBe(200);
  });

  it('only the owner of the instance and those who maintain its app are not asked; a share does not answer for the visitor', async () => {
    const s = setup({ visibility: 'private' });
    const { core } = s.h;
    const admin = core.users.get(s.h.adminId)!;
    const mk = (name: string, role: 'user' | 'publisher' = 'user') => core.users.create({ email: `${name}@x.y`, name, password: PW, role });
    const granted = mk('granted');
    const viaGroup = mk('viagroup');
    const collaborator = mk('collab', 'publisher');
    const instanceOwner = mk('instowner');
    core.access.setGrant(s.inst, 'user', granted.id, 'view', admin);
    const team = core.groups.create('Team');
    core.groups.addMember(team.id, viaGroup.id);
    core.access.setGrant(s.inst, 'group', team.id, 'view', admin);
    core.apps.addCollaborator(s.app.id, collaborator.id, s.h.adminId);
    core.access.setGrant(s.inst, 'user', collaborator.id, 'view', admin);
    // A second instance of the app that belongs to somebody else: its owner is not asked there.
    core.apps.createInstance({ appId: s.app.id, slug: 'theirs', ownerId: instanceOwner.id, createdBy: s.h.adminId });
    for (const [email, slug] of [['admin@x.y', 'workout'], ['collab@x.y', 'workout'], ['instowner@x.y', 'theirs']] as const) {
      const cookie = email === 'admin@x.y' ? await s.h.login() : await s.h.login(email, PW);
      const res = await s.ask(cookie, { slug });
      expect(res.status, `${email} ${slug}`).toBe(302);
      expect(res.headers.location, `${email} ${slug}`).toContain('/__lager/callback?code=');
    }
    expect(s.confirmations()).toEqual([]);
    // A publisher who shares his app with somebody's address, or with a group, has not asked that person: they are asked, once.
    for (const email of ['granted@x.y', 'viagroup@x.y']) {
      const cookie = await s.h.login(email, PW);
      const page = await s.ask(cookie);
      expect(page.status, email).toBe(200);
      expect(page.headers.location, email).toBeUndefined();
      expect(page.text).toContain(t('en', 'signin.sees.name'));
      expect((await s.answer(cookie, { ...s.fieldsOf(page.text), decision: 'continue' })).status).toBe(302);
      expect((await s.ask(cookie)).status, email).toBe(302);
    }
    expect(s.confirmations().map((c) => c.user_id).sort()).toEqual([granted.id, viaGroup.id].sort());
    // Until they have agreed to it, the instance does not get a grantee's address either.
    core.apps.deploy({ slug: 'workout', html: HTML, userId: s.h.adminId, capabilities: { user: { scopes: ['email'] } } });
    const owner = await s.h.enter('workout', await s.h.login());
    const profiles = (await request(s.h.app).get('/__lager/users').query({ ids: `${granted.id},${s.h.adminId}` }).set('Host', W).set('Cookie', owner)).body.profiles;
    expect(profiles[granted.id]).toMatchObject({ name: 'granted', email: null });
    expect(profiles[s.h.adminId]).toMatchObject({ email: 'admin@x.y' });
  });

  it('cancel signs nobody in: back to a public instance, which works without a sign-in, else to the platform', async () => {
    const s = setup({ visibility: 'public' });
    const cookie = await s.h.login('v@x.y', PW);
    const page = await s.ask(cookie);
    const no = await s.answer(cookie, { ...s.fieldsOf(page.text), decision: 'cancel' });
    expect(no.status).toBe(302);
    expect(no.headers.location).toBe('http://workout.apps.localhost:8080/');
    expect(no.headers.location).not.toContain('code=');
    // The instance serves the anonymous visitor instead of sending the browser back to the question.
    const open = await request(s.h.app).get('/').set('Host', W);
    expect(open.status).toBe(200);
    expect(s.confirmations()).toEqual([]);
    expect((await s.ask(cookie)).status).toBe(200);
    // An instance for signed-in users would redirect an anonymous browser straight back here: cancel leads to the platform instead.
    s.h.core.apps.setVisibility(s.inst.id, 'users', s.h.adminId);
    const page2 = await s.ask(cookie);
    const no2 = await s.answer(cookie, { ...s.fieldsOf(page2.text), decision: 'cancel' });
    expect(no2.headers.location).toBe('/');
    // Anything but an explicit "continue" is a cancel.
    const none = await s.answer(cookie, s.fieldsOf(page2.text));
    expect(none.headers.location).toBe('/');
    expect(s.confirmations()).toEqual([]);
  });

  it('refuses an answer without the form token, with a foreign one or with one from before a sign-out', async () => {
    const s = setup();
    const cookie = await s.h.login('v@x.y', PW);
    const fields = s.fieldsOf((await s.ask(cookie)).text);
    const adminCookie = await s.h.login();
    for (const csrf of ['', 'nonsense']) {
      const res = await s.answer(cookie, { ...fields, csrf, decision: 'continue' });
      expect(res.status, csrf).toBe(403);
      expect(res.headers.location).toBeUndefined();
    }
    // The administrator's token does not answer for the visitor.
    const adminPage = await request(s.h.app).get('/account').set('Host', s.h.host).set('Cookie', adminCookie);
    const adminCsrf = /name="csrf" value="([^"]+)"/.exec(adminPage.text)![1];
    expect((await s.answer(cookie, { ...fields, csrf: adminCsrf, decision: 'continue' })).status).toBe(403);
    // A sign-out ends the epoch the token was made in.
    s.h.core.users.bumpEpoch(s.visitor.id);
    const fresh = await s.h.login('v@x.y', PW);
    expect((await s.answer(fresh, { ...fields, decision: 'continue' })).status).toBe(403);
    expect(s.confirmations()).toEqual([]);
    // Without a session the answer signs nobody in either.
    const anonymous = await request(s.h.app).post('/auth/instance').set('Host', s.h.host).type('form').send({ ...fields, decision: 'continue' });
    expect(anonymous.headers.location).toBe('/login?return=%2F');
  });

  it('asks again when the app starts to ask for the email address, and keeps the address back until then', async () => {
    const s = setup({ visibility: 'users' });
    const platform = await s.h.login('v@x.y', PW);
    const inst = await s.h.enter('workout', platform);
    const viewer = async () => (await request(s.h.app).get('/__lager/session').set('Host', W).set('Cookie', inst)).body.viewer;
    expect(await viewer()).toMatchObject({ name: 'Vera', email: null });
    // A new version declares the email scope. The visitor agreed to the name only.
    s.h.core.apps.deploy({ slug: 'workout', html: HTML, userId: s.h.adminId, capabilities: { user: { scopes: ['email'] } } });
    expect(await viewer()).toMatchObject({ name: 'Vera', email: null });
    const page = await s.ask(platform);
    expect(page.status).toBe(200);
    expect(page.text).toContain(t('en', 'signin.sees.email'));
    // An answer to a page that spoke of the name only does not cover the address: the question is shown again.
    const stale = await s.answer(platform, { ...s.fieldsOf(page.text), email: '0', decision: 'continue' });
    expect(stale.status).toBe(200);
    expect(stale.text).toContain(t('en', 'signin.sees.email'));
    expect(s.confirmations()).toEqual([{ user_id: s.visitor.id, email: 0 }]);
    await s.answer(platform, { ...s.fieldsOf(page.text), decision: 'continue' });
    expect(s.confirmations()).toEqual([{ user_id: s.visitor.id, email: 1 }]);
    expect(await viewer()).toMatchObject({ name: 'Vera', email: 'v@x.y' });
    expect((await s.ask(platform)).status).toBe(302);
    // An agreement that covered the address still covers an app that stops asking for it.
    s.h.core.apps.deploy({ slug: 'workout', html: HTML, userId: s.h.adminId, capabilities: { user: {} } });
    expect((await s.ask(platform)).status).toBe(302);
    expect(s.confirmations()).toEqual([{ user_id: s.visitor.id, email: 1 }]);
  });

  it('the checks of the sign-in still come first, and a deleted instance takes its confirmations along', async () => {
    const s = setup({ visibility: 'private' });
    const cookie = await s.h.login('v@x.y', PW);
    // No access: no question, and an answer does not open the instance either.
    expect((await s.ask(cookie)).status).toBe(403);
    const csrf = /name="csrf" value="([^"]+)"/.exec((await request(s.h.app).get('/account').set('Host', s.h.host).set('Cookie', cookie)).text)![1];
    const forced = await s.answer(cookie, { csrf, slug: 'workout', n: NONCE, return: '/', decision: 'continue' });
    expect(forced.status).toBe(403);
    expect(s.confirmations()).toEqual([]);
    // A host that is not attached to the instance is refused in the answer as in the question.
    s.h.core.apps.setVisibility(s.inst.id, 'public', s.h.adminId);
    expect((await s.answer(cookie, { csrf, slug: 'workout', host: 'evil.example', decision: 'continue' })).status).toBe(400);
    const ok = await s.answer(cookie, { csrf, slug: 'workout', n: NONCE, return: 'https://evil.example', decision: 'continue' });
    expect(ok.headers.location).toMatch(/^http:\/\/workout\.apps\.localhost:8080\/__lager\/callback\?code=[^&]+&return=%2F$/);
    expect(s.confirmations()).toHaveLength(1);
    s.h.core.apps.deleteInstance(s.inst.id, s.h.adminId);
    expect(s.confirmations()).toEqual([]);
  });

  it('is worded in every language', async () => {
    const s = setup({ caps: { user: { scopes: ['email'] } } });
    const cookie = await s.h.login('v@x.y', PW);
    for (const locale of LOCALES) {
      s.h.core.users.setLocale(s.visitor.id, locale);
      const res = await s.ask(cookie);
      expect(res.text, locale).toContain(`<html lang="${locale}">`);
      for (const key of ['signin.sees.email', 'signin.continue', 'signin.cancel'] as const) expect(res.text, locale).toContain(esc(t(locale, key)));
      expect(res.text, locale).toContain(esc(t(locale, 'signin.heading', { app: 'Workout <b>' })));
      expect(res.text, locale).not.toMatch(/\{(app|host|user)\}/);
    }
  });
});

describe('the answer to the sign-in question, sent from an out-of-date page', () => {
  it('changes nothing, issues no code and leads home, not to the app the form names', async () => {
    const s = setup();
    const cookie = await s.h.login('v@x.y', PW);
    const fields = s.fieldsOf((await s.ask(cookie)).text);
    const res = await s.answer(cookie, { ...fields, csrf: 'stale', decision: 'continue' });
    expect(res.status).toBe(403);
    expect(res.headers.location).toBeUndefined();
    expect(res.text).not.toContain('code=');
    expect((res.headers['set-cookie'] as unknown as string[] | undefined ?? []).some((c) => c.includes('lager_inst'))).toBe(false);
    expect(/<a class="[^"]*btn[^"]*" href="([^"]+)">/.exec(res.text.slice(res.text.indexOf('<main')))![1]).toBe('/');
    expect(s.confirmations()).toEqual([]);
  });
});

describe('an app the signed-in account may not open', () => {
  it('names the account, says what to ask for, and offers another account and the home page', async () => {
    const s = setup({ visibility: 'private' });
    const cookie = await s.h.login('v@x.y', PW);
    const res = await s.ask(cookie, { return: '/today' });
    expect(res.status).toBe(403);
    const text = esc(t('en', 'noAccess.text', { email: '%' })).split('%');
    expect(res.text).toContain(`${text[0]}<strong>v@x.y</strong>${text[1]}`);
    // The owner is not named: the visitor has no right to know who it is.
    expect(res.text).not.toContain('admin@x.y');
    expect(res.text).toContain(`href="/">${t('en', 'home.title')}</a>`);
    const form = /<form method="post" action="\/logout">((?:(?!<\/form>)[\s\S])*?name="return"[\s\S]*?)<\/form>/.exec(res.text)![1];
    expect(form).toContain(t('en', 'noAccess.switch'));
    const back = /name="return" value="([^"]+)"/.exec(form)![1].replace(/&amp;/g, '&');
    expect(back).toBe(`/auth/instance?slug=workout&n=${NONCE}&return=%2Ftoday`);
  });

  it('"Use another account" signs out and, after signing in with an account that has access, ends on the app', async () => {
    const s = setup({ visibility: 'private' });
    const cookie = await s.h.login('v@x.y', PW);
    const page = (await s.ask(cookie)).text;
    const fields = Object.fromEntries([...(/<form method="post" action="\/logout">((?:(?!<\/form>)[\s\S])*?name="return"[\s\S]*?)<\/form>/.exec(page)![1]).matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2].replace(/&amp;/g, '&')]));
    const out = await request(s.h.app).post('/logout').set('Host', s.h.host).set('Cookie', cookie).type('form').send(fields);
    expect(out.status).toBe(302);
    const login = new URL(out.headers.location, 'http://x');
    expect(login.pathname).toBe('/login');
    const ret = login.searchParams.get('return')!;
    expect(ret.startsWith('/auth/instance?slug=workout')).toBe(true);
    // The old session is over.
    expect((await s.ask(cookie)).status).toBe(302);
    // The owner signs in with the same return: the sign-in goes on to the app.
    const signedIn = await request(s.h.app).post('/login').set('Host', s.h.host).type('form').send({ email: 'admin@x.y', password: 'admin-password-1', return: ret });
    expect(signedIn.headers.location).toBe(ret);
    const owner = signedIn.headers['set-cookie'] as unknown as string[];
    const onward = await request(s.h.app).get(ret).set('Host', s.h.host).set('Cookie', owner.map((c) => c.split(';')[0]).join('; '));
    expect(onward.headers.location).toMatch(/^http:\/\/workout\.apps\.localhost:8080\/__lager\/callback\?code=/);
  });

  /**
   * From the app's own address with a cookie for an account that lost its access, through "Use another account", to the app
   * signed in as the owner. Returns what each step answered.
   */
  async function switchOnAppHost(s: ReturnType<typeof setup>, host: string) {
    const inst = await s.h.enter('workout', await s.h.login('v@x.y', PW));
    s.h.core.apps.setVisibility(s.inst.id, 'private', s.h.adminId);
    const cookieOf = (res: request.Response, name: string): string =>
      (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith(`${name}=`))!.split(';')[0];
    // The app's host sends the visitor to the platform, with this browser's sign-in nonce and the host it came from.
    const onApp = await request(s.h.app).get('/').set('Host', host).set('Cookie', inst);
    const nonce = cookieOf(onApp, 'lager_nonce');
    const toPlatform = new URL(onApp.headers.location);
    // The platform names the account on its own origin and offers another one.
    const visitor = await s.h.login('v@x.y', PW);
    const noAccess = await request(s.h.app).get(toPlatform.pathname + toPlatform.search).set('Host', s.h.host).set('Cookie', visitor);
    const logout = /<form method="post" action="\/logout">((?:(?!<\/form>)[\s\S])*?name="return"[\s\S]*?)<\/form>/.exec(noAccess.text)![1];
    const fields = Object.fromEntries([...logout.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2].replace(/&amp;/g, '&')]));
    const out = await request(s.h.app).post('/logout').set('Host', s.h.host).set('Cookie', visitor).type('form').send(fields);
    const ret = new URL(out.headers.location, 'http://x').searchParams.get('return')!;
    const owner = await request(s.h.app).post('/login').set('Host', s.h.host).type('form').send({ email: 'admin@x.y', password: 'admin-password-1', return: ret });
    const ownerCookie = (owner.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    const code = new URL((await request(s.h.app).get(ret).set('Host', s.h.host).set('Cookie', ownerCookie)).headers.location);
    const callback = await request(s.h.app).get(code.pathname + code.search).set('Host', code.host).set('Cookie', nonce);
    return { onApp, toPlatform, noAccess, code, callback };
  }

  it('on the app’s own address, after the share was taken back, it sends the visitor to the platform and shows the app no address', async () => {
    const s = setup({ visibility: 'users' });
    const { onApp, toPlatform, noAccess } = await switchOnAppHost(s, W);
    // The app (no email scope here) never gets the address: the page that names the account is the platform's.
    expect(onApp.status).toBe(302);
    expect(onApp.text).not.toContain('v@x.y');
    expect(`${toPlatform.origin}${toPlatform.pathname}`).toBe('http://lager.localhost:8080/auth/instance');
    expect(toPlatform.searchParams.get('slug')).toBe('workout');
    expect(toPlatform.searchParams.get('n')).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(noAccess.status).toBe(403);
    expect(noAccess.text).toContain('<strong>v@x.y</strong>');
  });

  it('"Use another account" from the app’s own address ends on the app, signed in', async () => {
    const s = setup({ visibility: 'users' });
    const { code, callback } = await switchOnAppHost(s, W);
    expect(code.host).toBe('workout.apps.localhost:8080');
    expect(callback.status).toBe(302);
    expect((callback.headers['set-cookie'] as unknown as string[]).some((c) => c.startsWith('lager_inst='))).toBe(true);
  });

  it('the same from a custom domain comes back to that domain', async () => {
    const s = setup({ visibility: 'users' });
    s.h.core.domains.add(s.inst, 'workout.example.org', s.h.core.users.get(s.h.adminId)!, true);
    const { toPlatform, code, callback } = await switchOnAppHost(s, 'workout.example.org');
    expect(toPlatform.searchParams.get('host')).toBe('workout.example.org');
    expect(code.host).toBe('workout.example.org:8080');
    expect(callback.status).toBe(302);
    expect((callback.headers['set-cookie'] as unknown as string[]).some((c) => c.startsWith('lager_inst='))).toBe(true);
  });

  it('a sign-out sent from an out-of-date page signs nobody out and follows no way back', async () => {
    const s = setup();
    const cookie = await s.h.login('v@x.y', PW);
    const out = await request(s.h.app).post('/logout').set('Host', s.h.host).set('Cookie', cookie).type('form').send({ csrf: 'stale', return: '/auth/instance?slug=workout' });
    expect(out.headers.location ?? '').not.toContain('auth/instance');
    expect((await s.ask(cookie)).status).toBe(200);
  });

  it('a sign-out without a way back, or with one off the platform, ends at the plain sign-in', async () => {
    const s = setup();
    for (const ret of ['', '//evil.example/x', 'https://evil.example']) {
      const cookie = await s.h.login('v@x.y', PW);
      const csrf = csrfToken(s.h.core, s.h.core.users.get(s.visitor.id)!);
      const out = await request(s.h.app).post('/logout').set('Host', s.h.host).set('Cookie', cookie).type('form').send({ csrf, return: ret });
      expect(out.headers.location, ret).toBe('/login');
    }
  });
});
