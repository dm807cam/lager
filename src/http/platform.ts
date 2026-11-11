import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import type { Core } from '../core.js';
import { clearCookie, sessionCookieName } from './cookies.js';
import { csrfValid, issueSession, sessionUser } from './session.js';
import { isLocale, t } from '../i18n/index.js';
import { badCodePage, disabledPage, forbiddenPage, loginPage, notFoundPage, sessionExpiredPage } from './pages.js';
import { LANG_COOKIE, ONE_YEAR_SECONDS, requestLocale } from './locale.js';
import { LagerError } from '../errors.js';
import { safeReturnPath, sendError } from './errors.js';
import { sameOriginGuard } from './origin.js';
import { signToken } from './tokens.js';
import { hostUrl, instanceUrl } from '../config.js';
import { normalizeHost } from '../platform/domains.js';
import type { PlatformExtension } from './app.js';

// dist/assets after a build, ../../assets next to src when running from source.
const ICON = fs.readFileSync([new URL('../assets/icon.webp', import.meta.url), new URL('../../assets/icon.webp', import.meta.url)]
  .find((u) => fs.existsSync(u)) ?? new URL('../assets/icon.webp', import.meta.url));

const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED_KEYS = 10_000;

/**
 * Failed login attempts within a sliding window, tracked per client IP and per account (e-mail).
 * Expired entries are swept on every failure and the number of tracked keys is capped.
 */
export class LoginLimiter {
  private byIp = new Map<string, number[]>();
  private byAccount = new Map<string, number[]>();

  private static recent(map: Map<string, number[]>, key: string): number[] {
    const cutoff = Date.now() - WINDOW_MS;
    const list = (map.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) map.set(key, list); else map.delete(key);
    return list;
  }

  private static sweep(map: Map<string, number[]>): void {
    const cutoff = Date.now() - WINDOW_MS;
    for (const [key, list] of map) {
      if (list[list.length - 1] <= cutoff) map.delete(key);
    }
    // Still full of live entries: drop the oldest keys so the map cannot grow without bound.
    while (map.size >= MAX_TRACKED_KEYS) map.delete(map.keys().next().value as string);
  }

  /** Number of keys currently tracked (IPs plus accounts). */
  get size(): number { return this.byIp.size + this.byAccount.size; }

  blocked(ip: string, account: string): boolean {
    return LoginLimiter.recent(this.byIp, ip).length >= MAX_FAILURES
      || LoginLimiter.recent(this.byAccount, account).length >= MAX_FAILURES;
  }

  fail(ip: string, account: string): void {
    LoginLimiter.sweep(this.byIp);
    LoginLimiter.sweep(this.byAccount);
    const now = Date.now();
    this.byIp.set(ip, [...LoginLimiter.recent(this.byIp, ip), now]);
    this.byAccount.set(account, [...LoginLimiter.recent(this.byAccount, account), now]);
  }
}

export function createPlatformRouter(core: Core, extensions: PlatformExtension[]): express.Router {
  const router = express.Router();
  const limiter = new LoginLimiter();
  const { config } = core;

  // Platform pages must never be framed: instances are same-site and could trick clicks.
  router.use((_req, res, next) => {
    res.set({ 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" });
    next();
  });

  router.get('/healthz', (_req, res) => { res.json({ ok: true }); });

  router.get('/icon.webp', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=604800').type('image/webp').send(ICON);
  });

  // `same-origin` lets browsers send the real Origin on the login post (`no-referrer` would make it `null`, which the guard refuses).
  const loginHeaders: express.RequestHandler = (_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin' });
    next();
  };

  // The language switcher of every platform page. The choice lives in a cookie and, for a signed-in account, on the account.
  router.get('/lang/:locale', (req, res) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) {
      res.status(404).type('html').send(notFoundPage(requestLocale(core, req)));
      return;
    }
    res.cookie(LANG_COOKIE, locale, {
      httpOnly: true, sameSite: 'lax', path: '/', secure: config.publicUrl.protocol === 'https:', maxAge: ONE_YEAR_SECONDS * 1000,
    });
    const user = sessionUser(core, req);
    // A cross-site link or image must not change the stored language of a signed-in account.
    if (user && req.get('Sec-Fetch-Site') !== 'cross-site') core.users.setLocale(user.id, locale);
    res.set('Cache-Control', 'no-store').redirect(safeReturnPath(req.query.return));
  });

  router.get('/login', loginHeaders, (req, res) => {
    const locale = requestLocale(core, req);
    res.type('html').send(loginPage(locale, safeReturnPath(req.query.return), undefined, {
      registration: core.settings.registration,
      notice: req.query.verified === '1' ? t(locale, 'login.verified') : undefined,
    }));
  });

  // Artifact code on an instance origin is same-site and could post this form to sign a visitor into another account.
  router.post('/login', loginHeaders, sameOriginGuard(core), express.urlencoded({ extended: false, limit: '10kb' }), (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ret = safeReturnPath(body.return);
    const locale = requestLocale(core, req);
    const ip = req.ip ?? 'unknown';
    const account = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 254) : '';
    if (limiter.blocked(ip, account)) {
      res.status(429).type('html').send(loginPage(locale, ret, t(locale, 'login.tooMany'), { registration: core.settings.registration }));
      return;
    }
    const result = typeof body.email === 'string' && typeof body.password === 'string'
      ? core.users.checkLogin(body.email, body.password) : { ok: false as const, reason: 'invalid' as const };
    if (!result.ok) {
      // Unverified and disabled are only reported after a correct password, so they do not count as failures.
      if (result.reason === 'invalid') limiter.fail(ip, account);
      const message = result.reason === 'unverified' ? t(locale, 'login.unverified')
        : result.reason === 'disabled' ? t(locale, 'login.disabled') : t(locale, 'login.invalid');
      res.status(401).type('html').send(loginPage(locale, ret, message, {
        registration: core.settings.registration, resendEmail: result.reason === 'unverified' ? account : undefined,
      }));
      return;
    }
    issueSession(core, res, result.user);
    res.redirect(ret);
  });

  router.post('/logout', express.urlencoded({ extended: false, limit: '10kb' }), (req, res) => {
    const user = sessionUser(core, req);
    const csrf = (req.body as Record<string, unknown> | undefined)?.csrf;
    if (!user || !csrfValid(core, user, csrf)) {
      res.status(403).type('html').send(sessionExpiredPage(requestLocale(core, req, user)));
      return;
    }
    // Ending the epoch signs the account out everywhere: every platform session, instance cookie and pending code.
    core.users.bumpEpoch(user.id);
    clearCookie(res, config, sessionCookieName(config));
    res.redirect('/login');
  });

  router.get('/auth/instance', (req, res) => {
    const user = sessionUser(core, req);
    if (!user) {
      res.redirect('/login?return=' + encodeURIComponent(req.originalUrl));
      return;
    }
    const locale = requestLocale(core, req, user);
    const slug = typeof req.query.slug === 'string' ? req.query.slug : '';
    const instance = core.apps.getInstanceBySlug(slug);
    if (!instance) {
      res.status(404).type('html').send(notFoundPage(locale));
      return;
    }
    // `host` is attacker-controlled: it counts only if it is attached to this very instance, and the redirect uses the stored form.
    let customHost: string | null = null;
    if (req.query.host !== undefined) {
      try {
        if (typeof req.query.host !== 'string') throw new LagerError('invalid_argument', 'host must be given once.');
        customHost = normalizeHost(req.query.host);
      } catch {
        res.status(400).type('html').send(badCodePage(locale));
        return;
      }
      if (core.domains.instanceIdFor(customHost) !== instance.id) {
        res.status(400).type('html').send(badCodePage(locale));
        return;
      }
    }
    if (instance.disabled) {
      res.status(403).type('html').send(disabledPage(locale));
      return;
    }
    if (core.access.levelFor(instance, user) === 'none') {
      res.status(403).type('html').send(forbiddenPage(locale));
      return;
    }
    const code = signToken({ uid: user.id, iid: instance.id, k: 'code', jti: crypto.randomUUID(), ep: user.sessionEpoch }, config.secret, 60);
    const back = safeReturnPath(req.query.return);
    res.redirect(`${customHost ? hostUrl(config, customHost) : instanceUrl(config, instance.slug)}/__lager/callback?code=${encodeURIComponent(code)}&return=${encodeURIComponent(back)}`);
  });

  for (const ext of extensions) ext(router, core);

  router.use((req, res) => {
    if (req.path.startsWith('/api/')) sendError(res, new LagerError('not_found', 'Not found.'));
    else res.status(404).type('html').send(notFoundPage(requestLocale(core, req)));
  });
  return router;
}
