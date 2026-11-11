import type { Request, Response } from 'express';
import type { Core } from '../core.js';
import { isLocale, negotiateLocale, type Locale } from '../i18n/index.js';
import type { User } from '../platform/users.js';
import { readCookie } from './cookies.js';
import { sessionUser } from './session.js';

export const LANG_COOKIE = 'lager_lang';
export const ONE_YEAR_SECONDS = 365 * 24 * 3600;

/**
 * The language of a request: the signed-in account's stored choice, then the `lager_lang` cookie, then `Accept-Language`,
 * then the configured default. `user` is the viewer when the caller already knows them (an instance viewer); when it is
 * left out, the platform session is consulted.
 */
export function requestLocale(core: Core, req: Request, user?: User | null): Locale {
  const viewer = user === undefined ? sessionUser(core, req) : user;
  if (viewer?.locale) return viewer.locale;
  const cookie = readCookie(req, LANG_COOKIE);
  if (isLocale(cookie)) return cookie;
  return negotiateLocale(req.get('accept-language'), core.config.defaultLocale);
}

/** The locale `requireUser` resolved for the signed-in request (stored choice, cookie, browser, default). */
export const localeOf = (res: Response): Locale => res.locals.locale as Locale;
