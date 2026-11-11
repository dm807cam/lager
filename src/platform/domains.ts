import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { LagerError } from '../errors.js';
import type { Instance } from './apps.js';
import type { Settings } from './settings.js';
import type { User } from './users.js';

const MAX_HOST = 253;
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Lower-cases a DNS hostname and drops one trailing dot. Requires at least two labels of `[a-z0-9-]`, no port and no IP literal.
 * The character check runs before lower-casing, so characters that only fold to ASCII (such as the Kelvin sign) are refused.
 */
export function normalizeHost(input: string): string {
  const bad = (): never => { throw new LagerError('invalid_argument', 'Das ist kein gültiger Hostname.'); };
  if (typeof input !== 'string') return bad();
  let host = input.trim();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.length === 0 || host.length > MAX_HOST || !/^[A-Za-z0-9.-]+$/.test(host)) return bad();
  host = host.toLowerCase();
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l))) return bad();
  // An all-numeric last label is an IPv4 address (or a malformed one), never a registrable name.
  if (/^[0-9]+$/.test(labels[labels.length - 1])) return bad();
  return host;
}

/**
 * Custom hostnames per instance. A host belongs to at most one instance on the whole server. Lager does not verify
 * ownership of the DNS name: the administrator decides who may attach domains (`Settings.customDomains`).
 */
export class Domains {
  /** host → instance id; loaded on first use, dropped on every change. */
  private cache: Map<string, string> | null = null;

  constructor(private db: DatabaseSync, private config: Config, private settings: Settings) {}

  canManage(user: User, canManageInstance: boolean): boolean {
    if (user.disabled) return false;
    if (user.role === 'admin') return true;
    return user.role === 'publisher' && this.settings.customDomains === 'publishers' && canManageInstance;
  }

  private assertCanManage(user: User, canManageInstance: boolean): void {
    if (!this.canManage(user, canManageInstance)) throw new LagerError('forbidden', 'Du darfst für diese Instanz keine eigenen Domains verwalten.');
  }

  add(instance: Instance, host: string, by: User, canManageInstance: boolean): string {
    this.assertCanManage(by, canManageInstance);
    const normalized = normalizeHost(host);
    const apps = this.config.appsDomain.toLowerCase();
    if (normalized === this.config.publicUrl.hostname.toLowerCase() || normalized === apps || normalized.endsWith('.' + apps)) {
      throw new LagerError('invalid_argument', 'Diese Domain kann nicht verwendet werden.');
    }
    try {
      this.db.prepare('INSERT INTO instance_domains (host, instance_id, created_by, created_at) VALUES (?, ?, ?, ?)')
        .run(normalized, instance.id, by.id, new Date().toISOString());
    } catch (e) {
      if (/UNIQUE|PRIMARY KEY/i.test(String((e as Error).message))) throw new LagerError('conflict', 'Diese Domain ist bereits vergeben.');
      throw e;
    } finally {
      this.cache = null;
    }
    return normalized;
  }

  remove(instance: Instance, host: string, by: User, canManageInstance: boolean): boolean {
    this.assertCanManage(by, canManageInstance);
    const normalized = normalizeHost(host);
    const res = this.db.prepare('DELETE FROM instance_domains WHERE host = ? AND instance_id = ?').run(normalized, instance.id);
    this.cache = null;
    return Number(res.changes) > 0;
  }

  list(instanceId: string): string[] {
    return (this.db.prepare('SELECT host FROM instance_domains WHERE instance_id = ? ORDER BY host').all(instanceId) as Array<{ host: string }>).map((r) => r.host);
  }

  /** The instance a request host belongs to, or null. Case-insensitive; one trailing dot is ignored. */
  instanceIdFor(host: string): string | null {
    if (!this.cache) {
      this.cache = new Map((this.db.prepare('SELECT host, instance_id FROM instance_domains').all() as Array<{ host: string; instance_id: string }>)
        .map((r) => [r.host, r.instance_id]));
    }
    const key = host.toLowerCase().replace(/\.$/, '');
    return this.cache.get(key) ?? null;
  }

  removeAll(instanceId: string): void {
    this.db.prepare('DELETE FROM instance_domains WHERE instance_id = ?').run(instanceId);
    this.cache = null;
  }
}
