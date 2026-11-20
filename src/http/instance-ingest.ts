import express from 'express';
import type { Request, Response } from 'express';
import type { Core } from '../core.js';
import { assertDocData } from '../data/paths.js';
import { newDocId } from '../data/store.js';
import { LagerError } from '../errors.js';
import type { Instance } from '../platform/apps.js';
import { ingestEndpoints, type IngestEndpoint } from '../platform/ingest.js';
import { addressKey } from './client-address.js';
import { discardBody, sendError } from './errors.js';
import type { Ctx } from './instance.js';

/** The fields the server writes into a received document; a client cannot set them. */
const SERVER_FIELDS = ['_receivedAt', '_visitor', '_country'] as const;
const COUNTRY_RE = /^[A-Za-z]{2}$/;
const MAX_USER_AGENT = 512;
/** Header values for the preflight and for a refused method. */
const ALLOWED_METHODS = ['POST', 'OPTIONS'].join(', ');
const TOKEN_REQUEST_HEADERS = ['Authorization', 'Content-Type'].join(', ');

/** A refusal with the status that tells a sender what to do about it; the body names the reason and nothing about the instance. */
function refuse(res: Response, status: number, error: LagerError): void {
  res.status(status).json({ error: { code: error.code, message: error.message } });
}

const NO_ENDPOINT = (): LagerError => new LagerError('not_found', 'No such endpoint.');
const WRONG_ORIGIN = (): LagerError => new LagerError('forbidden', 'This origin may not send here.');

/** What `Access-Control-Allow-Origin` says to a request from `origin`: the origin itself, `*`, or null when it is not listed. */
function allowedOrigin(origins: string[], origin: string | undefined): string | null {
  if (origin === undefined) return null;
  if (origins.includes('*')) return '*';
  return origins.includes(origin.toLowerCase()) ? origin : null;
}

function presentedToken(req: Request): unknown {
  const header = /^Bearer +(\S+)$/i.exec(req.get('Authorization') ?? '');
  // The query form is for senders that cannot set a header (many webhooks); the header wins when both are there.
  return header ? header[1] : req.query.key;
}

/**
 * Mounts `POST /_ingest/<name>`: a request from outside the instance appends one JSON document to the collection the endpoint
 * names, and that is all it can do. The answer to an accepted request is `202` without a body; nothing stored is ever sent back.
 *
 * The route is mounted before the instance's session is looked at and never reads a cookie: whoever sends is anonymous here,
 * so a page that makes a signed-in visitor's browser send cannot borrow what that visitor may do. Who may send is decided by
 * the declaration alone: browsers on the listed origins (`auth: "none"`), or whoever holds the endpoint's token.
 */
export function mountIngestEndpoints(router: express.Router, core: Core): void {
  router.all('/_ingest/:name', (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    const name = req.params.name;
    const instance = core.apps.getInstanceBySlug(res.locals.slug as string);
    const endpoint = instance && !instance.disabled && core.ingest.enabled
      ? ingestEndpoints(core.apps.getVersion(instance.appId, instance.activeVersion)?.capabilities).find((e) => e.name === name) : undefined;
    const stop = (status: number, error: LagerError, outcome?: 'refused' | 'limited'): void => {
      if (instance && endpoint && outcome) core.ingest.note(instance.id, endpoint.name, outcome);
      // The answer was decided without the body: what the client still sends is thrown away, so it gets the answer and not a reset.
      discardBody(req);
      refuse(res, status, error);
    };
    // An endpoint that is switched off answers like one that does not exist.
    if (!instance || !endpoint) { stop(404, NO_ENDPOINT()); return; }
    if (core.ingest.isOff(instance.id, endpoint.name)) { stop(404, NO_ENDPOINT(), 'refused'); return; }

    // The declared websites, and on an endpoint with `managedOrigins` those the instance's managers added.
    const origins = core.ingest.originsFor(instance.id, endpoint);
    const cors = allowedOrigin(origins, req.get('Origin'));
    if (origins.length > 0 || endpoint.managedOrigins) res.vary('Origin');
    // Never with credentials: a browser that is asked to send cookies along gets its request refused by this very header.
    if (cors !== null) res.set('Access-Control-Allow-Origin', cors);
    if (req.method === 'OPTIONS') {
      if (cors === null) { stop(403, WRONG_ORIGIN()); return; }
      res.set({
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': endpoint.auth === 'token' ? TOKEN_REQUEST_HEADERS : 'Content-Type',
        'Access-Control-Max-Age': '600',
      }).status(204).end();
      return;
    }
    if (req.method !== 'POST') { res.set('Allow', ALLOWED_METHODS); stop(405, new LagerError('invalid_argument', 'Send the document with POST.')); return; }

    const address = addressKey(req.ip);
    if (endpoint.auth === 'none') {
      // Browsers state the origin of every cross-site POST. Other clients can make one up, so this keeps other websites out, not scripts.
      if (cors === null) { stop(403, WRONG_ORIGIN(), 'refused'); return; }
    } else {
      // The token is looked at first: wrong ones from an address must never keep out the right one from the same address
      // (senders share addresses). Only further wrong ones are turned away unanswered, to slow down guessing.
      if (!core.ingest.tokenValid(instance.id, endpoint.name, presentedToken(req))) {
        if (core.ingest.tokenGuessesExhausted(instance.id, address)) {
          res.set('Retry-After', '60');
          stop(429, new LagerError('rate_limited', 'Too many requests with a wrong token; try again later.'), 'limited');
          return;
        }
        core.ingest.noteBadToken(instance.id, address);
        res.set('WWW-Authenticate', 'Bearer');
        stop(401, new LagerError('unauthenticated', 'This endpoint needs its token: send "Authorization: Bearer <token>".'), 'refused');
        return;
      }
    }
    // A token tells its holder apart; without one the client address has to.
    if (!core.ingest.admit(instance.id, `endpoint:${endpoint.name}`, { address: endpoint.auth === 'none' ? address : undefined, perDay: endpoint.maxPerDay })) {
      res.set('Retry-After', '30');
      stop(429, new LagerError('rate_limited', 'Too many requests; try again later.'), 'limited');
      return;
    }
    const tooLarge = (): LagerError => new LagerError('invalid_argument', `The document is larger than ${endpoint.maxBytes} bytes.`);
    const declared = req.get('Content-Length');
    if (declared !== undefined && (!/^\d{1,15}$/.test(declared) || Number(declared) > endpoint.maxBytes)) { stop(413, tooLarge(), 'refused'); return; }

    // Any content type: a page that wants to spare its visitors the preflight sends JSON as text/plain. Compressed bodies are not unpacked.
    express.raw({ type: () => true, limit: endpoint.maxBytes, inflate: false })(req, res, (err?: unknown) => {
      if (err) {
        const type = (err as { type?: string }).type;
        if (type === 'entity.too.large') stop(413, tooLarge(), 'refused');
        else if (type === 'encoding.unsupported') stop(415, new LagerError('invalid_argument', 'Send the document uncompressed.'), 'refused');
        else stop(400, new LagerError('invalid_argument', 'The request could not be read.'), 'refused');
        return;
      }
      try {
        const body: unknown = req.body;
        let data: unknown;
        try { data = JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : ''); } catch { data = undefined; }
        if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new LagerError('invalid_argument', 'Send one JSON object.');
        assertDocData(data);
        for (const field of SERVER_FIELDS) delete data[field];
        data._receivedAt = new Date().toISOString();
        // The address is used for this hash and for the limits above, and is never stored.
        if (endpoint.visitor) data._visitor = core.ingest.visitorId(instance.id, address, (req.get('User-Agent') ?? '').slice(0, MAX_USER_AGENT));
        const country = endpoint.country && core.ingest.countryHeader ? req.get(core.ingest.countryHeader) : undefined;
        if (country !== undefined && COUNTRY_RE.test(country)) data._country = country.toUpperCase();
        core.data.ingest(instance.id, `${endpoint.collection}/${newDocId()}`, data, { by: null, rotate: endpoint.onFull === 'rotate' });
        core.ingest.note(instance.id, endpoint.name, 'accepted');
        res.status(202).end();
      } catch (e) {
        // Anything that is not a refusal of this request is the server's own failure: logged, and answered as one.
        if (!(e instanceof LagerError)) sendError(res, e);
        else stop(e.code === 'quota_exceeded' ? 507 : 400, e, 'refused');
      }
    });
  });
}

/** One endpoint as the page sees it; the token only for the people who manage the instance. */
function endpointInfo(core: Core, instance: Instance, e: IngestEndpoint, manages: boolean): Record<string, unknown> {
  return {
    name: e.name, path: `/_ingest/${e.name}`, collection: e.collection, auth: e.auth,
    origins: core.ingest.originsFor(instance.id, e), managedOrigins: e.managedOrigins,
    instanceOrigins: e.managedOrigins ? core.ingest.instanceOrigins(instance.id, e.name) : [], maxBytes: e.maxBytes,
    enabled: core.ingest.enabled && !core.ingest.isOff(instance.id, e.name),
    token: manages && e.auth === 'token' ? core.ingest.token(instance.id, e.name) : null,
  };
}

/**
 * Mounts `GET /__lager/ingest`, what `lager.use("ingest")` shows the page: the endpoints of the active version and whether each
 * is switched on. The token of an endpoint goes only to the people who manage the instance.
 *
 * And `PUT /__lager/ingest/<name>/origins`, with which the people who manage the instance replace the websites they added to an
 * endpoint that declares `managedOrigins: true` (`ingest.setOrigins`). Everyone else is refused, as is every endpoint whose
 * websites the app fixes.
 */
export function mountIngestInfo(router: express.Router, core: Core, ctxOf: (res: Response) => Ctx, requireAccess: (ctx: Ctx) => void): void {
  const declaredOrRefuse = (ctx: Ctx): void => {
    if (ctx.caps.ingest === undefined || ctx.caps.ingest === null || typeof ctx.caps.ingest !== 'object') {
      throw new LagerError('not_found', 'This app does not receive data from outside.');
    }
  };
  const manages = (ctx: Ctx): boolean => ctx.viewer.level === 'admin' || ctx.viewer.level === 'owner';

  router.get('/__lager/ingest', (_req, res) => {
    const ctx = ctxOf(res);
    requireAccess(ctx);
    declaredOrRefuse(ctx);
    res.set('Cache-Control', 'no-store').json({
      endpoints: ingestEndpoints(ctx.caps).map((e) => endpointInfo(core, ctx.instance, e, manages(ctx))),
    });
  });

  router.put('/__lager/ingest/:name/origins', express.json({ limit: '16kb' }), (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.get('X-Lager-Request') !== '1') throw new LagerError('forbidden', 'Missing X-Lager-Request header.');
    const ctx = ctxOf(res);
    requireAccess(ctx);
    declaredOrRefuse(ctx);
    if (!manages(ctx)) throw new LagerError('forbidden', 'Only the people who manage this instance may change where data may come from.');
    const endpoint = ingestEndpoints(ctx.caps).find((e) => e.name === req.params.name);
    if (!endpoint) throw new LagerError('not_found', 'No such endpoint.');
    const body: unknown = req.body;
    const list = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).origins : undefined;
    core.ingest.setOrigins(ctx.instance.id, endpoint, list);
    res.json({ endpoint: endpointInfo(core, ctx.instance, endpoint, true) });
  });
}
