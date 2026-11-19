import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { createCore, type Core } from '../src/core.js';

let core: Core | undefined;
afterEach(() => { core?.close(); core = undefined; vi.restoreAllMocks(); });

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

  it('starts with the values of .env.example on this machine', async () => {
    const example = /^LAGER_ADMIN_PASSWORD=(.+)$/m.exec(fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8'))![1];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const urls = ['http://localhost:8080', 'http://lager.localhost:8080', 'http://localhost.:8080', 'http://127.0.0.1:8080', 'http://[::1]:8080'];
    for (const url of urls) {
      const c = makeWith({ publicUrl: new URL(url), adminPassword: example });
      expect((await c.users.checkLogin('admin@x.y', example)).ok, url).toBe(true);
      c.close();
    }
    // Accepted, but never silently: the port may be published beyond this machine.
    expect(warn).toHaveBeenCalledTimes(urls.length);
    expect(warn.mock.calls[0][0]).toMatch(new RegExp(`WARNING.*admin@x\\.y.*example password "${example}".*Change it`));
    // A password of one's own draws no warning, and neither does a later start with the example value still in the environment.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-core-'));
    makeWith({ dataDir, publicUrl: new URL('http://localhost:8080'), adminPassword: 'my-own-password' }).close();
    core = makeWith({ dataDir, publicUrl: new URL('http://localhost:8080'), adminPassword: example });
    expect(warn).toHaveBeenCalledTimes(urls.length);
  });

  it('refuses a short LAGER_SECRET on a first start, and only warns once accounts depend on it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-core-'));
    const base = { LAGER_PUBLIC_URL: 'http://lager.localhost:8080', LAGER_APPS_DOMAIN: 'apps.localhost', LAGER_DATA_DIR: dataDir, LAGER_ADMIN_EMAIL: 'admin@x.y', LAGER_ADMIN_PASSWORD: 'ci-password-123' };
    const short = loadConfig({ ...base, LAGER_SECRET: 'x'.repeat(31) });
    // Nothing is signed or encrypted with it yet: refuse, and say what changing it later would cost.
    expect(() => createCore(short)).toThrow(/LAGER_SECRET is shorter than 32 characters.*signs everyone out.*AI provider keys/s);
    expect(warn).not.toHaveBeenCalled();
    // An installation that has run with the short secret keeps starting: replacing it would sign everyone out and lose the AI keys.
    const first = createCore({ ...short, weakSecret: false });
    expect(first.users.count()).toBe(1);
    first.close();
    core = createCore(short);
    expect(core.users.count()).toBe(1);
    expect(core.config.secret).toBe('x'.repeat(31));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/WARNING: LAGER_SECRET is shorter than 32 characters.*signs everyone out.*AI provider keys.*entered again/s);
    core.close();
    // A secret of full length, and the generated one, start in silence on a fresh directory.
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-core-'));
    createCore(loadConfig({ ...base, LAGER_DATA_DIR: fresh, LAGER_SECRET: 'x'.repeat(32) })).close();
    core = createCore(loadConfig({ ...base, LAGER_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'lager-core-')) }));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('holds the first administrator to the minimum password length, on the first start only', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-core-'));
    expect(() => makeWith({ dataDir, adminPassword: 'too-short' })).toThrow(/LAGER_ADMIN_PASSWORD is too short.*at least 10 characters/);
    // Nothing was created, and the database is closed again: the corrected start succeeds on the same directory.
    const first = makeWith({ dataDir, adminPassword: 'ci-password-123' });
    expect((await first.users.checkLogin('admin@x.y', 'ci-password-123')).ok).toBe(true);
    first.close();
    // Once an account exists the variable is no longer read, so whatever it holds cannot stop a later start.
    core = makeWith({ dataDir, adminPassword: 'short' });
    expect(core.users.count()).toBe(1);
    expect((await core.users.checkLogin('admin@x.y', 'short')).ok).toBe(false);
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
