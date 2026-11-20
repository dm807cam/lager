import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { INGEST_LIMITS } from '../src/platform/ingest.js';
import { makeHarness, type Harness, type HarnessOptions } from './support/http.js';

let h: Harness | undefined;
afterEach(() => { vi.useRealTimers(); h?.core.close(); h = undefined; });

const HOST = 'party.apps.localhost';
const RULES = [{ path: 'rsvps', read: 'admin', write: 'anyone' }, { path: 'wall', read: 'view', write: 'anyone' }];

function setup(opts: { rules?: object[]; visibility?: 'private' | 'users' | 'public' } & HarnessOptions = {}) {
  const { rules, visibility, ...harness } = opts;
  h = makeHarness(harness);
  const r = h.core.apps.deploy({ slug: 'party', html: '<html><head></head><body>party</body></html>', userId: h.adminId, capabilities: { db: { rules: rules ?? RULES } } as never });
  h.core.apps.setVisibility(r.instances[0].id, visibility ?? 'public', h.adminId);
  return { h, inst: r.instances[0] };
}

function db(h: Harness, cookie: string | undefined, body: object) {
  const req = request(h.app).post('/__lager/db').set('Host', HOST).set('X-Lager-Request', '1');
  if (cookie) req.set('Cookie', cookie);
  return req.send(body);
}

describe('a guest on a public instance and write: "anyone"', () => {
  it('adds a document under an id the server makes up', async () => {
    const { h, inst } = setup();
    const res = await db(h, undefined, { op: 'add', path: 'rsvps', data: { name: 'Grace', coming: true } });
    expect(res.status).toBe(200);
    // Not readable for a guest: the id comes back, the document does not.
    expect(res.body.doc).toBeNull();
    expect(res.body.id).toMatch(/^[A-Za-z0-9]{20}$/);
    const stored = h.core.data.get(inst.id, `rsvps/${res.body.id}`)!;
    expect(stored.data).toEqual({ name: 'Grace', coming: true });
    expect(stored.updatedBy).toBeNull();
    // It counts as data from outside, not against the instance's storage.
    expect(h.core.data.ingestUsage(inst.id)).toBeGreaterThan(0);
    // Where guests may read, they get what they added.
    const wall = await db(h, undefined, { op: 'add', path: 'wall', data: { text: 'hi' } });
    expect(wall.body.doc).toMatchObject({ id: wall.body.id, data: { text: 'hi' } });
  });

  it('can do nothing else there: no set, update, delete or acquire, also not on what they added', async () => {
    const { h, inst } = setup();
    const { id } = (await db(h, undefined, { op: 'add', path: 'wall', data: { text: 'mine' } })).body;
    for (const body of [
      { op: 'set', path: `wall/${id}`, data: { text: 'changed' } }, { op: 'set', path: 'wall/chosen-id', data: { text: 'x' } },
      { op: 'update', path: `wall/${id}`, data: { text: 'changed' } }, { op: 'delete', path: `wall/${id}` },
      { op: 'acquire', path: `wall/${id}`, options: { holder: 'h' } },
    ]) expect((await db(h, undefined, body)).status, body.op).toBe(403);
    expect(h.core.data.query(inst.id, 'wall').map((d) => d.data)).toEqual([{ text: 'mine' }]);
  });

  it('adds only where the rule says so', async () => {
    const { h, inst } = setup();
    expect((await db(h, undefined, { op: 'add', path: 'tasks', data: { a: 1 } })).status).toBe(403);
    expect((await db(h, undefined, { op: 'add', path: 'data/users/someone/notes', data: { a: 1 } })).status).toBe(403);
    // A document path is not a collection.
    expect((await db(h, undefined, { op: 'add', path: 'rsvps/r1', data: { a: 1 } })).status).toBe(400);
    expect((await db(h, undefined, { op: 'add', path: 'rsvps', data: [1] })).status).toBe(400);
    expect(h.core.data.hasData(inst.id)).toBe(false);
  });

  it('needs the request header of the runtime, so another site cannot make a visitor\'s browser add', async () => {
    const { h } = setup();
    const res = await request(h.app).post('/__lager/db').set('Host', HOST).send({ op: 'add', path: 'rsvps', data: { a: 1 } });
    expect(res.status).toBe(403);
  });

  it('is held to the size of a small document', async () => {
    const { h } = setup();
    expect((await db(h, undefined, { op: 'add', path: 'rsvps', data: { text: 'x'.repeat(INGEST_LIMITS.defaultMaxBytes) } })).status).toBe(400);
    expect((await db(h, undefined, { op: 'add', path: 'rsvps', data: { text: 'x'.repeat(INGEST_LIMITS.defaultMaxBytes - 50) } })).status).toBe(200);
  });

  it('is refused with quota_exceeded when the ingest quota is full, while the owner still writes', async () => {
    const { h, inst } = setup({ ingestQuotaBytes: 20_000 });
    let added = 0;
    for (let i = 0; i < 40; i++) {
      const res = await db(h, undefined, { op: 'add', path: 'rsvps', data: { text: 'x'.repeat(1000) } });
      if (res.status === 200) added++; else { expect(res.status).toBe(507); expect(res.body.error.code).toBe('quota_exceeded'); }
    }
    expect(added).toBeGreaterThan(5);
    expect(added).toBeLessThan(20);
    const owner = await h.enter('party', await h.login());
    expect((await db(h, owner, { op: 'add', path: 'rsvps', data: { text: 'x'.repeat(5000) } })).status).toBe(200);
    // The owner tidies up, and there is room for guests again.
    for (const d of h.core.data.query(inst.id, 'rsvps')) await db(h, owner, { op: 'delete', path: d.path });
    expect((await db(h, undefined, { op: 'add', path: 'rsvps', data: { text: 'x'.repeat(1000) } })).status).toBe(200);
  });

  it('shares a budget per rule and minute with all other visitors', async () => {
    const { h, inst } = setup();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-03-01T10:00:00Z') });
    // Other visitors used the rule's budget up.
    for (let i = 0; i < INGEST_LIMITS.perEndpoint; i++) h.core.ingest.admit(inst.id, 'rule:rsvps', { perDay: INGEST_LIMITS.defaultPerDay });
    const res = await db(h, undefined, { op: 'add', path: 'rsvps', data: { a: 1 } });
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('5');
    // Another rule of the same instance still has room.
    expect((await db(h, undefined, { op: 'add', path: 'wall', data: { a: 1 } })).status).toBe(200);
    vi.setSystemTime(Date.now() + INGEST_LIMITS.windowMs + 1);
    expect((await db(h, undefined, { op: 'add', path: 'rsvps', data: { a: 1 } })).status).toBe(200);
  });

  it('cannot add anything when receiving data is switched off on the server', async () => {
    const { h } = setup({ ingestQuotaBytes: 0 });
    expect((await db(h, undefined, { op: 'add', path: 'rsvps', data: { a: 1 } })).status).toBe(403);
  });

  it('gets nowhere on an instance that is not public', async () => {
    const { h } = setup({ visibility: 'users' });
    expect((await db(h, undefined, { op: 'add', path: 'rsvps', data: { a: 1 } })).status).toBe(401);
  });
});

describe('signed-in people and write: "anyone"', () => {
  it('a viewer appends like a guest, under their name, and changes nothing', async () => {
    const { h, inst } = setup();
    const vera = h.core.users.create({ email: 'vera@x.y', name: 'Vera', password: 'password-123', role: 'user' });
    const cookie = await h.enter('party', await h.login('vera@x.y', 'password-123'));
    const res = await db(h, cookie, { op: 'add', path: 'wall', data: { text: 'hello' } });
    expect(res.status).toBe(200);
    expect(res.body.doc).toMatchObject({ updatedBy: vera.id });
    expect(h.core.data.ingestUsage(inst.id)).toBeGreaterThan(0);
    expect((await db(h, cookie, { op: 'set', path: `wall/${res.body.id}`, data: { text: 'edited' } })).status).toBe(403);
    expect((await db(h, cookie, { op: 'delete', path: `wall/${res.body.id}` })).status).toBe(403);
  });

  it('a contributor writes as before, into the instance\'s own storage, and may change and delete', async () => {
    const { h, inst } = setup();
    const ada = h.core.users.create({ email: 'ada@x.y', name: 'Ada', password: 'password-123', role: 'user' });
    h.core.access.setGrant(inst, 'user', ada.id, 'interact', h.core.users.get(h.adminId)!);
    const cookie = await h.enter('party', await h.login('ada@x.y', 'password-123'));
    const res = await db(h, cookie, { op: 'add', path: 'wall', data: { text: 'x'.repeat(INGEST_LIMITS.defaultMaxBytes * 2) } });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(res.body.doc.id);
    expect(h.core.data.ingestUsage(inst.id)).toBe(0);
    expect((await db(h, cookie, { op: 'set', path: 'wall/chosen', data: { a: 1 } })).status).toBe(200);
    expect((await db(h, cookie, { op: 'delete', path: `wall/${res.body.id}` })).status).toBe(200);
  });

  it('what a guest added and the owner then approves is the instance\'s own', async () => {
    const { h, inst } = setup();
    const { id } = (await db(h, undefined, { op: 'add', path: 'wall', data: { text: 'hi' } })).body;
    const owner = await h.enter('party', await h.login());
    expect((await db(h, owner, { op: 'update', path: `wall/${id}`, data: { approved: true } })).status).toBe(200);
    expect(h.core.data.ingestUsage(inst.id)).toBe(0);
    expect(h.core.data.get(inst.id, `wall/${id}`)?.data).toEqual({ text: 'hi', approved: true });
  });
});
