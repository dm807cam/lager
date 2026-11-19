import express from 'express';
import type { Request, RequestHandler } from 'express';
import type { Core } from '../core.js';
import { LagerError } from '../errors.js';
import type { User } from '../platform/users.js';
import { sendError } from './errors.js';
import { requestLocale } from './locale.js';
import { createInstanceRouter } from './instance.js';
import { instanceHostPage, notFoundPage } from './pages.js';
import { createPlatformRouter } from './platform.js';
import { sessionUser } from './session.js';

export { sessionUser };
export interface PlatformExtension { (router: express.Router, core: Core): void }

/** Platform routes: 401 JSON for /api paths, redirect to /login for pages. Sets `res.locals.user`. */
export function requireUser(core: Core): RequestHandler {
  return (req, res, next) => {
    const user: User | null = sessionUser(core, req);
    if (user) {
      res.locals.user = user;
      res.locals.locale = requestLocale(core, req, user);
      next();
    } else if (req.originalUrl.startsWith('/api')) {
      sendError(res, new LagerError('unauthenticated', 'Sign in required.'));
    } else {
      // Only a GET can be replayed after login; a form POST would end on a 404.
      res.redirect('/login?return=' + encodeURIComponent(req.method === 'GET' ? req.originalUrl : '/'));
    }
  };
}

export function createHttpApp(core: Core, extensions: PlatformExtension[] = []): express.Express {
  const { config } = core;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  if (config.accessLog) {
    // The query string is left out: it can carry sign-in codes and reset tokens.
    app.use((req, res, next) => {
      const start = process.hrtime.bigint();
      res.on('close', () => {
        const ms = Number((process.hrtime.bigint() - start) / 1_000_000n);
        const host = String(req.headers.host ?? '-').replace(/[^\x21-\x7e]/g, '?').slice(0, 100);
        const urlPath = req.originalUrl.split('?')[0].replace(/[^\x21-\x7e]/g, '?').slice(0, 200);
        console.log(`${new Date().toISOString()} ${req.ip ?? '-'} ${req.method} ${host}${urlPath} ${res.statusCode} ${ms}ms`);
      });
      next();
    });
  }

  const platformHost = config.publicUrl.hostname.toLowerCase();
  const suffix = '.' + config.appsDomain.toLowerCase();
  const platform = createPlatformRouter(core, extensions);
  const instances = createInstanceRouter(core);

  app.use((req: Request, res, next) => {
    // A request without a Host header (HTTP/1.0 probes, scanners) has no host name and ends as "not found" below.
    const host = (req.hostname ?? '').toLowerCase().replace(/\.$/, '');
    if (host === platformHost) {
      platform(req, res, next);
    } else if (host.endsWith(suffix) && host.length > suffix.length && !host.slice(0, -suffix.length).includes('.')) {
      res.locals.slug = host.slice(0, -suffix.length);
      instances(req, res, next);
    } else {
      // Not the platform and not under the apps domain: only a custom domain attached to an instance is served.
      const id = core.domains.instanceIdFor(host);
      const instance = id ? core.apps.getInstance(id) : null;
      if (!instance) {
        res.status(404).type('html').send(notFoundPage(requestLocale(core, req, null), instanceHostPage(core.config)));
        return;
      }
      res.locals.slug = instance.slug;
      res.locals.customHost = host;
      instances(req, res, next);
    }
  });

  app.use((err: unknown, _req: Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) { next(err); return; }
    const e = err as { type?: string; status?: number; expose?: boolean };
    if (e?.type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'invalid_argument', message: 'Request body too large.' } });
    } else if (typeof e?.type === 'string' && e.type.startsWith('entity.') && e.status === 400) {
      res.status(400).json({ error: { code: 'invalid_argument', message: 'Malformed request body.' } });
    } else if (typeof e?.status === 'number' && e.status >= 400 && e.status < 500 && (e.expose === true || err instanceof URIError)) {
      // Express and the body parsers mark what the client got wrong (a malformed URL, an unsupported charset or encoding): answered
      // with their status and not logged as a server error.
      res.status(e.status).json({ error: { code: 'invalid_argument', message: 'The request is malformed.' } });
    } else {
      sendError(res, err);
    }
  });
  return app;
}
