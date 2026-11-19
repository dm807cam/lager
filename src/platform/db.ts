import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Schema changes of the platform database, applied in order and counted in `PRAGMA user_version`.
 * The first entry is the complete schema; append a new entry for every later change, never edit a released one.
 */
export const MIGRATIONS: string[] = [
  `
  -- accounts
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','publisher','user')),
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    verified_at TEXT,
    disabled_at TEXT,
    session_epoch INTEGER NOT NULL DEFAULT 0,
    locale TEXT,
    ai_group_id TEXT
  );
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
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  -- apps, versions and instances
  CREATE TABLE apps (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    self_instances TEXT NOT NULL DEFAULT 'off',
    next_version INTEGER NOT NULL DEFAULT 1,
    description TEXT NOT NULL DEFAULT '',
    theme_color TEXT NOT NULL DEFAULT '#1f2a5c',
    icon_version INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE app_collaborators (
    app_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (app_id, user_id)
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
    instance_id TEXT,
    PRIMARY KEY (app_id, number)
  );
  CREATE INDEX versions_instance ON versions(instance_id);
  CREATE TABLE instances (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES apps(id),
    slug TEXT NOT NULL UNIQUE,
    owner_id TEXT NOT NULL REFERENCES users(id),
    active_version INTEGER NOT NULL,
    auto_update INTEGER NOT NULL DEFAULT 1,
    visibility TEXT NOT NULL CHECK (visibility IN ('private','users','public')),
    created_at TEXT NOT NULL,
    users_level TEXT NOT NULL DEFAULT 'interact',
    disabled_at TEXT
  );
  CREATE INDEX instances_app ON instances(app_id);
  CREATE TABLE grants (
    instance_id TEXT NOT NULL,
    principal_type TEXT NOT NULL CHECK (principal_type IN ('user','group')),
    principal_id TEXT NOT NULL,
    level TEXT NOT NULL CHECK (level IN ('view','interact','admin')),
    created_by TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (instance_id, principal_type, principal_id)
  );
  CREATE TABLE instance_domains (
    host TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX instance_domains_instance ON instance_domains(instance_id);
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

  -- API tokens and the OAuth server of the MCP connector
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

  -- language models for lager.complete: providers, and AI groups that route people to them
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
  -- "Everyone else": the AI group of every person not assigned to another one; off until a provider is chosen.
  INSERT INTO ai_groups (id, name, provider_id, model, hourly_limit, created_at)
    VALUES ('default', '', NULL, '', 60, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
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
