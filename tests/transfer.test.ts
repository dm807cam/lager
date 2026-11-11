import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { apiExtension } from '../src/http/api.js';
import { manageExtension } from '../src/http/manage.js';
import { makeHarness, type Harness } from './support/http.js';

let h: Harness | undefined;
let server: http.Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((r) => (server ? server.close(r) : r(undefined)));
  server = undefined;
  h?.core.close();
  h = undefined;
});

const RULES = { db: { rules: [{ path: 'locked', read: 'owner', write: 'owner' }] } };

function setup(opts: { instanceQuotaBytes?: number } = {}) {
  h = makeHarness({ extensions: [apiExtension, manageExtension], ...opts });
  const core = h.core;
  core.apps.deploy({ slug: 'notes', html: '<p>n</p>', userId: h.adminId, capabilities: RULES });
  const inst = core.apps.getInstanceBySlug('notes')!;
  core.data.set(inst.id, 'locked/a', { v: 1 }, null);
  core.data.set(inst.id, 'open/a', { v: 2 }, null);
  const admin = core.users.get(h.adminId)!;
  const mgr = core.users.create({ email: 'm@x.y', name: 'M', password: 'pw-manager-1', role: 'user' });
  core.access.setGrant(inst, 'user', mgr.id, 'admin', admin);
  return { h, core, inst, ownerToken: core.tokens.create(admin.id, 'o').token, mgrToken: core.tokens.create(mgr.id, 'm').token, mgr };
}

const post = (e: ReturnType<typeof setup>, token: string, type: string, body: string | object) =>
  request(e.h.app).post('/api/instances/notes/import').set('Host', e.h.host).set('Authorization', `Bearer ${token}`).type(type).send(body);

describe('export and import hold managers to the app rules', () => {
  it('REST export omits what a manager may not read; the owner gets everything', async () => {
    const e = setup();
    const get = (t: string) => request(e.h.app).get('/api/instances/notes/export').set('Host', e.h.host).set('Authorization', `Bearer ${t}`);
    expect((await get(e.mgrToken)).text.split('\n').filter(Boolean).map((l) => JSON.parse(l).path)).toEqual(['open/a']);
    expect((await get(e.ownerToken)).text.split('\n').filter(Boolean).map((l) => JSON.parse(l).path)).toEqual(['locked/a', 'open/a']);
  });

  it('REST import is refused as a whole for a manager when one document is not writable', async () => {
    const e = setup();
    for (const [type, body] of [['application/x-ndjson', '{"path":"open/b","data":{}}\n{"path":"locked/x","data":{}}\n'], ['application/json', [{ path: 'open/b', data: {} }, { path: 'locked/x', data: {} }]]] as const) {
      const res = await post(e, e.mgrToken, type, body);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('forbidden');
    }
    expect(e.core.data.get(e.inst.id, 'locked/x')).toBeNull();
    expect(e.core.data.get(e.inst.id, 'open/b')).toBeNull();
    expect((await post(e, e.mgrToken, 'application/x-ndjson', '{"path":"open/b","data":{}}\n')).body).toEqual({ imported: 1 });
    expect((await post(e, e.ownerToken, 'application/x-ndjson', '{"path":"locked/x","data":{}}\n')).body).toEqual({ imported: 1 });
  });

  it('the page export applies the same filter', async () => {
    const e = setup();
    const cookie = await e.h.login('m@x.y', 'pw-manager-1');
    const res = await request(e.h.app).get('/instances/notes/export').set('Host', e.h.host).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.text.split('\n').filter(Boolean).map((l) => JSON.parse(l).path)).toEqual(['open/a']);
  });
});

/** Opens an import request and returns the pieces to drive it by hand. */
function rawImport(port: number, token: string, headers: Record<string, string>) {
  let req!: http.ClientRequest;
  const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
    req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/instances/notes/import', headers: { Host: h!.host, Authorization: `Bearer ${token}`, ...headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject);
  });
  return { req, response };
}

async function listen(): Promise<number> {
  server = http.createServer(h!.app);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
}

describe('import limits', () => {
  it('refuses an oversized declared body, and an oversized streamed body, with 413', async () => {
    const e = setup();
    const port = await listen();
    const declared = rawImport(port, e.ownerToken, { 'Content-Type': 'application/x-ndjson', 'Content-Length': String(21 * 1024 * 1024) });
    declared.req.flushHeaders();
    expect((await declared.response).status).toBe(413);
    const json = rawImport(port, e.ownerToken, { 'Content-Type': 'application/json', 'Content-Length': String(6 * 1024 * 1024) });
    json.req.flushHeaders();
    expect((await json.response).status).toBe(413);
    // No Content-Length: counted while streaming.
    const streamed = rawImport(port, e.ownerToken, { 'Content-Type': 'application/x-ndjson' });
    const line = `${JSON.stringify({ path: 'big/1', data: { pad: 'x'.repeat(60_000) } })}\n`;
    streamed.req.on('error', () => undefined);
    for (let i = 0; i < 360 && !streamed.req.destroyed; i++) if (!streamed.req.write(line)) await new Promise((r) => streamed.req.once('drain', r).once('error', r).once('close', r));
    const res = await streamed.response.catch(() => ({ status: 0, body: '' }));
    expect(res.status).toBe(413);
    expect(e.core.data.get(e.inst.id, 'big/1')).toBeNull();
  }, 30_000);

  it('allows one import per instance at a time', async () => {
    const e = setup();
    const port = await listen();
    const first = rawImport(port, e.ownerToken, { 'Content-Type': 'application/x-ndjson', 'Transfer-Encoding': 'chunked' });
    first.req.write('{"path":"a/1","data":{}}\n');
    await new Promise((r) => setTimeout(r, 100));
    const second = rawImport(port, e.ownerToken, { 'Content-Type': 'application/x-ndjson', 'Transfer-Encoding': 'chunked' });
    second.req.write('{"path":"a/2","data":{}}\n');
    const refused = await second.response;
    expect(refused.status).toBe(409);
    first.req.end('{"path":"a/3","data":{}}\n');
    const done = await first.response;
    expect(done.status).toBe(200);
    expect(JSON.parse(done.body)).toEqual({ imported: 2 });
    // The slot is free again.
    expect((await post(e, e.ownerToken, 'application/x-ndjson', '{"path":"a/4","data":{}}\n')).status).toBe(200);
  });

  it('refuses a quota-full instance before reading the body', async () => {
    const e = setup({ instanceQuotaBytes: 128 * 1024 });
    for (let i = 0; i < 20; i++) { try { e.core.data.set(e.inst.id, `fill/${i}`, { pad: 'x'.repeat(20_000) }, null); } catch { break; } }
    expect(() => e.core.data.assertQuota(e.inst.id)).toThrow();
    const port = await listen();
    // The body is never sent: an answer proves the handler did not wait for it.
    const r = rawImport(port, e.ownerToken, { 'Content-Type': 'application/x-ndjson', 'Content-Length': '1000' });
    r.req.flushHeaders();
    const res = await r.response;
    expect(res.status).toBe(507);
    r.req.destroy();
  });
});
