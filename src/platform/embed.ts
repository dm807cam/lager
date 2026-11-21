import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { LagerError } from '../errors.js';
import type { Capabilities } from './apps.js';
import type { Domains } from './domains.js';
import { normalizeOrigin } from './ingest.js';

/** At most this many websites may show one instance in a frame. */
export const EMBED_LIMITS = { origins: 20 } as const;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Checks the `embed` declaration of an app. It carries no fields: it only says that the app is built to be shown in a frame
 * on other websites. Which websites is decided per instance by the people who manage it (`Embed.setOrigins`), never by the
 * declaration, so a deploy alone can never make an instance frameable. A field Lager does not know fails the deploy.
 */
export function parseEmbed(declaration: unknown): void {
  if (!isObject(declaration)) throw new LagerError('invalid_argument', 'embed must be an object.');
  const unknown = Object.keys(declaration);
  if (unknown.length > 0) {
    throw new LagerError('invalid_argument', `embed has no field "${unknown[0]}"; the websites that may embed an instance are set per instance by the people who manage it.`);
  }
}

/** Whether the capabilities of a version declare `embed` in a form `parseEmbed` accepts. */
export function embedDeclared(caps: Capabilities | undefined): boolean {
  if (!caps || !Object.prototype.hasOwnProperty.call(caps, 'embed')) return false;
  try {
    parseEmbed(caps.embed);
    return true;
  } catch {
    return false;
  }
}

/**
 * The websites that may show an instance in a frame (`Content-Security-Policy: frame-ancestors`).
 *
 * Instances under the apps domain are same-site with each other, so the browser sends an instance's `SameSite=Lax` session
 * cookie into a frame that another instance (code nobody reviewed) opens: that is why an instance may otherwise only frame
 * itself. A website outside Lager is a different site, and there the browser sends no `Lax` cookie into the frame at all, so the
 * framed instance only ever sees a guest. What may never be named is therefore every host that serves an instance: the apps
 * domain and everything under it, the custom domains of instances, and the platform host, which serves no instance but is
 * Lager's own.
 */
export class Embed {
  constructor(private db: DatabaseSync, private config: Config, private domains: Domains) {}

  /** Whether `host` is served by this Lager: an instance name, a custom domain of an instance, or the platform. */
  isLagerHost(host: string): boolean {
    const h = host.toLowerCase().replace(/\.$/, '');
    const apps = this.config.appsDomain.toLowerCase();
    const platform = this.config.publicUrl.hostname.toLowerCase();
    return h === apps || h.endsWith('.' + apps) || h === platform || h.endsWith('.' + platform) || this.domains.instanceIdFor(h) !== null;
  }

  private lagerOrigin(origin: string): boolean {
    return this.isLagerHost(new URL(origin).hostname);
  }

  /** The websites the people who manage the instance named, as stored, whatever the active version declares. */
  origins(instanceId: string): string[] {
    const row = this.db.prepare('SELECT origins FROM embed_origins WHERE instance_id = ?').get(instanceId) as { origins: string } | undefined;
    if (!row) return [];
    try {
      const list: unknown = JSON.parse(row.origins);
      return Array.isArray(list) ? list.filter((o): o is string => typeof o === 'string') : [];
    } catch {
      return [];
    }
  }

  /**
   * Replaces the websites of the instance. Every new entry must be exactly a web origin, not `*` and not a host of this Lager;
   * the list holds at most `EMBED_LIMITS.origins`. Entries that are stored already are kept as they are, so a website can always
   * be removed, also one that has since become a custom domain (`frameAncestors` leaves those out). Throws `invalid_argument`
   * with a stable reason: `origin_invalid`, `origin_lager` or `embed_limit`.
   */
  setOrigins(instanceId: string, list: unknown): string[] {
    if (!Array.isArray(list)) throw new LagerError('invalid_argument', 'origins must be a list of websites.');
    const current = this.origins(instanceId);
    const out: string[] = [];
    for (const o of list as unknown[]) {
      const origin = o === '*' ? null : normalizeOrigin(typeof o === 'string' ? o.trim() : o);
      if (origin === null) {
        // Echo only the start of what was sent: the body may be 16 kB.
        throw new LagerError('invalid_argument', `"${String(o).slice(0, 100)}" is not a website address; write it like https://blog.example.com, without a path.`, 'origin_invalid');
      }
      if (!current.includes(origin) && this.lagerOrigin(origin)) {
        throw new LagerError('invalid_argument', `${origin} is served by this Lager; instances and the platform cannot embed an instance.`, 'origin_lager');
      }
      if (!out.includes(origin)) out.push(origin);
    }
    if (out.length > EMBED_LIMITS.origins && !out.every((o) => current.includes(o))) {
      throw new LagerError('invalid_argument', `At most ${EMBED_LIMITS.origins} websites may embed an instance.`, 'embed_limit');
    }
    if (out.length === 0) this.db.prepare('DELETE FROM embed_origins WHERE instance_id = ?').run(instanceId);
    else {
      this.db.prepare(
        `INSERT INTO embed_origins (instance_id, origins) VALUES (?, ?)
         ON CONFLICT(instance_id) DO UPDATE SET origins = excluded.origins`,
      ).run(instanceId, JSON.stringify(out));
    }
    return out;
  }

  /**
   * The websites that may frame the instance right now: none unless the active version declares `embed`, and never a host of
   * this Lager, also one that became a custom domain after it was named. Checked on every response, so adding a custom domain
   * closes it at once.
   */
  frameAncestors(instanceId: string, caps: Capabilities | undefined): string[] {
    if (!embedDeclared(caps)) return [];
    return this.origins(instanceId).filter((o) => normalizeOrigin(o) === o && !this.lagerOrigin(o)).slice(0, EMBED_LIMITS.origins);
  }
}
