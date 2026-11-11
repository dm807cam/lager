import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { GrantLevel } from '../src/platform/access.js';
import { signToken } from '../src/http/tokens.js';
import { makeHarness, type Harness } from './support/http.js';

let h: Harness | undefined;
let server: http.Server | undefined;
const opened: http.ClientRequest[] = [];
afterEach(async () => {
  for (const r of opened.splice(0)) r.destroy();
  server?.closeAllConnections();
  await new Promise((r) => (server ? server.close(r) : r(undefined)));
  server = undefined;
  h?.core.close();
  h = undefined;
});

const HOST = 'pollo.apps.localhost';
const SECOND = 'pollo-two.apps.localhost';
const PLAIN = 'plain.apps.localhost';

interface Res { status: number; body: any; text: string }

async function setup() {
  h = makeHarness();
  const core = h.core;
  const first = core.apps.deploy({ slug: 'pollo', html: '<p>v1</p>', userId: h.adminId, capabilities: { artifact: {} } });
  const inst = first.instances[0];
  const two = core.apps.createInstance({ appId: first.app.id, slug: 'pollo-two', ownerId: h.adminId });
  const plain = core.apps.deploy({ slug: 'plain', html: '<p>x</p>', userId: h.adminId }).instances[0];
  const admin = core.users.get(h.adminId)!;
  const cookieFor = (i: { id: string }, u: { id: string; sessionEpoch: number }) =>
    'lager_inst=' + signToken({ uid: u.id, iid: i.id, k: 'inst', ep: u.sessionEpoch }, 'test-secret', 600);
  const mk = (email: string, level: GrantLevel) => {
    const u = core.users.create({ email, name: email, password: 'pw-12345678', role: 'user' });
    core.access.setGrant(inst, 'user', u.id, level, admin);
    return { user: u, cookie: cookieFor(inst, u) };
  };
  server = http.createServer(h.app);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    core, inst, two, plain, admin, port, mk,
    owner: cookieFor(inst, admin), ownerTwo: cookieFor(two, admin), ownerPlain: cookieFor(plain, admin),
  };
}
type Env = Awaited<ReturnType<typeof setup>>;

function request(env: Env, method: string, path: string, host: string, cookie: string | undefined, body?: string, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: env.port, path, method,
      headers: { Host: host, ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}), ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let parsed: any = null;
        try { parsed = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode!, body: parsed, text });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const publish = (env: Env, cookie: string | undefined, payload: unknown, host = HOST, header = true): Promise<Res> =>
  request(env, 'POST', '/__lager/artifact', host, cookie, typeof payload === 'string' ? payload : JSON.stringify(payload), header ? { 'X-Lager-Request': '1' } : {});

function events(env: Env, cookie: string, host = HOST): Promise<{ next(event: string): Promise<any> }> {
  return new Promise((resolve, reject) => {
    const got: Array<{ event: string; data: any }> = [];
    const waiters: Array<() => void> = [];
    let buf = '';
    const req = http.get({ host: '127.0.0.1', port: env.port, path: '/__lager/db/events', headers: { Host: host, Cookie: cookie } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1]; const data = /^data: (.*)$/m.exec(block)?.[1];
          if (ev) got.push({ event: ev, data: data === undefined ? undefined : JSON.parse(data) });
        }
        waiters.splice(0).forEach((w) => w());
      });
      resolve({
        async next(event) {
          const deadline = Date.now() + 2000;
          for (;;) {
            const i = got.findIndex((e) => e.event === event);
            if (i >= 0) return got.splice(i, 1)[0].data;
            if (Date.now() > deadline) throw new Error(`no ${event} event; got ${JSON.stringify(got)}`);
            await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 50); });
          }
        },
      });
    });
    opened.push(req);
    req.on('error', reject);
  });
}

describe('POST /__lager/artifact', () => {
  it('owner publishes; the page then serves the new html', async () => {
    const env = await setup();
    const res = await publish(env, env.owner, { html: '<!doctype html><p>voted</p>', baseVersion: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: '2' });
    const page = await request(env, 'GET', '/', HOST, env.owner);
    expect(page.status).toBe(200);
    expect(page.text).toContain('<p>voted</p>');
    expect(env.core.apps.getInstance(env.inst.id)).toMatchObject({ activeVersion: 2, autoUpdate: false });
    const session = await request(env, 'GET', '/__lager/session', HOST, env.owner);
    expect(session.body.instance.version).toBe(2);
    // an editor with the admin grant may publish as well
    const adm = env.mk('adm@x.y', 'admin');
    expect((await publish(env, adm.cookie, { html: '<!doctype html><p>by admin</p>', baseVersion: 2 })).body).toEqual({ version: '3' });
  });

  it('reload event reaches a second open stream, and no other instance is told', async () => {
    const env = await setup();
    const a = await events(env, env.owner);
    const viewer = env.mk('v@x.y', 'view');
    const b = await events(env, viewer.cookie);
    const other = await events(env, env.ownerTwo, SECOND);
    expect((await publish(env, env.owner, { html: '<!doctype html><p>n</p>', baseVersion: 1 })).status).toBe(200);
    expect(await a.next('reload')).toEqual({ version: 2 });
    expect(await b.next('reload')).toEqual({ version: 2 });
    // another instance's stream stays quiet: its own activation is the first thing it hears
    env.core.apps.activate(env.two.id, 1, env.admin.id);
    expect(env.core.apps.getInstance(env.two.id)!.activeVersion).toBe(1);
    env.core.apps.deploy({ slug: 'pollo', html: '<p>d</p>', userId: env.admin.id });
    expect(await other.next('reload')).toEqual({ version: 3 });
  });

  it('interact viewer is forbidden; undeclared app is not_declared; anonymous is refused', async () => {
    const env = await setup();
    const i = env.mk('i@x.y', 'interact');
    const denied = await publish(env, i.cookie, { html: '<!doctype html><p>x</p>', baseVersion: 1 });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('forbidden');
    const none = await publish(env, env.ownerPlain, { html: '<!doctype html><p>x</p>', baseVersion: 1 }, PLAIN);
    expect(none.status).toBe(403);
    expect(none.body.error.code).toBe('not_declared');
    expect((await publish(env, undefined, { html: '<!doctype html><p>x</p>', baseVersion: 1 })).status).toBe(401);
    expect(env.core.apps.getInstance(env.inst.id)!.activeVersion).toBe(1);
  });

  it('accepts the self declaration as well', async () => {
    const env = await setup();
    env.core.apps.deploy({ slug: 'plain', html: '<p>x2</p>', userId: env.admin.id, capabilities: { self: {} } });
    expect((await publish(env, env.ownerPlain, { html: '<!doctype html><p>y</p>', baseVersion: 2 }, PLAIN)).body).toEqual({ version: '3' });
  });

  it('stale baseVersion → 409', async () => {
    const env = await setup();
    expect((await publish(env, env.owner, { html: '<!doctype html><p>a</p>', baseVersion: 1 })).status).toBe(200);
    const stale = await publish(env, env.owner, { html: '<!doctype html><p>b</p>', baseVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('conflict');
  });

  it('the other instance of the app keeps serving its own version', async () => {
    const env = await setup();
    await publish(env, env.owner, { html: '<!doctype html><p>state of one</p>', baseVersion: 1 });
    const other = await request(env, 'GET', '/', SECOND, env.ownerTwo);
    expect(other.text).toContain('<p>v1</p>');
    expect(other.text).not.toContain('state of one');
    // and it cannot reach the version through the API of its own
    expect(env.core.apps.getInstance(env.two.id)!.activeVersion).toBe(1);
  });

  it('61st publish within an hour → 429', async () => {
    const env = await setup();
    for (let n = 1; n <= 60; n++) {
      const r = await publish(env, env.owner, { html: `<!doctype html><p>${n}</p>`, baseVersion: n });
      expect(r.status).toBe(200);
    }
    const limited = await publish(env, env.owner, { html: '<!doctype html><p>61</p>', baseVersion: 61 });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('rate_limited');
    // another instance has its own budget
    expect((await publish(env, env.ownerTwo, { html: '<!doctype html><p>x</p>', baseVersion: 1 }, SECOND)).status).toBe(200);
  });

  it('oversized and empty html are refused', async () => {
    const env = await setup();
    const big = await publish(env, env.owner, { html: '<!doctype html>' + 'x'.repeat(16 * 1024 * 1024), baseVersion: 1 });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('too_large');
    const huge = await publish(env, env.owner, { html: '<!doctype html>' + 'x'.repeat(20 * 1024 * 1024), baseVersion: 1 });
    expect(huge.status).toBe(413);
    expect(huge.body.error.code).toBe('too_large');
    for (const bad of [{ html: '<p>not a document</p>', baseVersion: 1 }, { html: 'x<!doctype html>', baseVersion: 1 }, { html: '', baseVersion: 1 }, { html: '  \n', baseVersion: 1 }, { html: 5, baseVersion: 1 }, { html: '<p>x</p>' }, { html: '<!doctype html><p>x</p>', baseVersion: 'one' }, '[]', 'nope']) {
      const r = await publish(env, env.owner, bad);
      expect([r.status, r.body.error.code]).toEqual([400, 'invalid_content']);
    }
    expect(env.core.apps.getInstance(env.inst.id)!.activeVersion).toBe(1);
  });

  it('accepts a BOM and whitespace before a case-insensitive doctype', async () => {
    const env = await setup();
    const r = await publish(env, env.owner, { html: '\uFEFF \n<!DOCTYPE HTML><html></html>', baseVersion: 1 });
    expect(r.body).toEqual({ version: '2' });
  });

  it('{publish:false} refuses everyone with not_granted, under either name', async () => {
    const env = await setup();
    env.core.apps.deploy({ slug: 'plain', html: '<p>locked</p>', userId: env.admin.id, capabilities: { artifact: { publish: false } } });
    const r = await publish(env, env.ownerPlain, { html: '<!doctype html><p>y</p>', baseVersion: 2 }, PLAIN);
    expect([r.status, r.body.error.code]).toEqual([403, 'not_granted']);
    env.core.apps.deploy({ slug: 'plain', html: '<p>locked2</p>', userId: env.admin.id, capabilities: { self: { publish: false } } });
    const r2 = await publish(env, env.ownerPlain, { html: '<!doctype html><p>y</p>', baseVersion: 3 }, PLAIN);
    expect([r2.status, r2.body.error.code]).toEqual([403, 'not_granted']);
    expect(env.core.apps.getInstance(env.plain.id)!.activeVersion).toBe(3);
  });

  it('requires X-Lager-Request', async () => {
    const env = await setup();
    const r = await publish(env, env.owner, { html: '<!doctype html><p>x</p>', baseVersion: 1 }, HOST, false);
    expect(r.status).toBe(403);
    expect(env.core.apps.getInstance(env.inst.id)!.activeVersion).toBe(1);
  });
});
