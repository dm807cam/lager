import { once } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import express from 'express';
import type { Request, RequestHandler, Response } from 'express';
import type { Core } from '../core.js';
import { assertDocData, parseDocPath } from '../data/paths.js';
import { LagerError } from '../errors.js';
import {
  addDomainTo, appDetail, domainInstance, downloadableVersion, runAppCheck, appSummary, checkCapabilities, createInstanceFor, domainsJson, removeDomainFrom, deployWithIcon, updateAppLook, grantPrincipal, grantsJson, instanceJson, managedInstance, modelsJson, readableApp, setAppModel, transferAccess,
} from '../mcp/tools.js';
import type { GrantLevel } from '../platform/access.js';
import type { Instance, Visibility } from '../platform/apps.js';
import type { User } from '../platform/users.js';
import type { PlatformExtension } from './app.js';
import { discardBody, sendError } from './errors.js';
import { countSnapshotAction } from './snapshot-limit.js';
import { sessionUser } from './session.js';

const MAX_HTML = '16mb';
// JSON escaping inflates HTML; Apps.deploy enforces the 16 MiB limit on the HTML itself.
const MAX_JSON = '24mb';
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
/** A JSON array has to be held whole to be parsed, so it gets a smaller limit. */
const MAX_IMPORT_JSON_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_DOCS = 100_000;

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

interface DeployInput { html: string; title?: string; note?: string; capabilities?: unknown; description?: string; themeColor?: string; iconSvg?: string }

function deployInput(req: Request): DeployInput {
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
    return {
      html: req.body, title: queryString(req, 'title'), note: queryString(req, 'note'), capabilities,
      description: queryString(req, 'description'), themeColor: queryString(req, 'theme_color'),
    };
  }
  if (!req.is('application/json')) {
    throw new LagerError('invalid_argument', 'Send the HTML as text/html or as JSON {html, title?, note?, capabilities?}.');
  }
  const body = bodyObject(req);
  if (typeof body.html !== 'string') throw new LagerError('invalid_argument', 'html must be a string.');
  return {
    html: body.html, title: optionalString(body, 'title'), note: optionalString(body, 'note'), capabilities: body.capabilities ?? undefined,
    description: optionalString(body, 'description') ?? queryString(req, 'description'),
    themeColor: optionalString(body, 'theme_color') ?? queryString(req, 'theme_color'),
    iconSvg: optionalString(body, 'icon_svg'),
  };
}

/** Streams the instance's documents as NDJSON (one `{path,data}` per line), including the caller's own private area. */
export async function streamExport(core: Core, user: User, inst: Instance, res: Response): Promise<void> {
  const d = new Date();
  const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  res.status(200).set({
    'Content-Type': 'application/x-ndjson; charset=utf-8', 'Content-Disposition': `attachment; filename="${inst.slug}-${stamp}.ndjson"`,
    'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
  });
  const access = transferAccess(core, user, inst);
  let closed = false;
  // An aborted download never emits `drain`; racing it against `close` lets the generator end instead of hanging.
  const closeSignal = new Promise<void>((resolve) => { res.on('close', () => { closed = true; resolve(); }); });
  try {
    for (const doc of core.data.exportDocs(inst.id, { includePrivateOf: user.id, filter: access.readable })) {
      if (closed) return;
      if (!res.write(`${JSON.stringify(doc)}\n`)) await Promise.race([once(res, 'drain'), closeSignal]).catch(() => undefined);
    }
    res.end();
  } catch (e) {
    console.error(e);
    res.destroy();
  }
}

/** A version's HTML as a download; text/plain and nosniff keep it from ever rendering on the platform origin. */
export function sendVersionDownload(res: Response, slug: string, number: number, html: string): void {
  res.status(200).set({
    'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${slug}-v${number}.html"`,
    'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
  }).send(html);
}

/** Version number from a route parameter; anything but a positive integer is "not found". */
export function versionParam(value: unknown): number {
  const n = typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 1) throw new LagerError('not_found', 'Version not found.');
  return n;
}

type ImportDoc = { path: string; data: Record<string, unknown> };

function importEntry(value: unknown, where: string): ImportDoc {
  const v = value as { path?: unknown; data?: unknown } | null;
  if (v === null || typeof v !== 'object' || typeof v.path !== 'string' || v.data === null || typeof v.data !== 'object' || Array.isArray(v.data)) {
    throw new LagerError('invalid_argument', `${where} must be an object {path, data} with data an object.`);
  }
  return { path: v.path, data: v.data as Record<string, unknown> };
}

class ImportTooLarge extends Error {}

/** Longest NDJSON line: a document is at most 256 KiB, plus its path and the wrapper. */
const MAX_IMPORT_LINE = 300 * 1024;

/**
 * Reads the documents of an import body from the request stream: NDJSON (one `{path,data}` per line, validated line by line
 * while it arrives) or a JSON array. Bytes and documents are counted as they come; the first violation aborts the read.
 * `writable` is the caller's rule check (everything must be writable, else the whole import is refused).
 */
async function readImportDocs(req: Request, json: boolean, writable: (path: string) => boolean): Promise<ImportDoc[]> {
  const limit = json ? MAX_IMPORT_JSON_BYTES : MAX_IMPORT_BYTES;
  const tooMany = (): LagerError => new LagerError('invalid_argument', `At most ${MAX_IMPORT_DOCS} documents per import.`);
  const check = (value: unknown, where: string): ImportDoc => {
    const doc = importEntry(value, where);
    parseDocPath(doc.path);
    assertDocData(doc.data);
    if (!writable(doc.path)) throw new LagerError('forbidden', `You may not write "${doc.path}" (another user's private area or a rule of the app).`);
    return doc;
  };
  const decoder = new StringDecoder('utf8');
  const docs: ImportDoc[] = [];
  let bytes = 0;
  let buffered = '';
  let n = 0;
  const line = (text: string): void => {
    n++;
    if (text.trim() === '') return;
    if (docs.length >= MAX_IMPORT_DOCS) throw tooMany();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new LagerError('invalid_argument', `Line ${n} is not valid JSON.`); }
    docs.push(check(parsed, `Line ${n}`));
  };
  // destroyOnReturn: false, so a refusal can still be answered instead of the socket being torn down.
  for await (const chunk of req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
    bytes += chunk.length;
    if (bytes > limit) throw new ImportTooLarge();
    buffered += decoder.write(chunk);
    if (json) continue;
    let from = 0;
    for (let i = buffered.indexOf('\n', from); i >= 0; i = buffered.indexOf('\n', from)) {
      line(buffered.slice(from, i));
      from = i + 1;
    }
    buffered = buffered.slice(from);
    if (buffered.length > MAX_IMPORT_LINE) throw new LagerError('invalid_argument', `Line ${n + 1} is too long.`);
  }
  buffered += decoder.end();
  if (!json) {
    line(buffered);
    return docs;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(buffered); } catch { throw new LagerError('invalid_argument', 'The body is not valid JSON.'); }
  if (!Array.isArray(parsed)) throw new LagerError('invalid_argument', 'The JSON body must be an array of {path, data}.');
  if (parsed.length > MAX_IMPORT_DOCS) throw tooMany();
  return parsed.map((v, i) => check(v, `Entry ${i + 1}`));
}

export const apiExtension: PlatformExtension = (router, core) => {
  const auth = requireApiUser(core);
  const sessionOnly = requireSessionOnly(core);
  const noStore: RequestHandler = (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };

  router.put('/api/apps/:slug', noStore, auth,
    express.text({ type: 'text/html', limit: MAX_HTML }), express.json({ limit: MAX_JSON }),
    async (req, res) => {
      const input = deployInput(req);
      res.json(await deployWithIcon(core, userOf(res), {
        slug: req.params.slug as string, html: input.html, title: input.title, note: input.note,
        capabilities: checkCapabilities(input.capabilities), description: input.description, themeColor: input.themeColor, iconSvg: input.iconSvg,
      }));
    });

  /** The icon as `image/svg+xml`; the 64 KiB rule is enforced on the text, the body limit only leaves a margin. */
  router.put('/api/apps/:slug/icon', noStore, auth, express.text({ type: 'image/svg+xml', limit: '80kb' }), async (req, res) => {
    const user = userOf(res);
    if (typeof req.body !== 'string') throw new LagerError('invalid_argument', 'Send the icon as image/svg+xml.');
    res.json(await updateAppLook(core, user, readableApp(core, user, req.params.slug as string), { iconSvg: req.body }));
  });

  router.patch('/api/apps/:slug', noStore, auth, express.json({ limit: '10kb' }), async (req, res) => {
    const user = userOf(res);
    const body = bodyObject(req);
    const app = readableApp(core, user, req.params.slug as string);
    res.json(await updateAppLook(core, user, app, { description: optionalString(body, 'description'), themeColor: optionalString(body, 'theme_color') }));
  });

  router.put('/api/apps/:slug/model', noStore, auth, express.json({ limit: '10kb' }), (req, res) => {
    const user = userOf(res);
    const model = bodyObject(req).model;
    if (model !== null && typeof model !== 'string') throw new LagerError('invalid_argument', 'model must be a model name or null.');
    res.json(setAppModel(core, user, readableApp(core, user, req.params.slug as string), model));
  });

  router.get('/api/models', noStore, auth, (_req, res) => {
    res.json(modelsJson(core, userOf(res)));
  });

  router.get('/api/apps', noStore, auth, (_req, res) => {
    const user = userOf(res);
    res.json({ apps: core.access.appsOf(user).map((a) => appSummary(core, user, a)) });
  });

  router.get('/api/apps/:slug', noStore, auth, (req, res) => {
    const user = userOf(res);
    res.json(appDetail(core, user, readableApp(core, user, req.params.slug as string)));
  });

  router.post('/api/instances/:slug/activate', noStore, auth, express.json({ limit: '10kb' }), (req, res) => {
    const user = userOf(res);
    const version = bodyObject(req).version;
    if (typeof version !== 'number' || !Number.isInteger(version)) throw new LagerError('invalid_argument', 'version must be an integer.');
    const inst = managedInstance(core, user, req.params.slug as string);
    if (version !== inst.activeVersion) countSnapshotAction(core, inst.id);
    res.json(instanceJson(core, core.apps.activate(inst.id, version, user.id)));
  });

  router.post('/api/instances/:slug/auto-update', noStore, auth, express.json({ limit: '10kb' }), (req, res) => {
    const user = userOf(res);
    const on = bodyObject(req).on;
    if (typeof on !== 'boolean') throw new LagerError('invalid_argument', 'on must be true or false.');
    const inst = managedInstance(core, user, req.params.slug as string);
    res.json(instanceJson(core, core.apps.setAutoUpdate(inst.id, on, user.id)));
  });

  router.post('/api/instances/:slug/badge', noStore, auth, express.json({ limit: '10kb' }), (req, res) => {
    const user = userOf(res);
    const on = bodyObject(req).on;
    if (typeof on !== 'boolean') throw new LagerError('invalid_argument', 'on must be true or false.');
    const inst = managedInstance(core, user, req.params.slug as string);
    res.json(instanceJson(core, core.apps.setShowBadge(inst.id, on, user.id)));
  });

  router.get('/api/instances/:slug/grants', noStore, auth, (req, res) => {
    res.json(grantsJson(core, managedInstance(core, userOf(res), req.params.slug as string)));
  });

  router.put('/api/instances/:slug/grants', noStore, auth, express.json({ limit: '10kb' }), (req, res) => {
    const user = userOf(res);
    const body = bodyObject(req);
    const inst = managedInstance(core, user, req.params.slug as string);
    const who = grantPrincipal(core, { email: optionalString(body, 'email'), group: optionalString(body, 'group') });
    const level = optionalString(body, 'level');
    if (level === undefined) throw new LagerError('invalid_argument', 'level is required.');
    core.access.setGrant(inst, who.type, who.id, level as GrantLevel, user);
    res.json(grantsJson(core, inst));
  });

  router.delete('/api/instances/:slug/grants', noStore, auth, express.json({ limit: '10kb' }), (req, res) => {
    const user = userOf(res);
    const body = bodyObject(req);
    const inst = managedInstance(core, user, req.params.slug as string);
    const who = grantPrincipal(core, { email: optionalString(body, 'email'), group: optionalString(body, 'group') });
    core.access.removeGrant(inst, who.type, who.id, user);
    res.json(grantsJson(core, inst));
  });

  router.get('/api/instances/:slug/export', noStore, auth, (req, res, next) => {
    const user = userOf(res);
    streamExport(core, user, managedInstance(core, user, req.params.slug as string), res).catch(next);
  });

  const importing = new Set<string>();
  router.post('/api/instances/:slug/import', noStore, auth, async (req, res) => {
    const user = userOf(res);
    // Every refusal below happens before the body is read.
    const refuse = (e: unknown): void => { discardBody(req); sendError(res, e); };
    let inst: Instance;
    try {
      inst = managedInstance(core, user, req.params.slug as string);
      const json = Boolean(req.is('application/json'));
      if (!json && !req.is('application/x-ndjson')) throw new LagerError('invalid_argument', 'Send application/x-ndjson (one {path,data} per line) or a JSON array.');
      core.data.assertQuota(inst.id);
      const declared = Number(req.get('content-length'));
      if (Number.isFinite(declared) && declared > (json ? MAX_IMPORT_JSON_BYTES : MAX_IMPORT_BYTES)) throw new ImportTooLarge();
      if (importing.has(inst.id)) throw new LagerError('conflict', 'Another import into this instance is still running.');
    } catch (e) {
      if (e instanceof ImportTooLarge) { discardBody(req); res.status(413).json({ error: { code: 'invalid_argument', message: 'Request body too large.' } }); return; }
      refuse(e);
      return;
    }
    importing.add(inst.id);
    try {
      const json = Boolean(req.is('application/json'));
      const access = transferAccess(core, user, inst);
      const docs = await readImportDocs(req, json, access.writable);
      res.json(core.data.importDocs(inst.id, docs, user.id, { allowPrivateOf: user.id }));
    } catch (e) {
      discardBody(req);
      if (e instanceof ImportTooLarge) res.status(413).json({ error: { code: 'invalid_argument', message: 'Request body too large.' } });
      else sendError(res, e);
    } finally {
      importing.delete(inst.id);
    }
  });

  router.get('/api/apps/:slug/versions/:number', noStore, auth, (req, res) => {
    const slug = req.params.slug as string;
    const number = versionParam(req.params.number);
    sendVersionDownload(res, slug, number, downloadableVersion(core, userOf(res), slug, number).html);
  });

  router.post('/api/check', noStore, auth, express.json({ limit: MAX_JSON }), (req, res) => {
    const body = bodyObject(req);
    res.json(runAppCheck(userOf(res), body.html, body.capabilities));
  });

  router.get('/api/instances/:slug/domains', noStore, auth, (req, res) => {
    res.json({ domains: domainsJson(core, domainInstance(core, userOf(res), req.params.slug as string)) });
  });

  const domainHost = (req: Request): string => {
    const host = optionalString(bodyObject(req), 'host');
    if (host === undefined) throw new LagerError('invalid_argument', 'host is required.');
    return host;
  };

  router.put('/api/instances/:slug/domains', noStore, auth, express.json({ limit: '10kb' }), (req, res) => {
    res.json({ domains: domainsJson(core, addDomainTo(core, userOf(res), req.params.slug as string, domainHost(req))) });
  });

  router.delete('/api/instances/:slug/domains', noStore, auth, express.json({ limit: '10kb' }), (req, res) => {
    res.json({ domains: domainsJson(core, removeDomainFrom(core, userOf(res), req.params.slug as string, domainHost(req))) });
  });

  router.post('/api/apps/:slug/instances', noStore, auth, express.json({ limit: '10kb' }), (req, res) => {
    const user = userOf(res);
    const body = bodyObject(req);
    const slug = optionalString(body, 'slug');
    if (slug === undefined) throw new LagerError('invalid_argument', 'slug is required.');
    const inst = createInstanceFor(core, user, {
      app: req.params.slug as string, slug, ownerEmail: optionalString(body, 'ownerEmail'),
      visibility: optionalString(body, 'visibility') as Visibility | undefined,
    });
    res.json(instanceJson(core, inst));
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
