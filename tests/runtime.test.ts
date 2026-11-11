// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { assertCollectionPath, parseDocPath } from '../src/data/paths.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */
const SOURCE = fs.readFileSync(path.resolve(process.cwd(), 'src/runtime/runtime.js'), 'utf8');
const g = globalThis as any;

interface StoredDoc { path: string; id: string; data: Record<string, unknown>; version: number; createdAt: string; updatedAt: string; updatedBy: string | null }
type Call = [string, any];

const OWNER = { id: 'u1', name: 'Ada', email: 'ada@example.org', level: 'owner', isOwner: true, canEdit: true };
const sessionOf = (viewer: Record<string, unknown>): { status: number; body: unknown } => ({
  status: 200,
  body: { viewer, instance: { id: 'i1', slug: 'demo', appSlug: 'demo', version: 1 }, capabilities: {}, loginUrl: '/login' },
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  closed = false;
  private handlers = new Map<string, ((e: { data?: string }) => void)[]>();
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  addEventListener(type: string, fn: (e: { data?: string }) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  close(): void { this.closed = true; }
  emit(type: string, data?: unknown): void {
    for (const fn of this.handlers.get(type) ?? []) fn({ data: data === undefined ? undefined : JSON.stringify(data) });
  }
}

let calls: Call[];
let docs: Map<string, StoredDoc>;
let session: { status: number; body: unknown } | 'network-error';
let users: Record<string, { id: string; name: string; email: string | null; isMe: boolean }>;
let clock: number;

const parentOf = (path: string): string => path.split('/').slice(0, -1).join('/');
const dbCalls = (): any[] => calls.filter(([u]) => u === '/__lager/db').map(([, init]) => JSON.parse(init.body));
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function put(path: string, data: Record<string, unknown>): StoredDoc {
  const prev = docs.get(path);
  const now = new Date(1_700_000_000_000 + ++clock * 1000).toISOString();
  const doc: StoredDoc = {
    path, id: path.split('/').pop()!, data, version: (prev?.version ?? 0) + 1,
    createdAt: prev?.createdAt ?? now, updatedAt: now, updatedBy: 'u1',
  };
  docs.set(path, doc);
  return doc;
}

function runQuery(path: string, spec: any): StoredDoc[] {
  let out = [...docs.values()].filter((d) => parentOf(d.path) === path);
  for (const [f, op, v] of spec.where ?? []) {
    if (op !== '==') throw new Error('fake supports == only');
    out = out.filter((d) => d.data[f] === v);
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  for (const [f, dir] of [...(spec.orderBy ?? [])].reverse()) {
    out.sort((a, b) => {
      const x = a.data[f] as number; const y = b.data[f] as number;
      return (x < y ? -1 : x > y ? 1 : 0) * (dir === 'desc' ? -1 : 1);
    });
  }
  return spec.limit ? out.slice(0, spec.limit) : out;
}

async function fakeFetch(url: string, init?: any): Promise<Response> {
  calls.push([url, init]);
  if (url === '/__lager/session') {
    if (session === 'network-error') throw new TypeError('network down');
    return json(session.body, session.status);
  }
  if (url.startsWith('/__lager/users?q=')) {
    const q = decodeURIComponent(url.slice('/__lager/users?q='.length)).toLowerCase();
    return json({ profiles: Object.values(users).filter((u) => u.name.toLowerCase().includes(q)) });
  }
  if (url.startsWith('/__lager/users?ids=')) {
    const ids = decodeURIComponent(url.slice('/__lager/users?ids='.length)).split(',');
    const profiles: Record<string, unknown> = {};
    for (const id of ids) if (users[id]) profiles[id] = users[id];
    return json({ profiles });
  }
  if (url === '/__lager/db') {
    const b = JSON.parse(init.body);
    const code = /^err\/(\w+)$/.exec(b.path)?.[1];
    if (code) return json({ error: { code, message: `boom ${code}` } }, 400);
    switch (b.op) {
      case 'get': return json({ doc: docs.get(b.path) ?? null });
      case 'set': return json({ doc: put(b.path, b.data) });
      case 'update': {
        const prev = docs.get(b.path);
        if (!prev) return json({ error: { code: 'invalid_argument', message: 'missing' } }, 400);
        return json({ doc: put(b.path, { ...prev.data, ...b.data }) });
      }
      case 'delete': docs.delete(b.path); return json({ ok: true });
      case 'query': return json({ docs: runQuery(b.path, b.query ?? {}) });
      case 'acquire':
        if (b.path === 'locks/busy') return json({ acquired: false, expiresAt: 'x', holder: 'someone' });
        return json({ acquired: true, version: 1, holder: b.options.holder, expiresAt: 'x' });
      default: return json({ error: { code: 'invalid_argument', message: 'op' } }, 400);
    }
  }
  if (url === '/__lager/assets' || url.startsWith('/__lager/assets/')) {
    const type = init?.headers?.['Content-Type'] as string | undefined;
    if (init?.method === 'POST') {
      const status = /^x\/s(\d+)$/.exec(type ?? '')?.[1];
      if (status) return json({ error: { code: 'x', message: 'boom', reason: type === 'x/s400' ? 'unsupported_type' : undefined } }, Number(status));
      return json({ id: 'a'.repeat(32), url: `/_blob/${'a'.repeat(32)}`, sizeBytes: init.body.size, contentType: type }, 201);
    }
    if (init?.method === 'DELETE') {
      return url.endsWith('/' + 'b'.repeat(32)) ? json({ error: { code: 'forbidden', message: 'no' } }, 403) : json({ deleted: true });
    }
    return json({
      assets: [{ id: 'n'.padEnd(32, '1'), url: '/_blob/new', contentType: 'image/png', sizeBytes: 2, createdAt: '2026-02-01T00:00:00.000Z' },
        { id: 'o'.padEnd(32, '1'), url: '/_blob/old', contentType: 'image/png', sizeBytes: 1, createdAt: '2026-01-01T00:00:00.000Z' }],
      usage: { files: 2, bytes: 3, maxFiles: 2000, maxBytes: 1000 },
    });
  }
  return json({ error: { code: 'not_found', message: 'x' } }, 404);
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const es = (): FakeEventSource => FakeEventSource.instances[FakeEventSource.instances.length - 1];

function boot(): any {
  delete g.claude;
  delete g.storage;
  (0, eval)(SOURCE);
  return g.claude;
}

beforeEach(() => {
  calls = []; docs = new Map(); users = {}; clock = 0;
  session = sessionOf(OWNER);
  FakeEventSource.instances = [];
  g.fetch = fakeFetch;
  g.EventSource = FakeEventSource;
});
afterEach(() => { delete g.claude; delete g.storage; });

describe('claude.use', () => {
  it('use is memoized and unknown names resolve null', async () => {
    const claude = boot();
    const a = await claude.use('db');
    expect(a).not.toBeNull();
    expect(await claude.use('db')).toBe(a);
    expect(await claude.use('nope')).toBeNull();
    expect(await claude.use('constructor')).toBeNull();
    await claude.use('user');
    const sessionCalls = calls.filter(([u]) => u === '/__lager/session');
    expect(sessionCalls).toHaveLength(1);
    expect(sessionCalls[0][1]).toEqual({ credentials: 'same-origin' });
  });

  it('is lazy: no request before the first use', () => {
    boot();
    expect(calls).toHaveLength(0);
  });

  it('db is null when the session is 401', async () => {
    session = { status: 401, body: { error: { code: 'unauthenticated', message: 'Sign in required.' } } };
    const claude = boot();
    expect(await claude.use('db')).toBeNull();
    const user = await claude.use('user');
    expect(user).not.toBeNull();
    expect(await user.isOwner()).toBe(false);
    expect(await user.id()).toBeNull();
  });

  it('db is null on a network failure and when the level is absent', async () => {
    session = 'network-error';
    expect(await boot().use('db')).toBeNull();
    session = sessionOf({ id: null, name: '', email: null });
    expect(await boot().use('db')).toBeNull();
  });

  it('window.claude is frozen', async () => {
    const claude = boot();
    expect(Object.isFrozen(claude)).toBe(true);
    expect(Object.keys(claude).sort()).toEqual(['complete', 'use']);
    expect(Object.isFrozen(await claude.use('db'))).toBe(true);
    expect(Object.isFrozen(await claude.use('user'))).toBe(true);
    expect(Object.isFrozen(g.storage)).toBe(true);
  });

  it('claude.complete rejects', async () => {
    const claude = boot();
    await expect(claude.complete()).rejects.toThrow('claude.complete is not available on this Lager server');
    await expect(claude.complete()).rejects.toBeInstanceOf(Error);
  });
});

describe('db', () => {
  it('doc set/get/update/delete send the right requests', async () => {
    const db = await boot().use('db');
    const ref = db.doc('tasks/t1');
    expect(ref.id).toBe('t1');
    expect(ref.path).toBe('tasks/t1');
    expect(await ref.set({ title: 'a', n: 1 })).toBeUndefined();
    const snap = await ref.get();
    expect(snap.exists).toBe(true);
    expect(snap.id).toBe('t1');
    expect(snap.data()).toEqual({ title: 'a', n: 1 });
    expect(snap.metadata).toEqual({ fromCache: false, hasPendingWrites: false });
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.data())).toBe(true);
    await ref.update({ n: 2 });
    expect((await ref.get()).data()).toEqual({ title: 'a', n: 2 });
    expect(await ref.delete()).toBeUndefined();
    expect((await ref.get()).exists).toBe(false);
    expect(await ref.acquire({ holder: 'tab1', ttlMs: 5000 })).toEqual({ acquired: true, version: 1, holder: 'tab1', expiresAt: 'x' });
    expect(await db.doc('locks/busy').acquire({ holder: 'tab1' })).toEqual({ acquired: false, expiresAt: 'x' });

    expect(dbCalls()).toEqual([
      { op: 'set', path: 'tasks/t1', data: { title: 'a', n: 1 } },
      { op: 'get', path: 'tasks/t1' },
      { op: 'update', path: 'tasks/t1', data: { n: 2 } },
      { op: 'get', path: 'tasks/t1' },
      { op: 'delete', path: 'tasks/t1' },
      { op: 'get', path: 'tasks/t1' },
      { op: 'acquire', path: 'tasks/t1', options: { holder: 'tab1', ttlMs: 5000 } },
      { op: 'acquire', path: 'locks/busy', options: { holder: 'tab1' } },
    ]);
    const init = calls.find(([u]) => u === '/__lager/db')![1];
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', 'X-Lager-Request': '1' });
  });

  it('update on a missing doc rejects invalid_argument', async () => {
    const db = await boot().use('db');
    await expect(db.doc('tasks/nope').update({ a: 1 })).rejects.toEqual({ code: 'invalid_argument', message: 'missing' });
  });

  it('missing doc snapshot', async () => {
    const db = await boot().use('db');
    const snap = await db.doc('tasks/none').get();
    expect(snap.exists).toBe(false);
    expect(snap.id).toBe('none');
    expect(snap.data()).toBeUndefined();
    expect(snap.metadata).toEqual({ fromCache: false, hasPendingWrites: false });
  });

  it('collection add and auto ids', async () => {
    const db = await boot().use('db');
    const col = db.collection('tasks');
    expect(col.path).toBe('tasks');
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const id = col.doc().id;
      expect(id).toMatch(/^[A-Za-z0-9]{20}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(50);
    expect(col.doc('fixed').path).toBe('tasks/fixed');
    const ref = await col.add({ title: 'x' });
    expect(ref.id).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(ref.path).toBe(`tasks/${ref.id}`);
    expect(dbCalls()).toEqual([{ op: 'set', path: ref.path, data: { title: 'x' } }]);
    expect((await ref.get()).data()).toEqual({ title: 'x' });
    expect(db.doc('boards/b1').collection('cols').path).toBe('boards/b1/cols');
    expect(db.collection('boards/b1/cols').doc('c1').path).toBe('boards/b1/cols/c1');
  });

  it('rejects malformed paths synchronously with TypeError', async () => {
    const db = await boot().use('db');
    expect(() => db.doc('tasks')).toThrow(TypeError);
    expect(() => db.collection('tasks/t1')).toThrow(TypeError);
    expect(() => db.doc('tasks//t1')).toThrow(TypeError);
    expect(() => db.doc('tasks/..')).toThrow(TypeError);
    expect(() => db.doc('tasks/a b')).toThrow(TypeError);
    expect(() => db.collection(Array.from({ length: 17 }, () => 'a').join('/'))).toThrow(TypeError);
    expect(() => db.doc('a/b').collection('c/d')).toThrow(TypeError);
    expect(() => db.collection('a').doc(5)).toThrow(TypeError);
    expect(calls.filter(([u]) => u === '/__lager/db')).toHaveLength(0);
  });

  it('query chaining is immutable and sends where/orderBy/limit', async () => {
    const db = await boot().use('db');
    for (const [id, n, done] of [['a', 3, true], ['b', 1, true], ['c', 2, false]] as const) put(`tasks/${id}`, { n, done });
    const col = db.collection('tasks');
    const q1 = col.where('done', '==', true);
    const q2 = q1.orderBy('n', 'desc');
    const q3 = q2.limit(1);
    expect(q1).not.toBe(q2);
    expect(q2).not.toBe(q3);

    const s1 = await q1.get();
    expect(s1.docs.map((d: any) => d.id)).toEqual(['a', 'b']);
    const s2 = await q2.get();
    expect(s2.docs.map((d: any) => d.id)).toEqual(['a', 'b']);
    const s3 = await q3.get();
    expect(s3.docs.map((d: any) => d.id)).toEqual(['a']);
    expect(s3.size).toBe(1);
    expect(s3.empty).toBe(false);
    expect((await col.where('done', '==', 'zzz').get()).empty).toBe(true);
    await col.orderBy('n').get();

    expect(dbCalls()).toEqual([
      { op: 'query', path: 'tasks', query: { where: [['done', '==', true]] } },
      { op: 'query', path: 'tasks', query: { where: [['done', '==', true]], orderBy: [['n', 'desc']] } },
      { op: 'query', path: 'tasks', query: { where: [['done', '==', true]], orderBy: [['n', 'desc']], limit: 1 } },
      { op: 'query', path: 'tasks', query: { where: [['done', '==', 'zzz']] } },
      { op: 'query', path: 'tasks', query: { orderBy: [['n', 'asc']] } },
    ]);
    // the plain collection is unaffected by chaining
    await col.get();
    expect(dbCalls().pop()).toEqual({ op: 'query', path: 'tasks', query: {} });
  });

  it('query get reports all docs as added', async () => {
    const db = await boot().use('db');
    put('tasks/a', { n: 1 });
    put('tasks/b', { n: 2 });
    const snap = await db.collection('tasks').get();
    expect(snap.docChanges().map((c: any) => [c.type, c.doc.id, c.oldIndex, c.newIndex])).toEqual([['added', 'a', -1, 0], ['added', 'b', -1, 1]]);
    expect(snap.metadata).toEqual({ fromCache: false, hasPendingWrites: false });
    expect(snap.docs[0].data()).toEqual({ n: 1 });
  });

  it('quota_exceeded is passed through', async () => {
    const db = await boot().use('db');
    await expect(db.collection('err').doc('quota_exceeded').set({ a: 1 })).rejects.toMatchObject({ code: 'quota_exceeded' });
    await expect(db.doc('err/quota_exceeded').get()).rejects.toMatchObject({ code: 'quota_exceeded' });
  });

  it('error codes are mapped', async () => {
    const db = await boot().use('db');
    await expect(db.doc('err/forbidden').get()).rejects.toEqual({ code: 'not_granted', message: 'boom forbidden' });
    await expect(db.doc('err/invalid_argument').set({})).rejects.toEqual({ code: 'invalid_argument', message: 'boom invalid_argument' });
    await expect(db.doc('err/quota_exceeded').set({})).rejects.toEqual({ code: 'quota_exceeded', message: 'boom quota_exceeded' });
    await expect(db.doc('err/conflict').delete()).rejects.toEqual({ code: 'unavailable', message: 'boom conflict' });
    await expect(db.doc('err/unauthenticated').get()).rejects.toMatchObject({ code: 'unavailable' });
    await expect(db.collection('err').doc('forbidden').get()).rejects.toMatchObject({ code: 'not_granted' });
    g.fetch = async (u: string) => { if (u === '/__lager/db') throw new TypeError('offline'); return fakeFetch(u); };
    await expect(db.doc('tasks/x').get()).rejects.toMatchObject({ code: 'unavailable' });
    await expect(db.doc('tasks/x').set({ big: 1n })).rejects.toMatchObject({ code: 'invalid_argument' });
  });
});

describe('onSnapshot', () => {
  it('doc onSnapshot emits initial and on matching change only', async () => {
    const db = await boot().use('db');
    const seen: any[] = [];
    const unsub = db.doc('tasks/t1').onSnapshot((s: any) => seen.push(s));
    await flush();
    expect(seen).toHaveLength(1);
    expect(seen[0].exists).toBe(false);
    expect(seen[0].data()).toBeUndefined();
    expect(es().url).toBe('/__lager/db/events');

    const before = calls.length;
    es().emit('change', { path: 'tasks/other', parent: 'tasks' });
    await flush();
    expect(calls.length).toBe(before);
    expect(seen).toHaveLength(1);

    put('tasks/t1', { v: 1 });
    es().emit('change', { path: 'tasks/t1', parent: 'tasks' });
    await flush();
    expect(seen).toHaveLength(2);
    expect(seen[1].data()).toEqual({ v: 1 });

    // same version again: fetched but not emitted
    es().emit('change', { path: 'tasks/t1', parent: 'tasks' });
    await flush();
    expect(seen).toHaveLength(2);

    put('tasks/t1', { v: 2 });
    es().emit('change', { path: 'tasks/t1', parent: 'tasks' });
    await flush();
    expect(seen).toHaveLength(3);
    docs.delete('tasks/t1');
    es().emit('change', { path: 'tasks/t1', parent: 'tasks' });
    await flush();
    expect(seen).toHaveLength(4);
    expect(seen[3].exists).toBe(false);

    unsub();
    put('tasks/t1', { v: 9 });
    es().emit('change', { path: 'tasks/t1', parent: 'tasks' });
    await flush();
    expect(seen).toHaveLength(4);
  });

  it('query onSnapshot reports docChanges', async () => {
    const db = await boot().use('db');
    put('tasks/a', { n: 1 });
    put('tasks/b', { n: 2 });
    put('other/z', { n: 9 });
    const snaps: any[] = [];
    db.collection('tasks').orderBy('n').onSnapshot((s: any) => snaps.push(s));
    await flush();
    expect(snaps).toHaveLength(1);
    const brief = (s: any): unknown[] => s.docChanges().map((c: any) => [c.type, c.doc.id, c.oldIndex, c.newIndex]);
    expect(brief(snaps[0])).toEqual([['added', 'a', -1, 0], ['added', 'b', -1, 1]]);

    // an event for another collection is ignored
    const before = calls.length;
    es().emit('change', { path: 'other/z', parent: 'other' });
    await flush();
    expect(calls.length).toBe(before);

    // add c at the front, modify b
    put('tasks/c', { n: 0 });
    put('tasks/b', { n: 5 });
    es().emit('change', { path: 'tasks/c', parent: 'tasks' });
    await flush();
    expect(snaps).toHaveLength(2);
    expect(snaps[1].docs.map((d: any) => d.id)).toEqual(['c', 'a', 'b']);
    expect(brief(snaps[1])).toEqual([['added', 'c', -1, 0], ['modified', 'b', 1, 2]]);
    // unchanged doc is the same object across deliveries
    expect(snaps[1].docs[1]).toBe(snaps[0].docs[0]);

    docs.delete('tasks/a');
    es().emit('change', { path: 'tasks/a', parent: 'tasks' });
    await flush();
    expect(snaps).toHaveLength(3);
    const removed = snaps[2].docChanges();
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ type: 'removed', oldIndex: 1, newIndex: -1 });
    expect(removed[0].doc.id).toBe('a');
    expect(removed[0].doc.exists).toBe(true);
    expect(removed[0].doc.data()).toEqual({ n: 1 });

    // nothing changed: no emission
    es().emit('change', { path: 'tasks/x', parent: 'tasks' });
    await flush();
    expect(snaps).toHaveLength(3);
  });

  it('EventSource is shared and closed after last unsubscribe', async () => {
    const db = await boot().use('db');
    expect(FakeEventSource.instances).toHaveLength(0);
    const u1 = db.doc('a/1').onSnapshot(() => {});
    const u2 = db.collection('a').onSnapshot(() => {});
    await flush();
    expect(FakeEventSource.instances).toHaveLength(1);
    u1();
    u1(); // idempotent
    expect(es().closed).toBe(false);
    u2();
    expect(es().closed).toBe(true);
    const u3 = db.doc('a/2').onSnapshot(() => {});
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(es().closed).toBe(false);
    u3();
    expect(es().closed).toBe(true);
  });

  it('reset re-emits', async () => {
    const db = await boot().use('db');
    put('tasks/a', { n: 1 });
    const d: any[] = [];
    const q: any[] = [];
    const u1 = db.doc('tasks/a').onSnapshot((s: any) => d.push(s));
    const u2 = db.collection('tasks').onSnapshot((s: any) => q.push(s));
    await flush();
    expect([d.length, q.length]).toEqual([1, 1]);
    put('tasks/a', { n: 2 });
    es().emit('reset');
    await flush();
    expect([d.length, q.length]).toEqual([2, 2]);
    expect(d[1].data()).toEqual({ n: 2 });
    expect(q[1].docs[0].data()).toEqual({ n: 2 });
    es().emit('reset'); // unchanged: no emission
    await flush();
    expect([d.length, q.length]).toEqual([2, 2]);
    u1(); u2();
  });

  it('transient failures retry with backoff and recover; unsubscribe cancels the retry', async () => {
    const db = await boot().use('db');
    put('tasks/t1', { v: 1 });
    const seen: any[] = [];
    const errors: any[] = [];
    vi.useFakeTimers();
    try {
      let failing = true;
      g.fetch = async (u: string, i: any) => {
        if (failing && u === '/__lager/db') throw new TypeError('offline');
        return fakeFetch(u, i);
      };
      const unsub = db.doc('tasks/t1').onSnapshot((s: any) => seen.push(s), (e: any) => errors.push(e));
      await vi.advanceTimersByTimeAsync(0);
      expect(seen).toHaveLength(0);
      expect(errors).toHaveLength(0);
      expect(es().closed).toBe(false);
      await vi.advanceTimersByTimeAsync(999);
      await vi.advanceTimersByTimeAsync(1); // retry 1 at 1s fails, next at +2s
      await vi.advanceTimersByTimeAsync(1999);
      expect(seen).toHaveLength(0);
      failing = false;
      await vi.advanceTimersByTimeAsync(1);
      expect(errors).toHaveLength(0);
      expect(seen).toHaveLength(1);
      expect(seen[0].data()).toEqual({ v: 1 });

      // a pending retry is cancelled by unsubscribe
      failing = true;
      put('tasks/t1', { v: 2 });
      es().emit('change', { path: 'tasks/t1', parent: 'tasks' });
      await vi.advanceTimersByTimeAsync(0);
      const attempts = dbCalls().length;
      expect(vi.getTimerCount()).toBe(1);
      unsub();
      expect(vi.getTimerCount()).toBe(0);
      failing = false;
      await vi.advanceTimersByTimeAsync(60000);
      expect(dbCalls().length).toBe(attempts);
      expect(seen).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a change between the initial fetch and the stream open is caught on open', async () => {
    const db = await boot().use('db');
    put('tasks/t1', { v: 1 });
    const seen: any[] = [];
    db.doc('tasks/t1').onSnapshot((s: any) => seen.push(s));
    await flush();
    expect(seen).toHaveLength(1);
    put('tasks/t1', { v: 2 }); // event emitted before the stream was open is lost
    es().emit('open');
    await flush();
    expect(seen).toHaveLength(2);
    expect(seen[1].data()).toEqual({ v: 2 });
    es().emit('open'); // nothing changed: deduplicated
    await flush();
    expect(seen).toHaveLength(2);
  });

  it('fetch errors go to the error callback and end the listener', async () => {
    const db = await boot().use('db');
    const errors: any[] = [];
    const seen: any[] = [];
    db.doc('err/forbidden').onSnapshot((s: any) => seen.push(s), (e: any) => errors.push(e));
    await flush();
    expect(seen).toHaveLength(0);
    expect(errors).toEqual([{ code: 'not_granted', message: 'boom forbidden' }]);
    expect(es().closed).toBe(true);
  });

  it('overlapping events trigger a follow-up fetch rather than a lost update', async () => {
    const db = await boot().use('db');
    const seen: any[] = [];
    db.doc('tasks/t1').onSnapshot((s: any) => seen.push(s));
    await flush();
    put('tasks/t1', { v: 1 });
    es().emit('change', { path: 'tasks/t1', parent: 'tasks' });
    put('tasks/t1', { v: 2 });
    es().emit('change', { path: 'tasks/t1', parent: 'tasks' });
    await flush();
    await flush();
    expect(seen[seen.length - 1].data()).toEqual({ v: 2 });
  });
});

describe('user', () => {
  it('user namespace for owner', async () => {
    const user = await boot().use('user');
    expect(Object.isFrozen(user)).toBe(true);
    expect(await user.isOwner()).toBe(true);
    expect(await user.canEdit()).toBe(true);
    expect(await user.can('data.write')).toBe(true);
    expect(await user.can('files.write')).toBeNull();
    expect(await user.id()).toBe('u1');
    expect(await user.name()).toBe('Ada');
    expect(await user.email()).toBe('ada@example.org');
    expect(await user.avatarUrl()).toBeNull();
    const me = await user.me();
    expect(me).toEqual({ id: 'u1', name: 'Ada', avatarUrl: '', color: expect.stringMatching(/^hsl\(\d{1,3} 65% 45%\)$/), email: 'ada@example.org', isOwner: true, canEdit: true });
    expect(Number(/hsl\((\d+)/.exec(me.color)![1])).toBeLessThan(360);
    expect((await user.me()).color).toBe(me.color);
    expect(await user.search('a')).toEqual([]);
  });

  it('can(data.write) follows the level', async () => {
    for (const [level, expected] of [['view', false], ['interact', true], ['admin', true], ['owner', true]] as const) {
      session = sessionOf({ id: 'u2', name: 'B', email: null, level, isOwner: level === 'owner', canEdit: level === 'admin' || level === 'owner' });
      expect(await (await boot().use('user')).can('data.write')).toBe(expected);
    }
  });

  it('user namespace for anonymous', async () => {
    session = sessionOf({ id: null, name: '', email: null, level: 'view', isOwner: false, canEdit: false });
    const user = await boot().use('user');
    expect(await user.isOwner()).toBe(false);
    expect(await user.canEdit()).toBe(false);
    expect(await user.can('data.write')).toBe(false);
    expect(await user.id()).toBeNull();
    expect(await user.name()).toBe('');
    expect(await user.email()).toBeNull();
    expect(await user.avatarUrl()).toBeNull();
    const me = await user.me();
    expect(me).toMatchObject({ id: null, name: '', avatarUrl: '', email: null, isOwner: false, canEdit: false });
    expect(me.color).toMatch(/^hsl\(\d+ 65% 45%\)$/);
    expect(await user.profiles(['x'])).toEqual({});
  });

  it('profiles caches and omits unknown ids', async () => {
    users = {
      u1: { id: 'u1', name: 'Ada', email: 'ada@example.org', isMe: true },
      u2: { id: 'u2', name: 'Bob', email: null, isMe: false },
    };
    const user = await boot().use('user');
    const first = await user.profiles(['u1', 'u2', 'ghost', 'u2']);
    expect(Object.keys(first).sort()).toEqual(['u1', 'u2']);
    expect(first.u2).toEqual({ id: 'u2', name: 'Bob', avatarUrl: '', color: expect.stringMatching(/^hsl\(/), email: null, isMe: false, guest: false });
    expect(first.u1.isMe).toBe(true);
    expect(first.u1.color).toBe((await user.me()).color);
    const userCalls = (): string[] => calls.map(([u]) => u).filter((u) => u.startsWith('/__lager/users'));
    expect(userCalls()).toEqual(['/__lager/users?ids=u1,u2,ghost']);
    expect(calls.find(([u]) => u.startsWith('/__lager/users'))![1]).toEqual({ credentials: 'same-origin' });

    expect(Object.keys(await user.profiles('u2'))).toEqual(['u2']);
    expect(Object.keys(await user.profiles(['u1', 'ghost']))).toEqual(['u1']);
    expect(userCalls()).toHaveLength(1);
    users.u3 = { id: 'u3', name: 'Cy', email: null, isMe: false };
    expect(Object.keys(await user.profiles(['u3', 'u1']))).toEqual(['u3', 'u1']);
    expect(userCalls()).toHaveLength(2);
    expect(userCalls()[1]).toBe('/__lager/users?ids=u3');
    expect(await user.profiles([])).toEqual({});
  });

  it('user.search calls the endpoint and never rejects', async () => {
    users = {
      u1: { id: 'u1', name: 'Ada', email: 'ada@example.org', isMe: true },
      u2: { id: 'u2', name: 'Bob', email: null, isMe: false },
    };
    const user = await boot().use('user');
    const searchCalls = (): [string, any][] => calls.filter(([u]) => u.startsWith('/__lager/users?q='));
    const hits = await user.search('b');
    expect(hits).toEqual([{ id: 'u2', name: 'Bob', avatarUrl: '', color: expect.stringMatching(/^hsl\(/), email: null, isMe: false, guest: false }]);
    expect(Object.isFrozen(hits[0])).toBe(true);
    expect(hits[0]).toEqual((await user.profiles(['u2'])).u2);
    expect(searchCalls().map(([u]) => u)).toEqual(['/__lager/users?q=b']);
    expect(searchCalls()[0][1]).toEqual({ credentials: 'same-origin' });
    // a hit is warm: profiles() needs no further request
    expect(calls.filter(([u]) => u.startsWith('/__lager/users?ids='))).toEqual([]);

    // the query is encoded; an empty query is sent as it is
    await user.search('a b&c=d');
    expect(searchCalls()[1][0]).toBe('/__lager/users?q=a%20b%26c%3Dd');
    expect((await user.search('')).map((p: { id: string }) => p.id)).toEqual(['u1', 'u2']);
    expect(searchCalls()[2][0]).toBe('/__lager/users?q=');
    expect(await user.search(undefined)).toEqual([]);
    expect(await user.search(42)).toEqual([]);
    expect(searchCalls()).toHaveLength(3);
  });

  it('user.search returns at most eight profiles and skips malformed and unnamed entries', async () => {
    users = {};
    for (let i = 1; i <= 12; i++) users['p' + i] = { id: 'p' + i, name: 'Person ' + i, email: null, isMe: false };
    const user = await boot().use('user');
    const hits = await user.search('person');
    expect(hits.map((p: { id: string }) => p.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']);
    g.fetch = async () => json({ profiles: [{ name: 'No id' }, null, 'x', { id: 'nameless', name: '' }, { id: 'ok', name: 'Fine', email: 'f@x.y', isMe: false }] });
    const odd = await user.search('x');
    expect(odd.map((p: { id: string }) => p.id)).toEqual(['ok']);
    expect(odd[0].email).toBe('f@x.y');
  });

  it('user.search never rejects', async () => {
    const user = await boot().use('user');
    g.fetch = async () => { throw new TypeError('offline'); };
    expect(await user.search('a')).toEqual([]);
    g.fetch = async () => json({ error: { code: 'unauthenticated', message: 'no' } }, 401);
    expect(await user.search('a')).toEqual([]);
    g.fetch = async () => json({ profiles: 5 });
    expect(await user.search('a')).toEqual([]);
    g.fetch = async () => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } });
    expect(await user.search('a')).toEqual([]);
    // without a session there is nothing to ask
    session = 'network-error';
    calls = [];
    g.fetch = fakeFetch;
    const anonymous = await boot().use('user');
    expect(await anonymous.search('a')).toEqual([]);
    expect(calls.filter(([u]) => u.startsWith('/__lager/users'))).toEqual([]);
  });

  it('a superseded user.search resolves with the newer result', async () => {
    const user = await boot().use('user');
    const reply = (name: string, delay: number) => new Promise<Response>((r) => {
      setTimeout(() => r(json({ profiles: [{ id: 'x-' + name, name, email: null, isMe: false }] })), delay);
    });
    g.fetch = (url: string) => (url.endsWith('q=a') ? reply('Old', 20) : reply('New', 0));
    const [first, second] = await Promise.all([user.search('a'), user.search('ab')]);
    expect(first.map((p: { name: string }) => p.name)).toEqual(['New']);
    expect(second.map((p: { name: string }) => p.name)).toEqual(['New']);
  });

  it('profiles never rejects', async () => {
    const user = await boot().use('user');
    g.fetch = async () => { throw new TypeError('offline'); };
    expect(await user.profiles(['u9'])).toEqual({});
  });
});

describe('assets', () => {
  const withAssets = (viewer: Record<string, unknown> = OWNER, caps: Record<string, unknown> = { assets: {} }): void => {
    session = { status: 200, body: { ...(sessionOf(viewer).body as object), capabilities: caps } };
  };

  it('assets namespace uploads a Blob and maps error codes', async () => {
    withAssets();
    const assets = await boot().use('assets');
    expect(Object.isFrozen(assets)).toBe(true);
    const ok = await assets.upload(new Blob(['abc'], { type: 'image/png' }));
    expect(ok).toEqual({ id: 'a'.repeat(32), url: `/_blob/${'a'.repeat(32)}`, sizeBytes: 3, contentType: 'image/png' });
    const post = calls.find(([u, i]) => u === '/__lager/assets' && i.method === 'POST')!;
    expect(post[1].headers).toEqual({ 'Content-Type': 'image/png', 'X-Lager-Request': '1' });
    expect(post[1].credentials).toBe('same-origin');
    await assets.upload(new Blob(['abc']), { type: 'text/csv' });
    expect(calls.filter(([u]) => u === '/__lager/assets').pop()![1].headers['Content-Type']).toBe('text/csv');
    const code = (p: Promise<unknown>): Promise<string> => p.then(() => 'resolved', (e: { code: string }) => e.code);
    expect(await code(assets.upload(new Blob(['x'], { type: 'x/s413' })))).toBe('too_large');
    expect(await code(assets.upload(new Blob(['x'], { type: 'x/s403' })))).toBe('not_uploader');
    expect(await code(assets.upload(new Blob(['x'], { type: 'x/s507' })))).toBe('quota_or_state');
    expect(await code(assets.upload(new Blob(['x'], { type: 'x/s409' })))).toBe('quota_or_state');
    expect(await code(assets.upload(new Blob(['x'], { type: 'x/s400' })))).toBe('unsupported_type');
    expect(await code(assets.upload(new Blob(['x'], { type: 'x/s500' })))).toBe('upstream_error');
    expect(await code(assets.upload('nope' as never))).toBe('invalid_request');
    expect(await code(assets.upload(new Blob([], { type: 'image/png' })))).toBe('invalid_request');
    expect(await code(assets.upload(new Blob(['x'])))).toBe('invalid_request');
  });

  it('list is oldest first and delete accepts an id or its url', async () => {
    withAssets();
    const assets = await boot().use('assets');
    const l = await assets.list();
    expect(l.assets.map((a: { url: string }) => a.url)).toEqual(['/_blob/old', '/_blob/new']);
    expect(l.usage).toEqual({ files: 2, bytes: 3, maxFiles: 2000, maxBytes: 1000 });
    expect(Object.isFrozen(l)).toBe(true);
    expect(await assets.delete('c'.repeat(32))).toEqual({ deleted: true });
    expect(await assets.delete(`/_blob/${'c'.repeat(32)}`)).toEqual({ deleted: true });
    expect(calls.filter(([, i]) => i?.method === 'DELETE').map(([u]) => u)).toEqual(Array(2).fill(`/__lager/assets/${'c'.repeat(32)}`));
    await expect(assets.delete('b'.repeat(32))).rejects.toMatchObject({ code: 'not_uploader' });
    await expect(assets.delete('../x')).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('assets is null when not declared or not permitted', async () => {
    withAssets(OWNER, {});
    expect(await boot().use('assets')).toBeNull();
    withAssets({ ...OWNER, level: 'view', isOwner: false, canEdit: false });
    expect(await boot().use('assets')).toBeNull();
    withAssets({ ...OWNER, level: 'interact', isOwner: false, canEdit: false });
    expect(await boot().use('assets')).toBeNull();
    withAssets({ ...OWNER, level: 'interact', isOwner: false, canEdit: false }, { assets: { upload: 'interact' } });
    expect(await boot().use('assets')).not.toBeNull();
    session = { status: 401, body: { error: { code: 'unauthenticated', message: 'x' } } };
    expect(await boot().use('assets')).toBeNull();
  });

  it('permissions report assets only when it is available', async () => {
    withAssets();
    const p = await boot().use('permissions');
    expect(await p.state('assets')).toBe('granted');
    expect(await p.state()).toEqual({ assets: 'granted', db: 'granted', user: 'granted' });
  });
});

describe('permissions', () => {
  it('permissions are granted', async () => {
    const p = await boot().use('permissions');
    expect(await p.state('db')).toBe('granted');
    expect(await p.state('user')).toBe('granted');
    expect(await p.state()).toEqual({ db: 'granted', user: 'granted' });
    expect(await p.state('mcp')).toBe('unavailable');
    expect(await p.request()).toEqual({ db: 'granted', user: 'granted' });
    expect(await p.request(['db'])).toEqual({ db: 'granted' });
    expect(await p.manage()).toBeUndefined();
  });

  it('db is unavailable when the session is not', async () => {
    session = { status: 401, body: { error: { code: 'unauthenticated', message: 'x' } } };
    const p = await boot().use('permissions');
    expect(await p.state('db')).toBe('unavailable');
    expect(await p.state()).toEqual({ user: 'granted' });
  });
});

describe('window.storage', () => {
  it('storage personal and shared map to the right doc paths', async () => {
    boot();
    expect(await g.storage.set('a key/1', 'v1')).toEqual({ key: 'a key/1', value: 'v1', shared: false });
    expect(await g.storage.set('k2', 'v2', true)).toEqual({ key: 'k2', value: 'v2', shared: true });
    expect(dbCalls()).toEqual([
      { op: 'set', path: 'data/users/u1/storage/kv/a%20key%2F1', data: { key: 'a key/1', value: 'v1' } },
      { op: 'set', path: 'kv/k2', data: { key: 'k2', value: 'v2' } },
    ]);
    expect(await g.storage.get('a key/1')).toEqual({ key: 'a key/1', value: 'v1', shared: false });
    expect(await g.storage.get('k2', true)).toEqual({ key: 'k2', value: 'v2', shared: true });
    expect(await g.storage.delete('k2', true)).toEqual({ key: 'k2', deleted: true, shared: true });
    expect(await g.storage.delete('a key/1')).toEqual({ key: 'a key/1', deleted: true, shared: false });
    expect(docs.size).toBe(0);
    expect(dbCalls().slice(-2)).toEqual([
      { op: 'delete', path: 'kv/k2' },
      { op: 'delete', path: 'data/users/u1/storage/kv/a%20key%2F1' },
    ]);
  });

  it('storage personal calls reject for anonymous viewers', async () => {
    session = sessionOf({ id: null, name: '', email: null, level: 'interact', isOwner: false, canEdit: false });
    boot();
    await expect(g.storage.set('k', 'v')).rejects.toThrow('Not signed in');
    await expect(g.storage.get('k')).rejects.toThrow('Not signed in');
    await expect(g.storage.list()).rejects.toThrow('Not signed in');
    await expect(g.storage.delete('k')).rejects.toThrow('Not signed in');
    expect(await g.storage.set('k', 'v', true)).toEqual({ key: 'k', value: 'v', shared: true });
  });

  it('storage.get throws on a missing key', async () => {
    boot();
    await expect(g.storage.get('nope')).rejects.toThrow('Key not found: nope');
    await expect(g.storage.get('nope', true)).rejects.toThrow('Key not found: nope');
    await expect(g.storage.get('nope')).rejects.toBeInstanceOf(Error);
  });

  it('storage validates keys and values', async () => {
    boot();
    await expect(g.storage.set('', 'v')).rejects.toBeInstanceOf(Error);
    await expect(g.storage.set('x'.repeat(201), 'v')).rejects.toBeInstanceOf(Error);
    await expect(g.storage.set(5, 'v')).rejects.toBeInstanceOf(Error);
    await expect(g.storage.set('k', 5)).rejects.toBeInstanceOf(Error);
    await expect(g.storage.get('')).rejects.toBeInstanceOf(Error);
    expect((await g.storage.set('x'.repeat(200), 'v')).key).toHaveLength(200);
  });

  it('storage rejects keys whose encoded form exceeds 200 bytes', async () => {
    boot();
    const before = dbCalls().length;
    await expect(g.storage.set('x'.repeat(201), 'v')).rejects.toThrow('Key too long');
    await expect(g.storage.get('ä'.repeat(100))).rejects.toThrow('Key too long'); // 100 chars, 600 encoded bytes
    await expect(g.storage.delete('/'.repeat(67))).rejects.toThrow('Key too long'); // %2F x 67 = 201
    expect((await g.storage.set('/'.repeat(66), 'v')).key).toHaveLength(66); // 198 encoded
    expect(dbCalls().length).toBe(before + 1);
  });

  it('storage.list filters by prefix', async () => {
    boot();
    await g.storage.set('b2', '1');
    await g.storage.set('a1', '1');
    await g.storage.set('b1', '1');
    await g.storage.set('b3', '1', true);
    expect(await g.storage.list()).toEqual({ keys: ['a1', 'b1', 'b2'], prefix: '', shared: false });
    expect(await g.storage.list('b')).toEqual({ keys: ['b1', 'b2'], prefix: 'b', shared: false });
    expect(await g.storage.list('b', true)).toEqual({ keys: ['b3'], prefix: 'b', shared: true });
    expect(await g.storage.list('zz')).toEqual({ keys: [], prefix: 'zz', shared: false });
    expect(dbCalls().slice(-4).map((c) => c.path)).toEqual(['data/users/u1/storage/kv', 'data/users/u1/storage/kv', 'kv', 'data/users/u1/storage/kv']);
  });
});

describe('path parity with the server validators', () => {
  it('every path the runtime sends is accepted by the server', async () => {
    const claude = boot();
    await g.storage.set('a key/1', 'v');
    await g.storage.set('k', 'v', true);
    await g.storage.get('a key/1');
    await g.storage.get('k', true);
    await g.storage.list('a');
    await g.storage.list('k', true);
    await g.storage.delete('a key/1');
    await g.storage.delete('k', true);
    const db = await claude.use('db');
    await db.doc('tasks/t1').set({ a: 1 });
    await db.collection('tasks').get();

    const sent = dbCalls();
    expect(sent).toHaveLength(10);
    for (const c of sent) {
      if (c.op === 'query') expect(() => assertCollectionPath(c.path), c.path).not.toThrow();
      else expect(() => parseDocPath(c.path), c.path).not.toThrow();
    }
    expect(sent.filter((c) => c.op === 'query').map((c) => c.path)).toEqual(['data/users/u1/storage/kv', 'kv', 'tasks']);
  });
});
