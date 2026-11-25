import type { Request, Response } from 'express';
import type { Core } from '../core.js';
import { isMessageKey, type MessageKey } from '../i18n/index.js';
import type { User } from '../platform/users.js';
import { clearPlantedSession, deviceCookieName, readCookie, sessionCookieName, sessionCookiePlanted, setCookie, THIRTY_DAYS_SECONDS } from './cookies.js';
import { openToken, sealToken, signToken, verifyToken } from './tokens.js';

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

const DEVICE_TTL_SECONDS = 365 * 24 * 3600;

/**
 * Marks this browser as one that has just proved control of the account: by signing in, by setting a password through a reset link,
 * by confirming the address with the password, or by changing the password. The pause of an account under attack does not apply
 * to such a browser (see `LoginLimiter`). The cookie signs nobody in, and it stops counting when the password changes.
 */
export function markDevice(core: Core, res: Response, user: User): void {
  setCookie(res, core.config, deviceCookieName(core.config),
    signToken({ uid: user.id, k: 'dev', p: core.users.passwordMark(user.id) }, core.config.secret, DEVICE_TTL_SECONDS), DEVICE_TTL_SECONDS);
}

/** True when the browser carries the device cookie of this account, made under its current password. */
export function knownDevice(core: Core, req: Request, user: User): boolean {
  const d = verifyToken<{ uid?: unknown; k?: unknown; p?: unknown }>(readCookie(req, deviceCookieName(core.config)), core.config.secret);
  return d !== null && d.k === 'dev' && d.uid === user.id && typeof d.p === 'string' && d.p === core.users.passwordMark(user.id);
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
/** Values a flash may fill into its text: at most this many, each at most this long. */
const MAX_FLASH_PARAMS = 4;
const MAX_FLASH_PARAM = 300;
/** Ids of the sections a notice may be placed above: plain words, so they can never end an attribute or a URL fragment. */
const FLASH_ANCHOR = /^[a-z][a-z0-9-]{0,40}$/;

/**
 * A one-line notice for the next page view, as a catalog key; the page renders it in the viewer's language. `params` fill the
 * key's placeholders (names, addresses, versions); they are plain text and escaped where shown. `anchor` is the id of the section
 * that changed: the notice is shown right above it, and the redirect scrolls there.
 */
export interface Flash { ok?: MessageKey; error?: MessageKey; params?: Record<string, string>; anchor?: string; undo?: Undo }
/** A form that takes a change back: the route it posts to (a path of this platform) and the fields it sends besides the CSRF token. */
export interface Undo { action: string; fields: Record<string, string> }
/** Undo forms post only to the platform's own form routes. */
const UNDO_ACTION = /^\/(?:ui|admin)(?:\/[A-Za-z0-9%_-]{1,100}){1,6}$/;
/** An encoded dot: a browser resolves `%2e%2e` as `..` in a form action, so no Undo path may hold one. */
const ENCODED_DOT = /%2e/i;

/**
 * Short-lived `flash` query value carrying the key of a notice, its values and its place to the page a POST redirects to. It is
 * sealed, not only signed: the values name people (an address something was shared with), and URLs end up in browser history
 * and in the access logs of reverse proxies. A value longer than a notice may show is cut, so the notice keeps its other values.
 */
export const flashToken = (core: Core, user: User, flash: Flash): string =>
  sealToken({
    uid: user.id, k: 'flash', e: flash.error !== undefined ? 1 : 0, m: flash.error ?? flash.ok ?? '',
    ...(flash.params ? { p: Object.fromEntries(Object.entries(flash.params).slice(0, MAX_FLASH_PARAMS).map(([k, v]) => [k, clipParam(v)])) } : {}),
    ...(flash.anchor ? { a: flash.anchor } : {}), ...(flash.undo ? { u: flash.undo } : {}),
  }, core.config.secret, FLASH_TTL_SECONDS);

/** A value cut to what a notice shows, with an ellipsis where it was cut. */
const clipParam = (value: string): string => (value.length > MAX_FLASH_PARAM ? `${value.slice(0, MAX_FLASH_PARAM - 1)}…` : value);

/** The values of a flash as plain strings, or nothing when they are not what `flashToken` writes. */
function flashParams(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_FLASH_PARAMS || !entries.every(([, v]) => typeof v === 'string' && v.length <= MAX_FLASH_PARAM)) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

/** The notice of a valid flash value issued to this user; anything else, including a value that is not a catalog key, yields nothing. */
export function readFlash(core: Core, user: User, value: unknown): Flash {
  const t = openToken<{ uid?: unknown; k?: unknown; e?: unknown; m?: unknown; p?: unknown; a?: unknown; u?: unknown }>(typeof value === 'string' ? value : undefined, core.config.secret);
  if (t === null || t.k !== 'flash' || t.uid !== user.id || !isMessageKey(t.m)) return {};
  const params = flashParams(t.p);
  const u = t.u as { action?: unknown; fields?: unknown } | null | undefined;
  const undoFields = u && typeof u === 'object' ? flashParams(u.fields) : undefined;
  const undo = u && typeof u.action === 'string' && UNDO_ACTION.test(u.action) && !ENCODED_DOT.test(u.action) && undoFields ? { action: u.action, fields: undoFields } : undefined;
  const extra = { ...(params ? { params } : {}), ...(typeof t.a === 'string' && FLASH_ANCHOR.test(t.a) ? { anchor: t.a } : {}), ...(undo ? { undo } : {}) };
  return t.e === 1 ? { error: t.m, ...extra } : { ok: t.m, ...extra };
}

/** Where a POST sends the browser to show `flash` on `path`: the sealed value in the query, the changed section as the fragment. */
export const flashUrl = (core: Core, user: User, path: string, flash: Flash): string =>
  `${path}?flash=${encodeURIComponent(flashToken(core, user, flash))}${flash.anchor && FLASH_ANCHOR.test(flash.anchor) ? '#notice' : ''}`;
