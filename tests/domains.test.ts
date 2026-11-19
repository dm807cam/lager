import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { hostUrl } from '../src/config.js';
import { createCore, type Core } from '../src/core.js';
import { normalizeHost } from '../src/platform/domains.js';
import type { Instance } from '../src/platform/apps.js';
import type { User } from '../src/platform/users.js';

let core: Core;
let admin: User, pub: User, plain: User;
let notes: Instance, other: Instance;

beforeEach(() => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-domains-'));
  const config: Config = {
    dataDir, port: 0, defaultLocale: 'en', publicUrl: new URL('http://lager.localhost:8080'), appsDomain: 'apps.localhost', adminEmail: 'a@x.y', adminPassword: 'pw',
    secret: 's', snapshotKeep: 20, trustProxy: false, instanceQuotaBytes: 50 * 1024 * 1024,
  };
  core = createCore(config);
  admin = core.users.getByEmail('a@x.y')!;
  pub = core.users.create({ email: 'p@x.y', name: 'P', password: 'pw', role: 'publisher' });
  plain = core.users.create({ email: 'u@x.y', name: 'U', password: 'pw', role: 'user' });
  notes = core.apps.deploy({ slug: 'notes', html: '<p>1</p>', userId: pub.id }).instances[0];
  other = core.apps.deploy({ slug: 'other', html: '<p>2</p>', userId: pub.id }).instances[0];
});
afterEach(() => { core.close(); });

describe('normalizeHost', () => {
  it('lower-cases, trims a trailing dot and validates', () => {
    expect(normalizeHost('Notes.Example.COM.')).toBe('notes.example.com');
    for (const bad of ['localhost', 'a', 'ex ample.com', '1.2.3.4', '[::1]', 'a.com:8080', '-a.com', 'a-.com', 'a..com', '', '.a.com', 'a.com/x', 'a_b.com', `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.com`, `${'a'.repeat(64)}.com`]) {
      expect(() => normalizeHost(bad), bad).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
    }
    // A last label that does not start with a letter covers hex, octal and all-numeric IPv4 forms.
    for (const bad of ['0x7f.0x1', '127.1', '10.0.0.1', 'a.1b', 'a.123', 'a.0x7f', '*.example.com', 'a.*', '[2001:db8::1]', 'a_b.example.com', '::1']) {
      expect(() => normalizeHost(bad), bad).toThrow(expect.objectContaining({ code: 'invalid_argument', reason: 'host_invalid' }));
    }
    // Names that browsers or resolvers send to the local machine or network.
    for (const bad of ['localhost.', 'x.localhost', 'a.b.localhost', 'printer.local', 'a.b.local', 'db.internal', 'a.corp.internal', 'LOCALHOST.local']) {
      expect(() => normalizeHost(bad), bad).toThrow(expect.objectContaining({ code: 'invalid_argument', reason: 'host_invalid' }));
    }
    // Look-alikes and test names stay allowed.
    for (const ok of ['a.example', 'a.test', 'localhost.example.com', 'my-local.example.com', 'internal.example.com', 'a.xn--p1ai']) expect(normalizeHost(ok)).toBe(ok);
    expect(() => normalizeHost(undefined as never)).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
  });

  it('hostUrl keeps protocol and port of the public url', () => {
    expect(hostUrl(core.config, 'notes.example.com')).toBe('http://notes.example.com:8080');
    expect(hostUrl({ ...core.config, publicUrl: new URL('https://lager.example.com') }, 'a.b.c')).toBe('https://a.b.c');
  });
});

describe('Domains', () => {
  it('add/list/remove and lookup cache', () => {
    expect(core.domains.instanceIdFor('notes.example.com')).toBeNull();
    expect(core.domains.add(notes, 'Notes.Example.com.', admin, true)).toBe('notes.example.com');
    expect(core.domains.add(notes, 'b.example.com', admin, true)).toBe('b.example.com');
    expect(core.domains.list(notes.id)).toEqual(['b.example.com', 'notes.example.com']);
    expect(core.domains.instanceIdFor('notes.example.com')).toBe(notes.id);
    expect(core.domains.instanceIdFor('NOTES.example.com')).toBe(notes.id);
    expect(core.domains.remove(notes, 'notes.example.com', admin, true)).toBe(true);
    expect(core.domains.remove(notes, 'notes.example.com', admin, true)).toBe(false);
    expect(core.domains.instanceIdFor('notes.example.com')).toBeNull();
    expect(core.domains.list(notes.id)).toEqual(['b.example.com']);
    // Removing a host that belongs to another instance does nothing.
    expect(core.domains.remove(other, 'b.example.com', admin, true)).toBe(false);
    expect(core.domains.instanceIdFor('b.example.com')).toBe(notes.id);
  });

  it('refuses the platform host and anything under the apps domain', () => {
    for (const bad of ['lager.localhost', 'LAGER.localhost.', 'apps.localhost', 'x.apps.localhost', 'a.b.apps.localhost']) {
      expect(() => core.domains.add(notes, bad, admin, true), bad).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
    }
    expect(core.domains.list(notes.id)).toEqual([]);
  });

  it('refuses the platform host and the apps domain with host_unavailable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-domains-'));
    const c = createCore({ ...core.config, dataDir: dir, publicUrl: new URL('https://lager.example.test'), appsDomain: 'apps.example.test' });
    try {
      const a = c.users.getByEmail('a@x.y')!;
      const inst = c.apps.deploy({ slug: 'n', html: '<p>1</p>', userId: a.id }).instances[0];
      for (const bad of ['lager.example.test', 'apps.example.test', 'x.apps.example.test']) {
        expect(() => c.domains.add(inst, bad, a, true), bad).toThrow(expect.objectContaining({ reason: 'host_unavailable' }));
      }
    } finally { c.close(); }
  });

  it('allows at most 10 domains per instance', () => {
    for (let i = 0; i < 10; i++) core.domains.add(notes, `d${i}.example.com`, admin, true);
    expect(() => core.domains.add(notes, 'd10.example.com', admin, true)).toThrow(expect.objectContaining({ code: 'conflict', reason: 'domain_limit' }));
    core.domains.add(other, 'o.example.com', admin, true);
    core.domains.remove(notes, 'd0.example.com', admin, true);
    expect(core.domains.add(notes, 'd10.example.com', admin, true)).toBe('d10.example.com');
  });

  it('a host can be attached only once platform-wide', () => {
    core.domains.add(notes, 'a.example.com', admin, true);
    expect(() => core.domains.add(other, 'A.example.com', admin, true)).toThrow(expect.objectContaining({ code: 'conflict' }));
    expect(() => core.domains.add(notes, 'a.example.com', admin, true)).toThrow(expect.objectContaining({ code: 'conflict' }));
  });

  it('who may manage', () => {
    expect(core.domains.canManage(admin, false)).toBe(true);
    expect(core.domains.canManage(pub, true)).toBe(false);
    expect(core.settings.customDomains).toBe('admins');
    expect(() => core.domains.add(notes, 'a.example.com', pub, true)).toThrow(expect.objectContaining({ code: 'forbidden' }));
    core.settings.setCustomDomains('publishers');
    expect(core.domains.canManage(pub, true)).toBe(true);
    expect(core.domains.canManage(pub, false)).toBe(false);
    expect(core.domains.canManage(plain, true)).toBe(false);
    expect(core.domains.canManage(admin, false)).toBe(true);
    expect(core.domains.add(notes, 'a.example.com', pub, true)).toBe('a.example.com');
    expect(() => core.domains.add(notes, 'b.example.com', pub, false)).toThrow(expect.objectContaining({ code: 'forbidden' }));
    expect(() => core.domains.remove(notes, 'a.example.com', plain, true)).toThrow(expect.objectContaining({ code: 'forbidden' }));
    expect(core.domains.remove(notes, 'a.example.com', pub, true)).toBe(true);
    expect(() => core.settings.setCustomDomains('everyone' as never)).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
  });

  it('deleting the instance frees its domains', () => {
    core.domains.add(notes, 'a.example.com', admin, true);
    core.apps.deleteInstance(notes.id, pub.id);
    expect(core.domains.instanceIdFor('a.example.com')).toBeNull();
    expect(core.domains.list(notes.id)).toEqual([]);
    expect(core.domains.add(other, 'a.example.com', admin, true)).toBe('a.example.com');
  });

  it('survives a restart', () => {
    core.domains.add(notes, 'a.example.com', admin, true);
    const config = core.config;
    core.close();
    core = createCore(config);
    expect(core.domains.instanceIdFor('a.example.com')).toBe(notes.id);
  });
});
