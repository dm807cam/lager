import type { Request } from 'express';
import type { Core } from '../core.js';
import type { User } from '../platform/users.js';
import { readCookie, SESSION_COOKIE } from './cookies.js';
import { verifyToken } from './tokens.js';

/** Platform session: signed `{uid}` without a kind. Tokens with a kind (`code`, `inst`) are never accepted here. */
export function sessionUser(core: Core, req: Request): User | null {
  const t = verifyToken<{ uid?: unknown; k?: unknown }>(readCookie(req, SESSION_COOKIE), core.config.secret);
  if (!t || t.k !== undefined || typeof t.uid !== 'string') return null;
  return core.users.get(t.uid);
}
