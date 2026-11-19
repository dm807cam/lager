import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import type { Core } from '../core.js';
import { addressKey } from './client-address.js';
import { clearCookie, deviceCookieName, NONCE_RE, readCookie, sessionCookieName, setCookie, warnIfPlainHttp } from './cookies.js';
import { csrfToken, csrfValid, issueSession, sessionUser } from './session.js';
import { isLocale, t } from '../i18n/index.js';
import { authCard, badCodePage, disabledPage, esc, forbiddenPage, hiddenField, loginPage, notFoundPage, page, sessionExpiredPage } from './pages.js';
import { btn, icon } from './ui.js';
import { LANG_COOKIE, ONE_YEAR_SECONDS, requestLocale } from './locale.js';
import { LagerError } from '../errors.js';
import { safeReturnPath, sendError } from './errors.js';
import { sameOriginGuard } from './origin.js';
import { signToken, verifyToken } from './tokens.js';
import { hostUrl, instanceUrl } from '../config.js';
import type { Instance } from '../platform/apps.js';
import type { User } from '../platform/users.js';
import type { Locale } from '../i18n/index.js';
import { normalizeHost } from '../platform/domains.js';
import { fallbackIconPath } from '../platform/fallback-icon.js';
import type { PlatformExtension } from './app.js';

// dist/assets after a build, ../../assets next to src when running from source.
const asset = (name: string): Buffer => fs.readFileSync([new URL(`../assets/${name}`, import.meta.url), new URL(`../../assets/${name}`, import.meta.url)]
  .find((u) => fs.existsSync(u)) ?? new URL(`../assets/${name}`, import.meta.url));
const ICON = asset('icon.webp');
const PLATFORM_ICONS = new Map([180, 192, 512].map((size) => [size, asset(`icon-${size}.png`)] as const));
const PLATFORM_MANIFEST = JSON.stringify({
  name: 'Lager', short_name: 'Lager',
  start_url: '/', scope: '/', display: 'standalone', background_color: '#1f2a5c', theme_color: '#1f2a5c',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  ],
});
const ICON_FILE = /^(64|192|512)\.png$/;

const MAX_FAILURES = 10;
/** Failures one address may still make against an account that is already under attack from elsewhere. */
const MAX_FAILURES_HOT_ACCOUNT = 3;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED_KEYS = 10_000;
/** Consecutive failures on one account, from anywhere, before it refuses sign-ins for a while. */
const ACCOUNT_MAX_FAILURES = 10;
/** The first pause; every further failure doubles it, up to the longest one. */
const ACCOUNT_PAUSE_MS = 30 * 1000;
const ACCOUNT_PAUSE_MAX_MS = 15 * 60 * 1000;

/**
 * Failed login attempts within a sliding window, tracked per client IP, per account (e-mail) and per pair of both.
 * An address is refused after `MAX_FAILURES` failures. An account that collected that many failures is not locked for
 * everyone, or anybody could keep its owner out: only addresses that themselves failed on it are refused, and sooner.
 * Expired entries are swept on every failure and the number of tracked keys is capped.
 *
 * Addresses are cheap (a botnet, or the 2^64 of one IPv6 prefix), so the account also counts its consecutive failures whatever
 * the address: from the tenth on, each failure pauses the account, for 30 seconds at first and twice as long each time, up to
 * 15 minutes. During a pause an attempt is turned away before the password is looked at, with the answer a wrong password gets.
 * A correct password, or 15 quiet minutes after the last pause, starts the count again. The pause does not apply to a browser
 * that has signed in to the account before (see the device cookie in the login route), so guessing does not keep the owner out.
 */
export class LoginLimiter {
  private byIp = new Map<string, number[]>();
  private byAccount = new Map<string, number[]>();
  private byPair = new Map<string, number[]>();
  private paused = new Map<string, { failures: number; last: number; until: number }>();
  private static pair = (ip: string, account: string): string => `${account}\n${ip}`;

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
    if (LoginLimiter.recent(this.byIp, ip).length >= MAX_FAILURES) return true;
    return LoginLimiter.recent(this.byAccount, account).length >= MAX_FAILURES
      && LoginLimiter.recent(this.byPair, LoginLimiter.pair(ip, account)).length >= MAX_FAILURES_HOT_ACCOUNT;
  }

  /** True while the account takes no sign-in from a browser it does not know. */
  accountPaused(account: string): boolean {
    return Date.now() < (this.paused.get(account)?.until ?? 0);
  }

  /** The password was right: the account's count of consecutive failures starts again. */
  succeed(account: string): void {
    this.paused.delete(account);
  }

  private failAccount(account: string, now: number): void {
    for (const [key, e] of this.paused) {
      if (now - Math.max(e.last, e.until) >= WINDOW_MS) this.paused.delete(key);
    }
    const failures = (this.paused.get(account)?.failures ?? 0) + 1;
    const over = failures - ACCOUNT_MAX_FAILURES;
    // Re-inserted at the end: when the map is full, the accounts that were failed on longest ago go first.
    this.paused.delete(account);
    while (this.paused.size >= MAX_TRACKED_KEYS) this.paused.delete(this.paused.keys().next().value as string);
    this.paused.set(account, { failures, last: now, until: over < 0 ? 0 : now + Math.min(ACCOUNT_PAUSE_MS * 2 ** over, ACCOUNT_PAUSE_MAX_MS) });
  }

  fail(ip: string, account: string): void {
    LoginLimiter.sweep(this.byIp);
    LoginLimiter.sweep(this.byAccount);
    LoginLimiter.sweep(this.byPair);
    const now = Date.now();
    const pair = LoginLimiter.pair(ip, account);
    this.byIp.set(ip, [...LoginLimiter.recent(this.byIp, ip), now]);
    this.byAccount.set(account, [...LoginLimiter.recent(this.byAccount, account), now]);
    this.byPair.set(pair, [...LoginLimiter.recent(this.byPair, pair), now]);
    this.failAccount(account, now);
  }
}

export function createPlatformRouter(core: Core, extensions: PlatformExtension[]): express.Router {
  const router = express.Router();
  const limiter = new LoginLimiter();
  const { config } = core;
  // A new password, also one set through a reset mail, ends the pause of the account: its owner always has that way in.
  core.users.onPasswordChanged((id) => {
    const user = core.users.get(id);
    if (user) limiter.succeed(user.email.trim().toLowerCase());
  });
  warnIfPlainHttp(config);

  /** A browser that signed in to this account before carries a signed cookie saying so; a pause of the account does not apply to it. */
  const knownDevice = (req: express.Request, account: string): boolean => {
    const d = verifyToken<{ uid?: unknown; k?: unknown }>(readCookie(req, deviceCookieName(config)), config.secret);
    return d !== null && d.k === 'dev' && typeof d.uid === 'string' && core.users.getByEmail(account)?.id === d.uid;
  };

  // Platform pages must never be framed: instances are same-site and could trick clicks.
  router.use((_req, res, next) => {
    res.set({ 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" });
    next();
  });

  router.get('/healthz', (_req, res) => { res.json({ ok: true }); });

  router.get('/icon.webp', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=604800').type('image/webp').send(ICON);
  });

  for (const [size, bytes] of PLATFORM_ICONS) {
    router.get(`/icon-${size}.png`, (_req, res) => {
      res.set({ 'Cache-Control': 'public, max-age=604800', 'X-Content-Type-Options': 'nosniff' }).type('image/png').send(bytes);
    });
  }

  router.get('/manifest.webmanifest', (_req, res) => {
    res.set({ 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' }).type('application/manifest+json').send(PLATFORM_MANIFEST);
  });

  // The icons of apps: public, and cached for a year because the version is part of the URL. A wrong version is sent to the current one.
  router.get('/app-icons/:appId/:version/:file', async (req, res) => {
    const m = ICON_FILE.exec(req.params.file as string);
    const found = m ? core.apps.getApp(req.params.appId as string) : null;
    if (!m || !found || found.id !== req.params.appId) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    const app = found;
    if (req.params.version !== String(app.iconVersion)) {
      res.set('Cache-Control', 'no-cache').redirect(`/app-icons/${app.id}/${app.iconVersion}/${m[1]}.png`);
      return;
    }
    const size = Number(m[1]) as 64 | 192 | 512;
    const own = core.icons.png(app.id, size);
    // No drawn icon yet: the bundled one, for a short time. A public request never queues rendering.
    const file = own ?? fallbackIconPath(size);
    res.set({ 'Cache-Control': own ? 'public, max-age=31536000, immutable' : 'public, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'cross-origin' });
    res.type('image/png').sendFile(file, { dotfiles: 'allow', cacheControl: false });
  });

  /** Whether the version the instance runs asks for the visitor's email address (`user.scopes: ["email"]`). */
  const declaresEmail = (instance: Instance): boolean => {
    const scopes = core.apps.listVersions(instance.appId).find((v) => v.number === instance.activeVersion)?.capabilities.user?.scopes;
    return Array.isArray(scopes) && scopes.includes('email');
  };

  /** The question before the first sign-in to an instance. Cancel comes first, so Enter never continues. */
  const signInPage = (locale: Locale, user: User, instance: Instance, host: string, email: boolean, fields: Record<string, string>): string => {
    const app = core.apps.getApp(instance.appId)?.title || instance.slug;
    return page(locale, t(locale, 'signin.title'), authCard(`<div class="auth-icon">${icon('shield')}</div><h1>${esc(t(locale, 'signin.heading', { app }))}</h1>
<div class="consent-who"><p>${esc(t(locale, 'signin.text', { app, host, user: user.name || user.email }))}</p>
<p>${esc(t(locale, email ? 'signin.sees.email' : 'signin.sees.name'))}</p></div>
<form method="post" action="/auth/instance">
${hiddenField('csrf', csrfToken(core, user))}${Object.entries(fields).map(([k, v]) => hiddenField(k, v)).join('')}
<div class="consent-actions"><button type="submit" name="decision" value="cancel" class="${btn('secondary')}">${esc(t(locale, 'signin.cancel'))}</button>
<button type="submit" name="decision" value="continue" class="${btn('primary')}">${esc(t(locale, 'signin.continue'))}</button></div>
</form>`), { switcher: false });
  };

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
    // A link or image on another site, or on an instance (same site, other origin), changes nothing: neither this browser's cookie
    // nor the stored language of a signed-in account. The switcher's own links are same-origin navigations.
    const site = req.get('Sec-Fetch-Site');
    if (site === undefined || site === 'same-origin' || site === 'none') {
      res.cookie(LANG_COOKIE, locale, {
        httpOnly: true, sameSite: 'lax', path: '/', secure: config.publicUrl.protocol === 'https:', maxAge: ONE_YEAR_SECONDS * 1000,
      });
      const user = sessionUser(core, req);
      if (user) core.users.setLocale(user.id, locale);
    }
    res.set('Cache-Control', 'no-store').redirect(safeReturnPath(req.query.return));
  });

  router.get('/login', loginHeaders, (req, res) => {
    const locale = requestLocale(core, req);
    res.type('html').send(loginPage(locale, safeReturnPath(req.query.return), undefined, {
      registration: core.settings.registration,
      notice: req.query.verified === '1' ? t(locale, 'login.verified') : undefined,
    }));
  });

  // App code on an instance origin is same-site and could post this form to sign a visitor into another account.
  router.post('/login', loginHeaders, sameOriginGuard(core), express.urlencoded({ extended: false, limit: '10kb' }), async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ret = safeReturnPath(body.return);
    const locale = requestLocale(core, req);
    const ip = addressKey(req.ip);
    const account = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 254) : '';
    if (limiter.blocked(ip, account)) {
      res.status(429).type('html').send(loginPage(locale, ret, t(locale, 'login.tooMany'), { registration: core.settings.registration }));
      return;
    }
    // A paused account answers like a wrong password, whether it exists or not, and without the cost of checking one.
    const result = typeof body.email === 'string' && typeof body.password === 'string' && (!limiter.accountPaused(account) || knownDevice(req, account))
      ? await core.users.checkLogin(body.email, body.password) : null;
    if (result === null || !result.ok) {
      const reason = result?.reason ?? 'invalid';
      // Unverified and disabled are only reported after a correct password, so they do not count as failures.
      // An attempt turned away unseen is neither: counting it would let anyone stretch the pause without end.
      if (result?.reason === 'invalid') limiter.fail(ip, account);
      else if (result) limiter.succeed(account);
      const message = reason === 'unverified' ? t(locale, 'login.unverified')
        : reason === 'disabled' ? t(locale, 'login.disabled') : t(locale, 'login.invalid');
      res.status(401).type('html').send(loginPage(locale, ret, message, {
        registration: core.settings.registration, resendEmail: reason === 'unverified' ? account : undefined,
      }));
      return;
    }
    limiter.succeed(account);
    issueSession(core, res, result.user);
    setCookie(res, config, deviceCookieName(config), signToken({ uid: result.user.id, k: 'dev' }, config.secret, ONE_YEAR_SECONDS), ONE_YEAR_SECONDS);
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

  /**
   * Signs the visitor in to an instance. Whoever reaches it through its visibility alone is asked first, once per instance:
   * otherwise any public app could send its visitors through here and learn who they are without their doing anything.
   * `GET` asks or, when nothing needs asking, signs in; `POST` is the answer to the question.
   */
  const instanceSignIn: express.RequestHandler = (req, res) => {
    const answer = req.method === 'POST';
    const params = ((answer ? req.body : req.query) ?? {}) as Record<string, unknown>;
    const user = sessionUser(core, req);
    if (!user) {
      res.redirect('/login?return=' + encodeURIComponent(answer ? '/' : req.originalUrl));
      return;
    }
    const locale = requestLocale(core, req, user);
    if (answer && !csrfValid(core, user, params.csrf)) {
      res.status(403).type('html').send(sessionExpiredPage(locale));
      return;
    }
    const slug = typeof params.slug === 'string' ? params.slug : '';
    const instance = core.apps.getInstanceBySlug(slug);
    if (!instance) {
      res.status(404).type('html').send(notFoundPage(locale));
      return;
    }
    // `host` is attacker-controlled: it counts only if it is attached to this very instance, and the redirect uses the stored form.
    let customHost: string | null = null;
    if (params.host !== undefined) {
      try {
        if (typeof params.host !== 'string') throw new LagerError('invalid_argument', 'host must be given once.');
        customHost = normalizeHost(params.host);
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
    // The instance put a nonce into its own cookie before sending the browser here; the code carries it back, so it is only good in that browser.
    const nonce = typeof params.n === 'string' && NONCE_RE.test(params.n) ? params.n : undefined;
    const target = customHost ? hostUrl(config, customHost) : instanceUrl(config, instance.slug);
    const back = safeReturnPath(params.return);
    const email = declaresEmail(instance);
    if (answer && params.decision !== 'continue') {
      // Cancelled. A public instance works without a sign-in; any other would only send the browser straight back to the question.
      res.redirect(instance.visibility === 'public' ? `${target}/` : '/');
      return;
    }
    if (!core.access.signInConfirmed(instance, user, email)) {
      // The answer counts for what its page said: if the app began to ask for the address in between, the question comes again.
      if (!answer || (email && params.email !== '1')) {
        res.type('html').send(signInPage(locale, user, instance, new URL(target).host, email,
          { slug: instance.slug, ...(customHost ? { host: customHost } : {}), ...(nonce ? { n: nonce } : {}), return: back, email: email ? '1' : '0' }));
        return;
      }
      core.access.confirmSignIn(instance, user, email);
    }
    const code = signToken({ uid: user.id, iid: instance.id, k: 'code', jti: crypto.randomUUID(), ep: user.sessionEpoch, n: nonce, h: customHost ?? `${instance.slug}.${config.appsDomain}`.toLowerCase() }, config.secret, 60);
    res.redirect(`${target}/__lager/callback?code=${encodeURIComponent(code)}&return=${encodeURIComponent(back)}`);
  };
  router.get('/auth/instance', loginHeaders, instanceSignIn);
  router.post('/auth/instance', loginHeaders, express.urlencoded({ extended: false, limit: '10kb' }), instanceSignIn);

  for (const ext of extensions) ext(router, core);

  router.use((req, res) => {
    if (req.path.startsWith('/api/')) sendError(res, new LagerError('not_found', 'Not found.'));
    else res.status(404).type('html').send(notFoundPage(requestLocale(core, req)));
  });
  return router;
}
