import type { RequestHandler } from 'express';
import type { Core } from '../core.js';
import { t } from '../i18n/index.js';
import { requestLocale } from './locale.js';
import { esc, page } from './pages.js';

/**
 * Forms without a session cannot carry a CSRF token. A browser post from another origin (or with `Origin: null`) is refused;
 * requests without an Origin header (non-browser clients) pass. Pages with such forms must be served with
 * `Referrer-Policy: same-origin`, because a stricter policy makes browsers send `Origin: null` on same-origin posts.
 */
export function sameOriginGuard(core: Core): RequestHandler {
  const origin = core.config.publicUrl.origin;
  return (req, res, next) => {
    const o = req.headers.origin;
    if (o !== undefined && o !== origin) {
      const locale = requestLocale(core, req);
      const title = t(locale, 'error.failed.title');
      res.status(403).type('html').send(page(locale, title, `<h1>${esc(title)}</h1><p>${esc(t(locale, 'error.crossOrigin'))}</p>`));
      return;
    }
    next();
  };
}
