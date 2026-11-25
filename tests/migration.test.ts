import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, openPlatformDb } from '../src/platform/db.js';

/** A platform database as a build with only the baseline schema left it: version 1, with data in it. */
function versionOne(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-migrate-'));
  const db = new DatabaseSync(path.join(dir, 'platform.sqlite'));
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(MIGRATIONS[0]);
  db.exec('PRAGMA user_version = 1');
  const now = '2026-01-01T00:00:00.000Z';
  db.prepare('INSERT INTO users (id, email, name, role, password_hash, created_at, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('u1', 'ann@example.org', 'Ann', 'admin', 'scrypt$00$00', now, now);
  db.prepare('INSERT INTO apps (id, slug, title, owner_id, created_at) VALUES (?, ?, ?, ?, ?)').run('a1', 'notes', 'Notes', 'u1', now);
  db.prepare('INSERT INTO versions (app_id, number, sha256, size_bytes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('a1', 1, 'x', 1, 'u1', now);
  db.prepare('INSERT INTO instances (id, app_id, slug, owner_id, active_version, visibility, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('i1', 'a1', 'notes', 'u1', 1, 'public', now);
  db.prepare('INSERT INTO oauth_clients (client_id, metadata, issued_at, created_at) VALUES (?, ?, ?, ?)').run('c1', '{"redirect_uris":["https://x.example/cb"]}', 1, now);
  db.close();
  return dir;
}

describe('platform database migrations', () => {
  it('a version-1 database is brought up to date and keeps its data', () => {
    const dir = versionOne();
    const db = openPlatformDb(dir);
    try {
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);
      expect({ ...db.prepare('SELECT id, email, name, role FROM users').get() }).toEqual({ id: 'u1', email: 'ann@example.org', name: 'Ann', role: 'admin' });
      expect({ ...db.prepare('SELECT id, slug, visibility FROM instances').get() }).toEqual({ id: 'i1', slug: 'notes', visibility: 'public' });
      // Migration 2: the OAuth client is still there and has the new column, empty; the new table exists and works with the old rows.
      expect({ ...db.prepare('SELECT client_id, created_at, last_used_at FROM oauth_clients').get() })
        .toEqual({ client_id: 'c1', created_at: '2026-01-01T00:00:00.000Z', last_used_at: null });
      db.prepare('INSERT INTO instance_signins (user_id, instance_id, email, confirmed_at) VALUES (?, ?, ?, ?)').run('u1', 'i1', 1, '2026-02-01T00:00:00.000Z');
      expect(db.prepare('SELECT COUNT(*) AS n FROM instance_signins').get()).toMatchObject({ n: 1 });
      // Migration 3: the state of ingest endpoints, with its defaults.
      db.prepare('INSERT INTO ingest_endpoints (instance_id, name) VALUES (?, ?)').run('i1', 'hits');
      // Migration 4: the websites added per instance, none until someone adds them.
      expect({ ...db.prepare('SELECT disabled, token_generation, origins FROM ingest_endpoints').get() }).toEqual({ disabled: null, token_generation: 0, origins: null });
      expect(() => db.prepare('INSERT INTO ingest_endpoints (instance_id, name) VALUES (?, ?)').run('no-such-instance', 'hits')).toThrow();
      // The confirmation and the endpoint state go with their instance.
      db.prepare('DELETE FROM instances WHERE id = ?').run('i1');
      expect(db.prepare('SELECT COUNT(*) AS n FROM instance_signins').get()).toMatchObject({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM ingest_endpoints').get()).toMatchObject({ n: 0 });
    } finally {
      db.close();
    }
    // Opening it again changes nothing.
    const again = openPlatformDb(dir);
    expect((again.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);
    expect(again.prepare('SELECT COUNT(*) AS n FROM users').get()).toMatchObject({ n: 1 });
    again.close();
  });

  it('a version-3 database keeps the state of its ingest endpoints and gains the websites column', () => {
    const dir = versionOne();
    const old = new DatabaseSync(path.join(dir, 'platform.sqlite'));
    old.exec('PRAGMA foreign_keys = ON');
    old.exec(MIGRATIONS[1]);
    old.exec(MIGRATIONS[2]);
    old.exec('PRAGMA user_version = 3');
    old.prepare('INSERT INTO ingest_endpoints (instance_id, name, disabled, token_generation) VALUES (?, ?, ?, ?)').run('i1', 'hits', 1, 2);
    old.close();
    const db = openPlatformDb(dir);
    try {
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);
      expect({ ...db.prepare('SELECT instance_id, name, disabled, token_generation, origins FROM ingest_endpoints').get() })
        .toEqual({ instance_id: 'i1', name: 'hits', disabled: 1, token_generation: 2, origins: null });
    } finally {
      db.close();
    }
  });

  it('a version-4 database keeps its ingest websites and gains the table of embedding websites', () => {
    const dir = versionOne();
    const old = new DatabaseSync(path.join(dir, 'platform.sqlite'));
    old.exec('PRAGMA foreign_keys = ON');
    old.exec(MIGRATIONS[1]);
    old.exec(MIGRATIONS[2]);
    old.exec(MIGRATIONS[3]);
    old.exec('PRAGMA user_version = 4');
    old.prepare('INSERT INTO ingest_endpoints (instance_id, name, origins) VALUES (?, ?, ?)').run('i1', 'hits', '["https://blog.example.com"]');
    old.close();
    const db = openPlatformDb(dir);
    try {
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);
      expect({ ...db.prepare('SELECT origins FROM ingest_endpoints').get() }).toEqual({ origins: '["https://blog.example.com"]' });
      expect(db.prepare('SELECT COUNT(*) AS n FROM embed_origins').get()).toMatchObject({ n: 0 });
    } finally {
      db.close();
    }
  });

  it('a version-5 database keeps its accounts and gains the tables of two-step sign-in, which go with the account', () => {
    const dir = versionOne();
    const old = new DatabaseSync(path.join(dir, 'platform.sqlite'));
    old.exec('PRAGMA foreign_keys = ON');
    for (const m of MIGRATIONS.slice(1, 5)) old.exec(m);
    old.exec('PRAGMA user_version = 5');
    old.close();
    const db = openPlatformDb(dir);
    try {
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);
      expect(db.prepare('SELECT COUNT(*) AS n FROM user_two_factor').get()).toMatchObject({ n: 0 });
      db.prepare('INSERT INTO user_two_factor (user_id, secret_enc, created_at) VALUES (?, ?, ?)').run('u1', 'v1:x:y:z', '2026-11-21T00:00:00.000Z');
      db.prepare('INSERT INTO user_recovery_codes (code_hash, user_id) VALUES (?, ?)').run('h1', 'u1');
      expect({ ...db.prepare('SELECT confirmed_at, last_step, failures, lock_level, locked_until FROM user_two_factor').get() })
        .toEqual({ confirmed_at: null, last_step: 0, failures: 0, lock_level: 0, locked_until: 0 });
      expect(() => db.prepare('INSERT INTO user_two_factor (user_id, secret_enc, created_at) VALUES (?, ?, ?)').run('no-such-user', 'v1:x:y:z', 'x')).toThrow();
      // The account owns an app here, so its second factor is removed the way account removal removes it.
      db.prepare('DELETE FROM user_recovery_codes WHERE user_id = ?').run('u1');
      db.prepare('DELETE FROM user_two_factor WHERE user_id = ?').run('u1');
      expect(db.prepare('SELECT COUNT(*) AS n FROM user_two_factor').get()).toMatchObject({ n: 0 });
    } finally {
      db.close();
    }
  });

  it('a version-6 database keeps its apps and groups, which follow the default storage until an administrator sets one', () => {
    const dir = versionOne();
    const old = new DatabaseSync(path.join(dir, 'platform.sqlite'));
    old.exec('PRAGMA foreign_keys = ON');
    for (const m of MIGRATIONS.slice(1, 6)) old.exec(m);
    old.exec('PRAGMA user_version = 6');
    old.prepare('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run('g1', 'Team', '2026-11-21T00:00:00.000Z');
    old.close();
    const db = openPlatformDb(dir);
    try {
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);
      expect({ ...db.prepare('SELECT slug, quota_bytes FROM apps').get() }).toEqual({ slug: 'notes', quota_bytes: null });
      expect({ ...db.prepare('SELECT name, quota_bytes FROM groups').get() }).toEqual({ name: 'Team', quota_bytes: null });
    } finally {
      db.close();
    }
  });

  it('a fresh database and a migrated one have the same schema', () => {
    const schema = (db: DatabaseSync): string[] =>
      (db.prepare("SELECT name FROM pragma_table_list WHERE schema = 'main' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>)
        .flatMap((table) => (db.prepare(`SELECT name, type FROM pragma_table_info('${table.name}') ORDER BY name`).all() as Array<{ name: string; type: string }>)
          .map((column) => `${table.name}.${column.name} ${column.type}`));
    const fresh = openPlatformDb(fs.mkdtempSync(path.join(os.tmpdir(), 'lager-migrate-')));
    const migrated = openPlatformDb(versionOne());
    expect(schema(migrated)).toEqual(schema(fresh));
    expect(schema(fresh)).toContain('oauth_clients.last_used_at TEXT');
    expect(schema(fresh)).toContain('ingest_endpoints.token_generation INTEGER');
    expect(schema(fresh)).toContain('ingest_endpoints.origins TEXT');
    expect(schema(fresh)).toContain('embed_origins.origins TEXT');
    expect(schema(fresh)).toContain('user_two_factor.secret_enc TEXT');
    expect(schema(fresh)).toContain('user_recovery_codes.code_hash TEXT');
    expect(schema(fresh)).toContain('apps.quota_bytes INTEGER');
    expect(schema(fresh)).toContain('groups.quota_bytes INTEGER');
    fresh.close();
    migrated.close();
  });
});
