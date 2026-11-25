import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import type { Request, Response } from 'express';
import type { Core } from '../core.js';
import { appendRule, canDelete, canRead, canWrite, type Level, type Viewer } from '../data/rules.js';
import type { HubEvent } from '../data/hub.js';
import { newDocId } from '../data/store.js';
import { LagerError } from '../errors.js';
import type { Capabilities, DbRule, Instance } from '../platform/apps.js';
import { effectiveRules, INGEST_LIMITS } from '../platform/ingest.js';
import type { User } from '../platform/users.js';
import { addressKey } from './client-address.js';
import { clearCookie, instanceCookieName, NONCE_RE, nonceCookieName, readCookie, setCookie, THIRTY_DAYS_SECONDS } from './cookies.js';
import { safeReturnPath, sendError, sendNotFound } from './errors.js';
import { injectRuntime, type BadgeText } from './inject.js';
import { mountPageRoutes } from './instance-page.js';
import { mountPwaRoutes } from './instance-pwa.js';
import { mountAssetRoutes } from './instance-assets.js';
import { mountRoomRoutes, STREAM_LIMITS } from './instance-room.js';
import { mountCompleteRoutes } from './instance-complete.js';
import { mountIngestEndpoints, mountIngestInfo } from './instance-ingest.js';
import { mountEmbed } from './instance-embed.js';
import { assertOwnOrigin } from './origin.js';
import { RateLimiter } from './ratelimit.js';
import { StreamLimiter } from './stream-limit.js';
import { requestLocale } from './locale.js';
import { t as tr } from '../i18n/index.js';
import { btn } from './ui.js';
import { badCodePage, disabledPage, esc, instanceHostPage, noAccessPage, notFoundPage } from './pages.js';
import { epochValid } from './session.js';
import { iconToken, signToken, verifyToken } from './tokens.js';

const RUNTIME_FILE = new URL('../runtime/runtime.js', import.meta.url);
const BADGE_FILE = new URL('../runtime/badge.js', import.meta.url);
const SW_FILE = new URL('../runtime/sw.js', import.meta.url);
/** Marks a page or session answer the service worker may keep for use without a connection (see `offlineAllowed`). */
export const OFFLINE_HEADER = 'X-Lager-Offline';
/** Where the "Made with Lager" badge points: the project, not this server. */
export const PROJECT_URL = 'https://github.com/dm807cam/lager';
const MAX_PROFILE_IDS = 100;
const WRITE_ONLY_UPDATE = 'update needs read access to the document as well, because it merges into what is stored. On a path the viewer may write but not read, use set (replace) instead.';
const WRITE_ONLY_ACQUIRE = 'acquire needs read access to the document as well as write access.';
const MAX_SEARCH_RESULTS = 20;
const MAX_SEARCH_QUERY = 100;
const PING_MS = 25_000;
/** A reader that falls this far behind is dropped rather than buffered without bound. */
const MAX_BUFFERED_BYTES = 1024 * 1024;
/** How long a started sign-in may take before its nonce lapses. */
const NONCE_SECONDS = 600;
/**
 * Database operations per viewer, instance and minute. A page load makes one read per listener and every change at most one
 * more per listener every 250 ms (the runtime coalesces), so real apps stay far below. Guests are counted per client address
 * (an IPv6 /64 is one address): an anonymous address gets as many reads as an account, never more, and fewer writes, which
 * guests may not make anyway. All guests of an instance together get `guestTotalFactor` times that.
 */
export const DB_RATE = { reads: 600, writes: 300, guestReads: 600, guestWrites: 150, guestTotalFactor: 8, windowMs: 60_000 };
const DB_READS = new Set(['get', 'query']);
const RANK: Record<Level, number> = { none: 0, view: 1, interact: 2, admin: 3, owner: 4 };

function instanceUser(core: Core, req: Request, instance: Instance): User | null {
  const t = verifyToken<{ uid?: unknown; iid?: unknown; k?: unknown; ep?: unknown }>(readCookie(req, instanceCookieName(core.config)), core.config.secret);
  if (!t || t.k !== 'inst' || t.iid !== instance.id || typeof t.uid !== 'string') return null;
  const user = core.users.get(t.uid);
  return epochValid(user, t.ep) ? user : null;
}

function activeCapabilities(core: Core, instance: Instance): Capabilities {
  return core.apps.getVersion(instance.appId, instance.activeVersion)?.capabilities ?? {};
}

/** The app may be opened without a connection unless its active version declares `{"db": {"offline": false}}` (ADR 0020). */
export function offlineAllowed(caps: Capabilities): boolean {
  return caps.db?.offline !== false;
}

/** `customHost` is the custom domain the visitor came in on; the platform sends the code back to exactly that host. */
function loginUrl(core: Core, instance: Instance, customHost?: string, nonce?: string): string {
  const host = customHost ? `&host=${encodeURIComponent(customHost)}` : '';
  const n = nonce ? `&n=${nonce}` : '';
  return `${core.config.publicUrl.origin}/auth/instance?slug=${encodeURIComponent(instance.slug)}${host}&return=%2F${n}`;
}

/**
 * The sign-in nonce of this browser on this instance host, created on first use. The platform puts it into the code it issues
 * and the callback compares it with the cookie, so a code minted in one browser cannot sign another browser in.
 */
function signInNonce(core: Core, req: Request, res: Response): string {
  const name = nonceCookieName(core.config);
  const existing = readCookie(req, name);
  if (existing && NONCE_RE.test(existing)) return existing;
  const nonce = crypto.randomBytes(18).toString('base64url');
  setCookie(res, core.config, name, nonce, NONCE_SECONDS);
  return nonce;
}

export interface Ctx { instance: Instance; user: User | null; viewer: Viewer; caps: Capabilities; rules: DbRule[] | undefined }

function context(core: Core, req: Request, instance: Instance): Ctx {
  const user = instanceUser(core, req, instance);
  const caps = activeCapabilities(core, instance);
  return {
    instance, user, caps, rules: effectiveRules(caps),
    viewer: { userId: user?.id ?? null, level: core.access.levelFor(instance, user) },
  };
}

/** Throws unless the viewer has at least `view` access. */
export function requireAccess(ctx: Ctx): void {
  if (ctx.viewer.level !== 'none') return;
  if (ctx.user) throw new LagerError('forbidden', 'No access to this instance.');
  throw new LagerError('unauthenticated', 'Sign in required.');
}

export function createInstanceRouter(core: Core): express.Router {
  const router = express.Router();
  const { config } = core;
  // Instance hosts do not receive the platform's language cookie, so their pages offer no switcher; their styles come from the platform host.
  const NO_SWITCHER = instanceHostPage(config);
  // Consumed handshake code ids with their expiry (epoch seconds); codes are single-use.
  const usedCodes = new Map<string, number>();
  const runtime = fs.readFileSync(RUNTIME_FILE);
  const runtimeEtag = `"${crypto.createHash('sha256').update(runtime).digest('base64url').slice(0, 27)}"`;
  const badgeScript = fs.readFileSync(BADGE_FILE);
  const badgeEtag = `"${crypto.createHash('sha256').update(badgeScript).digest('base64url').slice(0, 27)}"`;
  const swScript = fs.readFileSync(SW_FILE);
  const swEtag = `"${crypto.createHash('sha256').update(swScript).digest('base64url').slice(0, 27)}"`;

  const ctxOf = (res: Response): Ctx => res.locals.ctx as Ctx;
  const hasScope = (ctx: Ctx, scope: string): boolean => Array.isArray(ctx.caps.user?.scopes) && ctx.caps.user.scopes.includes(scope);
  const emailAllowed = (ctx: Ctx): boolean => hasScope(ctx, 'email');

  // Everything under /__lager/ is data, a script or an image with its type declared: never to be sniffed into something else.
  router.use('/__lager', (_req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });

  mountPwaRoutes(router, core, (req, instance) => core.access.levelFor(instance, instanceUser(core, req, instance)) !== 'none');
  // Before the session is looked at: whoever sends to an ingest endpoint is anonymous there, whatever cookie comes along.
  mountIngestEndpoints(router, core);

  router.use((req, res, next) => {
    const instance = core.apps.getInstanceBySlug(res.locals.slug as string);
    if (!instance) {
      res.status(404).type('html').send(notFoundPage(requestLocale(core, req, null), NO_SWITCHER));
      return;
    }
    if (instance.disabled) {
      if (req.path.startsWith('/__lager/')) sendError(res, new LagerError('forbidden', 'This instance has been disabled.'));
      else res.status(403).type('html').send(disabledPage(requestLocale(core, req, instanceUser(core, req, instance)), NO_SWITCHER));
      return;
    }
    res.locals.ctx = context(core, req, instance);
    next();
  });

  router.get('/__lager/callback', (req, res) => {
    const { instance } = ctxOf(res);
    const locale = requestLocale(core, req, null);
    const t = verifyToken<{ uid?: unknown; iid?: unknown; k?: unknown; jti?: unknown; ep?: unknown; h?: unknown; n?: unknown; exp: number }>(
      typeof req.query.code === 'string' ? req.query.code : undefined, config.secret);
    const user = t && typeof t.uid === 'string' ? core.users.get(t.uid) : null;
    // The code names the host it was issued for and is only good there: a code for the custom domain is not valid on the default host.
    const host = (req.hostname ?? '').toLowerCase().replace(/\.$/, '');
    const nonce = readCookie(req, nonceCookieName(config));
    const sameBrowser = typeof nonce === 'string' && NONCE_RE.test(nonce) && typeof t?.n === 'string'
      && nonce.length === t.n.length && crypto.timingSafeEqual(Buffer.from(nonce), Buffer.from(t.n));
    if (!t || t.k !== 'code' || t.iid !== instance.id || t.h !== host || typeof t.jti !== 'string' || !sameBrowser || !epochValid(user, t.ep)) {
      res.status(400).type('html').send(badCodePage(locale, NO_SWITCHER));
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    for (const [id, exp] of usedCodes) if (exp <= now) usedCodes.delete(id);
    if (usedCodes.has(t.jti)) {
      res.status(400).type('html').send(badCodePage(locale, NO_SWITCHER));
      return;
    }
    usedCodes.set(t.jti, t.exp);
    setCookie(res, config, instanceCookieName(config), signToken({ uid: user.id, iid: instance.id, k: 'inst', ep: user.sessionEpoch }, config.secret, THIRTY_DAYS_SECONDS));
    clearCookie(res, config, nonceCookieName(config));
    res.redirect(safeReturnPath(req.query.return));
  });

  router.get(['/', '/index.html'], (req, res) => {
    const ctx = ctxOf(res);
    if (ctx.viewer.level === 'none') {
      if (ctx.user) {
        // Signed in here, but no longer allowed in (a share that was taken back). The ways out are on the platform: its sign-in for
        // this instance offers another account, and the home page lists the apps this account has.
        const locale = requestLocale(core, req, ctx.user);
        const platform = config.publicUrl.origin;
        const actions = `<a class="${btn('primary')}" href="${esc(`${platform}/auth/instance?slug=${encodeURIComponent(ctx.instance.slug)}`)}">${esc(tr(locale, 'noAccess.switch'))}</a>`
          + `<a class="${btn('secondary')}" href="${esc(`${platform}/`)}">${esc(tr(locale, 'home.title'))}</a>`;
        res.status(403).type('html').send(noAccessPage(locale, ctx.user.email, actions, NO_SWITCHER));
      } else {
        res.redirect(loginUrl(core, ctx.instance, res.locals.customHost as string | undefined, signInNonce(core, req, res)));
      }
      return;
    }
    const app = core.apps.getApp(ctx.instance.appId);
    // The badge is for the people the app is shared with; whoever manages the instance never sees it.
    const level = ctx.viewer.level;
    let badge: BadgeText | undefined;
    if (core.settings.madeWithBadge && ctx.instance.showBadge && level !== 'admin' && level !== 'owner') {
      const locale = requestLocale(core, req, ctx.user);
      badge = { label: tr(locale, 'badge.label'), linkLabel: tr(locale, 'badge.link'), close: tr(locale, 'badge.close'), href: PROJECT_URL };
    }
    const html = injectRuntime(core.apps.readVersionHtml(ctx.instance.appId, ctx.instance.activeVersion),
      app ? {
        title: app.title, themeColor: app.themeColor, iconVersion: app.iconVersion,
        // Phones fetch the home-screen icon on their own, often without cookies: the page hands them what opens it.
        ...(ctx.instance.visibility === 'public' ? {} : { iconToken: iconToken(ctx.instance.id, app.iconVersion, config.secret) }),
      } : undefined, badge);
    // Other instances are same-site and would get this instance's cookie inside a frame: only the instance may frame itself,
    // and the websites outside Lager its managers named for an app that declares `embed`. Those are other sites, where the
    // browser sends no `Lax` cookie into the frame, so there the instance only ever sees a guest (see `Embed`).
    const ancestors = core.embed.frameAncestors(ctx.instance.id, ctx.caps);
    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': ['frame-ancestors', "'self'", ...ancestors].join(' '),
      // Chrome, Firefox and Safari (since 2019) ignore X-Frame-Options when the policy has frame-ancestors, so it stays: a
      // browser that knows only X-Frame-Options keeps the old protection instead of none.
      'X-Frame-Options': 'SAMEORIGIN',
    });
    if (offlineAllowed(ctx.caps)) res.set(OFFLINE_HEADER, '1');
    res.send(html);
  });

  router.get('/__lager/runtime.js', (req, res) => {
    res.set({ 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', ETag: runtimeEtag });
    if (req.headers['if-none-match'] === runtimeEtag) {
      res.status(304).end();
      return;
    }
    res.send(runtime);
  });

  router.get('/__lager/badge.js', (req, res) => {
    res.set({ 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', ETag: badgeEtag });
    if (req.headers['if-none-match'] === badgeEtag) {
      res.status(304).end();
      return;
    }
    res.send(badgeScript);
  });

  // The service worker lives under /__lager/ with the other scripts but controls the whole host, which the header allows.
  // It holds nothing of the instance: what it keeps is decided by the mark on each answer (OFFLINE_HEADER).
  router.get('/__lager/sw.js', (req, res) => {
    // The worker's referrer policy comes from this answer: as on the page, other hosts learn nothing about the instance.
    res.set({
      'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', ETag: swEtag, 'Service-Worker-Allowed': '/',
      'Referrer-Policy': 'same-origin',
    });
    if (req.headers['if-none-match'] === swEtag) {
      res.status(304).end();
      return;
    }
    res.send(swScript);
  });

  router.get('/__lager/session', (req, res) => {
    const ctx = ctxOf(res);
    // Only a browser that is not signed in here can start a sign-in, so only it gets a nonce.
    const url = loginUrl(core, ctx.instance, res.locals.customHost as string | undefined, ctx.user ? undefined : signInNonce(core, req, res));
    if (ctx.viewer.level === 'none') {
      sendError(res, new LagerError('unauthenticated', 'Sign in required.'), { loginUrl: url });
      return;
    }
    const level = ctx.viewer.level;
    res.set('Cache-Control', 'no-store');
    if (offlineAllowed(ctx.caps)) res.set(OFFLINE_HEADER, '1');
    res.json({
      viewer: {
        id: ctx.user?.id ?? null,
        name: ctx.user?.name ?? '',
        // A visitor who agreed to share only a name (see /auth/instance) keeps the address back when the app starts asking for it.
        email: ctx.user && emailAllowed(ctx) && core.access.signInConfirmed(ctx.instance, ctx.user, true) ? ctx.user.email : null,
        level,
        isOwner: level === 'owner',
        canEdit: level === 'admin' || level === 'owner',
        // The viewer's stored language, else what their browser asks for; the runtime words its dialogs with it.
        locale: requestLocale(core, req, ctx.user),
      },
      instance: {
        id: ctx.instance.id, slug: ctx.instance.slug,
        appSlug: core.apps.getApp(ctx.instance.appId)?.slug ?? null, version: ctx.instance.activeVersion,
      },
      capabilities: ctx.caps,
      loginUrl: url,
    });
  });

  router.get('/__lager/users', (req, res) => {
    const ctx = ctxOf(res);
    requireAccess(ctx);
    if (req.query.q !== undefined) {
      // Search among the people who can open this instance; only for signed-in viewers and apps that declared the profile scope.
      if (!ctx.user) throw new LagerError('unauthenticated', 'Sign in required.');
      if (typeof req.query.q !== 'string' || req.query.q.length > MAX_SEARCH_QUERY) {
        throw new LagerError('invalid_argument', `q must be a string of at most ${MAX_SEARCH_QUERY} characters.`);
      }
      const found = hasScope(ctx, 'profile') ? core.access.usersWithAccess(ctx.instance, req.query.q, MAX_SEARCH_RESULTS, emailAllowed(ctx)) : [];
      res.set('Cache-Control', 'no-store').json({
        // As for single profiles: no address of someone who has not agreed to share it with this instance.
        profiles: found.map((u) => ({ id: u.id, name: u.name, email: emailAllowed(ctx) && core.access.signInConfirmed(ctx.instance, u, true) ? u.email : null, isMe: u.id === ctx.user?.id })),
      });
      return;
    }
    const raw = typeof req.query.ids === 'string' ? req.query.ids : '';
    const ids = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
    if (ids.length > MAX_PROFILE_IDS) throw new LagerError('invalid_argument', `At most ${MAX_PROFILE_IDS} ids are allowed.`);
    const profiles: Record<string, { id: string; name: string; email: string | null; isMe: boolean }> = {};
    // Profiles belong to the `user` capability: an app that did not declare it resolves nobody, and an anonymous visitor never gets an address.
    const declared = typeof ctx.caps.user === 'object' && ctx.caps.user !== null;
    const withEmail = emailAllowed(ctx) && ctx.user !== null;
    // An id resolves only for someone this instance already knows: the viewer, the owner and the people it is shared with,
    // whoever wrote one of its documents and whoever is in one of its rooms. Any other account stays unknown, like a wrong id.
    const known = (uid: string): boolean => uid === ctx.user?.id || core.access.isConnected(ctx.instance, uid)
      || core.data.hasAuthor(ctx.instance.id, uid) || core.rooms.hasUser(ctx.instance.id, uid);
    for (const id of declared ? ids : []) {
      const u = known(id) ? core.users.get(id) : null;
      if (u) profiles[id] = { id: u.id, name: u.name, email: withEmail && core.access.signInConfirmed(ctx.instance, u, true) ? u.email : null, isMe: u.id === ctx.user?.id };
    }
    res.set('Cache-Control', 'no-store').json({ profiles });
  });

  const dbReads = new RateLimiter(DB_RATE.reads, DB_RATE.windowMs);
  const dbWrites = new RateLimiter(DB_RATE.writes, DB_RATE.windowMs);

  router.post('/__lager/db', express.json({ limit: '512kb' }), (req, res) => {
    if (req.get('X-Lager-Request') !== '1') throw new LagerError('forbidden', 'Missing X-Lager-Request header.');
    const ctx = ctxOf(res);
    requireAccess(ctx);
    // Counted before the store is touched: every query loads its whole collection. Anything that is not a read counts as a write.
    const isRead = DB_READS.has((req.body as { op?: unknown } | undefined)?.op as string);
    const limiter = isRead ? dbReads : dbWrites;
    const guest = ctx.viewer.userId === null;
    const budget = guest ? (isRead ? DB_RATE.guestReads : DB_RATE.guestWrites) : (isRead ? DB_RATE.reads : DB_RATE.writes);
    const viewerKey = `${ctx.instance.id}\n${ctx.viewer.userId ?? `ip:${addressKey(req.ip)}`}`;
    // Guests also share one budget per instance, so many addresses together stay bounded. It is checked first and recorded
    // only for an admitted request: while it is used up, a guest's own budget does not drain, and a guest at their own limit does not use it up.
    const guestsKey = `${ctx.instance.id}\nguests`;
    const guestTotal = budget * DB_RATE.guestTotalFactor;
    if ((guest && limiter.full(guestsKey, guestTotal)) || !limiter.hit(viewerKey, budget)) {
      res.set('Retry-After', '5');
      throw new LagerError('rate_limited', 'Too many database requests; try again shortly.');
    }
    if (guest) limiter.hit(guestsKey, guestTotal);
    const body: unknown = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new LagerError('invalid_argument', 'Request body must be a JSON object.');
    const { op, path, data, query, options } = body as Record<string, unknown>;
    if (typeof op !== 'string') throw new LagerError('invalid_argument', 'op is required.');
    if (typeof path !== 'string' || path === '') throw new LagerError('invalid_argument', 'path must be a non-empty string.');
    const id = ctx.instance.id;
    const by = ctx.viewer.userId;
    const deny = (): never => { throw new LagerError('forbidden', 'Not allowed.'); };
    const obj = (v: unknown, what: string): Record<string, unknown> => {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new LagerError('invalid_argument', `${what} must be an object.`);
      return v as Record<string, unknown>;
    };
    /** What a write answers with: the stored document for a caller who may read that path, else null (the write still happened). */
    const readable = <T extends { path: string }>(doc: T): T | null => (canRead(ctx.rules, ctx.viewer, doc.path) ? doc : null);
    res.set('Cache-Control', 'no-store');
    switch (op) {
      case 'get':
        // A document the viewer may not read behaves like a missing one.
        if (!canRead(ctx.rules, ctx.viewer, path)) { res.json({ doc: null }); return; }
        res.json({ doc: core.data.get(id, path) });
        return;
      case 'query': {
        if (!canRead(ctx.rules, ctx.viewer, path)) { res.json({ docs: [] }); return; }
        const spec = query === undefined ? {} : obj(query, 'query');
        // A rule on a document path does not apply to its collection, so filter per document.
        const docs = core.data.query(id, path, spec, (p) => canRead(ctx.rules, ctx.viewer, p));
        res.json({ docs });
        return;
      }
      case 'set':
      case 'update':
        if (!canWrite(ctx.rules, ctx.viewer, path)) deny();
        // A merge is checked against the size limit as a whole, which would tell a writer who cannot read how big the hidden document is.
        if (op === 'update' && !canRead(ctx.rules, ctx.viewer, path)) throw new LagerError('forbidden', WRITE_ONLY_UPDATE);
        // The stored document can hold more than the caller sent (an update merges), so it only goes back to someone who may read it.
        res.json({ doc: readable(core.data[op](id, path, obj(data, 'data'), by)) });
        return;
      case 'delete':
        if (!canDelete(ctx.rules, ctx.viewer, path)) deny();
        core.data.delete(id, path);
        res.json({ ok: true });
        return;
      case 'add': {
        const docPath = `${path}/${newDocId()}`;
        if (canWrite(ctx.rules, ctx.viewer, docPath)) {
          const doc = core.data.set(id, docPath, obj(data, 'data'), by);
          // The id goes back also where the document does not: whoever added it has to be able to name it.
          res.json({ doc: readable(doc), id: doc.id });
          return;
        }
        // Not a writer here, but a rule may let every visitor append. What they add counts as data from outside, with its limits.
        const rule = core.ingest.enabled ? appendRule(ctx.rules, ctx.viewer, docPath) : null;
        if (rule === null) throw new LagerError('forbidden', 'Not allowed.');
        const added = obj(data, 'data');
        if (Buffer.byteLength(JSON.stringify(added)) > INGEST_LIMITS.defaultMaxBytes) {
          throw new LagerError('invalid_argument', `A visitor can add at most ${INGEST_LIMITS.defaultMaxBytes} bytes at a time.`);
        }
        if (!core.ingest.admit(id, `rule:${rule}`, { perDay: INGEST_LIMITS.defaultPerDay })) {
          res.set('Retry-After', '5');
          throw new LagerError('rate_limited', 'Too many additions by visitors; try again shortly.');
        }
        const doc = core.data.ingest(id, docPath, added, { by, rotate: false });
        res.json({ doc: readable(doc), id: doc.id });
        return;
      }
      case 'acquire': {
        if (!canWrite(ctx.rules, ctx.viewer, path)) deny();
        // A lease answers with the document's version and expiry and merges its data: nothing for someone who may not read the document.
        if (!canRead(ctx.rules, ctx.viewer, path)) throw new LagerError('forbidden', WRITE_ONLY_ACQUIRE);
        const o = obj(options, 'options');
        res.json(core.data.acquire(id, path, {
          holder: o.holder as string, ttlMs: o.ttlMs as number | undefined, data: o.data as Record<string, unknown> | undefined,
        }, by));
        return;
      }
      default:
        throw new LagerError('invalid_argument', `Unknown op "${op}".`);
    }
  });

  const dbStreams = new StreamLimiter(STREAM_LIMITS);

  router.get('/__lager/db/events', (req, res) => {
    assertOwnOrigin(req);
    const first = ctxOf(res);
    requireAccess(first);
    const userId = first.viewer.userId;
    const viewer = dbStreams.admit(first.instance.id, userId ?? `ip:${addressKey(req.ip)}`, userId === null, '');
    if (!viewer) {
      res.status(429).set('Retry-After', '5').json({ error: { code: 'rate_limited', message: 'Too many open connections.' } });
      return;
    }
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    const epoch = first.user?.sessionEpoch;
    let ping: NodeJS.Timeout | undefined;
    let unsubscribe: (() => void) | undefined;
    let ended = false;
    const send = (event: string, payload?: unknown): void => {
      if (ended) return;
      res.write(`event: ${event}\n${payload === undefined ? '' : `data: ${JSON.stringify(payload)}\n`}\n`);
      // A client that stopped reading is cut off; its EventSource reconnects and catches up.
      if (res.writableLength > MAX_BUFFERED_BYTES) stop();
    };
    const stop = (): void => {
      if (ended) return;
      ended = true;
      clearInterval(ping);
      unsubscribe?.();
      dbStreams.release(first.instance.id, viewer, '');
      res.end();
    };
    /** The instance while this stream's session still has access to it, else null. Re-resolved on every event and every ping. */
    const current = (): { inst: Instance; level: Level } | null => {
      const inst = core.apps.getInstance(first.instance.id);
      const viewer = userId === null ? null : core.users.get(userId);
      // The stream belongs to the session it was opened with: logout, password change or disabling ends it.
      if (userId !== null && (!viewer || viewer.disabled || viewer.sessionEpoch !== epoch)) return null;
      const level = inst ? core.access.levelFor(inst, viewer) : 'none';
      return inst && RANK[level] >= RANK.view ? { inst, level } : null;
    };
    unsubscribe = core.hub.subscribe(first.instance.id, (e: HubEvent) => {
      const now = current();
      if (!now) { stop(); return; }
      if (e.type === 'reset') { send('reset'); return; }
      if (e.type === 'reload') { send('reload', { version: e.version }); return; }
      const rules = effectiveRules(activeCapabilities(core, now.inst));
      if (canRead(rules, { userId, level: now.level }, e.path)) send('change', { path: e.path, parent: e.parent });
    });
    // An idle stream has no events to notice a revoked session or grant, so the ping checks too.
    ping = setInterval(() => {
      if (!current()) { stop(); return; }
      res.write(': ping\n\n');
      if (res.writableLength > MAX_BUFFERED_BYTES) stop();
    }, PING_MS);
    req.on('close', stop);
  });

  mountAssetRoutes(router, core, ctxOf, requireAccess);
  mountRoomRoutes(router, core, ctxOf, requireAccess, activeCapabilities);
  mountPageRoutes(router, core, ctxOf, requireAccess);
  mountCompleteRoutes(router, core, ctxOf, requireAccess);
  mountIngestInfo(router, core, ctxOf, requireAccess, dbWrites);
  mountEmbed(router, core, ctxOf, requireAccess, dbWrites);

  router.use((req, res) => { sendNotFound(core, req, res); });
  return router;
}
