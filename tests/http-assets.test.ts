import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { GrantLevel } from '../src/platform/access.js';
import { signToken } from '../src/http/tokens.js';
import { makeHarness, type Harness } from './support/http.js';

let h: Harness | undefined;
afterEach(() => { h?.core.close(); h = undefined; });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HOST = { up: 'up.apps.localhost', ia: 'ia.apps.localhost', plain: 'plain.apps.localhost' };

function setup(visibility: 'private' | 'users' | 'public' = 'private') {
  h = makeHarness();
  const core = h.core;
  const deploy = (slug: string, capabilities?: object) => core.apps.deploy({ slug, html: '<p>x</p>', userId: h!.adminId, capabilities }).instances[0];
  const up = deploy('up', { assets: {} });
  const ia = deploy('ia', { assets: { upload: 'interact' } });
  const plain = deploy('plain');
  for (const i of [up, ia, plain]) core.apps.setVisibility(i.id, visibility, h.adminId);
  const admin = core.users.get(h.adminId)!;
  const mk = (email: string) => core.users.create({ email, name: email, password: 'pw-12345678', role: 'user' });
  const grant = (inst: typeof up, u: { id: string }, level: GrantLevel) => core.access.setGrant(inst, 'user', u.id, level, admin);
  return { h, core, up, ia, plain, mk, grant };
}

async function cookieFor(h: Harness, slug: string, email: string): Promise<string> {
  return h.enter(slug, await h.login(email, email === 'admin@x.y' ? 'pw' : 'pw-12345678'));
}

const upload = (h: Harness, host: string, cookie: string | undefined, body: Buffer | string, type?: string, header = true) => {
  const r = request(h.app).post('/__lager/assets').set('Host', host);
  if (cookie) r.set('Cookie', cookie);
  if (header) r.set('X-Lager-Request', '1');
  if (type) r.set('Content-Type', type);
  return r.send(body);
};
const blob = (h: Harness, host: string, cookie: string | undefined, id: string) => {
  const r = request(h.app).get(`/_blob/${id}`).set('Host', host).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  return cookie ? r.set('Cookie', cookie) : r;
};
const list = (h: Harness, host: string, cookie: string) => request(h.app).get('/__lager/assets').set('Host', host).set('Cookie', cookie);
const del = (h: Harness, host: string, cookie: string, id: string) =>
  request(h.app).delete(`/__lager/assets/${id}`).set('Host', host).set('Cookie', cookie).set('X-Lager-Request', '1');

describe('assets routes', () => {
  it('owner uploads and the blob is served with safe headers', async () => {
    const { h } = setup();
    const c = await cookieFor(h, 'up', 'admin@x.y');
    const res = await upload(h, HOST.up, c, PNG, 'image/png');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ url: `/_blob/${res.body.id}`, sizeBytes: PNG.length, contentType: 'image/png' });
    const got = await blob(h, HOST.up, c, res.body.id);
    expect(got.status).toBe(200);
    expect(Buffer.from(got.body).equals(PNG)).toBe(true);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect(got.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(got.headers['content-disposition']).toBe('inline');
    expect(got.headers['content-security-policy']).toBeUndefined();
    const range = await blob(h, HOST.up, c, res.body.id).set('Range', 'bytes=0-3');
    expect(range.status).toBe(206);
    expect(Buffer.from(range.body).equals(PNG.subarray(0, 4))).toBe(true);
    expect((await blob(h, HOST.up, c, 'f'.repeat(32))).status).toBe(404);
    expect((await blob(h, HOST.up, c, '..%2f..%2fx')).status).toBe(404);
  });

  it('svg is served sandboxed', async () => {
    const { h } = setup();
    const c = await cookieFor(h, 'up', 'admin@x.y');
    const res = await upload(h, HOST.up, c, SVG, 'image/svg+xml');
    expect(res.status).toBe(201);
    const got = await blob(h, HOST.up, c, res.body.id);
    expect(got.headers['content-type']).toBe('image/svg+xml');
    expect(got.headers['content-security-policy']).toBe("sandbox; default-src 'none'; style-src 'unsafe-inline'");
    expect(got.headers['x-content-type-options']).toBe('nosniff');
  });

  it('html is refused; script text declared text/plain is served as plain text', async () => {
    const { h } = setup();
    const c = await cookieFor(h, 'up', 'admin@x.y');
    const bad = await upload(h, HOST.up, c, '<html></html>', 'text/html');
    expect(bad.status).toBe(400);
    expect(bad.body.error.reason).toBe('unsupported_type');
    const ok = await upload(h, HOST.up, c, '<script>alert(1)</script>', 'text/plain');
    expect(ok.status).toBe(201);
    const got = await blob(h, HOST.up, c, ok.body.id);
    expect(got.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(got.headers['content-disposition']).toBe('attachment');
    expect(got.headers['content-security-policy']).toContain('sandbox');
    const mismatch = await upload(h, HOST.up, c, '<html>', 'image/png');
    expect(mismatch.status).toBe(400);
    expect((await upload(h, HOST.up, c, Buffer.alloc(0), 'text/plain')).status).toBe(400);
    expect((await upload(h, HOST.up, c, 'x')).status).toBe(400);
  });

  it('undeclared capability answers 404 and the session shows none', async () => {
    const { h, plain } = setup();
    const c = await cookieFor(h, 'plain', 'admin@x.y');
    expect((await upload(h, HOST.plain, c, PNG, 'image/png')).status).toBe(404);
    expect((await list(h, HOST.plain, c)).status).toBe(404);
    expect((await del(h, HOST.plain, c, 'a'.repeat(32))).status).toBe(404);
    const s = await request(h.app).get('/__lager/session').set('Host', HOST.plain).set('Cookie', c);
    expect(s.body.capabilities.assets).toBeUndefined();
    expect(plain.slug).toBe('plain');
  });

  it('interact uploader with upload:"interact" sees and deletes only own files', async () => {
    const { h, ia, mk, grant } = setup();
    const ann = mk('ann@x.y'); const bob = mk('bob@x.y');
    grant(ia, ann, 'interact'); grant(ia, bob, 'interact');
    const [ca, cb, co] = await Promise.all([cookieFor(h, 'ia', 'ann@x.y'), cookieFor(h, 'ia', 'bob@x.y'), cookieFor(h, 'ia', 'admin@x.y')]);
    const mine = await upload(h, HOST.ia, ca, PNG, 'image/png');
    const theirs = await upload(h, HOST.ia, cb, PNG, 'image/png');
    expect(mine.status).toBe(201);
    const l = await list(h, HOST.ia, ca);
    expect(l.body.assets.map((a: { id: string }) => a.id)).toEqual([mine.body.id]);
    expect(l.body.usage).toMatchObject({ files: 2, bytes: PNG.length * 2, maxFiles: 2000 });
    expect(l.body.usage.maxBytes).toBeGreaterThanOrEqual(PNG.length * 2);
    expect((await del(h, HOST.ia, ca, theirs.body.id)).status).toBe(403);
    expect((await del(h, HOST.ia, ca, mine.body.id)).body).toEqual({ deleted: true });
    expect((await del(h, HOST.ia, ca, mine.body.id)).body).toEqual({ deleted: false });
    expect((await list(h, HOST.ia, co)).body.assets).toHaveLength(1);
    expect((await del(h, HOST.ia, co, theirs.body.id)).body).toEqual({ deleted: true });
    expect((await blob(h, HOST.ia, ca, mine.body.id)).status).toBe(404);
  });

  it('interact cannot upload without the declaration', async () => {
    const { h, up, mk, grant } = setup();
    grant(up, mk('ann@x.y'), 'interact');
    const c = await cookieFor(h, 'up', 'ann@x.y');
    expect((await upload(h, HOST.up, c, PNG, 'image/png')).status).toBe(403);
    expect((await list(h, HOST.up, c)).status).toBe(403);
  });

  it('view-level viewer can read a blob but not list or upload', async () => {
    const { h, ia, mk, grant } = setup();
    grant(ia, mk('ann@x.y'), 'view');
    const owner = await cookieFor(h, 'ia', 'admin@x.y');
    const a = await upload(h, HOST.ia, owner, PNG, 'image/png');
    const c = await cookieFor(h, 'ia', 'ann@x.y');
    expect((await blob(h, HOST.ia, c, a.body.id)).status).toBe(200);
    expect((await list(h, HOST.ia, c)).status).toBe(403);
    expect((await upload(h, HOST.ia, c, PNG, 'image/png')).status).toBe(403);
    expect((await del(h, HOST.ia, c, a.body.id)).status).toBe(403);
  });

  it('private instance: anonymous and unrelated users are refused like the page', async () => {
    const { h, mk, up } = setup();
    const owner = await cookieFor(h, 'up', 'admin@x.y');
    const a = await upload(h, HOST.up, owner, PNG, 'image/png');
    const eve = mk('eve@x.y');
    // Eve cannot pass the handshake for a private instance, so present a validly signed instance cookie.
    const eveCookie = `lager_inst=${signToken({ uid: eve.id, iid: up.id, k: 'inst', ep: eve.sessionEpoch }, 'test-secret', 3600)}`;
    expect((await blob(h, HOST.up, undefined, a.body.id)).status).toBe(401);
    expect((await blob(h, HOST.up, eveCookie, a.body.id)).status).toBe(403);
  });

  it('public instance: anonymous may read a blob but nothing else', async () => {
    const { h } = setup('public');
    const owner = await cookieFor(h, 'up', 'admin@x.y');
    const a = await upload(h, HOST.up, owner, PNG, 'image/png');
    expect((await blob(h, HOST.up, undefined, a.body.id)).status).toBe(200);
    expect((await upload(h, HOST.up, undefined, PNG, 'image/png')).status).toBe(403);
    expect((await request(h.app).get('/__lager/assets').set('Host', HOST.up)).status).toBe(403);
  });

  it('requires X-Lager-Request', async () => {
    const { h } = setup();
    const c = await cookieFor(h, 'up', 'admin@x.y');
    expect((await upload(h, HOST.up, c, PNG, 'image/png', false)).status).toBe(403);
    const a = await upload(h, HOST.up, c, PNG, 'image/png');
    const res = await request(h.app).delete(`/__lager/assets/${a.body.id}`).set('Host', HOST.up).set('Cookie', c);
    expect(res.status).toBe(403);
    expect((await blob(h, HOST.up, c, a.body.id)).status).toBe(200);
  });

  it('413 for oversized bodies', async () => {
    const { h } = setup();
    const c = await cookieFor(h, 'up', 'admin@x.y');
    expect((await upload(h, HOST.up, c, Buffer.alloc(20 * 1024 * 1024 + 2, 0x61), 'text/plain')).status).toBe(413);
    const svg = Buffer.concat([Buffer.from('<svg>'), Buffer.alloc(2 * 1024 * 1024)]);
    const res = await upload(h, HOST.up, c, svg, 'image/svg+xml');
    expect(res.status).toBe(413);
    expect(res.body.error.reason).toBe('too_large');
  });

  it('quota exhaustion answers 507, a deleted instance drops its assets handle', async () => {
    h = makeHarness({ instanceQuotaBytes: 100_000 });
    const inst = h.core.apps.deploy({ slug: 'up', html: '<p>x</p>', userId: h.adminId, capabilities: { assets: {} } }).instances[0];
    const c = await cookieFor(h, 'up', 'admin@x.y');
    expect((await upload(h, HOST.up, c, Buffer.alloc(60_000, 0x61), 'text/plain')).status).toBe(201);
    expect((await upload(h, HOST.up, c, Buffer.alloc(60_000, 0x61), 'text/plain')).status).toBe(507);
    h.core.apps.deleteInstance(inst.id, h.adminId);
    expect(h.core.assets.list(inst.id)).toEqual([]);
  });
});
