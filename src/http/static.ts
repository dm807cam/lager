import crypto from 'node:crypto';
import fs from 'node:fs';
import type { PlatformExtension } from './app.js';

/** One file of the interface, addressed by a hash of its content so it can be cached for good. */
interface StaticFile { path: string; type: string; body: Buffer }

// src/static next to src/http when running from source, dist/static after a build.
const load = (name: string, ext: string, type: string): StaticFile => {
  const body = fs.readFileSync(new URL(`../static/${name}.${ext}`, import.meta.url));
  const hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
  return { path: `/static/${name}.${hash}.${ext}`, type, body };
};

const CSS = load('app', 'css', 'text/css; charset=utf-8');
const JS = load('app', 'js', 'text/javascript; charset=utf-8');

/** The current URLs (platform-relative paths) of the stylesheet and the script. */
export const staticUrls = (): { css: string; js: string } => ({ css: CSS.path, js: JS.path });

/**
 * Serves the stylesheet and the script under their hashed paths; any other hash is a 404. Instance hosts load the
 * stylesheet from here for their error pages, so it may be used cross-origin.
 */
export const staticExtension: PlatformExtension = (router) => {
  for (const file of [CSS, JS]) {
    router.get(file.path, (_req, res) => {
      res.set({
        'Content-Type': file.type, 'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'cross-origin',
      }).send(file.body);
    });
  }
};
