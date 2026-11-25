import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { adminExtension } from '../src/http/admin.js';
import { dashboardExtension } from '../src/http/dashboard.js';
import { csrfToken } from '../src/http/session.js';
import { MemoryMailer } from '../src/platform/mail.js';
import type { User } from '../src/platform/users.js';
import { makeHarness, type Harness } from './support/http.js';
import { esc } from '../src/http/pages.js';
import { t, type MessageKey } from '../src/i18n/index.js';

const en = (key: MessageKey): string => esc(t('en', key));
let h: Harness | undefined;
afterEach(() => { h?.core.close(); h = undefined; });

const PASSWORD = 'correct horse battery';

function setup(opts: { mailer?: MemoryMailer } = {}) {
  h = makeHarness({ extensions: [adminExtension, dashboardExtension], mailer: opts.mailer });
  const hh = h;
  const get = (path: string, cookie?: string) => {
    const r = request(hh.app).get(path).set('Host', hh.host);
    return cookie ? r.set('Cookie', cookie) : r;
  };
  /** POST with a valid csrf token of `user` unless `csrf` is given. */
  const post = (path: string, cookie: string, body: Record<string, string>, user: User | null = hh.core.users.get(hh.adminId), csrf?: string) =>
    request(hh.app).post(path).set('Host', hh.host).set('Cookie', cookie).type('form')
      .send({ csrf: csrf ?? (user ? csrfToken(hh.core, user) : ''), ...body });
  const makeUser = async (email: string, role: 'user' | 'publisher' | 'admin' = 'user', name = 'Nina') => {
    const user = hh.core.users.create({ email, name, password: PASSWORD, role });
    return { user, cookie: await hh.login(email, PASSWORD) };
  };
  return { hh, get, post, makeUser };
}

describe('administration area', () => {
  it('the invitations page says that a link without an address needs a confirmation by mail, only while mail is on', async () => {
    let s = setup({ mailer: new MemoryMailer() });
    expect((await s.get('/admin/invites', await s.hh.login())).text).toContain(en('admin.invites.unbound'));
    s.hh.core.close();
    s = setup();
    expect((await s.get('/admin/invites', await s.hh.login())).text).not.toContain(en('admin.invites.unbound'));
  });

  it('non-admin gets 403, anonymous is redirected', async () => {
    const s = setup();
    const anon = await s.get('/admin/users');
    expect(anon.status).toBe(302);
    expect(anon.headers.location).toContain('/login');
    const { user, cookie } = await s.makeUser('nina@x.y');
    const res = await s.get('/admin/users', cookie);
    expect(res.status).toBe(403);
    expect(res.text).toContain(en('error.forbidden.title'));
    const before = s.hh.core.users.get(user.id)!.role;
    const p = await s.post(`/admin/users/${user.id}/role`, cookie, { role: 'admin' }, user);
    expect(p.status).toBe(403);
    // The page of one account is the administration's as well.
    const page = await s.get(`/admin/users/${user.id}`, cookie);
    expect(page.status).toBe(403);
    expect(page.text).toContain(en('forbidden.admin'));
    const anonPage = await s.get(`/admin/users/${user.id}`);
    expect(anonPage.status).toBe(302);
    expect(anonPage.headers.location).toContain('/login');
    expect(s.hh.core.users.get(user.id)!.role).toBe(before);
    expect((await s.post('/admin/settings', cookie, { registration: 'open', maxInstances: '5' }, user)).status).toBe(403);
  });

  it('shows the administration link to administrators only', async () => {
    const s = setup();
    const admin = await s.hh.login();
    expect((await s.get('/', admin)).text).toContain('href="/admin"');
    const { cookie } = await s.makeUser('nina@x.y');
    expect((await s.get('/', cookie)).text).not.toContain('href="/admin"');
  });

  it('GET /admin shows the users section with navigation', async () => {
    const s = setup();
    const res = await s.get('/admin', await s.hh.login());
    expect(res.status).toBe(200);
    for (const href of ['/admin/users', '/admin/invites', '/admin/groups', '/admin/settings', '/admin/apps']) expect(res.text).toContain(`href="${href}"`);
    expect(res.text).toContain('admin@x.y');
  });

  it('change role', async () => {
    const s = setup();
    const admin = await s.hh.login();
    const { user } = await s.makeUser('nina@x.y');
    const res = await s.post(`/admin/users/${user.id}/role`, admin, { role: 'publisher' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/admin/users/${user.id}`);
    expect(s.hh.core.users.get(user.id)!.role).toBe('publisher');
    const page = await s.get(`/admin/users/${user.id}`, admin);
    expect(page.text).toMatch(/<option value="publisher" selected>/);
    expect((await s.get('/admin/users/nope', admin)).status).toBe(404);
    const bad = await s.post(`/admin/users/${user.id}/role`, admin, { role: 'god' });
    expect(bad.status).toBe(400);
    expect(s.hh.core.users.get(user.id)!.role).toBe('publisher');
  });

  it('last admin guard shows a message', async () => {
    const s = setup();
    const admin = await s.hh.login();
    const res = await s.post(`/admin/users/${s.hh.adminId}/role`, admin, { role: 'user' });
    expect(res.status).toBe(409);
    expect(res.text).toContain(en('admin.users.lastAdmin'));
    // The refusal shows on the account's own page, where the form was.
    expect(res.text).toContain(`action="/admin/users/${s.hh.adminId}/role"`);
    expect(s.hh.core.users.get(s.hh.adminId)!.role).toBe('admin');
    // Nobody deactivates their own account, last administrator or not: it would end their own session.
    const res2 = await s.post(`/admin/users/${s.hh.adminId}/disabled`, admin, { disabled: '1' });
    expect(res2.status).toBe(403);
    expect(res2.text).toContain(en('admin.users.disableSelf'));
    expect(s.hh.core.users.get(s.hh.adminId)!.disabled).toBe(false);
    const { user: second } = await s.makeUser('second@x.y');
    s.hh.core.users.setRole(second.id, 'admin');
    expect((await s.post(`/admin/users/${s.hh.adminId}/disabled`, admin, { disabled: '1' })).status).toBe(403);
    expect(s.hh.core.users.get(s.hh.adminId)!.disabled).toBe(false);
    // An action on an account that does not exist answers 404 with the list.
    const gone = await s.post('/admin/users/nope/role', admin, { role: 'user' });
    expect(gone.status).toBe(404);
    expect(gone.text).toContain(en('admin.users.notFound'));
    expect(gone.text).toContain('href="/admin/users/'); 
  });

  it('disable and enable a user', async () => {
    const s = setup();
    const admin = await s.hh.login();
    const { user, cookie } = await s.makeUser('nina@x.y');
    expect((await s.get('/', cookie)).status).toBe(200);
    const off = await s.post(`/admin/users/${user.id}/disabled`, admin, { disabled: '1' });
    expect(off.status).toBe(302);
    expect(off.headers.location).toBe(`/admin/users/${user.id}`);
    expect((await s.get('/', cookie)).status).toBe(302);
    expect((await s.get('/admin/users', admin)).text).toContain(en('common.disabled'));
    await s.post(`/admin/users/${user.id}/disabled`, admin, { disabled: '0' });
    expect(s.hh.core.users.get(user.id)!.disabled).toBe(false);
    expect((await s.get('/admin/users', admin)).text).not.toContain(`${en('common.disabled')}</td>`);
    expect((await s.post(`/admin/users/${user.id}/disabled`, admin, { disabled: 'x' })).status).toBe(400);
  });

  it('reset link is shown once and works', async () => {
    const s = setup();
    const admin = await s.hh.login();
    const { user } = await s.makeUser('nina@x.y');
    const res = await s.post(`/admin/users/${user.id}/reset-link`, admin, {});
    expect(res.status).toBe(200);
    const link = /https?:\/\/[^\s"<]+\/reset\?token=[^\s"<]+/.exec(res.text)![0];
    expect((await s.get('/admin/users', admin)).text).not.toContain('/reset?token=');
    const u = new URL(link);
    const form = await s.get(u.pathname + u.search);
    expect(form.status).toBe(200);
    const done = await request(s.hh.app).post('/reset').set('Host', s.hh.host).type('form')
      .send({ token: u.searchParams.get('token'), password: 'a brand new password' });
    expect(done.status).toBe(200);
    expect((await s.hh.login('nina@x.y', 'a brand new password'))).toContain('lager_session=');
  });

  it('create invite shows the link; revoke removes it', async () => {
    const mailer = new MemoryMailer();
    const s = setup({ mailer });
    const admin = await s.hh.login();
    const res = await s.post('/admin/invites', admin, { email: 'new@x.y', role: 'publisher' });
    expect(res.status).toBe(200);
    expect(mailer.sent).toHaveLength(1);
    expect(res.text).toContain(en('admin.invites.mailed'));
    const link = /https?:\/\/[^\s"<]+\/register\?invite=[^\s"<]+/.exec(res.text)![0];
    const u = new URL(link);
    const reg = await request(s.hh.app).post('/register').set('Host', s.hh.host).type('form')
      .send({ name: 'New', email: 'new@x.y', password: PASSWORD, invite: u.searchParams.get('invite') });
    expect([200, 302]).toContain(reg.status);
    expect(s.hh.core.users.getByEmail('new@x.y')!.role).toBe('publisher');

    const noMail = await s.post('/admin/invites', admin, { role: 'user' });
    expect(noMail.text).toContain(en('admin.invites.notMailed'));
    const list = await s.get('/admin/invites', admin);
    expect(list.text).not.toContain('invite=');
    const open = s.hh.core.accounts.listInvites().filter((i) => !i.used);
    expect(open).toHaveLength(1);
    expect(list.text).toContain(en('common.revoke'));
    const rev = await s.post(`/admin/invites/${open[0].id}/revoke`, admin, {});
    expect(rev.status).toBe(302);
    expect(s.hh.core.accounts.listInvites().filter((i) => !i.used)).toHaveLength(0);
    expect((await s.post('/admin/invites', admin, { email: 'nope', role: 'user' })).status).toBe(400);
  });

  it('groups: create, add member by e-mail, remove, delete', async () => {
    const s = setup();
    const admin = await s.hh.login();
    const { user } = await s.makeUser('nina@x.y');
    expect((await s.post('/admin/groups', admin, { name: 'Team' })).headers.location).toBe('/admin/groups');
    const group = s.hh.core.groups.list()[0];
    expect((await s.get('/admin/groups', admin)).text).toContain(`/admin/groups/${group.id}`);
    expect((await s.post(`/admin/groups/${group.id}/rename`, admin, { name: 'Crew' })).headers.location).toBe(`/admin/groups/${group.id}`);
    expect(s.hh.core.groups.get(group.id)!.name).toBe('Crew');
    const add = await s.post(`/admin/groups/${group.id}/members`, admin, { email: ' nina@x.y ' });
    expect(add.status).toBe(302);
    expect(s.hh.core.groups.members(group.id).map((m) => m.id)).toEqual([user.id]);
    expect((await s.get(`/admin/groups/${group.id}`, admin)).text).toContain(en('common.remove'));
    const unknown = await s.post(`/admin/groups/${group.id}/members`, admin, { email: 'who@x.y' });
    expect(unknown.text).toContain(en('notice.noAccount'));
    await s.post(`/admin/groups/${group.id}/members/${user.id}/remove`, admin, {});
    expect(s.hh.core.groups.members(group.id)).toHaveLength(0);
    expect((await s.post(`/admin/groups/${group.id}/delete`, admin, {})).headers.location).toBe('/admin/groups');
    expect(s.hh.core.groups.list()).toHaveLength(0);
    expect((await s.get(`/admin/groups/${group.id}`, admin)).status).toBe(404);
  });

  it('settings: registration mode and instance limit', async () => {
    const s = setup();
    const admin = await s.hh.login();
    const page = await s.get('/admin/settings', admin);
    expect(page.text).toContain(en('admin.mode.invite'));
    expect(page.text).toContain(en('admin.mode.closed'));
    expect((await s.post('/admin/settings', admin, { registration: 'closed', maxInstances: '7' })).status).toBe(302);
    expect(s.hh.core.settings.registration).toBe('closed');
    expect(s.hh.core.settings.maxInstancesPerUser).toBe(7);
    const bad = await s.post('/admin/settings', admin, { registration: 'open', maxInstances: '0' });
    expect(bad.status).toBe(400);
    expect(s.hh.core.settings.registration).toBe('closed');
  });

  it('settings page warns when mail is not configured', async () => {
    const s = setup();
    const page = await s.get('/admin/settings', await s.hh.login());
    expect(page.text).toContain(en('admin.settings.noMail'));
  });

  it('apps overview lists foreign apps and disables an instance', async () => {
    const s = setup();
    const admin = await s.hh.login();
    const { user } = await s.makeUser('pub@x.y', 'publisher');
    const { instances } = s.hh.core.apps.deploy({ slug: 'notes', html: '<h1>secret content</h1>', userId: user.id });
    const slug = instances[0].slug;
    const page = await s.get('/admin/apps', admin);
    expect(page.status).toBe(200);
    expect(page.text).toContain('pub@x.y');
    expect(page.text).toContain(slug);
    expect(page.text).toContain(en('common.deactivate'));
    expect(page.text).not.toContain('secret content');
    expect((await s.post(`/admin/instances/${slug}/disabled`, admin, { disabled: '1' })).headers.location).toBe('/admin/apps');
    const host = `${slug}.apps.localhost:8080`;
    const served = await request(s.hh.app).get('/').set('Host', host);
    expect(served.text).toContain(t('en', 'error.disabled.text'));
    expect((await s.get('/admin/apps', admin)).text).toContain(en('common.activate'));
    await s.post(`/admin/instances/${slug}/disabled`, admin, { disabled: '0' });
    expect(s.hh.core.apps.getInstanceBySlug(slug)!.disabled).toBe(false);
    expect((await s.post('/admin/instances/nope/disabled', admin, { disabled: '1' })).status).toBe(404);
  });

  it('posts without csrf → 403', async () => {
    const s = setup();
    const admin = await s.hh.login();
    const { user } = await s.makeUser('nina@x.y');
    for (const [path, body] of [
      [`/admin/users/${user.id}/role`, { role: 'publisher' }],
      [`/admin/users/${user.id}/disabled`, { disabled: '1' }],
      [`/admin/users/${user.id}/reset-link`, {}],
      ['/admin/invites', { role: 'user' }],
      ['/admin/groups', { name: 'G' }],
      ['/admin/settings', { registration: 'closed', maxInstances: '3' }],
    ] as Array<[string, Record<string, string>]>) {
      const res = await request(s.hh.app).post(path).set('Host', s.hh.host).set('Cookie', admin).type('form').send(body);
      expect(res.status, path).toBe(403);
    }
    const wrong = await s.post(`/admin/users/${user.id}/role`, admin, { role: 'publisher' }, null, 'forged');
    expect(wrong.status).toBe(403);
    expect(s.hh.core.users.get(user.id)!.role).toBe('user');
    expect(s.hh.core.settings.registration).not.toBe('closed');
  });

  it('escapes user-controlled names', async () => {
    const s = setup();
    const admin = await s.hh.login();
    await s.makeUser('x@x.y', 'user', '<script>alert(1)</script>');
    const group = s.hh.core.groups.create('<script>g</script>');
    s.hh.core.groups.addMember(group.id, s.hh.core.users.getByEmail('x@x.y')!.id);
    for (const path of ['/admin/users', '/admin/groups', `/admin/groups/${group.id}`]) {
      const res = await s.get(path, admin);
      expect(res.text, path).not.toContain('<script>');
      expect(res.text, path).toContain('&lt;script&gt;');
    }
  });
});
