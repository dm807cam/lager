import type { Request, Response } from 'express';
import type { Core } from '../core.js';
import { isMessageKey, type MessageKey } from '../i18n/index.js';
import type { User } from '../platform/users.js';
import { clearPlantedSession, readCookie, sessionCookieName, sessionCookiePlanted, setCookie, THIRTY_DAYS_SECONDS } from './cookies.js';
import { signToken, verifyToken } from './tokens.js';

/** True while `ep` is the account's current session epoch and the account is usable. Tokens without a numeric `ep` never match. */
export function epochValid(user: User | null, ep: unknown): user is User {
  return user !== null && !user.disabled && typeof ep === 'number' && ep === user.sessionEpoch;
}

/**
 * Platform session: signed `{uid, ep}` without a kind. Tokens with a kind (`code`, `inst`) are never accepted here.
 * A session dies when the account's epoch moves on (logout, password change, disabling) and sessions issued before
 * epochs existed carry no `ep` and are rejected. A request that carries the session cookie twice is signed out: which of the two
 * the browser lists first is up to whoever planted the second.
 */
export function sessionUser(core: Core, req: Request): User | null {
  if (sessionCookiePlanted(req, core.config)) {
    if (req.res && !req.res.headersSent && !req.res.locals.sessionCleared) {
      clearPlantedSession(req.res, core.config);
      req.res.locals.sessionCleared = true;
    }
    return null;
  }
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

/**
 * Signed token that platform forms send back to prove they were rendered for this user. Like a session it carries the account's
 * epoch, so a form rendered before a sign-out or a password change is worthless afterwards.
 */
export const csrfToken = (core: Core, user: User): string => signToken({ uid: user.id, k: 'ui', ep: user.sessionEpoch }, core.config.secret, CSRF_TTL_SECONDS);

export function csrfValid(core: Core, user: User, value: unknown): boolean {
  const t = verifyToken<{ uid?: unknown; k?: unknown; ep?: unknown }>(typeof value === 'string' ? value : undefined, core.config.secret);
  return t !== null && t.k === 'ui' && t.uid === user.id && t.ep === user.sessionEpoch;
}

const FLASH_TTL_SECONDS = 120;
/** A one-line notice for the next page view, as a catalog key; the page renders it in the viewer's language. */
export interface Flash { ok?: MessageKey; error?: MessageKey }

/** Signed, short-lived `flash` query value carrying only the key of a notice to the page a POST redirects to. */
export const flashToken = (core: Core, user: User, flash: Flash): string =>
  signToken({ uid: user.id, k: 'flash', e: flash.error !== undefined ? 1 : 0, m: flash.error ?? flash.ok ?? '' }, core.config.secret, FLASH_TTL_SECONDS);

/** The notice of a valid flash value issued to this user; anything else, including a value that is not a catalog key, yields nothing. */
export function readFlash(core: Core, user: User, value: unknown): Flash {
  const t = verifyToken<{ uid?: unknown; k?: unknown; e?: unknown; m?: unknown }>(typeof value === 'string' ? value : undefined, core.config.secret);
  if (t === null || t.k !== 'flash' || t.uid !== user.id || !isMessageKey(t.m)) return {};
  return t.e === 1 ? { error: t.m } : { ok: t.m };
}
