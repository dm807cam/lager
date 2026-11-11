import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import type { Request, Response } from 'express';
import type { Core } from '../core.js';
import { canRead, canWrite, type Level, type Viewer } from '../data/rules.js';
import type { HubEvent } from '../data/hub.js';
import { LagerError } from '../errors.js';
import type { Capabilities, DbRule, Instance } from '../platform/apps.js';
import type { User } from '../platform/users.js';
import { INSTANCE_COOKIE, readCookie, setCookie, THIRTY_DAYS_SECONDS } from './cookies.js';
import { safeReturnPath, sendError } from './errors.js';
import { injectRuntime } from './inject.js';
import { badCodePage, forbiddenPage, notFoundPage } from './pages.js';
import { signToken, verifyToken } from './tokens.js';

const RUNTIME_FILE = new URL('../runtime/runtime.js', import.meta.url);
const MAX_PROFILE_IDS = 100;
const PING_MS = 25_000;
const RANK: Record<Level, number> = { none: 0, view: 1, interact: 2, admin: 3, owner: 4 };

/** Access level of a (possibly anonymous) user on an instance. */
export function levelFor(instance: Instance, userId: string | null): Level {
  if (userId !== null && userId === instance.ownerId) return 'owner';
  if (instance.visibility === 'users' && userId !== null) return 'interact';
  if (instance.visibility === 'public') return 'view';
  return 'none';
}

function instanceUser(core: Core, req: Request, instance: Instance): User | null {
  const t = verifyToken<{ uid?: unknown; iid?: unknown; k?: unknown }>(readCookie(req, INSTANCE_COOKIE), core.config.secret);
  if (!t || t.k !== 'inst' || t.iid !== instance.id || typeof t.uid !== 'string') return null;
  return core.users.get(t.uid);
}

function activeCapabilities(core: Core, instance: Instance): Capabilities {
  return core.apps.listVersions(instance.appId).find((v) => v.number === instance.activeVersion)?.capabilities ?? {};
}

function loginUrl(core: Core, instance: Instance): string {
  return `${core.config.publicUrl.origin}/auth/instance?slug=${encodeURIComponent(instance.slug)}&return=%2F`;
}

function newDocId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (const b of crypto.randomBytes(20)) id += alphabet[b % alphabet.length];
  return id;
}

interface Ctx { instance: Instance; user: User | null; viewer: Viewer; caps: Capabilities; rules: DbRule[] | undefined }

function context(core: Core, req: Request, instance: Instance): Ctx {
  const user = instanceUser(core, req, instance);
  const caps = activeCapabilities(core, instance);
  return {
    instance, user, caps, rules: caps.db?.rules,
    viewer: { userId: user?.id ?? null, level: levelFor(instance, user?.id ?? null) },
  };
}

/** Throws unless the viewer has at least `view` access. */
function requireAccess(ctx: Ctx): void {
  if (ctx.viewer.level !== 'none') return;
  if (ctx.user) throw new LagerError('forbidden', 'No access to this instance.');
  throw new LagerError('unauthenticated', 'Sign in required.');
}

export function createInstanceRouter(core: Core): express.Router {
  const router = express.Router();
  const { config } = core;
  // Consumed handshake code ids with their expiry (epoch seconds); codes are single-use.
  const usedCodes = new Map<string, number>();
  const runtime = fs.readFileSync(RUNTIME_FILE);
  const runtimeEtag = `"${crypto.createHash('sha256').update(runtime).digest('base64url').slice(0, 27)}"`;

  const ctxOf = (res: Response): Ctx => res.locals.ctx as Ctx;
  const emailAllowed = (ctx: Ctx): boolean => Array.isArray(ctx.caps.user?.scopes) && ctx.caps.user.scopes.includes('email');

  router.use((req, res, next) => {
    const instance = core.apps.getInstanceBySlug(res.locals.slug as string);
    if (!instance) {
      res.status(404).type('html').send(notFoundPage());
      return;
    }
    res.locals.ctx = context(core, req, instance);
    next();
  });

  router.get('/__lager/callback', (req, res) => {
    const { instance } = ctxOf(res);
    const t = verifyToken<{ uid?: unknown; iid?: unknown; k?: unknown; jti?: unknown; exp: number }>(
      typeof req.query.code === 'string' ? req.query.code : undefined, config.secret);
    if (!t || t.k !== 'code' || t.iid !== instance.id || typeof t.uid !== 'string' || typeof t.jti !== 'string'
      || !core.users.get(t.uid)) {
      res.status(400).type('html').send(badCodePage());
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    for (const [id, exp] of usedCodes) if (exp <= now) usedCodes.delete(id);
    if (usedCodes.has(t.jti)) {
      res.status(400).type('html').send(badCodePage());
      return;
    }
    usedCodes.set(t.jti, t.exp);
    setCookie(res, config, INSTANCE_COOKIE, signToken({ uid: t.uid, iid: instance.id, k: 'inst' }, config.secret, THIRTY_DAYS_SECONDS));
    res.redirect(safeReturnPath(req.query.return));
  });

  router.get(['/', '/index.html'], (_req, res) => {
    const ctx = ctxOf(res);
    if (ctx.viewer.level === 'none') {
      if (ctx.user) {
        res.status(403).type('html').send(forbiddenPage());
      } else {
        res.redirect(loginUrl(core, ctx.instance));
      }
      return;
    }
    const html = injectRuntime(core.apps.readVersionHtml(ctx.instance.appId, ctx.instance.activeVersion));
    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    }).send(html);
  });

  router.get('/__lager/runtime.js', (req, res) => {
    res.set({ 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', ETag: runtimeEtag });
    if (req.headers['if-none-match'] === runtimeEtag) {
      res.status(304).end();
      return;
    }
    res.send(runtime);
  });

  router.get('/__lager/session', (_req, res) => {
    const ctx = ctxOf(res);
    const url = loginUrl(core, ctx.instance);
    if (ctx.viewer.level === 'none') {
      sendError(res, new LagerError('unauthenticated', 'Sign in required.'), { loginUrl: url });
      return;
    }
    const level = ctx.viewer.level;
    res.set('Cache-Control', 'no-store').json({
      viewer: {
        id: ctx.user?.id ?? null,
        name: ctx.user?.name ?? '',
        email: ctx.user && emailAllowed(ctx) ? ctx.user.email : null,
        level,
        isOwner: level === 'owner',
        canEdit: level === 'admin' || level === 'owner',
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
    const raw = typeof req.query.ids === 'string' ? req.query.ids : '';
    const ids = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
    if (ids.length > MAX_PROFILE_IDS) throw new LagerError('invalid_argument', `At most ${MAX_PROFILE_IDS} ids are allowed.`);
    const profiles: Record<string, { id: string; name: string; email: string | null; isMe: boolean }> = {};
    for (const id of ids) {
      const u = core.users.get(id);
      if (u) profiles[id] = { id: u.id, name: u.name, email: emailAllowed(ctx) ? u.email : null, isMe: u.id === ctx.user?.id };
    }
    res.set('Cache-Control', 'no-store').json({ profiles });
  });

  router.post('/__lager/db', express.json({ limit: '512kb' }), (req, res) => {
    if (req.get('X-Lager-Request') !== '1') throw new LagerError('forbidden', 'Missing X-Lager-Request header.');
    const ctx = ctxOf(res);
    requireAccess(ctx);
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
    res.set('Cache-Control', 'no-store');
    switch (op) {
      case 'get':
        if (!canRead(ctx.rules, ctx.viewer, path)) deny();
        res.json({ doc: core.data.get(id, path) });
        return;
      case 'query': {
        if (!canRead(ctx.rules, ctx.viewer, path)) deny();
        const spec = query === undefined ? {} : obj(query, 'query');
        // A rule on a document path does not apply to its collection, so filter per document.
        const docs = core.data.query(id, path, spec).filter((d) => canRead(ctx.rules, ctx.viewer, d.path));
        res.json({ docs });
        return;
      }
      case 'set':
      case 'update':
        if (!canWrite(ctx.rules, ctx.viewer, path)) deny();
        res.json({ doc: core.data[op](id, path, obj(data, 'data'), by) });
        return;
      case 'delete':
        if (!canWrite(ctx.rules, ctx.viewer, path)) deny();
        core.data.delete(id, path);
        res.json({ ok: true });
        return;
      case 'add': {
        const docPath = `${path}/${newDocId()}`;
        if (!canWrite(ctx.rules, ctx.viewer, docPath)) deny();
        res.json({ doc: core.data.set(id, docPath, obj(data, 'data'), by) });
        return;
      }
      case 'acquire': {
        if (!canWrite(ctx.rules, ctx.viewer, path)) deny();
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

  router.get('/__lager/db/events', (req, res) => {
    const first = ctxOf(res);
    requireAccess(first);
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    const send = (event: string, payload?: unknown): void => {
      res.write(`event: ${event}\n${payload === undefined ? '' : `data: ${JSON.stringify(payload)}\n`}\n`);
    };
    const userId = first.viewer.userId;
    let ping: NodeJS.Timeout | undefined;
    let unsubscribe: (() => void) | undefined;
    const stop = (): void => {
      clearInterval(ping);
      unsubscribe?.();
      res.end();
    };
    unsubscribe = core.hub.subscribe(first.instance.id, (e: HubEvent) => {
      // Re-resolve access on every event so revoked visibility or changed rules take effect immediately.
      const inst = core.apps.getInstance(first.instance.id);
      const level = inst ? levelFor(inst, userId) : 'none';
      if (!inst || RANK[level] < RANK.view) { stop(); return; }
      if (e.type === 'reset') { send('reset'); return; }
      const rules = activeCapabilities(core, inst).db?.rules;
      if (canRead(rules, { userId, level }, e.path)) send('change', { path: e.path, parent: e.parent });
    });
    ping = setInterval(() => { res.write(': ping\n\n'); }, PING_MS);
    req.on('close', () => { clearInterval(ping); unsubscribe?.(); });
  });

  router.use((_req, res) => { res.status(404).type('text/plain').send('Nicht gefunden'); });
  return router;
}
