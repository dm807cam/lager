import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { assertSlug } from '../config.js';
import { LagerError } from '../errors.js';
import { checkArtifact } from './check.js';
import { DEFAULT_THEME_COLOR } from './icons.js';
import type { Settings } from './settings.js';
import type { User, Users } from './users.js';

export type RuleLevel = 'view' | 'interact' | 'admin' | 'owner' | 'self';
export interface DbRule { path: string; read?: RuleLevel; write?: RuleLevel }
export interface Capabilities { db?: { rules?: DbRule[] }; user?: { scopes?: string[] }; assets?: { upload?: 'interact' }; room?: { topics?: Record<string, 'interact'> }; [k: string]: unknown }
export type Visibility = 'private' | 'users' | 'public';
export type SelfInstances = 'off' | 'users';
export type UsersLevel = 'view' | 'interact';
export interface App {
  id: string; slug: string; title: string; ownerId: string; createdAt: string; selfInstances: SelfInstances;
  /** One plain sentence (at most 200 characters); empty when not given. */
  description: string;
  /** `#rrggbb`, lower case. */
  themeColor: string;
  /** Bumps on every icon change; part of every icon URL so caches never serve an old picture. */
  iconVersion: number;
}
export interface Version {
  appId: string; number: number; sha256: string; sizeBytes: number;
  capabilities: Capabilities; note: string | null; createdBy: string; createdAt: string;
  /** null = deployed version; otherwise self-published by that instance and private to it. */
  instanceId: string | null;
}
export interface Instance {
  id: string; appId: string; slug: string; ownerId: string;
  activeVersion: number; autoUpdate: boolean; visibility: Visibility; createdAt: string;
  usersLevel: UsersLevel; disabled: boolean;
}
export interface DeployResult {
  app: App; version: Version; instances: Instance[]; warnings: string[];
  /** Instances that were not moved to the new version because their auto-update is off. */
  pinned: Instance[];
  createdApp: boolean; createdVersion: boolean;
}
export type ActivateHook = (instance: Instance, from: number, to: number) => void;
export type ActivatedHook = (instance: Instance) => void;
export interface AccessChecks {
  canDeploy(app: App, userId: string): boolean;
  canManage(instance: Instance, userId: string): boolean;
}

const MAX_HTML_BYTES = 16 * 1024 * 1024;
const SELF_PUBLISHED_NOTE = 'saved by the instance itself';
/** An instance keeps this many self-published versions; older ones are removed when a newer one is saved. */
export const MAX_SAVED_VERSIONS = 20;
const VISIBILITIES: Visibility[] = ['private', 'users', 'public'];
const USERS_LEVELS: UsersLevel[] = ['view', 'interact'];
const SELF_INSTANCES: SelfInstances[] = ['off', 'users'];
/** Non-administrators may create this many instances per rolling window, deleted ones included (create-fill-delete loops fill the disk). */
export const CREATIONS_PER_WINDOW = 10;
const CREATION_WINDOW_MS = 24 * 3600_000;

interface AppRow {
  id: string; slug: string; title: string; owner_id: string; created_at: string; self_instances: SelfInstances;
  description: string; theme_color: string; icon_version: number;
}
interface VersionRow {
  app_id: string; number: number; sha256: string; size_bytes: number;
  capabilities: string; note: string | null; created_by: string; created_at: string; instance_id: string | null;
}
interface InstanceRow {
  id: string; app_id: string; slug: string; owner_id: string;
  active_version: number; auto_update: number; visibility: Visibility; created_at: string;
  users_level: UsersLevel; disabled_at: string | null;
}

const toApp = (r: AppRow): App => ({
  id: r.id, slug: r.slug, title: r.title, ownerId: r.owner_id, createdAt: r.created_at, selfInstances: r.self_instances,
  description: r.description, themeColor: r.theme_color, iconVersion: Number(r.icon_version),
});

export const MAX_DESCRIPTION = 200;

/** Trimmed, whitespace collapsed to single spaces, at most 200 characters, no control characters. */
export function normalizeDescription(value: unknown): string {
  if (typeof value !== 'string') throw new LagerError('invalid_argument', 'description must be a string.');
  const text = value.trim().replace(/\s+/g, ' ');
  if (/[\u0000-\u001F\u007F]/.test(text)) throw new LagerError('invalid_argument', 'description must be plain text.');
  if ([...text].length > MAX_DESCRIPTION) throw new LagerError('invalid_argument', `description must be at most ${MAX_DESCRIPTION} characters.`);
  return text;
}

/** `#rgb` or `#rrggbb` (any case) to `#rrggbb` lower case. */
export function normalizeThemeColor(value: unknown): string {
  const m = typeof value === 'string' ? /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim()) : null;
  if (!m) throw new LagerError('invalid_argument', 'theme_color must be a hex colour such as #1f2a5c or #fff.');
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return `#${hex.toLowerCase()}`;
}
const toVersion = (r: VersionRow): Version => ({
  appId: r.app_id, number: r.number, sha256: r.sha256, sizeBytes: r.size_bytes,
  capabilities: JSON.parse(r.capabilities) as Capabilities, note: r.note, createdBy: r.created_by, createdAt: r.created_at,
  instanceId: r.instance_id,
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
  private activatedHooks: ActivatedHook[] = [];
  private deleteHooks: Array<(instance: Instance) => void> = [];
  private checks: AccessChecks | null = null;
  private quota: { bytes: number; otherUsage: (instanceId: string) => number } | null = null;

  constructor(private db: DatabaseSync, private dataDir: string, private users: Users, private settings?: Settings) {}

  /** Replaces the Stage 1 owner-only rule for deploy, activate, visibility and users-level changes. */
  setChecks(checks: AccessChecks): void {
    this.checks = checks;
  }

  /** Saved pages count against the instance quota together with `otherUsage` (documents and assets); 0 = unlimited. */
  setQuota(bytes: number, otherUsage: (instanceId: string) => number): void {
    this.quota = { bytes, otherUsage };
  }

  /** Bytes of the pages this instance saved itself. */
  savedBytes(instanceId: string): number {
    return Number((this.db.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS b FROM versions WHERE instance_id = ?').get(instanceId) as { b: number }).b);
  }

  onInstanceDeleted(hook: (instance: Instance) => void): void {
    this.deleteHooks.push(hook);
  }

  onBeforeActivate(hook: ActivateHook): void {
    this.hooks.push(hook);
  }

  /** Runs after an instance's active version changed and the change is committed (deploy, activate, self-publish). */
  onActivated(hook: ActivatedHook): void {
    this.activatedHooks.push(hook);
  }

  private fireActivated(instances: Instance[]): void {
    for (const i of instances) for (const hook of this.activatedHooks) hook(i);
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
    if (retired.owner_id !== ownerId) throw new LagerError('conflict', 'This name was used before and is reserved.', 'slug_retired');
    this.db.prepare('DELETE FROM retired_slugs WHERE slug = ?').run(slug);
  }

  /** Enforces and records the creation rate of a new instance for `owner`; platform administrators are exempt. */
  private countCreation(owner: User): void {
    if (owner.role === 'admin') return;
    const now = Date.now();
    const since = new Date(now - CREATION_WINDOW_MS).toISOString();
    this.db.prepare('DELETE FROM instance_creations WHERE created_at <= ?').run(since);
    const recent = (this.db.prepare('SELECT COUNT(*) AS c FROM instance_creations WHERE user_id = ? AND created_at > ?').get(owner.id, since) as { c: number }).c;
    if (recent >= CREATIONS_PER_WINDOW) throw new LagerError('conflict', 'You have created too many instances today. Try again tomorrow.', 'creation_rate');
    this.db.prepare('INSERT INTO instance_creations (user_id, created_at) VALUES (?, ?)').run(owner.id, new Date(now).toISOString());
  }

  /** The next version number of the app. Numbers come from a counter and are never reused, also after saved versions were pruned. */
  private allocateVersion(appId: string): number {
    const row = this.db.prepare('SELECT next_version AS n, (SELECT MAX(number) FROM versions WHERE app_id = apps.id) AS top FROM apps WHERE id = ?')
      .get(appId) as { n: number; top: number | null };
    const number = Math.max(Number(row.n), Number(row.top ?? 0) + 1);
    this.db.prepare('UPDATE apps SET next_version = ? WHERE id = ?').run(number + 1, appId);
    return number;
  }

  private fireHooks(instance: Instance, from: number, to: number): void {
    for (const hook of this.hooks) hook(instance, from, to);
  }

  deploy(input: {
    slug: string; html: string; title?: string; capabilities?: Capabilities; note?: string; userId: string;
    /** Left out on a redeploy = unchanged. */
    description?: string; themeColor?: string;
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
    const description = input.description === undefined ? undefined : normalizeDescription(input.description);
    const themeColor = input.themeColor === undefined ? undefined : normalizeThemeColor(input.themeColor);
    const capabilities = input.capabilities ?? {};
    const capabilitiesJson = canonicalJson(capabilities);
    const sha256 = crypto.createHash('sha256').update(input.html).digest('hex');
    const warnings = checkArtifact(input.html, capabilities).warnings;

    const updated: Instance[] = [];
    const result = this.transaction(() => {
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
        if ((description !== undefined && description !== app.description) || (themeColor !== undefined && themeColor !== app.themeColor)) {
          app = { ...app, description: description ?? app.description, themeColor: themeColor ?? app.themeColor };
          this.db.prepare('UPDATE apps SET description = ?, theme_color = ? WHERE id = ?').run(app.description, app.themeColor, app.id);
        }
      } else {
        if (this.db.prepare('SELECT 1 FROM instances WHERE slug = ?').get(input.slug)) {
          throw new LagerError('conflict', `Instance slug "${input.slug}" is already taken.`, 'slug_taken');
        }
        this.claimSlug(input.slug, user.id);
        this.countCreation(user);
        app = {
          id: crypto.randomUUID(), slug: input.slug, title: input.title || input.slug, ownerId: user.id, createdAt: now, selfInstances: 'off',
          description: description ?? '', themeColor: themeColor ?? DEFAULT_THEME_COLOR, iconVersion: 0,
        };
        this.db
          .prepare('INSERT INTO apps (id, slug, title, owner_id, created_at, description, theme_color) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(app.id, app.slug, app.title, app.ownerId, app.createdAt, app.description, app.themeColor);
        createdApp = true;
      }

      // "Latest" means the latest deployed version: a self-published one carries a single instance's state.
      const latest = this.latestDeployedVersion(app.id) ?? undefined;

      let version: Version;
      let createdVersion = false;
      let pinned: Instance[] = [];
      if (latest && latest.sha256 === sha256 && canonicalJson(latest.capabilities) === capabilitiesJson) {
        version = latest;
      } else {
        version = {
          appId: app.id, number: this.allocateVersion(app.id), sha256, sizeBytes, instanceId: null,
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
          updated.push({ ...toInstance(row), activeVersion: version.number });
        }
        pinned = (this.db.prepare('SELECT * FROM instances WHERE app_id = ? AND auto_update = 0 AND active_version != ? ORDER BY created_at, slug')
          .all(app.id, version.number) as unknown as InstanceRow[]).map(toInstance);
      }

      return { app, version, instances: this.listInstances(app.id), warnings, pinned, createdApp, createdVersion };
    });
    this.fireActivated(updated);
    return result;
  }

  /** Changes the description and/or theme colour. Owner or collaborator (the same people who may deploy). */
  setAppMeta(appId: string, meta: { description?: string; themeColor?: string }, userId: string): App {
    const row = this.db.prepare('SELECT * FROM apps WHERE id = ?').get(appId) as AppRow | undefined;
    if (!row) throw new LagerError('not_found', 'App not found.');
    const app = toApp(row);
    const allowed = this.checks ? this.checks.canDeploy(app, userId) : app.ownerId === userId;
    if (!allowed) throw new LagerError('forbidden', `You are not allowed to change "${app.slug}".`);
    const description = meta.description === undefined ? app.description : normalizeDescription(meta.description);
    const themeColor = meta.themeColor === undefined ? app.themeColor : normalizeThemeColor(meta.themeColor);
    this.db.prepare('UPDATE apps SET description = ?, theme_color = ? WHERE id = ?').run(description, themeColor, appId);
    return { ...app, description, themeColor };
  }

  /** Called after the icon files changed; the new number goes into every icon URL. */
  bumpIconVersion(appId: string): App {
    this.db.prepare('UPDATE apps SET icon_version = icon_version + 1 WHERE id = ?').run(appId);
    return this.getApp(appId)!;
  }

  getApp(slugOrId: string): App | null {
    // An id always wins: an app whose slug happens to equal another app's id must never stand in for that app.
    const row = this.db.prepare('SELECT * FROM apps WHERE slug = ? OR id = ? ORDER BY (id = ?) DESC LIMIT 1').get(slugOrId, slugOrId, slugOrId) as AppRow | undefined;
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

  /** The highest-numbered version that was deployed (not self-published), or null. */
  latestDeployedVersion(appId: string): Version | null {
    const row = this.db.prepare('SELECT * FROM versions WHERE app_id = ? AND instance_id IS NULL ORDER BY number DESC LIMIT 1').get(appId) as VersionRow | undefined;
    return row ? toVersion(row) : null;
  }

  readVersionHtml(appId: string, number: number): string {
    if (!Number.isInteger(number) || !this.db.prepare('SELECT 1 FROM versions WHERE app_id = ? AND number = ?').get(appId, number)) {
      throw new LagerError('not_found', `Version ${number} not found.`);
    }
    return fs.readFileSync(this.versionFile(appId, number), 'utf8');
  }

  /** `createdBy` is the account that asked for the instance when it is not the owner; the creation rate is charged to it. */
  createInstance(input: { appId: string; slug: string; ownerId: string; visibility?: Visibility; createdBy?: string }): Instance {
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
        if (owned >= this.settings.maxInstancesPerUser) throw new LagerError('conflict', 'Instance limit reached.', 'instance_limit');
      }
      if (this.db.prepare('SELECT 1 FROM instances WHERE slug = ?').get(input.slug)) {
        throw new LagerError('conflict', `Instance slug "${input.slug}" is already taken.`, 'slug_taken');
      }
      this.claimSlug(input.slug, owner.id);
      // Whoever creates the instance spends their own budget, so nobody can use up another account's.
      this.countCreation((input.createdBy !== undefined ? this.users.get(input.createdBy) : null) ?? owner);
      // New instances start on the latest deployed version, never on another instance's self-published one.
      const latest = this.latestDeployedVersion(input.appId);
      if (!latest) throw new LagerError('not_found', 'App has no versions.');
      const id = crypto.randomUUID();
      this.db
        .prepare(
          'INSERT INTO instances (id, app_id, slug, owner_id, active_version, auto_update, visibility, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
        )
        .run(id, input.appId, input.slug, input.ownerId, latest.number, visibility, new Date().toISOString());
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
    let changed = false;
    const result = this.transaction(() => {
      const instance = this.managedInstance(instanceId, userId);
      const row = this.db.prepare('SELECT instance_id, capabilities FROM versions WHERE app_id = ? AND number = ?').get(instance.appId, version) as { instance_id: string | null; capabilities: string } | undefined;
      if (!row) throw new LagerError('not_found', `Version ${version} not found.`);
      if (row.instance_id !== null && row.instance_id !== instance.id) {
        throw new LagerError('forbidden', 'This version was saved by another instance.');
      }
      // The data rules come from the active version. A manager is held to them, so only the owner may switch to a version with other rules.
      if (instance.ownerId !== userId && instance.activeVersion !== version) {
        const rulesOf = (json: string | undefined): string => canonicalJson((JSON.parse(json ?? '{}') as Capabilities).db?.rules ?? []);
        const current = this.db.prepare('SELECT capabilities FROM versions WHERE app_id = ? AND number = ?').get(instance.appId, instance.activeVersion) as { capabilities: string } | undefined;
        if (rulesOf(current?.capabilities) !== rulesOf(row.capabilities)) {
          throw new LagerError('conflict', 'Only the instance owner can activate a version with different data rules.', 'rules_differ');
        }
      }
      if (instance.activeVersion !== version) {
        this.fireHooks(instance, instance.activeVersion, version);
        // An instance on its own saved content must not be overwritten by the next deploy.
        this.db.prepare('UPDATE instances SET active_version = ?, auto_update = CASE WHEN ? THEN 0 ELSE auto_update END WHERE id = ?')
          .run(version, row.instance_id !== null ? 1 : 0, instance.id);
        changed = true;
      }
      return this.getInstance(instanceId)!;
    });
    if (changed) this.fireActivated([result]);
    return result;
  }

  /**
   * The page of `instanceId` saves itself as a new version that belongs to this instance only. `baseVersion` is the version the page
   * was loaded from; a stale one is a conflict. The instance moves to the new version and stops following deploys.
   */
  selfPublish(input: { instanceId: string; html: string; baseVersion: number; userId: string }): { version: Version; instance: Instance } {
    if (typeof input.html !== 'string' || input.html.trim() === '') throw new LagerError('invalid_argument', 'HTML must not be empty.');
    const sizeBytes = Buffer.byteLength(input.html);
    if (sizeBytes > MAX_HTML_BYTES) throw new LagerError('invalid_argument', 'HTML exceeds the limit of 16 MiB.');
    const sha256 = crypto.createHash('sha256').update(input.html).digest('hex');
    const out = this.transaction(() => {
      const instance = this.managedInstance(input.instanceId, input.userId);
      if (instance.activeVersion !== input.baseVersion) {
        throw new LagerError('conflict', 'The page has meanwhile been saved in a newer version.');
      }
      const base = this.db.prepare('SELECT * FROM versions WHERE app_id = ? AND number = ?').get(instance.appId, instance.activeVersion) as VersionRow | undefined;
      if (!base) throw new LagerError('not_found', `Version ${instance.activeVersion} not found.`);
      const number = this.allocateVersion(instance.appId);
      // Keep the newest MAX_SAVED_VERSIONS - 1 saved versions plus the new one, which becomes the active version.
      const mine = this.db.prepare('SELECT number, size_bytes FROM versions WHERE instance_id = ? ORDER BY number DESC')
        .all(instance.id) as unknown as Array<{ number: number; size_bytes: number }>;
      const dropped = mine.slice(MAX_SAVED_VERSIONS - 1);
      if (this.quota && this.quota.bytes > 0) {
        const kept = this.savedBytes(instance.id) - dropped.reduce((sum, r) => sum + Number(r.size_bytes), 0);
        if (this.quota.otherUsage(instance.id) + kept + sizeBytes > this.quota.bytes) {
          throw new LagerError('quota_exceeded', 'This instance\'s storage is full.');
        }
      }
      for (const r of dropped) this.db.prepare('DELETE FROM versions WHERE app_id = ? AND number = ?').run(instance.appId, r.number);
      const now = new Date().toISOString();
      this.db
        .prepare(
          'INSERT INTO versions (app_id, number, sha256, size_bytes, capabilities, note, created_by, created_at, instance_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(instance.appId, number, sha256, sizeBytes, base.capabilities, SELF_PUBLISHED_NOTE, input.userId, now, instance.id);
      this.writeVersionFile(instance.appId, number, input.html);
      // No data snapshot here: saving the page leaves the documents untouched, so there is nothing to restore.
      this.db.prepare('UPDATE instances SET active_version = ?, auto_update = 0 WHERE id = ?').run(number, instance.id);
      const version = toVersion(this.db.prepare('SELECT * FROM versions WHERE app_id = ? AND number = ?').get(instance.appId, number) as unknown as VersionRow);
      return { version, instance: this.getInstance(instance.id)!, dropped: dropped.map((r) => r.number) };
    });
    this.deleteVersionFiles(out.instance.appId, out.dropped);
    this.fireActivated([out.instance]);
    return { version: out.version, instance: out.instance };
  }

  /** Pruned saved versions are deleted outright: the trash is not counted by any quota, so nothing may pile up there. */
  private deleteVersionFiles(appId: string, numbers: number[]): void {
    for (const n of numbers) fs.rmSync(path.dirname(this.versionFile(appId, n)), { recursive: true, force: true });
  }

  /** The saved pages hold an instance's state: when the instance or app is deleted, they go to the trash, never back to another instance. */
  private trashVersionFiles(appId: string, numbers: number[]): void {
    const stamp = new Date().toISOString().replace(/[-:.]/g, '');
    for (const n of numbers) {
      const source = path.dirname(this.versionFile(appId, n));
      if (!fs.existsSync(source)) continue;
      const target = path.join(this.dataDir, 'trash', `version-${appId}-${n}-${stamp}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(source, target);
    }
  }

  /** Whether the instance follows new deploys. Turning it on moves the instance to the latest deployed version right away. */
  setAutoUpdate(instanceId: string, on: boolean, userId: string): Instance {
    const instance = this.managedInstance(instanceId, userId);
    this.db.prepare('UPDATE instances SET auto_update = ? WHERE id = ?').run(on ? 1 : 0, instance.id);
    const latest = on ? this.latestDeployedVersion(instance.appId) : null;
    if (latest && latest.number !== instance.activeVersion) return this.activate(instance.id, latest.number, userId);
    return this.getInstance(instance.id)!;
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
      throw new LagerError('invalid_argument', 'Collaborators must be active admins or publishers.', 'collaborators_invalid');
    }
    if (target.id === app.ownerId) throw new LagerError('invalid_argument', 'The owner is already in charge of the app.', 'owner_in_charge');
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
    const { instance, saved } = this.transaction(() => {
      const inst = this.ownedInstance(instanceId, userId);
      const numbers = (this.db.prepare('SELECT number FROM versions WHERE instance_id = ?').all(inst.id) as unknown as Array<{ number: number }>).map((r) => r.number);
      this.db.prepare('DELETE FROM versions WHERE instance_id = ?').run(inst.id);
      this.removeInstanceRows(inst);
      return { instance: inst, saved: numbers };
    });
    for (const hook of this.deleteHooks) hook(instance);
    this.trashVersionFiles(instance.appId, saved);
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
        throw new LagerError('conflict', 'Other users have instances of this app. They must be deleted first.', 'other_users_instances');
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
