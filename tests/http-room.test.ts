import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GrantLevel } from '../src/platform/access.js';
import { signToken } from '../src/http/tokens.js';
import { makeHarness, type Harness } from './support/http.js';

let h: Harness | undefined;
let server: http.Server | undefined;
const opened: http.ClientRequest[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const r of opened.splice(0)) r.destroy();
  server?.closeAllConnections();
  await new Promise((r) => (server ? server.close(r) : r(undefined)));
  server = undefined;
  h?.core.close();
  h = undefined;
});

const HOST = 'room.apps.localhost';
const PLAIN = 'plain.apps.localhost';
const CAPS = { room: { topics: { move: 'interact' } } };

interface SseEvent { event: string; data: any }
interface Stream { status: number; events: SseEvent[]; ended: Promise<void>; next(event: string): Promise<any>; close(): void; hello: any }

async function setup(visibility: 'private' | 'users' | 'public' = 'private') {
  h = makeHarness();
  const core = h.core;
  const inst = core.apps.deploy({ slug: 'room', html: '<p>x</p>', userId: h.adminId, capabilities: CAPS }).instances[0];
  core.apps.deploy({ slug: 'plain', html: '<p>x</p>', userId: h.adminId });
  core.apps.setVisibility(inst.id, visibility, h.adminId);
  const admin = core.users.get(h.adminId)!;
  const cookieOf = (u: { id: string; sessionEpoch: number }) => 'lager_inst=' + signToken({ uid: u.id, iid: inst.id, k: 'inst', ep: u.sessionEpoch }, 'test-secret', 600);
  const mk = (email: string, level?: GrantLevel) => {
    const u = core.users.create({ email, name: email, password: 'pw-12345678', role: 'user' });
    if (level) core.access.setGrant(inst, 'user', u.id, level, admin);
    return { user: u, cookie: cookieOf(u) };
  };
  server = http.createServer(h.app);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { h, core, inst, admin, owner: { user: admin, cookie: cookieOf(admin) }, mk, port };
}
type Env = Awaited<ReturnType<typeof setup>>;

function stream(env: Env, cookie: string | undefined, query = '', host = HOST): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const events: SseEvent[] = [];
    const waiters: Array<() => void> = [];
    let buf = '';
    const req = http.get({
      host: '127.0.0.1', port: env.port, path: `/__lager/room/events${query}`, headers: { Host: host, ...(cookie ? { Cookie: cookie } : {}) },
    }, (res) => {
      const ended = new Promise<void>((done) => { res.on('end', done); res.on('close', done); });
      if (res.statusCode !== 200) { res.resume(); resolve({ status: res.statusCode!, events, ended, next: () => Promise.reject(new Error('no stream')), close: () => req.destroy(), hello: null }); return; }
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
        status: 200, events, ended, close: () => req.destroy(), hello: null,
        async next(event) {
          const deadline = Date.now() + 2000;
          for (;;) {
            const i = events.findIndex((e) => e.event === event);
            if (i >= 0) return events.splice(i, 1)[0].data;
            if (Date.now() > deadline) throw new Error(`no ${event} event within 2s; got ${JSON.stringify(events)}`);
            await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 50); });
          }
        },
      };
      void s.next('hello').then((hello) => { s.hello = hello; resolve(s); }, reject);
    });
    opened.push(req);
    req.on('error', (e) => { if (!(e as NodeJS.ErrnoException).code?.includes('ECONNRESET')) reject(e); });
  });
}

function post(env: Env, cookie: string | undefined, body: unknown, opts: { header?: boolean; host?: string } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: env.port, path: '/__lager/room', method: 'POST',
      headers: {
        Host: opts.host ?? HOST, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
        ...(opts.header === false ? {} : { 'X-Lager-Request': '1' }), ...(cookie ? { Cookie: cookie } : {}),
      },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode!, body: text.startsWith('{') ? JSON.parse(text) : text }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

describe('room routes', () => {
  it('hello, then a message emitted by the owner reaches a second viewer', async () => {
    const env = await setup();
    const viewer = env.mk('v@x.y', 'view');
    const a = await stream(env, viewer.cookie);
    expect(a.hello.peers).toEqual([expect.objectContaining({ peer: a.hello.peer, by: viewer.user.id, guest: false, kind: 'viewer', presence: {} })]);
    expect(a.hello.secret).toBeUndefined();
    const o = await stream(env, env.owner.cookie);
    const joined = await a.next('peers');
    expect(joined.joined).toEqual([expect.objectContaining({ peer: o.hello.peer, by: env.admin.id })]);
    const res = await post(env, env.owner.cookie, { room: '', peer: o.hello.peer, op: 'emit', topic: 'hi', data: { n: 1 } });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(await a.next('message')).toEqual({ topic: 'hi', data: { n: 1 }, from: expect.objectContaining({ peer: o.hello.peer, by: env.admin.id, guest: false }) });
    expect((await o.next('message')).topic).toBe('hi');
  });

  it('interact viewer may emit an opened topic but not another one', async () => {
    const env = await setup();
    const i = env.mk('i@x.y', 'interact');
    const s = await stream(env, i.cookie);
    const send = (topic: string) => post(env, i.cookie, { room: '', peer: s.hello.peer, op: 'emit', topic, data: 1 });
    expect((await send('move')).status).toBe(200);
    const denied = await send('reset');
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('forbidden');
    expect((await send('constructor')).status).toBe(403);
    expect((await send('__proto__')).status).toBe(403);
  });

  it('view-level viewer cannot emit but can set presence', async () => {
    const env = await setup();
    const v = env.mk('v@x.y', 'view');
    const watcher = await stream(env, env.owner.cookie);
    const s = await stream(env, v.cookie);
    expect((await post(env, v.cookie, { room: '', peer: s.hello.peer, op: 'emit', topic: 'move', data: 1 })).status).toBe(403);
    expect((await post(env, v.cookie, { room: '', peer: s.hello.peer, op: 'presence', patch: { cursor: [1, 2] } })).status).toBe(200);
    let updated: unknown[] = [];
    while (updated.length === 0) updated = (await watcher.next('peers')).updated;
    expect(updated).toEqual([expect.objectContaining({ peer: s.hello.peer, presence: { cursor: [1, 2] } })]);
  });

  it('a peer id of another viewer cannot be used', async () => {
    const env = await setup();
    const a = env.mk('a@x.y', 'admin');
    const b = env.mk('b@x.y', 'admin');
    const sa = await stream(env, a.cookie);
    expect((await post(env, b.cookie, { room: '', peer: sa.hello.peer, op: 'presence', patch: { x: 1 } })).status).toBe(403);
    expect((await post(env, b.cookie, { room: '', peer: 'unknown', op: 'presence', patch: { x: 1 } })).status).toBe(403);
    // right viewer, wrong room
    expect((await post(env, a.cookie, { room: 'other', peer: sa.hello.peer, op: 'presence', patch: { x: 1 } })).status).toBe(403);
    expect((await post(env, a.cookie, { room: '', peer: sa.hello.peer, op: 'presence', patch: { x: 1 } })).status).toBe(200);
  });

  it('a peer id from another instance cannot be used', async () => {
    const env = await setup();
    env.core.apps.deploy({ slug: 'room2', html: '<p>x</p>', userId: env.h.adminId, capabilities: CAPS });
    const s = await stream(env, env.owner.cookie);
    const inst2 = env.core.apps.getInstanceBySlug('room2')!;
    const c2 = 'lager_inst=' + signToken({ uid: env.admin.id, iid: inst2.id, k: 'inst', ep: 0 }, 'test-secret', 600);
    expect((await post(env, c2, { room: '', peer: s.hello.peer, op: 'presence', patch: { x: 1 } }, { host: 'room2.apps.localhost' })).status).toBe(403);
  });

  it('sender identity comes from the session', async () => {
    const env = await setup();
    const v = env.mk('v@x.y', 'admin');
    const listener = await stream(env, env.owner.cookie);
    const s = await stream(env, v.cookie, '?by=x&guest=true');
    await listener.next('peers');
    await post(env, v.cookie, { room: '', peer: s.hello.peer, op: 'emit', topic: 'hi', by: env.admin.id, guest: true, from: { by: 'x' } });
    expect((await listener.next('message')).from).toMatchObject({ by: v.user.id, guest: false });
    await post(env, v.cookie, { room: '', peer: s.hello.peer, op: 'presence', patch: { by: 'spoof', guest: true } });
    const p = await listener.next('peers');
    expect(p.updated[0]).toMatchObject({ by: v.user.id, guest: false, presence: { by: 'spoof', guest: true } });
  });

  it('guests are marked as such and need their stream secret', async () => {
    const env = await setup('public');
    const g1 = await stream(env, undefined);
    const g2 = await stream(env, undefined);
    expect(g1.hello.peers.find((p: any) => p.peer === g1.hello.peer)).toMatchObject({ by: null, guest: true });
    expect(typeof g1.hello.secret).toBe('string');
    expect(g1.hello.secret).not.toBe(g2.hello.secret);
    const body = (s: Stream, secret?: string) => ({ room: '', peer: s.hello.peer, op: 'presence', patch: { a: 1 }, ...(secret === undefined ? {} : { secret }) });
    expect((await post(env, undefined, body(g1))).status).toBe(403);
    expect((await post(env, undefined, body(g1, g2.hello.secret))).status).toBe(403);
    expect((await post(env, undefined, body(g1, 5 as never))).status).toBe(403);
    expect((await post(env, undefined, body(g1, g1.hello.secret))).status).toBe(200);
    // a guest cannot emit
    expect((await post(env, undefined, { room: '', peer: g1.hello.peer, op: 'emit', topic: 'move', secret: g1.hello.secret })).status).toBe(403);
    // a signed-in viewer cannot take over a guest's peer
    expect((await post(env, env.owner.cookie, body(g1))).status).toBe(403);
  });

  it('undeclared capability → 404', async () => {
    const env = await setup();
    const owner = 'lager_inst=' + signToken({ uid: env.admin.id, iid: env.core.apps.getInstanceBySlug('plain')!.id, k: 'inst', ep: 0 }, 'test-secret', 600);
    const s = await stream(env, owner, '', PLAIN);
    expect(s.status).toBe(404);
    expect((await post(env, owner, { room: '', peer: 'x', op: 'presence', patch: {} }, { host: PLAIN })).status).toBe(404);
  });

  it('private instance refuses anonymous streams and posts', async () => {
    const env = await setup('private');
    expect((await stream(env, undefined)).status).toBe(401);
    const outsider = env.mk('o@x.y');
    expect((await stream(env, outsider.cookie)).status).toBe(403);
    expect((await post(env, undefined, { room: '', peer: 'x', op: 'presence', patch: {} })).status).toBe(401);
  });

  it('a post needs the request header and a valid body', async () => {
    const env = await setup();
    const s = await stream(env, env.owner.cookie);
    const base = { room: '', peer: s.hello.peer };
    expect((await post(env, env.owner.cookie, { ...base, op: 'presence', patch: {} }, { header: false })).status).toBe(403);
    expect((await post(env, env.owner.cookie, { ...base, op: 'nope' })).status).toBe(400);
    expect((await post(env, env.owner.cookie, { ...base, op: 'presence', patch: [1] })).status).toBe(400);
    expect((await post(env, env.owner.cookie, { ...base, op: 'emit', topic: 5 })).status).toBe(400);
    expect((await post(env, env.owner.cookie, { ...base, op: 'emit', topic: 't', data: 'x'.repeat(70_000) })).status).toBe(400);
    expect((await post(env, env.owner.cookie, { ...base, op: 'emit', topic: 't', data: 'x'.repeat(140_000) })).status).toBe(413);
    expect((await post(env, env.owner.cookie, '[1]')).status).toBe(400);
  });

  it('a bad room name is refused before the stream opens', async () => {
    const env = await setup();
    const s = await stream(env, env.owner.cookie, '?room=a%20b');
    expect(s.status).toBe(400);
    const named = await stream(env, env.owner.cookie, '?room=game-1');
    expect(named.status).toBe(200);
    const lobby = await stream(env, env.owner.cookie);
    expect(lobby.hello.peers).toHaveLength(1);
    expect(named.hello.peers).toHaveLength(1);
  });

  it('closing the stream tells the others', async () => {
    const env = await setup();
    const a = await stream(env, env.owner.cookie);
    const b = await stream(env, env.owner.cookie);
    await a.next('peers');
    b.close();
    expect((await a.next('peers')).left).toEqual([expect.objectContaining({ peer: b.hello.peer })]);
    // the closed stream's peer id is dead
    expect((await post(env, env.owner.cookie, { room: '', peer: b.hello.peer, op: 'presence', patch: {} })).status).toBe(403);
  });

  it('stream ends when the session is revoked or the grant is withdrawn', async () => {
    const env = await setup();
    const e = env.mk('e@x.y', 'view');
    const f = env.mk('f@x.y', 'view');
    const gone = env.mk('g@x.y', 'view');
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const se = await stream(env, e.cookie);
    const sf = await stream(env, f.cookie);
    const sg = await stream(env, gone.cookie);
    const state = { e: false, f: false, g: false };
    void se.ended.then(() => { state.e = true; });
    void sf.ended.then(() => { state.f = true; });
    void sg.ended.then(() => { state.g = true; });
    vi.advanceTimersByTime(25_001);
    await new Promise((r) => setImmediate(r));
    expect(state).toEqual({ e: false, f: false, g: false });
    env.core.access.removeGrant(env.inst, 'user', e.user.id, env.admin);
    env.core.users.bumpEpoch(f.user.id);
    env.core.users.setDisabled(gone.user.id, true);
    vi.advanceTimersByTime(25_001);
    await Promise.all([se.ended, sf.ended, sg.ended]);
    expect(state).toEqual({ e: true, f: true, g: true });
    // and their peers are gone for the rest
    const rest = await stream(env, env.owner.cookie);
    expect(rest.hello.peers).toHaveLength(1);
  });

  it('stream ends when a new version drops the capability', async () => {
    const env = await setup();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const s = await stream(env, env.owner.cookie);
    env.core.apps.deploy({ slug: 'room', html: '<p>v2</p>', userId: env.h.adminId, capabilities: {} });
    vi.advanceTimersByTime(25_001);
    await s.ended;
  });

  it('rate limit', async () => {
    const env = await setup();
    const s = await stream(env, env.owner.cookie);
    const results: number[] = [];
    for (let i = 0; i < 31; i++) results.push((await post(env, env.owner.cookie, { room: '', peer: s.hello.peer, op: 'presence', patch: { i } })).status);
    expect(results.slice(0, 30).every((x) => x === 200)).toBe(true);
    expect(results[30]).toBe(429);
    // another peer has its own budget
    const t = await stream(env, env.owner.cookie);
    expect((await post(env, env.owner.cookie, { room: '', peer: t.hello.peer, op: 'presence', patch: { i: 1 } })).status).toBe(200);
  });

  it('a full room answers 409', async () => {
    const env = await setup();
    const streams: Stream[] = [];
    for (let i = 0; i < 200; i++) streams.push(await stream(env, env.owner.cookie, '?room=full'));
    expect((await stream(env, env.owner.cookie, '?room=full')).status).toBe(409);
  }, 30_000);
});
