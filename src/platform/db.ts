import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS: string[] = [
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
