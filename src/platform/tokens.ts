import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { LagerError } from '../errors.js';
import type { User, Users } from './users.js';

export interface ApiTokenInfo { id: string; name: string; userId: string; createdAt: string; lastUsedAt: string | null }

interface TokenRow { id: string; user_id: string; name: string; token_hash: string; created_at: string; last_used_at: string | null }

const PREFIX = 'lgr_';
const MAX_NAME = 100;

const toInfo = (r: TokenRow): ApiTokenInfo => ({
  id: r.id, name: r.name, userId: r.user_id, createdAt: r.created_at, lastUsedAt: r.last_used_at,
});

/** SHA-256 (hex) of a random secret; only this is ever stored. */
export function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

/** Constant-time comparison of two hex digests. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/** Static API tokens `lgr_…` used as bearer tokens by Claude Code and scripts. */
export class ApiTokens {
  constructor(private db: DatabaseSync, private users: Users) {}

  create(userId: string, name: string): { token: string; info: ApiTokenInfo } {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed || trimmed.length > MAX_NAME) {
      throw new LagerError('invalid_argument', `Token name must be 1 to ${MAX_NAME} characters.`);
    }
    if (!this.users.get(userId)) throw new LagerError('not_found', 'User not found.');
    const token = PREFIX + crypto.randomBytes(32).toString('base64url');
    const info: ApiTokenInfo = { id: crypto.randomUUID(), name: trimmed, userId, createdAt: new Date().toISOString(), lastUsedAt: null };
    this.db
      .prepare('INSERT INTO api_tokens (id, user_id, name, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, NULL)')
      .run(info.id, userId, info.name, hashSecret(token), info.createdAt);
    return { token, info };
  }

  verify(token: string): User | null {
    if (typeof token !== 'string' || !token.startsWith(PREFIX) || token.length > 200) return null;
    const hash = hashSecret(token);
    const row = this.db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').get(hash) as TokenRow | undefined;
    if (!row || !sameHash(row.token_hash, hash)) return null;
    const user = this.users.get(row.user_id);
    if (!user) return null;
    this.db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
    return user;
  }

  list(userId: string): ApiTokenInfo[] {
    const rows = this.db
      .prepare('SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at, name')
      .all(userId) as unknown as TokenRow[];
    return rows.map(toInfo);
  }

  revoke(userId: string, id: string): boolean {
    return Number(this.db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').run(id, userId).changes) > 0;
  }
}
