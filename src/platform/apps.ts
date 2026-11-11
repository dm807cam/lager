import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { assertSlug } from '../config.js';
import { LagerError } from '../errors.js';
import { lintArtifact } from './lint.js';
import type { Settings } from './settings.js';
import type { User, Users } from './users.js';

export type RuleLevel = 'view' | 'interact' | 'admin' | 'owner' | 'self';
export interface DbRule { path: string; read?: RuleLevel; write?: RuleLevel }
export interface Capabilities { db?: { rules?: DbRule[] }; user?: { scopes?: string[] }; assets?: { upload?: 'interact' }; [k: string]: unknown }
export type Visibility = 'private' | 'users' | 'public';
export type SelfInstances = 'off' | 'users';
export type UsersLevel = 'view' | 'interact';
export interface App { id: string; slug: string; title: string; ownerId: string; createdAt: string; selfInstances: SelfInstances }
export interface Version {
  appId: string; number: number; sha256: string; sizeBytes: number;
  capabilities: Capabilities; note: string | null; createdBy: string; createdAt: string;
}
export interface Instance {
  id: string; appId: string; slug: string; ownerId: string;
  activeVersion: number; autoUpdate: boolean; visibility: Visibility; createdAt: string;
  usersLevel: UsersLevel; disabled: boolean;
}
export interface DeployResult {
  app: App; version: Version; instances: Instance[]; warnings: string[];
  createdApp: boolean; createdVersion: boolean;
}
export type ActivateHook = (instance: Instance, from: number, to: number) => void;
export interface AccessChecks {
  canDeploy(app: App, userId: string): boolean;
  canManage(instance: Instance, userId: string): boolean;
}

const MAX_HTML_BYTES = 16 * 1024 * 1024;
const VISIBILITIES: Visibility[] = ['private', 'users', 'public'];
const USERS_LEVELS: UsersLevel[] = ['view', 'interact'];
const SELF_INSTANCES: SelfInstances[] = ['off', 'users'];
/** Non-administrators may create this many instances per rolling window, deleted ones included (create-fill-delete loops fill the disk). */
export const CREATIONS_PER_WINDOW = 10;
const CREATION_WINDOW_MS = 24 * 3600_000;

interface AppRow { id: string; slug: string; title: string; owner_id: string; created_at: string; self_instances: SelfInstances }
interface VersionRow {
  app_id: string; number: number; sha256: string; size_bytes: number;
  capabilities: string; note: string | null; created_by: string; created_at: string;
}
interface InstanceRow {
  id: string; app_id: string; slug: string; owner_id: string;
  active_version: number; auto_update: number; visibility: Visibility; created_at: string;
  users_level: UsersLevel; disabled_at: string | null;
}

const toApp = (r: AppRow): App => ({ id: r.id, slug: r.slug, title: r.title, ownerId: r.owner_id, createdAt: r.created_at, selfInstances: r.self_instances });
const toVersion = (r: VersionRow): Version => ({
  appId: r.app_id, number: r.number, sha256: r.sha256, sizeBytes: r.size_bytes,
  capabilities: JSON.parse(r.capabilities) as Capabilities, note: r.note, createdBy: r.created_by, createdAt: r.created_at,
});
const toInstance = (r: InstanceRow): Instance => ({
  id: r.id, appId: r.app_id, slug: r.slug, ownerId: r.owner_id, activeVersion: r.active_version,
  autoUpdate: r.auto_update !== 0, visibility: r.visibility, createdAt: r.created_at,
  usersLevel: r.users_level, disabled: r.disabled_at !== null,
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
  private deleteHooks: Array<(instance: Instance) => void> = [];
  private checks: AccessChecks | null = null;

  constructor(private db: DatabaseSync, private dataDir: string, private users: Users, private settings?: Settings) {}

  /** Replaces the Stage 1 owner-only rule for deploy, activate, visibility and users-level changes. */
  setChecks(checks: AccessChecks): void {
    this.checks = checks;
  }

  onInstanceDeleted(hook: (instance: Instance) => void): void {
    this.deleteHooks.push(hook);
  }

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

  /**
   * A slug that belonged to a deleted instance stays reserved for its former owner: a new owner would inherit the browser state
   * (storage, service workers) that visitors built up on that origin. Reclaiming it lifts the reservation.
   */
  private claimSlug(slug: string, ownerId: string): void {
    const retired = this.db.prepare('SELECT owner_id FROM retired_slugs WHERE slug = ?').get(slug) as { owner_id: string } | undefined;
    if (!retired) return;
    if (retired.owner_id !== ownerId) throw new LagerError('conflict', 'Dieser Name wurde bereits verwendet und ist gesperrt.');
    this.db.prepare('DELETE FROM retired_slugs WHERE slug = ?').run(slug);
  }

  /** Enforces and records the creation rate of a new instance for `owner`; platform administrators are exempt. */
  private countCreation(owner: User): void {
    if (owner.role === 'admin') return;
    const now = Date.now();
    const since = new Date(now - CREATION_WINDOW_MS).toISOString();
    this.db.prepare('DELETE FROM instance_creations WHERE created_at <= ?').run(since);
    const recent = (this.db.prepare('SELECT COUNT(*) AS c FROM instance_creations WHERE user_id = ? AND created_at > ?').get(owner.id, since) as { c: number }).c;
    if (recent >= CREATIONS_PER_WINDOW) throw new LagerError('conflict', 'Du hast heute zu viele Instanzen angelegt. Versuche es morgen wieder.');
    this.db.prepare('INSERT INTO instance_creations (user_id, created_at) VALUES (?, ?)').run(owner.id, new Date(now).toISOString());
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
    if (user.disabled) throw new LagerError('forbidden', 'This account is disabled.');
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
        const allowed = this.checks ? this.checks.canDeploy(app, user.id) : app.ownerId === user.id;
        if (!allowed) throw new LagerError('forbidden', `You are not allowed to deploy "${app.slug}".`);
        if (input.title && input.title !== app.title) {
          this.db.prepare('UPDATE apps SET title = ? WHERE id = ?').run(input.title, app.id);
          app = { ...app, title: input.title };
        }
      } else {
        if (this.db.prepare('SELECT 1 FROM instances WHERE slug = ?').get(input.slug)) {
          throw new LagerError('conflict', `Instance slug "${input.slug}" is already taken.`);
        }
        this.claimSlug(input.slug, user.id);
        this.countCreation(user);
        app = { id: crypto.randomUUID(), slug: input.slug, title: input.title || input.slug, ownerId: user.id, createdAt: now, selfInstances: 'off' };
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

  /** Apps the user owns or is listed as collaborator on (role and account state are not checked here). */
  listAppsFor(userId: string): App[] {
    const rows = this.db
      .prepare('SELECT * FROM apps WHERE owner_id = ? OR id IN (SELECT app_id FROM app_collaborators WHERE user_id = ?) ORDER BY slug')
      .all(userId, userId) as unknown as AppRow[];
    return rows.map(toApp);
  }

  listAllApps(): App[] {
    return this.listApps();
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
      const owner = this.users.get(input.ownerId);
      if (!owner) throw new LagerError('not_found', 'Owner not found.');
      if (this.settings && owner.role !== 'admin') {
        const owned = (this.db.prepare('SELECT COUNT(*) AS c FROM instances WHERE owner_id = ?').get(owner.id) as { c: number }).c;
        if (owned >= this.settings.maxInstancesPerUser) throw new LagerError('conflict', 'Instanz-Limit erreicht');
      }
      if (this.db.prepare('SELECT 1 FROM instances WHERE slug = ?').get(input.slug)) {
        throw new LagerError('conflict', `Instance slug "${input.slug}" is already taken.`);
      }
      this.claimSlug(input.slug, owner.id);
      this.countCreation(owner);
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

  listAllInstances(): Instance[] {
    const rows = this.db.prepare('SELECT * FROM instances ORDER BY created_at, slug').all() as unknown as InstanceRow[];
    return rows.map(toInstance);
  }

  /** Newest first: instances of others open to all signed-in users or the public, with app title and owner name from one join. */
  listDiscoverable(excludeOwnerId: string, limit: number): Array<Instance & { appTitle: string; ownerName: string }> {
    const rows = this.db.prepare(
      `SELECT i.*, a.title AS app_title, COALESCE(u.name, '–') AS owner_name FROM instances i
       JOIN apps a ON a.id = i.app_id LEFT JOIN users u ON u.id = i.owner_id
       WHERE i.disabled_at IS NULL AND i.owner_id != ? AND i.visibility IN ('users', 'public')
       ORDER BY i.created_at DESC, i.rowid DESC LIMIT ?`,
    ).all(excludeOwnerId, limit) as unknown as Array<InstanceRow & { app_title: string; owner_name: string }>;
    return rows.map((r) => ({ ...toInstance(r), appTitle: r.app_title, ownerName: r.owner_name }));
  }

  /** Newest first: apps whose owner lets every signed-in user create instances. */
  listSelfServiceApps(limit: number): App[] {
    const rows = this.db.prepare("SELECT * FROM apps WHERE self_instances = 'users' ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit) as unknown as AppRow[];
    return rows.map(toApp);
  }

  listInstancesOwnedBy(userId: string): Instance[] {
    const rows = this.db.prepare('SELECT * FROM instances WHERE owner_id = ? ORDER BY created_at, slug').all(userId) as unknown as InstanceRow[];
    return rows.map(toInstance);
  }

  private requireInstance(instanceId: string): Instance {
    const instance = this.getInstance(instanceId);
    if (!instance) throw new LagerError('not_found', 'Instance not found.');
    return instance;
  }

  /** The instance, if `userId` may manage it (owner or instance admin once `setChecks` is wired; owner only before). */
  private managedInstance(instanceId: string, userId: string): Instance {
    const instance = this.requireInstance(instanceId);
    const allowed = this.checks ? this.checks.canManage(instance, userId) : instance.ownerId === userId;
    if (!allowed) throw new LagerError('forbidden', 'You are not allowed to manage this instance.');
    return instance;
  }

  private ownedInstance(instanceId: string, userId: string): Instance {
    const instance = this.requireInstance(instanceId);
    if (instance.ownerId !== userId) throw new LagerError('forbidden', 'Only the instance owner can do this.');
    return instance;
  }

  private ownedApp(appId: string, userId: string): App {
    const app = this.getApp(appId);
    if (!app) throw new LagerError('not_found', 'App not found.');
    if (app.ownerId !== userId) throw new LagerError('forbidden', 'Only the app owner can do this.');
    return app;
  }

  activate(instanceId: string, version: number, userId: string): Instance {
    return this.transaction(() => {
      const instance = this.managedInstance(instanceId, userId);
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
    const instance = this.managedInstance(instanceId, userId);
    this.db.prepare('UPDATE instances SET visibility = ? WHERE id = ?').run(visibility, instance.id);
    return this.getInstance(instanceId)!;
  }

  /** Level every signed-in user gets while the visibility is `users`. */
  setUsersLevel(instanceId: string, level: UsersLevel, userId: string): Instance {
    if (!USERS_LEVELS.includes(level)) throw new LagerError('invalid_argument', `Invalid level "${String(level)}".`);
    const instance = this.managedInstance(instanceId, userId);
    this.db.prepare('UPDATE instances SET users_level = ? WHERE id = ?').run(level, instance.id);
    return this.getInstance(instanceId)!;
  }

  /** Platform-level switch; the caller enforces the platform admin role. */
  setInstanceDisabled(instanceId: string, disabled: boolean): Instance {
    const instance = this.requireInstance(instanceId);
    if (disabled) {
      this.db.prepare('UPDATE instances SET disabled_at = COALESCE(disabled_at, ?) WHERE id = ?').run(new Date().toISOString(), instance.id);
    } else {
      this.db.prepare('UPDATE instances SET disabled_at = NULL WHERE id = ?').run(instance.id);
    }
    return this.getInstance(instanceId)!;
  }

  setSelfInstances(appId: string, mode: SelfInstances, userId: string): App {
    if (!SELF_INSTANCES.includes(mode)) throw new LagerError('invalid_argument', `Invalid mode "${String(mode)}".`);
    const app = this.ownedApp(appId, userId);
    this.db.prepare('UPDATE apps SET self_instances = ? WHERE id = ?').run(mode, app.id);
    return this.getApp(app.id)!;
  }

  addCollaborator(appId: string, userId: string, byUserId: string): void {
    const app = this.ownedApp(appId, byUserId);
    const target = this.users.get(userId);
    if (!target) throw new LagerError('not_found', 'User not found.');
    if (target.disabled || (target.role !== 'admin' && target.role !== 'publisher')) {
      throw new LagerError('invalid_argument', 'Collaborators must be active admins or publishers.');
    }
    if (target.id === app.ownerId) throw new LagerError('invalid_argument', 'The owner is already in charge of the app.');
    this.db.prepare('INSERT OR IGNORE INTO app_collaborators (app_id, user_id) VALUES (?, ?)').run(app.id, target.id);
  }

  removeCollaborator(appId: string, userId: string, byUserId: string): void {
    const app = this.ownedApp(appId, byUserId);
    this.db.prepare('DELETE FROM app_collaborators WHERE app_id = ? AND user_id = ?').run(app.id, userId);
  }

  listCollaborators(appId: string): User[] {
    const rows = this.db.prepare('SELECT user_id FROM app_collaborators WHERE app_id = ?').all(appId) as unknown as Array<{ user_id: string }>;
    return rows.map((r) => this.users.get(r.user_id)).filter((u): u is User => u !== null).sort((a, b) => a.name.localeCompare(b.name));
  }

  isCollaborator(appId: string, userId: string): boolean {
    return this.db.prepare('SELECT 1 FROM app_collaborators WHERE app_id = ? AND user_id = ?').get(appId, userId) !== undefined;
  }

  /** Removes the instance row and its grants, then lets listeners (data trash) react. Owner only. */
  deleteInstance(instanceId: string, userId: string): void {
    const instance = this.transaction(() => {
      const inst = this.ownedInstance(instanceId, userId);
      this.removeInstanceRows(inst);
      return inst;
    });
    for (const hook of this.deleteHooks) hook(instance);
  }

  /** Removes the rows of the instance and reserves its slug for the owner (see `claimSlug`). */
  private removeInstanceRows(instance: Instance): void {
    this.db.prepare('DELETE FROM grants WHERE instance_id = ?').run(instance.id);
    this.db.prepare('DELETE FROM instances WHERE id = ?').run(instance.id);
    this.db.prepare('INSERT OR REPLACE INTO retired_slugs (slug, owner_id, retired_at) VALUES (?, ?, ?)')
      .run(instance.slug, instance.ownerId, new Date().toISOString());
  }

  /** Owner only. Refused while someone else owns an instance of the app. Files move to `<dataDir>/trash`. */
  deleteApp(appId: string, userId: string): void {
    const { app, instances } = this.transaction(() => {
      const a = this.ownedApp(appId, userId);
      const all = this.listInstances(a.id);
      if (all.some((i) => i.ownerId !== userId)) {
        throw new LagerError('conflict', 'Andere Nutzer haben Instanzen dieser App. Sie müssen zuerst gelöscht werden.');
      }
      for (const i of all) this.removeInstanceRows(i);
      this.db.prepare('DELETE FROM app_collaborators WHERE app_id = ?').run(a.id);
      this.db.prepare('DELETE FROM versions WHERE app_id = ?').run(a.id);
      this.db.prepare('DELETE FROM apps WHERE id = ?').run(a.id);
      return { app: a, instances: all };
    });
    for (const hook of this.deleteHooks) for (const i of instances) hook(i);
    const source = path.join(this.dataDir, 'apps', app.id);
    if (fs.existsSync(source)) {
      const trash = path.join(this.dataDir, 'trash');
      fs.mkdirSync(trash, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:.]/g, '');
      fs.renameSync(source, path.join(trash, `app-${app.id}-${stamp}`));
    }
  }
}
