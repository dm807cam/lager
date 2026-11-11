import express from 'express';
import type { Request, Response } from 'express';
import type { Core } from '../core.js';
import { LagerError } from '../errors.js';
import { sendError } from './errors.js';
import type { Ctx } from './instance.js';

const MAX_HTML_BYTES = 16 * 1024 * 1024;
/** The JSON envelope escapes quotes and newlines, so the body may exceed the html it carries. */
const BODY_LIMIT_BYTES = MAX_HTML_BYTES + 1024 * 1024;
const PUBLISHES_PER_HOUR = 60;
const WINDOW_MS = 3600_000;

type Failure = { status: number; code: string; message: string };

function reply(res: Response, f: Failure): void {
  res.status(f.status).json({ error: { code: f.code, message: f.message } });
}

const isObject = (v: unknown): v is object => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The page must be a complete HTML document: optional BOM and whitespace, then a doctype. */
const DOCTYPE = /^\uFEFF?\s*<!doctype html/i;

/** `{publish: false}` under either name stops the page from saving itself, for every viewer. */
function publishDisabled(ctx: Ctx): boolean {
  return [ctx.caps.artifact, ctx.caps.self].some((d) => isObject(d) && (d as Record<string, unknown>).publish === false);
}

/** The app declares `artifact` or its alias `self`. */
function declared(ctx: Ctx): boolean {
  return isObject(ctx.caps.artifact) || isObject(ctx.caps.self);
}

/** Mounts `POST /__lager/artifact`: the page saves itself as a new version that belongs to this instance only. */
export function mountArtifactRoutes(router: express.Router, core: Core, ctxOf: (res: Response) => Ctx, requireAccess: (ctx: Ctx) => void): void {
  /** Publish attempts per instance within the last hour: failed ones count too, and the limit is checked before the body is read. */
  const recent = new Map<string, number[]>();
  const publishesInWindow = (instanceId: string, now: number): number[] => {
    const fresh = (recent.get(instanceId) ?? []).filter((t) => t > now - WINDOW_MS);
    if (fresh.length > 0) recent.set(instanceId, fresh); else recent.delete(instanceId);
    return fresh;
  };

  router.post('/__lager/artifact', (req: Request, res: Response, next) => {
    try {
      if (req.get('X-Lager-Request') !== '1') throw new LagerError('forbidden', 'Missing X-Lager-Request header.');
      const ctx = ctxOf(res);
      requireAccess(ctx);
      if (!declared(ctx)) { reply(res, { status: 403, code: 'not_declared', message: 'This app may not save itself.' }); return; }
      if (publishDisabled(ctx)) { reply(res, { status: 403, code: 'not_granted', message: 'This app may not save itself.' }); return; }
      if (ctx.viewer.level !== 'admin' && ctx.viewer.level !== 'owner') {
        reply(res, { status: 403, code: 'forbidden', message: 'Only administrators and owners may save the page.' });
        return;
      }
      if (publishesInWindow(ctx.instance.id, Date.now()).length >= PUBLISHES_PER_HOUR) {
        reply(res, { status: 429, code: 'rate_limited', message: 'Too many saves in the last hour.' });
        return;
      }
      const now = Date.now();
      recent.set(ctx.instance.id, [...publishesInWindow(ctx.instance.id, now), now]);
    } catch (e) { sendError(res, e); return; }
    next();
  }, (req, res, next) => {
    express.json({ limit: BODY_LIMIT_BYTES })(req, res, (err?: unknown) => {
      if (!err) { next(); return; }
      const e = err as { type?: string };
      if (e.type === 'entity.too.large') reply(res, { status: 413, code: 'too_large', message: 'The page is larger than 16 MiB.' });
      else reply(res, { status: 400, code: 'invalid_content', message: 'The request is not valid JSON.' });
    });
  }, (req, res) => {
    try {
      const ctx = ctxOf(res);
      const body: unknown = req.body;
      const { html, baseVersion } = isObject(body) ? body as Record<string, unknown> : {} as Record<string, unknown>;
      if (typeof html !== 'string' || html.trim() === '' || typeof baseVersion !== 'number' || !Number.isInteger(baseVersion)) {
        reply(res, { status: 400, code: 'invalid_content', message: 'html and baseVersion are required.' });
        return;
      }
      if (!DOCTYPE.test(html)) {
        reply(res, { status: 400, code: 'invalid_content', message: 'The page must be a complete HTML document (<!doctype html>).' });
        return;
      }
      if (Buffer.byteLength(html) > MAX_HTML_BYTES) {
        reply(res, { status: 413, code: 'too_large', message: 'The page is larger than 16 MiB.' });
        return;
      }
      const { version } = core.apps.selfPublish({ instanceId: ctx.instance.id, html, baseVersion, userId: ctx.viewer.userId ?? '' });
      res.set('Cache-Control', 'no-store').json({ version: String(version.number) });
    } catch (e) { sendError(res, e); }
  });
}
