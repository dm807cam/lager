import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { adminExtension } from '../src/http/admin.js';
import { apiExtension } from '../src/http/api.js';
import { dashboardExtension } from '../src/http/dashboard.js';
import { manageExtension } from '../src/http/manage.js';
import { csrfToken } from '../src/http/session.js';
import type { User } from '../src/platform/users.js';
import { esc } from '../src/http/pages.js';
import { t, type MessageKey } from '../src/i18n/index.js';
import { makeHarness, NONCE, NONCE_COOKIE, type Harness } from './support/http.js';

const en = (key: MessageKey): string => esc(t('en', key));
let h: Harness | undefined;
afterEach(() => { h?.core.close(); h = undefined; });

const CUSTOM = 'notes.example.test';
const CUSTOM_HOST = `${CUSTOM}:8080`;
const DEFAULT_HOST = 'notes.apps.localhost:8080';

function setup() {
  h = makeHarness({ extensions: [dashboardExtension, manageExtension, adminExtension, apiExtension] });
  const hh = h;
  const pub = hh.core.users.create({ email: 'p@x.y', name: 'P', password: 'password-123', role: 'publisher' });
  const inst = hh.core.apps.deploy({ slug: 'notes', html: '<html><head></head><body>notes</body></html>', userId: pub.id }).instances[0];
  const other = hh.core.apps.deploy({ slug: 'other', html: '<p>other</p>', userId: pub.id }).instances[0];
  const admin = hh.core.users.get(hh.adminId)!;
  // The administrator manages `notes` as a grantee (not as owner), which is what the page needs; `other` stays private to the publisher.
  hh.core.access.setGrant(inst, 'user', admin.id, 'admin', pub);
  // A grantee is asked once before the first sign-in to an instance; here the administrator has answered already.
  hh.core.access.confirmSignIn(inst, admin, true);
  return { hh, pub, inst, other, admin };
}

/** Walks the handshake from a custom host: returns the cookie pair and the redirect chain. */
async function enterVia(hh: Harness, host: string, platformCookie: string) {
  const first = await request(hh.app).get('/').set('Host', host);
  const auth = await request(hh.app).get(new URL(first.headers.location).pathname + new URL(first.headers.location).search)
    .set('Host', hh.host).set('Cookie', platformCookie);
  const loc = new URL(auth.headers.location);
  const nonce = ([] as string[]).concat(first.headers['set-cookie'] ?? []).find((c) => c.startsWith('lager_nonce='))?.split(';')[0] ?? '';
  const cb = await request(hh.app).get(loc.pathname + loc.search).set('Host', loc.host).set('Cookie', nonce);
  const raw = ([] as string[]).concat(cb.headers['set-cookie'] ?? [])[0];
  return { first, auth, loc, cb, cookie: raw?.split(';')[0] ?? '', raw };
}

describe('custom domains over http', () => {
  it('unknown host → 404', async () => {
    const { hh } = setup();
    const res = await request(hh.app).get('/').set('Host', CUSTOM_HOST);
    expect(res.status).toBe(404);
  });

  it('custom host serves the instance', async () => {
    const { hh, inst, admin } = setup();
    hh.core.domains.add(inst, CUSTOM, admin, true);
    const cookie = await hh.login();
    const { cookie: inst1 } = await enterVia(hh, CUSTOM_HOST, cookie);
    const res = await request(hh.app).get('/').set('Host', CUSTOM_HOST).set('Cookie', inst1);
    expect(res.status).toBe(200);
    expect(res.text).toContain('notes');
    expect(res.text).toContain('/__lager/runtime.js');
  });

  it('sign-in from a custom host returns to that host', async () => {
    const { hh, inst, admin } = setup();
    hh.core.domains.add(inst, CUSTOM, admin, true);
    const { first, auth, loc, cb, raw, cookie } = await enterVia(hh, CUSTOM_HOST, await hh.login());
    expect(first.status).toBe(302);
    expect(first.headers.location).toMatch(new RegExp(`^http://lager\\.localhost:8080/auth/instance\\?slug=notes&host=${CUSTOM.replaceAll('.', '\\.')}&return=%2F&n=[A-Za-z0-9_-]{24}$`));
    expect(auth.status).toBe(302);
    expect(loc.origin).toBe(`http://${CUSTOM_HOST}`);
    expect(loc.pathname).toBe('/__lager/callback');
    expect(loc.searchParams.get('code')).toBeTruthy();
    expect(cb.status).toBe(302);
    expect(raw).toContain('HttpOnly');
    expect(raw).not.toMatch(/Domain=/i);
    expect(cookie.startsWith('lager_inst=')).toBe(true);
  });

  it('the redirect is built from the stored host, not the raw parameter', async () => {
    const { hh, inst, admin } = setup();
    hh.core.domains.add(inst, CUSTOM, admin, true);
    const cookie = await hh.login();
    const res = await request(hh.app).get('/auth/instance').query({ slug: 'notes', host: 'Notes.Example.TEST.', return: '/' })
      .set('Host', hh.host).set('Cookie', cookie);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.location).origin).toBe(`http://${CUSTOM_HOST}`);
  });

  it('host param not attached to the instance → 400', async () => {
    const { hh, inst, other, admin } = setup();
    hh.core.domains.add(inst, CUSTOM, admin, true);
    hh.core.domains.add(other, 'other.example.test', admin, true);
    const cookie = await hh.login();
    const get = (host: string) => request(hh.app).get('/auth/instance').query({ slug: 'notes', host }).set('Host', hh.host).set('Cookie', cookie);
    for (const host of ['other.example.test', 'evil.example.org', 'notes.apps.localhost', 'lager.localhost', 'notes.example.test@evil.org', 'notes.example.test:8080', '', 'x'.repeat(300)]) {
      const res = await get(host);
      expect(res.status, host).toBe(400);
      expect(res.headers.location).toBeUndefined();
    }
    expect((await request(hh.app).get('/auth/instance').query({ slug: 'notes', host: ['a.example.test', 'b.example.test'] })
      .set('Host', hh.host).set('Cookie', cookie)).status).toBe(400);
    // Unchanged without the parameter.
    const plain = await request(hh.app).get('/auth/instance').query({ slug: 'notes' }).set('Host', hh.host).set('Cookie', cookie);
    expect(new URL(plain.headers.location).host).toBe(DEFAULT_HOST);
  });

  it('a code issued for a custom host is still bound to the instance id and single-use', async () => {
    const { hh, inst, other, admin } = setup();
    hh.core.domains.add(inst, CUSTOM, admin, true);
    hh.core.domains.add(other, 'other.example.test', admin, true);
    const auth = await request(hh.app).get('/auth/instance').query({ slug: 'notes', host: CUSTOM, n: NONCE }).set('Host', hh.host).set('Cookie', await hh.login());
    const loc = new URL(auth.headers.location);
    const wrong = await request(hh.app).get(loc.pathname + loc.search).set('Host', 'other.example.test:8080').set('Cookie', NONCE_COOKIE);
    expect(wrong.status).toBe(400);
    expect((await request(hh.app).get(loc.pathname + loc.search).set('Host', CUSTOM_HOST).set('Cookie', NONCE_COOKIE)).status).toBe(302);
    expect((await request(hh.app).get(loc.pathname + loc.search).set('Host', CUSTOM_HOST).set('Cookie', NONCE_COOKIE)).status).toBe(400);
  });

  it('each host needs its own handshake', async () => {
    const { hh, inst, admin } = setup();
    hh.core.domains.add(inst, CUSTOM, admin, true);
    const platformCookie = await hh.login();
    const custom = await enterVia(hh, CUSTOM_HOST, platformCookie);
    // A cookie value presented on the default host is accepted by value (same signed token) only if the browser sends it; browsers do not,
    // so the default host without a cookie must still send the visitor through the handshake.
    const noCookie = await request(hh.app).get('/').set('Host', DEFAULT_HOST);
    expect(noCookie.status).toBe(302);
    expect(noCookie.headers.location).toMatch(/^http:\/\/lager\.localhost:8080\/auth\/instance\?slug=notes&return=%2F&n=[A-Za-z0-9_-]{24}$/);
    const def = await hh.enter('notes', platformCookie);
    expect((await request(hh.app).get('/').set('Host', DEFAULT_HOST).set('Cookie', def)).status).toBe(200);
    expect((await request(hh.app).get('/').set('Host', CUSTOM_HOST).set('Cookie', custom.cookie)).status).toBe(200);
    const withoutCustomCookie = await request(hh.app).get('/').set('Host', CUSTOM_HOST);
    expect(withoutCustomCookie.status).toBe(302);
    expect(withoutCustomCookie.headers.location).toContain('host=notes.example.test');
  });

  it('removing the domain stops serving it', async () => {
    const { hh, inst, admin } = setup();
    hh.core.domains.add(inst, CUSTOM, admin, true);
    const { cookie } = await enterVia(hh, CUSTOM_HOST, await hh.login());
    hh.core.domains.remove(inst, CUSTOM, admin, true);
    expect((await request(hh.app).get('/').set('Host', CUSTOM_HOST).set('Cookie', cookie)).status).toBe(404);
  });

  it('a disabled instance is not served on its custom host', async () => {
    const { hh, inst, admin } = setup();
    hh.core.domains.add(inst, CUSTOM, admin, true);
    hh.core.apps.setInstanceDisabled(inst.id, true);
    expect((await request(hh.app).get('/').set('Host', CUSTOM_HOST)).status).toBe(403);
  });
});

describe('custom domains on the management page', () => {
  const csrf = (user: User) => csrfToken(h!.core, user);
  const page = (cookie: string, path: string) => request(h!.app).get(path).set('Host', h!.host).set('Cookie', cookie);
  const post = (cookie: string, user: User, path: string, body: Record<string, string>) =>
    request(h!.app).post(path).set('Host', h!.host).set('Cookie', cookie).type('form').send({ csrf: csrf(user), ...body });

  it('shows the section only to those who may manage', async () => {
    const { hh, pub, admin } = setup();
    const pc = await hh.login('p@x.y', 'password-123');
    const ac = await hh.login();
    expect((await page(pc, '/instances/notes')).text).not.toContain(en('instance.domains.title'));
    const adminPage = await page(ac, '/instances/notes');
    expect(adminPage.text).toContain(en('instance.domains.title'));
    expect(adminPage.text).toContain(en('instance.domains.hint'));
    hh.core.settings.setCustomDomains('publishers');
    expect((await page(pc, '/instances/notes')).text).toContain(en('instance.domains.title'));
    // A grantee without manage right never sees it, and posting is refused.
    const u = hh.core.users.create({ email: 'u@x.y', name: 'U', password: 'password-123', role: 'user' });
    const uc = await hh.login('u@x.y', 'password-123');
    expect((await page(uc, '/instances/notes')).status).toBe(403);
    expect((await post(uc, u, '/ui/instances/notes/domains', { host: 'a.example.test' })).status).toBe(403);
    expect(hh.core.domains.list(hh.core.apps.getInstanceBySlug('notes')!.id)).toEqual([]);
    void pub; void admin;
  });

  it('add and remove through the page with notices', async () => {
    const { hh, inst, other, admin } = setup();
    const ac = await hh.login();
    const follow = async (res: request.Response) => { expect(res.status).toBe(302); return page(ac, res.headers.location as string); };
    const added = await follow(await post(ac, admin, '/ui/instances/notes/domains', { host: 'Notes.Example.test' }));
    expect(added.status).toBe(200);
    expect(hh.core.domains.list(inst.id)).toEqual([CUSTOM]);
    expect(added.text).toContain(`http://${CUSTOM_HOST}`);
    expect(added.text).toContain(en('common.remove'));
    expect((await follow(await post(ac, admin, '/ui/instances/notes/domains', { host: 'nonsense' }))).text).toContain(en('notice.hostInvalid'));
    hh.core.domains.add(other, 'other.example.test', admin, true);
    expect((await follow(await post(ac, admin, '/ui/instances/notes/domains', { host: 'other.example.test' }))).text).toContain(en('notice.hostTaken'));
    // The harness' own hosts end in .localhost, which is refused as a name for the local machine before it can be "unavailable".
    for (const bad of ['lager.localhost', 'x.apps.localhost', 'a.local', 'b.internal', '0x7f.0x1']) {
      expect((await follow(await post(ac, admin, '/ui/instances/notes/domains', { host: bad }))).text, bad).toContain(en('notice.hostInvalid'));
    }
    // CSRF is required.
    const noCsrf = await request(h!.app).post('/ui/instances/notes/domains/remove').set('Host', hh.host).set('Cookie', ac).type('form').send({ host: CUSTOM });
    expect(noCsrf.status).toBe(403);
    expect(hh.core.domains.list(inst.id)).toEqual([CUSTOM]);
    await follow(await post(ac, admin, '/ui/instances/notes/domains/remove', { host: CUSTOM }));
    expect(hh.core.domains.list(inst.id)).toEqual([]);
  });

  it('a publisher may add only while the setting allows it', async () => {
    const { hh, inst, pub } = setup();
    const pc = await hh.login('p@x.y', 'password-123');
    const denied = await post(pc, pub, '/ui/instances/notes/domains', { host: 'a.example.test' });
    expect(denied.status).toBe(403);
    hh.core.settings.setCustomDomains('publishers');
    expect((await post(pc, pub, '/ui/instances/notes/domains', { host: 'a.example.test' })).status).toBe(302);
    expect(hh.core.domains.list(inst.id)).toEqual(['a.example.test']);
  });

  it('admin setting switches publisher access', async () => {
    const { hh, admin } = setup();
    const ac = await hh.login();
    const form = await page(ac, '/admin/settings');
    expect(form.text).toContain(en('instance.domains.title'));
    expect(form.text).toContain(en('admin.domains.admins'));
    expect(form.text).toContain(en('admin.domains.publishers'));
    expect(hh.core.settings.customDomains).toBe('admins');
    expect((await post(ac, admin, '/admin/settings', { registration: 'open', maxInstances: '5', customDomains: 'publishers' })).status).toBe(302);
    expect(hh.core.settings.customDomains).toBe('publishers');
    // Omitting the field leaves it alone; an unknown value is refused without changing anything.
    await post(ac, admin, '/admin/settings', { registration: 'open', maxInstances: '6' });
    expect(hh.core.settings.customDomains).toBe('publishers');
    const bad = await post(ac, admin, '/admin/settings', { registration: 'open', maxInstances: '7', customDomains: 'all' });
    expect(bad.status).toBe(400);
    expect(hh.core.settings.maxInstancesPerUser).toBe(6);
    expect(hh.core.settings.customDomains).toBe('publishers');
  });
});

describe('handshake code is bound to its host', () => {
  it('a code for the custom host is refused on the default host, and vice versa', async () => {
    const { hh, inst, admin } = setup();
    hh.core.domains.add(inst, CUSTOM, admin, true);
    const cookie = await hh.login();
    const issue = async (query: Record<string, string>) => {
      const auth = await request(hh.app).get('/auth/instance').query({ slug: 'notes', n: NONCE, ...query }).set('Host', hh.host).set('Cookie', cookie);
      const loc = new URL(auth.headers.location);
      return loc.pathname + loc.search;
    };
    const forCustom = await issue({ host: CUSTOM });
    expect((await request(hh.app).get(forCustom).set('Host', DEFAULT_HOST).set('Cookie', NONCE_COOKIE)).status).toBe(400);
    expect((await request(hh.app).get(forCustom).set('Host', CUSTOM_HOST).set('Cookie', NONCE_COOKIE)).status).toBe(302);
    const forDefault = await issue({});
    expect((await request(hh.app).get(forDefault).set('Host', CUSTOM_HOST).set('Cookie', NONCE_COOKIE)).status).toBe(400);
    expect((await request(hh.app).get(forDefault).set('Host', DEFAULT_HOST).set('Cookie', NONCE_COOKIE)).status).toBe(302);
  });
});

describe('request host forms', () => {
  it('resolves the same instance for case and a trailing dot', async () => {
    const { hh, inst, admin } = setup();
    hh.core.domains.add(inst, CUSTOM, admin, true);
    for (const host of ['Notes.Example.Test.', 'NOTES.example.test', 'notes.example.test.:8080']) {
      expect((await request(hh.app).get('/').set('Host', host)).status, host).toBe(302);
    }
    for (const host of ['[::1]', 'other.example.test', '127.0.0.1']) {
      expect((await request(hh.app).get('/').set('Host', host)).status, host).toBe(404);
    }
  });

  it('refuses IPv6 literals, wildcards, underscores and local names as domains over REST', async () => {
    const { hh, admin } = setup();
    const token = hh.core.tokens.create(admin.id, 't').token;
    for (const host of ['[::1]', '::1', '*.example.test', 'a_b.example.test', 'x.localhost', '0x7f.0x1']) {
      const res = await request(hh.app).put('/api/instances/notes/domains').set('Host', hh.host).set('Authorization', `Bearer ${token}`).send({ host });
      expect(res.status, host).toBe(400);
    }
  });
});

describe('administrators and other people\'s instances', () => {
  it('REST: a platform administrator lists, adds and removes domains of any instance; a publisher still needs the setting', async () => {
    const { hh, other, pub, admin } = setup();
    const token = hh.core.tokens.create(admin.id, 't').token;
    const call = (method: 'get' | 'put' | 'delete', body?: object) => {
      const r = request(hh.app)[method]('/api/instances/other/domains').set('Host', hh.host).set('Authorization', `Bearer ${token}`);
      return body ? r.send(body) : r;
    };
    expect((await call('put', { host: 'o.example.test' })).body.domains).toEqual([{ host: 'o.example.test', url: 'http://o.example.test:8080' }]);
    expect(hh.core.domains.list(other.id)).toEqual(['o.example.test']);
    expect((await call('get')).body.domains).toHaveLength(1);
    expect((await call('delete', { host: 'o.example.test' })).body.domains).toEqual([]);
    expect((await request(hh.app).put('/api/instances/nope/domains').set('Host', hh.host).set('Authorization', `Bearer ${token}`).send({ host: 'a.example.test' })).status).toBe(404);
    // A publisher who owns the instance is refused while the setting is on "admins".
    const ptoken = hh.core.tokens.create(pub.id, 'p').token;
    expect((await request(hh.app).put('/api/instances/other/domains').set('Host', hh.host).set('Authorization', `Bearer ${ptoken}`).send({ host: 'p.example.test' })).status).toBe(403);
    // A plain user without rights on the instance is refused as before.
    const plain = hh.core.users.create({ email: 'u@x.y', name: 'U', password: 'password-123', role: 'user' });
    const utoken = hh.core.tokens.create(plain.id, 'u').token;
    expect((await request(hh.app).put('/api/instances/other/domains').set('Host', hh.host).set('Authorization', `Bearer ${utoken}`).send({ host: 'u.example.test' })).status).toBe(403);
  });

  it('REST: the 11th domain of an instance is a conflict', async () => {
    const { hh, other, admin } = setup();
    const token = hh.core.tokens.create(admin.id, 't').token;
    for (let i = 0; i < 10; i++) hh.core.domains.add(other, `d${i}.example.test`, admin, true);
    const res = await request(hh.app).put('/api/instances/other/domains').set('Host', hh.host).set('Authorization', `Bearer ${token}`).send({ host: 'd10.example.test' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
  });

  it('admin page: list, add, remove with csrf and notices, for an instance the administrator has no access to', async () => {
    const { hh, other, admin } = setup();
    const ac = await hh.login();
    const csrf = csrfToken(hh.core, admin);
    const get = (path: string) => request(hh.app).get(path).set('Host', hh.host).set('Cookie', ac);
    const post = (path: string, body: Record<string, string>) => request(hh.app).post(path).set('Host', hh.host).set('Cookie', ac).type('form').send({ csrf, ...body });
    expect((await get('/admin/apps')).text).toContain('/admin/instances/other/domains');
    expect((await get('/admin/instances/other/domains')).status).toBe(200);
    expect((await get('/admin/instances/nope/domains')).status).toBe(404);
    const added = await post('/admin/instances/other/domains', { host: 'Admin.Example.test' });
    expect(added.status).toBe(302);
    expect(hh.core.domains.list(other.id)).toEqual(['admin.example.test']);
    expect((await get('/admin/instances/other/domains')).text).toContain('admin.example.test');
    expect((await post('/admin/instances/other/domains', { host: 'x.localhost' })).text).toContain(en('notice.hostInvalid'));
    expect((await request(hh.app).post('/admin/instances/other/domains/remove').set('Host', hh.host).set('Cookie', ac).type('form').send({ host: 'admin.example.test' })).status).toBe(403);
    expect(hh.core.domains.list(other.id)).toEqual(['admin.example.test']);
    for (let i = 0; i < 9; i++) hh.core.domains.add(other, `d${i}.example.test`, admin, true);
    const full = await post('/admin/instances/other/domains', { host: 'more.example.test' });
    expect(full.status).toBe(409);
    expect(full.text).toContain(en('notice.domainLimit'));
    expect((await post('/admin/instances/other/domains/remove', { host: 'admin.example.test' })).status).toBe(302);
    expect(hh.core.domains.list(other.id)).not.toContain('admin.example.test');
    // Other roles are kept out.
    const pc = await hh.login('p@x.y', 'password-123');
    expect((await request(hh.app).get('/admin/instances/other/domains').set('Host', hh.host).set('Cookie', pc)).status).toBe(403);
  });
});
