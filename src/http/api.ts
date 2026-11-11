import express from 'express';
import type { Request, RequestHandler, Response } from 'express';
import type { Core } from '../core.js';
import { LagerError } from '../errors.js';
import { appDetail, appSummary, checkCapabilities, describeDeploy, instanceJson, ownedApp, ownedInstance } from '../mcp/tools.js';
import type { User } from '../platform/users.js';
import type { PlatformExtension } from './app.js';
import { sessionUser } from './session.js';

const MAX_HTML = '16mb';
// JSON escaping inflates HTML; Apps.deploy enforces the 16 MiB limit on the HTML itself.
const MAX_JSON = '24mb';

/** API token (`lgr_…`) or OAuth access token from `Authorization: Bearer …`. */
export function bearerUser(core: Core, req: Request): User | null {
  const header = req.get('authorization');
  if (!header) return null;
  const m = /^Bearer +([^\s]+) *$/i.exec(header);
  if (!m) return null;
  const token = m[1];
  if (token.startsWith('lgr_')) return core.tokens.verify(token);
  return core.oauth.verifyAccessToken(token)?.user ?? null;
}

const unauthenticated = (): LagerError => new LagerError('unauthenticated', 'Sign in required: send Authorization: Bearer <token>.');
const userOf = (res: Response): User => res.locals.apiUser as User;

/**
 * Bearer token, or the platform session cookie together with `X-Lager-Request: 1` (CSRF guard).
 * An Authorization header is authoritative: a bad token is rejected even next to a valid cookie.
 */
function requireApiUser(core: Core): RequestHandler {
  return (req, res, next) => {
    let user: User | null = null;
    if (req.get('authorization') !== undefined) user = bearerUser(core, req);
    else if (req.get('X-Lager-Request') === '1') user = sessionUser(core, req);
    if (!user) throw unauthenticated();
    res.locals.apiUser = user;
    next();
  };
}

/** Token management: browser session only, so a leaked token cannot mint or list tokens. */
function requireSessionOnly(core: Core): RequestHandler {
  return (req, res, next) => {
    if (req.get('authorization') !== undefined) {
      throw new LagerError('forbidden', 'API tokens can only be managed with a browser session.');
    }
    const user = req.get('X-Lager-Request') === '1' ? sessionUser(core, req) : null;
    if (!user) throw unauthenticated();
    res.locals.apiUser = user;
    next();
  };
}

function queryString(req: Request, name: string): string | undefined {
  const v = req.query[name];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new LagerError('invalid_argument', `Query parameter ${name} must be given once.`);
  return v;
}

function optionalString(body: Record<string, unknown>, name: string): string | undefined {
  const v = body[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new LagerError('invalid_argument', `${name} must be a string.`);
  return v;
}

function bodyObject(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new LagerError('invalid_argument', 'Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

function deployInput(req: Request): { html: string; title?: string; note?: string; capabilities?: unknown } {
  if (typeof req.body === 'string') {
    const raw = queryString(req, 'capabilities');
    let capabilities: unknown;
    if (raw !== undefined) {
      try {
        capabilities = JSON.parse(raw);
      } catch {
        throw new LagerError('invalid_argument', 'Query parameter capabilities must be JSON.');
      }
    }
    return { html: req.body, title: queryString(req, 'title'), note: queryString(req, 'note'), capabilities };
  }
  if (!req.is('application/json')) {
    throw new LagerError('invalid_argument', 'Send the HTML as text/html or as JSON {html, title?, note?, capabilities?}.');
  }
  const body = bodyObject(req);
  if (typeof body.html !== 'string') throw new LagerError('invalid_argument', 'html must be a string.');
  return { html: body.html, title: optionalString(body, 'title'), note: optionalString(body, 'note'), capabilities: body.capabilities ?? undefined };
}

export const apiExtension: PlatformExtension = (router, core) => {
  const auth = requireApiUser(core);
  const sessionOnly = requireSessionOnly(core);
  const noStore: RequestHandler = (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };

  router.put('/api/apps/:slug', noStore, auth,
    express.text({ type: 'text/html', limit: MAX_HTML }), express.json({ limit: MAX_JSON }),
    (req, res) => {
      const input = deployInput(req);
      const result = core.apps.deploy({
        slug: req.params.slug as string, html: input.html, title: input.title, note: input.note,
        capabilities: checkCapabilities(input.capabilities), userId: userOf(res).id,
      });
      res.json(describeDeploy(core, result));
    });

  router.get('/api/apps', noStore, auth, (_req, res) => {
    res.json({ apps: core.apps.listApps(userOf(res).id).map((a) => appSummary(core, a)) });
  });

  router.get('/api/apps/:slug', noStore, auth, (req, res) => {
    res.json(appDetail(core, ownedApp(core, userOf(res), req.params.slug as string)));
  });

  router.post('/api/instances/:slug/activate', noStore, auth, express.json({ limit: '10kb' }), (req, res) => {
    const user = userOf(res);
    const version = bodyObject(req).version;
    if (typeof version !== 'number' || !Number.isInteger(version)) throw new LagerError('invalid_argument', 'version must be an integer.');
    const inst = ownedInstance(core, user, req.params.slug as string);
    res.json(instanceJson(core, core.apps.activate(inst.id, version, user.id)));
  });

  router.post('/api/tokens', noStore, sessionOnly, express.json({ limit: '10kb' }), (req, res) => {
    const name = bodyObject(req).name;
    res.json(core.tokens.create(userOf(res).id, typeof name === 'string' ? name : ''));
  });

  router.get('/api/tokens', noStore, sessionOnly, (_req, res) => {
    res.json({ tokens: core.tokens.list(userOf(res).id) });
  });

  router.delete('/api/tokens/:id', noStore, sessionOnly, (req, res) => {
    if (!core.tokens.revoke(userOf(res).id, req.params.id as string)) throw new LagerError('not_found', 'Token not found.');
    res.json({ ok: true });
  });
};
