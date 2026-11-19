import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import type { Core } from '../core.js';
import { addressKey } from './client-address.js';
import { clearCookie, NONCE_RE, sessionCookieName, warnIfPlainHttp } from './cookies.js';
import { csrfToken, csrfValid, issueSession, knownDevice, markDevice, sessionUser } from './session.js';
import { isLocale, t } from '../i18n/index.js';
import { authCard, badCodePage, disabledPage, esc, forbiddenPage, hiddenField, loginPage, notFoundPage, page, sessionExpiredPage } from './pages.js';
import { btn, icon } from './ui.js';
import { LANG_COOKIE, ONE_YEAR_SECONDS, requestLocale } from './locale.js';
import { LagerError } from '../errors.js';
import { safeReturnPath, sendError } from './errors.js';
import { sameOriginGuard } from './origin.js';
import { signToken } from './tokens.js';
import { hostUrl, instanceUrl } from '../config.js';
import type { Instance } from '../platform/apps.js';
import type { LoginResult, User } from '../platform/users.js';
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
/** Failures in a row on one account, from anywhere, before it refuses sign-ins for a while. */
const ACCOUNT_MAX_FAILURES = 10;
/** How long the account then pauses: the first time, and each further time while the attack goes on. Never longer than the last step. */
const ACCOUNT_PAUSES_MS = [30_000, 60_000, 2 * 60_000, 5 * 60_000];

interface AccountState {
  /** Failures in a row since the last pause ended (or since the count began). */
  failures: number;
  /** Time of the last failure. */
  last: number;
  /** End of the current or the last pause; 0 before the first. */
  until: number;
  /** Index into `ACCOUNT_PAUSES_MS` of the next pause. Falls by one for every quiet window after a pause. */
  level: number;
}

/** An attempt that was counted as a failure before its password was checked; see `LoginLimiter.begin`. */
export interface Attempt { ip: string; account: string; at: number }

/**
 * Failed login attempts within a sliding window, tracked per client IP, per account (e-mail) and per pair of both.
 * An address is refused after `MAX_FAILURES` failures. Once an account collected that many, an address that itself failed on it
 * is refused sooner. Expired entries are swept on every failure and the number of tracked keys is capped.
 *
 * Addresses are cheap (a botnet, or the 2^64 of one IPv6 prefix), so the account also counts its failures in a row whatever the
 * address. The tenth pauses it: for the length of the pause every attempt from a browser the account does not know is turned
 * away before the password is looked at, with the answer a wrong password gets. A pause has a fixed end. Attempts made during it
 * neither extend it nor count, and when it is over the account takes ten attempts again before the next, longer one
 * (`ACCOUNT_PAUSES_MS`, at most five minutes). Each quiet window after a pause takes the length back one step, and a correct
 * password ends everything. A browser that has proved control of the account before carries a device cookie and is never paused.
 *
 * Checking a password is awaited, so an attempt is counted before the check (`begin`) and taken back when the password was right
 * (`release`): requests that arrive together cannot all pass a limit that none of them has been counted against yet.
 */
export class LoginLimiter {
  private byIp = new Map<string, number[]>();
  private byAccount = new Map<string, number[]>();
  private byPair = new Map<string, number[]>();
  /**
   * One map for every name that was tried, whether an account of that name exists or not: anything that treated the two
   * differently would let the limiter's answers tell them apart. When it is full, an entry that is not paused goes first.
   */
  private accounts = new Map<string, AccountState>();
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
    return Date.now() < (this.accounts.get(account)?.until ?? 0);
  }

  /** The password was right, or a new one was set: the account's pause and its count of failures end. */
  succeed(account: string): void {
    this.accounts.delete(account);
  }

  private failAccount(account: string, now: number): void {
    const map = this.accounts;
    const quietFor = (e: AccountState): number => now - Math.max(e.last, e.until);
    for (const [key, e] of map) {
      if (quietFor(e) >= WINDOW_MS * ACCOUNT_PAUSES_MS.length) map.delete(key);
    }
    const e = map.get(account) ?? { failures: 0, last: 0, until: 0, level: 0 };
    const pausedNow = now < e.until;
    if (!pausedNow) {
      // What was counted before or during a pause is spent with it; so is a run of failures that broke off a window ago.
      if (e.last < e.until || now - e.last >= WINDOW_MS) e.failures = 0;
      const quietWindows = e.until ? Math.floor((now - e.until) / WINDOW_MS) : 0;
      if (quietWindows > 0) {
        e.level = Math.max(0, e.level - quietWindows);
        e.until += quietWindows * WINDOW_MS;
      }
    }
    e.failures += 1;
    e.last = now;
    // Only an account that is open can pause: a failure during a pause (from a known browser) never moves its end.
    if (!pausedNow && e.failures >= ACCOUNT_MAX_FAILURES) {
      e.until = now + ACCOUNT_PAUSES_MS[e.level];
      e.level = Math.min(e.level + 1, ACCOUNT_PAUSES_MS.length - 1);
      e.failures = 0;
    }
    map.delete(account);
    // Full: an entry that is not paused goes first, the oldest one if all are. Pushing out a pause would take as many names paused
    // at the same time as the map holds, each after ten checked passwords, within one pause: far more than the hash queue lets through.
    while (map.size >= MAX_TRACKED_KEYS) {
      let victim = map.keys().next().value as string;
      for (const [key, other] of map) if (now >= other.until) { victim = key; break; }
      map.delete(victim);
    }
    map.set(account, e);
  }

  /** Counts one failure. */
  fail(ip: string, account: string): Attempt {
    LoginLimiter.sweep(this.byIp);
    LoginLimiter.sweep(this.byAccount);
    LoginLimiter.sweep(this.byPair);
    const now = Date.now();
    const pair = LoginLimiter.pair(ip, account);
    this.byIp.set(ip, [...LoginLimiter.recent(this.byIp, ip), now]);
    this.byAccount.set(account, [...LoginLimiter.recent(this.byAccount, account), now]);
    this.byPair.set(pair, [...LoginLimiter.recent(this.byPair, pair), now]);
    this.failAccount(account, now);
    return { ip, account, at: now };
  }

  /**
   * Called before the password is checked. `blocked`: the address is over its limit. `paused`: the account takes no attempt from
   * this browser right now; nothing is counted. Otherwise the attempt is counted as a failure at once and returned, to be given
   * to `release` if the password turns out right. `known` says that the browser carries the account's device cookie.
   */
  begin(ip: string, account: string, known: boolean): Attempt | 'blocked' | 'paused' {
    if (this.blocked(ip, account)) return 'blocked';
    if (!known && this.accountPaused(account)) return 'paused';
    return this.fail(ip, account);
  }

  /**
   * Takes a counted attempt back. With `passwordRight` the account's pause and count end as well; without it (the check never ran)
   * only this attempt is forgotten.
   */
  release(attempt: Attempt, passwordRight: boolean): void {
    const drop = (map: Map<string, number[]>, key: string): void => {
      const list = map.get(key);
      const i = list ? list.lastIndexOf(attempt.at) : -1;
      if (!list || i < 0) return;
      list.splice(i, 1);
      if (list.length === 0) map.delete(key);
    };
    drop(this.byIp, attempt.ip);
    drop(this.byAccount, attempt.account);
    drop(this.byPair, LoginLimiter.pair(attempt.ip, attempt.account));
    if (passwordRight) {
      this.succeed(attempt.account);
      return;
    }
    const e = this.accounts.get(attempt.account);
    if (e && e.failures > 0) e.failures -= 1;
  }
}

const limiters = new WeakMap<Core, LoginLimiter>();
/** The sign-in limiter of this server; the password-reset form asks it whether an account is paused. */
export function loginLimiter(core: Core): LoginLimiter {
  let limiter = limiters.get(core);
  if (!limiter) limiters.set(core, limiter = new LoginLimiter());
  return limiter;
}

export function createPlatformRouter(core: Core, extensions: PlatformExtension[]): express.Router {
  const router = express.Router();
  const limiter = loginLimiter(core);
  const { config } = core;
  // A new password, also one set through a reset mail, ends the pause of the account: its owner always has that way in.
  core.users.onPasswordChanged((id) => {
    const user = core.users.get(id);
    if (user) limiter.succeed(user.email.trim().toLowerCase());
  });
  warnIfPlainHttp(config);

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

  /**
   * The question before the first sign-in to an instance. Cancel comes first, so Enter never continues. Both answers end on the
   * instance at `origin` (the callback after Continue, the public page after Cancel) or on the platform: the page allows its
   * form exactly those two origins, because browsers hold a form to `form-action` through the redirects after it.
   */
  const signInPage = (locale: Locale, user: User, instance: Instance, origin: string, email: boolean, fields: Record<string, string>): string => {
    const host = new URL(origin).host;
    const app = core.apps.getApp(instance.appId)?.title || instance.slug;
    return page(locale, t(locale, 'signin.title'), authCard(`<div class="auth-icon">${icon('shield')}</div><h1>${esc(t(locale, 'signin.heading', { app }))}</h1>
<div class="consent-who"><p>${esc(t(locale, 'signin.text', { app, host, user: user.name || user.email }))}</p>
<p>${esc(t(locale, email ? 'signin.sees.email' : 'signin.sees.name'))}</p></div>
<form method="post" action="/auth/instance">
${hiddenField('csrf', csrfToken(core, user))}${Object.entries(fields).map(([k, v]) => hiddenField(k, v)).join('')}
<div class="consent-actions"><button type="submit" name="decision" value="cancel" class="${btn('secondary')}">${esc(t(locale, 'signin.cancel'))}</button>
<button type="submit" name="decision" value="continue" class="${btn('primary')}">${esc(t(locale, 'signin.continue'))}</button></div>
</form>`), { switcher: false, formTargets: [origin] });
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
    const tooMany = (): void => {
      res.status(429).type('html').send(loginPage(locale, ret, t(locale, 'login.tooMany'), { registration: core.settings.registration }));
    };
    // Counted as a failure now, before the password is checked: of many attempts sent at once, only as many as the limits leave are looked at.
    const owner = core.users.getByEmail(account);
    const known = owner !== null && knownDevice(core, req, owner);
    const attempt = limiter.begin(ip, account, known);
    if (attempt === 'blocked') { tooMany(); return; }
    // A paused account answers like a wrong password, whether it exists or not, and without the cost of checking one.
    let result: LoginResult | null = null;
    if (attempt !== 'paused' && typeof body.email === 'string' && typeof body.password === 'string') {
      try {
        // A browser the account knows does not wait behind a flood of guesses.
        result = await core.users.checkLogin(body.email, body.password, known);
      } catch (e) {
        if (!(e instanceof LagerError) || e.code !== 'rate_limited') throw e;
        // Too many passwords are being checked at once: this one was not looked at, so it does not count either, and the
        // answer says that the server is busy, not that the visitor failed.
        limiter.release(attempt, false);
        res.status(429).type('html').send(loginPage(locale, ret, t(locale, 'login.busy'), { registration: core.settings.registration }));
        return;
      }
    }
    if (result === null || !result.ok) {
      const reason = result?.reason ?? 'invalid';
      // Unverified and disabled are only reported after a correct password, so they do not count as failures.
      if (result && result.reason !== 'invalid' && attempt !== 'paused') limiter.release(attempt, true);
      const message = reason === 'unverified' ? t(locale, 'login.unverified')
        : reason === 'disabled' ? t(locale, 'login.disabled') : t(locale, 'login.invalid');
      res.status(401).type('html').send(loginPage(locale, ret, message, {
        registration: core.settings.registration, resendEmail: reason === 'unverified' ? account : undefined,
      }));
      return;
    }
    if (attempt !== 'paused') limiter.release(attempt, true);
    issueSession(core, res, result.user);
    markDevice(core, res, result.user);
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
        res.type('html').send(signInPage(locale, user, instance, new URL(target).origin, email,
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
