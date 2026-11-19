import type { Request, Response } from 'express';
import { isLoopbackHost, type Config } from '../config.js';

const isHttps = (config: Config): boolean => config.publicUrl.protocol === 'https:';
/** Over https the `__Host-` prefix makes browsers reject cookies set by sibling subdomains (cookie tossing). */
export const sessionCookieName = (config: Config): string => (isHttps(config) ? '__Host-lager_session' : 'lager_session');
export const instanceCookieName = (config: Config): string => (isHttps(config) ? '__Host-lager_inst' : 'lager_inst');
export const nonceCookieName = (config: Config): string => (isHttps(config) ? '__Host-lager_nonce' : 'lager_nonce');
/** Marks a browser that has signed in to an account before; see `LoginLimiter`. */
export const deviceCookieName = (config: Config): string => (isHttps(config) ? '__Host-lager_device' : 'lager_device');
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

/**
 * True when the request carries the platform session cookie more than once, which a browser does only when a second one was planted
 * for a parent domain or another path. Over plain http nothing stops an app on a sibling host from doing that (there is no `__Host-`
 * prefix to refuse it), and the planted cookie would sign the visitor in to the attacker's account. Over https it cannot happen.
 */
export function sessionCookiePlanted(req: Request, config: Config): boolean {
  if (isHttps(config)) return false;
  const name = sessionCookieName(config);
  return (req.headers.cookie ?? '').split(';').filter((part) => part.slice(0, Math.max(part.indexOf('='), 0)).trim() === name).length > 1;
}

/** Clears the platform session cookie of this host and of every parent domain a planted one may have been set for. */
export function clearPlantedSession(res: Response, config: Config): void {
  const name = sessionCookieName(config);
  clearCookie(res, config, name);
  const labels = config.publicUrl.hostname.split('.');
  for (let i = 0; i < labels.length; i++) res.clearCookie(name, { path: '/', domain: labels.slice(i).join('.') });
}

/** Said once at startup when the public URL is plain http on a name other machines use (the installer's "this network only" mode). */
export function warnIfPlainHttp(config: Config): void {
  if (isHttps(config) || isLoopbackHost(config.publicUrl.hostname)) return;
  console.warn(`${config.publicUrl.origin} is plain http. Without https a cookie is not bound to one host, so an app on this server `
    + 'can plant a session cookie and sign a visitor in to an account of its choosing. Host only apps you trust, or put https in front.');
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
