import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { INGEST_NOTIFY_MS } from '../src/data/store.js';
import type { HubEvent } from '../src/data/hub.js';
import { INGEST_LIMITS } from '../src/platform/ingest.js';
import { makeHarness, type Harness, type HarnessOptions } from './support/http.js';

let h: Harness | undefined;
afterEach(() => { vi.useRealTimers(); h?.core.close(); h = undefined; });

const HOST = 'stats.apps.localhost';
const BLOG = 'https://blog.example.com';
const ENDPOINTS = [
  { name: 'hits', auth: 'none', origins: [BLOG, 'http://localhost:4000'] },
  { name: 'weight', collection: 'log/main/weights', auth: 'token', maxBytes: 200 },
];

function setup(opts: { endpoints?: object[]; rules?: object[]; visibility?: 'private' | 'users' | 'public' } & HarnessOptions = {}) {
  const { endpoints, rules, visibility, ...harness } = opts;
  h = makeHarness(harness);
  const caps = { db: rules ? { rules } : {}, ingest: { endpoints: endpoints ?? ENDPOINTS } };
  const r = h.core.apps.deploy({ slug: 'stats', html: '<html><head></head><body>stats</body></html>', userId: h.adminId, capabilities: caps as never });
  if (visibility) h.core.apps.setVisibility(r.instances[0].id, visibility, h.adminId);
  return { h, inst: r.instances[0] };
}

/** A request as the blog's page would send it; `origin: null` sends no Origin header at all. */
const hit = (h: Harness, body: unknown = { path: '/' }, origin: string | null = BLOG) => {
  const req = request(h.app).post('/_ingest/hits').set('Host', HOST).type('text/plain');
  if (origin !== null) req.set('Origin', origin);
  return req.send(typeof body === 'string' ? body : JSON.stringify(body));
};
const docs = (h: Harness, instId: string, collection = 'hits') => h.core.data.query(instId, collection);

describe('POST /_ingest/<name>: who may send', () => {
  it('a page on a listed origin adds a document to a private instance and learns nothing back', async () => {
    const { h, inst } = setup();
    const res = await hit(h, { path: '/hello', ref: 'https://news.example' });
    expect(res.status).toBe(202);
    expect(res.text).toBe('');
    expect(res.headers['access-control-allow-origin']).toBe(BLOG);
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    expect(res.headers.vary).toMatch(/Origin/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['set-cookie']).toBeUndefined();
    const [doc] = docs(h, inst.id);
    expect(doc.data).toMatchObject({ path: '/hello', ref: 'https://news.example' });
    expect(doc.updatedBy).toBeNull();
    // The id is the server's: 20 letters and digits.
    expect(doc.id).toMatch(/^[A-Za-z0-9]{20}$/);
  });

  it('refuses an origin that is not listed, a missing one and "null", and stores nothing', async () => {
    const { h, inst } = setup();
    for (const origin of ['https://evil.example', 'https://blog.example.com.evil.example', 'null', null, 'https://blog.example.com:8443']) {
      const res = await hit(h, { path: '/' }, origin);
      expect(res.status, String(origin)).toBe(403);
      expect(res.headers['access-control-allow-origin'], String(origin)).toBeUndefined();
    }
    expect(docs(h, inst.id)).toEqual([]);
    expect(h.core.ingest.countsOf(inst.id, 'hits')).toEqual({ accepted: 0, refused: 5, limited: 0 });
  });

  it('compares origins without regard to letter case', async () => {
    const { h } = setup();
    expect((await hit(h, { path: '/' }, 'HTTPS://Blog.Example.com')).status).toBe(202);
  });

  it('answers the preflight for a listed origin only', async () => {
    const { h } = setup();
    const ok = await request(h.app).options('/_ingest/hits').set('Host', HOST).set('Origin', BLOG).set('Access-Control-Request-Method', 'POST');
    expect(ok.status).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe(BLOG);
    expect(ok.headers['access-control-allow-methods']).toBe('POST');
    expect(ok.headers['access-control-allow-headers']).toBe('Content-Type');
    const no = await request(h.app).options('/_ingest/hits').set('Host', HOST).set('Origin', 'https://evil.example');
    expect(no.status).toBe(403);
    expect(no.headers['access-control-allow-origin']).toBeUndefined();
    // A token endpoint without origins is for scripts: no browser on another site gets through the preflight.
    const script = await request(h.app).options('/_ingest/weight').set('Host', HOST).set('Origin', BLOG);
    expect(script.status).toBe(403);
  });

  it('a token endpoint takes the token as a header or as ?key=, and nothing else', async () => {
    const { h, inst } = setup();
    const token = h.core.ingest.token(inst.id, 'weight');
    expect(token).toMatch(/^lgi_[A-Za-z0-9_-]{43}$/);
    const send = (set: (r: request.Test) => request.Test) => set(request(h!.app).post('/_ingest/weight').set('Host', HOST)).send({ kg: 71.5 });
    expect((await send((r) => r.set('Authorization', `Bearer ${token}`))).status).toBe(202);
    expect((await send((r) => r.query({ key: token }))).status).toBe(202);
    const none = await send((r) => r);
    expect(none.status).toBe(401);
    expect(none.headers['www-authenticate']).toBe('Bearer');
    expect((await send((r) => r.set('Authorization', `Bearer ${token}x`))).status).toBe(401);
    expect((await send((r) => r.query({ key: h!.core.ingest.token(inst.id, 'hits') }))).status).toBe(401);
    expect((await send((r) => r.query({ key: [token, token] }))).status).toBe(401);
    // An origin does not stand in for the token.
    expect((await send((r) => r.set('Origin', BLOG))).status).toBe(401);
    expect(docs(h, inst.id, 'log/main/weights')).toHaveLength(2);
    expect(docs(h, inst.id, 'log/main/weights')[0].data).toMatchObject({ kg: 71.5 });
  });

  it('the token of one instance does not open the same endpoint of another', async () => {
    const { h, inst } = setup();
    const other = h.core.apps.createInstance({ appId: inst.appId, slug: 'stats-two', ownerId: h.adminId });
    const res = await request(h.app).post('/_ingest/weight').set('Host', 'stats-two.apps.localhost').set('Authorization', `Bearer ${h.core.ingest.token(inst.id, 'weight')}`).send({ kg: 1 });
    expect(res.status).toBe(401);
    expect(h.core.ingest.token(other.id, 'weight')).not.toBe(h.core.ingest.token(inst.id, 'weight'));
  });

  it('a replaced token stops working at once and the new one works', async () => {
    const { h, inst } = setup();
    const before = h.core.ingest.token(inst.id, 'weight');
    h.core.ingest.rotateToken(inst.id, 'weight');
    const after = h.core.ingest.token(inst.id, 'weight');
    expect(after).not.toBe(before);
    const send = (token: string) => request(h!.app).post('/_ingest/weight').set('Host', HOST).set('Authorization', `Bearer ${token}`).send({ kg: 70 });
    expect((await send(before)).status).toBe(401);
    expect((await send(after)).status).toBe(202);
  });

  it('wrong tokens from one address are no longer looked at after a while, also the right one', async () => {
    const { h, inst } = setup();
    const send = (token: string) => request(h!.app).post('/_ingest/weight').set('Host', HOST).set('Authorization', `Bearer ${token}`).send({ kg: 70 });
    for (let i = 0; i < INGEST_LIMITS.badTokens; i++) expect((await send('lgi_wrong')).status).toBe(401);
    const blocked = await send(h.core.ingest.token(inst.id, 'weight'));
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBe('60');
    expect(docs(h, inst.id, 'log/main/weights')).toEqual([]);
  });

  it('with origins ["*"] a token endpoint can be called from any website', async () => {
    const { h, inst } = setup({ endpoints: [{ name: 'weight', auth: 'token', origins: ['*'] }] });
    const pre = await request(h.app).options('/_ingest/weight').set('Host', HOST).set('Origin', 'https://anything.example');
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('*');
    expect(pre.headers['access-control-allow-headers']).toBe('Authorization, Content-Type');
    const res = await request(h.app).post('/_ingest/weight').set('Host', HOST).set('Origin', 'https://anything.example').set('Authorization', `Bearer ${h.core.ingest.token(inst.id, 'weight')}`).send({ kg: 1 });
    expect(res.status).toBe(202);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});

describe('POST /_ingest/<name>: what it cannot do', () => {
  it('ignores the session cookie: the owner\'s browser is as anonymous as any other', async () => {
    const { h, inst } = setup();
    const cookie = await h.enter('stats', await h.login());
    // The owner may write anywhere, but through the endpoint the request is still held to the origin list…
    expect((await request(h.app).post('/_ingest/hits').set('Host', HOST).set('Cookie', cookie).set('Origin', 'https://evil.example').send({ a: 1 })).status).toBe(403);
    // …and what it stores carries nobody's name.
    expect((await request(h.app).post('/_ingest/hits').set('Host', HOST).set('Cookie', cookie).set('Origin', BLOG).send({ a: 1 })).status).toBe(202);
    expect(docs(h, inst.id)[0].updatedBy).toBeNull();
    expect(h.core.data.hasAuthor(inst.id, h.adminId)).toBe(false);
  });

  it('only appends: GET, PUT, PATCH and DELETE are refused, and a path below the endpoint does not exist', async () => {
    const { h, inst } = setup();
    await hit(h, { n: 1 });
    const [doc] = docs(h, inst.id);
    for (const method of ['get', 'put', 'patch', 'delete'] as const) {
      const res = await request(h.app)[method]('/_ingest/hits').set('Host', HOST).set('Origin', BLOG);
      expect(res.status, method).toBe(405);
      expect(res.headers.allow).toBe('POST, OPTIONS');
      expect(res.text).not.toContain(doc.id);
    }
    expect((await request(h.app).post(`/_ingest/hits/${doc.id}`).set('Host', HOST).set('Origin', BLOG).send({ n: 2 })).status).toBe(404);
    expect(docs(h, inst.id)).toHaveLength(1);
    expect(docs(h, inst.id)[0].data).toMatchObject({ n: 1 });
  });

  it('takes one JSON object and refuses everything else', async () => {
    const { h, inst } = setup();
    for (const body of ['', 'not json', '[1,2]', '"text"', '42', 'null', '{"__proto__":{"x":1}}', JSON.stringify({ n: 1e400 }).replace('null', '1e400')]) {
      expect((await hit(h, body)).status, body).toBe(400);
    }
    // 33 levels deep: one more than a document may have.
    expect((await hit(h, '{"a":'.repeat(33) + '1' + '}'.repeat(33))).status).toBe(400);
    expect(docs(h, inst.id)).toEqual([]);
  });

  it('holds a request to the endpoint\'s size, before and after reading it', async () => {
    const { h, inst } = setup();
    const token = h.core.ingest.token(inst.id, 'weight');
    const send = (note: string) => request(h!.app).post('/_ingest/weight').set('Host', HOST).set('Authorization', `Bearer ${token}`).type('json').send(JSON.stringify({ note }));
    expect((await send('x'.repeat(150))).status).toBe(202);
    expect((await send('x'.repeat(300))).status).toBe(413);
    // The default applies where the endpoint names none.
    expect((await hit(h, { text: 'x'.repeat(INGEST_LIMITS.defaultMaxBytes) })).status).toBe(413);
    expect((await hit(h, { text: 'x'.repeat(INGEST_LIMITS.defaultMaxBytes - 100) })).status).toBe(202);
    // A compressed body is not unpacked.
    expect((await request(h.app).post('/_ingest/hits').set('Host', HOST).set('Origin', BLOG).set('Content-Encoding', 'gzip').send(Buffer.from([31, 139, 8, 0]))).status).toBe(415);
  });

  it('an unknown endpoint, a version without the endpoint, a disabled instance and an unknown instance all answer 404', async () => {
    const { h, inst } = setup();
    expect((await request(h.app).post('/_ingest/nothing').set('Host', HOST).set('Origin', BLOG).send({})).status).toBe(404);
    // The declaration comes from the active version: a deploy without it closes the endpoint.
    h.core.apps.deploy({ slug: 'stats', html: '<p>v2</p>', userId: h.adminId, capabilities: { db: {} } });
    expect((await hit(h)).status).toBe(404);
    h.core.apps.activate(inst.id, 1, h.adminId);
    expect((await hit(h)).status).toBe(202);
    h.core.apps.setInstanceDisabled(inst.id, true);
    expect((await hit(h)).status).toBe(404);
    expect((await request(h.app).post('/_ingest/hits').set('Host', 'nobody.apps.localhost').set('Origin', BLOG).send({})).status).toBe(404);
  });

  it('a declaration that does not parse opens nothing', async () => {
    const { h, inst } = setup({ endpoints: [{ name: 'hits', auth: 'none', origins: ['*'] }] });
    expect((await hit(h)).status).toBe(404);
    expect(docs(h, inst.id)).toEqual([]);
  });

  it('with LAGER_INGEST_QUOTA_MB=0 no endpoint answers', async () => {
    const { h, inst } = setup({ ingestQuotaBytes: 0 });
    expect((await hit(h)).status).toBe(404);
    expect(docs(h, inst.id)).toEqual([]);
  });

  it('a switched-off endpoint answers like a missing one until it is switched on again', async () => {
    const { h, inst } = setup();
    h.core.ingest.setOff(inst.id, 'hits', true);
    expect((await hit(h)).status).toBe(404);
    expect(h.core.ingest.countsOf(inst.id, 'hits').refused).toBe(1);
    h.core.ingest.setOff(inst.id, 'hits', false);
    expect((await hit(h)).status).toBe(202);
  });
});

describe('POST /_ingest/<name>: what the server adds', () => {
  it('writes _receivedAt itself and drops what the client sends under the server\'s field names', async () => {
    const { h, inst } = setup();
    const before = Date.now();
    await hit(h, { path: '/', _receivedAt: '1999-01-01T00:00:00.000Z', _visitor: 'me', _country: 'XX', _links: { self: '/x' } });
    const { data } = docs(h, inst.id)[0];
    expect(Date.parse(data._receivedAt as string)).toBeGreaterThanOrEqual(before);
    expect(data).not.toHaveProperty('_visitor');
    expect(data).not.toHaveProperty('_country');
    // Other fields that start with an underscore are the sender's own.
    expect(data._links).toEqual({ self: '/x' });
  });

  it('never stores the client address, the user agent or the origin', async () => {
    const { h, inst } = setup({ trustProxy: 1, endpoints: [{ name: 'hits', auth: 'none', origins: [BLOG], visitor: 'daily', country: true }], countryHeader: 'cf-ipcountry' });
    await request(h.app).post('/_ingest/hits').set('Host', HOST).set('Origin', BLOG).set('X-Forwarded-For', '203.0.113.77').set('User-Agent', 'TestBrowser/9.9').set('cf-ipcountry', 'de').send({ path: '/' });
    const stored = JSON.stringify(docs(h, inst.id));
    expect(stored).not.toContain('203.0.113.77');
    expect(stored).not.toContain('TestBrowser');
    expect(stored).not.toContain('blog.example.com');
    expect(docs(h, inst.id)[0].data).toMatchObject({ path: '/', _country: 'DE' });
  });

  it('_visitor is the same for one visitor within a day and differs by address, browser, instance and day', async () => {
    const { h, inst } = setup({ trustProxy: 1, endpoints: [{ name: 'hits', auth: 'none', origins: [BLOG], visitor: 'daily' }] });
    h.core.apps.createInstance({ appId: inst.appId, slug: 'stats-two', ownerId: h.adminId });
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-03-01T10:00:00Z') });
    const send = async (ip: string, agent: string, host = HOST): Promise<string> => {
      const slug = host.split('.')[0];
      await request(h!.app).post('/_ingest/hits').set('Host', host).set('Origin', BLOG).set('X-Forwarded-For', ip).set('User-Agent', agent).send({ path: '/' });
      const all = docs(h!, h!.core.apps.getInstanceBySlug(slug)!.id).sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
      vi.setSystemTime(Date.now() + 1000);
      return all[all.length - 1].data._visitor as string;
    };
    const first = await send('203.0.113.7', 'A');
    expect(first).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await send('203.0.113.7', 'A')).toBe(first);
    expect(await send('203.0.113.8', 'A')).not.toBe(first);
    expect(await send('203.0.113.7', 'B')).not.toBe(first);
    expect(await send('203.0.113.7', 'A', 'stats-two.apps.localhost')).not.toBe(first);
    // A whole IPv6 /64 is one visitor, as everywhere else.
    expect(await send('2001:db8:1:2::1', 'A')).toBe(await send('2001:db8:1:2:ffff::9', 'A'));
    vi.setSystemTime(Date.parse('2026-03-02T00:00:01Z'));
    expect(await send('203.0.113.7', 'A')).not.toBe(first);
  });

  it('adds no _visitor and no _country unless the endpoint asks, and no _country unless the operator named a header', async () => {
    const { h, inst } = setup({ endpoints: [{ name: 'hits', auth: 'none', origins: [BLOG], country: true }, { name: 'plain', auth: 'none', origins: [BLOG] }] });
    await request(h.app).post('/_ingest/hits').set('Host', HOST).set('Origin', BLOG).set('cf-ipcountry', 'DE').send({ a: 1 });
    expect(docs(h, inst.id)[0].data).not.toHaveProperty('_country');
    expect(docs(h, inst.id)[0].data).not.toHaveProperty('_visitor');
  });

  it('takes only a two-letter country from the header', async () => {
    const { h, inst } = setup({ endpoints: [{ name: 'hits', auth: 'none', origins: [BLOG], country: true }], countryHeader: 'cf-ipcountry' });
    for (const value of ['T1', 'Germany', '<b>', '']) await request(h.app).post('/_ingest/hits').set('Host', HOST).set('Origin', BLOG).set('cf-ipcountry', value).send({ a: 1 });
    for (const doc of docs(h, inst.id)) expect(doc.data).not.toHaveProperty('_country');
  });
});

describe('POST /_ingest/<name>: limits', () => {
  it('one address gets its budget per minute, and other addresses are not affected', async () => {
    const { h, inst } = setup({ trustProxy: 1 });
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-03-01T10:00:00Z') });
    const from = (ip: string) => request(h!.app).post('/_ingest/hits').set('Host', HOST).set('Origin', BLOG).set('X-Forwarded-For', ip).send({ a: 1 });
    for (let i = 0; i < INGEST_LIMITS.perAddress; i++) expect((await from('203.0.113.7')).status).toBe(202);
    const over = await from('203.0.113.7');
    expect(over.status).toBe(429);
    expect(over.headers['retry-after']).toBe('30');
    expect(over.headers['access-control-allow-origin']).toBe(BLOG);
    expect((await from('203.0.113.8')).status).toBe(202);
    expect(h.core.ingest.countsOf(inst.id, 'hits')).toEqual({ accepted: INGEST_LIMITS.perAddress + 1, refused: 0, limited: 1 });
    vi.setSystemTime(Date.now() + INGEST_LIMITS.windowMs + 1);
    expect((await from('203.0.113.7')).status).toBe(202);
  });

  it('an endpoint and an instance take only so much per minute, however many addresses send', () => {
    const { h, inst } = setup();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-03-01T10:00:00Z') });
    const admit = (sink: string, n: number): boolean => h.core.ingest.admit(inst.id, sink, { address: `198.51.100.${n % 250}-${Math.floor(n / 250)}`, perDay: INGEST_LIMITS.maxPerDay });
    for (let i = 0; i < INGEST_LIMITS.perEndpoint; i++) expect(admit('endpoint:hits', i)).toBe(true);
    expect(admit('endpoint:hits', 1e6)).toBe(false);
    // The instance as a whole has room for a second endpoint, and then no more.
    for (let i = 0; i < INGEST_LIMITS.perInstance - INGEST_LIMITS.perEndpoint; i++) expect(admit('endpoint:other', i)).toBe(true);
    expect(admit('endpoint:third', 1)).toBe(false);
    // A refused request did not use up the sender's own budget, and another instance has its own.
    expect(h.core.ingest.admit('another-instance', 'endpoint:hits', { address: '198.51.100.1-0', perDay: 10 })).toBe(true);
    vi.setSystemTime(Date.now() + INGEST_LIMITS.windowMs + 1);
    expect(admit('endpoint:third', 1)).toBe(true);
  });

  it('an endpoint takes its number of documents per day, then nothing until the next day', async () => {
    const { h, inst } = setup({ endpoints: [{ name: 'hits', auth: 'none', origins: [BLOG], maxPerDay: 3 }] });
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-03-01T23:00:00Z') });
    for (let i = 0; i < 3; i++) expect((await hit(h)).status).toBe(202);
    expect((await hit(h)).status).toBe(429);
    vi.setSystemTime(Date.parse('2026-03-01T23:59:59Z'));
    expect((await hit(h)).status).toBe(429);
    vi.setSystemTime(Date.parse('2026-03-02T00:00:01Z'));
    expect((await hit(h)).status).toBe(202);
    expect(docs(h, inst.id)).toHaveLength(4);
  });

  it('a full ingest quota refuses with 507 and leaves the instance\'s own storage alone', async () => {
    const { h, inst } = setup({ ingestQuotaBytes: 20_000 });
    let accepted = 0;
    for (let i = 0; i < 40; i++) {
      const res = await hit(h, { text: 'x'.repeat(1000) });
      if (res.status === 202) accepted++; else expect(res.status).toBe(507);
    }
    expect(accepted).toBeGreaterThan(5);
    expect(accepted).toBeLessThan(20);
    expect(docs(h, inst.id)).toHaveLength(accepted);
    expect(h.core.data.ingestUsage(inst.id)).toBeLessThanOrEqual(20_000);
    expect(h.core.ingest.countsOf(inst.id, 'hits')).toEqual({ accepted, refused: 40 - accepted, limited: 0 });
    // The owner still writes: what came from outside does not count against the instance's storage.
    expect(() => h.core.data.set(inst.id, 'notes/n1', { text: 'mine' }, h.adminId)).not.toThrow();
  });

  it('with onFull "rotate" the oldest received documents of the collection make room', async () => {
    const { h, inst } = setup({ ingestQuotaBytes: 20_000, endpoints: [{ name: 'hits', auth: 'none', origins: [BLOG], onFull: 'rotate' }] });
    for (let i = 0; i < 40; i++) expect((await hit(h, { n: i, text: 'x'.repeat(1000) })).status).toBe(202);
    const kept = docs(h, inst.id).map((d) => d.data.n as number).sort((a, b) => a - b);
    expect(kept.length).toBeGreaterThan(5);
    expect(kept.length).toBeLessThan(20);
    // The newest ones stayed, without a gap.
    expect(kept).toEqual(Array.from({ length: kept.length }, (_, i) => 40 - kept.length + i));
    expect(h.core.data.ingestUsage(inst.id)).toBeLessThanOrEqual(20_000);
  });
});

describe('received documents in the instance', () => {
  it('are readable only by managers unless a rule opens the collection', async () => {
    const { h, inst } = setup({ visibility: 'public' });
    await hit(h, { path: '/secret-page' });
    const db = (cookie: string | undefined, body: object) => {
      const req = request(h!.app).post('/__lager/db').set('Host', HOST).set('X-Lager-Request', '1');
      if (cookie) req.set('Cookie', cookie);
      return req.send(body);
    };
    // A guest of the public instance sees nothing of what came in…
    expect((await db(undefined, { op: 'query', path: 'hits' })).body).toEqual({ docs: [] });
    const [doc] = docs(h, inst.id);
    expect((await db(undefined, { op: 'get', path: doc.path })).body).toEqual({ doc: null });
    // …and neither does someone it is shared with as a contributor; the owner does.
    const ada = h.core.users.create({ email: 'ada@x.y', name: 'Ada', password: 'password-123', role: 'user' });
    h.core.access.setGrant(inst, 'user', ada.id, 'interact', h.core.users.get(h.adminId)!);
    const adaCookie = await h.enter('stats', await h.login('ada@x.y', 'password-123'));
    expect((await db(adaCookie, { op: 'query', path: 'hits' })).body).toEqual({ docs: [] });
    const owner = await h.enter('stats', await h.login());
    expect((await db(owner, { op: 'query', path: 'hits' })).body.docs).toHaveLength(1);
  });

  it('a rule of the app for the collection decides instead', async () => {
    const { h } = setup({ visibility: 'public', rules: [{ path: 'hits', read: 'view' }] });
    await hit(h, { path: '/' });
    const res = await request(h.app).post('/__lager/db').set('Host', HOST).set('X-Lager-Request', '1').send({ op: 'query', path: 'hits' });
    expect(res.body.docs).toHaveLength(1);
  });

  it('live queries hear of the first document at once and of a burst once, when the interval is over', async () => {
    const { h, inst } = setup();
    const events: HubEvent[] = [];
    h.core.hub.subscribe(inst.id, (e) => events.push(e));
    for (let i = 0; i < 5; i++) await hit(h, { n: i });
    expect(events).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, INGEST_NOTIFY_MS + 200));
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: 'change', parent: 'hits' });
  }, 10_000);
});

describe('GET /__lager/ingest', () => {
  it('shows the endpoints to every viewer and the token to managers only', async () => {
    const { h, inst } = setup({ visibility: 'public' });
    const guest = await request(h.app).get('/__lager/ingest').set('Host', HOST);
    expect(guest.status).toBe(200);
    expect(guest.headers['cache-control']).toBe('no-store');
    expect(guest.body.endpoints).toEqual([
      { name: 'hits', path: '/_ingest/hits', collection: 'hits', auth: 'none', origins: [BLOG, 'http://localhost:4000'], maxBytes: 4096, enabled: true, token: null },
      { name: 'weight', path: '/_ingest/weight', collection: 'log/main/weights', auth: 'token', origins: [], maxBytes: 200, enabled: true, token: null },
    ]);
    const ada = h.core.users.create({ email: 'ada@x.y', name: 'Ada', password: 'password-123', role: 'user' });
    h.core.access.setGrant(inst, 'user', ada.id, 'interact', h.core.users.get(h.adminId)!);
    const contributor = await request(h.app).get('/__lager/ingest').set('Host', HOST).set('Cookie', await h.enter('stats', await h.login('ada@x.y', 'password-123')));
    expect(contributor.body.endpoints[1].token).toBeNull();
    const owner = await request(h.app).get('/__lager/ingest').set('Host', HOST).set('Cookie', await h.enter('stats', await h.login()));
    expect(owner.body.endpoints[0].token).toBeNull();
    expect(owner.body.endpoints[1].token).toBe(h.core.ingest.token(inst.id, 'weight'));
    h.core.ingest.setOff(inst.id, 'weight', true);
    expect((await request(h.app).get('/__lager/ingest').set('Host', HOST)).body.endpoints.map((e: { enabled: boolean }) => e.enabled)).toEqual([true, false]);
  });

  it('needs access to the instance and the declaration', async () => {
    const { h } = setup();
    expect((await request(h.app).get('/__lager/ingest').set('Host', HOST)).status).toBe(401);
    h.core.apps.deploy({ slug: 'plain', html: '<p>x</p>', userId: h.adminId });
    const cookie = await h.enter('plain', await h.login());
    expect((await request(h.app).get('/__lager/ingest').set('Host', 'plain.apps.localhost').set('Cookie', cookie)).status).toBe(404);
  });
});
