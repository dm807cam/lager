import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { createCore, type Core } from '../src/core.js';

let core: Core | undefined;
afterEach(() => { core?.close(); core = undefined; });

function make(): Core {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-core-'));
  const config: Config = {
    dataDir, port: 0, defaultLocale: 'en', publicUrl: new URL('http://lager.test'), appsDomain: 'apps.test',
    adminEmail: 'admin@x.y', adminPassword: 'pw', secret: 's', snapshotKeep: 20, trustProxy: false,
  };
  core = createCore(config);
  return core;
}

function makeWith(overrides: Partial<Config>): Core {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-core-'));
  return createCore({
    dataDir, port: 0, defaultLocale: 'en', publicUrl: new URL('http://lager.test'), appsDomain: 'apps.test',
    adminEmail: 'admin@x.y', adminPassword: 'pw', secret: 's', snapshotKeep: 20, trustProxy: false, ...overrides,
  });
}

describe('core', () => {
  it('refuses the placeholder admin password on https, but allows it on http', () => {
    expect(() => makeWith({ publicUrl: new URL('https://lager.example.org'), adminPassword: 'bitte-aendern' }))
      .toThrow(/bitte-aendern/);
    core = makeWith({ publicUrl: new URL('http://lager.localhost:8080'), adminPassword: 'bitte-aendern' });
    expect(core.users.count()).toBe(1);
  });

  it('bootstraps admin', () => {
    expect(make().users.count()).toBe(1);
  });

  it('activate snapshots data and keeps it', () => {
    const c = make();
    const admin = c.users.list()[0];
    const r1 = c.apps.deploy({ slug: 'todo', html: '<p>v1</p>', userId: admin.id });
    const inst = r1.instances[0];
    c.data.set(inst.id, 'tasks/a', { n: 1 }, admin.id);
    c.apps.deploy({ slug: 'todo', html: '<p>v2</p>', userId: admin.id });
    expect(c.apps.getInstance(inst.id)!.activeVersion).toBe(2);
    expect(c.data.listSnapshots(inst.id).map((s) => s.label)).toEqual(['v1-to-v2']);
    c.data.set(inst.id, 'tasks/b', { n: 2 }, admin.id);
    c.apps.activate(inst.id, 1, admin.id);
    expect(c.data.get(inst.id, 'tasks/a')!.data).toEqual({ n: 1 });
    expect(c.data.get(inst.id, 'tasks/b')!.data).toEqual({ n: 2 });
    expect(c.data.listSnapshots(inst.id).map((s) => s.label)).toContain('v2-to-v1');
  });

  it('deploy without data creates no snapshot', () => {
    const c = make();
    const admin = c.users.list()[0];
    const r = c.apps.deploy({ slug: 'todo', html: '<p>v1</p>', userId: admin.id });
    c.apps.deploy({ slug: 'todo', html: '<p>v2</p>', userId: admin.id });
    expect(c.data.listSnapshots(r.instances[0].id)).toEqual([]);
    expect(c.data.hasData(r.instances[0].id)).toBe(false);
  });
});
