import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import type { Core } from '../core.js';
import { clearCookie, setCookie, SESSION_COOKIE, THIRTY_DAYS_SECONDS } from './cookies.js';
import { sessionUser } from './session.js';
import { forbiddenPage, loginPage, notFoundPage } from './pages.js';
import { levelFor } from './instance.js';
import { safeReturnPath } from './errors.js';
import { signToken } from './tokens.js';
import { instanceUrl } from '../config.js';
import type { PlatformExtension } from './app.js';

// dist/assets after a build, ../../assets next to src when running from source.
const ICON = fs.readFileSync([new URL('../assets/icon.webp', import.meta.url), new URL('../../assets/icon.webp', import.meta.url)]
  .find((u) => fs.existsSync(u)) ?? new URL('../assets/icon.webp', import.meta.url));

const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;

/** Failed login attempts per client IP within a sliding window. */
class LoginLimiter {
  private failures = new Map<string, number[]>();
  private recent(ip: string): number[] {
    const cutoff = Date.now() - WINDOW_MS;
    const list = (this.failures.get(ip) ?? []).filter((t) => t > cutoff);
    if (list.length) this.failures.set(ip, list); else this.failures.delete(ip);
    return list;
  }
  blocked(ip: string): boolean { return this.recent(ip).length >= MAX_FAILURES; }
  fail(ip: string): void { this.failures.set(ip, [...this.recent(ip), Date.now()]); }
}

export function createPlatformRouter(core: Core, extensions: PlatformExtension[]): express.Router {
  const router = express.Router();
  const limiter = new LoginLimiter();
  const { config } = core;

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
    res.set('Cache-Control', 'no-store');
    if (limiter.blocked(ip)) {
      res.status(429).type('html').send(loginPage(ret, 'Zu viele fehlgeschlagene Versuche. Bitte warte einige Minuten.'));
      return;
    }
    const user = typeof body.email === 'string' && typeof body.password === 'string'
      ? core.users.verifyPassword(body.email, body.password) : null;
    if (!user) {
      limiter.fail(ip);
      res.status(401).type('html').send(loginPage(ret, 'E-Mail oder Passwort ist falsch.'));
      return;
    }
    setCookie(res, config, SESSION_COOKIE, signToken({ uid: user.id }, config.secret, THIRTY_DAYS_SECONDS));
    res.redirect(ret);
  });

  router.post('/logout', (_req, res) => {
    clearCookie(res, config, SESSION_COOKIE);
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
    if (levelFor(instance, user.id) === 'none') {
      res.status(403).type('html').send(forbiddenPage());
      return;
    }
    const code = signToken({ uid: user.id, iid: instance.id, k: 'code', jti: crypto.randomUUID() }, config.secret, 60);
    const back = safeReturnPath(req.query.return);
    res.redirect(`${instanceUrl(config, instance.slug)}/__lager/callback?code=${encodeURIComponent(code)}&return=${encodeURIComponent(back)}`);
  });

  for (const ext of extensions) ext(router, core);

  router.use((_req, res) => { res.status(404).type('text/plain').send('Not found'); });
  return router;
}
