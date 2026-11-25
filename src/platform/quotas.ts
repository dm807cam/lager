import type { DatabaseSync } from 'node:sqlite';
import { LagerError } from '../errors.js';

const MIB = 1024 * 1024;
/** The largest storage an administrator can set for an app or a group: 1 TiB. */
export const MAX_QUOTA_MB = 1024 * 1024;

/** Where the storage of an instance comes from: its app, a group of its owner, or the server's setting. */
export type QuotaSource = 'app' | 'group' | 'default';

/**
 * The storage per instance (documents, uploaded files and self-saved pages together). An administrator can set it for all
 * instances of one app, and for all instances owned by the members of one group; without either it is `defaultBytes`
 * (LAGER_INSTANCE_QUOTA_MB). The app's setting comes first, because it is the more specific one. Of the groups of the owner,
 * the largest setting applies, so being in one more group never takes space away.
 */
export class Quotas {
  constructor(private db: DatabaseSync, readonly defaultBytes: number) {}

  /** The setting of an app or a group in bytes, `null` to follow the next rule again. */
  private static check(bytes: number | null): number | null {
    if (bytes === null) return null;
    if (!Number.isSafeInteger(bytes) || bytes < MIB || bytes > MAX_QUOTA_MB * MIB) {
      throw new LagerError('invalid_argument', `Storage must be a whole number of bytes from 1 MiB to ${MAX_QUOTA_MB} MiB.`);
    }
    return bytes;
  }

  /** What the instance may use, in bytes (0 = unlimited), and where that comes from. An unknown instance gets the default. */
  resolve(instanceId: string): { bytes: number; source: QuotaSource } {
    const r = this.db.prepare(`SELECT a.quota_bytes AS app,
      (SELECT MAX(g.quota_bytes) FROM group_members m JOIN groups g ON g.id = m.group_id WHERE m.user_id = i.owner_id) AS grp
      FROM instances i JOIN apps a ON a.id = i.app_id WHERE i.id = ?`).get(instanceId) as { app: number | null; grp: number | null } | undefined;
    if (r?.app != null) return { bytes: Number(r.app), source: 'app' };
    if (r?.grp != null) return { bytes: Number(r.grp), source: 'group' };
    return { bytes: this.defaultBytes, source: 'default' };
  }

  /** What the instance may use, in bytes; 0 = unlimited. */
  of(instanceId: string): number {
    return this.resolve(instanceId).bytes;
  }

  /** The storage set for the instances of an app, `null` when it follows the groups and the default. */
  ofApp(appId: string): number | null {
    const r = this.db.prepare('SELECT quota_bytes FROM apps WHERE id = ?').get(appId) as { quota_bytes: number | null } | undefined;
    return r?.quota_bytes == null ? null : Number(r.quota_bytes);
  }

  setApp(appId: string, bytes: number | null): void {
    const value = Quotas.check(bytes);
    if (Number(this.db.prepare('UPDATE apps SET quota_bytes = ? WHERE id = ?').run(value, appId).changes) === 0) {
      throw new LagerError('not_found', 'App not found.');
    }
  }

  /** The storage set for the instances the group's members own, `null` when the group sets none. */
  ofGroup(groupId: string): number | null {
    const r = this.db.prepare('SELECT quota_bytes FROM groups WHERE id = ?').get(groupId) as { quota_bytes: number | null } | undefined;
    return r?.quota_bytes == null ? null : Number(r.quota_bytes);
  }

  setGroup(groupId: string, bytes: number | null): void {
    const value = Quotas.check(bytes);
    if (Number(this.db.prepare('UPDATE groups SET quota_bytes = ? WHERE id = ?').run(value, groupId).changes) === 0) {
      throw new LagerError('not_found', 'Group not found.');
    }
  }
}
