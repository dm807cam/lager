import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { signToken } from '../src/http/tokens.js';
import { makeHarness, PLATFORM_HOST, type Harness } from './support/http.js';

const TAG = '<script src="/__lager/runtime.js"></script>';
let h: Harness | undefined;
afterEach(() => { h?.core.close(); h = undefined; });

const W = 'workout.apps.localhost';
const O = 'other.apps.localhost';

function setup(opts: { caps?: object; visibility?: 'private' | 'users' | 'public'; quota?: number } = {}) {
  h = makeHarness({ instanceQuotaBytes: opts.quota });
  const r = h.core.apps.deploy({ slug: 'workout', html: '<html><head></head><body>v1</body></html>', userId: h.adminId, capabilities: opts.caps });
  h.core.apps.deploy({ slug: 'other', html: '<p>other</p>', userId: h.adminId });
  if (opts.visibility) h.core.apps.setVisibility(r.instances[0].id, opts.visibility, h.adminId);
  return { h, inst: r.instances[0] };
}

async function db(h: Harness, host: string, cookie: string | undefined, body: object, header = true) {
  const req = request(h.app).post('/__lager/db').set('Host', host);
  if (cookie) req.set('Cookie', cookie);
  if (header) req.set('X-Lager-Request', '1');
  return req.send(body);
}

describe('instance host', () => {
  it('private instance redirects anonymous to the platform', async () => {
    const { h } = setup();
    const res = await request(h.app).get('/').set('Host', W);
    expect(res.status).toBe(302);
    expect(res.headers.location.startsWith('http://lager.localhost:8080/auth/instance?slug=workout')).toBe(true);
  });

  it('handshake yields a page with the runtime injected', async () => {
    const { h } = setup();
    const inst = await h.enter('workout', await h.login());
    const res = await request(h.app).get('/').set('Host', W).set('Cookie', inst);
    expect(res.status).toBe(200);
    expect(res.text).toContain(TAG);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('same-origin');
    const cookie = inst;
    expect(cookie.startsWith('lager_inst=')).toBe(true);
  });

  it('instance cookie is HttpOnly and host-only', async () => {
    const { h } = setup();
    const auth = await request(h.app).get('/auth/instance').query({ slug: 'workout' }).set('Host', PLATFORM_HOST).set('Cookie', await h.login());
    const loc = new URL(auth.headers.location);
    const cb = await request(h.app).get(loc.pathname + loc.search).set('Host', loc.host);
    expect(cb.status).toBe(302);
    const c = ([] as string[]).concat(cb.headers['set-cookie'])[0];
    expect(c).toContain('HttpOnly');
    expect(c).toMatch(/SameSite=Lax/i);
    expect(c).not.toMatch(/Domain=/i);
  });

  it('cookie for A rejected on B', async () => {
    const { h } = setup();
    const inst = await h.enter('workout', await h.login());
    const res = await request(h.app).get('/').set('Host', O).set('Cookie', inst);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/auth/instance?slug=other');
  });

  it('handshake code for A rejected on B', async () => {
    const { h } = setup();
    const auth = await request(h.app).get('/auth/instance').query({ slug: 'workout' }).set('Host', PLATFORM_HOST).set('Cookie', await h.login());
    const loc = new URL(auth.headers.location);
    const res = await request(h.app).get(loc.pathname + loc.search).set('Host', O);
    expect(res.status).toBe(400);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('code cannot be used as session cookie, and inst token cannot be a code', async () => {
    const { h, inst } = setup();
    const code = signToken({ uid: h.adminId, iid: inst.id, k: 'code' }, 'test-secret', 60);
    const res = await request(h.app).get('/').set('Host', W).set('Cookie', 'lager_inst=' + code);
    expect(res.status).toBe(302);
    const instTok = signToken({ uid: h.adminId, iid: inst.id, k: 'inst' }, 'test-secret', 60);
    const cb = await request(h.app).get('/__lager/callback').query({ code: instTok }).set('Host', W);
    expect(cb.status).toBe(400);
  });

  it('callback return must be a local path', async () => {
    const { h, inst } = setup();
    const code = signToken({ uid: h.adminId, iid: inst.id, k: 'code', jti: 'j1' }, 'test-secret', 60);
    const cb = await request(h.app).get('/__lager/callback').query({ code, return: '//evil.example' }).set('Host', W);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe('/');
  });

  it('handshake code is single-use', async () => {
    const { h } = setup();
    const auth = await request(h.app).get('/auth/instance').query({ slug: 'workout' }).set('Host', PLATFORM_HOST).set('Cookie', await h.login());
    const loc = new URL(auth.headers.location);
    expect((await request(h.app).get(loc.pathname + loc.search).set('Host', loc.host)).status).toBe(302);
    const again = await request(h.app).get(loc.pathname + loc.search).set('Host', loc.host);
    expect(again.status).toBe(400);
    expect(again.headers['set-cookie']).toBeUndefined();
  });

  it('level none with a user is 403', async () => {
    const { h, inst } = setup();
    const u = h.core.users.create({ email: 'u@x.y', name: 'U', password: 'pw', role: 'user' });
    const cookie = 'lager_inst=' + signToken({ uid: u.id, iid: inst.id, k: 'inst' }, 'test-secret', 60);
    expect((await request(h.app).get('/').set('Host', W).set('Cookie', cookie)).status).toBe(403);
    expect((await request(h.app).get('/__lager/session').set('Host', W).set('Cookie', cookie)).status).toBe(401);
  });

  it('users visibility gives signed-in users interact', async () => {
    const { h, inst } = setup({ visibility: 'users' });
    const u = h.core.users.create({ email: 'u@x.y', name: 'U', password: 'pw', role: 'user' });
    const cookie = 'lager_inst=' + signToken({ uid: u.id, iid: inst.id, k: 'inst' }, 'test-secret', 60);
    const res = await request(h.app).get('/__lager/session').set('Host', W).set('Cookie', cookie);
    expect(res.body.viewer).toMatchObject({ id: u.id, level: 'interact', isOwner: false, canEdit: false });
  });

  it('public instance serves anonymous with level view', async () => {
    const { h } = setup({ visibility: 'public' });
    expect((await request(h.app).get('/').set('Host', W)).status).toBe(200);
    const res = await request(h.app).get('/__lager/session').set('Host', W);
    expect(res.status).toBe(200);
    expect(res.body.viewer).toMatchObject({ id: null, name: '', email: null, level: 'view' });
    expect(res.body.loginUrl).toContain('/auth/instance?slug=workout');
  });

  it('session reports owner', async () => {
    const { h } = setup();
    const inst = await h.enter('workout', await h.login());
    const res = await request(h.app).get('/__lager/session').set('Host', W).set('Cookie', inst);
    expect(res.status).toBe(200);
    expect(res.body.viewer).toMatchObject({ id: h.adminId, level: 'owner', isOwner: true, canEdit: true, email: null });
    expect(res.body.instance).toMatchObject({ slug: 'workout', appSlug: 'workout', version: 1 });
    expect(res.body.capabilities).toEqual({});
  });

  it('session exposes email only with the email scope; users endpoint follows the same rule', async () => {
    const { h } = setup({ caps: { user: { scopes: ['email'] } } });
    const inst = await h.enter('workout', await h.login());
    const s = await request(h.app).get('/__lager/session').set('Host', W).set('Cookie', inst);
    expect(s.body.viewer.email).toBe('admin@x.y');
    const u = await request(h.app).get('/__lager/users').query({ ids: h.adminId + ',nope' }).set('Host', W).set('Cookie', inst);
    expect(u.body.profiles[h.adminId]).toMatchObject({ id: h.adminId, name: 'Admin', email: 'admin@x.y', isMe: true });
    expect(u.body.profiles.nope).toBeUndefined();
  });

  it('users endpoint hides email without scope and caps ids', async () => {
    const { h } = setup();
    const inst = await h.enter('workout', await h.login());
    const u = await request(h.app).get('/__lager/users').query({ ids: h.adminId }).set('Host', W).set('Cookie', inst);
    expect(u.body.profiles[h.adminId].email).toBeNull();
    const many = Array.from({ length: 101 }, (_, i) => 'id' + i).join(',');
    expect((await request(h.app).get('/__lager/users').query({ ids: many }).set('Host', W).set('Cookie', inst)).status).toBe(400);
  });

  it('serves the runtime with ETag', async () => {
    const { h } = setup();
    const res = await request(h.app).get('/__lager/runtime.js').set('Host', W);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-cache');
    const etag = res.headers.etag;
    expect(etag).toBeTruthy();
    expect((await request(h.app).get('/__lager/runtime.js').set('Host', W).set('If-None-Match', etag)).status).toBe(304);
  });

  it('db roundtrip', async () => {
    const { h } = setup();
    const inst = await h.enter('workout', await h.login());
    const call = async (body: object) => (await db(h, W, inst, body));
    expect((await call({ op: 'set', path: 'tasks/a', data: { n: 1 } })).body.doc.data).toEqual({ n: 1 });
    expect((await call({ op: 'get', path: 'tasks/a' })).body.doc.data).toEqual({ n: 1 });
    expect((await call({ op: 'get', path: 'tasks/zzz' })).body).toEqual({ doc: null });
    expect((await call({ op: 'query', path: 'tasks', query: { where: [['n', '==', 1]] } })).body.docs).toHaveLength(1);
    expect((await call({ op: 'update', path: 'tasks/a', data: { m: 2 } })).body.doc.data).toEqual({ n: 1, m: 2 });
    const added = (await call({ op: 'add', path: 'tasks', data: { n: 5 } })).body.doc;
    expect(added.id).toHaveLength(20);
    expect(added.path).toBe('tasks/' + added.id);
    const acq = await call({ op: 'acquire', path: 'locks/x', options: { holder: 'h1' } });
    expect(acq.body.acquired).toBe(true);
    expect((await call({ op: 'delete', path: 'tasks/a' })).body).toEqual({ ok: true });
    expect((await call({ op: 'get', path: 'tasks/a' })).body).toEqual({ doc: null });
  });

  it('db requires X-Lager-Request', async () => {
    const { h } = setup();
    const inst = await h.enter('workout', await h.login());
    expect((await db(h, W, inst, { op: 'get', path: 'a/b' }, false)).status).toBe(403);
  });

  it('db endpoint maps errors', async () => {
    const { h } = setup({ visibility: 'public' });
    const inst = await h.enter('workout', await h.login());
    const bad = await db(h, W, inst, { op: 'set', path: 'a//b', data: {} });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_argument');
    expect((await db(h, W, inst, { op: 'nope', path: 'a/b' })).status).toBe(400);
    expect((await db(h, W, inst, { op: 'set', data: {} })).status).toBe(400);
    expect((await db(h, W, inst, { op: 'set', path: 'a/b', data: 'x' })).status).toBe(400);
    const anon = await db(h, W, undefined, { op: 'set', path: 'a/b', data: {} });
    expect(anon.status).toBe(403);
    expect(anon.body.error.code).toBe('forbidden');
    const big = await request(h.app).post('/__lager/db').set('Host', W).set('Cookie', inst).set('X-Lager-Request', '1')
      .send({ op: 'set', path: 'a/b', data: { s: 'x'.repeat(600 * 1024) } });
    expect(big.status).toBe(413);
    const malformed = await request(h.app).post('/__lager/db').set('Host', W).set('Cookie', inst).set('X-Lager-Request', '1')
      .set('Content-Type', 'application/json').send('{oops');
    expect(malformed.status).toBe(400);
  });

  it('db honours capabilities rules, also when filtering query results', async () => {
    const { h } = setup({ caps: { db: { rules: [{ path: 'locked', write: 'self' }, { path: 'tasks/secret', read: 'owner' }] } }, visibility: 'public' });
    const inst = await h.enter('workout', await h.login());
    const res = await db(h, W, inst, { op: 'set', path: 'locked/x', data: {} });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
    // a viewer who may read tasks but not tasks/secret must not see it through a collection query
    await db(h, W, inst, { op: 'set', path: 'tasks/open', data: { a: 1 } });
    await db(h, W, inst, { op: 'set', path: 'tasks/secret', data: { a: 2 } });
    const anon = await db(h, W, undefined, { op: 'query', path: 'tasks' });
    expect(anon.body.docs.map((d: { id: string }) => d.id)).toEqual(['open']);
    // reads the viewer may not perform look like missing data; writes stay forbidden
    expect((await db(h, W, undefined, { op: 'get', path: 'tasks/secret' })).body).toEqual({ doc: null });
    expect((await db(h, W, undefined, { op: 'set', path: 'locked/y', data: {} })).status).toBe(403);
  });

  it('a collection the viewer cannot read at all queries as empty', async () => {
    const { h } = setup({ caps: { db: { rules: [{ path: 'vault', read: 'owner' }] } }, visibility: 'public' });
    const inst = await h.enter('workout', await h.login());
    await db(h, W, inst, { op: 'set', path: 'vault/a', data: { a: 1 } });
    expect((await db(h, W, inst, { op: 'query', path: 'vault' })).body.docs).toHaveLength(1);
    const anon = await db(h, W, undefined, { op: 'query', path: 'vault' });
    expect(anon.status).toBe(200);
    expect(anon.body).toEqual({ docs: [] });
  });

  it('serves the newly active version after rollback, data intact', async () => {
    const { h, inst } = setup();
    const cookie = await h.enter('workout', await h.login());
    await db(h, W, cookie, { op: 'set', path: 'tasks/a', data: { n: 1 } });
    h.core.apps.deploy({ slug: 'workout', html: '<html><head></head><body>v2</body></html>', userId: h.adminId });
    expect((await request(h.app).get('/').set('Host', W).set('Cookie', cookie)).text).toContain('v2');
    h.core.apps.activate(inst.id, 1, h.adminId);
    expect((await request(h.app).get('/').set('Host', W).set('Cookie', cookie)).text).toContain('v1');
    expect((await db(h, W, cookie, { op: 'get', path: 'tasks/a' })).body.doc.data).toEqual({ n: 1 });
    expect((await request(h.app).get('/__lager/session').set('Host', W).set('Cookie', cookie)).body.instance.version).toBe(1);
  });

  it('events stream delivers a change', async () => {
    const { h } = setup();
    const cookie = await h.enter('workout', await h.login());
    const server = http.createServer(h.app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const received = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no event within 2s')), 2000);
        const req = http.get({ host: '127.0.0.1', port, path: '/__lager/db/events', headers: { Host: W, Cookie: cookie } }, (res) => {
          expect(res.headers['content-type']).toContain('text/event-stream');
          let buf = '';
          res.on('data', (c) => {
            buf += c;
            if (buf.includes('event: change')) { clearTimeout(timer); req.destroy(); resolve(buf); }
          });
          // headers are flushed immediately; write once the stream is established
          setTimeout(() => { h.core.data.set(h.core.apps.getInstanceBySlug('workout')!.id, 'tasks/a', { n: 1 }, h.adminId); }, 50);
        });
        req.on('error', (e) => { if (!(e as NodeJS.ErrnoException).code?.includes('ECONNRESET')) reject(e); });
      });
      expect(received).toContain('"path":"tasks/a"');
      expect(received).toContain('"parent":"tasks"');
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });

  it('events require a viewer with access', async () => {
    const { h } = setup();
    expect((await request(h.app).get('/__lager/db/events').set('Host', W)).status).toBe(401);
  });

  it('unknown instance slug → 404', async () => {
    h = makeHarness();
    const res = await request(h.app).get('/').set('Host', 'ghost.apps.localhost');
    expect(res.status).toBe(404);
    expect(res.text).toContain('Nicht gefunden');
  });

  it('unknown instance path → 404', async () => {
    const { h } = setup({ visibility: 'public' });
    expect((await request(h.app).get('/other.html').set('Host', W)).status).toBe(404);
  });

  it('grantee gets the granted level in the session', async () => {
    const { h, inst } = setup();
    const e = h.core.users.create({ email: 'e@x.y', name: 'E', password: 'pw', role: 'user' });
    const cookie = 'lager_inst=' + signToken({ uid: e.id, iid: inst.id, k: 'inst' }, 'test-secret', 60);
    expect((await request(h.app).get('/').set('Host', W).set('Cookie', cookie)).status).toBe(403);
    h.core.access.setGrant(inst, 'user', e.id, 'view', h.core.users.get(h.adminId)!);
    const platform = await h.login('e@x.y', 'pw');
    const entered = await h.enter('workout', platform);
    expect((await request(h.app).get('/').set('Host', W).set('Cookie', entered)).status).toBe(200);
    const res = await request(h.app).get('/__lager/session').set('Host', W).set('Cookie', entered);
    expect(res.body.viewer).toMatchObject({ id: e.id, level: 'view', isOwner: false, canEdit: false });
    expect((await db(h, W, entered, { op: 'set', path: 'tasks/a', data: { n: 1 } })).status).toBe(403);
    expect((await db(h, W, entered, { op: 'get', path: 'tasks/a' })).status).toBe(200);
  });

  it('disabled instance serves the notice', async () => {
    const { h, inst } = setup({ visibility: 'public' });
    h.core.apps.setInstanceDisabled(inst.id, true);
    const page = await request(h.app).get('/').set('Host', W);
    expect(page.status).toBe(403);
    expect(page.text).toContain('deaktiviert');
    const s = await request(h.app).get('/__lager/session').set('Host', W);
    expect(s.status).toBe(403);
    expect(s.body.error.code).toBe('forbidden');
    const cookie = await h.enter('other', await h.login());
    expect((await request(h.app).get('/__lager/session').set('Host', W).set('Cookie', cookie)).status).toBe(403);
    expect((await db(h, W, undefined, { op: 'get', path: 'a/b' })).status).toBe(403);
    const auth = await request(h.app).get('/auth/instance').query({ slug: 'workout' }).set('Host', PLATFORM_HOST).set('Cookie', await h.login());
    expect(auth.status).toBe(403);
    h.core.apps.setInstanceDisabled(inst.id, false);
    expect((await request(h.app).get('/').set('Host', W)).status).toBe(200);
  });

  it('disabled user is treated as anonymous in the instance', async () => {
    const { h, inst } = setup({ visibility: 'users' });
    const e = h.core.users.create({ email: 'e@x.y', name: 'E', password: 'pw', role: 'user' });
    const cookie = 'lager_inst=' + signToken({ uid: e.id, iid: inst.id, k: 'inst' }, 'test-secret', 60);
    expect((await request(h.app).get('/__lager/session').set('Host', W).set('Cookie', cookie)).status).toBe(200);
    h.core.users.setDisabled(e.id, true);
    expect((await request(h.app).get('/__lager/session').set('Host', W).set('Cookie', cookie)).status).toBe(401);
  });

  it('quota_exceeded maps to 507', async () => {
    const { h } = setup({ quota: 16 * 1024 });
    const inst = await h.enter('workout', await h.login());
    let status = 200;
    let body: { error?: { code?: string } } = {};
    for (let i = 0; i < 100 && status === 200; i++) {
      const res = await db(h, W, inst, { op: 'set', path: `tasks/t${i}`, data: { text: 'x'.repeat(2000) } });
      status = res.status;
      body = res.body as typeof body;
    }
    expect(status).toBe(507);
    expect(body.error?.code).toBe('quota_exceeded');
    expect((await db(h, W, inst, { op: 'get', path: 'tasks/t0' })).status).toBe(200);
    expect((await db(h, W, inst, { op: 'delete', path: 'tasks/t0' })).status).toBe(200);
  });
});
