import express from 'express';
import type { Response } from 'express';
import type { Core } from '../core.js';
import { LagerError } from '../errors.js';
import { EMBED_LIMITS, embedDeclared } from '../platform/embed.js';
import { DB_RATE, type Ctx } from './instance.js';
import type { RateLimiter } from './ratelimit.js';

/**
 * What `lager.use("embed")` shows the page. The websites are the owner's configuration, so they go only to the people who
 * manage the instance, as the added websites of an ingest endpoint do; `active` lists those that the response header names
 * right now (a website that became a host of this Lager is left out there).
 */
function embedInfo(core: Core, ctx: Ctx, manages: boolean): Record<string, unknown> {
  return {
    origins: manages ? core.embed.origins(ctx.instance.id) : [],
    active: manages ? core.embed.frameAncestors(ctx.instance.id, ctx.caps) : [],
    limit: EMBED_LIMITS.origins,
    canManage: manages,
  };
}

/**
 * Mounts `GET /__lager/embed` and `PUT /__lager/embed/origins`, with which the people who manage the instance replace the
 * websites that may show it in a frame (`embed.setOrigins`). Both answer only for an app whose active version declares `embed`;
 * changing the list is refused for everyone below `admin`.
 */
export function mountEmbed(
  router: express.Router, core: Core, ctxOf: (res: Response) => Ctx, requireAccess: (ctx: Ctx) => void, writes: RateLimiter,
): void {
  const declaredOrRefuse = (ctx: Ctx): void => {
    if (!embedDeclared(ctx.caps)) throw new LagerError('not_found', 'This app is not built to be shown on other websites.');
  };
  const manages = (ctx: Ctx): boolean => ctx.viewer.level === 'admin' || ctx.viewer.level === 'owner';

  router.get('/__lager/embed', (_req, res) => {
    const ctx = ctxOf(res);
    requireAccess(ctx);
    declaredOrRefuse(ctx);
    res.set('Cache-Control', 'no-store').json(embedInfo(core, ctx, manages(ctx)));
  });

  router.put('/__lager/embed/origins', express.json({ limit: '16kb' }), (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.get('X-Lager-Request') !== '1') throw new LagerError('forbidden', 'Missing X-Lager-Request header.');
    const ctx = ctxOf(res);
    requireAccess(ctx);
    declaredOrRefuse(ctx);
    if (!manages(ctx)) throw new LagerError('forbidden', 'Only the people who manage this instance may choose the websites that show it.');
    // Out of the same budget as the viewer's database writes: each call writes to the platform database.
    if (!writes.hit(`${ctx.instance.id}\n${ctx.viewer.userId}`, DB_RATE.writes)) {
      res.set('Retry-After', '5');
      throw new LagerError('rate_limited', 'Too many requests; try again shortly.');
    }
    const body: unknown = req.body;
    const list = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).origins : undefined;
    core.embed.setOrigins(ctx.instance.id, list);
    res.json(embedInfo(core, ctx, true));
  });
}
