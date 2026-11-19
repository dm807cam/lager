import crypto from 'node:crypto';
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
    icon_version INTEGER NOT NULL DEFAULT 0,
    -- The owner's choice of catalog model; NULL follows the version's \`complete.model\` declaration.
    ai_model_id TEXT REFERENCES ai_models(id) ON DELETE SET NULL
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
    disabled_at TEXT,
    show_badge INTEGER NOT NULL DEFAULT 1
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
  -- The model catalog: \`id\` is the name apps declare (\`complete: {model: "fast"}\`) and never changes.
  CREATE TABLE ai_models (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES ai_providers(id),
    model TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  -- \`model_id\` is the group's default model; NULL turns the language model off for the group.
  CREATE TABLE ai_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    model_id TEXT REFERENCES ai_models(id),
    hourly_limit INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  -- Further catalog models an app may pick for the people of a group, besides its default model.
  CREATE TABLE ai_group_models (
    group_id TEXT NOT NULL REFERENCES ai_groups(id) ON DELETE CASCADE,
    model_id TEXT NOT NULL REFERENCES ai_models(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, model_id)
  );
  CREATE UNIQUE INDEX ai_groups_name ON ai_groups(name COLLATE NOCASE) WHERE id != 'default';
  -- "Everyone else": the AI group of every person not assigned to another one; off until a model is chosen.
  INSERT INTO ai_groups (id, name, model_id, hourly_limit, created_at)
    VALUES ('default', '', NULL, 60, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `,
];

/**
 * A fingerprint of the first migration, kept in `PRAGMA application_id`. Before the first release that migration is
 * edited in place (ADR 0013), so a database created by an earlier pre-release build has the same `user_version` but
 * another schema; the fingerprint tells the two apart and Lager refuses to start instead of failing on missing columns.
 */
export const SCHEMA_FINGERPRINT = crypto.createHash('sha256').update(MIGRATIONS[0]!).digest().readInt32BE(0);

export function openPlatformDb(dataDir: string): DatabaseSync {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'platform.sqlite'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (row.user_version > MIGRATIONS.length) {
    db.close();
    throw new Error(`${path.join(dataDir, 'platform.sqlite')} has schema version ${row.user_version}, but this Lager knows only ${MIGRATIONS.length}. `
      + 'It was created by a newer or a pre-release build; use that build, or start with an empty data directory.');
  }
  const { application_id: fingerprint } = db.prepare('PRAGMA application_id').get() as { application_id: number };
  if (row.user_version >= 1 && fingerprint !== SCHEMA_FINGERPRINT) {
    db.close();
    throw new Error(`${path.join(dataDir, 'platform.sqlite')} was created by a pre-release build of Lager with a different schema. `
      + 'Export what you need with that build, then start with an empty data directory.');
  }
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]!);
      if (v === 0) db.exec(`PRAGMA application_id = ${SCHEMA_FINGERPRINT}`);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}
