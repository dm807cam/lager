import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { signToken } from '../src/http/tokens.js';
import { makeHarness, NONCE, NONCE_COOKIE, PLATFORM_HOST, type Harness } from './support/http.js';
import { t } from '../src/i18n/index.js';

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
    const auth = await request(h.app).get('/auth/instance').query({ slug: 'workout', n: NONCE }).set('Host', PLATFORM_HOST).set('Cookie', await h.login());
    const loc = new URL(auth.headers.location);
    const cb = await request(h.app).get(loc.pathname + loc.search).set('Host', loc.host).set('Cookie', NONCE_COOKIE);
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
    const code = signToken({ uid: h.adminId, iid: inst.id, k: 'code', jti: 'j1', ep: 0, h: W, n: NONCE }, 'test-secret', 60);
    const cb = await request(h.app).get('/__lager/callback').query({ code, return: '//evil.example' }).set('Host', W).set('Cookie', NONCE_COOKIE);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe('/');
  });

  it('handshake code is single-use', async () => {
    const { h } = setup();
    const auth = await request(h.app).get('/auth/instance').query({ slug: 'workout', n: NONCE }).set('Host', PLATFORM_HOST).set('Cookie', await h.login());
    const loc = new URL(auth.headers.location);
    expect((await request(h.app).get(loc.pathname + loc.search).set('Host', loc.host).set('Cookie', NONCE_COOKIE)).status).toBe(302);
    const again = await request(h.app).get(loc.pathname + loc.search).set('Host', loc.host).set('Cookie', NONCE_COOKIE);
    expect(again.status).toBe(400);
    expect(again.headers['set-cookie']).toBeUndefined();
  });

  it('level none with a user is 403', async () => {
    const { h, inst } = setup();
    const u = h.core.users.create({ email: 'u@x.y', name: 'U', password: 'pw', role: 'user' });
    const cookie = 'lager_inst=' + signToken({ uid: u.id, iid: inst.id, k: 'inst', ep: 0 }, 'test-secret', 60);
    expect((await request(h.app).get('/').set('Host', W).set('Cookie', cookie)).status).toBe(403);
    expect((await request(h.app).get('/__lager/session').set('Host', W).set('Cookie', cookie)).status).toBe(401);
  });

  it('users visibility gives signed-in users interact', async () => {
    const { h, inst } = setup({ visibility: 'users' });
    const u = h.core.users.create({ email: 'u@x.y', name: 'U', password: 'pw', role: 'user' });
    const cookie = 'lager_inst=' + signToken({ uid: u.id, iid: inst.id, k: 'inst', ep: 0 }, 'test-secret', 60);
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

  it('users endpoint resolves nobody for an app without the user capability', async () => {
    const { h } = setup();
    const inst = await h.enter('workout', await h.login());
    const u = await request(h.app).get('/__lager/users').query({ ids: h.adminId }).set('Host', W).set('Cookie', inst);
    expect(u.status).toBe(200);
    expect(u.body.profiles).toEqual({});
  });

  it('an anonymous visitor of a public instance gets names but never an address', async () => {
    const { h } = setup({ caps: { user: { scopes: ['email'] } }, visibility: 'public' });
    const u = await request(h.app).get('/__lager/users').query({ ids: h.adminId }).set('Host', W);
    expect(u.body.profiles[h.adminId]).toEqual({ id: h.adminId, name: 'Admin', email: null, isMe: false });
  });

  it('the page may only be framed by its own origin', async () => {
    const { h } = setup();
    const res = await request(h.app).get('/').set('Host', W).set('Cookie', await h.enter('workout', await h.login()));
    expect(res.headers['content-security-policy']).toBe("frame-ancestors 'self'");
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('a sign-in code only works in the browser that started the sign-in', async () => {
    const { h } = setup();
    const start = await request(h.app).get('/').set('Host', W);
    const nonceCookie = ([] as string[]).concat(start.headers['set-cookie'])[0].split(';')[0];
    expect(nonceCookie).toMatch(/^lager_nonce=[A-Za-z0-9_-]{24}$/);
    expect(([] as string[]).concat(start.headers['set-cookie'])[0]).toMatch(/HttpOnly/);
    const startUrl = new URL(start.headers.location);
    const auth = await request(h.app).get(startUrl.pathname + startUrl.search).set('Host', PLATFORM_HOST).set('Cookie', await h.login());
    const loc = new URL(auth.headers.location);
    // Another browser (no nonce, or its own) is not signed in by this code, and the attempt does not burn it.
    expect((await request(h.app).get(loc.pathname + loc.search).set('Host', W)).status).toBe(400);
    expect((await request(h.app).get(loc.pathname + loc.search).set('Host', W).set('Cookie', NONCE_COOKIE)).status).toBe(400);
    const ok = await request(h.app).get(loc.pathname + loc.search).set('Host', W).set('Cookie', nonceCookie);
    expect(ok.status).toBe(302);
    expect(([] as string[]).concat(ok.headers['set-cookie']).some((c) => c.startsWith('lager_nonce=;'))).toBe(true);
    // A code issued without a nonce is good nowhere.
    const bare = await request(h.app).get('/auth/instance').query({ slug: 'workout' }).set('Host', PLATFORM_HOST).set('Cookie', await h.login());
    const bareLoc = new URL(bare.headers.location);
    expect((await request(h.app).get(bareLoc.pathname + bareLoc.search).set('Host', W).set('Cookie', nonceCookie)).status).toBe(400);
  });

  it('a signed-in viewer keeps the stored nonce and gets a plain login URL', async () => {
    const { h } = setup();
    const inst = await h.enter('workout', await h.login());
    const s = await request(h.app).get('/__lager/session').set('Host', W).set('Cookie', inst);
    expect(s.body.loginUrl).toBe('http://lager.localhost:8080/auth/instance?slug=workout&return=%2F');
    expect(s.headers['set-cookie']).toBeUndefined();
    const anon = await request(h.app).get('/__lager/session').set('Host', W).set('Cookie', NONCE_COOKIE);
    expect(anon.body.error.loginUrl).toBe(`http://lager.localhost:8080/auth/instance?slug=workout&return=%2F&n=${NONCE}`);
    expect(anon.headers['set-cookie']).toBeUndefined();
  });

  it('documents the viewer may not read cannot shape a limited query', async () => {
    const { h } = setup({ caps: { db: { rules: [{ path: 'config/a-secret', read: 'owner', write: 'owner' }] } } });
    const owner = await h.login();
    const ada = h.core.users.create({ email: 'ada@x.y', name: 'Ada', password: 'ada-password-1', role: 'user' });
    h.core.access.setGrant(h.core.apps.getInstanceBySlug('workout')!, 'user', ada.id, 'interact', h.core.users.get(h.adminId)!);
    const ownerInst = await h.enter('workout', owner);
    await db(h, W, ownerInst, { op: 'set', path: 'config/a-secret', data: { v: 'm' } });
    const adaInst = await h.enter('workout', await h.login('ada@x.y', 'ada-password-1'));
    await db(h, W, adaInst, { op: 'set', path: 'config/z-mine', data: { v: 'zzz' } });
    // The hidden document sorts first; with the limit applied before the read filter the answer would be empty and leak a match.
    const probe = await db(h, W, adaInst, { op: 'query', path: 'config', query: { where: [['v', '>=', 'a']], limit: 1 } });
    expect(probe.body.docs.map((d: { path: string }) => d.path)).toEqual(['config/z-mine']);
  });

  it('a write answers with the stored document only to someone who may read it', async () => {
    const { h, inst } = setup({ caps: { db: { rules: [{ path: 'votes', read: 'admin', write: 'interact' }] } } });
    const admin = h.core.users.get(h.adminId)!;
    const mk = (name: string) => {
      const u = h.core.users.create({ email: `${name}@x.y`, name, password: `${name}-password-1`, role: 'user' });
      h.core.access.setGrant(inst, 'user', u.id, 'interact', admin);
      return u;
    };
    const ada = mk('ada');
    const bob = mk('bob');
    h.core.data.set(inst.id, `votes/${bob.id}`, { choice: 'secret' }, bob.id);
    const adaInst = await h.enter('workout', await h.login('ada@x.y', 'ada-password-1'));
    // An update merges into what is stored: without read access it is refused, whatever is there and however big it is.
    h.core.data.set(inst.id, 'votes/big', { pad: 'x'.repeat(200 * 1024) }, bob.id);
    const answers = [];
    for (const [target, data] of [[`votes/${bob.id}`, {}], ['votes/big', { pad2: 'y'.repeat(100 * 1024) }], ['votes/missing', { pad2: 'y'.repeat(100 * 1024) }]] as const) {
      const probe = await db(h, W, adaInst, { op: 'update', path: target, data });
      expect(probe.status, target).toBe(403);
      expect(probe.body.error.message).toContain('use set');
      expect(JSON.stringify(probe.body)).not.toContain('secret');
      answers.push(JSON.stringify(probe.body));
    }
    expect(new Set(answers).size).toBe(1);
    expect(h.core.data.get(inst.id, `votes/${bob.id}`)!.version).toBe(1);
    expect(h.core.data.get(inst.id, 'votes/missing')).toBeNull();
    // A lease would answer with the version and expiry of the hidden document and merge into it.
    for (const target of [`votes/${bob.id}`, 'votes/missing']) {
      const lease = await db(h, W, adaInst, { op: 'acquire', path: target, options: { holder: 'h', data: { x: 1 } } });
      expect(lease.status, target).toBe(403);
      expect(lease.body.error.message).toBe('acquire needs read access to the document as well as write access.');
    }
    expect(h.core.data.get(inst.id, `votes/${bob.id}`)!.data).toEqual({ choice: 'secret' });
    // Deleting says the same whether or not there was a document.
    const gone = await db(h, W, adaInst, { op: 'delete', path: 'votes/big' });
    const never = await db(h, W, adaInst, { op: 'delete', path: 'votes/never-there' });
    expect([gone.status, gone.body]).toEqual([200, { ok: true }]);
    expect([never.status, never.body]).toEqual([gone.status, gone.body]);
    expect(h.core.data.get(inst.id, 'votes/big')).toBeNull();
    // set replaces without looking: the same answer over an existing document and a new one.
    expect((await db(h, W, adaInst, { op: 'set', path: `votes/x-${bob.id}`, data: { a: 1 } })).body).toEqual({ doc: null });
    expect((await db(h, W, adaInst, { op: 'set', path: `votes/x-${bob.id}`, data: { a: 2 } })).body).toEqual({ doc: null });
    h.core.data.delete(inst.id, `votes/x-${bob.id}`);
    expect((await db(h, W, adaInst, { op: 'set', path: `votes/${ada.id}`, data: { choice: 'mine' } })).body).toEqual({ doc: null });
    expect((await db(h, W, adaInst, { op: 'add', path: 'votes', data: { choice: 'more' } })).body).toEqual({ doc: null });
    // The writes happened all the same.
    expect(h.core.data.get(inst.id, `votes/${ada.id}`)!.data).toEqual({ choice: 'mine' });
    expect(h.core.data.query(inst.id, 'votes')).toHaveLength(3);
    // Whoever may read gets the document as before.
    const ownerInst = await h.enter('workout', await h.login());
    expect((await db(h, W, ownerInst, { op: 'update', path: `votes/${bob.id}`, data: {} })).body.doc.data).toEqual({ choice: 'secret' });
    expect((await db(h, W, adaInst, { op: 'update', path: 'tasks/t', data: { n: 1 } })).body.doc.data).toEqual({ n: 1 });
  });

  it('a viewer cannot store anything in their private area', async () => {
    const { h, inst } = setup();
    const vera = h.core.users.create({ email: 'vera@x.y', name: 'Vera', password: 'vera-password-1', role: 'user' });
    h.core.access.setGrant(inst, 'user', vera.id, 'view', h.core.users.get(h.adminId)!);
    const cookie = await h.enter('workout', await h.login('vera@x.y', 'vera-password-1'));
    const own = `data/users/${vera.id}/prefs`;
    for (const body of [{ op: 'set', path: own, data: { a: 1 } }, { op: 'update', path: own, data: { a: 1 } },
      { op: 'add', path: `data/users/${vera.id}`, data: { a: 1 } }, { op: 'acquire', path: own, options: { holder: 'h' } }]) {
      expect((await db(h, W, cookie, body)).status, body.op).toBe(403);
    }
    expect(h.core.data.hasData(inst.id)).toBe(false);
    h.core.data.set(inst.id, own, { theme: 'dark' }, vera.id);
    expect((await db(h, W, cookie, { op: 'get', path: own })).body.doc.data).toEqual({ theme: 'dark' });
    h.core.access.setGrant(inst, 'user', vera.id, 'interact', h.core.users.get(h.adminId)!);
    expect((await db(h, W, cookie, { op: 'set', path: own, data: { a: 1 } })).status).toBe(200);
    // Lowered to viewer again: nobody else can remove this data, so its owner still can; changing it stays closed.
    h.core.access.setGrant(inst, 'user', vera.id, 'view', h.core.users.get(h.adminId)!);
    expect((await db(h, W, cookie, { op: 'update', path: own, data: { b: 2 } })).status).toBe(403);
    expect((await db(h, W, cookie, { op: 'delete', path: `data/users/${h.adminId}/prefs` })).status).toBe(403);
    expect((await db(h, W, cookie, { op: 'delete', path: 'tasks/t' })).status).toBe(403);
    expect((await db(h, W, cookie, { op: 'delete', path: own })).body).toEqual({ ok: true });
    expect(h.core.data.get(inst.id, own)).toBeNull();
  });

  it('the change feed is silent about paths the subscriber cannot read', async () => {
    const { h, inst } = setup({ caps: { db: { rules: [{ path: 'votes', read: 'admin', write: 'interact' }] } } });
    const ada = h.core.users.create({ email: 'ada@x.y', name: 'Ada', password: 'ada-password-1', role: 'user' });
    h.core.access.setGrant(inst, 'user', ada.id, 'interact', h.core.users.get(h.adminId)!);
    const cookie = await h.enter('workout', await h.login('ada@x.y', 'ada-password-1'));
    const server = http.createServer(h.app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const received = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no event within 2s')), 2000);
        const req = http.get({ host: '127.0.0.1', port, path: '/__lager/db/events', headers: { Host: W, Cookie: cookie } }, (res) => {
          let buf = '';
          res.on('data', (c) => {
            buf += c;
            if (buf.includes('"path":"tasks/after"')) { clearTimeout(timer); req.destroy(); resolve(buf); }
          });
          setTimeout(() => {
            h.core.data.set(inst.id, 'votes/hidden', { n: 1 }, h.adminId);
            h.core.data.delete(inst.id, 'votes/hidden');
            // A readable change afterwards proves the stream was open while the hidden ones happened.
            h.core.data.set(inst.id, 'tasks/after', { n: 1 }, h.adminId);
          }, 50);
        });
        req.on('error', (e) => { if (!(e as NodeJS.ErrnoException).code?.includes('ECONNRESET')) reject(e); });
      });
      expect(received.match(/event: change/g)).toHaveLength(1);
      expect(received).not.toContain('votes');
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });

  it('a busy lease does not name its holder, and a malformed query is a 400', async () => {
    const { h } = setup();
    const inst = await h.enter('workout', await h.login());
    expect((await db(h, W, inst, { op: 'acquire', path: 'locks/x', options: { holder: 'first-tab-secret' } })).body.acquired).toBe(true);
    const busy = await db(h, W, inst, { op: 'acquire', path: 'locks/x', options: { holder: 'second' } });
    expect(busy.body.acquired).toBe(false);
    expect(busy.body.holder).toBeUndefined();
    expect(JSON.stringify(busy.body)).not.toContain('first-tab-secret');
    for (const query of [{ where: {} }, { orderBy: {} }, { where: 'x' }]) {
      const res = await db(h, W, inst, { op: 'query', path: 'tasks', query });
      expect(res.status, JSON.stringify(query)).toBe(400);
      expect(res.body.error.code).toBe('invalid_argument');
    }
  });

  it('users endpoint names only people the instance knows', async () => {
    const { h, inst } = setup({ caps: { user: { scopes: ['email'] } }, visibility: 'users' });
    const admin = h.core.users.get(h.adminId)!;
    const mk = (name: string) => h.core.users.create({ email: `${name}@x.y`, name, password: `${name}-password-1`, role: 'user' });
    const [granted, viaGroup, author, inRoom, stranger, me, privately] = ['granted', 'viagroup', 'author', 'inroom', 'stranger', 'me', 'privately'].map(mk);
    h.core.access.setGrant(inst, 'user', granted.id, 'view', admin);
    const team = h.core.groups.create('team');
    h.core.groups.addMember(team.id, viaGroup.id);
    h.core.access.setGrant(inst, 'group', team.id, 'view', admin);
    h.core.data.set(inst.id, 'tasks/t1', { n: 1 }, author.id);
    // Using only one's private area tells nobody that the account was here.
    h.core.data.set(inst.id, `data/users/${privately.id}/prefs`, { n: 1 }, privately.id);
    const peer = h.core.rooms.connect(inst.id, '', { by: inRoom.id, guest: false }, () => {});
    // The stranger wrote to another instance only.
    h.core.data.set(h.core.apps.getInstanceBySlug('other')!.id, 'tasks/t1', { n: 1 }, stranger.id);

    const cookie = await h.enter('workout', await h.login('me@x.y', 'me-password-1'));
    const ask = async (ids: string[]) => (await request(h.app).get('/__lager/users').query({ ids: ids.join(',') }).set('Host', W).set('Cookie', cookie)).body.profiles;
    const everyone = [h.adminId, granted.id, viaGroup.id, author.id, inRoom.id, stranger.id, me.id, privately.id, 'nope'];
    const first = await ask(everyone);
    expect(Object.keys(first).sort()).toEqual([h.adminId, granted.id, viaGroup.id, author.id, inRoom.id, me.id].sort());
    expect(first[me.id]).toEqual({ id: me.id, name: 'me', email: 'me@x.y', isMe: true });
    expect(JSON.stringify(first)).not.toContain('stranger');

    // Leaving the room and losing the grant end it; writing here starts it. An author stays known after
    // someone else edited the document and after it was deleted.
    peer.leave();
    h.core.access.removeGrant(inst, 'user', granted.id, admin);
    h.core.data.update(inst.id, 'tasks/t1', { n: 2 }, h.adminId);
    expect(Object.keys(await ask([author.id]))).toEqual([author.id]);
    h.core.data.delete(inst.id, 'tasks/t1');
    h.core.data.set(inst.id, 'tasks/t2', { n: 2 }, stranger.id);
    expect(Object.keys(await ask(everyone)).sort()).toEqual([h.adminId, viaGroup.id, author.id, stranger.id, me.id].sort());

    // An anonymous visitor of a public instance gets the same people, without addresses.
    h.core.apps.setVisibility(inst.id, 'public', h.adminId);
    const anon = (await request(h.app).get('/__lager/users').query({ ids: everyone.join(',') }).set('Host', W)).body.profiles;
    expect(Object.keys(anon).sort()).toEqual([h.adminId, viaGroup.id, author.id, stranger.id].sort());
    expect(anon[stranger.id].email).toBeNull();
  });

  it('users endpoint hides email without scope and caps ids', async () => {
    const { h } = setup({ caps: { user: {} } });
    const inst = await h.enter('workout', await h.login());
    const u = await request(h.app).get('/__lager/users').query({ ids: h.adminId }).set('Host', W).set('Cookie', inst);
    expect(u.body.profiles[h.adminId].email).toBeNull();
    const many = Array.from({ length: 101 }, (_, i) => 'id' + i).join(',');
    expect((await request(h.app).get('/__lager/users').query({ ids: many }).set('Host', W).set('Cookie', inst)).status).toBe(400);
  });

  it('user search is empty without the profile scope', async () => {
    const { h } = setup({ visibility: 'users' });
    h.core.users.create({ email: 'ada@x.y', name: 'Ada Lovelace', password: 'pw-ada-12345', role: 'user' });
    const adaCookie = await h.enter('workout', await h.login('ada@x.y', 'pw-ada-12345'));
    const none = await request(h.app).get('/__lager/users').query({ q: 'a' }).set('Host', W).set('Cookie', adaCookie);
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ profiles: [] });
    // a scope list without "profile" does not count either
    h.core.apps.deploy({ slug: 'workout', html: '<p>2</p>', userId: h.adminId, capabilities: { user: { scopes: ['email'] } } });
    const emailOnly = await request(h.app).get('/__lager/users').query({ q: 'a' }).set('Host', W).set('Cookie', adaCookie);
    expect(emailOnly.body).toEqual({ profiles: [] });
  });

  it('user search needs the profile scope', async () => {
    const { h: hh, inst } = setup({ caps: { user: { scopes: ['profile'] } } });
    const owner = hh.core.users.get(hh.adminId)!;
    const adaB = hh.core.users.create({ email: 'ada@x.y', name: 'Ada Lovelace', password: 'pw-ada-12345', role: 'user' });
    const bob = hh.core.users.create({ email: 'bob@x.y', name: 'Bob', password: 'pw-bob-12345', role: 'user' });
    hh.core.users.create({ email: 'eve@x.y', name: 'Eve Adams', password: 'pw-eve-12345', role: 'user' });
    hh.core.access.setGrant(inst, 'user', adaB.id, 'view', owner);
    hh.core.access.setGrant(inst, 'user', bob.id, 'interact', owner);
    const ownerCookie = await hh.enter('workout', await hh.login());
    const adaCookie2 = await hh.enter('workout', await hh.login('ada@x.y', 'pw-ada-12345'));
    const search = (cookie: string | undefined, q: string) => {
      const r = request(hh.app).get('/__lager/users').query({ q }).set('Host', W);
      return cookie ? r.set('Cookie', cookie) : r;
    };

    // owner and grantees only (Eve has no access), matched by name; no e-mail without the scope
    const hit = await search(ownerCookie, 'ada');
    expect(hit.status).toBe(200);
    expect(hit.body.profiles).toEqual([{ id: adaB.id, name: 'Ada Lovelace', email: null, isMe: false }]);
    const all = await search(adaCookie2, '');
    expect(all.body.profiles.map((p: { name: string }) => p.name)).toEqual(['Ada Lovelace', 'Admin', 'Bob']);
    expect(all.body.profiles.find((p: { isMe: boolean }) => p.isMe).id).toBe(adaB.id);
    // without the email scope only names match: an address-only query finds nobody
    expect((await search(ownerCookie, 'bob@x')).body).toEqual({ profiles: [] });
    expect((await search(ownerCookie, 'nobody')).body).toEqual({ profiles: [] });
    expect((await search(ownerCookie, 'a')).headers['cache-control']).toBe('no-store');

    // anonymous: 401, also on a public instance where anonymous viewers have view access
    const anon = await search(undefined, 'a');
    expect(anon.status).toBe(401);
    hh.core.apps.setVisibility(inst.id, 'public', hh.adminId);
    expect((await search(undefined, 'a')).status).toBe(401);
    // the ids form is unchanged
    const ids = await request(hh.app).get('/__lager/users').query({ ids: bob.id }).set('Host', W).set('Cookie', ownerCookie);
    expect(ids.body.profiles[bob.id]).toMatchObject({ name: 'Bob' });
  });

  it('user search shows e-mail addresses only with the email scope', async () => {
    const { h, inst } = setup({ caps: { user: { scopes: ['profile', 'email'] } } });
    const ada = h.core.users.create({ email: 'ada@x.y', name: 'Ada', password: 'pw-ada-12345', role: 'user' });
    h.core.access.setGrant(inst, 'user', ada.id, 'view', h.core.users.get(h.adminId)!);
    const cookie = await h.enter('workout', await h.login());
    // Until Ada has agreed to share her address with this instance, the search shows her name only and does not match her address.
    const before = await request(h.app).get('/__lager/users').query({ q: 'ada' }).set('Host', W).set('Cookie', cookie);
    expect(before.body.profiles).toEqual([{ id: ada.id, name: 'Ada', email: null, isMe: false }]);
    expect((await request(h.app).get('/__lager/users').query({ q: 'ada@x' }).set('Host', W).set('Cookie', cookie)).body.profiles).toEqual([]);
    h.core.access.confirmSignIn(inst, ada, true);
    const res = await request(h.app).get('/__lager/users').query({ q: 'ada' }).set('Host', W).set('Cookie', cookie);
    expect(res.body.profiles).toEqual([{ id: ada.id, name: 'Ada', email: 'ada@x.y', isMe: false }]);
    const byAddress = await request(h.app).get('/__lager/users').query({ q: 'ada@x' }).set('Host', W).set('Cookie', cookie);
    expect(byAddress.body.profiles.map((p: { id: string }) => p.id)).toEqual([ada.id]);
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

  it('an idle events stream ends at the next ping once access is gone', async () => {
    const { h, inst } = setup();
    const admin = h.core.users.get(h.adminId)!;
    const mk = (email: string) => h.core.users.create({ email, name: email, password: 'pw', role: 'user' });
    const e = mk('e@x.y');
    const f = mk('f@x.y');
    h.core.access.setGrant(inst, 'user', e.id, 'view', admin);
    h.core.access.setGrant(inst, 'user', f.id, 'view', admin);
    const ec = await h.enter('workout', await h.login('e@x.y', 'pw'));
    const fc = await h.enter('workout', await h.login('f@x.y', 'pw'));
    const server = http.createServer(h.app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const open = (cookie: string) => new Promise<{ ended: Promise<void>; req: http.ClientRequest }>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/__lager/db/events', headers: { Host: W, Cookie: cookie } }, (res) => {
        const ended = new Promise<void>((done) => { res.on('end', done); res.on('close', done); });
        res.on('data', () => undefined);
        resolve({ ended, req });
      });
      req.on('error', reject);
    });
    try {
      const streamE = await open(ec);
      const streamF = await open(fc);
      const state = { e: false, f: false };
      void streamE.ended.then(() => { state.e = true; });
      void streamF.ended.then(() => { state.f = true; });
      // Nothing changed: pings keep both streams open.
      vi.advanceTimersByTime(25_001);
      await vi.advanceTimersByTimeAsync(10);
      await new Promise((r) => setImmediate(r));
      expect(state).toEqual({ e: false, f: false });
      // e's grant is withdrawn, f's session ends (logout); no data event follows, only the next ping.
      h.core.access.removeGrant(inst, 'user', e.id, admin);
      h.core.users.bumpEpoch(f.id);
      expect(state).toEqual({ e: false, f: false });
      vi.advanceTimersByTime(25_001);
      await Promise.all([streamE.ended, streamF.ended]);
      expect(state).toEqual({ e: true, f: true });
    } finally {
      vi.useRealTimers();
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
    expect(res.text).toContain(t('en', 'error.notFound.title'));
  });

  it('unknown instance path → 404', async () => {
    const { h } = setup({ visibility: 'public' });
    expect((await request(h.app).get('/other.html').set('Host', W)).status).toBe(404);
  });

  it('grantee gets the granted level in the session', async () => {
    const { h, inst } = setup();
    const e = h.core.users.create({ email: 'e@x.y', name: 'E', password: 'pw', role: 'user' });
    const cookie = 'lager_inst=' + signToken({ uid: e.id, iid: inst.id, k: 'inst', ep: 0 }, 'test-secret', 60);
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
    expect(page.text).toContain(t('en', 'error.disabled.text'));
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
    const cookie = 'lager_inst=' + signToken({ uid: e.id, iid: inst.id, k: 'inst', ep: 0 }, 'test-secret', 60);
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

describe('session epoch', () => {
  async function member() {
    const { h, inst } = setup({ visibility: 'users' });
    const user = h.core.users.create({ email: 'm@x.y', name: 'M', password: 'long enough pw', role: 'user' });
    const platform = await h.login('m@x.y', 'long enough pw');
    const cookie = await h.enter('workout', platform);
    expect((await request(h.app).get('/__lager/session').set('Host', W).set('Cookie', cookie)).status).toBe(200);
    return { h, inst, user, platform, cookie };
  }
  const anonymous = async (h: Harness, cookie: string) => {
    const res = await request(h.app).get('/__lager/session').set('Host', W).set('Cookie', cookie);
    expect(res.status).toBe(401);
  };

  it('instance cookie dies with the epoch', async () => {
    for (const kill of [
      (c: Awaited<ReturnType<typeof member>>) => c.h.core.users.bumpEpoch(c.user.id),
      (c: Awaited<ReturnType<typeof member>>) => c.h.core.users.setPassword(c.user.id, 'another long password'),
      (c: Awaited<ReturnType<typeof member>>) => c.h.core.users.setDisabled(c.user.id, true),
    ]) {
      const c = await member();
      await kill(c);
      await anonymous(c.h, c.cookie);
      const page = await request(c.h.app).get('/').set('Host', W).set('Cookie', c.cookie);
      expect(page.status).toBe(302);
      c.h.core.close();
      h = undefined;
    }
  });

  it('handshake code from before an epoch bump is rejected', async () => {
    const { h, inst, user, platform } = await member();
    const auth = await request(h.app).get('/auth/instance').query({ slug: 'workout', return: '/' }).set('Host', PLATFORM_HOST).set('Cookie', platform);
    const loc = new URL(auth.headers.location);
    h.core.users.bumpEpoch(user.id);
    const cb = await request(h.app).get(loc.pathname + loc.search).set('Host', loc.host);
    expect(cb.status).toBe(400);
    expect(cb.headers['set-cookie']).toBeUndefined();
    expect(inst.id).toBeTruthy();
  });

  it('instance cookie and code without an epoch are rejected', async () => {
    const { h, user } = await member();
    const inst = h.core.apps.getInstanceBySlug('workout')!;
    const legacyCookie = `lager_inst=${signToken({ uid: user.id, iid: inst.id, k: 'inst' }, 'test-secret', 60)}`;
    await anonymous(h, legacyCookie);
    const okCookie = `lager_inst=${signToken({ uid: user.id, iid: inst.id, k: 'inst', ep: user.sessionEpoch }, 'test-secret', 60)}`;
    expect((await request(h.app).get('/__lager/session').set('Host', W).set('Cookie', okCookie)).status).toBe(200);
    const code = signToken({ uid: user.id, iid: inst.id, k: 'code', jti: 'j1' }, 'test-secret', 60);
    expect((await request(h.app).get('/__lager/callback').query({ code }).set('Host', W)).status).toBe(400);
  });
});

