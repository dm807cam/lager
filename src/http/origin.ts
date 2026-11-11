import type { RequestHandler } from 'express';
import { esc, page } from './pages.js';

/**
 * Forms without a session cannot carry a CSRF token. A browser post from another origin (or with `Origin: null`) is refused;
 * requests without an Origin header (non-browser clients) pass. Pages with such forms must be served with
 * `Referrer-Policy: same-origin`, because a stricter policy makes browsers send `Origin: null` on same-origin posts.
 */
export function sameOriginGuard(origin: string): RequestHandler {
  return (req, res, next) => {
    const o = req.headers.origin;
    if (o !== undefined && o !== origin) {
      res.status(403).type('html').send(page('Das hat nicht geklappt', `<h1>Das hat nicht geklappt</h1><p>${esc('Die Anfrage kam von einer fremden Seite und wurde abgelehnt.')}</p>`));
      return;
    }
    next();
  };
}
