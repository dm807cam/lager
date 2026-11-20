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
      expect({ ...db.prepare('SELECT disabled, token_generation FROM ingest_endpoints').get() }).toEqual({ disabled: 0, token_generation: 0 });
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
    fresh.close();
    migrated.close();
  });
});
