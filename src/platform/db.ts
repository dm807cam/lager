import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','publisher','user')),
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE apps (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE versions (
    app_id TEXT NOT NULL REFERENCES apps(id),
    number INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    capabilities TEXT NOT NULL DEFAULT '{}',
    note TEXT,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (app_id, number)
  );
  CREATE TABLE instances (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES apps(id),
    slug TEXT NOT NULL UNIQUE,
    owner_id TEXT NOT NULL REFERENCES users(id),
    active_version INTEGER NOT NULL,
    auto_update INTEGER NOT NULL DEFAULT 1,
    visibility TEXT NOT NULL CHECK (visibility IN ('private','users','public')),
    created_at TEXT NOT NULL
  );
  CREATE INDEX instances_app ON instances(app_id);
  `,
  `
  CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );
  CREATE INDEX api_tokens_user ON api_tokens(user_id);
  CREATE TABLE oauth_clients (
    client_id TEXT PRIMARY KEY,
    secret_hash TEXT,
    secret_expires_at INTEGER,
    metadata TEXT NOT NULL,
    issued_at INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE oauth_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
    user_id TEXT NOT NULL REFERENCES users(id),
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    scopes TEXT NOT NULL,
    resource TEXT,
    grant_id TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE oauth_tokens (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('access','refresh')),
    client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
    user_id TEXT NOT NULL REFERENCES users(id),
    grant_id TEXT NOT NULL,
    scopes TEXT NOT NULL,
    resource TEXT,
    used INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX oauth_tokens_grant ON oauth_tokens(grant_id);
  `,
  `
  ALTER TABLE users ADD COLUMN verified_at TEXT;
  ALTER TABLE users ADD COLUMN disabled_at TEXT;
  ALTER TABLE users ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0;
  UPDATE users SET verified_at = created_at;
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE account_tokens (
    hash TEXT PRIMARY KEY,
    id TEXT UNIQUE NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('verify','reset','invite')),
    user_id TEXT,
    email TEXT,
    role TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );
  CREATE TABLE groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE group_members (
    group_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (group_id, user_id)
  );
  CREATE TABLE grants (
    instance_id TEXT NOT NULL,
    principal_type TEXT NOT NULL CHECK (principal_type IN ('user','group')),
    principal_id TEXT NOT NULL,
    level TEXT NOT NULL CHECK (level IN ('view','interact','admin')),
    created_by TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (instance_id, principal_type, principal_id)
  );
  CREATE TABLE app_collaborators (
    app_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (app_id, user_id)
  );
  ALTER TABLE apps ADD COLUMN self_instances TEXT NOT NULL DEFAULT 'off';
  ALTER TABLE instances ADD COLUMN users_level TEXT NOT NULL DEFAULT 'interact';
  ALTER TABLE instances ADD COLUMN disabled_at TEXT;
  `,
  `
  CREATE TABLE retired_slugs (
    slug TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    retired_at TEXT NOT NULL
  );
  CREATE TABLE instance_creations (
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX instance_creations_user ON instance_creations(user_id, created_at);
  `,
  `
  ALTER TABLE versions ADD COLUMN instance_id TEXT;
  `,
  `
  CREATE TABLE instance_domains (
    host TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX instance_domains_instance ON instance_domains(instance_id);
  `,
  `
  ALTER TABLE users ADD COLUMN locale TEXT;
  `,
  `
  ALTER TABLE apps ADD COLUMN next_version INTEGER NOT NULL DEFAULT 1;
  UPDATE apps SET next_version = COALESCE((SELECT MAX(number) FROM versions WHERE versions.app_id = apps.id), 0) + 1;
  CREATE INDEX versions_instance ON versions(instance_id);
  `,
  `
  ALTER TABLE apps ADD COLUMN description TEXT NOT NULL DEFAULT '';
  ALTER TABLE apps ADD COLUMN theme_color TEXT NOT NULL DEFAULT '#1f2a5c';
  ALTER TABLE apps ADD COLUMN icon_version INTEGER NOT NULL DEFAULT 0;
  `,
  // Several language model providers and AI groups; the single provider of earlier versions moves over.
  `
  CREATE TABLE ai_providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    type TEXT NOT NULL,
    base_url TEXT,
    key_enc TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE ai_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider_id TEXT,
    model TEXT NOT NULL DEFAULT '',
    hourly_limit INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX ai_groups_name ON ai_groups(name COLLATE NOCASE) WHERE id != 'default';
  ALTER TABLE users ADD COLUMN ai_group_id TEXT;
  INSERT INTO ai_providers (id, name, type, base_url, key_enc, created_at)
    SELECT 'migrated',
      CASE value WHEN 'anthropic' THEN 'Anthropic (Claude)' WHEN 'openai' THEN 'OpenAI' WHEN 'openrouter' THEN 'OpenRouter'
        WHEN 'deepseek' THEN 'DeepSeek' WHEN 'gemini' THEN 'Google Gemini' WHEN 'mistral' THEN 'Mistral' WHEN 'groq' THEN 'Groq'
        WHEN 'ollama' THEN 'Ollama' ELSE 'Custom server' END,
      value,
      NULLIF((SELECT value FROM settings WHERE key = 'ai_base_url'), ''),
      NULLIF((SELECT value FROM settings WHERE key = 'ai_key'), ''),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM settings WHERE key = 'ai_provider' AND value IN ('anthropic','openai','openrouter','deepseek','gemini','mistral','groq','ollama','custom');
  INSERT INTO ai_groups (id, name, provider_id, model, hourly_limit, created_at) VALUES ('default', '',
    CASE WHEN EXISTS (SELECT 1 FROM ai_providers WHERE id = 'migrated') AND COALESCE((SELECT value FROM settings WHERE key = 'ai_model'), '') != '' THEN 'migrated' END,
    COALESCE((SELECT value FROM settings WHERE key = 'ai_model'), ''),
    COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'ai_hourly_limit' AND value GLOB '[0-9]*' AND value NOT GLOB '*[^0-9]*' AND CAST(value AS INTEGER) BETWEEN 1 AND 10000), 60),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  DELETE FROM settings WHERE key IN ('ai_provider', 'ai_model', 'ai_base_url', 'ai_key', 'ai_hourly_limit');
  `,
];

export function openPlatformDb(dataDir: string): DatabaseSync {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'platform.sqlite'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}
