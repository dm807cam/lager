import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { InstanceAssets } from '../src/data/assets.js';
import { MAX_OPEN_HANDLES } from '../src/data/handles.js';
import { Hub } from '../src/data/hub.js';
import { runQuery, type QuerySpec } from '../src/data/query.js';
import { InstanceData, SNAPSHOT_OLD_MS, SNAPSHOT_QUOTA_FACTOR } from '../src/data/store.js';
import { LagerError } from '../src/errors.js';
import { apiExtension } from '../src/http/api.js';
import { addressKey } from '../src/http/client-address.js';
import { dashboardExtension } from '../src/http/dashboard.js';
import { DB_RATE } from '../src/http/instance.js';
import { manageExtension } from '../src/http/manage.js';
import { SNAPSHOT_ACTIONS_PER_HOUR } from '../src/http/snapshot-limit.js';
import { signToken } from '../src/http/tokens.js';
import { t } from '../src/i18n/index.js';
import { makeHarness, type Harness } from './support/http.js';

const KIB = 1024;
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'lager-limits-'));
const stores: Array<{ close(): void }> = [];
let h: Harness | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const s of stores.splice(0)) s.close();
  h?.core.close();
  h = undefined;
});

function dataStore(dir: string, opts: { quota?: number; keep?: number; maxOpen?: number } = {}): InstanceData {
  const s = new InstanceData(dir, new Hub(), opts.keep ?? 20, opts.quota ?? 0, opts.maxOpen);
  stores.push(s);
  return s;
}

function code(fn: () => unknown): string {
  try { fn(); } catch (e) { if (e instanceof LagerError) return e.code; throw e; }
  return 'none';
}

describe('snapshot byte budget', () => {
  const fill = (s: InstanceData): void => { for (let i = 0; i < 40; i++) s.set('i1', `docs/d${i}`, { text: 'x'.repeat(2 * KIB) }, null); };

  it('prunes the oldest snapshots beyond a multiple of the quota, in addition to the count', () => {
    const quota = 200 * KIB;
    const store = dataStore(tmp(), { quota });
    fill(store);
    const made = Array.from({ length: 8 }, (_, n) => store.snapshot('i1', `s${n}`)!);
    expect(made[0].sizeBytes).toBeGreaterThan(80 * KIB);
    const kept = store.listSnapshots('i1');
    expect(kept.length).toBeLessThan(8);
    expect(kept.length).toBeGreaterThan(1);
    expect(kept.reduce((sum, s) => sum + s.sizeBytes, 0)).toBeLessThanOrEqual(SNAPSHOT_QUOTA_FACTOR * quota);
    // Newest first, without gaps: only the oldest ones went.
    expect(kept.map((s) => s.id)).toEqual(made.map((s) => s.id).reverse().slice(0, kept.length));
  });

  it('keeps the newest snapshot that is at least a day old when newer ones fill the budget, and stays within it', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const quota = 200 * KIB;
    const store = dataStore(tmp(), { quota });
    fill(store);
    store.snapshot('i1', 'ancient');
    vi.setSystemTime(Date.now() + SNAPSHOT_OLD_MS);
    const old = store.snapshot('i1', 'yesterday')!;
    vi.setSystemTime(Date.now() + SNAPSHOT_OLD_MS);
    // A burst of version changes today: more than the budget holds.
    const made = Array.from({ length: 8 }, (_, n) => store.snapshot('i1', `s${n}`)!);
    const kept = store.listSnapshots('i1');
    expect(kept[kept.length - 1].id).toBe(old.id);
    expect(kept.some((s) => s.label === 'ancient')).toBe(false);
    expect(kept.length).toBeGreaterThan(2);
    expect(kept.length).toBeLessThan(9);
    expect(kept.slice(0, -1).map((s) => s.id)).toEqual(made.map((s) => s.id).reverse().slice(0, kept.length - 1));
    expect(kept.reduce((sum, s) => sum + s.sizeBytes, 0)).toBeLessThanOrEqual(SNAPSHOT_QUOTA_FACTOR * quota);
    // Once a newer snapshot is a day old it takes over, so the protected state does not grow stale.
    vi.setSystemTime(Date.now() + SNAPSHOT_OLD_MS + 1000);
    for (let n = 0; n < 8; n++) store.snapshot('i1', `t${n}`);
    const later = store.listSnapshots('i1');
    expect(later[later.length - 1].id).toBe(made[7].id);
    expect(later.reduce((sum, s) => sum + s.sizeBytes, 0)).toBeLessThanOrEqual(SNAPSHOT_QUOTA_FACTOR * quota);
  });

  it('the count limit also leaves the day-old snapshot in place', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const store = dataStore(tmp(), { keep: 3 });
    fill(store);
    store.snapshot('i1', 'yesterday');
    vi.setSystemTime(Date.now() + SNAPSHOT_OLD_MS);
    for (let n = 0; n < 5; n++) store.snapshot('i1', `s${n}`);
    expect(store.listSnapshots('i1').map((s) => s.label)).toEqual(['s4', 's3', 'yesterday']);
  });

  it('without a quota only the count applies', () => {
    const store = dataStore(tmp());
    fill(store);
    for (let n = 0; n < 8; n++) store.snapshot('i1', `s${n}`);
    expect(store.listSnapshots('i1')).toHaveLength(8);
  });

  it('always keeps the newest snapshot, and a restore is never blocked by the quota or the budget', () => {
    const dir = tmp();
    fill(dataStore(dir));
    stores.pop()!.close();
    // The same data under a quota far below one snapshot.
    const store = dataStore(dir, { quota: KIB });
    const first = store.snapshot('i1', 'first')!;
    expect(store.listSnapshots('i1').map((s) => s.id)).toEqual([first.id]);
    store.delete('i1', 'docs/d0');
    store.restore('i1', first.id);
    expect(store.get('i1', 'docs/d0')).not.toBeNull();
    expect(store.listSnapshots('i1').map((s) => s.label)).toEqual(['pre-restore']);
    expect(code(() => store.set('i1', 'docs/more', { a: 1 }, null))).toBe('quota_exceeded');
  });
});

describe('query limits', () => {
  const run = (spec: unknown): string => code(() => runQuery([], spec as QuerySpec));
  const clauses = (n: number): unknown[] => Array.from({ length: n }, (_, i) => [`f${i}`, '==', i]);
  const list = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

  it('caps where clauses, list lengths, orderBy fields and limit', () => {
    expect(run({ where: clauses(10) })).toBe('none');
    expect(run({ where: clauses(11) })).toBe('invalid_argument');
    for (const op of ['in', 'not-in', 'array-contains-any']) {
      expect(run({ where: [['a', op, list(30)]] })).toBe('none');
      expect(run({ where: [['a', op, list(31)]] })).toBe('invalid_argument');
    }
    // A plain value may be a long array: it is compared once per document, not entry by entry.
    expect(run({ where: [['a', '==', list(100)]] })).toBe('none');
    expect(run({ orderBy: Array.from({ length: 5 }, (_, i) => [`f${i}`, 'asc']) })).toBe('none');
    expect(run({ orderBy: Array.from({ length: 6 }, (_, i) => [`f${i}`, 'asc']) })).toBe('invalid_argument');
    expect(run({ limit: 1000 })).toBe('none');
    expect(run({ limit: 1001 })).toBe('invalid_argument');
  });

  it('the store refuses an oversized query even on an instance without data', () => {
    const store = dataStore(tmp());
    expect(code(() => store.query('nope', 'tasks', { where: [['a', 'in', list(31)]] }))).toBe('invalid_argument');
  });
});

describe('query paths give identical results', () => {
  const IDS = ['b', 'B', 'a', 'a-1', 'a.1', 'a_1', 'a1', 'A1', '10', '9', '~z', 'Z', '@x', '+x', ':x', 'aa', 'ab'];

  function seeded(): InstanceData {
    const store = dataStore(tmp());
    IDS.forEach((id, i) => store.set('i1', `tasks/${id}`, { n: i, tag: i % 3 }, null));
    store.set('i1', 'tasks/a/sub/deep', { n: 99 }, null);
    store.set('i1', 'other/x', { n: 100 }, null);
    return store;
  }
  /** What the query returned before limits were pushed into SQL: load everything, drop the invisible, then filter, sort and cut in JavaScript. */
  function reference(store: InstanceData, spec: QuerySpec, visible?: (p: string) => boolean) {
    const all = IDS.map((id) => store.get('i1', `tasks/${id}`)!).filter((d) => !visible || visible(d.path));
    return runQuery(all, spec);
  }

  it('with and without limit, filter, order and a visibility rule', () => {
    const store = seeded();
    const hidden = (p: string): boolean => !p.startsWith('tasks/a');
    const specs: QuerySpec[] = [
      {}, { limit: 1 }, { limit: 5 }, { limit: 17 }, { limit: 1000 },
      { where: [['tag', '==', 1]], limit: 3 }, { orderBy: [['n', 'desc']], limit: 4 }, { where: [], orderBy: [], limit: 6 },
    ];
    for (const spec of specs) {
      for (const visible of [undefined, hidden, () => false]) {
        expect(store.query('i1', 'tasks', spec, visible), JSON.stringify(spec)).toEqual(reference(store, spec, visible));
      }
    }
    expect(store.query('i1', 'tasks', { limit: 3 }).map((d) => d.id)).toEqual([...IDS].sort().slice(0, 3));
  });

  it('a plain query reads only as many rows as it returns, and never parses a document the viewer may not see', () => {
    const store = seeded();
    const parse = vi.spyOn(JSON, 'parse');
    expect(store.query('i1', 'tasks', { limit: 2 })).toHaveLength(2);
    expect(parse).toHaveBeenCalledTimes(2);
    parse.mockClear();
    expect(store.query('i1', 'tasks', { where: [['tag', '==', 1]] }, (p) => p === 'tasks/b')).toHaveLength(0);
    expect(parse).toHaveBeenCalledTimes(1);
    parse.mockClear();
    expect(store.query('i1', 'tasks', { limit: 2 }, (p) => !p.startsWith('tasks/1'))).toHaveLength(2);
    expect(parse).toHaveBeenCalledTimes(2);
  });
});

describe('import', () => {
  it('records the importing author once, and only when a document lies outside the private areas', () => {
    const store = dataStore(tmp());
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare');
    const authorWrites = (): number => prepare.mock.calls.filter(([sql]) => sql.includes('INTO authors')).length;
    store.importDocs('i1', [{ path: 'data/users/u1/prefs', data: {} }, { path: 'data/users/u1/more', data: {} }], 'u1', { allowPrivateOf: 'u1' });
    expect(authorWrites()).toBe(0);
    expect(store.hasAuthor('i1', 'u1')).toBe(false);
    const docs = Array.from({ length: 50 }, (_, i) => ({ path: `tasks/t${i}`, data: { i } }));
    store.importDocs('i1', [{ path: 'data/users/u1/prefs', data: {} }, ...docs], 'u1', { allowPrivateOf: 'u1' });
    expect(authorWrites()).toBe(1);
    expect(store.hasAuthor('i1', 'u1')).toBe(true);
    store.importDocs('i1', docs, null);
    expect(authorWrites()).toBe(1);
  });
});

describe('open database handles', () => {
  it('the limit is a small constant well below a default descriptor limit', () => {
    expect(MAX_OPEN_HANDLES).toBe(64);
  });

  it('documents: the number of open handles stays bounded and every instance stays readable and writable', () => {
    const dir = tmp();
    const store = dataStore(dir, { maxOpen: 4 });
    for (let i = 0; i < 12; i++) {
      store.set(`i${i}`, 'tasks/t', { i }, 'u1');
      expect(store.openHandles).toBeLessThanOrEqual(4);
    }
    expect(store.openHandles).toBe(4);
    // A closed handle checkpointed its WAL: the data is in the main file and no WAL is left behind.
    expect(fs.existsSync(path.join(dir, 'instances', 'i0', 'data.sqlite-wal'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'instances', 'i11', 'data.sqlite-wal'))).toBe(true);
    for (let i = 0; i < 12; i++) {
      expect(store.get(`i${i}`, 'tasks/t')!.data).toEqual({ i });
      expect(store.update(`i${i}`, 'tasks/t', { again: true }, 'u1').data).toEqual({ i, again: true });
      expect(store.query(`i${i}`, 'tasks')).toHaveLength(1);
      expect(store.hasAuthor(`i${i}`, 'u1')).toBe(true);
      expect(store.usage(`i${i}`)).toBeGreaterThan(0);
    }
    expect(store.openHandles).toBe(4);
  });

  it('with the default limit, more instances than the limit keep the count at the limit', () => {
    const store = dataStore(tmp());
    for (let i = 0; i < MAX_OPEN_HANDLES + 6; i++) store.set(`i${i}`, 'tasks/t', { i }, null);
    expect(store.openHandles).toBe(MAX_OPEN_HANDLES);
    expect(store.get('i0', 'tasks/t')!.data).toEqual({ i: 0 });
  });

  it('an export survives its handle being closed between two batches', () => {
    const store = dataStore(tmp(), { maxOpen: 2 });
    store.importDocs('big', Array.from({ length: 1200 }, (_, i) => ({ path: `tasks/t${String(i).padStart(4, '0')}`, data: { i } })), null);
    const seen: string[] = [];
    for (const d of store.exportDocs('big')) {
      // A slow consumer: other instances are used while the export is under way.
      if (seen.length % 100 === 0) for (let i = 0; i < 4; i++) store.set(`other${i}`, 'tasks/t', { n: seen.length }, null);
      seen.push(d.path);
    }
    expect(seen).toHaveLength(1200);
    expect(new Set(seen).size).toBe(1200);
    expect(store.openHandles).toBeLessThanOrEqual(2);
  });

  it('an export fails instead of ending early when the instance is deleted half-way', () => {
    const store = dataStore(tmp());
    store.importDocs('gone', Array.from({ length: 1200 }, (_, i) => ({ path: `tasks/t${String(i).padStart(4, '0')}`, data: { i } })), null);
    let seen = 0;
    expect(code(() => { for (const d of store.exportDocs('gone')) { if (++seen === 10) store.trash('gone'); void d; } })).toBe('not_found');
    expect(seen).toBe(500);
    // An instance without data exports nothing, without an error.
    expect([...store.exportDocs('never')]).toEqual([]);
  });

  it('snapshot, restore and trash work on instances whose handle was closed', () => {
    const dir = tmp();
    const store = dataStore(dir, { maxOpen: 2 });
    store.set('a', 'tasks/t', { v: 1 }, null);
    for (let i = 0; i < 4; i++) store.set(`other${i}`, 'tasks/t', {}, null);
    const snap = store.snapshot('a', 'manual')!;
    store.set('a', 'tasks/t', { v: 2 }, null);
    for (let i = 0; i < 4; i++) store.get(`other${i}`, 'tasks/t');
    store.restore('a', snap.id);
    expect(store.get('a', 'tasks/t')!.data).toEqual({ v: 1 });
    for (let i = 0; i < 4; i++) store.get(`other${i}`, 'tasks/t');
    store.trash('a');
    expect(store.get('a', 'tasks/t')).toBeNull();
    expect(fs.existsSync(path.join(dir, 'instances', 'a'))).toBe(false);
  });

  it('assets: the number of open handles stays bounded and every file stays listed', () => {
    const assets = new InstanceAssets(tmp(), 0, () => 0, 4);
    stores.push(assets);
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      ids.push(assets.put(`i${i}`, Buffer.from(`file ${i}`), 'text/plain', null).id);
      expect(assets.openHandles).toBeLessThanOrEqual(4);
    }
    for (let i = 0; i < 12; i++) {
      expect(assets.get(`i${i}`, ids[i])!.info.sizeBytes).toBe(`file ${i}`.length);
      expect(assets.usage(`i${i}`).files).toBe(1);
      expect(assets.put(`i${i}`, Buffer.from('second'), 'text/plain', null).sizeBytes).toBe(6);
      expect(assets.list(`i${i}`)).toHaveLength(2);
    }
    expect(assets.openHandles).toBe(4);
  });
});

describe('http', () => {
  const HOST = 'todo.apps.localhost';
  function setup(trustProxy?: number): { h: Harness; token: string; instId: string } {
    h = makeHarness({ extensions: [apiExtension, dashboardExtension, manageExtension], trustProxy });
    h.core.apps.deploy({ slug: 'todo', html: '<p>1</p>', userId: h.adminId, capabilities: { db: { rules: [{ path: 'secret', read: 'owner' }] } } });
    h.core.apps.deploy({ slug: 'todo', html: '<p>2</p>', userId: h.adminId, capabilities: { db: {}, user: {} } });
    return { h, token: h.core.tokens.create(h.adminId, 'test').token, instId: h.core.apps.getInstanceBySlug('todo')!.id };
  }
  const db = (h: Harness, cookie: string | undefined, body: object, from?: string) => {
    const req = request(h.app).post('/__lager/db').set('Host', HOST).set('X-Lager-Request', '1');
    if (from) req.set('X-Forwarded-For', from);
    return (cookie ? req.set('Cookie', cookie) : req).send(body);
  };
  const many = <T>(n: number, fn: (i: number) => Promise<T>): Promise<T[]> => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));

  it('restores and manual activations share one budget per instance across REST and the dashboard', async () => {
    const { h, token, instId } = setup();
    const activate = (version: number) => request(h.app).post('/api/instances/todo/activate').set('Host', h.host)
      .set('Authorization', `Bearer ${token}`).send({ version });
    h.core.data.set(instId, 'tasks/t1', { v: 1 }, h.adminId);
    // Activating the version that is already active takes no snapshot and costs nothing.
    for (let i = 0; i < SNAPSHOT_ACTIONS_PER_HOUR + 2; i++) expect((await activate(2)).status).toBe(200);
    for (let i = 0; i < SNAPSHOT_ACTIONS_PER_HOUR; i++) expect((await activate(i % 2 === 0 ? 1 : 2)).status).toBe(200);
    const before = h.core.data.listSnapshots(instId);
    expect(before).toHaveLength(SNAPSHOT_ACTIONS_PER_HOUR);

    const refused = await activate(1);
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('rate_limited');
    expect(h.core.apps.getInstanceBySlug('todo')!.activeVersion).toBe(2);

    const cookie = await h.login();
    const admin = h.core.users.get(h.adminId)!;
    const csrf = signToken({ uid: admin.id, k: 'ui' }, h.core.config.secret, 3600);
    const post = (route: string, body: Record<string, string>) => request(h.app).post(`/ui/instances/todo/${route}`).set('Host', h.host)
      .set('Cookie', cookie).type('form').send({ csrf, ...body });
    for (const res of [await post('restore', { snapshot: before[0].id }), await post('activate', { version: '1' })]) {
      expect(res.status).toBe(302);
      const page = await request(h.app).get(res.headers.location as string).set('Host', h.host).set('Cookie', cookie);
      expect(page.text).toContain(t('en', 'notice.snapshotRate'));
    }
    expect(h.core.data.listSnapshots(instId).map((s) => s.id)).toEqual(before.map((s) => s.id));
    expect(h.core.apps.getInstanceBySlug('todo')!.activeVersion).toBe(2);

    // A deploy to an instance that follows deploys is not an on-demand action and is never refused.
    h.core.apps.setAutoUpdate(instId, true, h.adminId);
    h.core.apps.deploy({ slug: 'todo', html: '<p>3</p>', userId: h.adminId });
    expect(h.core.apps.getInstanceBySlug('todo')!.activeVersion).toBe(3);
    // Another instance has its own budget.
    h.core.apps.deploy({ slug: 'other', html: '<p>1</p>', userId: h.adminId });
    h.core.apps.deploy({ slug: 'other', html: '<p>2</p>', userId: h.adminId });
    const other = await request(h.app).post('/api/instances/other/activate').set('Host', h.host).set('Authorization', `Bearer ${token}`).send({ version: 1 });
    expect(other.status).toBe(200);
  });

  it('the instance page shows what the snapshots take, apart from the quota', async () => {
    const { h, instId } = setup();
    const cookie = await h.login();
    const label = t('en', 'instance.storage.snapshots', { size: 'SIZE' }).split('SIZE')[0];
    const page = () => request(h!.app).get('/instances/todo').set('Host', h!.host).set('Cookie', cookie);
    expect((await page()).text).not.toContain(label);
    h.core.data.set(instId, 'tasks/t1', { v: 1 }, h.adminId);
    h.core.data.snapshot(instId, 'manual');
    expect((await page()).text).toContain(label);
  });

  it('database requests are limited per viewer, with separate budgets for reads and writes', async () => {
    const { h, instId } = setup();
    const cookie = await h.enter('todo', await h.login());
    const get = () => db(h, cookie, { op: 'get', path: 'tasks/t1' });
    const set = () => db(h, cookie, { op: 'set', path: 'tasks/t1', data: { a: 1 } });
    const writes = await Promise.all(Array.from({ length: DB_RATE.writes }, set));
    expect(writes.every((r) => r.status === 200)).toBe(true);
    const refused = await set();
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('rate_limited');
    expect(refused.headers['retry-after']).toBe('5');
    for (const op of ['update', 'add', 'delete', 'acquire', 'nonsense']) {
      expect((await db(h, cookie, { op, path: 'tasks/t1', data: {}, options: { holder: 'x' } })).status, op).toBe(429);
    }
    // Reads have their own budget and still work.
    const reads = await Promise.all(Array.from({ length: DB_RATE.reads }, get));
    expect(reads.every((r) => r.status === 200)).toBe(true);
    expect((await get()).status).toBe(429);
    expect((await db(h, cookie, { op: 'query', path: 'tasks' })).status).toBe(429);

    // Another viewer of the same instance is not affected.
    h.core.apps.setVisibility(instId, 'public', h.adminId);
    expect((await db(h, undefined, { op: 'get', path: 'tasks/t1' })).status).toBe(200);
  });

  it('guests are counted per client address, an IPv6 /64 being one address', async () => {
    const { h, instId } = setup(1);
    h.core.apps.setVisibility(instId, 'public', h.adminId);
    // A guest may not write, but the attempt is counted like any other write.
    const write = (from: string) => db(h, undefined, { op: 'set', path: 'tasks/t1', data: {} }, from);
    const first = await many(DB_RATE.guestWrites, (i) => write(`2001:db8:1:2::${(i + 1).toString(16)}`));
    expect(first.every((r) => r.status === 403)).toBe(true);
    for (const from of ['2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:DB8:1:2::1', '2001:0db8:0001:0002:0000:0000:0000:0009']) {
      const refused = await write(from);
      expect(refused.status, from).toBe(429);
      expect(refused.body.error.code).toBe('rate_limited');
    }
    // Another /64, an IPv4 address and its IPv4-mapped spelling: the last two are one client.
    expect((await write('2001:db8:1:3::1')).status).toBe(403);
    const v4 = await many(DB_RATE.guestWrites, (i) => write(i % 2 === 0 ? '203.0.113.7' : '::ffff:203.0.113.7'));
    expect(v4.every((r) => r.status === 403)).toBe(true);
    expect((await write('203.0.113.7')).status).toBe(429);
    expect((await write('::ffff:cb00:7107')).status).toBe(429);
    expect((await write('203.0.113.8')).status).toBe(403);
    // Reads are counted apart, and a signed-in viewer from the same address has a budget of their own.
    expect((await db(h, undefined, { op: 'query', path: 'tasks' }, '203.0.113.7')).status).toBe(200);
    const cookie = await h.enter('todo', await h.login());
    expect((await db(h, cookie, { op: 'set', path: 'tasks/t1', data: {} }, '203.0.113.7')).status).toBe(200);
  });

  it('all guests of an instance together are bounded, whatever addresses they come from', async () => {
    const { h, instId } = setup(1);
    h.core.apps.setVisibility(instId, 'public', h.adminId);
    h.core.apps.deploy({ slug: 'other', html: '<p>1</p>', userId: h.adminId });
    h.core.apps.setVisibility(h.core.apps.getInstanceBySlug('other')!.id, 'public', h.adminId);
    const write = (from: string, host = HOST) => request(h!.app).post('/__lager/db').set('Host', host).set('X-Lager-Request', '1')
      .set('X-Forwarded-For', from).send({ op: 'set', path: 'tasks/t1', data: {} });
    const total = DB_RATE.guestWrites * DB_RATE.guestTotalFactor;
    // Every request from a prefix of its own: no single address comes near its limit.
    const spread = await many(total, (i) => write(`2001:db8:${(i + 1).toString(16)}::1`));
    expect(spread.every((r) => r.status === 403)).toBe(true);
    const refused = await write('2001:db8:ffff::1');
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('rate_limited');
    // Guests on another instance and signed-in viewers of this one are not affected.
    expect((await write('2001:db8:ffff::1', 'other.apps.localhost')).status).toBe(403);
    const cookie = await h.enter('todo', await h.login());
    expect((await db(h, cookie, { op: 'set', path: 'tasks/t1', data: {} }, '2001:db8:ffff::1')).status).toBe(200);
  });

  it('the numbers: an anonymous address reads no more than an account, and all guests together eight times that', () => {
    expect(DB_RATE).toMatchObject({ reads: 600, writes: 300, guestReads: 600, guestWrites: 150, guestTotalFactor: 8 });
  });

  it('while the guest total is used up, a refused guest does not drain their own budget', async () => {
    const { h, instId } = setup(1);
    vi.useFakeTimers({ toFake: ['Date'] });
    h.core.apps.setVisibility(instId, 'public', h.adminId);
    const write = (from: string) => db(h, undefined, { op: 'set', path: 'tasks/t1', data: {} }, from);
    await many(DB_RATE.guestWrites * DB_RATE.guestTotalFactor, (i) => write(`2001:db8:${(i + 1).toString(16)}::1`));
    // Fifty seconds later the total is still full: the victim keeps asking and is refused every time.
    vi.setSystemTime(Date.now() + 50_000);
    const refused = await many(DB_RATE.guestWrites + 5, () => write('203.0.113.9'));
    expect(refused.every((r) => r.status === 429)).toBe(true);
    // The total's window passes; the victim's refused attempts are younger than a minute but were never counted.
    vi.setSystemTime(Date.now() + 11_000);
    const after = await many(DB_RATE.guestWrites, () => write('203.0.113.9'));
    expect(after.every((r) => r.status === 403)).toBe(true);
    expect((await write('203.0.113.9')).status).toBe(429);
  });

  it('the database budget comes back when its window has passed', async () => {
    const { h } = setup();
    vi.useFakeTimers({ toFake: ['Date'] });
    const cookie = await h.enter('todo', await h.login());
    const set = () => db(h, cookie, { op: 'set', path: 'tasks/t1', data: { a: 1 } });
    await many(DB_RATE.writes, set);
    expect((await set()).status).toBe(429);
    vi.setSystemTime(Date.now() + DB_RATE.windowMs - 1000);
    expect((await set()).status).toBe(429);
    vi.setSystemTime(Date.now() + 1001);
    expect((await set()).status).toBe(200);
  });

  it('refused and failed attempts cost nothing of the snapshot budget', async () => {
    const { h, token, instId } = setup();
    const manager = h.core.users.create({ email: 'm@x.y', name: 'm', password: 'password-123', role: 'user' });
    h.core.access.setGrant(h.core.apps.getInstanceBySlug('todo')!, 'user', manager.id, 'admin', h.core.users.get(h.adminId)!);
    const managerToken = h.core.tokens.create(manager.id, 'test').token;
    const activate = (version: number, bearer = token) => request(h!.app).post('/api/instances/todo/activate').set('Host', h!.host)
      .set('Authorization', `Bearer ${bearer}`).send({ version });
    const admin = h.core.users.get(h.adminId)!;
    const cookies = new Map([[admin.id, await h.login()], [manager.id, await h.login(manager.email, 'password-123')]]);
    const ui = (user: { id: string }, route: string, body: Record<string, string>) =>
      request(h!.app).post(`/ui/instances/todo/${route}`).set('Host', h!.host).set('Cookie', cookies.get(user.id)!).type('form')
        .send({ csrf: signToken({ uid: user.id, k: 'ui' }, h!.core.config.secret, 3600), ...body });
    h.core.data.set(instId, 'tasks/t1', { v: 1 }, h.adminId);
    const snap = h.core.data.snapshot(instId, 'manual')!;
    const tries = SNAPSHOT_ACTIONS_PER_HOUR + 2;
    for (let i = 0; i < tries; i++) {
      // A version that does not exist, and one a manager may not switch to because its data rules differ.
      expect((await activate(9)).status).toBe(404);
      expect((await activate(1, managerToken)).status).toBe(409);
      // A manager may not restore at all; the owner names a snapshot that does not exist, then a malformed id.
      expect((await ui(manager, 'restore', { snapshot: snap.id })).status).toBe(403);
      expect((await ui(admin, 'restore', { snapshot: '20200101T000000000Z-gone' })).status).toBe(404);
      expect((await ui(admin, 'restore', { snapshot: '../x' })).status).toBe(302);
    }
    expect(h.core.data.listSnapshots(instId).map((s) => s.id)).toEqual([snap.id]);
    // The whole budget is still there for what really takes a snapshot.
    for (let i = 0; i < SNAPSHOT_ACTIONS_PER_HOUR - 1; i++) expect((await activate(i % 2 === 0 ? 1 : 2)).status).toBe(200);
    expect((await ui(admin, 'restore', { snapshot: snap.id })).status).toBe(302);
    expect(h.core.data.listSnapshots(instId).length).toBe(1 + SNAPSHOT_ACTIONS_PER_HOUR);
    expect((await activate(2)).status).toBe(429);
    // An instance without data takes no snapshot, so its version changes are free.
    h.core.apps.deploy({ slug: 'empty', html: '<p>1</p>', userId: h.adminId });
    h.core.apps.deploy({ slug: 'empty', html: '<p>2</p>', userId: h.adminId });
    for (let i = 0; i < tries; i++) {
      const res = await request(h.app).post('/api/instances/empty/activate').set('Host', h.host).set('Authorization', `Bearer ${token}`).send({ version: i % 2 === 0 ? 1 : 2 });
      expect(res.status).toBe(200);
    }
  });

  it('switching auto-update on counts when it changes the version, and the budget comes back after an hour', async () => {
    const { h, token, instId } = setup();
    vi.useFakeTimers({ toFake: ['Date'] });
    const post = (route: string, body: object) => request(h!.app).post(`/api/instances/todo/${route}`).set('Host', h!.host)
      .set('Authorization', `Bearer ${token}`).send(body);
    h.core.data.set(instId, 'tasks/t1', { v: 1 }, h.adminId);
    // Switching it on or off without a version change is free.
    for (let i = 0; i < SNAPSHOT_ACTIONS_PER_HOUR + 2; i++) {
      expect((await post('auto-update', { on: i % 2 === 0 })).status).toBe(200);
    }
    for (let i = 0; i < SNAPSHOT_ACTIONS_PER_HOUR / 2; i++) {
      expect((await post('activate', { version: 1 })).status).toBe(200);
      expect((await post('auto-update', { on: true })).body.activeVersion).toBe(2);
    }
    expect(h.core.data.listSnapshots(instId)).toHaveLength(SNAPSHOT_ACTIONS_PER_HOUR);
    // Back on version 1 by other means: switching auto-update on would now take the eleventh snapshot of the hour.
    h.core.apps.activate(instId, 1, h.adminId);
    const count = h.core.data.listSnapshots(instId).length;
    const refused = await post('auto-update', { on: true });
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('rate_limited');
    const cookie = await h.login();
    const csrf = signToken({ uid: h.adminId, k: 'ui' }, h.core.config.secret, 3600);
    const form = await request(h.app).post('/ui/instances/todo/auto-update').set('Host', h.host).set('Cookie', cookie).type('form').send({ csrf, on: ['0', '1'] });
    expect((await request(h.app).get(form.headers.location as string).set('Host', h.host).set('Cookie', cookie)).text).toContain(t('en', 'notice.snapshotRate'));
    expect(h.core.apps.getInstanceBySlug('todo')!.activeVersion).toBe(1);
    expect(h.core.data.listSnapshots(instId)).toHaveLength(count);
    // Switching it off is never refused.
    expect((await post('auto-update', { on: false })).status).toBe(200);

    vi.setSystemTime(Date.now() + 60 * 60_000 + 1);
    expect((await post('auto-update', { on: true })).body.activeVersion).toBe(2);
  });

  it('an oversized query is refused over HTTP', async () => {
    const { h } = setup();
    const cookie = await h.enter('todo', await h.login());
    const res = await db(h, cookie, { op: 'query', path: 'tasks', query: { where: [['a', 'in', Array.from({ length: 31 }, (_, i) => i)]] } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_argument');
  });

  it('capabilities and rules come from the active version, looked up as a single row', async () => {
    const { h, instId } = setup();
    const cookie = await h.enter('todo', await h.login());
    const all = vi.spyOn(h.core.apps, 'listVersions');
    const session = () => request(h!.app).get('/__lager/session').set('Host', HOST).set('Cookie', cookie);
    expect((await session()).body.capabilities).toEqual({ db: {}, user: {} });
    h.core.data.set(instId, 'secret/s1', { a: 1 }, h.adminId);
    h.core.apps.setVisibility(instId, 'public', h.adminId);
    expect((await db(h, undefined, { op: 'get', path: 'secret/s1' })).body.doc).not.toBeNull();
    // Version 1 closes `secret` to everyone but the owner; activating it changes what the same requests answer.
    h.core.apps.activate(instId, 1, h.adminId);
    expect((await session()).body.capabilities).toEqual({ db: { rules: [{ path: 'secret', read: 'owner' }] } });
    expect((await db(h, undefined, { op: 'get', path: 'secret/s1' })).body.doc).toBeNull();
    expect((await db(h, cookie, { op: 'get', path: 'secret/s1' })).body.doc).not.toBeNull();
    expect(all).not.toHaveBeenCalled();
  });
});

describe('addressKey', () => {
  it('keeps IPv4 addresses and unwraps IPv4-mapped ones', () => {
    expect(addressKey('203.0.113.7')).toBe('203.0.113.7');
    expect(addressKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(addressKey('::FFFF:203.0.113.7')).toBe('203.0.113.7');
    expect(addressKey('::ffff:cb00:7107')).toBe('203.0.113.7');
    expect(addressKey('0:0:0:0:0:ffff:cb00:7107')).toBe('203.0.113.7');
    expect(addressKey(' 127.0.0.1 ')).toBe('127.0.0.1');
  });

  it('reduces IPv6 addresses to their /64 in one canonical spelling', () => {
    const key = '2001:db8:1:2::/64';
    for (const ip of [
      '2001:db8:1:2::1', '2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:0db8:0001:0002:0000:0000:0000:0001', '2001:DB8:1:2::ABCD',
      '2001:db8:1:2:3:4:5:6', '2001:db8:1:2::', '[2001:db8:1:2::1]', '2001:db8:1:2::1%eth0', '2001:db8:1:2::192.0.2.1',
    ]) expect(addressKey(ip), ip).toBe(key);
    expect(addressKey('2001:db8:1:3::1')).toBe('2001:db8:1:3::/64');
    expect(addressKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(addressKey('2001:db8:0:0:1::')).toBe('2001:db8:0:0::/64');
    expect(addressKey('::1')).toBe('0:0:0:0::/64');
    expect(addressKey('::')).toBe('0:0:0:0::/64');
    expect(addressKey('fe80::1%en0')).toBe('fe80:0:0:0::/64');
    // An IPv4-compatible or other embedded form that is not IPv4-mapped stays IPv6.
    expect(addressKey('64:ff9b::203.0.113.7')).toBe('64:ff9b:0:0::/64');
  });

  it('maps everything that is not an address to one shared key', () => {
    for (const ip of [undefined, '', 'unknown', 'not an ip', '1.2.3', '1.2.3.4.5', '999.1.1.1', '2001:db8:::1', '12345::', 'g::1', '1.2.3.4:80', '::ffff:1.2.3']) {
      expect(addressKey(ip), String(ip)).toBe('unknown');
    }
  });
});
