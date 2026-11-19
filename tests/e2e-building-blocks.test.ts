import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { createCore } from '../src/core.js';
import { apiExtension } from '../src/http/api.js';
import { createHttpApp } from '../src/http/app.js';
import { adminExtension } from '../src/http/admin.js';
import { authExtension } from '../src/http/auth.js';
import { dashboardExtension } from '../src/http/dashboard.js';
import { manageExtension } from '../src/http/manage.js';
import { mcpExtension } from '../src/mcp/http.js';
import { MemoryMailer } from '../src/platform/mail.js';

let cleanup: (() => void) | undefined;
const streams: http.ClientRequest[] = [];
afterEach(() => { for (const r of streams.splice(0)) r.destroy(); cleanup?.(); cleanup = undefined; });

interface Res { status: number; headers: http.IncomingHttpHeaders; bytes: Buffer; body: string }
interface Opts { headers?: Record<string, string>; body?: string | Buffer }
interface SseEvent { event: string; data: any }
interface Stream { status: number; hello: any; next(event: string): Promise<any> }

const PLATFORM = 'lager.localhost:8080';
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const API = { ...JSON_HEADERS, 'X-Lager-Request': '1' };
/** A real 1x1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-e2e-blocks-'));
  const config: Config = {
    dataDir, port: 0, defaultLocale: 'en', publicUrl: new URL(`http://${PLATFORM}`), appsDomain: 'apps.localhost',
    adminEmail: 'admin@x.y', adminPassword: 'admin-password-1', secret: 'e2e-blocks-secret', snapshotKeep: 20, trustProxy: false,
    instanceQuotaBytes: 50 * 1024 * 1024,
  };
  const core = createCore(config, { mailer: new MemoryMailer() });
  const server = http.createServer(createHttpApp(core, [authExtension, adminExtension, apiExtension, mcpExtension, dashboardExtension, manageExtension]));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanup = () => { server.closeAllConnections(); server.close(); core.close(); };
  const port = (server.address() as AddressInfo).port;
  /** Plain http request with an explicit Host header, so the host routing is exercised on a real socket. */
  const call = (host: string, method: string, url: string, opts: Opts = {}): Promise<Res> =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { Host: host, ...opts.headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => { const bytes = Buffer.concat(chunks); resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes, body: bytes.toString('utf8') }); });
      });
      req.on('error', reject);
      req.end(opts.body);
    });
  /** Opens an SSE stream and collects its events; `next` waits for the next event of a name. */
  const openStream = (host: string, cookie: string, url: string): Promise<Stream> =>
    new Promise((resolve, reject) => {
      const events: SseEvent[] = [];
      const waiters: Array<() => void> = [];
      let buf = '';
      const req = http.get({ host: '127.0.0.1', port, path: url, headers: { Host: host, Cookie: cookie } }, (res) => {
        if (res.statusCode !== 200) { res.resume(); resolve({ status: res.statusCode ?? 0, hello: null, next: () => Promise.reject(new Error('no stream')) }); return; }
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buf += chunk;
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const ev = /^event: (.*)$/m.exec(block)?.[1]; const data = /^data: (.*)$/m.exec(block)?.[1];
            if (ev) events.push({ event: ev, data: data === undefined ? undefined : JSON.parse(data) });
          }
          waiters.splice(0).forEach((w) => w());
        });
        const s: Stream = {
          status: 200, hello: null,
          async next(event) {
            const deadline = Date.now() + 3000;
            for (;;) {
              const i = events.findIndex((e) => e.event === event);
              if (i >= 0) return events.splice(i, 1)[0].data;
              if (Date.now() > deadline) throw new Error(`no ${event} event within 3s; got ${JSON.stringify(events)}`);
              await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 50); });
            }
          },
        };
        void s.next('hello').then((hello) => { s.hello = hello; resolve(s); }, reject);
      });
      streams.push(req);
      req.on('error', (e) => { if (!(e as NodeJS.ErrnoException).code?.includes('ECONNRESET')) reject(e); });
    });
  return { call, openStream };
}

const cookiePair = (res: Res, name: string): string => {
  const raw = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(name + '='));
  if (!raw) throw new Error(`no ${name} cookie (status ${res.status})`);
  return raw.split(';')[0];
};
const form = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();
const csrfIn = (html: string): string => {
  const m = /name="csrf" value="([^"]+)"/.exec(html);
  if (!m) throw new Error('no csrf field in page');
  return m[1];
};
const pathOf = (url: string): string => { const u = new URL(url); return u.pathname + u.search; };
const parse = (res: Res): any => JSON.parse(res.body);
const lines = (res: Res): Array<{ path: string; data: unknown }> =>
  res.body.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as { path: string; data: unknown }).sort((a, b) => a.path.localeCompare(b.path));

describe('building blocks end to end', () => {
  it('assets, room, self-publish, custom domain, export/import', async () => {
    const { call, openStream } = await boot();
    const hostOf = (slug: string): string => `${slug}.apps.localhost:8080`;
    const board = fs.readFileSync(new URL('../examples/board.html', import.meta.url), 'utf8');
    const BOARD_CAPS = { db: {}, user: {}, assets: {}, room: {}, downloads: {} };

    const login = async (email: string, password: string): Promise<string> => {
      const res = await call(PLATFORM, 'POST', '/login', { headers: FORM, body: form({ email, password }) });
      expect(res.status).toBe(302);
      return cookiePair(res, 'lager_session');
    };
    /** Invites an account with a role through the administration page and registers it through the link; returns its session. */
    const adminSession = await login('admin@x.y', 'admin-password-1');
    const adminCsrf = csrfIn((await call(PLATFORM, 'GET', '/admin/invites', { headers: { Cookie: adminSession } })).body);
    const register = async (role: string, name: string, email: string, password: string): Promise<string> => {
      const inv = await call(PLATFORM, 'POST', '/admin/invites', { headers: { ...FORM, Cookie: adminSession }, body: form({ csrf: adminCsrf, role, email }) });
      expect(inv.status).toBe(200);
      const link = /(https?:\/\/[^\s<]*\/register\?invite=[\w-]+)/.exec(inv.body)![1];
      const reg = await call(PLATFORM, 'POST', '/register', { headers: FORM, body: form({ invite: new URL(link).searchParams.get('invite')!, name, email, password }) });
      expect(reg.status).toBe(302);
      return cookiePair(reg, 'lager_session');
    };
    /** Platform handshake for an instance on any host it answers on; returns the instance cookie. */
    const open = async (session: string, host: string): Promise<string> => {
      const start = await call(host, 'GET', '/');
      expect(start.status).toBe(302);
      const hs = await call(PLATFORM, 'GET', pathOf(start.headers.location!), { headers: { Cookie: session } });
      expect(hs.status).toBe(302);
      const cb = new URL(hs.headers.location!);
      expect(cb.host).toBe(host);
      return cookiePair(await call(cb.host, 'GET', cb.pathname + cb.search, { headers: { Cookie: cookiePair(start, 'lager_nonce') } }), 'lager_inst');
    };
    const token = async (session: string): Promise<Record<string, string>> => {
      const res = await call(PLATFORM, 'POST', '/api/tokens', { headers: { ...API, Cookie: session }, body: JSON.stringify({ name: 'e2e' }) });
      expect(res.status).toBe(200);
      return { Authorization: `Bearer ${parse(res).token}` };
    };

    const pSession = await register('publisher', 'Petra', 'p@x.y', 'petra-password-1');
    const uSession = await register('user', 'Uwe', 'u@x.y', 'uwe-password-12');
    const petra = await token(pSession);
    const deploy = (slug: string, html: string, caps: unknown, bearer: Record<string, string> = petra): Promise<Res> =>
      call(PLATFORM, 'PUT', `/api/apps/${slug}?capabilities=${encodeURIComponent(JSON.stringify(caps))}`, { headers: { ...bearer, 'Content-Type': 'text/html' }, body: html });
    const grant = (slug: string, email: string, level: string): Promise<Res> =>
      call(PLATFORM, 'PUT', `/api/instances/${slug}/grants`, { headers: { ...petra, ...JSON_HEADERS }, body: JSON.stringify({ email, level }) });

    // 1. The publisher deploys the example with every building block it uses declared: no warnings.
    const d1 = await deploy('board', board, BOARD_CAPS);
    expect(d1.status).toBe(200);
    expect(parse(d1)).toMatchObject({ app: 'board', version: 1, warnings: ['No icon supplied; a generated one is used. Pass icon_svg to set your own.'], pinned: [] });
    const owner = await open(pSession, hostOf('board'));
    const session = parse(await call(hostOf('board'), 'GET', '/__lager/session', { headers: { Cookie: owner } }));
    expect(session.capabilities).toEqual(BOARD_CAPS);
    expect(session.viewer.level).toBe('owner');
    const served = await call(hostOf('board'), 'GET', '/', { headers: { Cookie: owner } });
    expect(served.status).toBe(200);
    expect(served.body).toContain('Pin board');

    // 2. The owner uploads a PNG and gets the same bytes back; HTML is refused as an upload.
    const up = await call(hostOf('board'), 'POST', '/__lager/assets', { headers: { 'Content-Type': 'image/png', 'X-Lager-Request': '1', Cookie: owner }, body: PNG });
    expect(up.status).toBe(201);
    const asset = parse(up) as { id: string; url: string; sizeBytes: number; contentType: string };
    expect(asset).toMatchObject({ url: `/_blob/${asset.id}`, sizeBytes: PNG.length, contentType: 'image/png' });
    const blob = await call(hostOf('board'), 'GET', asset.url, { headers: { Cookie: owner } });
    expect(blob.status).toBe(200);
    expect(blob.headers['content-type']).toBe('image/png');
    expect(blob.headers['x-content-type-options']).toBe('nosniff');
    expect(blob.bytes.equals(PNG)).toBe(true);
    expect((await call(hostOf('board'), 'GET', asset.url)).status).toBe(401);
    const html = await call(hostOf('board'), 'POST', '/__lager/assets', { headers: { 'Content-Type': 'text/html', 'X-Lager-Request': '1', Cookie: owner }, body: '<script>alert(1)</script>' });
    expect(html.status).toBe(400);
    expect(parse(html).error.reason).toBe('unsupported_type');

    // 3. Owner and a granted "interact" user see each other's presence, and a message from the owner reaches the user.
    expect((await grant('board', 'u@x.y', 'interact')).status).toBe(200);
    const guest = await open(uSession, hostOf('board'));
    const roomPost = (cookie: string, body: unknown): Promise<Res> =>
      call(hostOf('board'), 'POST', '/__lager/room', { headers: { ...API, Cookie: cookie }, body: JSON.stringify(body) });
    const ownerStream = await openStream(hostOf('board'), owner, '/__lager/room/events?room=pins');
    const guestStream = await openStream(hostOf('board'), guest, '/__lager/room/events?room=pins');
    expect(ownerStream.hello.peers).toHaveLength(1);
    expect(guestStream.hello.peers).toHaveLength(2);
    // The owner's stream hears the user arrive.
    expect((await ownerStream.next('peers')).joined[0].peer).toBe(guestStream.hello.peer);
    expect((await roomPost(owner, { room: 'pins', peer: ownerStream.hello.peer, op: 'presence', patch: { name: 'Petra' } })).status).toBe(200);
    expect((await roomPost(guest, { room: 'pins', peer: guestStream.hello.peer, op: 'presence', patch: { name: 'Uwe' } })).status).toBe(200);
    // Every member also hears its own update, so wait for the one about the other peer.
    const updateOf = async (stream: Stream, peer: string): Promise<any> => {
      for (;;) { const u = (await stream.next('peers')).updated.find((p: { peer: string }) => p.peer === peer); if (u) return u; }
    };
    expect(await updateOf(guestStream, ownerStream.hello.peer)).toMatchObject({ presence: { name: 'Petra' } });
    expect(await updateOf(ownerStream, guestStream.hello.peer)).toMatchObject({ presence: { name: 'Uwe' } });
    // Only editors emit on a topic the app did not open; the owner's message reaches the user, the user's does not go out.
    expect((await roomPost(owner, { room: 'pins', peer: ownerStream.hello.peer, op: 'emit', topic: 'pin', data: { text: 'neu' } })).status).toBe(200);
    expect(await guestStream.next('message')).toMatchObject({ topic: 'pin', data: { text: 'neu' }, from: { peer: ownerStream.hello.peer } });
    expect((await roomPost(guest, { room: 'pins', peer: guestStream.hello.peer, op: 'emit', topic: 'pin', data: {} })).status).toBe(403);
    // A viewer may hold at most 8 streams on an instance: seven more succeed (this is the owner's second to eighth), the ninth is refused.
    for (let i = 0; i < 7; i++) expect((await openStream(hostOf('board'), owner, '/__lager/room/events?room=pins')).status).toBe(200);
    expect((await openStream(hostOf('board'), owner, '/__lager/room/events?room=pins')).status).toBe(429);

    // 4. A page that declares `page` saves itself; a later redeploy reports the instance as pinned and leaves the saved page alone.
    const shell = '<!doctype html><html><body><p>Version eins</p></body></html>';
    expect((await deploy('page', shell, { page: {} })).status).toBe(200);
    const pageOwner = await open(pSession, hostOf('page'));
    const save = (cookie: string, body: unknown): Promise<Res> =>
      call(hostOf('page'), 'POST', '/__lager/page', { headers: { ...API, Cookie: cookie }, body: JSON.stringify(body) });
    expect((await save(pageOwner, { html: '<p>kein Doctype</p>', baseVersion: 1 })).status).toBe(400);
    const saved = await save(pageOwner, { html: shell.replace('Version eins', 'Selbst gespeichert'), baseVersion: 1 });
    expect(saved.status).toBe(200);
    expect(parse(saved)).toEqual({ version: '2' });
    expect((await call(hostOf('page'), 'GET', '/', { headers: { Cookie: pageOwner } })).body).toContain('Selbst gespeichert');
    expect((await save(pageOwner, { html: shell, baseVersion: 1 })).status).toBe(409);
    const redeploy = await deploy('page', shell.replace('Version eins', 'Neu deployt'), { page: {} });
    expect(redeploy.status).toBe(200);
    expect(parse(redeploy)).toMatchObject({ createdVersion: true, pinned: ['page'] });
    expect(parse(redeploy).warnings.join(' ')).toContain('page');
    expect((await call(hostOf('page'), 'GET', '/', { headers: { Cookie: pageOwner } })).body).toContain('Selbst gespeichert');

    // 5. Only an administrator who manages the instance attaches a domain; the instance then answers on that host after its own handshake.
    const CUSTOM = 'board.example.test';
    const put = (bearer: Record<string, string>, host: string): Promise<Res> =>
      call(PLATFORM, 'PUT', '/api/instances/board/domains', { headers: { ...bearer, ...JSON_HEADERS }, body: JSON.stringify({ host }) });
    expect((await put(petra, CUSTOM)).status).toBe(403);
    expect((await grant('board', 'admin@x.y', 'admin')).status).toBe(200);
    const adminBearer = await token(adminSession);
    expect((await put(adminBearer, 'board.apps.localhost')).status).toBe(400);
    const attached = await put(adminBearer, CUSTOM);
    expect(attached.status).toBe(200);
    expect(parse(attached).domains.map((d: { host: string }) => d.host)).toEqual([CUSTOM]);
    // Without a session the custom host sends the visitor to the platform, naming the host it came in on.
    const customStart = await call(CUSTOM, 'GET', '/');
    expect(customStart.status).toBe(302);
    expect(new URL(customStart.headers.location!).searchParams.get('host')).toBe(CUSTOM);
    const customCookie = await open(pSession, `${CUSTOM}:8080`);
    const customPage = await call(CUSTOM, 'GET', '/', { headers: { Cookie: customCookie } });
    expect(customPage.status).toBe(200);
    expect(customPage.body).toContain('Pin board');
    // A host nobody attached stays unknown, and the cookie of the custom host is not valid for another instance.
    expect((await call('other.example.test', 'GET', '/')).status).toBe(404);
    expect((await call(hostOf('page'), 'GET', '/__lager/session', { headers: { Cookie: customCookie } })).status).toBe(401);

    // 6. Export the documents, import them into a new instance, and download version 1 as an attachment.
    for (const [id, text] of [['c1', 'Milch'], ['c2', 'Brot']]) {
      const set = await call(hostOf('board'), 'POST', '/__lager/db', { headers: { ...API, Cookie: owner }, body: JSON.stringify({ op: 'set', path: `cards/${id}`, data: { text, image: asset.url, createdAt: 1 } }) });
      expect(set.status).toBe(200);
    }
    const exported = await call(PLATFORM, 'GET', '/api/instances/board/export', { headers: petra });
    expect(exported.status).toBe(200);
    expect(exported.headers['content-disposition']).toMatch(/^attachment; filename="board-\d{8}\.ndjson"$/);
    expect(lines(exported).map((l) => l.path)).toEqual(['cards/c1', 'cards/c2']);
    const created = await call(PLATFORM, 'POST', '/api/apps/board/instances', { headers: { ...petra, ...JSON_HEADERS }, body: JSON.stringify({ slug: 'board-2' }) });
    expect(created.status).toBe(200);
    const imported = await call(PLATFORM, 'POST', '/api/instances/board-2/import', { headers: { ...petra, 'Content-Type': 'application/x-ndjson' }, body: exported.body });
    expect(imported.status).toBe(200);
    const again = await call(PLATFORM, 'GET', '/api/instances/board-2/export', { headers: petra });
    expect(lines(again)).toEqual(lines(exported));
    // The uploaded picture does not move with the documents: the new instance does not have the file.
    const owner2 = await open(pSession, hostOf('board-2'));
    expect((await call(hostOf('board-2'), 'GET', asset.url, { headers: { Cookie: owner2 } })).status).toBe(404);

    const v1 = await call(PLATFORM, 'GET', '/api/apps/board/versions/1', { headers: petra });
    expect(v1.status).toBe(200);
    expect(v1.headers['content-disposition']).toBe('attachment; filename="board-v1.html"');
    expect(v1.headers['content-type']).toContain('text/plain');
    expect(v1.headers['x-content-type-options']).toBe('nosniff');
    expect(v1.body).toBe(board);
  });
});
