import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, openPlatformDb } from '../src/platform/db.js';

let db: DatabaseSync | undefined;
afterEach(() => { db?.close(); db = undefined; });

/** A database at the schema before the AI groups migration, with the given settings, then upgraded. */
function upgradeFrom(settings: Record<string, string>): DatabaseSync {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-aimig-'));
  const old = new DatabaseSync(path.join(dir, 'platform.sqlite'));
  for (const m of MIGRATIONS.slice(0, -1)) old.exec(m);
  old.exec(`PRAGMA user_version = ${MIGRATIONS.length - 1}`);
  for (const [k, v] of Object.entries(settings)) old.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(k, v);
  old.close();
  db = openPlatformDb(dir);
  return db;
}

const providers = (d: DatabaseSync) => d.prepare('SELECT id, name, type, base_url, key_enc FROM ai_providers').all().map((r) => ({ ...r }));
const groups = (d: DatabaseSync) => d.prepare('SELECT id, name, provider_id, model, hourly_limit FROM ai_groups').all().map((r) => ({ ...r }));
const setting = (d: DatabaseSync, k: string) => (d.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | undefined)?.value;

describe('AI groups migration', () => {
  it('migrates a connected provider with key and limit', () => {
    const d = upgradeFrom({ ai_provider: 'anthropic', ai_model: 'claude-opus-5-5', ai_key: 'v1:a:b:c', ai_hourly_limit: '25', ai_max_tokens: '900' });
    expect(providers(d)).toEqual([{ id: 'migrated', name: 'Anthropic (Claude)', type: 'anthropic', base_url: null, key_enc: 'v1:a:b:c' }]);
    expect(groups(d)).toEqual([{ id: 'default', name: '', provider_id: 'migrated', model: 'claude-opus-5-5', hourly_limit: 25 }]);
    for (const k of ['ai_provider', 'ai_model', 'ai_base_url', 'ai_key', 'ai_hourly_limit']) expect(setting(d, k)).toBeUndefined();
    expect(setting(d, 'ai_max_tokens')).toBe('900');
  });

  it('migrates a custom server with its address', () => {
    const d = upgradeFrom({ ai_provider: 'custom', ai_model: 'm', ai_base_url: 'http://10.0.0.2:8000/v1' });
    expect(providers(d)).toEqual([{ id: 'migrated', name: 'Custom server', type: 'custom', base_url: 'http://10.0.0.2:8000/v1', key_enc: null }]);
    expect(groups(d)[0]).toMatchObject({ provider_id: 'migrated', model: 'm' });
  });

  it('a provider without a model becomes Off', () => {
    const d = upgradeFrom({ ai_provider: 'openai' });
    expect(providers(d)).toHaveLength(1);
    expect(groups(d)[0]).toMatchObject({ id: 'default', provider_id: null });
  });

  it('nothing configured gives an Off default group with the default limit', () => {
    const d = upgradeFrom({});
    expect(providers(d)).toEqual([]);
    expect(groups(d)).toEqual([{ id: 'default', name: '', provider_id: null, model: '', hourly_limit: 60 }]);
  });

  it('a bad stored limit falls back to 60', () => {
    expect(groups(upgradeFrom({ ai_hourly_limit: 'abc' }))[0].hourly_limit).toBe(60);
  });

  it('a fresh database has the default group and users can be assigned', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-aimig-'));
    db = openPlatformDb(dir);
    expect(groups(db).map((g) => g.id)).toEqual(['default']);
    const cols = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('ai_group_id');
  });
});
