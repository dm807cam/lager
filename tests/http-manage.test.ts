import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { dashboardExtension } from '../src/http/dashboard.js';
import { manageExtension } from '../src/http/manage.js';
import { signToken } from '../src/http/tokens.js';
import type { User } from '../src/platform/users.js';
import { esc } from '../src/http/pages.js';
import { t, type MessageKey } from '../src/i18n/index.js';
import { makeHarness, type Harness } from './support/http.js';

const en = (key: MessageKey): string => esc(t('en', key));
let h: Harness;
afterEach(() => { h?.core.close(); });

interface Ctx { p: User; u: User; w: User; pc: string; uc: string; wc: string }

/** Publisher `p` owns app `notes` with instance `notes`; plain users `u` and `w`; group `team` with `w`. */
async function setup(): Promise<Ctx> {
  h = makeHarness({ extensions: [dashboardExtension, manageExtension] });
  const mk = (email: string, role: 'publisher' | 'user') => h.core.users.create({ email, name: email.split('@')[0], password: 'password-123', role });
  const p = mk('p@x.y', 'publisher');
  const u = mk('u@x.y', 'user');
  const w = mk('w@x.y', 'user');
  h.core.apps.deploy({ slug: 'notes', html: '<p>1</p>', title: 'Notizen', userId: p.id });
  h.core.apps.deploy({ slug: 'notes', html: '<p>2</p>', userId: p.id });
  const team = h.core.groups.create('team');
  h.core.groups.addMember(team.id, w.id);
  const login = (user: User) => h.login(user.email, 'password-123');
  return { p, u, w, pc: await login(p), uc: await login(u), wc: await login(w) };
}

const csrf = (user: User): string => signToken({ uid: user.id, k: 'ui', ep: h.core.users.get(user.id)?.sessionEpoch }, h.core.config.secret, 3600);
const page = (cookie: string | null, path: string) => {
  const r = request(h.app).get(path).set('Host', h.host);
  return cookie ? r.set('Cookie', cookie) : r;
};
const post = (cookie: string, user: User, path: string, body: Record<string, string> = {}) =>
  request(h.app).post(path).set('Host', h.host).set('Cookie', cookie).type('form').send({ csrf: csrf(user), ...body });
/** Follows the redirect of a POST and returns the page it ends on. */
const follow = async (cookie: string, res: request.Response) => {
  expect(res.status).toBe(302);
  return page(cookie, res.headers.location as string);
};
const inst = (slug = 'notes') => h.core.apps.getInstanceBySlug(slug)!;
const level = (slug: string, user: User) => h.core.access.levelFor(inst(slug), user);

describe('instance page', () => {
  it('requires manage rights', async () => {
    const { p, u, uc, pc } = await setup();
    expect((await page(uc, '/instances/notes')).status).toBe(403);
    h.core.access.setGrant(inst(), 'user', u.id, 'view', p);
    expect((await page(uc, '/instances/notes')).status).toBe(403);
    h.core.access.setGrant(inst(), 'user', u.id, 'admin', p);
    const ok = await page(uc, '/instances/notes');
    expect(ok.status).toBe(200);
    expect(ok.text).toContain('http://notes.apps.localhost:8080');
    const anon = await page(null, '/instances/notes');
    expect(anon.status).toBe(302);
    expect(anon.headers.location).toBe('/login?return=%2Finstances%2Fnotes');
    expect((await page(pc, '/instances/nope')).status).toBe(404);
  });

  it('shows versions, visibility, grants, snapshots and the delete form for the owner only', async () => {
    const { p, u, pc, uc } = await setup();
    h.core.data.set(inst().id, 'notes/n1', { text: 'x' }, p.id);
    h.core.data.snapshot(inst().id, 'manual-one');
    const res = await page(pc, '/instances/notes');
    for (const text of [en('instance.version'), en('common.activate'), en('instance.visibility.title'), en('instance.grants.title'), en('instance.snapshots.title'), 'manual-one', en('instance.snapshots.restore'), en('instance.delete.title'), 'name="confirm"']) {
      expect(res.text).toContain(text);
    }
    h.core.access.setGrant(inst(), 'user', u.id, 'admin', p);
    const grantee = await page(uc, '/instances/notes');
    expect(grantee.text).not.toContain(en('instance.delete.title'));
    expect(grantee.text).toContain('u@x.y');
    // A manager sees the snapshots but is not offered the restore they would be refused.
    expect(grantee.text).toContain('manual-one');
    expect(grantee.text).not.toContain('/ui/instances/notes/restore');
    expect(grantee.text).toContain(en('instance.snapshots.ownerOnly'));
    expect(res.text).toContain('/ui/instances/notes/restore');
    expect(res.text).not.toContain(en('instance.snapshots.ownerOnly'));
  });

  it('only the owner restores a snapshot, not a manager', async () => {
    const { p, u, pc, uc } = await setup();
    h.core.access.setGrant(inst(), 'user', u.id, 'admin', p);
    h.core.data.set(inst().id, `data/users/${p.id}/prefs`, { v: 'old' }, p.id);
    const snap = h.core.data.snapshot(inst().id, 'keep-me')!;
    h.core.data.set(inst().id, `data/users/${p.id}/prefs`, { v: 'new' }, p.id);
    const refused = await post(uc, u, '/ui/instances/notes/restore', { snapshot: snap.id });
    expect(refused.status).toBe(403);
    expect(h.core.data.get(inst().id, `data/users/${p.id}/prefs`)!.data).toEqual({ v: 'new' });
    expect(h.core.data.listSnapshots(inst().id).some((s) => s.label === 'pre-restore')).toBe(false);
    expect((await post(pc, p, '/ui/instances/notes/restore', { snapshot: snap.id })).status).toBe(302);
    expect(h.core.data.get(inst().id, `data/users/${p.id}/prefs`)!.data).toEqual({ v: 'old' });
  });

  it('activate, visibility and restore via form', async () => {
    const { p, pc } = await setup();
    const act = await post(pc, p, '/ui/instances/notes/activate', { version: '1' });
    expect(act.status).toBe(302);
    expect(act.headers.location.split('?')[0]).toBe('/instances/notes');
    expect(inst().activeVersion).toBe(1);
    await post(pc, p, '/ui/instances/notes/visibility', { visibility: 'public' });
    expect(inst().visibility).toBe('public');
    h.core.data.set(inst().id, 'notes/n1', { text: 'x' }, p.id);
    const snap = h.core.data.snapshot(inst().id, 'keep-me')!;
    const res = await post(pc, p, '/ui/instances/notes/restore', { snapshot: snap.id });
    expect(res.status).toBe(302);
    expect(h.core.data.listSnapshots(inst().id).some((s) => s.label === 'pre-restore')).toBe(true);
  });

  it('grant by e-mail, change level, remove', async () => {
    const { p, u, pc } = await setup();
    const add = await post(pc, p, '/ui/instances/notes/grants', { email: 'u@x.y', level: 'view' });
    expect(add.status).toBe(302);
    expect(add.headers.location.split('?')[0]).toBe('/instances/notes');
    expect(level('notes', u)).toBe('view');
    const shown = await follow(pc, add);
    expect(shown.text).toContain('u@x.y');
    expect(shown.text).toContain(en('instance.grants.user'));
    await post(pc, p, '/ui/instances/notes/grants', { email: 'u@x.y', level: 'interact' });
    expect(level('notes', u)).toBe('interact');
    const rm = await post(pc, p, '/ui/instances/notes/grants/remove', { type: 'user', id: u.id });
    expect(rm.status).toBe(302);
    expect(level('notes', u)).toBe('none');
  });

  it('grant to a group', async () => {
    const { p, w, pc } = await setup();
    const team = h.core.groups.getByName('team')!;
    const res = await post(pc, p, '/ui/instances/notes/grants', { group: team.id, level: 'interact' });
    expect(res.status).toBe(302);
    expect(level('notes', w)).toBe('interact');
    const shown = await follow(pc, res);
    expect(shown.text).toContain('team');
    expect(shown.text).toContain(en('instance.grants.group'));
    await post(pc, p, '/ui/instances/notes/grants/remove', { type: 'group', id: team.id });
    expect(level('notes', w)).toBe('none');
  });

  it('unknown e-mail shows the message', async () => {
    const { p, pc } = await setup();
    const res = await post(pc, p, '/ui/instances/notes/grants', { email: 'nobody@x.y', level: 'view' });
    const shown = await follow(pc, res);
    expect(shown.status).toBe(200);
    expect(shown.text).toContain(en('notice.noAccount'));
    expect(h.core.access.listGrants(inst().id)).toHaveLength(0);
  });

  it('a grant for the owner is refused with a message, a grantee cannot manage as viewer', async () => {
    const { p, u, pc, uc } = await setup();
    const self = await post(pc, p, '/ui/instances/notes/grants', { email: 'p@x.y', level: 'view' });
    expect((await follow(pc, self)).text).toContain(en('notice.ownerFullAccess'));
    h.core.access.setGrant(inst(), 'user', u.id, 'view', p);
    const denied = await post(uc, u, '/ui/instances/notes/grants', { email: 'w@x.y', level: 'view' });
    expect(denied.status).toBe(403);
  });

  it('visibility with users level', async () => {
    const { p, w, pc, wc } = await setup();
    const res = await post(pc, p, '/ui/instances/notes/visibility', { visibility: 'users', users_level: 'view' });
    expect(res.status).toBe(302);
    expect(inst().visibility).toBe('users');
    expect(level('notes', w)).toBe('view');
    await post(pc, p, '/ui/instances/notes/visibility', { visibility: 'users', users_level: 'interact' });
    expect(level('notes', w)).toBe('interact');
    const shown = await page(pc, '/instances/notes');
    expect(shown.text).toContain(en('instance.usersLevel'));
    const bad = await post(pc, p, '/ui/instances/notes/visibility', { visibility: 'private', users_level: 'admin' });
    expect((await follow(pc, bad)).status).toBe(200);
    expect(inst().visibility).toBe('users');
    expect((await page(wc, '/')).status).toBe(200);
  });

  it('admin grantee cannot delete; owner can with confirmation', async () => {
    const { p, u, pc, uc } = await setup();
    h.core.access.setGrant(inst(), 'user', u.id, 'admin', p);
    const refused = await post(uc, u, '/ui/instances/notes/delete', { confirm: 'notes' });
    expect(refused.status).toBe(403);
    expect(h.core.apps.getInstanceBySlug('notes')).not.toBeNull();
    const wrong = await post(pc, p, '/ui/instances/notes/delete', { confirm: 'nope' });
    const shown = await follow(pc, wrong);
    expect(shown.text).toContain(en('notice.confirmName'));
    expect(h.core.apps.getInstanceBySlug('notes')).not.toBeNull();
    const ok = await post(pc, p, '/ui/instances/notes/delete', { confirm: 'notes' });
    expect(ok.status).toBe(302);
    expect(ok.headers.location.split('?')[0]).toBe('/');
    expect(h.core.apps.getInstanceBySlug('notes')).toBeNull();
  });

  it('posts without csrf → 403', async () => {
    const { pc } = await setup();
    const paths: Array<[string, Record<string, string>]> = [
      ['/ui/instances/notes/activate', { version: '1' }],
      ['/ui/instances/notes/visibility', { visibility: 'public' }],
      ['/ui/instances/notes/auto-update', { on: '0' }],
      ['/ui/instances/notes/grants', { email: 'u@x.y', level: 'view' }],
      ['/ui/instances/notes/delete', { confirm: 'notes' }],
      ['/ui/apps/notes/instances', { slug: 'x1' }],
      ['/ui/apps/notes/collaborators', { email: 'admin@x.y' }],
      ['/ui/apps/notes/self-instances', { mode: 'users' }],
      ['/ui/apps/notes/delete', { confirm: 'notes' }],
    ];
    for (const [path, body] of paths) {
      const res = await request(h.app).post(path).set('Host', h.host).set('Cookie', pc).type('form').send(body);
      expect(res.status, path).toBe(403);
    }
    expect(inst().activeVersion).toBe(2);
    expect(inst().autoUpdate).toBe(true);
    expect(inst().visibility).toBe('private');
    expect(h.core.apps.getApp('notes')).not.toBeNull();
  });

  it('forged posts are refused and change nothing: no rights, collaborator on owner-only routes, foreign csrf, wrong token kind', async () => {
    const { p, u, pc, uc } = await setup();
    const app = h.core.apps.getApp('notes')!;
    const c = h.core.users.create({ email: 'c@x.y', name: 'c', password: 'password-123', role: 'publisher' });
    h.core.apps.addCollaborator(app.id, c.id, p.id);
    const cc = await h.login('c@x.y', 'password-123');
    h.core.access.setGrant(inst(), 'user', u.id, 'view', p);
    h.core.data.set(inst().id, 'tasks/a', { n: 1 }, p.id);
    h.core.data.snapshot(inst().id, 'manual');
    const snap = h.core.data.listSnapshots(inst().id)[0]?.id ?? 'x';

    const instanceRoutes: Array<[string, Record<string, string>]> = [
      ['/ui/instances/notes/activate', { version: '1' }],
      ['/ui/instances/notes/visibility', { visibility: 'public', users_level: 'view' }],
      ['/ui/instances/notes/restore', { snapshot: snap }],
      ['/ui/instances/notes/grants', { email: 'c@x.y', level: 'admin' }],
      ['/ui/instances/notes/grants/remove', { type: 'user', id: u.id }],
      ['/ui/instances/notes/delete', { confirm: 'notes' }],
    ];
    const ownerOnlyAppRoutes: Array<[string, Record<string, string>]> = [
      ['/ui/apps/notes/collaborators', { email: 'admin@x.y' }],
      ['/ui/apps/notes/collaborators/remove', { id: c.id }],
      ['/ui/apps/notes/self-instances', { mode: 'users' }],
      ['/ui/apps/notes/delete', { confirm: 'notes' }],
    ];
    const appRoutes: Array<[string, Record<string, string>]> = [['/ui/apps/notes/instances', { slug: 'forged' }], ...ownerOnlyAppRoutes];
    const all = [...instanceRoutes, ...appRoutes];

    const state = (): string => JSON.stringify([
      h.core.apps.listAllInstances(), h.core.apps.listAllApps(), h.core.apps.listCollaborators(app.id).map((x) => x.id),
      h.core.access.listGrants(inst().id), h.core.data.listSnapshots(inst().id).map((x) => x.id),
    ]);
    const before = state();
    const forge = async (label: string, cookie: string, routes: typeof all, csrfField: string | undefined) => {
      for (const [path, body] of routes) {
        const req = request(h.app).post(path).set('Host', h.host).set('Cookie', cookie).type('form');
        const res = await req.send(csrfField === undefined ? body : { csrf: csrfField, ...body });
        expect(res.status, `${label} ${path}`).toBe(403);
      }
      expect(state(), label).toBe(before);
    };

    // (a) signed in, valid csrf of their own, but no rights on the instance/app (u only has view on the instance).
    await forge('no rights', uc, all, csrf(u));
    // (b) a collaborator on the routes only the app owner may use.
    await forge('collaborator', cc, ownerOnlyAppRoutes, csrf(c));
    // (c) the owner's session with a csrf token minted for another user.
    await forge('foreign csrf', pc, all, csrf(u));
    // (d) the owner's session with signed tokens of the wrong kind in the csrf field.
    for (const kind of ['flash', 'code', 'inst']) {
      const token = signToken({ uid: p.id, k: kind, iid: inst().id }, h.core.config.secret, 3600);
      await forge(`wrong kind ${kind}`, pc, all, token);
    }
    await forge('garbage csrf', pc, all, 'not-a-token');
  });

  it('escapes values on the page', async () => {
    const { p, pc } = await setup();
    h.core.groups.create('<b>grp</b>');
    const res = await page(pc, '/instances/notes');
    expect(res.text).not.toContain('<b>grp</b>');
    expect(res.text).toContain('&lt;b&gt;grp&lt;/b&gt;');
    h.core.access.setGrant(inst(), 'group', h.core.groups.getByName('<b>grp</b>')!.id, 'view', p);
    expect((await page(pc, '/instances/notes')).text).not.toContain('<b>grp</b>');
  });
});

describe('app page', () => {
  it('collaborator sees it, cannot manage collaborators', async () => {
    const { p, u, pc, uc } = await setup();
    const c = h.core.users.create({ email: 'c@x.y', name: 'c', password: 'password-123', role: 'publisher' });
    h.core.apps.addCollaborator(h.core.apps.getApp('notes')!.id, c.id, p.id);
    const cc = await h.login('c@x.y', 'password-123');
    const owner = await page(pc, '/apps/notes');
    expect(owner.status).toBe(200);
    for (const text of [en('app.collaborators'), en('app.self.title'), en('app.delete.title'), en('app.newInstance'), 'p@x.y']) expect(owner.text).toContain(text);
    const collab = await page(cc, '/apps/notes');
    expect(collab.status).toBe(200);
    expect(collab.text).toContain(en('app.newInstance'));
    expect(collab.text).not.toContain(en('app.collaborators'));
    expect(collab.text).not.toContain(en('app.delete.title'));
    const refused = await post(cc, c, '/ui/apps/notes/collaborators', { email: 'admin@x.y' });
    expect(refused.status).toBe(403);
    expect((await page(uc, '/apps/notes')).status).toBe(403);
    expect(u.id).toBeTruthy();
  });

  it('owner adds and removes a collaborator; role user is refused', async () => {
    const { p, u, pc } = await setup();
    const c = h.core.users.create({ email: 'c@x.y', name: 'c', password: 'password-123', role: 'publisher' });
    const app = h.core.apps.getApp('notes')!;
    const add = await post(pc, p, '/ui/apps/notes/collaborators', { email: 'c@x.y' });
    expect(add.headers.location.split('?')[0]).toBe('/apps/notes');
    expect(h.core.apps.isCollaborator(app.id, c.id)).toBe(true);
    expect((await follow(pc, add)).text).toContain('c@x.y');
    const rm = await post(pc, p, '/ui/apps/notes/collaborators/remove', { id: c.id });
    expect(rm.status).toBe(302);
    expect(h.core.apps.isCollaborator(app.id, c.id)).toBe(false);
    const plain = await post(pc, p, '/ui/apps/notes/collaborators', { email: 'u@x.y' });
    const shown = await follow(pc, plain);
    expect(shown.text).toContain(en('notice.collaboratorsInvalid'));
    expect(h.core.apps.isCollaborator(app.id, u.id)).toBe(false);
    const unknown = await post(pc, p, '/ui/apps/notes/collaborators', { email: 'nobody@x.y' });
    expect((await follow(pc, unknown)).text).toContain(en('notice.noAccount'));
  });

  it('self-service switch', async () => {
    const { p, pc } = await setup();
    const res = await post(pc, p, '/ui/apps/notes/self-instances', { mode: 'users' });
    expect(res.status).toBe(302);
    expect(h.core.apps.getApp('notes')!.selfInstances).toBe('users');
    await post(pc, p, '/ui/apps/notes/self-instances', { mode: 'off' });
    expect(h.core.apps.getApp('notes')!.selfInstances).toBe('off');
  });

  it('create instance for another user', async () => {
    const { p, u, w, pc, wc } = await setup();
    const res = await post(pc, p, '/ui/apps/notes/instances', { slug: 'for-u', owner_email: 'u@x.y' });
    expect(res.status).toBe(302);
    expect(res.headers.location.split('?')[0]).toBe('/apps/notes');
    expect(inst('for-u').ownerId).toBe(u.id);
    const own = await post(pc, p, '/ui/apps/notes/instances', { slug: 'mine' });
    expect(inst('mine').ownerId).toBe(p.id);
    expect(own.status).toBe(302);
    const unknown = await post(pc, p, '/ui/apps/notes/instances', { slug: 'ghost', owner_email: 'nobody@x.y' });
    expect((await follow(pc, unknown)).text).toContain(en('notice.noAccount'));
    expect(h.core.apps.getInstanceBySlug('ghost')).toBeNull();
    // A self-service creator cannot pick the owner.
    h.core.apps.setSelfInstances(h.core.apps.getApp('notes')!.id, 'users', p.id);
    const sneaky = await post(wc, w, '/ui/apps/notes/instances', { slug: 'sneaky', owner_email: 'u@x.y' });
    expect(sneaky.status).toBe(302);
    expect(inst('sneaky').ownerId).toBe(w.id);
    const list = await page(pc, '/apps/notes');
    expect(list.text).toContain('for-u');
    expect(list.text).toContain('u@x.y');
  });

  it('instances for others: the daily limit and the half of the receiver\'s limit are refused with their own notices', async () => {
    const { p, u, pc } = await setup();
    h.core.settings.setMaxInstancesPerUser(4);
    for (const slug of ['for-u-1', 'for-u-2']) expect((await post(pc, p, '/ui/apps/notes/instances', { slug, owner_email: 'u@x.y' })).status).toBe(302);
    const half = await post(pc, p, '/ui/apps/notes/instances', { slug: 'for-u-3', owner_email: 'u@x.y' });
    expect((await follow(pc, half)).text).toContain(en('notice.ownerLimitHalf'));
    expect(h.core.apps.getInstanceBySlug('for-u-3')).toBeNull();
    expect(h.core.apps.listInstancesOwnedBy(u.id)).toHaveLength(2);
    // Three more for three other people use up the five a day.
    for (const n of ['a', 'b', 'c']) {
      h.core.users.create({ email: `${n}@x.y`, name: n, password: 'pw-pw-pw-pw', role: 'user' });
      await post(pc, p, '/ui/apps/notes/instances', { slug: `for-${n}`, owner_email: `${n}@x.y` });
      expect(inst(`for-${n}`).ownerId).not.toBe(p.id);
    }
    h.core.users.create({ email: 'd@x.y', name: 'd', password: 'pw-pw-pw-pw', role: 'user' });
    const sixth = await post(pc, p, '/ui/apps/notes/instances', { slug: 'for-d', owner_email: 'd@x.y' });
    expect((await follow(pc, sixth)).text).toContain(en('notice.creationRateOthers'));
    expect(h.core.apps.getInstanceBySlug('for-d')).toBeNull();
  });

  it('shows taken and invalid names as notices', async () => {
    const { p, pc } = await setup();
    const taken = await post(pc, p, '/ui/apps/notes/instances', { slug: 'notes' });
    expect((await follow(pc, taken)).text).toContain(en('notice.slugTaken'));
    const bad = await post(pc, p, '/ui/apps/notes/instances', { slug: 'Bad Name' });
    expect((await follow(pc, bad)).text).toContain(esc(t('en', 'notice.slugInvalid', { max: 63 })));
  });

  it('instance limit message', async () => {
    const { p, w, pc, wc } = await setup();
    h.core.settings.setMaxInstancesPerUser(1);
    h.core.apps.setSelfInstances(h.core.apps.getApp('notes')!.id, 'users', p.id);
    const first = await post(wc, w, '/ui/apps/notes/instances', { slug: 'w-one', from: 'home' });
    expect(first.headers.location.split('?')[0]).toBe('/');
    const second = await post(wc, w, '/ui/apps/notes/instances', { slug: 'w-two', from: 'home' });
    const shown = await follow(wc, second);
    expect(shown.text).toContain(en('notice.instanceLimit'));
    expect(h.core.apps.getInstanceBySlug('w-two')).toBeNull();
    expect(pc).toBeTruthy();
  });

  it('delete app refuses while others own instances', async () => {
    const { p, u, pc, uc } = await setup();
    const app = h.core.apps.getApp('notes')!;
    h.core.apps.createInstance({ appId: app.id, slug: 'u-inst', ownerId: u.id });
    const notOwner = await post(uc, u, '/ui/apps/notes/delete', { confirm: 'notes' });
    expect(notOwner.status).toBe(403);
    const wrong = await post(pc, p, '/ui/apps/notes/delete', { confirm: 'x' });
    expect((await follow(pc, wrong)).text).toContain(en('notice.confirmName'));
    const blocked = await post(pc, p, '/ui/apps/notes/delete', { confirm: 'notes' });
    const shown = await follow(pc, blocked);
    expect(shown.text).toContain(en('notice.otherUsersInstances'));
    expect(h.core.apps.getApp('notes')).not.toBeNull();
    h.core.apps.deleteInstance(inst('u-inst').id, u.id);
    const ok = await post(pc, p, '/ui/apps/notes/delete', { confirm: 'notes' });
    expect(ok.status).toBe(302);
    expect(ok.headers.location.split('?')[0]).toBe('/');
    expect(h.core.apps.getApp('notes')).toBeNull();
  });
});

describe('self-publishing and versions', () => {
  it('auto-update toggle', async () => {
    const { p, u, pc, uc } = await setup();
    const before = await page(pc, '/instances/notes');
    expect(before.text).toContain(en('instance.autoUpdate.label'));
    const autoUpdateForm = (html: string): string => /<form[^>]*action="\/ui\/instances\/notes\/auto-update"[\s\S]*?<\/form>/.exec(html)![0];
    expect(autoUpdateForm(before.text)).toMatch(/name="on"[^>]*value="1"[^>]*checked|checked[^>]*name="on"/);
    const off = await post(pc, p, '/ui/instances/notes/auto-update', { on: '0' });
    expect(off.status).toBe(302);
    expect(off.headers.location.split('?')[0]).toBe('/instances/notes');
    expect(inst().autoUpdate).toBe(false);
    h.core.apps.deploy({ slug: 'notes', html: '<p>3</p>', userId: p.id });
    expect(inst().activeVersion).toBe(2);
    expect(autoUpdateForm((await page(pc, '/instances/notes')).text)).not.toMatch(/name="on"[^>]*checked/);
    await post(pc, p, '/ui/instances/notes/auto-update', { on: '1' });
    expect(inst().autoUpdate).toBe(true);
    // switching it on moves the instance to the latest deployed version at once, with the usual snapshot
    await post(pc, p, '/ui/instances/notes/auto-update', { on: '0' });
    h.core.data.set(inst().id, 'n/a', { x: 1 }, p.id);
    h.core.apps.deploy({ slug: 'notes', html: '<p>4</p>', userId: p.id });
    expect(inst().activeVersion).toBe(3);
    await post(pc, p, '/ui/instances/notes/auto-update', { on: '1' });
    expect(inst()).toMatchObject({ autoUpdate: true, activeVersion: 4 });
    expect(h.core.data.listSnapshots(inst().id).map((x) => x.label)).toContain('v3-to-v4');
    // somebody without manage rights changes nothing
    expect((await post(uc, u, '/ui/instances/notes/auto-update', { on: '0' })).status).toBe(403);
    expect(inst().autoUpdate).toBe(true);
    expect((await post(pc, p, '/ui/instances/missing/auto-update', { on: '0' })).status).toBe(404);
  });

  it('self-published versions are labelled and hidden from the app page list', async () => {
    const { p, u, pc, uc } = await setup();
    const app = h.core.apps.getApp('notes')!;
    const other = h.core.apps.createInstance({ appId: app.id, slug: 'notes-u', ownerId: u.id });
    h.core.apps.selfPublish({ instanceId: inst().id, html: '<p>mine</p>', baseVersion: 2, userId: p.id });
    h.core.apps.selfPublish({ instanceId: other.id, html: '<p>theirs</p>', baseVersion: 2, userId: u.id });
    const own = await page(pc, '/instances/notes');
    expect(own.text).toContain(en('instance.savedBySelf'));
    // Match version entries, not bare "v3": the pages carry base64 csrf tokens that can contain such substrings by chance.
    expect(own.text).toContain('data-version="3"');
    expect(own.text).not.toContain('data-version="4"');
    const theirs = await page(uc, '/instances/notes-u');
    expect(theirs.text).toContain('data-version="4"');
    expect(theirs.text).not.toContain('data-version="3"');
    const list = await page(pc, '/apps/notes');
    expect(list.text).not.toContain('data-version="3"');
    expect(list.text).not.toContain('data-version="4"');
    expect(list.text).toMatch(new RegExp(`notes-u[\\s\\S]*?${esc(t('en', 'app.savedCount', { count: 1 }))}|${esc(t('en', 'app.savedCount', { count: 1 }))}[\\s\\S]*?notes-u`));
    // activating somebody else's version through the form is refused
    expect((await post(pc, p, '/ui/instances/notes/activate', { version: '4' })).status).toBe(403);
    expect(inst().activeVersion).toBe(3);
  });
});

describe('data export and version html links', () => {
  it('export link and html links are present and authorised', async () => {
    const { p, u, w, pc, uc, wc } = await setup();
    h.core.access.setGrant(inst(), 'user', u.id, 'admin', p);
    h.core.data.set(inst().id, 'tasks/t1', { title: 'A' }, null);
    h.core.data.set(inst().id, `data/users/${u.id}/storage/kv/mine`, { mine: 1 }, null);
    h.core.data.set(inst().id, `data/users/${p.id}/storage/kv/hers`, { hers: 1 }, null);

    const owner = await page(pc, '/instances/notes');
    expect(owner.text).toContain(`<h2>${en('instance.data.title')}</h2>`);
    // The export link is styled as a button with an icon; its target and its text are what count.
    expect(owner.text).toMatch(new RegExp(`<a [^>]*href="/instances/notes/export"[^>]*>(?:<svg[^]*?</svg>)?${en('instance.data.export').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</a>`));
    expect(owner.text).toContain('href="/apps/notes/versions/1/html"');
    expect(owner.text).toContain('href="/apps/notes/versions/2/html"');
    const app = await page(pc, '/apps/notes');
    expect(app.text).toContain('href="/apps/notes/versions/1/html"');
    expect(app.text).toContain('>HTML</a>');

    // A manager who does not work on the app sees the export link but no links to its deployed versions.
    const admin = await page(uc, '/instances/notes');
    expect(admin.text).toContain(en('instance.data.export'));
    expect(admin.text).not.toContain('/versions/1/html');

    const exp = await page(uc, '/instances/notes/export').buffer(true).parse((r, cb) => {
      let t = ''; r.setEncoding('utf8'); r.on('data', (c) => { t += c; }); r.on('end', () => cb(null, t));
    });
    expect(exp.status).toBe(200);
    expect(exp.headers['content-type']).toMatch(/^application\/x-ndjson/);
    expect(exp.headers['content-disposition']).toMatch(/^attachment; filename="notes-\d{8}\.ndjson"$/);
    expect((exp.body as string).split('\n').filter(Boolean).map((l) => JSON.parse(l).path)).toEqual([`data/users/${u.id}/storage/kv/mine`, 'tasks/t1']);

    expect((await page(wc, '/instances/notes/export')).status).toBe(403);
    expect((await page(pc, '/instances/nope/export')).status).toBe(404);
    const anon = await page(null, '/instances/notes/export');
    expect(anon.status).toBe(302);
    expect(anon.headers.location).toBe('/login?return=%2Finstances%2Fnotes%2Fexport');
    void w;

    const html = await page(pc, '/apps/notes/versions/1/html');
    expect(html.status).toBe(200);
    expect(html.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(html.headers['content-disposition']).toBe('attachment; filename="notes-v1.html"');
    expect(html.headers['x-content-type-options']).toBe('nosniff');
    expect(html.text).toBe('<p>1</p>');
    expect((await page(uc, '/apps/notes/versions/1/html')).status).toBe(403);
    expect((await page(pc, '/apps/notes/versions/9/html')).status).toBe(404);
    expect((await page(pc, '/apps/notes/versions/x/html')).status).toBe(404);
    expect((await page(null, '/apps/notes/versions/1/html')).status).toBe(302);
  });

  it('saved versions get an html link on the instance page for its managers only', async () => {
    const { p, u, pc, uc } = await setup();
    h.core.access.setGrant(inst(), 'user', u.id, 'admin', p);
    const saved = h.core.apps.selfPublish({ instanceId: inst().id, html: '<p>saved</p>', baseVersion: 2, userId: p.id }).version.number;
    for (const cookie of [pc, uc]) {
      const res = await page(cookie, '/instances/notes');
      expect(res.text).toContain(`href="/apps/notes/versions/${saved}/html"`);
      expect((await page(cookie, `/apps/notes/versions/${saved}/html`)).text).toBe('<p>saved</p>');
    }
    // the app page lists deployed versions only, so it has no link for it
    expect((await page(pc, '/apps/notes')).text).not.toContain(`/versions/${saved}/html`);
  });
});
