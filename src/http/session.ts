import type { Request, Response } from 'express';
import type { Core } from '../core.js';
import type { User } from '../platform/users.js';
import { readCookie, sessionCookieName, setCookie, THIRTY_DAYS_SECONDS } from './cookies.js';
import { signToken, verifyToken } from './tokens.js';

/** True while `ep` is the account's current session epoch and the account is usable. Tokens without a numeric `ep` never match. */
export function epochValid(user: User | null, ep: unknown): user is User {
  return user !== null && !user.disabled && typeof ep === 'number' && ep === user.sessionEpoch;
}

/**
 * Platform session: signed `{uid, ep}` without a kind. Tokens with a kind (`code`, `inst`) are never accepted here.
 * A session dies when the account's epoch moves on (logout, password change, disabling) and sessions issued before
 * epochs existed carry no `ep` and are rejected.
 */
export function sessionUser(core: Core, req: Request): User | null {
  const t = verifyToken<{ uid?: unknown; ep?: unknown; k?: unknown }>(readCookie(req, sessionCookieName(core.config)), core.config.secret);
  if (!t || t.k !== undefined || typeof t.uid !== 'string') return null;
  const user = core.users.get(t.uid);
  return epochValid(user, t.ep) ? user : null;
}

/** Sets the platform session cookie for `user` at the account's current epoch. */
export function issueSession(core: Core, res: Response, user: User): void {
  setCookie(res, core.config, sessionCookieName(core.config), signToken({ uid: user.id, ep: user.sessionEpoch }, core.config.secret, THIRTY_DAYS_SECONDS));
}

const CSRF_TTL_SECONDS = 12 * 3600;

/** Signed token that platform forms send back to prove they were rendered for this user. */
export const csrfToken = (core: Core, user: User): string => signToken({ uid: user.id, k: 'ui' }, core.config.secret, CSRF_TTL_SECONDS);

export function csrfValid(core: Core, user: User, value: unknown): boolean {
  const t = verifyToken<{ uid?: unknown; k?: unknown }>(typeof value === 'string' ? value : undefined, core.config.secret);
  return t !== null && t.k === 'ui' && t.uid === user.id;
}
