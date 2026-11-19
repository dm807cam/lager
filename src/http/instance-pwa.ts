import express from 'express';
import type { Request, Response } from 'express';
import type { Core } from '../core.js';
import { LagerError } from '../errors.js';
import type { App, Instance } from '../platform/apps.js';
import { DEFAULT_THEME_COLOR, type ICON_SIZES } from '../platform/icons.js';
import { fallbackIconPath } from '../platform/fallback-icon.js';
import { sendError } from './errors.js';

const YEAR = 'public, max-age=31536000, immutable';
const SHORT_NAME_LENGTH = 12;
const ICON_FILE = /^icon-(180|192|512)\.png$/;

const themeOf = (app: App): string => (/^#[0-9a-f]{6}$/i.test(app.themeColor) ? app.themeColor.toLowerCase() : DEFAULT_THEME_COLOR);

/**
 * The home-screen install machinery: the manifest and the icons of an instance. Public (a private instance serves them too,
 * the browser fetches them without credentials, possibly cross-site), but never for an unknown or disabled instance. The
 * same-origin guard of the other instance routes is deliberately not applied here. Only PNGs rendered on the server go out.
 * Mounted before the instance-wide middleware, which answers a disabled instance with its notice instead of a plain 404.
 */
export function mountPwaRoutes(router: express.Router, core: Core): void {
  const notFound = (res: Response): void => sendError(res, new LagerError('not_found', 'Not found.'));

  /** The app of the instance this host serves, or null (answered with 404). */
  const resolve = async (res: Response): Promise<{ instance: Instance; app: App } | null> => {
    const instance = core.apps.getInstanceBySlug(res.locals.slug as string);
    const app = instance && !instance.disabled ? core.apps.getApp(instance.appId) : null;
    if (!instance || !app) { notFound(res); return null; }
    return { instance, app };
  };

  const png = (req: Request, res: Response, app: App, size: (typeof ICON_SIZES)[number], maskable = false): void => {
    const own = core.icons.png(app.id, size, maskable);
    // No drawn icon yet: serve the bundled one. A public request never queues rendering.
    const file = own ?? fallbackIconPath(size);
    const current = own !== null && req.query.v === String(app.iconVersion);
    res.set({
      'Content-Type': 'image/png', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': current ? YEAR : 'no-cache',
    });
    res.sendFile(file, { dotfiles: 'allow', cacheControl: false });
  };

  router.get('/__lager/manifest.webmanifest', async (_req, res) => {
    const found = await resolve(res);
    if (!found) return;
    const { app } = found;
    const color = themeOf(app);
    const v = app.iconVersion;
    res.set({
      'Content-Type': 'application/manifest+json; charset=utf-8', 'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'no-cache',
    }).send(JSON.stringify({
      name: app.title,
      short_name: [...app.title].slice(0, SHORT_NAME_LENGTH).join('').trim(),
      description: app.description,
      start_url: '/', scope: '/', display: 'standalone',
      background_color: color, theme_color: color,
      icons: [
        { src: `/__lager/icon-192.png?v=${v}`, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: `/__lager/icon-512.png?v=${v}`, sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: `/__lager/icon-512-maskable.png?v=${v}`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    }));
  });

  router.get('/__lager/:file', async (req, res, next) => {
    const file = req.params.file as string;
    const m = ICON_FILE.exec(file);
    if (!m && file !== 'icon-512-maskable.png') { next(); return; }
    const found = await resolve(res);
    if (!found) return;
    if (m) png(req, res, found.app, Number(m[1]) as (typeof ICON_SIZES)[number]);
    else png(req, res, found.app, 512, true);
  });

  router.get('/apple-touch-icon.png', async (req, res) => {
    const found = await resolve(res);
    if (found) png(req, res, found.app, 180);
  });

  router.get('/favicon.ico', async (req, res) => {
    const found = await resolve(res);
    if (found) png(req, res, found.app, 64);
  });
}
