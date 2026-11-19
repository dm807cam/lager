import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
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

const HOST = 'room.apps.localhost';

async function setup(visibility: 'private' | 'public' = 'private') {
  h = makeHarness({ trustProxy: 1 });
  const core = h.core;
  const inst = core.apps.deploy({ slug: 'room', html: '<p>x</p>', userId: h.adminId, capabilities: { room: {}, assets: {} } }).instances[0];
  core.apps.setVisibility(inst.id, visibility, h.adminId);
  const admin = core.users.get(h.adminId)!;
  const cookie = 'lager_inst=' + signToken({ uid: admin.id, iid: inst.id, k: 'inst', ep: admin.sessionEpoch }, 'test-secret', 600);
  const asset = core.assets.put(inst.id, Buffer.from('hello'), 'text/plain', admin.id);
  server = http.createServer(h.app);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, cookie, assetId: asset.id };
}

/** Resolves with the status once headers arrive; an event stream stays open until the afterEach hook. */
function get(env: { port: number }, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: env.port, path, headers: { Host: HOST, ...headers } }, (res) => { res.resume(); resolve(res.statusCode!); });
    req.on('error', reject);
    opened.push(req);
  });
}

describe('same-origin guard on streams and blobs', () => {
  it.each(['/__lager/db/events', '/__lager/room/events'])('%s refuses foreign callers and serves its own', async (path) => {
    const env = await setup();
    const c = { Cookie: env.cookie };
    expect(await get(env, path, { ...c, Origin: 'http://other.apps.localhost' })).toBe(403);
    expect(await get(env, path, { ...c, 'Sec-Fetch-Site': 'same-site' })).toBe(403);
    expect(await get(env, path, { ...c, 'Sec-Fetch-Site': 'cross-site' })).toBe(403);
    expect(await get(env, path, c)).toBe(200);
    expect(await get(env, path, { ...c, Origin: `http://${HOST}`, 'Sec-Fetch-Site': 'same-origin' })).toBe(200);
    expect(await get(env, path, { ...c, 'Sec-Fetch-Site': 'none' })).toBe(200);
  });

  it('judges the origin by the forwarded scheme and host behind a proxy', async () => {
    const env = await setup();
    const c = { Cookie: env.cookie, 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': HOST };
    expect(await get(env, '/__lager/db/events', { ...c, Origin: `https://${HOST}` })).toBe(200);
    expect(await get(env, '/__lager/db/events', { ...c, Origin: `http://${HOST}` })).toBe(403);
  });

  it('refuses same-site and cross-site embedding of blobs only', async () => {
    const env = await setup();
    const path = `/_blob/${env.assetId}`;
    const c = { Cookie: env.cookie };
    expect(await get(env, path, { ...c, 'Sec-Fetch-Site': 'same-site' })).toBe(403);
    expect(await get(env, path, { ...c, 'Sec-Fetch-Site': 'cross-site' })).toBe(403);
    expect(await get(env, path, c)).toBe(200);
    expect(await get(env, path, { ...c, 'Sec-Fetch-Site': 'same-origin' })).toBe(200);
  });
});

describe('db event stream limits', () => {
  it('admits 8 streams per signed-in user, then answers 429 before opening one', async () => {
    const env = await setup();
    for (let i = 0; i < 8; i++) expect(await get(env, '/__lager/db/events', { Cookie: env.cookie })).toBe(200);
    expect(await get(env, '/__lager/db/events', { Cookie: env.cookie })).toBe(429);
    // The room streams have their own budget.
    expect(await get(env, '/__lager/room/events', { Cookie: env.cookie })).toBe(200);
  });

  it('admits 8 streams per guest IP', async () => {
    const env = await setup('public');
    for (let i = 0; i < 8; i++) expect(await get(env, '/__lager/db/events')).toBe(200);
    expect(await get(env, '/__lager/db/events')).toBe(429);
  });

  it('frees a slot when a stream closes', async () => {
    const env = await setup();
    for (let i = 0; i < 8; i++) await get(env, '/__lager/db/events', { Cookie: env.cookie });
    opened.shift()!.destroy();
    await new Promise((r) => setTimeout(r, 100));
    expect(await get(env, '/__lager/db/events', { Cookie: env.cookie })).toBe(200);
  });
});

describe('language switch', () => {
  it('does not store the language of a signed-in account on a cross-site or same-site request, but sets the cookie', async () => {
    h = makeHarness();
    const cookie = await h.login();
    const cross = await request(h.app).get('/lang/de').set('Host', h.host).set('Cookie', cookie).set('Sec-Fetch-Site', 'cross-site');
    expect(cross.headers['set-cookie'].join(';')).toMatch(/lager_lang=de/);
    expect(h.core.users.get(h.adminId)!.locale).not.toBe('de');
    // An instance is same-site with the platform, and its code is not the account's owner either.
    await request(h.app).get('/lang/de').set('Host', h.host).set('Cookie', cookie).set('Sec-Fetch-Site', 'same-site');
    expect(h.core.users.get(h.adminId)!.locale).not.toBe('de');
    // A typed address or a bookmark ("none") and a browser that sends no header at all still switch.
    await request(h.app).get('/lang/fr').set('Host', h.host).set('Cookie', cookie).set('Sec-Fetch-Site', 'none');
    expect(h.core.users.get(h.adminId)!.locale).toBe('fr');
    await request(h.app).get('/lang/es').set('Host', h.host).set('Cookie', cookie);
    expect(h.core.users.get(h.adminId)!.locale).toBe('es');
    await request(h.app).get('/lang/de').set('Host', h.host).set('Cookie', cookie).set('Sec-Fetch-Site', 'same-origin');
    expect(h.core.users.get(h.adminId)!.locale).toBe('de');
  });
});
