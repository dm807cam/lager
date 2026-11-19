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
    adminEmail: 'admin@x.y', adminPassword: 'admin-password-1', secret: 's', snapshotKeep: 20, trustProxy: false,
  };
  core = createCore(config);
  return core;
}

function makeWith(overrides: Partial<Config>): Core {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-core-'));
  return createCore({
    dataDir, port: 0, defaultLocale: 'en', publicUrl: new URL('http://lager.test'), appsDomain: 'apps.test',
    adminEmail: 'admin@x.y', adminPassword: 'admin-password-1', secret: 's', snapshotKeep: 20, trustProxy: false, ...overrides,
  });
}

describe('core', () => {
  it('refuses the placeholder admin password wherever other machines reach Lager, https or not', () => {
    const example = /^LAGER_ADMIN_PASSWORD=(.+)$/m.exec(fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8'))![1];
    for (const url of ['https://lager.example.org', 'http://lager.example.org', 'http://192.168.1.20:8080', 'http://lager.lan:8080']) {
      for (const adminPassword of [example, 'bitte-aendern', 'change-me']) {
        expect(() => makeWith({ publicUrl: new URL(url), adminPassword }), `${url} ${adminPassword}`)
          .toThrow(new RegExp(`LAGER_ADMIN_PASSWORD.*${adminPassword}`));
      }
    }
  });

  it('starts with the values of .env.example on this machine', () => {
    const example = /^LAGER_ADMIN_PASSWORD=(.+)$/m.exec(fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8'))![1];
    for (const url of ['http://localhost:8080', 'http://lager.localhost:8080', 'http://127.0.0.1:8080', 'http://[::1]:8080']) {
      const c = makeWith({ publicUrl: new URL(url), adminPassword: example });
      expect(c.users.checkLogin('admin@x.y', example).ok, url).toBe(true);
      c.close();
    }
    core = makeWith({ publicUrl: new URL('http://lager.localhost:8080'), adminPassword: 'bitte-aendern' });
    expect(core.users.count()).toBe(1);
  });

  it('holds the first administrator to the minimum password length, on the first start only', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-core-'));
    expect(() => makeWith({ dataDir, adminPassword: 'too-short' })).toThrow(/LAGER_ADMIN_PASSWORD is too short.*at least 10 characters/);
    // Nothing was created, and the database is closed again: the corrected start succeeds on the same directory.
    const first = makeWith({ dataDir, adminPassword: 'ci-password-123' });
    expect(first.users.checkLogin('admin@x.y', 'ci-password-123').ok).toBe(true);
    first.close();
    // Once an account exists the variable is no longer read, so whatever it holds cannot stop a later start.
    core = makeWith({ dataDir, adminPassword: 'short' });
    expect(core.users.count()).toBe(1);
    expect(core.users.checkLogin('admin@x.y', 'short').ok).toBe(false);
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
