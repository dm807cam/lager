import type { Request } from 'express';
import type { Core } from '../core.js';
import type { User } from '../platform/users.js';
import { readCookie, sessionCookieName } from './cookies.js';
import { signToken, verifyToken } from './tokens.js';

/** Platform session: signed `{uid}` without a kind. Tokens with a kind (`code`, `inst`) are never accepted here. */
export function sessionUser(core: Core, req: Request): User | null {
  const t = verifyToken<{ uid?: unknown; k?: unknown }>(readCookie(req, sessionCookieName(core.config)), core.config.secret);
  if (!t || t.k !== undefined || typeof t.uid !== 'string') return null;
  return core.users.get(t.uid);
}

const CSRF_TTL_SECONDS = 12 * 3600;

/** Signed token that platform forms send back to prove they were rendered for this user. */
export const csrfToken = (core: Core, user: User): string => signToken({ uid: user.id, k: 'ui' }, core.config.secret, CSRF_TTL_SECONDS);

export function csrfValid(core: Core, user: User, value: unknown): boolean {
  const t = verifyToken<{ uid?: unknown; k?: unknown }>(typeof value === 'string' ? value : undefined, core.config.secret);
  return t !== null && t.k === 'ui' && t.uid === user.id;
}
