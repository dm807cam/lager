import type { Request, Response } from 'express';
import type { Config } from '../config.js';

const isHttps = (config: Config): boolean => config.publicUrl.protocol === 'https:';
/** Over https the `__Host-` prefix makes browsers reject cookies set by sibling subdomains (cookie tossing). */
export const sessionCookieName = (config: Config): string => (isHttps(config) ? '__Host-lager_session' : 'lager_session');
export const instanceCookieName = (config: Config): string => (isHttps(config) ? '__Host-lager_inst' : 'lager_inst');
export const nonceCookieName = (config: Config): string => (isHttps(config) ? '__Host-lager_nonce' : 'lager_nonce');
/** Shape of the sign-in nonce an instance hands to the platform. */
export const NONCE_RE = /^[A-Za-z0-9_-]{22,64}$/;
export const THIRTY_DAYS_SECONDS = 30 * 24 * 3600;

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Host-only (no Domain), HttpOnly cookie; Secure when the platform is served over https. */
export function setCookie(res: Response, config: Config, name: string, value: string, maxAgeSeconds = THIRTY_DAYS_SECONDS): void {
  res.cookie(name, value, {
    httpOnly: true, sameSite: 'lax', path: '/', secure: isHttps(config),
    maxAge: maxAgeSeconds * 1000,
  });
}

export function clearCookie(res: Response, config: Config, name: string): void {
  res.clearCookie(name, { httpOnly: true, sameSite: 'lax', path: '/', secure: isHttps(config) });
}
