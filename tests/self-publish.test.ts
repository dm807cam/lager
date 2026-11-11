import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { createCore, type Core } from '../src/core.js';
import { LagerError } from '../src/errors.js';
import type { Instance } from '../src/platform/apps.js';
import { openPlatformDb } from '../src/platform/db.js';
import type { User } from '../src/platform/users.js';

let core: Core;
let dir: string;
let admin: User;
let pub: User;
let usr: User;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-selfpub-'));
  const config: Config = {
    dataDir: dir, port: 0, defaultLocale: 'en', publicUrl: new URL('http://lager.test'), appsDomain: 'apps.test', adminEmail: 'adm@x.y', adminPassword: 'pw',
    secret: 's', snapshotKeep: 20, trustProxy: false, instanceQuotaBytes: 50 * 1024 * 1024,
  };
  core = createCore(config);
  admin = core.users.getByEmail('adm@x.y')!;
  pub = core.users.create({ email: 'pub@x.y', name: 'Pub', password: 'pw', role: 'publisher' });
  usr = core.users.create({ email: 'usr@x.y', name: 'Usr', password: 'pw', role: 'user' });
});
afterEach(() => core.close());

function code(fn: () => unknown): string {
  try { fn(); } catch (e) { if (e instanceof LagerError) return e.code; throw e; }
  return 'none';
}

/** App `poll` (v1) with the default instance `poll` and a second instance `poll-b` of the same app owned by `usr`. */
function setup(): { a: Instance; b: Instance; appId: string } {
  const r = core.apps.deploy({ slug: 'poll', html: '<p>v1</p>', userId: pub.id, capabilities: { artifact: {} } });
  const b = core.apps.createInstance({ appId: r.app.id, slug: 'poll-b', ownerId: usr.id });
  return { a: r.instances[0], b, appId: r.app.id };
}

describe('selfPublish', () => {
  it('creates an instance-bound version and pins the instance', () => {
    const { a, appId } = setup();
    const r = core.apps.selfPublish({ instanceId: a.id, html: '<p>voted</p>', baseVersion: 1, userId: pub.id });
    expect(r.version.number).toBe(2);
    expect(r.version.instanceId).toBe(a.id);
    expect(r.version.note).toBe('saved by the instance itself');
    expect(r.version.capabilities).toEqual({ artifact: {} });
    expect(r.instance.activeVersion).toBe(2);
    expect(r.instance.autoUpdate).toBe(false);
    expect(core.apps.readVersionHtml(appId, 2)).toBe('<p>voted</p>');
    expect(core.apps.listVersions(appId).map((v) => v.instanceId)).toEqual([null, a.id]);
  });

  it('conflict on a stale baseVersion; needs manage rights and valid html', () => {
    const { a } = setup();
    core.apps.selfPublish({ instanceId: a.id, html: '<p>x</p>', baseVersion: 1, userId: pub.id });
    expect(code(() => core.apps.selfPublish({ instanceId: a.id, html: '<p>y</p>', baseVersion: 1, userId: pub.id }))).toBe('conflict');
    expect(code(() => core.apps.selfPublish({ instanceId: a.id, html: '<p>y</p>', baseVersion: 2, userId: usr.id }))).toBe('forbidden');
    expect(code(() => core.apps.selfPublish({ instanceId: a.id, html: '  ', baseVersion: 2, userId: pub.id }))).toBe('invalid_argument');
    expect(code(() => core.apps.selfPublish({ instanceId: a.id, html: 'x'.repeat(16 * 1024 * 1024 + 1), baseVersion: 2, userId: pub.id }))).toBe('invalid_argument');
    expect(code(() => core.apps.selfPublish({ instanceId: 'nope', html: '<p>y</p>', baseVersion: 2, userId: pub.id }))).toBe('not_found');
  });

  it('a later deploy skips the pinned instance and reports it', () => {
    const { a, b, appId } = setup();
    core.apps.selfPublish({ instanceId: a.id, html: '<p>mine</p>', baseVersion: 1, userId: pub.id });
    const d = core.apps.deploy({ slug: 'poll', html: '<p>new</p>', userId: pub.id, capabilities: { artifact: {} } });
    expect(d.version.number).toBe(3);
    expect(d.pinned.map((i) => i.id)).toEqual([a.id]);
    expect(core.apps.getInstance(a.id)!.activeVersion).toBe(2);
    expect(core.apps.getInstance(b.id)!.activeVersion).toBe(3);
    expect(core.apps.readVersionHtml(appId, 2)).toBe('<p>mine</p>');
  });

  it('self-published versions are not "latest"', () => {
    const { a, appId } = setup();
    core.apps.selfPublish({ instanceId: a.id, html: '<p>mine</p>', baseVersion: 1, userId: pub.id });
    expect(core.apps.latestDeployedVersion(appId)!.number).toBe(1);
    const c = core.apps.createInstance({ appId, slug: 'poll-c', ownerId: usr.id });
    expect(c.activeVersion).toBe(1);
    // Redeploying the content of v1 is "unchanged" although a newer self-published version exists.
    const same = core.apps.deploy({ slug: 'poll', html: '<p>v1</p>', userId: pub.id, capabilities: { artifact: {} } });
    expect(same.createdVersion).toBe(false);
    expect(same.version.number).toBe(1);
    expect(same.pinned).toEqual([]);
    expect(core.apps.getInstance(a.id)!.activeVersion).toBe(2);
    // A different deploy takes the next free number, after the self-published one.
    expect(core.apps.deploy({ slug: 'poll', html: '<p>v3</p>', userId: pub.id }).version.number).toBe(3);
    expect(core.apps.latestDeployedVersion(appId)!.number).toBe(3);
    expect(core.apps.latestDeployedVersion('nope')).toBeNull();
  });

  it('another instance cannot activate it', () => {
    const { a, b } = setup();
    core.apps.selfPublish({ instanceId: a.id, html: '<p>mine</p>', baseVersion: 1, userId: pub.id });
    expect(code(() => core.apps.activate(b.id, 2, usr.id))).toBe('forbidden');
    expect(core.apps.getInstance(b.id)!.activeVersion).toBe(1);
    core.apps.activate(a.id, 1, pub.id);
    expect(core.apps.getInstance(a.id)!.activeVersion).toBe(1);
    const back = core.apps.activate(a.id, 2, pub.id);
    expect(back.activeVersion).toBe(2);
    expect(back.autoUpdate).toBe(false);
  });

  it('setAutoUpdate(true) lets the next deploy update again', () => {
    const { a, b } = setup();
    core.apps.selfPublish({ instanceId: a.id, html: '<p>mine</p>', baseVersion: 1, userId: pub.id });
    expect(code(() => core.apps.setAutoUpdate(a.id, true, usr.id))).toBe('forbidden');
    expect(core.apps.setAutoUpdate(a.id, true, pub.id).autoUpdate).toBe(true);
    const d = core.apps.deploy({ slug: 'poll', html: '<p>new</p>', userId: pub.id });
    expect(d.pinned).toEqual([]);
    expect(core.apps.getInstance(a.id)!.activeVersion).toBe(3);
    expect(core.apps.getInstance(b.id)!.activeVersion).toBe(3);
    expect(core.apps.setAutoUpdate(a.id, false, pub.id).autoUpdate).toBe(false);
  });

  it('snapshot hook still runs on selfPublish', () => {
    const { a } = setup();
    core.data.set(a.id, 'votes/a', { n: 1 }, pub.id);
    core.apps.selfPublish({ instanceId: a.id, html: '<p>mine</p>', baseVersion: 1, userId: pub.id });
    expect(core.data.listSnapshots(a.id).map((s) => s.label)).toEqual(['v1-to-v2']);
  });

  it('announces every activation to listeners of the instance', () => {
    const { a, b } = setup();
    const seen: unknown[] = [];
    core.hub.subscribe(a.id, (e) => seen.push(e));
    core.apps.selfPublish({ instanceId: a.id, html: '<p>mine</p>', baseVersion: 1, userId: pub.id });
    core.apps.activate(a.id, 1, pub.id);
    core.apps.setAutoUpdate(a.id, true, pub.id);
    core.apps.deploy({ slug: 'poll', html: '<p>new</p>', userId: pub.id });
    expect(seen).toEqual([{ type: 'reload', version: 2 }, { type: 'reload', version: 1 }, { type: 'reload', version: 3 }]);
    const other: unknown[] = [];
    core.hub.subscribe(b.id, (e) => other.push(e));
    core.apps.activate(b.id, 1, usr.id);
    expect(other).toEqual([{ type: 'reload', version: 1 }]);
    expect(seen).toHaveLength(3);
  });

  it('deleting the instance removes its self-published versions', () => {
    const { a, b, appId } = setup();
    core.apps.selfPublish({ instanceId: b.id, html: '<p>secret</p>', baseVersion: 1, userId: usr.id });
    core.apps.selfPublish({ instanceId: a.id, html: '<p>other</p>', baseVersion: 1, userId: pub.id });
    core.apps.deleteInstance(b.id, usr.id);
    expect(core.apps.listVersions(appId).map((v) => v.number)).toEqual([1, 3]);
    expect(code(() => core.apps.readVersionHtml(appId, 2))).toBe('not_found');
  });
});

const doc = (n: number | string, pad = 0): string => `<!doctype html><p>${n}</p>${'x'.repeat(pad)}`;

describe('saved version limits', () => {
  it('the 21st save prunes the oldest, keeps the active one and moves the pruned html to the trash', () => {
    const { a, b, appId } = setup();
    core.apps.selfPublish({ instanceId: b.id, html: doc('other'), baseVersion: 1, userId: usr.id });
    let base = 1;
    for (let n = 1; n <= 21; n++) base = Number(core.apps.selfPublish({ instanceId: a.id, html: doc(n), baseVersion: base, userId: pub.id }).version.number);
    const mine = core.apps.listVersions(appId).filter((v) => v.instanceId === a.id).map((v) => v.number);
    expect(mine).toHaveLength(20);
    expect(mine[0]).toBe(4);
    expect(mine[mine.length - 1]).toBe(base);
    expect(core.apps.getInstance(a.id)!.activeVersion).toBe(base);
    expect(core.apps.readVersionHtml(appId, base)).toBe(doc(21));
    expect(core.apps.listVersions(appId).filter((v) => v.instanceId === b.id).map((v) => v.number)).toEqual([2]);
    expect(core.apps.listVersions(appId)[0].number).toBe(1);
    expect(code(() => core.apps.readVersionHtml(appId, 3))).toBe('not_found');
    const trash = fs.readdirSync(path.join(dir, 'trash')).filter((n) => n.startsWith(`version-${appId}-3-`));
    expect(trash).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, 'trash', trash[0], 'index.html'), 'utf8')).toBe(doc(1));
    expect(fs.existsSync(path.join(dir, 'apps', appId, 'versions', '3'))).toBe(false);
  });

  it('saved bytes count toward the instance quota and an over-quota save is refused', () => {
    core.close();
    const small: Config = {
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lager-selfpub-q-')), port: 0, defaultLocale: 'en', publicUrl: new URL('http://lager.test'), appsDomain: 'apps.test',
      adminEmail: 'adm@x.y', adminPassword: 'pw', secret: 's', snapshotKeep: 20, trustProxy: false, instanceQuotaBytes: 1500,
    };
    core = createCore(small);
    admin = core.users.getByEmail('adm@x.y')!;
    const r = core.apps.deploy({ slug: 'poll', html: '<p>v1</p>', userId: admin.id, capabilities: { artifact: {} } });
    const inst = r.instances[0];
    const first = doc('one', 700 - doc('one').length);
    expect(Buffer.byteLength(first)).toBe(700);
    core.apps.selfPublish({ instanceId: inst.id, html: first, baseVersion: 1, userId: admin.id });
    expect(core.apps.savedBytes(inst.id)).toBe(700);
    core.apps.selfPublish({ instanceId: inst.id, html: doc('two', 700 - doc('two').length), baseVersion: 2, userId: admin.id });
    expect(code(() => core.apps.selfPublish({ instanceId: inst.id, html: doc('three', 200), baseVersion: 3, userId: admin.id }))).toBe('quota_exceeded');
    // refused: nothing changed and every document stays readable
    expect(core.apps.getInstance(inst.id)!.activeVersion).toBe(3);
    expect(core.apps.listVersions(r.app.id)).toHaveLength(3);
    expect(core.apps.readVersionHtml(r.app.id, 2)).toBe(first);
    // documents and uploads share the same budget: 1400 bytes saved, so 100 bytes of data fit only barely
    core.data.set(inst.id, 'a/b', { t: 'x' }, admin.id);
    expect(() => core.assets.put(inst.id, Buffer.from('x'.repeat(200)), 'text/plain', admin.id)).toThrow(/storage is full/);
    // a smaller replacement set frees room again: the quota counts what is stored
    core.apps.deleteInstance(inst.id, admin.id);
    expect(core.apps.savedBytes(inst.id)).toBe(0);
  });
});

describe('migration 5 (a database behind the latest still upgrades cleanly)', () => {
  it('keeps existing versions deployed', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-mig-'));
    const old = openPlatformDb(d);
    old.exec('ALTER TABLE versions DROP COLUMN instance_id');
    old.exec('DROP TABLE instance_domains');
    old.exec('ALTER TABLE users DROP COLUMN locale');
    old.exec('PRAGMA user_version = 4');
    old.exec('PRAGMA foreign_keys = OFF');
    old.exec(`INSERT INTO apps (id, slug, title, owner_id, created_at) VALUES ('a1', 'old', 'Old', 'o', 'x')`);
    old.exec(`INSERT INTO versions (app_id, number, sha256, size_bytes, capabilities, created_by, created_at) VALUES ('a1', 1, 's', 1, '{}', 'o', 'x')`);
    old.close();
    const db = openPlatformDb(d);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(7);
    expect(db.prepare('SELECT instance_id FROM versions').get()).toEqual({ instance_id: null });
    db.close();
  });
});
