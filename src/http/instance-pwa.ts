import express from 'express';
import type { Request, Response } from 'express';
import type { Core } from '../core.js';
import { LagerError } from '../errors.js';
import type { App, Instance } from '../platform/apps.js';
import { DEFAULT_THEME_COLOR, type ICON_SIZES } from '../platform/icons.js';
import { fallbackIconPath } from '../platform/fallback-icon.js';
import { sendError } from './errors.js';

const YEAR = 'public, max-age=31536000, immutable';
/** The icon of an instance that is not public is for the viewer's browser only, never for a shared cache. */
const PRIVATE_YEAR = 'private, max-age=31536000, immutable';
/** What the manifest calls an instance towards someone who may not open it. */
const GENERIC_NAME = 'Lager';
const SHORT_NAME_LENGTH = 12;
const ICON_FILE = /^icon-(180|192|512)\.png$/;

const themeOf = (app: App): string => (/^#[0-9a-f]{6}$/i.test(app.themeColor) ? app.themeColor.toLowerCase() : DEFAULT_THEME_COLOR);

/**
 * The home-screen install machinery: the manifest and the icons of an instance, never for an unknown or disabled instance.
 * Browsers fetch them without the page's say, possibly cross-site and, for the manifest, without cookies unless the link asks
 * for them (the injected one does, see `installTags`). Everyone gets an answer, so installing always works, but title,
 * description, colour and icon are what the app is about: they go only to a viewer who may open the instance. Anyone else
 * (an anonymous request to an instance that is not public, a signed-in account without access) gets a manifest that says
 * "Lager" and the bundled icon. The same-origin guard of the other instance routes is deliberately not applied here. Only
 * PNGs rendered on the server go out. Mounted before the instance-wide middleware, which answers a disabled instance with its
 * notice instead of a plain 404. `mayView` tells whether the request comes from someone with access to the instance.
 */
export function mountPwaRoutes(router: express.Router, core: Core, mayView: (req: Request, instance: Instance) => boolean): void {
  const notFound = (res: Response): void => sendError(res, new LagerError('not_found', 'Not found.'));

  /** The app of the instance this host serves, or null (answered with 404); `open` is false for a viewer who only gets the generic answer. */
  const resolve = async (req: Request, res: Response): Promise<{ instance: Instance; app: App; open: boolean; shared: boolean } | null> => {
    const instance = core.apps.getInstanceBySlug(res.locals.slug as string);
    const app = instance && !instance.disabled ? core.apps.getApp(instance.appId) : null;
    if (!instance || !app) { notFound(res); return null; }
    // Anything that depends on who asks must not be kept by a cache between Lager and the browser.
    return { instance, app, open: mayView(req, instance), shared: instance.visibility === 'public' };
  };

  const png = (req: Request, res: Response, found: { app: App; open: boolean; shared: boolean }, size: (typeof ICON_SIZES)[number], maskable = false): void => {
    const { app } = found;
    const own = found.open ? core.icons.png(app.id, size, maskable) : null;
    // No drawn icon yet, or a viewer without access: serve the bundled one. A public request never queues rendering.
    const file = own ?? fallbackIconPath(size);
    const current = own !== null && req.query.v === String(app.iconVersion);
    res.set({
      'Content-Type': 'image/png', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': current ? (found.shared ? YEAR : PRIVATE_YEAR) : 'no-cache',
    });
    if (!found.shared) res.vary('Cookie');
    res.sendFile(file, { dotfiles: 'allow', cacheControl: false });
  };

  router.get('/__lager/manifest.webmanifest', async (req, res) => {
    const found = await resolve(req, res);
    if (!found) return;
    const { app, open } = found;
    const color = open ? themeOf(app) : DEFAULT_THEME_COLOR;
    const v = open ? `?v=${app.iconVersion}` : '';
    const title = open ? app.title : GENERIC_NAME;
    res.set({
      'Content-Type': 'application/manifest+json; charset=utf-8', 'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'no-cache',
    });
    if (!found.shared) res.vary('Cookie');
    res.send(JSON.stringify({
      name: title,
      short_name: [...title].slice(0, SHORT_NAME_LENGTH).join('').trim(),
      ...(open ? { description: app.description } : {}),
      start_url: '/', scope: '/', display: 'standalone',
      background_color: color, theme_color: color,
      icons: [
        { src: `/__lager/icon-192.png${v}`, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: `/__lager/icon-512.png${v}`, sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: `/__lager/icon-512-maskable.png${v}`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    }));
  });

  router.get('/__lager/:file', async (req, res, next) => {
    const file = req.params.file as string;
    const m = ICON_FILE.exec(file);
    if (!m && file !== 'icon-512-maskable.png') { next(); return; }
    const found = await resolve(req, res);
    if (!found) return;
    if (m) png(req, res, found, Number(m[1]) as (typeof ICON_SIZES)[number]);
    else png(req, res, found, 512, true);
  });

  router.get('/apple-touch-icon.png', async (req, res) => {
    const found = await resolve(req, res);
    if (found) png(req, res, found, 180);
  });

  router.get('/favicon.ico', async (req, res) => {
    const found = await resolve(req, res);
    if (found) png(req, res, found, 64);
  });
}
