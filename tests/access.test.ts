import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { createCore, type Core } from '../src/core.js';
import { LagerError } from '../src/errors.js';
import type { Instance } from '../src/platform/apps.js';
import type { User } from '../src/platform/users.js';

let core: Core;
let o: User, e: User, v: User, x: User, a: User;
let inst: Instance;

beforeEach(() => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-access-'));
  const config: Config = {
    dataDir, port: 0, publicUrl: new URL('http://lager.test'), appsDomain: 'apps.test', adminEmail: 'a@x.y', adminPassword: 'pw',
    secret: 's', snapshotKeep: 20, trustProxy: false, instanceQuotaBytes: 50 * 1024 * 1024,
  };
  core = createCore(config);
  a = core.users.getByEmail('a@x.y')!;
  o = core.users.create({ email: 'o@x.y', name: 'Olga', password: 'pw', role: 'publisher' });
  e = core.users.create({ email: 'e@x.y', name: 'Erik', password: 'pw', role: 'user' });
  v = core.users.create({ email: 'v@x.y', name: 'Vera', password: 'pw', role: 'user' });
  x = core.users.create({ email: 'x@x.y', name: 'Xaver', password: 'pw', role: 'user' });
  inst = core.apps.deploy({ slug: 'demo', html: '<p>hi</p>', userId: o.id }).instances[0];
});
afterEach(() => core.close());

const fresh = (): Instance => core.apps.getInstance(inst.id)!;
const level = (u: User | null): string => core.access.levelFor(fresh(), u);
function code(fn: () => unknown): string {
  try { fn(); } catch (err) { if (err instanceof LagerError) return err.code; throw err; }
  return 'none';
}

describe('Access', () => {
  it('owner and visibility defaults', () => {
    expect(level(o)).toBe('owner');
    expect(level(e)).toBe('none');
    expect(level(null)).toBe('none');
    core.apps.setVisibility(inst.id, 'users', o.id);
    expect(level(e)).toBe('interact');
    expect(level(null)).toBe('none');
    core.apps.setUsersLevel(inst.id, 'view', o.id);
    expect(level(e)).toBe('view');
    core.apps.setVisibility(inst.id, 'public', o.id);
    expect(level(null)).toBe('view');
    expect(level(e)).toBe('view');
  });

  it('direct grants raise the level', () => {
    core.access.setGrant(fresh(), 'user', e.id, 'interact', o);
    expect(level(e)).toBe('interact');
    core.access.setGrant(fresh(), 'user', e.id, 'admin', o);
    expect(level(e)).toBe('admin');
    core.access.setGrant(fresh(), 'user', v.id, 'interact', o);
    core.apps.setVisibility(inst.id, 'public', o.id);
    expect(level(v)).toBe('interact');
    expect(level(x)).toBe('view');
    core.access.removeGrant(fresh(), 'user', v.id, o);
    expect(level(v)).toBe('view');
  });

  it('group grants apply to members', () => {
    const g = core.groups.create('G');
    core.groups.addMember(g.id, v.id);
    core.access.setGrant(fresh(), 'group', g.id, 'view', o);
    expect(level(v)).toBe('view');
    expect(level(e)).toBe('none');
    core.groups.removeMember(g.id, v.id);
    expect(level(v)).toBe('none');
    core.groups.addMember(g.id, v.id);
    expect(level(v)).toBe('view');
    core.groups.delete(g.id);
    expect(level(v)).toBe('none');
    expect(core.access.listGrants(inst.id)).toEqual([]);
  });

  it('highest level wins', () => {
    const g = core.groups.create('G');
    core.groups.addMember(g.id, e.id);
    core.access.setGrant(fresh(), 'user', e.id, 'view', o);
    core.access.setGrant(fresh(), 'group', g.id, 'admin', o);
    expect(level(e)).toBe('admin');
    core.access.setGrant(fresh(), 'group', g.id, 'view', o);
    core.access.setGrant(fresh(), 'user', e.id, 'interact', o);
    expect(level(e)).toBe('interact');
    const labels = core.access.listGrants(inst.id).map((gr) => [gr.principalType, gr.principalLabel, gr.level]).sort();
    expect(labels).toEqual([['group', 'G', 'view'], ['user', 'e@x.y', 'interact']]);
  });

  it('disabled instance and disabled user', () => {
    core.access.setGrant(fresh(), 'user', e.id, 'view', o);
    core.apps.setVisibility(inst.id, 'public', o.id);
    core.apps.setInstanceDisabled(inst.id, true);
    for (const u of [o, e, a, null]) expect(level(u)).toBe('none');
    core.apps.setInstanceDisabled(inst.id, false);
    expect(level(e)).toBe('view');
    core.apps.setVisibility(inst.id, 'private', o.id);
    core.access.setGrant(fresh(), 'user', e.id, 'admin', o);
    const disabledE = core.users.setDisabled(e.id, true);
    expect(level(disabledE)).toBe('none');
    core.apps.setVisibility(inst.id, 'public', o.id);
    expect(level(disabledE)).toBe('view');
    expect(core.access.canManageInstance(fresh(), disabledE)).toBe(false);
  });

  it('platform admin gets no implicit access', () => {
    expect(level(a)).toBe('none');
    expect(core.access.canManageInstance(fresh(), a)).toBe(false);
  });

  it('setGrant authorization', () => {
    expect(code(() => core.access.setGrant(fresh(), 'user', v.id, 'view', x))).toBe('forbidden');
    core.access.setGrant(fresh(), 'user', e.id, 'interact', o);
    expect(code(() => core.access.setGrant(fresh(), 'user', v.id, 'view', e))).toBe('forbidden');
    core.access.setGrant(fresh(), 'user', e.id, 'admin', o);
    core.access.setGrant(fresh(), 'user', v.id, 'view', e);
    expect(level(v)).toBe('view');
    expect(code(() => core.access.setGrant(fresh(), 'user', o.id, 'view', e))).toBe('invalid_argument');
    expect(code(() => core.access.setGrant(fresh(), 'user', 'nope', 'view', o))).toBe('not_found');
    expect(code(() => core.access.setGrant(fresh(), 'group', 'nope', 'view', o))).toBe('not_found');
    expect(code(() => core.access.setGrant(fresh(), 'user', v.id, 'owner' as 'view', o))).toBe('invalid_argument');
    expect(code(() => core.access.removeGrant(fresh(), 'user', v.id, x))).toBe('forbidden');
    core.access.removeGrant(fresh(), 'user', v.id, e);
    expect(level(v)).toBe('none');
  });

  it('canDeploy', () => {
    const app = core.apps.getApp('demo')!;
    const p2 = core.users.create({ email: 'p2@x.y', name: 'P2', password: 'pw', role: 'publisher' });
    expect(core.access.canDeploy(app, o)).toBe(true);
    expect(core.access.canDeploy(app, p2)).toBe(false);
    core.apps.addCollaborator(app.id, p2.id, o.id);
    expect(core.access.canDeploy(app, p2)).toBe(true);
    expect(core.access.canDeploy(app, e)).toBe(false);
    const demoted = core.users.setRole(p2.id, 'user');
    expect(core.access.canDeploy(app, demoted)).toBe(false);
    const disabled = core.users.setDisabled(o.id, true);
    expect(core.access.canDeploy(app, disabled)).toBe(false);
    expect(core.access.canDeploy(app, a)).toBe(false);
  });

  it('canCreateInstance', () => {
    const app = core.apps.getApp('demo')!;
    expect(core.access.canCreateInstance(app, e)).toBe(false);
    expect(core.access.canCreateInstance(app, o)).toBe(true);
    const on = core.apps.setSelfInstances(app.id, 'users', o.id);
    expect(core.access.canCreateInstance(on, e)).toBe(true);
    expect(core.access.canCreateInstance(on, core.users.setDisabled(e.id, true))).toBe(false);
  });

  it('sharedWith and catalog', () => {
    const g = core.groups.create('G');
    core.groups.addMember(g.id, e.id);
    core.access.setGrant(fresh(), 'user', e.id, 'view', o);
    core.access.setGrant(fresh(), 'group', g.id, 'interact', o);
    expect(core.access.sharedWith(e).map((i) => i.id)).toEqual([inst.id]);
    expect(core.access.sharedWith(o)).toEqual([]);
    expect(core.access.catalog(e)).toEqual({ instances: [], apps: [] });

    const second = core.apps.deploy({ slug: 'pub', html: '<p>p</p>', userId: o.id }).instances[0];
    core.apps.setVisibility(second.id, 'public', o.id);
    const third = core.apps.deploy({ slug: 'usr', html: '<p>p</p>', userId: o.id }).instances[0];
    core.apps.setVisibility(third.id, 'users', o.id);
    const mine = core.apps.deploy({ slug: 'mine', html: '<p>p</p>', userId: a.id }).instances[0];
    core.apps.setVisibility(mine.id, 'public', a.id);
    const off = core.apps.deploy({ slug: 'off', html: '<p>p</p>', userId: o.id }).instances[0];
    core.apps.setVisibility(off.id, 'public', o.id);
    core.apps.setInstanceDisabled(off.id, true);
    core.apps.setSelfInstances(core.apps.getApp('usr')!.id, 'users', o.id);

    expect(core.access.catalog(a).instances.map((i) => i.slug).sort()).toEqual(['pub', 'usr']);
    const cat = core.access.catalog(e);
    expect(cat.instances.map((i) => i.slug).sort()).toEqual(['mine', 'pub', 'usr']);
    expect(cat.apps.map((p) => p.slug)).toEqual(['usr']);
    core.apps.setInstanceDisabled(inst.id, true);
    expect(core.access.sharedWith(e)).toEqual([]);
  });

  it('usersWithAccess', () => {
    const g = core.groups.create('G');
    core.groups.addMember(g.id, v.id);
    core.access.setGrant(fresh(), 'user', e.id, 'view', o);
    core.access.setGrant(fresh(), 'group', g.id, 'view', o);
    const ids = (q?: string, limit?: number): string[] => core.access.usersWithAccess(fresh(), q, limit).map((u) => u.id).sort();
    expect(ids()).toEqual([o.id, e.id, v.id].sort());
    expect(ids('ERI')).toEqual([e.id]);
    expect(ids('v@x')).toEqual([v.id]);
    expect(ids(undefined, 2)).toHaveLength(2);
    core.users.setDisabled(e.id, true);
    expect(ids()).toEqual([o.id, v.id].sort());
  });
});
