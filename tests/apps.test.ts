import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
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
