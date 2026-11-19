import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { createCore, type Core } from '../src/core.js';
import { LagerError } from '../src/errors.js';
import { Apps, type Instance } from '../src/platform/apps.js';
import { openPlatformDb } from '../src/platform/db.js';
import { Users, type User } from '../src/platform/users.js';

let db: ReturnType<typeof openPlatformDb>;
let apps: Apps;
let u: User, p: User, n: User;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-apps-'));
  db = openPlatformDb(dir);
  const users = new Users(db);
  apps = new Apps(db, dir, users);
  u = users.create({ email: 'u@x.y', name: 'U', password: 'pw', role: 'admin' });
  p = users.create({ email: 'p@x.y', name: 'P', password: 'pw', role: 'publisher' });
  n = users.create({ email: 'n@x.y', name: 'N', password: 'pw', role: 'user' });
});

function code(fn: () => unknown): string {
  try { fn(); } catch (e) { if (e instanceof LagerError) return e.code; throw e; }
  return 'none';
}

describe('Apps', () => {
  it('first deploy creates app, v1 and default instance', () => {
    const html = '<p>héllo</p>\n';
    const r = apps.deploy({ slug: 'workout', html, userId: u.id });
    expect(r.createdApp).toBe(true);
    expect(r.createdVersion).toBe(true);
    expect(r.version.number).toBe(1);
    expect(r.instances).toHaveLength(1);
    const i = r.instances[0];
    expect(i.slug).toBe(r.app.slug);
    expect(i.activeVersion).toBe(1);
    expect(i.visibility).toBe('private');
    expect(i.autoUpdate).toBe(true);
    expect(r.app.title).toBe('workout');
    expect(apps.readVersionHtml(r.app.id, 1)).toBe(html);
    expect(apps.getApp('workout')?.id).toBe(r.app.id);
    expect(apps.getApp(r.app.id)?.slug).toBe('workout');
    expect(apps.listApps(u.id)).toHaveLength(1);
    expect(apps.listApps(p.id)).toHaveLength(0);
  });

  it('redeploy creates v2 and activates it', () => {
    apps.deploy({ slug: 'a', html: '<p>1</p>', userId: u.id });
    const r = apps.deploy({ slug: 'a', html: '<p>2</p>', userId: u.id });
    expect(r.createdApp).toBe(false);
    expect(r.version.number).toBe(2);
    expect(r.instances[0].activeVersion).toBe(2);
  });

  it('identical redeploy creates nothing', () => {
    const a = apps.deploy({ slug: 'a', html: '<p>1</p>', userId: u.id });
    const r = apps.deploy({ slug: 'a', html: '<p>1</p>', userId: u.id });
    expect(r.createdVersion).toBe(false);
    expect(r.version.number).toBe(1);
    expect(apps.listVersions(a.app.id)).toHaveLength(1);
  });

  it('same html with different capabilities is a new version', () => {
    const a = apps.deploy({ slug: 'a', html: '<p>1</p>', userId: u.id });
    const r = apps.deploy({ slug: 'a', html: '<p>1</p>', capabilities: { db: {} }, userId: u.id });
    expect(r.createdVersion).toBe(true);
    expect(r.version.number).toBe(2);
    expect(r.version.capabilities).toEqual({ db: {} });
    expect(apps.listVersions(a.app.id).map((v) => v.number)).toEqual([1, 2]);
  });

  it('deploy by non-owner is forbidden', () => {
    apps.deploy({ slug: 'a', html: '<p>1</p>', userId: u.id });
    expect(code(() => apps.deploy({ slug: 'a', html: '<p>2</p>', userId: p.id }))).toBe('forbidden');
  });

  it('deploy by role user is forbidden', () => {
    expect(code(() => apps.deploy({ slug: 'a', html: '<p>1</p>', userId: n.id }))).toBe('forbidden');
  });

  it('activate rolls back and fires hook', () => {
    const calls: [Instance, number, number][] = [];
    apps.onBeforeActivate((i, from, to) => calls.push([i, from, to]));
    const first = apps.deploy({ slug: 'a', html: '<p>1</p>', userId: u.id });
    apps.deploy({ slug: 'a', html: '<p>2</p>', userId: u.id });
    calls.length = 0;
    const inst = first.instances[0];
    const r = apps.activate(inst.id, 1, u.id);
    expect(r.activeVersion).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0][0].id).toBe(inst.id);
    expect(calls[0][1]).toBe(2);
    expect(calls[0][2]).toBe(1);
    expect(code(() => apps.activate(inst.id, 9, u.id))).toBe('not_found');
    expect(code(() => apps.activate(inst.id, 2, p.id))).toBe('forbidden');
  });

  it('activate to the current version does not fire the hook', () => {
    let fired = 0;
    apps.onBeforeActivate(() => { fired++; });
    const a = apps.deploy({ slug: 'a', html: '<p>1</p>', userId: u.id });
    apps.activate(a.instances[0].id, 1, u.id);
    expect(fired).toBe(0);
  });

  it('autoUpdate=false instances stay pinned on deploy', () => {
    const a = apps.deploy({ slug: 'a', html: '<p>1</p>', userId: u.id });
    db.prepare('UPDATE instances SET auto_update = 0 WHERE id = ?').run(a.instances[0].id);
    const r = apps.deploy({ slug: 'a', html: '<p>2</p>', userId: u.id });
    expect(r.instances[0].activeVersion).toBe(1);
    expect(r.instances[0].autoUpdate).toBe(false);
  });

  it('deploy hook fires during auto-update', () => {
    const calls: [number, number][] = [];
    apps.onBeforeActivate((_i, from, to) => calls.push([from, to]));
    apps.deploy({ slug: 'a', html: '<p>1</p>', userId: u.id });
    apps.deploy({ slug: 'a', html: '<p>2</p>', userId: u.id });
    expect(calls).toEqual([[1, 2]]);
  });

  it('second instance has its own slug and starts at latest', () => {
    const a = apps.deploy({ slug: 'a', html: '<p>1</p>', userId: u.id });
    apps.deploy({ slug: 'a', html: '<p>2</p>', userId: u.id });
    const i = apps.createInstance({ appId: a.app.id, slug: 'a-p', ownerId: p.id, visibility: 'users' });
    expect(i.activeVersion).toBe(2);
    expect(i.visibility).toBe('users');
    expect(apps.getInstanceBySlug('a-p')?.id).toBe(i.id);
    expect(apps.getInstance(i.id)?.slug).toBe('a-p');
    expect(apps.listInstances(a.app.id)).toHaveLength(2);
    expect(code(() => apps.createInstance({ appId: a.app.id, slug: 'a-p', ownerId: u.id }))).toBe('conflict');
    expect(code(() => apps.createInstance({ appId: a.app.id, slug: 'a', ownerId: u.id }))).toBe('conflict');
    expect(code(() => apps.createInstance({ appId: a.app.id, slug: 'Bad', ownerId: u.id }))).toBe('invalid_argument');
  });

  it('setVisibility requires the owner', () => {
    const a = apps.deploy({ slug: 'a', html: '<p>1</p>', userId: u.id });
    expect(apps.setVisibility(a.instances[0].id, 'public', u.id).visibility).toBe('public');
    expect(code(() => apps.setVisibility(a.instances[0].id, 'private', p.id))).toBe('forbidden');
  });

  it('deploy returns lint warnings', () => {
    const r = apps.deploy({ slug: 'a', html: '<script>localStorage.x</script>', userId: u.id });
    expect(r.warnings).toHaveLength(1);
  });

  it('rejects html over 16 MiB and empty html', () => {
    expect(code(() => apps.deploy({ slug: 'a', html: 'x'.repeat(16 * 1024 * 1024 + 1), userId: u.id }))).toBe('invalid_argument');
    expect(code(() => apps.deploy({ slug: 'a', html: '', userId: u.id }))).toBe('invalid_argument');
  });
});

describe('Apps with the access model', () => {
  let core: Core;
  let dir: string;
  let adm: User, own: User, col: User, usr: User, grantee: User;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-apps2-'));
    const config: Config = {
      dataDir: dir, port: 0, defaultLocale: 'en', publicUrl: new URL('http://lager.test'), appsDomain: 'apps.test', adminEmail: 'adm@x.y', adminPassword: 'admin-password-1',
      secret: 's', snapshotKeep: 20, trustProxy: false, instanceQuotaBytes: 50 * 1024 * 1024,
    };
    core = createCore(config);
    adm = core.users.getByEmail('adm@x.y')!;
    own = core.users.create({ email: 'own@x.y', name: 'Own', password: 'pw', role: 'publisher' });
    col = core.users.create({ email: 'col@x.y', name: 'Col', password: 'pw', role: 'publisher' });
    usr = core.users.create({ email: 'usr@x.y', name: 'Usr', password: 'pw', role: 'user' });
    grantee = core.users.create({ email: 'gr@x.y', name: 'Gr', password: 'pw', role: 'user' });
  });
  afterEach(() => core.close());

  it('collaborator can deploy, cannot delete or change self-service', () => {
    const r = core.apps.deploy({ slug: 'demo', html: '<p>1</p>', userId: own.id });
    const app = r.app;
    core.apps.addCollaborator(app.id, col.id, own.id);
    expect(core.apps.isCollaborator(app.id, col.id)).toBe(true);
    expect(core.apps.listCollaborators(app.id).map((c) => c.id)).toEqual([col.id]);
    const d = core.apps.deploy({ slug: 'demo', html: '<p>2</p>', userId: col.id });
    expect(d.version.number).toBe(2);
    expect(d.instances[0].activeVersion).toBe(2);
    expect(code(() => core.apps.deleteApp(app.id, col.id))).toBe('forbidden');
    expect(code(() => core.apps.setSelfInstances(app.id, 'users', col.id))).toBe('forbidden');
    expect(code(() => core.apps.deleteInstance(r.instances[0].id, col.id))).toBe('forbidden');
    expect(code(() => core.apps.addCollaborator(app.id, adm.id, col.id))).toBe('forbidden');
    expect(code(() => core.apps.deploy({ slug: 'demo', html: '<p>3</p>', userId: usr.id }))).toBe('forbidden');
    // the collaborator does not own the instance and has no grant on it
    expect(code(() => core.apps.activate(r.instances[0].id, 1, col.id))).toBe('forbidden');
    core.apps.removeCollaborator(app.id, col.id, own.id);
    expect(code(() => core.apps.deploy({ slug: 'demo', html: '<p>4</p>', userId: col.id }))).toBe('forbidden');
    expect(core.apps.setSelfInstances(app.id, 'users', own.id).selfInstances).toBe('users');
  });

  it('addCollaborator needs a publisher or admin target', () => {
    const app = core.apps.deploy({ slug: 'demo', html: '<p>1</p>', userId: own.id }).app;
    expect(code(() => core.apps.addCollaborator(app.id, usr.id, own.id))).toBe('invalid_argument');
    expect(code(() => core.apps.addCollaborator(app.id, 'nope', own.id))).toBe('not_found');
    core.users.setDisabled(col.id, true);
    expect(code(() => core.apps.addCollaborator(app.id, col.id, own.id))).toBe('invalid_argument');
    core.apps.addCollaborator(app.id, adm.id, own.id);
    expect(core.apps.isCollaborator(app.id, adm.id)).toBe(true);
    expect(code(() => core.apps.addCollaborator(app.id, adm.id, adm.id))).toBe('forbidden');
  });

  it('a manager cannot activate a version whose data rules differ; the owner can', () => {
    const strict = { db: { rules: [{ path: 'secret', read: 'owner' as const, write: 'owner' as const }] } };
    const r = core.apps.deploy({ slug: 'demo', html: '<p>1</p>', userId: own.id });
    core.apps.deploy({ slug: 'demo', html: '<p>2</p>', userId: own.id, capabilities: strict });
    core.apps.deploy({ slug: 'demo', html: '<p>3</p>', userId: own.id, capabilities: strict });
    const inst = r.instances[0];
    core.access.setGrant(core.apps.getInstance(inst.id)!, 'user', grantee.id, 'admin', own);
    expect(core.apps.getInstance(inst.id)!.activeVersion).toBe(3);
    // same rules: fine. No rules at all would open the owner-only path to the manager.
    expect(core.apps.activate(inst.id, 2, grantee.id).activeVersion).toBe(2);
    let reason = '';
    try { core.apps.activate(inst.id, 1, grantee.id); } catch (e) { reason = (e as LagerError).reason ?? ''; }
    expect(reason).toBe('rules_differ');
    expect(core.apps.getInstance(inst.id)!.activeVersion).toBe(2);
    expect(core.apps.activate(inst.id, 1, own.id).activeVersion).toBe(1);
  });

  it('an app whose slug looks like an id never stands in for the app with that id', () => {
    const victim = core.apps.deploy({ slug: 'victim', html: '<p>v</p>', userId: own.id }).app;
    expect(code(() => core.apps.deploy({ slug: victim.id, html: '<p>x</p>', userId: adm.id }))).toBe('invalid_argument');
    // A row from before slugs of that shape were refused: the id still wins.
    (core.apps as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): void } } }).db
      .prepare('INSERT INTO apps (id, slug, title, owner_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('00000000-0000-4000-8000-000000000000', victim.id, 'Evil', adm.id, new Date().toISOString());
    expect(core.apps.getApp(victim.id)!.title).toBe(victim.title);
    expect(core.apps.getApp('victim')!.id).toBe(victim.id);
  });

  it('creating an instance for someone else spends the creator\'s daily budget, not the owner\'s', () => {
    const r = core.apps.deploy({ slug: 'demo', html: '<p>1</p>', userId: own.id });
    const others = ['a', 'b', 'c'].map((n) => core.users.create({ email: `${n}@x.y`, name: n, password: 'pw', role: 'user' }));
    // Two gifts each to three people, then the publisher's own instances: all from the one budget of ten a day (the deploy was the first).
    const reasons: string[] = [];
    const attempt = (slug: string, ownerId: string): void => {
      try { core.apps.createInstance({ appId: r.app.id, slug, ownerId, createdBy: own.id }); reasons.push('ok'); }
      catch (e) { reasons.push((e as LagerError).reason ?? 'other'); }
    };
    for (let i = 0; i < 5; i++) attempt(`gift-${i}`, others[i % 3].id);
    for (let i = 0; i < 5; i++) attempt(`own-${i}`, own.id);
    expect(reasons).toEqual([...Array<string>(9).fill('ok'), 'creation_rate']);
    // The publisher ran out; the recipients' own budgets are untouched.
    for (const o of others) expect(core.apps.createInstance({ appId: r.app.id, slug: `mine-${o.name}`, ownerId: o.id }).ownerId).toBe(o.id);
  });

  it('a non-administrator creates at most five instances a day for other accounts, in total', () => {
    const r = core.apps.deploy({ slug: 'demo', html: '<p>1</p>', userId: own.id });
    const others = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => core.users.create({ email: `${n}@x.y`, name: n, password: 'pw', role: 'user' }));
    for (const o of others.slice(0, 5)) core.apps.createInstance({ appId: r.app.id, slug: `gift-${o.name}`, ownerId: o.id, createdBy: own.id });
    // The sixth is refused whoever it is for, also someone who has received nothing yet.
    for (const o of [others[5], others[0]]) {
      expect(() => core.apps.createInstance({ appId: r.app.id, slug: `more-${o.name}`, ownerId: o.id, createdBy: own.id }))
        .toThrow(expect.objectContaining({ code: 'conflict', reason: 'creation_rate_others' }));
    }
    expect(core.apps.getInstanceBySlug('more-f')).toBeNull();
    // Instances of their own are still theirs to create, another publisher has their own budget, and an administrator has no limit.
    expect(core.apps.createInstance({ appId: r.app.id, slug: 'still-mine', ownerId: own.id, createdBy: own.id }).ownerId).toBe(own.id);
    core.apps.addCollaborator(r.app.id, col.id, own.id);
    expect(core.apps.createInstance({ appId: r.app.id, slug: 'from-col', ownerId: others[5].id, createdBy: col.id }).ownerId).toBe(others[5].id);
    for (let i = 0; i < 7; i++) core.apps.createInstance({ appId: r.app.id, slug: `adm-${i}`, ownerId: usr.id, createdBy: adm.id });
    // A day later the budget is back.
    (core.apps as unknown as { db: { exec(sql: string): void } }).db.exec("UPDATE instance_creations SET created_at = '2000-01-01T00:00:00.000Z'");
    expect(core.apps.createInstance({ appId: r.app.id, slug: 'next-day', ownerId: others[0].id, createdBy: own.id }).ownerId).toBe(others[0].id);
  });

  it('others can fill an account\'s instance limit only to half; the owner and an administrator can use the rest', () => {
    core.settings.setMaxInstancesPerUser(6);
    const r = core.apps.deploy({ slug: 'demo', html: '<p>1</p>', userId: own.id });
    for (let i = 0; i < 2; i++) core.apps.createInstance({ appId: r.app.id, slug: `gift-${i}`, ownerId: usr.id, createdBy: own.id });
    // Two of six: one more brings the account to half, and from there on a publisher is refused.
    core.apps.createInstance({ appId: r.app.id, slug: 'gift-2', ownerId: usr.id, createdBy: own.id });
    const refused = (() => { try { core.apps.createInstance({ appId: r.app.id, slug: 'gift-3', ownerId: usr.id, createdBy: own.id }); return null; } catch (e) { return e as LagerError; } })();
    expect(refused).toMatchObject({ code: 'conflict', reason: 'owner_limit_half' });
    expect(refused!.message).toMatch(/Ask its owner .* or ask an administrator/);
    expect(core.apps.getInstanceBySlug('gift-3')).toBeNull();
    // A refusal costs the creator nothing of their daily budget.
    const spent = (): number => ((core.apps as unknown as { db: { prepare(sql: string): { get(): { c: number } } } }).db.prepare('SELECT COUNT(*) AS c FROM instance_creations').get()).c;
    const before = spent();
    expect(() => core.apps.createInstance({ appId: r.app.id, slug: 'gift-4', ownerId: usr.id, createdBy: own.id })).toThrow(expect.objectContaining({ reason: 'owner_limit_half' }));
    expect(spent()).toBe(before);
    // The other half is the owner's, and an administrator may still hand out instances up to the limit.
    core.apps.setSelfInstances(r.app.id, 'users', own.id);
    expect(core.apps.createInstance({ appId: r.app.id, slug: 'own-1', ownerId: usr.id, createdBy: usr.id }).ownerId).toBe(usr.id);
    expect(core.apps.createInstance({ appId: r.app.id, slug: 'adm-1', ownerId: usr.id, createdBy: adm.id }).ownerId).toBe(usr.id);
    expect(core.apps.createInstance({ appId: r.app.id, slug: 'adm-2', ownerId: usr.id, createdBy: adm.id }).ownerId).toBe(usr.id);
    expect(() => core.apps.createInstance({ appId: r.app.id, slug: 'adm-3', ownerId: usr.id, createdBy: adm.id })).toThrow(expect.objectContaining({ reason: 'instance_limit' }));
    // An administrator's own account has no limit, so nothing of it can be used up.
    for (let i = 0; i < 2; i++) expect(core.apps.createInstance({ appId: r.app.id, slug: `for-adm-${i}`, ownerId: adm.id, createdBy: own.id }).ownerId).toBe(adm.id);
  });

  it('instance admin grantee can activate and change visibility', () => {
    const r = core.apps.deploy({ slug: 'demo', html: '<p>1</p>', userId: own.id });
    core.apps.deploy({ slug: 'demo', html: '<p>2</p>', userId: own.id });
    const inst = r.instances[0];
    expect(code(() => core.apps.setVisibility(inst.id, 'public', grantee.id))).toBe('forbidden');
    core.access.setGrant(core.apps.getInstance(inst.id)!, 'user', grantee.id, 'interact', own);
    expect(code(() => core.apps.setVisibility(inst.id, 'public', grantee.id))).toBe('forbidden');
    core.access.setGrant(core.apps.getInstance(inst.id)!, 'user', grantee.id, 'admin', own);
    expect(core.apps.activate(inst.id, 1, grantee.id).activeVersion).toBe(1);
    expect(core.apps.setVisibility(inst.id, 'users', grantee.id).visibility).toBe('users');
    expect(core.apps.setUsersLevel(inst.id, 'view', grantee.id).usersLevel).toBe('view');
    expect(code(() => core.apps.setUsersLevel(inst.id, 'admin' as 'view', grantee.id))).toBe('invalid_argument');
    expect(code(() => core.apps.deleteInstance(inst.id, grantee.id))).toBe('forbidden');
  });

  it('deleteInstance moves data to trash and removes grants', () => {
    const app = core.apps.deploy({ slug: 'demo', html: '<p>1</p>', userId: own.id }).app;
    core.apps.setSelfInstances(app.id, 'users', own.id);
    const second = core.apps.createInstance({ appId: app.id, slug: 'demo-2', ownerId: usr.id });
    core.data.set(second.id, 'notes/a', { t: 1 }, usr.id);
    core.access.setGrant(second, 'user', grantee.id, 'view', usr);
    expect(fs.existsSync(path.join(dir, 'instances', second.id))).toBe(true);
    expect(code(() => core.apps.deleteInstance(second.id, own.id))).toBe('forbidden');
    core.apps.deleteInstance(second.id, usr.id);
    expect(core.apps.getInstance(second.id)).toBeNull();
    expect(core.access.listGrants(second.id)).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'instances', second.id))).toBe(false);
    const trashed = fs.readdirSync(path.join(dir, 'trash')).filter((n) => n.startsWith(second.id));
    expect(trashed).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, 'trash', trashed[0], 'data.sqlite'))).toBe(true);
    expect(core.apps.createInstance({ appId: app.id, slug: 'demo-2', ownerId: usr.id }).slug).toBe('demo-2');
    expect(code(() => core.apps.deleteInstance(second.id, usr.id))).toBe('not_found');
  });

  it('deleteApp refuses while others own instances', () => {
    const app = core.apps.deploy({ slug: 'demo', html: '<p>1</p>', userId: own.id }).app;
    core.apps.addCollaborator(app.id, col.id, own.id);
    core.apps.setSelfInstances(app.id, 'users', own.id);
    const foreign = core.apps.createInstance({ appId: app.id, slug: 'demo-x', ownerId: usr.id });
    const ownInst = core.apps.getInstanceBySlug('demo')!;
    core.data.set(ownInst.id, 'notes/a', { t: 1 }, own.id);
    expect(code(() => core.apps.deleteApp(app.id, col.id))).toBe('forbidden');
    expect(code(() => core.apps.deleteApp(app.id, own.id))).toBe('conflict');
    expect(core.apps.getApp('demo')).not.toBeNull();
    core.apps.deleteInstance(foreign.id, usr.id);
    expect(fs.existsSync(path.join(dir, 'apps', app.id))).toBe(true);
    core.apps.deleteApp(app.id, own.id);
    expect(core.apps.getApp('demo')).toBeNull();
    expect(core.apps.getInstanceBySlug('demo')).toBeNull();
    expect(core.apps.listCollaborators(app.id)).toEqual([]);
    expect(core.apps.listVersions(app.id)).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'apps', app.id))).toBe(false);
    expect(fs.readdirSync(path.join(dir, 'trash')).some((n) => n.startsWith(`app-${app.id}-`))).toBe(true);
    expect(fs.readdirSync(path.join(dir, 'trash')).some((n) => n.startsWith(ownInst.id))).toBe(true);
    expect(core.apps.deploy({ slug: 'demo', html: '<p>again</p>', userId: own.id }).createdApp).toBe(true);
  });

  it('instance limit per user', () => {
    const app = core.apps.deploy({ slug: 'demo', html: '<p>1</p>', userId: own.id }).app;
    core.settings.setMaxInstancesPerUser(2);
    core.apps.createInstance({ appId: app.id, slug: 'd2', ownerId: own.id });
    expect(code(() => core.apps.createInstance({ appId: app.id, slug: 'd3', ownerId: own.id }))).toBe('conflict');
    core.apps.deleteInstance(core.apps.getInstanceBySlug('d2')!.id, own.id);
    core.apps.createInstance({ appId: app.id, slug: 'd3', ownerId: own.id });
    const adminApp = core.apps.deploy({ slug: 'adm1', html: '<p>1</p>', userId: adm.id }).app;
    core.apps.createInstance({ appId: adminApp.id, slug: 'adm2', ownerId: adm.id });
    core.apps.createInstance({ appId: adminApp.id, slug: 'adm3', ownerId: adm.id });
    expect(core.apps.listInstancesOwnedBy(adm.id)).toHaveLength(3);
  });

  it('setInstanceDisabled', () => {
    const inst = core.apps.deploy({ slug: 'demo', html: '<p>1</p>', userId: own.id }).instances[0];
    expect(inst.disabled).toBe(false);
    expect(core.apps.setInstanceDisabled(inst.id, true).disabled).toBe(true);
    expect(code(() => core.apps.setVisibility(inst.id, 'public', own.id))).toBe('forbidden');
    expect(core.apps.listAllInstances().map((i) => i.slug)).toEqual(['demo']);
    expect(core.apps.listAllApps().map((a) => a.slug)).toEqual(['demo']);
    expect(core.apps.setInstanceDisabled(inst.id, false).disabled).toBe(false);
    expect(code(() => core.apps.setInstanceDisabled('nope', true))).toBe('not_found');
  });
});
