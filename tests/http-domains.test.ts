import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { adminExtension } from '../src/http/admin.js';
import { dashboardExtension } from '../src/http/dashboard.js';
import { manageExtension } from '../src/http/manage.js';
import { csrfToken } from '../src/http/session.js';
import type { User } from '../src/platform/users.js';
import { makeHarness, type Harness } from './support/http.js';

let h: Harness | undefined;
afterEach(() => { h?.core.close(); h = undefined; });

const CUSTOM = 'notes.example.test';
const CUSTOM_HOST = `${CUSTOM}:8080`;
const DEFAULT_HOST = 'notes.apps.localhost:8080';

function setup() {
  h = makeHarness({ extensions: [dashboardExtension, manageExtension, adminExtension] });
  const hh = h;
  const pub = hh.core.users.create({ email: 'p@x.y', name: 'P', password: 'password-123', role: 'publisher' });
  const inst = hh.core.apps.deploy({ slug: 'notes', html: '<html><head></head><body>notes</body></html>', userId: pub.id }).instances[0];
  const other = hh.core.apps.deploy({ slug: 'other', html: '<p>other</p>', userId: pub.id }).instances[0];
  const admin = hh.core.users.get(hh.adminId)!;
  // The administrator manages `notes` as a grantee (not as owner), which is what the page needs; `other` stays private to the publisher.
  hh.core.access.setGrant(inst, 'user', admin.id, 'admin', pub);
  return { hh, pub, inst, other, admin };
}

/** Walks the handshake from a custom host: returns the cookie pair and the redirect chain. */
async function enterVia(hh: Harness, host: string, platformCookie: string) {
  const first = await request(hh.app).get('/').set('Host', host);
  const auth = await request(hh.app).get(new URL(first.headers.location).pathname + new URL(first.headers.location).search)
    .set('Host', hh.host).set('Cookie', platformCookie);
  const loc = new URL(auth.headers.location);
  const cb = await request(hh.app).get(loc.pathname + loc.search).set('Host', loc.host);
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
    expect(first.headers.location).toBe(`http://lager.localhost:8080/auth/instance?slug=notes&host=${CUSTOM}&return=%2F`);
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
    const auth = await request(hh.app).get('/auth/instance').query({ slug: 'notes', host: CUSTOM }).set('Host', hh.host).set('Cookie', await hh.login());
    const loc = new URL(auth.headers.location);
    const wrong = await request(hh.app).get(loc.pathname + loc.search).set('Host', 'other.example.test:8080');
    expect(wrong.status).toBe(400);
    expect((await request(hh.app).get(loc.pathname + loc.search).set('Host', CUSTOM_HOST)).status).toBe(302);
    expect((await request(hh.app).get(loc.pathname + loc.search).set('Host', CUSTOM_HOST)).status).toBe(400);
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
    expect(noCookie.headers.location).toBe('http://lager.localhost:8080/auth/instance?slug=notes&return=%2F');
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
    expect((await page(pc, '/instances/notes')).text).not.toContain('Eigene Domains');
    const adminPage = await page(ac, '/instances/notes');
    expect(adminPage.text).toContain('Eigene Domains');
    expect(adminPage.text).toContain('DNS, Proxy-Eintrag und Zertifikat für die Domain richtest du selbst ein. Lager prüft nicht, wem die Domain gehört.');
    hh.core.settings.setCustomDomains('publishers');
    expect((await page(pc, '/instances/notes')).text).toContain('Eigene Domains');
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
    expect(added.text).toContain('Entfernen');
    expect((await follow(await post(ac, admin, '/ui/instances/notes/domains', { host: 'nonsense' }))).text).toContain('Das ist kein gültiger Hostname.');
    hh.core.domains.add(other, 'other.example.test', admin, true);
    expect((await follow(await post(ac, admin, '/ui/instances/notes/domains', { host: 'other.example.test' }))).text).toContain('Diese Domain ist bereits vergeben.');
    for (const bad of ['lager.localhost', 'x.apps.localhost']) {
      expect((await follow(await post(ac, admin, '/ui/instances/notes/domains', { host: bad }))).text, bad).toContain('Diese Domain kann nicht verwendet werden.');
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
    expect(form.text).toContain('Eigene Domains');
    expect(form.text).toContain('Nur Administratoren');
    expect(form.text).toContain('Auch Publisher');
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
