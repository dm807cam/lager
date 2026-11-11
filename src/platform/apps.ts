import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { assertSlug } from '../config.js';
import { LagerError } from '../errors.js';
import { lintArtifact } from './lint.js';
import type { Users } from './users.js';

export type RuleLevel = 'view' | 'interact' | 'admin' | 'owner' | 'self';
export interface DbRule { path: string; read?: RuleLevel; write?: RuleLevel }
export interface Capabilities { db?: { rules?: DbRule[] }; user?: { scopes?: string[] }; [k: string]: unknown }
export type Visibility = 'private' | 'users' | 'public';
export interface App { id: string; slug: string; title: string; ownerId: string; createdAt: string }
export interface Version {
  appId: string; number: number; sha256: string; sizeBytes: number;
  capabilities: Capabilities; note: string | null; createdBy: string; createdAt: string;
}
export interface Instance {
  id: string; appId: string; slug: string; ownerId: string;
  activeVersion: number; autoUpdate: boolean; visibility: Visibility; createdAt: string;
}
export interface DeployResult {
  app: App; version: Version; instances: Instance[]; warnings: string[];
  createdApp: boolean; createdVersion: boolean;
}
export type ActivateHook = (instance: Instance, from: number, to: number) => void;

const MAX_HTML_BYTES = 16 * 1024 * 1024;
const VISIBILITIES: Visibility[] = ['private', 'users', 'public'];

interface AppRow { id: string; slug: string; title: string; owner_id: string; created_at: string }
interface VersionRow {
  app_id: string; number: number; sha256: string; size_bytes: number;
  capabilities: string; note: string | null; created_by: string; created_at: string;
}
interface InstanceRow {
  id: string; app_id: string; slug: string; owner_id: string;
  active_version: number; auto_update: number; visibility: Visibility; created_at: string;
}

const toApp = (r: AppRow): App => ({ id: r.id, slug: r.slug, title: r.title, ownerId: r.owner_id, createdAt: r.created_at });
const toVersion = (r: VersionRow): Version => ({
  appId: r.app_id, number: r.number, sha256: r.sha256, sizeBytes: r.size_bytes,
  capabilities: JSON.parse(r.capabilities) as Capabilities, note: r.note, createdBy: r.created_by, createdAt: r.created_at,
});
const toInstance = (r: InstanceRow): Instance => ({
  id: r.id, appId: r.app_id, slug: r.slug, ownerId: r.owner_id, activeVersion: r.active_version,
  autoUpdate: r.auto_update !== 0, visibility: r.visibility, createdAt: r.created_at,
});

/** JSON with sorted object keys so equal capabilities always serialize identically. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export class Apps {
  private hooks: ActivateHook[] = [];

  constructor(private db: DatabaseSync, private dataDir: string, private users: Users) {}

  onBeforeActivate(hook: ActivateHook): void {
    this.hooks.push(hook);
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private versionFile(appId: string, number: number): string {
    return path.join(this.dataDir, 'apps', appId, 'versions', String(number), 'index.html');
  }

  private writeVersionFile(appId: string, number: number, html: string): void {
    const file = this.versionFile(appId, number);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, html);
    fs.renameSync(tmp, file);
  }

  private fireHooks(instance: Instance, from: number, to: number): void {
    for (const hook of this.hooks) hook(instance, from, to);
  }

  deploy(input: {
    slug: string; html: string; title?: string; capabilities?: Capabilities; note?: string; userId: string;
  }): DeployResult {
    assertSlug(input.slug);
    if (typeof input.html !== 'string' || input.html.trim() === '') {
      throw new LagerError('invalid_argument', 'HTML must not be empty.');
    }
    const sizeBytes = Buffer.byteLength(input.html);
    if (sizeBytes > MAX_HTML_BYTES) {
      throw new LagerError('invalid_argument', 'HTML exceeds the limit of 16 MiB.');
    }
    const user = this.users.get(input.userId);
    if (!user) throw new LagerError('forbidden', 'Unknown user.');
    if (user.role !== 'admin' && user.role !== 'publisher') {
      throw new LagerError('forbidden', 'Only admins and publishers can deploy apps.');
    }
    const capabilities = input.capabilities ?? {};
    const capabilitiesJson = canonicalJson(capabilities);
    const sha256 = crypto.createHash('sha256').update(input.html).digest('hex');
    const warnings = lintArtifact(input.html);

    return this.transaction(() => {
      const now = new Date().toISOString();
      const existing = this.db.prepare('SELECT * FROM apps WHERE slug = ?').get(input.slug) as AppRow | undefined;
      let app: App;
      let createdApp = false;
      if (existing) {
        app = toApp(existing);
        if (app.ownerId !== user.id) throw new LagerError('forbidden', `App "${app.slug}" belongs to another user.`);
        if (input.title && input.title !== app.title) {
          this.db.prepare('UPDATE apps SET title = ? WHERE id = ?').run(input.title, app.id);
          app = { ...app, title: input.title };
        }
      } else {
        if (this.db.prepare('SELECT 1 FROM instances WHERE slug = ?').get(input.slug)) {
          throw new LagerError('conflict', `Instance slug "${input.slug}" is already taken.`);
        }
        app = { id: crypto.randomUUID(), slug: input.slug, title: input.title || input.slug, ownerId: user.id, createdAt: now };
        this.db
          .prepare('INSERT INTO apps (id, slug, title, owner_id, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(app.id, app.slug, app.title, app.ownerId, app.createdAt);
        createdApp = true;
      }

      const latestRow = this.db
        .prepare('SELECT * FROM versions WHERE app_id = ? ORDER BY number DESC LIMIT 1')
        .get(app.id) as VersionRow | undefined;
      const latest = latestRow ? toVersion(latestRow) : undefined;

      let version: Version;
      let createdVersion = false;
      if (latest && latest.sha256 === sha256 && canonicalJson(latest.capabilities) === capabilitiesJson) {
        version = latest;
      } else {
        version = {
          appId: app.id, number: (latest?.number ?? 0) + 1, sha256, sizeBytes,
          capabilities: JSON.parse(capabilitiesJson) as Capabilities, note: input.note ?? null,
          createdBy: user.id, createdAt: now,
        };
        this.db
          .prepare(
            'INSERT INTO versions (app_id, number, sha256, size_bytes, capabilities, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(app.id, version.number, sha256, sizeBytes, capabilitiesJson, version.note, user.id, now);
        this.writeVersionFile(app.id, version.number, input.html);
        createdVersion = true;
      }

      if (createdApp) {
        this.db
          .prepare(
            'INSERT INTO instances (id, app_id, slug, owner_id, active_version, auto_update, visibility, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
          )
          .run(crypto.randomUUID(), app.id, app.slug, user.id, version.number, 'private', now);
      } else if (createdVersion) {
        const rows = this.db
          .prepare('SELECT * FROM instances WHERE app_id = ? AND auto_update = 1 AND active_version != ?')
          .all(app.id, version.number) as unknown as InstanceRow[];
        for (const row of rows) {
          this.fireHooks(toInstance(row), row.active_version, version.number);
          this.db.prepare('UPDATE instances SET active_version = ? WHERE id = ?').run(version.number, row.id);
        }
      }

      return { app, version, instances: this.listInstances(app.id), warnings, createdApp, createdVersion };
    });
  }

  getApp(slugOrId: string): App | null {
    const row = this.db.prepare('SELECT * FROM apps WHERE slug = ? OR id = ?').get(slugOrId, slugOrId) as AppRow | undefined;
    return row ? toApp(row) : null;
  }

  listApps(ownerId?: string): App[] {
    const rows = (
      ownerId
        ? this.db.prepare('SELECT * FROM apps WHERE owner_id = ? ORDER BY slug').all(ownerId)
        : this.db.prepare('SELECT * FROM apps ORDER BY slug').all()
    ) as unknown as AppRow[];
    return rows.map(toApp);
  }

  listVersions(appId: string): Version[] {
    const rows = this.db.prepare('SELECT * FROM versions WHERE app_id = ? ORDER BY number').all(appId) as unknown as VersionRow[];
    return rows.map(toVersion);
  }

  readVersionHtml(appId: string, number: number): string {
    if (!Number.isInteger(number) || !this.db.prepare('SELECT 1 FROM versions WHERE app_id = ? AND number = ?').get(appId, number)) {
      throw new LagerError('not_found', `Version ${number} not found.`);
    }
    return fs.readFileSync(this.versionFile(appId, number), 'utf8');
  }

  createInstance(input: { appId: string; slug: string; ownerId: string; visibility?: Visibility }): Instance {
    assertSlug(input.slug);
    const visibility = input.visibility ?? 'private';
    if (!VISIBILITIES.includes(visibility)) throw new LagerError('invalid_argument', `Invalid visibility "${visibility}".`);
    return this.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM apps WHERE id = ?').get(input.appId)) {
        throw new LagerError('not_found', 'App not found.');
      }
      if (!this.users.get(input.ownerId)) throw new LagerError('not_found', 'Owner not found.');
      if (this.db.prepare('SELECT 1 FROM instances WHERE slug = ?').get(input.slug)) {
        throw new LagerError('conflict', `Instance slug "${input.slug}" is already taken.`);
      }
      const latest = this.db.prepare('SELECT MAX(number) AS n FROM versions WHERE app_id = ?').get(input.appId) as { n: number | null };
      if (latest.n === null) throw new LagerError('not_found', 'App has no versions.');
      const id = crypto.randomUUID();
      this.db
        .prepare(
          'INSERT INTO instances (id, app_id, slug, owner_id, active_version, auto_update, visibility, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
        )
        .run(id, input.appId, input.slug, input.ownerId, latest.n, visibility, new Date().toISOString());
      return this.getInstance(id)!;
    });
  }

  getInstance(id: string): Instance | null {
    const row = this.db.prepare('SELECT * FROM instances WHERE id = ?').get(id) as InstanceRow | undefined;
    return row ? toInstance(row) : null;
  }

  getInstanceBySlug(slug: string): Instance | null {
    const row = this.db.prepare('SELECT * FROM instances WHERE slug = ?').get(slug) as InstanceRow | undefined;
    return row ? toInstance(row) : null;
  }

  listInstances(appId: string): Instance[] {
    const rows = this.db
      .prepare('SELECT * FROM instances WHERE app_id = ? ORDER BY created_at, slug')
      .all(appId) as unknown as InstanceRow[];
    return rows.map(toInstance);
  }

  private ownedInstance(instanceId: string, userId: string): Instance {
    const instance = this.getInstance(instanceId);
    if (!instance) throw new LagerError('not_found', 'Instance not found.');
    if (instance.ownerId !== userId) throw new LagerError('forbidden', 'Only the instance owner can do this.');
    return instance;
  }

  activate(instanceId: string, version: number, userId: string): Instance {
    return this.transaction(() => {
      const instance = this.ownedInstance(instanceId, userId);
      if (!this.db.prepare('SELECT 1 FROM versions WHERE app_id = ? AND number = ?').get(instance.appId, version)) {
        throw new LagerError('not_found', `Version ${version} not found.`);
      }
      if (instance.activeVersion !== version) {
        this.fireHooks(instance, instance.activeVersion, version);
        this.db.prepare('UPDATE instances SET active_version = ? WHERE id = ?').run(version, instance.id);
      }
      return this.getInstance(instanceId)!;
    });
  }

  setVisibility(instanceId: string, visibility: Visibility, userId: string): Instance {
    if (!VISIBILITIES.includes(visibility)) throw new LagerError('invalid_argument', `Invalid visibility "${visibility}".`);
    const instance = this.ownedInstance(instanceId, userId);
    this.db.prepare('UPDATE instances SET visibility = ? WHERE id = ?').run(visibility, instance.id);
    return this.getInstance(instanceId)!;
  }
}
