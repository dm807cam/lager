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
afterEach(() => { cleanup?.(); cleanup = undefined; });

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string }
interface Opts { headers?: Record<string, string>; body?: string }

const PLATFORM = 'lager.localhost:8080';
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const API = { ...JSON_HEADERS, 'X-Lager-Request': '1' };

async function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-e2e-multi-'));
  const config: Config = {
    dataDir, port: 0, publicUrl: new URL(`http://${PLATFORM}`), appsDomain: 'apps.localhost',
    adminEmail: 'admin@x.y', adminPassword: 'admin-password-1', secret: 'e2e-multi-secret', snapshotKeep: 20, trustProxy: false,
    instanceQuotaBytes: 50 * 1024 * 1024,
  };
  const mailer = new MemoryMailer();
  const core = createCore(config, { mailer });
  const server = http.createServer(createHttpApp(core, [authExtension, adminExtension, apiExtension, mcpExtension, dashboardExtension, manageExtension]));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanup = () => { server.closeAllConnections(); server.close(); core.close(); };
  const port = (server.address() as AddressInfo).port;
  // Plain http request with an explicit Host header, so the host routing is exercised on a real socket.
  const call = (host: string, method: string, url: string, opts: Opts = {}): Promise<Res> =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { Host: host, ...opts.headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end(opts.body);
    });
  return { mailer, call };
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

type Call = (host: string, method: string, url: string, opts?: Opts) => Promise<Res>;

describe('multi-user end to end', () => {
  it('invite, register, share, separate instances, revoke', async () => {
    const { mailer, call } = await boot();
    const hostOf = (slug: string): string => `${slug}.apps.localhost:8080`;
    const html = fs.readFileSync(new URL('../examples/notes.html', import.meta.url), 'utf8');

    const login = async (email: string, password: string): Promise<string> => {
      const res = await call(PLATFORM, 'POST', '/login', { headers: FORM, body: form({ email, password }) });
      expect(res.status).toBe(302);
      return cookiePair(res, 'lager_session');
    };
    /** The only place that knows how a verification link signs the browser in; returns the platform session cookie. */
    const verifyEmail = async (link: string): Promise<string> => {
      const res = await call(PLATFORM, 'GET', pathOf(link));
      expect(res.status).toBe(302);
      return cookiePair(res, 'lager_session');
    };
    /** Platform handshake for an instance; returns the instance cookie, or the failing platform response. */
    const openInstance = async (session: string, slug: string): Promise<{ cookie: string } | { denied: Res }> => {
      const host = hostOf(slug);
      const start = await call(host, 'GET', '/');
      if (start.status !== 302) return { denied: start };
      const hs = await call(PLATFORM, 'GET', pathOf(start.headers.location!), { headers: { Cookie: session } });
      if (hs.status !== 302) return { denied: hs };
      const cb = new URL(hs.headers.location!);
      expect(cb.host).toBe(host);
      const cbRes = await call(host, 'GET', cb.pathname + cb.search);
      return { cookie: cookiePair(cbRes, 'lager_inst') };
    };
    const mustOpen = async (session: string, slug: string): Promise<string> => {
      const r = await openInstance(session, slug);
      if (!('cookie' in r)) throw new Error(`could not open ${slug}: ${r.denied.status}`);
      return r.cookie;
    };
    const db = (slug: string, cookie: string, body: unknown): Promise<Res> =>
      call(hostOf(slug), 'POST', '/__lager/db', { headers: { ...API, Cookie: cookie }, body: JSON.stringify(body) });
    const docs = async (slug: string, cookie: string): Promise<Array<{ path: string }>> =>
      (JSON.parse((await db(slug, cookie, { op: 'query', path: 'notes' })).body) as { docs: Array<{ path: string }> }).docs;
    const adminPost = (session: string, csrf: string, url: string, fields: Record<string, string>): Promise<Res> =>
      call(PLATFORM, 'POST', url, { headers: { ...FORM, Cookie: session }, body: form({ csrf, ...fields }) });
    const home = (call2: Call, session: string) => call2(PLATFORM, 'GET', '/', { headers: { Cookie: session } });

    // 1. The administrator invites a publisher; the publisher registers through the link and is signed in at once.
    const adminSession = await login('admin@x.y', 'admin-password-1');
    const adminCsrf = csrfIn((await call(PLATFORM, 'GET', '/admin/invites', { headers: { Cookie: adminSession } })).body);
    const inviteRes = await adminPost(adminSession, adminCsrf, '/admin/invites', { role: 'publisher' });
    expect(inviteRes.status).toBe(200);
    const inviteLink = /(https?:\/\/[^\s<]*\/register\?invite=[\w-]+)/.exec(inviteRes.body)?.[1];
    expect(inviteLink).toBeDefined();
    const regForm = await call(PLATFORM, 'GET', pathOf(inviteLink!));
    expect(regForm.status).toBe(200);
    const reg = await call(PLATFORM, 'POST', '/register', {
      headers: FORM, body: form({ invite: new URL(inviteLink!).searchParams.get('invite')!, name: 'Petra', email: 'p@x.y', password: 'petra-password-1' }),
    });
    expect(reg.status).toBe(302);
    const pSession = cookiePair(reg, 'lager_session');
    expect((await home(call, pSession)).status).toBe(200);

    // 2. A user registers openly, gets a verification mail and is signed in by the link.
    const uReg = await call(PLATFORM, 'POST', '/register', {
      headers: FORM, body: form({ name: 'Uwe', email: 'u@x.y', password: 'uwe-password-12' }),
    });
    expect(uReg.status).toBe(200);
    const mail = mailer.sent.filter((m) => m.to === 'u@x.y').at(-1);
    expect(mail).toBeDefined();
    const verifyLink = /https?:\/\/\S+\/verify\?token=\S+/.exec(mail!.text)![0];
    const uSession = await verifyEmail(verifyLink);
    expect((await home(call, uSession)).status).toBe(200);
    // The user role cannot deploy.
    const uHome = (await home(call, uSession)).body;
    expect(uHome).not.toContain('Claude verbinden');

    // 3. The publisher creates an API token over HTTP and deploys the example as "notes".
    const tokenRes = await call(PLATFORM, 'POST', '/api/tokens', { headers: { ...API, Cookie: pSession }, body: JSON.stringify({ name: 'e2e' }) });
    expect(tokenRes.status).toBe(200);
    const bearer = { Authorization: `Bearer ${(JSON.parse(tokenRes.body) as { token: string }).token}` };
    const deploy = await call(PLATFORM, 'PUT', '/api/apps/notes?title=Notizen&capabilities=' + encodeURIComponent('{"db":{},"user":{}}'),
      { headers: { ...bearer, 'Content-Type': 'text/html' }, body: html });
    expect(deploy.status).toBe(200);
    expect(new URL((JSON.parse(deploy.body) as { urls: string[] }).urls[0]).host).toBe(hostOf('notes'));
    const uDeploy = await call(PLATFORM, 'PUT', '/api/apps/other', { headers: { ...API, Cookie: uSession, 'Content-Type': 'text/html' }, body: html });
    expect(uDeploy.status).toBe(403);

    // The owner stores a document.
    const pNotes = await mustOpen(pSession, 'notes');
    expect((await db('notes', pNotes, { op: 'set', path: 'notes/n1', data: { text: 'von Petra' } })).status).toBe(200);

    // 4. The private instance is closed to the user: the handshake is refused and no cookie is issued.
    const closed = await openInstance(uSession, 'notes');
    expect('denied' in closed && closed.denied.status).toBe(403);
    const anonDb = await db('notes', 'lager_inst=', { op: 'query', path: 'notes' });
    expect(anonDb.status).toBe(401);

    // 5. Grant "view": the user gets the page and reads the owner's document, but cannot write.
    const grant = (level: string): Promise<Res> => call(PLATFORM, 'PUT', '/api/instances/notes/grants',
      { headers: { ...bearer, ...JSON_HEADERS }, body: JSON.stringify({ email: 'u@x.y', level }) });
    expect((await grant('view')).status).toBe(200);
    const uNotes = await mustOpen(uSession, 'notes');
    const page = await call(hostOf('notes'), 'GET', '/', { headers: { Cookie: uNotes } });
    expect(page.status).toBe(200);
    expect(page.body).toContain('id="notes"');
    expect((await docs('notes', uNotes)).map((d) => d.path)).toContain('notes/n1');
    expect((await db('notes', uNotes, { op: 'set', path: 'notes/n1', data: { text: 'manipuliert' } })).status).toBe(403);

    // 6. Raise to "interact": the write works and the owner sees the shared document.
    expect((await grant('interact')).status).toBe(200);
    expect((await db('notes', uNotes, { op: 'set', path: 'notes/u1', data: { text: 'von Uwe' } })).status).toBe(200);
    expect((await docs('notes', pNotes)).map((d) => d.path).sort()).toEqual(['notes/n1', 'notes/u1']);

    // 7. Self-service: the owner opens the app to all users, the user creates an own instance with separate data.
    const pCsrf = csrfIn((await home(call, pSession)).body);
    const selfOn = await adminPost(pSession, pCsrf, '/ui/apps/notes/self-instances', { mode: 'users' });
    expect(selfOn.status).toBe(302);
    const uCsrf = csrfIn((await home(call, uSession)).body);
    expect((await home(call, uSession)).body).toContain('Eigene Instanz anlegen');
    const created = await adminPost(uSession, uCsrf, '/ui/apps/notes/instances', { from: 'home', slug: 'notes-u' });
    expect(created.status).toBe(302);
    const uOwn = await mustOpen(uSession, 'notes-u');
    expect(await docs('notes-u', uOwn)).toEqual([]);
    const own = JSON.parse((await call(hostOf('notes-u'), 'GET', '/__lager/session', { headers: { Cookie: uOwn } })).body) as { viewer: { id: string; level: string } };
    expect(own.viewer.level).toBe('owner');
    // Writing there does not show up in the shared instance, and the publisher cannot open the user's private instance.
    expect((await db('notes-u', uOwn, { op: 'set', path: 'notes/x1', data: { text: 'privat' } })).status).toBe(200);
    expect((await docs('notes', pNotes)).map((d) => d.path)).not.toContain('notes/x1');
    const pIntoU = await openInstance(pSession, 'notes-u');
    expect('denied' in pIntoU && pIntoU.denied.status).toBe(403);

    // 8. The administrator disables the user: the platform cookie and both instance cookies stop working.
    const adminCsrf2 = csrfIn((await call(PLATFORM, 'GET', '/admin/users', { headers: { Cookie: adminSession } })).body);
    expect((await adminPost(adminSession, adminCsrf2, `/admin/users/${own.viewer.id}/disabled`, { disabled: '1' })).status).toBe(302);
    const afterHome = await home(call, uSession);
    expect(afterHome.status).toBe(302);
    expect(afterHome.headers.location).toContain('/login');
    for (const [slug, cookie] of [['notes', uNotes], ['notes-u', uOwn]] as const) {
      expect((await call(hostOf(slug), 'GET', '/', { headers: { Cookie: cookie } })).status).toBe(302);
      expect((await db(slug, cookie, { op: 'query', path: 'notes' })).status).toBe(401);
      expect((await call(hostOf(slug), 'GET', '/__lager/session', { headers: { Cookie: cookie } })).status).toBe(401);
    }
    const disabledLogin = await call(PLATFORM, 'POST', '/login', { headers: FORM, body: form({ email: 'u@x.y', password: 'uwe-password-12' }) });
    expect(disabledLogin.status).toBe(401);

    // 9. The administrator owns nothing here and cannot open the publisher's private instance.
    const adminIn = await openInstance(adminSession, 'notes');
    expect('denied' in adminIn && adminIn.denied.status).toBe(403);
    // The administration area lists the instance for take-down but shows no instance data.
    const apps = (await call(PLATFORM, 'GET', '/admin/apps', { headers: { Cookie: adminSession } })).body;
    expect(apps).toContain('notes-u');
    expect(apps).not.toContain('von Petra');
  });
});
