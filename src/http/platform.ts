import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import type { Core } from '../core.js';
import { clearCookie, sessionCookieName, setCookie, THIRTY_DAYS_SECONDS } from './cookies.js';
import { csrfValid, sessionUser } from './session.js';
import { disabledPage, forbiddenPage, loginPage, notFoundPage, page } from './pages.js';
import { LagerError } from '../errors.js';
import { safeReturnPath, sendError } from './errors.js';
import { signToken } from './tokens.js';
import { instanceUrl } from '../config.js';
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

  router.get('/login', (req, res) => {
    res.set('Cache-Control', 'no-store').type('html').send(loginPage(safeReturnPath(req.query.return)));
  });

  router.post('/login', express.urlencoded({ extended: false, limit: '10kb' }), (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ret = safeReturnPath(body.return);
    const ip = req.ip ?? 'unknown';
    const account = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 254) : '';
    res.set('Cache-Control', 'no-store');
    if (limiter.blocked(ip, account)) {
      res.status(429).type('html').send(loginPage(ret, 'Zu viele fehlgeschlagene Versuche. Bitte warte einige Minuten.'));
      return;
    }
    const user = typeof body.email === 'string' && typeof body.password === 'string'
      ? core.users.verifyPassword(body.email, body.password) : null;
    if (!user) {
      limiter.fail(ip, account);
      res.status(401).type('html').send(loginPage(ret, 'E-Mail oder Passwort ist falsch.'));
      return;
    }
    setCookie(res, config, sessionCookieName(config), signToken({ uid: user.id }, config.secret, THIRTY_DAYS_SECONDS));
    res.redirect(ret);
  });

  router.post('/logout', express.urlencoded({ extended: false, limit: '10kb' }), (req, res) => {
    const user = sessionUser(core, req);
    const csrf = (req.body as Record<string, unknown> | undefined)?.csrf;
    if (!user || !csrfValid(core, user, csrf)) {
      res.status(403).type('html').send(page('Fehler', '<h1>Das hat nicht geklappt</h1><p class="err">Die Sitzung ist abgelaufen. Bitte lade die Seite neu und versuche es erneut.</p><p><a href="/">Zurück zur Übersicht</a></p>'));
      return;
    }
    clearCookie(res, config, sessionCookieName(config));
    res.redirect('/login');
  });

  router.get('/auth/instance', (req, res) => {
    const user = sessionUser(core, req);
    if (!user) {
      res.redirect('/login?return=' + encodeURIComponent(req.originalUrl));
      return;
    }
    const slug = typeof req.query.slug === 'string' ? req.query.slug : '';
    const instance = core.apps.getInstanceBySlug(slug);
    if (!instance) {
      res.status(404).type('html').send(notFoundPage());
      return;
    }
    if (instance.disabled) {
      res.status(403).type('html').send(disabledPage());
      return;
    }
    if (core.access.levelFor(instance, user) === 'none') {
      res.status(403).type('html').send(forbiddenPage());
      return;
    }
    const code = signToken({ uid: user.id, iid: instance.id, k: 'code', jti: crypto.randomUUID() }, config.secret, 60);
    const back = safeReturnPath(req.query.return);
    res.redirect(`${instanceUrl(config, instance.slug)}/__lager/callback?code=${encodeURIComponent(code)}&return=${encodeURIComponent(back)}`);
  });

  for (const ext of extensions) ext(router, core);

  router.use((req, res) => {
    if (req.path.startsWith('/api/')) sendError(res, new LagerError('not_found', 'Not found.'));
    else res.status(404).type('html').send(notFoundPage());
  });
  return router;
}
