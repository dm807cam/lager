import path from 'node:path';
import express from 'express';
import type { Response } from 'express';
import type { Core } from '../core.js';
import { AssetError, ASSET_LIMITS, isTextType, type AssetInfo } from '../data/assets.js';
import { LagerError } from '../errors.js';
import { sendError } from './errors.js';
import type { Ctx } from './instance.js';
import { assertOwnOrigin } from './origin.js';

const BODY_LIMIT = ASSET_LIMITS.maxBytes + 1;
const SANDBOX_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'";
const ATTACHMENT_TYPES = new Set(['text/csv', 'text/markdown', 'application/json', 'text/plain']);

const blobUrl = (id: string): string => `/_blob/${id}`;

/** Uploading and listing: editors always, `interact` viewers only when the app declares `assets.upload: "interact"`. */
function mayUse(ctx: Ctx): boolean {
  const level = ctx.viewer.level;
  if (level === 'admin' || level === 'owner') return true;
  return level === 'interact' && ctx.viewer.userId !== null && ctx.caps.assets?.upload === 'interact';
}

const isEditor = (ctx: Ctx): boolean => ctx.viewer.level === 'admin' || ctx.viewer.level === 'owner';

function requireDeclared(ctx: Ctx): void {
  if (ctx.caps.assets === undefined || ctx.caps.assets === null || typeof ctx.caps.assets !== 'object') {
    throw new LagerError('not_found', 'This app does not use file uploads.');
  }
}

function requireUse(ctx: Ctx): void {
  requireDeclared(ctx);
  if (!mayUse(ctx)) throw new LagerError('forbidden', 'You may not use file uploads.');
}

function guard(req: express.Request): void {
  if (req.get('X-Lager-Request') !== '1') throw new LagerError('forbidden', 'Missing X-Lager-Request header.');
}

function fail(res: Response, e: unknown): void {
  if (e instanceof AssetError) {
    res.status(e.reason === 'too_large' ? 413 : 400).json({ error: { code: e.code, message: e.message, reason: e.reason } });
    return;
  }
  sendError(res, e);
}

/** Mounts the asset routes (`/__lager/assets`, `/_blob/:id`) on the instance router. */
export function mountAssetRoutes(
  router: express.Router, core: Core, ctxOf: (res: Response) => Ctx, requireAccess: (ctx: Ctx) => void,
): void {
  const toJson = (a: AssetInfo): Record<string, unknown> => ({
    id: a.id, url: blobUrl(a.id), contentType: a.contentType, sizeBytes: a.sizeBytes, createdAt: a.createdAt,
  });

  router.post('/__lager/assets', (req, res, next) => {
    try { guard(req); requireAccess(ctxOf(res)); requireUse(ctxOf(res)); } catch (e) { fail(res, e); return; }
    next();
  }, express.raw({ type: () => true, limit: BODY_LIMIT }), (req, res) => {
    try {
      const ctx = ctxOf(res);
      const body: unknown = req.body;
      const bytes = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
      const info = core.assets.put(ctx.instance.id, bytes, req.get('Content-Type'), ctx.viewer.userId);
      res.status(201).set('Cache-Control', 'no-store').json({ id: info.id, url: blobUrl(info.id), sizeBytes: info.sizeBytes, contentType: info.contentType });
    } catch (e) { fail(res, e); }
  });

  router.get('/__lager/assets', (_req, res) => {
    const ctx = ctxOf(res);
    requireAccess(ctx);
    requireUse(ctx);
    const id = ctx.instance.id;
    const mine = isEditor(ctx) ? undefined : ctx.viewer.userId ?? '';
    const used = core.assets.usage(id);
    res.set('Cache-Control', 'no-store').json({
      assets: core.assets.list(id, mine).map(toJson),
      usage: { files: used.files, bytes: used.bytes, maxFiles: ASSET_LIMITS.maxFiles, maxBytes: core.assets.maxBytes(id) },
    });
  });

  router.delete('/__lager/assets/:id', (req, res) => {
    guard(req);
    const ctx = ctxOf(res);
    requireAccess(ctx);
    requireUse(ctx);
    const id = ctx.instance.id;
    const found = core.assets.get(id, req.params.id);
    if (!found) { res.set('Cache-Control', 'no-store').json({ deleted: false }); return; }
    if (!isEditor(ctx) && found.info.uploadedBy !== ctx.viewer.userId) {
      throw new LagerError('forbidden', 'You can only delete your own files.');
    }
    res.set('Cache-Control', 'no-store').json({ deleted: core.assets.delete(id, found.info.id) });
  });

  router.get('/_blob/:id', (req, res, next) => {
    // Another instance's page may not embed this instance's files with the visitor's cookies.
    assertOwnOrigin(req, { checkOrigin: false });
    const ctx = ctxOf(res);
    requireAccess(ctx);
    const found = core.assets.get(ctx.instance.id, req.params.id);
    if (!found) { res.status(404).type('text/plain').send('Not found'); return; }
    const type = found.info.contentType;
    const text = isTextType(type);
    res.set({
      'Content-Type': text ? `${type}; charset=utf-8` : type,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Content-Disposition': ATTACHMENT_TYPES.has(type) ? 'attachment' : 'inline',
    });
    if (text || type === 'image/svg+xml') res.set('Content-Security-Policy', SANDBOX_CSP);
    res.sendFile(path.resolve(found.path), { cacheControl: false, dotfiles: 'allow' }, (err) => { if (err) next(err); });
  });
}
