import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hub, type HubEvent } from '../src/data/hub.js';
import { InstanceData } from '../src/data/store.js';
import { LagerError } from '../src/errors.js';

let dir: string;
let hub: Hub;
let store: InstanceData;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lager-data-'));
  hub = new Hub();
  store = new InstanceData(dir, hub, 20);
});
afterEach(() => {
  vi.useRealTimers();
  store.close();
});

function code(fn: () => unknown): string {
  try { fn(); } catch (e) { if (e instanceof LagerError) return e.code; throw e; }
  return 'none';
}

describe('InstanceData', () => {
  it('set/get/update/delete roundtrip', () => {
    expect(store.get('i1', 'tasks/t1')).toBeNull();
    const d1 = store.set('i1', 'tasks/t1', { a: 1, b: 2 }, 'u1');
    expect(d1.version).toBe(1);
    expect(d1).toMatchObject({ path: 'tasks/t1', id: 't1', updatedBy: 'u1' });
    const d2 = store.set('i1', 'tasks/t1', { c: 3 }, 'u1');
    expect(d2.version).toBe(2);
    expect(d2.data).toEqual({ c: 3 });
    expect(d2.createdAt).toBe(d1.createdAt);

    store.set('i1', 'tasks/t2', { a: { x: 1 } }, null);
    const merged = store.update('i1', 'tasks/t2', { a: { y: 2 } }, null);
    expect(merged.data).toEqual({ a: { x: 1, y: 2 } });
    expect(merged.version).toBe(2);
    const created = store.update('i1', 'tasks/t9', { z: 1 }, null);
    expect(created.data).toEqual({ z: 1 });
    expect(created.version).toBe(1);

    expect(store.delete('i1', 'tasks/t1')).toBe(true);
    expect(store.delete('i1', 'tasks/t1')).toBe(false);
    expect(store.get('i1', 'tasks/t1')).toBeNull();
  });

  it('query filters, sorts, limits', () => {
    store.set('i1', 'tasks/t1', { n: 1, tags: ['a'] }, null);
    store.set('i1', 'tasks/t2', { n: 2, tags: ['b'] }, null);
    store.set('i1', 'tasks/t3', { n: 3, done: true, meta: { k: 'z' } }, null);
    store.set('i1', 'tasks/t1/sub/s1', { n: 99 }, null);
    const ids = (spec?: Parameters<InstanceData['query']>[2]) => store.query('i1', 'tasks', spec).map((d) => d.id);
    expect(ids()).toEqual(['t1', 't2', 't3']);
    expect(ids({ where: [['n', '>=', 2]] })).toEqual(['t2', 't3']);
    expect(ids({ where: [['tags', 'array-contains', 'a']] })).toEqual(['t1']);
    expect(ids({ where: [['meta.k', '==', 'z']] })).toEqual(['t3']);
    expect(ids({ where: [['n', 'in', [1, 3]]] })).toEqual(['t1', 't3']);
    expect(ids({ orderBy: [['n', 'desc']], limit: 2 })).toEqual(['t3', 't2']);
    expect(ids({ where: [['n', '==', '1']] })).toEqual([]);
    expect(store.query('i1', 'tasks/t1/sub').map((d) => d.id)).toEqual(['s1']);
    expect(store.query('nothing-here', 'tasks')).toEqual([]);
    expect(code(() => store.query('i1', 'tasks', { limit: 0 }))).toBe('invalid_argument');
    expect(code(() => store.query('i1', 'tasks', { limit: 1001 }))).toBe('invalid_argument');
    expect(code(() => store.query('i1', 'tasks', { where: [['n', '~' as never, 1]] }))).toBe('invalid_argument');
  });

  it('limits', () => {
    expect(code(() => store.set('i1', 'a//b', {}, null))).toBe('invalid_argument');
    expect(code(() => store.get('i1', 'a'))).toBe('invalid_argument');
    expect(code(() => store.query('i1', 'a/b'))).toBe('invalid_argument');
    const deep = Array.from({ length: 18 }, (_, i) => `s${i}`).join('/');
    expect(code(() => store.set('i1', deep, {}, null))).toBe('invalid_argument');
    expect(code(() => store.set('i1', `a/${'x'.repeat(201)}`, {}, null))).toBe('invalid_argument');
    // 8 segments of 150 bytes pass the segment rules but exceed 1000 bytes in total; 6 fit.
    const seg = 'y'.repeat(150);
    expect(code(() => store.set('i1', Array.from({ length: 8 }, () => seg).join('/'), {}, null))).toBe('invalid_argument');
    expect(store.set('i1', Array.from({ length: 6 }, () => seg).join('/'), {}, null).path).toHaveLength(6 * 150 + 5);
    expect(code(() => store.set('i1', 'a/b', 'x'.repeat(300 * 1024) as never, null))).toBe('invalid_argument');
    expect(code(() => store.set('i1', 'a/b', { big: 'x'.repeat(300 * 1024) }, null))).toBe('invalid_argument');
    let nested: Record<string, unknown> = {};
    for (let i = 0; i < 33; i++) nested = { n: nested };
    expect(code(() => store.set('i1', 'a/b', nested, null))).toBe('invalid_argument');
    expect(code(() => store.set('i1', 'a/b', [] as never, null))).toBe('invalid_argument');
    expect(code(() => store.set('i1', 'a/b', null as never, null))).toBe('invalid_argument');
    expect(code(() => store.update('i1', 'a/b', [] as never, null))).toBe('invalid_argument');
    expect(code(() => store.get('../x', 'a/b'))).toBe('invalid_argument');
  });

  it('publishes change events', () => {
    const events: HubEvent[] = [];
    hub.subscribe('i1', (e) => events.push(e));
    store.set('i1', 'tasks/t1', { a: 1 }, null);
    store.update('i1', 'tasks/t1', { b: 1 }, null);
    store.delete('i1', 'tasks/t1');
    const ev = { type: 'change', path: 'tasks/t1', parent: 'tasks' };
    expect(events).toEqual([ev, ev, ev]);
  });

  it('instances are isolated', () => {
    store.set('i1', 'tasks/t1', { v: 1 }, null);
    store.set('i2', 'tasks/t1', { v: 2 }, null);
    expect(store.get('i1', 'tasks/t1')!.data).toEqual({ v: 1 });
    expect(store.get('i2', 'tasks/t1')!.data).toEqual({ v: 2 });
    expect(fs.existsSync(path.join(dir, 'instances', 'i1', 'data.sqlite'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'instances', 'i2', 'data.sqlite'))).toBe(true);
  });

  it('a where or orderBy that is not a list is an invalid argument, not a crash', () => {
    store.set('i1', 'tasks/a', { n: 1 }, null);
    for (const spec of [{ where: {} }, { where: 5 }, { where: 'n' }, { orderBy: {} }, { orderBy: 'n' }, { where: [{}] }, { orderBy: [{}] }]) {
      expect(code(() => store.query('i1', 'tasks', spec as never)), JSON.stringify(spec)).toBe('invalid_argument');
      expect(code(() => store.query('nothing-yet', 'tasks', spec as never)), JSON.stringify(spec)).toBe('invalid_argument');
    }
  });

  it('remembers who wrote shared documents, not who used a private area', () => {
    store.set('i1', 'tasks/a', { n: 1 }, 'alice');
    store.update('i1', 'tasks/a', { n: 2 }, 'bob');
    store.acquire('i1', 'locks/l', { holder: 'h' }, 'carol');
    store.importDocs('i1', [{ path: 'tasks/b', data: {} }, { path: 'data/users/dora/prefs', data: {} }], 'dora', { allowPrivateOf: 'dora' });
    store.set('i1', 'data/users/erin/prefs', { n: 1 }, 'erin');
    store.set('i1', 'tasks/anon', { n: 1 }, null);
    store.delete('i1', 'tasks/a');
    store.delete('i1', 'tasks/b');
    expect(['alice', 'bob', 'carol', 'dora', 'erin', 'nobody'].map((u) => store.hasAuthor('i1', u))).toEqual([true, true, true, true, false, false]);
    expect(store.hasAuthor('never-opened', 'alice')).toBe(false);
  });

  it('a database from before the authors table is filled once from its documents, also after a restore', () => {
    const file = path.join(dir, 'instances', 'old', 'data.sqlite');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE docs (path TEXT PRIMARY KEY, parent TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT, lease_holder TEXT, lease_expires TEXT)`);
    const ins = old.prepare("INSERT INTO docs (path, parent, id, data, created_at, updated_at, updated_by) VALUES (?, ?, ?, '{}', 'x', 'x', ?)");
    ins.run('tasks/a', 'tasks', 'a', 'alice');
    ins.run('tasks/b', 'tasks', 'b', null);
    ins.run('data/users/erin/prefs/p', 'data/users/erin/prefs', 'p', 'erin');
    old.close();
    expect(store.hasAuthor('old', 'alice')).toBe(true);
    expect(store.hasAuthor('old', 'erin')).toBe(false);
    // The backfill runs once: an author whose document is gone is not lost when the database is opened again.
    store.delete('old', 'tasks/a');
    store.close();
    store = new InstanceData(dir, hub, 20);
    expect(store.hasAuthor('old', 'alice')).toBe(true);

    // A restore brings back the snapshot's own list; a snapshot from before the table is filled like any old database.
    const snap = store.snapshot('old', 'with-alice')!;
    store.set('old', 'tasks/c', {}, 'bob');
    store.restore('old', snap.id);
    expect([store.hasAuthor('old', 'alice'), store.hasAuthor('old', 'bob')]).toEqual([true, false]);
    store.set('old', 'tasks/d', {}, 'bob');
    expect(store.hasAuthor('old', 'bob')).toBe(true);
    const legacy = new DatabaseSync(path.join(dir, 'instances', 'old', 'snapshots', `${snap.id}.sqlite`));
    legacy.exec('DROP TABLE authors');
    legacy.close();
    store.restore('old', snap.id);
    expect([store.hasAuthor('old', 'alice'), store.hasAuthor('old', 'bob')]).toEqual([false, false]);
    expect(store.query('old', 'tasks').map((d) => d.id)).toEqual(['b']);
  });

  it('acquire grants, refuses, expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const a = store.acquire('i1', 'locks/l1', { holder: 'A', ttlMs: 1000, data: { owner: 'A' } }, null);
    expect(a).toEqual({ acquired: true, expiresAt: '2026-01-01T00:00:01.000Z', version: 1 });
    expect(store.get('i1', 'locks/l1')!.data).toEqual({ owner: 'A' });
    const b = store.acquire('i1', 'locks/l1', { holder: 'B', ttlMs: 1000 }, null);
    // The holder string is the lease's only credential: a refused caller must not learn it.
    expect(b).toEqual({ acquired: false, expiresAt: '2026-01-01T00:00:01.000Z', version: 1 });
    expect(store.acquire('i1', 'locks/l1', { holder: 'A', ttlMs: 1000 }, null).acquired).toBe(true);
    vi.setSystemTime(new Date('2026-01-01T00:00:02Z'));
    const c = store.acquire('i1', 'locks/l1', { holder: 'B', ttlMs: 1000, data: { extra: 1 } }, null);
    expect(c.acquired).toBe(true);
    expect(store.get('i1', 'locks/l1')!.data).toEqual({ owner: 'A', extra: 1 });
    expect(code(() => store.acquire('i1', 'locks/l1', { holder: 'B', ttlMs: 999999 }, null))).toBe('none');
  });

  it('snapshot and restore', () => {
    expect(store.snapshot('empty', 'x')).toBeNull();
    store.set('i1', 'tasks/t1', { v: 1 }, null);
    const snap = store.snapshot('i1', 'manual')!;
    expect(snap.label).toBe('manual');
    expect(snap.sizeBytes).toBeGreaterThan(0);
    const second = store.snapshot('i1', 'second')!;
    expect(store.listSnapshots('i1').map((s) => s.id)).toEqual([second.id, snap.id]);
    store.set('i1', 'tasks/t1', { v: 2 }, null);
    store.set('i1', 'tasks/t2', { v: 3 }, null);
    const events: HubEvent[] = [];
    hub.subscribe('i1', (e) => events.push(e));
    store.restore('i1', snap.id);
    expect(store.get('i1', 'tasks/t1')!.data).toEqual({ v: 1 });
    expect(store.get('i1', 'tasks/t2')).toBeNull();
    expect(store.listSnapshots('i1').map((s) => s.label)).toEqual(['pre-restore', 'second', 'manual']);
    expect(events).toContainEqual({ type: 'reset' });
    expect(code(() => store.restore('i1', '../../x'))).toBe('invalid_argument');
    expect(code(() => store.restore('i1', '20200101T000000000Z-nope'))).toBe('not_found');
    expect(code(() => store.snapshot('i1', 'Bad Label'))).toBe('invalid_argument');
  });

  it('keeps only snapshotKeep snapshots', () => {
    store.close();
    store = new InstanceData(dir, hub, 2);
    store.set('i1', 'tasks/t1', { v: 1 }, null);
    const made = [1, 2, 3, 4].map((n) => store.snapshot('i1', `s${n}`)!);
    expect(store.listSnapshots('i1').map((s) => s.id)).toEqual([made[3].id, made[2].id]);
  });

  it('data survives reopening', () => {
    store.set('i1', 'tasks/t1', { v: 1 }, null);
    store.close();
    store = new InstanceData(dir, hub, 20);
    expect(store.get('i1', 'tasks/t1')!.data).toEqual({ v: 1 });
    expect(store.hasData('i1')).toBe(true);
    expect(store.hasData('zzz')).toBe(false);
  });
});

describe('InstanceData quota, usage and trash', () => {
  const big = { text: 'x'.repeat(2000) };

  it('a lock on a new document counts against the quota, renewing an existing one does not', () => {
    store.close();
    store = new InstanceData(dir, hub, 20, 64 * 1024);
    store.acquire('q0', 'locks/mine', { holder: 'h' }, null);
    let n = 0;
    let refused = '';
    while (n < 2000 && refused === '') {
      refused = code(() => store.acquire('q0', `locks/${'p'.repeat(190)}${n}`, { holder: 'h' }, null));
      if (refused === 'none') { refused = ''; n++; }
    }
    expect(refused).toBe('quota_exceeded');
    expect(n).toBeLessThan(1000);
    expect(store.acquire('q0', 'locks/mine', { holder: 'h' }, null).acquired).toBe(true);
    expect(code(() => store.acquire('q0', 'locks/mine', { holder: 'h', data: { a: 1 } }, null))).toBe('quota_exceeded');
  });

  it('query drops invisible documents before it sorts and limits', () => {
    store.set('i1', 'c/a', { v: 1 }, null);
    store.set('i1', 'c/b', { v: 2 }, null);
    expect(store.query('i1', 'c', { limit: 1 }).map((d) => d.id)).toEqual(['a']);
    expect(store.query('i1', 'c', { limit: 1 }, (p) => p !== 'c/a').map((d) => d.id)).toEqual(['b']);
  });

  it('quota blocks writes but not reads or deletes', () => {
    store.close();
    store = new InstanceData(dir, hub, 20, 64 * 1024);
    let n = 0;
    while (n < 500) {
      try { store.set('q1', `docs/d${n}`, big, null); } catch (e) {
        expect(code(() => { throw e; })).toBe('quota_exceeded');
        break;
      }
      n++;
    }
    expect(n).toBeGreaterThan(5);
    expect(n).toBeLessThan(500);
    expect(code(() => store.update('q1', 'docs/d0', { a: 1 }, null))).toBe('quota_exceeded');
    expect(code(() => store.acquire('q1', 'locks/l', { holder: 'h', data: { a: 1 } }, null))).toBe('quota_exceeded');
    expect(store.get('q1', 'docs/d0')?.data).toEqual(big);
    expect(store.query('q1', 'docs')).toHaveLength(n);
    for (let i = 0; i < n; i++) expect(store.delete('q1', `docs/d${i}`)).toBe(true);
    expect(store.set('q1', 'docs/again', big, null).version).toBe(1);

    store.close();
    store = new InstanceData(dir, hub, 20, 0);
    for (let i = 0; i < 60; i++) store.set('q2', `docs/d${i}`, big, null);
    expect(store.usage('q2')).toBeGreaterThan(64 * 1024);
  });

  it('usage and trash', () => {
    expect(store.usage('u1')).toBe(0);
    expect(store.hasData('u1')).toBe(false);
    store.trash('u1');
    expect(fs.existsSync(path.join(dir, 'trash'))).toBe(false);
    store.set('u1', 'docs/a', big, null);
    expect(store.usage('u1')).toBeGreaterThan(0);
    store.trash('u1');
    expect(store.hasData('u1')).toBe(false);
    expect(store.get('u1', 'docs/a')).toBeNull();
    const moved = fs.readdirSync(path.join(dir, 'trash')).filter((f) => f.startsWith('u1-'));
    expect(moved).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, 'trash', moved[0], 'data.sqlite'))).toBe(true);
    store.set('u1', 'docs/b', { n: 1 }, null);
    expect(store.get('u1', 'docs/a')).toBeNull();
    expect(store.get('u1', 'docs/b')).not.toBeNull();
  });
});

describe('InstanceData export and import', () => {
  const paths = (gen: Iterable<{ path: string }>): string[] => [...gen].map((d) => d.path);

  it('exportDocs applies a path filter', () => {
    store.set('f1', 'a/1', { n: 1 }, null);
    store.set('f1', 'b/1', { n: 2 }, null);
    expect(paths(store.exportDocs('f1', { filter: (p) => p.startsWith('b/') }))).toEqual(['b/1']);
  });

  it('exportDocs yields nothing for an instance without data and orders by path', () => {
    expect(paths(store.exportDocs('none'))).toEqual([]);
    expect(store.hasData('none')).toBe(false);
    store.set('e1', 'b/1', { n: 2 }, null);
    store.set('e1', 'a/1', { n: 1 }, null);
    store.set('e1', 'a/1/sub/x', { n: 3 }, null);
    expect([...store.exportDocs('e1')]).toEqual([
      { path: 'a/1', data: { n: 1 } }, { path: 'a/1/sub/x', data: { n: 3 } }, { path: 'b/1', data: { n: 2 } },
    ]);
  });

  it('exportDocs pages through more documents than one batch', () => {
    store.importDocs('e2', Array.from({ length: 1234 }, (_, i) => ({ path: `c/d${String(i).padStart(5, '0')}`, data: { i } })), null);
    const out = paths(store.exportDocs('e2'));
    expect(out).toHaveLength(1234);
    expect(out).toEqual([...out].sort());
  });

  it('exportDocs omits other users private areas', () => {
    store.set('p1', 'tasks/t1', { a: 1 }, null);
    store.set('p1', 'data/users/u1/storage/kv/main', { mine: true }, null);
    store.set('p1', 'data/users/u2/storage/kv/main', { theirs: true }, null);
    store.set('p1', 'data/users/u10/storage/kv/main', { theirs: true }, null);
    store.set('p1', 'Data/Users/u2/storage/kv/main', { theirs: true }, null);
    store.set('p1', 'data/usersx/y/z', { fine: true }, null);
    expect(paths(store.exportDocs('p1'))).toEqual(['data/usersx/y/z', 'tasks/t1']);
    expect(paths(store.exportDocs('p1', { includePrivateOf: 'u1' }))).toEqual(['data/users/u1/storage/kv/main', 'data/usersx/y/z', 'tasks/t1']);
    expect(paths(store.exportDocs('p1', { includePrivateOf: 'u' }))).toEqual(['data/usersx/y/z', 'tasks/t1']);
  });

  it('importDocs is all-or-nothing', () => {
    store.set('i1', 'keep/k', { v: 1 }, null);
    const events: HubEvent[] = [];
    hub.subscribe('i1', (e) => events.push(e));
    const bad = [{ path: 'a/1', data: { n: 1 } }, { path: 'a/1/x', data: { n: 2 } }, { path: 'keep/k', data: { v: 2 } }];
    expect(code(() => store.importDocs('i1', bad, null))).toBe('invalid_argument');
    expect(store.get('i1', 'a/1')).toBeNull();
    expect(store.get('i1', 'keep/k')?.data).toEqual({ v: 1 });
    expect(code(() => store.importDocs('i1', [{ path: 'a/1', data: { n: 1 } }, { path: 'a/2', data: [] as never }], null))).toBe('invalid_argument');
    expect(code(() => store.importDocs('i1', [{ path: 'a/1', data: { n: 1 } }, { path: 'a/2', data: { big: 'x'.repeat(300_000) } }], null))).toBe('invalid_argument');
    expect(store.get('i1', 'a/1')).toBeNull();
    expect(events).toEqual([]);

    expect(store.importDocs('i1', [{ path: 'a/1', data: { n: 1 } }, { path: 'keep/k', data: { v: 2 } }], 'u9')).toEqual({ imported: 2 });
    expect(store.get('i1', 'a/1')?.data).toEqual({ n: 1 });
    const k = store.get('i1', 'keep/k')!;
    expect(k.data).toEqual({ v: 2 });
    expect(k.version).toBe(2);
    expect(k.updatedBy).toBe('u9');
    expect(events).toEqual([{ type: 'reset' }]);
  });

  it('importDocs rolls back when a failure happens during the write', () => {
    const docs = (function* () {
      yield { path: 'a/1', data: { n: 1 } };
      throw new Error('stream broke');
    })();
    expect(() => store.importDocs('i2', docs, null)).toThrow('stream broke');
    expect(store.get('i2', 'a/1')).toBeNull();
  });

  it('importDocs refuses foreign private paths', () => {
    const refuse = (p: string, allow?: string): string => code(() => store.importDocs('f1', [{ path: 'ok/doc', data: {} }, { path: p, data: {} }], null, allow ? { allowPrivateOf: allow } : {}));
    expect(refuse('data/users/u2/x/y/z')).toBe('forbidden');
    expect(refuse('data/users/u2/x/y/z', 'u1')).toBe('forbidden');
    expect(refuse('data/users/u1/x/y/z')).toBe('forbidden');
    expect(refuse('data/users/u1x/x/y/z', 'u1')).toBe('forbidden');
    expect(refuse('data/users/u/x/y/z', 'u1')).toBe('forbidden');
    expect(refuse('DATA/users/u1/x/y/z', 'u1')).toBe('forbidden');
    expect(refuse('data/Users/u1/x/y/z', 'u1')).toBe('forbidden');
    expect(refuse('data/users/U1/x/y/z', 'u1')).toBe('forbidden');
    expect(refuse('data/users', 'u1')).toBe('forbidden');
    expect(refuse('data/users/u1', 'u1')).toBe('invalid_argument');
    expect(store.get('f1', 'ok/doc')).toBeNull();
    expect(store.importDocs('f1', [{ path: 'data/users/u1/x/y/z', data: { a: 1 } }, { path: 'data/usersx/q/r', data: {} }], null, { allowPrivateOf: 'u1' })).toEqual({ imported: 2 });
  });

  it('importDocs respects the quota', () => {
    store.close();
    store = new InstanceData(dir, hub, 20, 64 * 1024);
    const big = { text: 'x'.repeat(2000) };
    const docs = Array.from({ length: 200 }, (_, i) => ({ path: `docs/d${i}`, data: big }));
    expect(code(() => store.importDocs('q1', docs, null))).toBe('quota_exceeded');
    expect(store.query('q1', 'docs')).toEqual([]);
    expect(store.importDocs('q1', docs.slice(0, 5), null)).toEqual({ imported: 5 });
    store.setExtraUsage(() => 64 * 1024);
    expect(code(() => store.importDocs('q1', docs.slice(0, 1), null))).toBe('quota_exceeded');
  });

  it('importDocs of an empty set writes and announces nothing', () => {
    const events: HubEvent[] = [];
    hub.subscribe('z1', (e) => events.push(e));
    expect(store.importDocs('z1', [], null)).toEqual({ imported: 0 });
    expect(events).toEqual([]);
  });

  it('later duplicates of a path win', () => {
    store.importDocs('d1', [{ path: 'a/1', data: { n: 1 } }, { path: 'a/1', data: { n: 2 } }], null);
    expect(store.get('d1', 'a/1')?.data).toEqual({ n: 2 });
  });
});

describe('path rules shared with the browser runtime', () => {
  it('refuses segments the runtime could not address', async () => {
    const { parseDocPath, assertCollectionPath } = await import('../src/data/paths.js');
    for (const bad of ['notes/Mein Eintrag', 'notes/ä', 'notes/a%20b', 'notes/..', 'notes/.', 'a b', 'notes/x#y']) {
      expect(() => (bad.split('/').length % 2 === 0 ? parseDocPath(bad) : assertCollectionPath(bad)), bad).toThrow(LagerError);
    }
    for (const good of ['notes/a-b_c.d~e:f@g+h', 'data/users/3f2a/settings/main/x', 'notes/2026-11-19T10:00']) {
      expect(() => parseDocPath(good), good).not.toThrow();
    }
  });
});
