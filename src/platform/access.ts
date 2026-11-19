import type { DatabaseSync } from 'node:sqlite';
import type { Level } from '../data/rules.js';
import { LagerError } from '../errors.js';
import type { App, Instance } from './apps.js';
import type { Apps } from './apps.js';
import type { Groups } from './groups.js';
import type { User, Users } from './users.js';

export type GrantLevel = 'view' | 'interact' | 'admin';
export interface Grant { instanceId: string; principalType: 'user' | 'group'; principalId: string; principalLabel: string; level: GrantLevel }

const RANK: Record<Level, number> = { none: 0, view: 1, interact: 2, admin: 3, owner: 4 };
const GRANT_LEVELS: readonly GrantLevel[] = ['view', 'interact', 'admin'];
const DEFAULT_LIMIT = 20;
/** Entries per list in `catalog`. */
export const CATALOG_LIMIT = 100;

const maxLevel = (a: Level, b: Level): Level => (RANK[a] >= RANK[b] ? a : b);

/** The one place that decides who may do what with apps and instances. */
export class Access {
  constructor(private db: DatabaseSync, private users: Users, private groups: Groups, private apps: Apps) {}

  /**
   * Level of a (possibly anonymous) user on an instance. A disabled instance is closed to everyone, a disabled
   * user counts as anonymous, and platform admins get no implicit access.
   */
  levelFor(instance: Instance, user: User | null): Level {
    if (instance.disabled) return 'none';
    const active = user && !user.disabled ? user : null;
    let level: Level = instance.visibility === 'public' ? 'view' : 'none';
    if (!active) return level;
    if (instance.ownerId === active.id) return 'owner';
    if (instance.visibility === 'users') level = maxLevel(level, instance.usersLevel);
    const rows = this.db.prepare(
      `SELECT level FROM grants WHERE instance_id = ? AND (
         (principal_type = 'user' AND principal_id = ?)
         OR (principal_type = 'group' AND principal_id IN (SELECT group_id FROM group_members WHERE user_id = ?)))`,
    ).all(instance.id, active.id, active.id) as unknown as Array<{ level: GrantLevel }>;
    for (const r of rows) level = maxLevel(level, r.level);
    return level;
  }

  listGrants(instanceId: string): Grant[] {
    const rows = this.db.prepare('SELECT principal_type, principal_id, level FROM grants WHERE instance_id = ?')
      .all(instanceId) as unknown as Array<{ principal_type: 'user' | 'group'; principal_id: string; level: GrantLevel }>;
    const out: Grant[] = [];
    for (const r of rows) {
      const label = r.principal_type === 'user' ? this.users.get(r.principal_id)?.email : this.groups.get(r.principal_id)?.name;
      if (label !== undefined) out.push({ instanceId, principalType: r.principal_type, principalId: r.principal_id, principalLabel: label, level: r.level });
    }
    return out.sort((a, b) => a.principalLabel.localeCompare(b.principalLabel));
  }

  private assertManage(instance: Instance, by: User): void {
    if (!this.canManageInstance(instance, by)) throw new LagerError('forbidden', 'You may not manage this instance.');
  }

  private assertPrincipalType(type: string): void {
    if (type !== 'user' && type !== 'group') throw new LagerError('invalid_argument', 'Principal type must be user or group.');
  }

  setGrant(instance: Instance, principalType: 'user' | 'group', principalId: string, level: GrantLevel, by: User): void {
    this.assertManage(instance, by);
    this.assertPrincipalType(principalType);
    if (!GRANT_LEVELS.includes(level)) throw new LagerError('invalid_argument', 'Grant level must be view, interact or admin.');
    if (principalType === 'user') {
      if (!this.users.get(principalId)) throw new LagerError('not_found', 'User not found.');
      if (principalId === instance.ownerId) throw new LagerError('invalid_argument', 'The owner already has full access.', 'owner_full_access');
    } else if (!this.groups.get(principalId)) {
      throw new LagerError('not_found', 'Group not found.');
    }
    this.db.prepare(
      `INSERT INTO grants (instance_id, principal_type, principal_id, level, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(instance_id, principal_type, principal_id) DO UPDATE SET level = excluded.level`,
    ).run(instance.id, principalType, principalId, level, by.id, new Date().toISOString());
  }

  removeGrant(instance: Instance, principalType: 'user' | 'group', principalId: string, by: User): void {
    this.assertManage(instance, by);
    this.assertPrincipalType(principalType);
    this.db.prepare('DELETE FROM grants WHERE instance_id = ? AND principal_type = ? AND principal_id = ?').run(instance.id, principalType, principalId);
  }

  /** Level admin or owner (never on a disabled instance). */
  canManageInstance(instance: Instance, user: User): boolean {
    const level = this.levelFor(instance, user);
    return level === 'admin' || level === 'owner';
  }

  /** The owner may delete their instance in every state, also after an administrator disabled it. */
  canDeleteInstance(instance: Instance, user: User): boolean {
    return !user.disabled && instance.ownerId === user.id;
  }

  /** Active admin or publisher who owns the app or collaborates on it. */
  canDeploy(app: App, user: User): boolean {
    if (user.disabled || (user.role !== 'admin' && user.role !== 'publisher')) return false;
    return app.ownerId === user.id || this.apps.isCollaborator(app.id, user.id);
  }

  canCreateInstance(app: App, user: User): boolean {
    if (this.canDeploy(app, user)) return true;
    return app.selfInstances === 'users' && !user.disabled;
  }

  /** The account that owns the app (and so manages collaborators, self-service and deletion). */
  isAppOwner(app: App, user: User): boolean {
    return !user.disabled && app.ownerId === user.id;
  }

  /** Reading app-level details (versions, instances): the owner and active collaborators who may still deploy. */
  canReadApp(app: App, user: User): boolean {
    return !user.disabled && (app.ownerId === user.id || this.canDeploy(app, user));
  }

  /** Apps the user may read: owned or collaborating. */
  appsOf(user: User): App[] {
    return this.apps.listAppsFor(user.id).filter((a) => this.canReadApp(a, user));
  }

  /** The owner always sees their instance (even a disabled one); others need some access level. */
  canSeeInstance(instance: Instance, user: User): boolean {
    if (user.disabled) return false;
    return instance.ownerId === user.id || this.levelFor(instance, user) !== 'none';
  }

  /** Instances shared with the user through a direct or group grant; not their own, not disabled. */
  sharedWith(user: User): Instance[] {
    if (user.disabled) return [];
    const rows = this.db.prepare(
      `SELECT DISTINCT instance_id FROM grants WHERE
         (principal_type = 'user' AND principal_id = ?)
         OR (principal_type = 'group' AND principal_id IN (SELECT group_id FROM group_members WHERE user_id = ?))`,
    ).all(user.id, user.id) as unknown as Array<{ instance_id: string }>;
    return rows.map((r) => this.apps.getInstance(r.instance_id))
      .filter((i): i is Instance => i !== null && !i.disabled && i.ownerId !== user.id)
      .sort((a, b) => a.slug.localeCompare(b.slug));
  }

  /** What a signed-in user can discover: others' instances open to all users or the public, and self-service apps; newest 100 of each. */
  catalog(user: User): { instances: Array<Instance & { appTitle: string; ownerName: string }>; apps: App[] } {
    if (user.disabled) return { instances: [], apps: [] };
    return { instances: this.apps.listDiscoverable(user.id, CATALOG_LIMIT), apps: this.apps.listSelfServiceApps(CATALOG_LIMIT) };
  }

  /** Whether the instance belongs to `userId` or is shared with them, directly or through a group (any level, also while disabled). */
  isConnected(instance: Instance, userId: string): boolean {
    if (instance.ownerId === userId) return true;
    return this.db.prepare(
      `SELECT 1 FROM grants WHERE instance_id = ? AND (
         (principal_type = 'user' AND principal_id = ?)
         OR (principal_type = 'group' AND principal_id IN (SELECT group_id FROM group_members WHERE user_id = ?))) LIMIT 1`,
    ).get(instance.id, userId, userId) !== undefined;
  }

  /**
   * True when the user reaches the instance through its visibility alone (public, or open to every signed-in user): not the owner,
   * not someone it is shared with, not someone who manages its app. Such an instance has to be confirmed before it learns who visits.
   */
  needsSignInConfirmation(instance: Instance, user: User): boolean {
    if (this.isConnected(instance, user.id)) return false;
    const app = this.apps.getApp(instance.appId);
    return !(app && this.canReadApp(app, user));
  }

  /** Whether the user agreed that this instance learns their name and, when `email` is asked for, their address. */
  signInConfirmed(instance: Instance, user: User, email: boolean): boolean {
    if (!this.needsSignInConfirmation(instance, user)) return true;
    const row = this.db.prepare('SELECT email FROM instance_signins WHERE user_id = ? AND instance_id = ?').get(user.id, instance.id) as { email: number } | undefined;
    return row !== undefined && (!email || row.email === 1);
  }

  /** Remembers the agreement; one that covered the address keeps covering it. */
  confirmSignIn(instance: Instance, user: User, email: boolean): void {
    this.db.prepare(
      `INSERT INTO instance_signins (user_id, instance_id, email, confirmed_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, instance_id) DO UPDATE SET email = MAX(email, excluded.email), confirmed_at = excluded.confirmed_at`,
    ).run(user.id, instance.id, email ? 1 : 0, new Date().toISOString());
  }

  /** Restoring a snapshot rolls back everything, including data the rules keep from managers: only the owner of an instance that is not disabled. */
  canRestoreInstance(instance: Instance, user: User): boolean {
    return this.levelFor(instance, user) === 'owner';
  }

  /** Active users who can open the instance: owner, direct grantees and members of granted groups. */
  /** `matchEmail = false` matches the query against names only (so addresses cannot be probed). */
  usersWithAccess(instance: Instance, query?: string, limit = DEFAULT_LIMIT, matchEmail = true): User[] {
    const ids = new Set<string>([instance.ownerId]);
    for (const g of this.listGrants(instance.id)) {
      if (g.principalType === 'user') ids.add(g.principalId);
      else for (const m of this.groups.members(g.principalId)) ids.add(m.id);
    }
    const needle = (query ?? '').trim().toLowerCase();
    const max = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
    return [...ids].map((id) => this.users.get(id))
      .filter((u): u is User => u !== null && !u.disabled
        && (needle === '' || u.name.toLowerCase().includes(needle) || (matchEmail && u.email.toLowerCase().includes(needle))))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, max);
  }
}
