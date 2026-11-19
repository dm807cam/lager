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
let dir: string;
let admin: User;
let pub: User;
let usr: User;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-selfpub-'));
  const config: Config = {
    dataDir: dir, port: 0, defaultLocale: 'en', publicUrl: new URL('http://lager.test'), appsDomain: 'apps.test', adminEmail: 'adm@x.y', adminPassword: 'admin-password-1',
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
  const r = core.apps.deploy({ slug: 'poll', html: '<p>v1</p>', userId: pub.id, capabilities: { page: {} } });
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
    expect(r.version.capabilities).toEqual({ page: {} });
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
    const d = core.apps.deploy({ slug: 'poll', html: '<p>new</p>', userId: pub.id, capabilities: { page: {} } });
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
    const same = core.apps.deploy({ slug: 'poll', html: '<p>v1</p>', userId: pub.id, capabilities: { page: {} } });
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

  it('selfPublish takes no data snapshot, deploy-driven and manual activations still do', () => {
    const { a } = setup();
    core.data.set(a.id, 'votes/a', { n: 1 }, pub.id);
    core.apps.selfPublish({ instanceId: a.id, html: '<p>mine</p>', baseVersion: 1, userId: pub.id });
    expect(core.data.listSnapshots(a.id)).toEqual([]);
    core.apps.activate(a.id, 1, pub.id);
    expect(core.data.listSnapshots(a.id).map((s) => s.label)).toEqual(['v2-to-v1']);
  });

  it('setAutoUpdate(true) moves the instance to the latest deployed version at once', () => {
    const { a } = setup();
    core.data.set(a.id, 'votes/a', { n: 1 }, pub.id);
    core.apps.selfPublish({ instanceId: a.id, html: '<p>mine</p>', baseVersion: 1, userId: pub.id });
    const on = core.apps.setAutoUpdate(a.id, true, pub.id);
    expect(on).toMatchObject({ autoUpdate: true, activeVersion: 1 });
    expect(core.data.listSnapshots(a.id).map((s) => s.label)).toEqual(['v2-to-v1']);
    // Switching it off never moves the instance.
    expect(core.apps.setAutoUpdate(a.id, false, pub.id)).toMatchObject({ autoUpdate: false, activeVersion: 1 });
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
  it('the 21st save prunes the oldest, keeps the active one and deletes the pruned html outright', () => {
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
    // Pruned versions are gone from rows and disk, and nothing of them lands in the trash (no quota counts it).
    expect(fs.existsSync(path.join(dir, 'apps', appId, 'versions', '3'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'trash'))).toBe(false);
    const holds = (folder: string): boolean => fs.readdirSync(folder, { withFileTypes: true }).some((e) => {
      const p = path.join(folder, e.name);
      return e.isDirectory() ? holds(p) : fs.readFileSync(p, 'utf8') === doc(1);
    });
    expect(holds(path.join(dir, 'apps'))).toBe(false);
    // Numbers are never reused: the next save continues after the highest number ever issued.
    expect(Number(core.apps.selfPublish({ instanceId: a.id, html: doc(22), baseVersion: base, userId: pub.id }).version.number)).toBe(base + 1);
  });

  it('version numbers are never reused after the newest saved versions were removed', () => {
    const { a, appId } = setup();
    const first = Number(core.apps.selfPublish({ instanceId: a.id, html: doc('x'), baseVersion: 1, userId: pub.id }).version.number);
    core.apps.activate(a.id, 1, pub.id);
    core.apps.deleteInstance(a.id, pub.id);
    const d = core.apps.deploy({ slug: 'poll', html: '<p>next</p>', userId: pub.id });
    expect(d.version.number).toBeGreaterThan(first);
    expect(core.apps.listVersions(appId).filter((v) => v.number === first)).toEqual([]);
  });

  it('saved bytes count toward the instance quota and an over-quota save is refused', () => {
    core.close();
    const small: Config = {
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lager-selfpub-q-')), port: 0, defaultLocale: 'en', publicUrl: new URL('http://lager.test'), appsDomain: 'apps.test',
      adminEmail: 'adm@x.y', adminPassword: 'admin-password-1', secret: 's', snapshotKeep: 20, trustProxy: false, instanceQuotaBytes: 1500,
    };
    core = createCore(small);
    admin = core.users.getByEmail('adm@x.y')!;
    const r = core.apps.deploy({ slug: 'poll', html: '<p>v1</p>', userId: admin.id, capabilities: { page: {} } });
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

describe('platform database schema version', () => {
  it('refuses a database whose schema is newer than this build knows', async () => {
    const { openPlatformDb, MIGRATIONS } = await import('../src/platform/db.js');
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-schema-'));
    const fresh = openPlatformDb(d);
    expect((fresh.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);
    expect(fresh.prepare('SELECT id, model_id, hourly_limit FROM ai_groups').all().map((r) => ({ ...r }))).toEqual([{ id: 'default', model_id: null, hourly_limit: 60 }]);
    fresh.exec('PRAGMA user_version = 10');
    fresh.close();
    expect(() => openPlatformDb(d)).toThrow(/schema version 10, but this Lager knows only 1/);
    // Opening a current database again runs nothing and changes nothing.
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-schema-'));
    openPlatformDb(d2).close();
    const again = openPlatformDb(d2);
    expect((again.prepare('SELECT COUNT(*) AS n FROM ai_groups').get() as { n: number }).n).toBe(1);
    again.close();
  });
});
