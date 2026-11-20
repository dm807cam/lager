import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backup } from '../src/backup.js';
import { createCore } from '../src/core.js';
import { makeHarness, type Harness } from './support/http.js';

let h: Harness | undefined;
afterEach(() => { h?.core.close(); h = undefined; vi.restoreAllMocks(); });

describe('backup', () => {
  it('includes what an instance received from outside, which snapshots leave out', () => {
    h = makeHarness();
    const { core } = h;
    const inst = core.apps.deploy({ slug: 'stats', html: '<p>v1</p>', userId: h.adminId }).instances[0];
    core.data.set(inst.id, 'notes/n1', { text: 'own' }, h.adminId);
    core.data.ingest(inst.id, 'hits/h1', { path: '/' }, { by: null, rotate: false });
    const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lager-backup-')), 'copy');
    backup(core.config.dataDir, target);
    expect(fs.readdirSync(path.join(target, 'instances', inst.id)).sort()).toEqual(['data.sqlite', 'inbox.sqlite']);
    // A server started on the copy reads both.
    const restored = createCore({ ...core.config, dataDir: target });
    try {
      expect(restored.data.get(inst.id, 'notes/n1')?.data).toEqual({ text: 'own' });
      expect(restored.data.get(inst.id, 'hits/h1')?.data).toEqual({ path: '/' });
    } finally {
      restored.close();
    }
  });

  it('copies a running data directory into one that starts up with the same content', () => {
    h = makeHarness();
    const { core } = h;
    const dir = core.config.dataDir;
    const r = core.apps.deploy({ slug: 'notes', html: '<p>v1</p>', userId: h.adminId });
    core.data.set(r.instances[0].id, 'notes/n1', { text: 'kept' }, h.adminId);
    fs.mkdirSync(path.join(dir, 'trash', 'old'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'trash', 'old', 'x'), 'x');
    fs.writeFileSync(path.join(dir, 'half.tmp'), 'x');
    // The harness passes its secret in the config; a real data directory holds the generated key file.
    fs.writeFileSync(path.join(dir, 'secret.key'), 'k\n', { mode: 0o600 });

    const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lager-backup-')), 'copy');
    // The server still holds its databases open (WAL mode) while the backup runs.
    const result = backup(dir, target);
    expect(result.databases).toBeGreaterThanOrEqual(2);
    expect(result.files).toBeGreaterThanOrEqual(2);

    const names = fs.readdirSync(target, { recursive: true }).map(String);
    expect(names.some((n) => /-(wal|shm)$/.test(n))).toBe(false);
    expect(names).not.toContain('trash');
    expect(names).not.toContain('half.tmp');
    expect(fs.readFileSync(path.join(target, 'secret.key'), 'utf8')).toBe(fs.readFileSync(path.join(dir, 'secret.key'), 'utf8'));
    expect(fs.statSync(path.join(target, 'secret.key')).mode & 0o777).toBe(0o600);
    const check = new DatabaseSync(path.join(target, 'platform.sqlite'), { readOnly: true });
    expect(check.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    check.close();

    // A write after the backup is not in it; a server started on the copy sees the state at backup time.
    core.data.set(r.instances[0].id, 'notes/n2', { text: 'later' }, h.adminId);
    const restored = createCore({ ...core.config, dataDir: target });
    try {
      const inst = restored.apps.getInstanceBySlug('notes')!;
      expect(restored.apps.readVersionHtml(inst.appId, 1)).toBe('<p>v1</p>');
      expect(restored.data.query(inst.id, 'notes').map((d) => d.data)).toEqual([{ text: 'kept' }]);
      expect(restored.users.getByEmail('admin@x.y')).not.toBeNull();
    } finally {
      restored.close();
    }
  });

  it('refuses a target inside the data directory, a used target and a directory that is not Lager\'s', () => {
    h = makeHarness();
    const dir = h.core.config.dataDir;
    expect(() => backup(dir, path.join(dir, 'backup'))).toThrow(/outside/);
    expect(() => backup(dir, dir)).toThrow(/outside/);
    const used = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-backup-'));
    fs.writeFileSync(path.join(used, 'something'), 'x');
    expect(() => backup(dir, used)).toThrow(/not empty/);
    expect(() => backup(fs.mkdtempSync(path.join(os.tmpdir(), 'lager-empty-')), path.join(used, 'new'))).toThrow(/not a Lager data directory/);
  });
});

describe('access log', () => {
  it('writes one line per request without the query string, and nothing when it is off', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
    h = makeHarness({ accessLog: true });
    await request(h.app).get('/login').query({ return: '/secret?code=abc' }).set('Host', h.host);
    await new Promise((r) => setTimeout(r, 10));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z \S+ GET lager\.localhost:8080\/login 200 \d+ms$/);
    h.core.close();
    h = makeHarness();
    await request(h.app).get('/login').set('Host', h.host);
    await new Promise((r) => setTimeout(r, 10));
    expect(lines).toHaveLength(1);
  });
});
