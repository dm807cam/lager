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
  /** 0 connecting, 1 open, 2 closed: what the browser reports after it gave up on an HTTP error. */
  readyState = 0;
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
let roomReply: (body: any) => Response;
let pageReply: (body: any) => Response | Promise<Response>;
let completeReply: (body: any) => Response | Promise<Response>;

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
  if (url === '/__lager/room') return roomReply(JSON.parse(init.body));
  if (url === '/__lager/page') return pageReply(JSON.parse(init.body));
  if (url === '/__lager/complete') return completeReply(JSON.parse(init.body));
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
  delete g.lager;
  delete g.__lagerRuntime;
  (0, eval)(SOURCE);
  return g.lager;
}

beforeEach(() => {
  calls = []; docs = new Map(); users = {}; clock = 0;
  roomReply = () => json({ ok: true });
  pageReply = () => json({ version: '2' });
  completeReply = () => json({ text: 'ok' });
  session = sessionOf(OWNER);
  FakeEventSource.instances = [];
  g.fetch = fakeFetch;
  g.EventSource = FakeEventSource;
});
// The runtime reads its session shortly after it starts; let that settle inside the test that booted it.
afterEach(async () => { await flush(); await flush(); delete g.lager; delete g.__lagerHost; delete g.__lagerRuntime; });

describe('double inclusion', () => {
  it('a second load of the runtime returns at once and keeps the first one\'s state', async () => {
    const lager = boot();
    const first = await lager.use('db');
    (0, eval)(SOURCE);
    expect(g.lager).toBe(lager);
    expect(await g.lager.use('db')).toBe(first);
  });
});

describe('lager.use', () => {
  it('use is memoized and unknown names resolve null', async () => {
    const lager = boot();
    const a = await lager.use('db');
    expect(a).not.toBeNull();
    expect(await lager.use('db')).toBe(a);
    expect(await lager.use('nope')).toBeNull();
    expect(await lager.use('constructor')).toBeNull();
    await lager.use('user');
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
    const lager = boot();
    expect(await lager.use('db')).toBeNull();
    const user = await lager.use('user');
    expect(user).not.toBeNull();
    expect(await user.isOwner()).toBe(false);
    expect(await user.id()).toBeNull();
  });

  it('a failed session fetch is not kept: the next use asks again and gets the namespace', async () => {
    session = 'network-error';
    const lager = boot();
    expect(await lager.use('db')).toBeNull();
    session = { status: 503, body: {} };
    expect(await lager.use('db')).toBeNull();
    session = sessionOf(OWNER);
    const db = await lager.use('db');
    expect(db).not.toBeNull();
    expect(await lager.use('db')).toBe(db);
    // A definite answer (not signed in) is kept as before.
    session = { status: 401, body: { error: { code: 'unauthenticated' } } };
    const other = boot();
    expect(await other.use('db')).toBeNull();
    session = sessionOf(OWNER);
    expect(await other.use('db')).toBeNull();
  });

  it('db is null on a network failure and when the level is absent', async () => {
    session = 'network-error';
    expect(await boot().use('db')).toBeNull();
    session = sessionOf({ id: null, name: '', email: null });
    expect(await boot().use('db')).toBeNull();
  });

  it('window.lager is frozen', async () => {
    const lager = boot();
    expect(Object.isFrozen(lager)).toBe(true);
    expect(Object.keys(lager).sort()).toEqual(['complete', 'use']);
    expect(Object.isFrozen(await lager.use('db'))).toBe(true);
    expect(Object.isFrozen(await lager.use('user'))).toBe(true);
    expect(g.storage).toBeUndefined();
  });

  it('lager.complete sends the prompt and resolves the answer text', async () => {
    const lager = boot();
    completeReply = (b) => json({ text: `echo ${JSON.stringify(b)}`, model: 'm', stopReason: 'end_turn' });
    expect(await lager.complete('hi')).toBe('echo {"messages":"hi"}');
    const call = calls.find(([u]) => u === '/__lager/complete')!;
    expect(call[1].method).toBe('POST');
    expect(call[1].headers['X-Lager-Request']).toBe('1');
    const history = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }];
    expect(await lager.complete(history, { system: 's', maxTokens: 50, other: 1 }))
      .toBe(`echo ${JSON.stringify({ messages: history, system: 's', maxTokens: 50 })}`);
  });

  it('lager.complete with full resolves text, stop reason and truncation', async () => {
    const lager = boot();
    completeReply = () => json({ text: '{"a"', model: 'm', stopReason: 'max_tokens', truncated: true });
    expect(await lager.complete('x', { full: true })).toEqual({ text: '{"a"', model: 'm', stopReason: 'max_tokens', truncated: true });
    expect(await lager.complete('x')).toBe('{"a"');
    const sent = JSON.parse(calls.filter(([u]) => u === '/__lager/complete').at(-1)![1].body);
    expect(sent.full).toBeUndefined();
  });

  it('lager.complete rejects with the server code', async () => {
    const lager = boot();
    await expect(lager.complete()).rejects.toMatchObject({ code: 'invalid_argument' });
    completeReply = () => json({ error: { code: 'not_configured', message: 'No language model is set up on this server.' } }, 503);
    await expect(lager.complete('x')).rejects.toMatchObject({ code: 'not_configured', message: 'No language model is set up on this server.' });
    completeReply = () => new Response('<html>bad gateway</html>', { status: 502 });
    await expect(lager.complete('x')).rejects.toMatchObject({ code: 'unavailable' });
    await expect(lager.complete('x')).rejects.toBeInstanceOf(Error);
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

  it('a stream the browser gave up on is opened anew with backoff, and not after the last unsubscribe', async () => {
    const db = await boot().use('db');
    put('tasks/t1', { v: 1 });
    const seen: any[] = [];
    const unsub = db.doc('tasks/t1').onSnapshot((s: any) => seen.push(s));
    await flush();
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.useFakeTimers();
    try {
      // A dropped connection: the browser reconnects by itself, the runtime leaves the stream alone.
      es().emit('error');
      await vi.advanceTimersByTimeAsync(5000);
      expect(FakeEventSource.instances).toHaveLength(1);
      // An HTTP error on reconnect (502 while the server restarts): the browser closes the stream for good.
      es().readyState = 2;
      es().emit('error');
      await vi.advanceTimersByTimeAsync(999);
      expect(FakeEventSource.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeEventSource.instances).toHaveLength(2);
      // Still down: the next attempt waits twice as long.
      es().readyState = 2;
      es().emit('error');
      await vi.advanceTimersByTimeAsync(1999);
      expect(FakeEventSource.instances).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeEventSource.instances).toHaveLength(3);
      // Back up: listeners catch up on what they missed.
      put('tasks/t1', { v: 2 });
      es().readyState = 1;
      es().emit('open');
      await vi.advanceTimersByTimeAsync(0);
      expect(seen[seen.length - 1].data()).toEqual({ v: 2 });
      // No listener left: a pending retry is dropped.
      es().readyState = 2;
      es().emit('error');
      unsub();
      await vi.advanceTimersByTimeAsync(60000);
      expect(FakeEventSource.instances).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
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

describe('path parity with the server validators', () => {
  it('every path the runtime sends is accepted by the server', async () => {
    const lager = boot();
    const db = await lager.use('db');
    await db.doc('tasks/t1').set({ a: 1 });
    await db.collection('tasks').doc().set({ a: 1 });
    await db.collection('lists/l1/items').add({ a: 1 });
    await db.collection('tasks').get();
    await db.doc('settings/main').delete();

    const sent = dbCalls();
    expect(sent).toHaveLength(5);
    for (const c of sent) {
      if (c.op === 'query') expect(() => assertCollectionPath(c.path), c.path).not.toThrow();
      else expect(() => parseDocPath(c.path), c.path).not.toThrow();
    }
    expect(sent.filter((c) => c.op === 'query').map((c) => c.path)).toEqual(['tasks']);
  });
});

describe('room', () => {
  const ME = { peer: 'p1', by: 'u1', guest: false, kind: 'viewer', presence: {}, updatedAt: 1 };
  const withRoom = (viewer: Record<string, unknown> = OWNER, caps: Record<string, unknown> = { room: {}, user: {} }): void => {
    session = { status: 200, body: { ...(sessionOf(viewer).body as object), capabilities: caps } };
  };
  const roomPosts = (): any[] => calls.filter(([u]) => u === '/__lager/room').map(([, init]) => JSON.parse(init.body));
  const tick = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const code = (p: Promise<unknown>): Promise<string> => p.then(() => 'resolved', (e: { code: string }) => e.code);
  // A runtime of this test may still hold a coalescing timer; let it fire before the next test's calls start.
  afterEach(() => tick(70));
  /** Boots, takes the namespace and connects the lobby as peer p1. */
  async function connect(): Promise<any> {
    const room = await boot().use('room');
    room.peers(); // opens the stream
    es().emit('hello', { peer: 'p1', peers: [ME] });
    return room;
  }

  it('room is null when not declared, or without a level', async () => {
    withRoom(OWNER, {});
    expect(await boot().use('room')).toBeNull();
    withRoom(OWNER, { room: {} });
    expect(await boot().use('room')).not.toBeNull();
    withRoom({ id: null, name: '', email: null }, { room: {} });
    expect(await boot().use('room')).toBeNull();
    session = 'network-error';
    expect(await boot().use('room')).toBeNull();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('is frozen, lazy, and shows up in permissions', async () => {
    withRoom();
    const lager = boot();
    const room = await lager.use('room');
    expect(Object.isFrozen(room)).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(await (await lager.use('permissions')).state('room')).toBe('granted');
    withRoom(OWNER, {});
    expect(await (await boot().use('permissions')).state('room')).toBe('unavailable');
  });

  it('room emit/on roundtrip through stubbed transport', async () => {
    withRoom();
    const room = await boot().use('room');
    const got: any[] = [];
    const off = room.on('hi', (m: any) => got.push(m));
    expect(es().url).toBe('/__lager/room/events');
    // the very first emit waits for the stream instead of being dropped
    const sent = room.emit('hi', { a: 1 });
    await tick(5);
    expect(roomPosts()).toEqual([]);
    es().emit('hello', { peer: 'p1', peers: [ME] });
    await sent;
    expect(roomPosts()).toEqual([{ room: '', peer: 'p1', op: 'emit', topic: 'hi', data: { a: 1 } }]);
    const post = calls.find(([u]) => u === '/__lager/room')!;
    expect(post[1].headers).toEqual({ 'Content-Type': 'application/json', 'X-Lager-Request': '1' });
    expect(post[1].credentials).toBe('same-origin');
    es().emit('message', { topic: 'hi', data: { a: 1 }, from: { peer: 'p1', by: 'u1', guest: false } });
    es().emit('message', { topic: 'hi', data: 2, from: { peer: 'p9', by: 'u1', guest: false } });
    es().emit('message', { topic: 'hi', from: { peer: 'p7', by: 'u2', guest: true } });
    es().emit('message', { topic: 'other', data: 3, from: { peer: 'p7', by: 'u2', guest: true } });
    expect(got).toEqual([
      { topic: 'hi', data: { a: 1 }, peer: 'p1', by: 'u1', isMe: true, sameTab: true, kind: 'viewer', guest: false },
      { topic: 'hi', data: 2, peer: 'p9', by: 'u1', isMe: true, sameTab: false, kind: 'viewer', guest: false },
      { topic: 'hi', peer: 'p7', by: 'u2', isMe: false, sameTab: false, kind: 'viewer', guest: true },
    ]);
    expect(Object.isFrozen(got[0])).toBe(true);
    expect('data' in got[2]).toBe(false);
    off();
    es().emit('message', { topic: 'hi', data: 4, from: { peer: 'p9', by: 'u1', guest: false } });
    expect(got).toHaveLength(3);
  });

  it('by is null unless the app declares user, and guests carry the secret', async () => {
    withRoom(OWNER, { room: {} });
    const room = await boot().use('room');
    const got: any[] = [];
    room.on('hi', (m: any) => got.push(m));
    es().emit('hello', { peer: 'p1', secret: 's3cret', peers: [ME] });
    es().emit('message', { topic: 'hi', data: 1, from: { peer: 'p2', by: 'u2', guest: false } });
    expect(got[0].by).toBeNull();
    expect(room.peers()[0].by).toBeNull();
    await room.emit('hi', 1);
    expect(roomPosts()[0]).toEqual({ room: '', peer: 'p1', op: 'emit', topic: 'hi', data: 1, secret: 's3cret' });
  });

  it('emit validates and respects the topics the viewer may send on', async () => {
    withRoom({ ...OWNER, level: 'view', isOwner: false, canEdit: false }, { room: { topics: { move: 'interact' } } });
    const room = await connect();
    expect(await code(room.emit('move', 1))).toBe('not_permitted');
    withRoom({ ...OWNER, level: 'interact', isOwner: false, canEdit: false }, { room: { topics: { move: 'interact', constructor: 'x' } } });
    const room2 = await connect();
    expect(await code(room2.emit('move', 1))).toBe('resolved');
    expect(await code(room2.emit('reset', 1))).toBe('not_permitted');
    expect(await code(room2.emit('toString', 1))).toBe('invalid_argument');
    withRoom();
    const room3 = await connect();
    expect(await code(room3.emit('Bad Topic', 1))).toBe('invalid_argument');
    expect(await code(room3.emit('', 1))).toBe('invalid_argument');
    expect(await code(room3.emit('t', 'x'.repeat(5000)))).toBe('invalid_argument');
    expect(await code(room3.emit('t', () => 1))).toBe('invalid_argument');
    expect(() => room3.on('t', 'nope')).toThrow(TypeError);
    const errors: any[] = [];
    room3.on('Bad', () => undefined, (e: any) => errors.push(e));
    expect(errors).toEqual([]);
    await tick(0);
    expect(errors).toEqual([{ code: 'invalid_argument', message: expect.any(String) }]);
    expect(roomPosts().map((b) => b.topic)).toEqual(['move']);
  });

  it('server failures map to the contract codes; a dropped emit while disconnected sends nothing', async () => {
    withRoom();
    const room = await connect();
    for (const [status, expected] of [[403, 'not_permitted'], [429, 'rate_limited'], [400, 'invalid_argument'], [500, 'upstream_error']] as const) {
      roomReply = () => json({ error: { code: 'x', message: 'm' } }, status);
      expect(await code(room.emit('t', 1))).toBe(expected);
    }
    roomReply = () => json({ ok: true });
  pageReply = () => json({ version: '2' });
    const before = roomPosts().length;
    vi.useFakeTimers(); // the retry timer must not outlive this test
    es().emit('error');
    vi.useRealTimers();
    expect(room.connected()).toBe(false);
    expect(await code(room.emit('t', 1))).toBe('resolved');
    expect(roomPosts()).toHaveLength(before);
  });

  it('onPeers reports joined, left and updated', async () => {
    withRoom();
    const room = await boot().use('room');
    const changes: any[] = [];
    room.onPeers((c: any) => changes.push(c));
    es().emit('hello', { peer: 'p1', peers: [ME] });
    await tick();
    expect(changes).toHaveLength(1);
    expect(changes[0].joined.map((p: any) => p.peer)).toEqual(['p1']);
    expect(changes[0].joined[0]).toMatchObject({ isMe: true, sameTab: true, kind: 'viewer', guest: false, by: 'u1' });
    expect(changes[0].peers).toBe(room.peers());
    expect(changes[0].peers.map((p: any) => p.peer)).toEqual(['p1']);
    expect(Object.isFrozen(changes[0].peers)).toBe(true);
    const p2 = { peer: 'p2', by: 'u2', guest: true, kind: 'viewer', presence: { cursor: [1, 2] }, updatedAt: 5 };
    es().emit('peers', { joined: [p2], left: [], updated: [] });
    await tick();
    expect(changes[1].joined).toEqual([expect.objectContaining({ peer: 'p2', isMe: false, guest: true, presence: { cursor: [1, 2] } })]);
    expect(changes[1].updated).toEqual([]);
    expect(Object.isFrozen(changes[1].joined[0].presence)).toBe(true);
    const unchanged = room.peers()[0];
    es().emit('peers', { joined: [], left: [], updated: [{ ...p2, presence: { cursor: [3, 4] } }] });
    await tick();
    expect(changes[2].updated).toEqual([expect.objectContaining({ peer: 'p2', presence: { cursor: [3, 4] } })]);
    expect(room.peers()[0]).toBe(unchanged); // a peer that did not change keeps its object
    es().emit('peers', { joined: [], left: [p2], updated: [] });
    await tick();
    expect(changes[3].left).toEqual([expect.objectContaining({ peer: 'p2' })]);
    // joined and left within one frame is neither
    const p3 = { ...p2, peer: 'p3' };
    es().emit('peers', { joined: [p3], left: [], updated: [] });
    es().emit('peers', { joined: [], left: [p3], updated: [] });
    await tick();
    expect(changes).toHaveLength(4);
    // the full list is rebuilt locally from the deltas
    expect(changes[1].peers.map((p: any) => p.peer)).toEqual(['p1', 'p2']);
    expect(changes[3].peers.map((p: any) => p.peer)).toEqual(['p1']);
  });

  it('a new hello resets the peer map', async () => {
    withRoom();
    const room = await boot().use('room');
    const changes: any[] = [];
    room.onPeers((c: any) => changes.push(c));
    const p2 = { peer: 'p2', by: 'u2', guest: false, kind: 'viewer', presence: {}, updatedAt: 5 };
    es().emit('hello', { peer: 'p1', peers: [ME, p2] });
    await tick();
    expect(changes[0].joined.map((p: any) => p.peer)).toEqual(['p1', 'p2']);
    vi.useFakeTimers();
    try {
      es().emit('error');
      await vi.advanceTimersByTimeAsync(1001);
    } finally { vi.useRealTimers(); }
    es().emit('hello', { peer: 'p3', peers: [{ ...ME, peer: 'p3' }] });
    await tick();
    expect(room.peers().map((p: any) => p.peer)).toEqual(['p3']);
    expect(changes[1].joined.map((p: any) => p.peer)).toEqual(['p3']);
    expect(changes[1].left.map((p: any) => p.peer).sort()).toEqual(['p1', 'p2']);
    // deltas after the reset apply to the new map
    es().emit('peers', { joined: [], left: [p2], updated: [] });
    await tick();
    expect(room.peers().map((p: any) => p.peer)).toEqual(['p3']);
  });

  it('presence applies locally at once, is coalesced and merged, and is re-sent after a reconnect', async () => {
    withRoom();
    const room = await connect();
    await room.presence({ cursor: { x: 1 }, mode: 'draw' });
    await room.presence({ mode: null, color: 'red' });
    expect(room.peers()[0].presence).toEqual({ cursor: { x: 1 }, color: 'red' });
    expect(Object.isFrozen(room.peers()[0].presence)).toBe(true);
    expect(roomPosts()).toEqual([]);
    await tick();
    expect(roomPosts()).toEqual([{ room: '', peer: 'p1', op: 'presence', patch: { cursor: { x: 1 }, mode: null, color: 'red' } }]);
    // the server echoes our own state; our local state stays authoritative
    es().emit('peers', { joined: [], left: [], updated: [{ ...ME, presence: {} }] });
    expect(room.peers()[0].presence).toEqual({ cursor: { x: 1 }, color: 'red' });
    // errors, then a retry with backoff opens a new stream, whose hello brings the full state again
    vi.useFakeTimers();
    try {
      const first = es();
      first.emit('error');
      expect(first.closed).toBe(true);
      expect(room.connected()).toBe(false);
      const n = FakeEventSource.instances.length;
      await vi.advanceTimersByTimeAsync(999);
      expect(FakeEventSource.instances).toHaveLength(n);
      await vi.advanceTimersByTimeAsync(2);
      expect(FakeEventSource.instances).toHaveLength(n + 1);
      calls.length = 0;
      es().emit('hello', { peer: 'p2', peers: [{ ...ME, peer: 'p2' }] });
      await vi.advanceTimersByTimeAsync(5);
      expect(roomPosts()).toEqual([{ room: '', peer: 'p2', op: 'presence', patch: { cursor: { x: 1 }, color: 'red' } }]);
      expect(room.connected()).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('presence validates its input', async () => {
    withRoom();
    const room = await connect();
    expect(await code(room.presence([1] as never))).toBe('invalid_argument');
    expect(await code(room.presence(null as never))).toBe('invalid_argument');
    expect(await code(room.presence({ 'bad key': 1 }))).toBe('invalid_argument');
    expect(await code(room.presence({ constructor: 1 }))).toBe('invalid_argument');
    expect(await code(room.presence({ a: undefined as never }))).toBe('invalid_argument');
    // The whole presence is held to the server's 2 KiB, not to the 4 KiB of a message.
    expect(await code(room.presence({ a: 'x'.repeat(1500) }))).toBe('resolved');
    expect(await code(room.presence({ b: 'x'.repeat(1500) }))).toBe('invalid_argument');
    expect(await code(room.presence({ c: 'x'.repeat(3000) }))).toBe('invalid_argument');
    expect(Object.keys(room.peers()[0].presence)).toEqual(['a']);
  });

  it('onConnection fires with the current state and then on changes', async () => {
    withRoom();
    const room = await boot().use('room');
    const seen: boolean[] = [];
    const off = room.onConnection((c: boolean) => seen.push(c));
    await tick(0);
    expect(seen).toEqual([false]);
    es().emit('hello', { peer: 'p1', peers: [ME] });
    vi.useFakeTimers(); // the retry timer must not outlive this test
    es().emit('error');
    vi.useRealTimers();
    expect(seen).toEqual([false, true, false]);
    off();
    expect(room.connected()).toBe(false);
  });

  it('join(name) opens its own stream and leave() closes it', async () => {
    withRoom();
    const room = await boot().use('room');
    expect(await code(room.join('Bad Name'))).toBe('invalid_argument');
    expect(await code(room.join('x'.repeat(49)))).toBe('invalid_argument');
    expect(FakeEventSource.instances).toHaveLength(0);
    const joining = room.join('game-1');
    await tick(0);
    expect(FakeEventSource.instances).toHaveLength(1); // the lobby is not opened by join
    const stream = es();
    expect(stream.url).toBe('/__lager/room/events?room=game-1');
    let settled = false;
    void joining.then(() => { settled = true; });
    await tick(0);
    expect(settled).toBe(false); // not admitted before the hello
    stream.emit('hello', { peer: 'g1', peers: [{ ...ME, peer: 'g1' }] });
    const game = await joining;
    expect(game.name).toBe('game-1');
    expect(Object.isFrozen(game)).toBe(true);
    expect(await room.join('game-1')).toBe(game);
    expect(game.connected()).toBe(true);
    expect(game.peers().map((p: any) => p.peer)).toEqual(['g1']);
    await game.emit('t', 1);
    await game.presence({ at: 1 });
    await tick();
    expect(roomPosts()).toEqual([
      { room: 'game-1', peer: 'g1', op: 'emit', topic: 't', data: 1 },
      { room: 'game-1', peer: 'g1', op: 'presence', patch: { at: 1 } },
    ]);
    const got: any[] = [];
    game.on('t', (m: any) => got.push(m));
    await game.leave();
    expect(stream.closed).toBe(true);
    await game.leave();
    stream.emit('message', { topic: 't', data: 1, from: { peer: 'g2', by: null, guest: true } });
    expect(got).toEqual([]);
    expect(await code(game.emit('t', 1))).toBe('invalid_argument');
    expect(await code(game.presence({ a: 1 }))).toBe('invalid_argument');
    // joining the name again comes back with a fresh stream
    const again = room.join('game-1');
    await tick(0);
    expect(FakeEventSource.instances).toHaveLength(2);
    es().emit('hello', { peer: 'g3', peers: [{ ...ME, peer: 'g3' }] });
    expect(await again).not.toBe(game);
  });

  it('join rejects when the room cannot be opened, and is limited to 16 rooms', async () => {
    withRoom();
    const room = await boot().use('room');
    const failing = room.join('nope');
    await tick(0);
    es().emit('error');
    expect(await code(failing)).toBe('upstream_error');
    expect(es().closed).toBe(true);
    for (let i = 0; i < 16; i++) {
      const p = room.join('r' + i);
      await tick(0);
      es().emit('hello', { peer: 'x' + i, peers: [] });
      await p;
    }
    expect(await code(room.join('r16'))).toBe('limit_reached');
  });

});

describe('page', () => {
  const declare = (caps: Record<string, unknown> = { page: {} }, viewer: Record<string, unknown> = OWNER): void => {
    session = { status: 200, body: { ...(sessionOf(viewer).body as object), capabilities: caps } };
  };
  const DOC = '<!doctype html><p>x</p>';
  let reload: ReturnType<typeof vi.fn>;
  beforeEach(() => { reload = vi.fn(); g.__lagerHost = { reload }; });
  const READER = { ...OWNER, level: 'interact', isOwner: false, canEdit: false };
  const failure = (p: Promise<unknown>): Promise<{ code: string }> => p.then(() => { throw new Error('resolved'); }, (e: { code: string }) => e);

  it('page.publish posts html with the loaded version and maps errors', async () => {
    declare();
    const page = await boot().use('page');
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.keys(page)).toEqual(['publish']);
    expect(await page.publish(DOC)).toEqual({ version: '2' });
    const post = calls.find(([u]) => u === '/__lager/page')!;
    expect(post[1].method).toBe('POST');
    expect(post[1].credentials).toBe('same-origin');
    expect(post[1].headers).toEqual({ 'Content-Type': 'application/json', 'X-Lager-Request': '1' });
    expect(JSON.parse(post[1].body)).toEqual({ html: DOC, baseVersion: 1 });
    const cases: Array<[number, string, string]> = [
      [403, 'forbidden', 'not_writer'], [401, 'unauthenticated', 'not_writer'], [403, 'not_declared', 'not_declared'], [409, 'conflict', 'conflict'],
      [413, 'too_large', 'too_large'], [400, 'invalid_content', 'invalid_content'], [429, 'rate_limited', 'rate_limited'], [500, 'internal', 'upstream_error'],
    ];
    for (const [status, code, expected] of cases) {
      pageReply = () => json({ error: { code, message: 'x' } }, status);
      expect((await failure(page.publish(DOC))).code, `${status} ${code}`).toBe(expected);
    }
    pageReply = () => { throw new TypeError('offline'); };
    expect((await failure(page.publish(DOC))).code).toBe('upstream_error');
    pageReply = () => new Response('<html>', { status: 502 });
    expect((await failure(page.publish(DOC))).code).toBe('upstream_error');
    expect((await failure(page.publish(''))).code).toBe('invalid_content');
    expect((await failure(page.publish('<p>no doctype</p>'))).code).toBe('invalid_content');
    expect((await failure(page.publish('<p>x</p><!doctype html>'))).code).toBe('invalid_content');
    pageReply = () => json({ error: { code: 'quota_exceeded', message: 'x' } }, 507);
    expect((await failure(page.publish(DOC))).code).toBe('too_large');
    pageReply = () => json({ version: '2' });
    expect(await page.publish('\uFEFF \n<!DOCTYPE HTML><html></html>')).toEqual({ version: '2' });
    expect((await failure(page.publish(5 as never))).code).toBe('invalid_content');
  });

  it('read-only viewers reject not_writer without a request', async () => {
    declare({ page: {} }, READER);
    const page = await boot().use('page');
    expect(page).not.toBeNull();
    expect((await failure(page.publish(DOC))).code).toBe('not_writer');
    expect(calls.some(([u]) => u === '/__lager/page')).toBe(false);
  });

  it('a reload event with a newer version reloads the page once', async () => {
    declare();
    await boot().use('page');
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(es().url).toBe('/__lager/db/events');
    es().emit('reload', { version: 1 });
    expect(reload).not.toHaveBeenCalled();
    es().emit('reload', { version: 2 });
    es().emit('reload', { version: 2 });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('the stream stays open for reload events when db listeners come and go, and a bad event is ignored', async () => {
    declare({ page: {}, db: {} });
    const lager = boot();
    await lager.use('page');
    const db = await lager.use('db');
    const off = db.doc('a/b').onSnapshot(() => {});
    await flush();
    off();
    expect(es().closed).toBe(false);
    es().emit('reload', 'nonsense');
    es().emit('reload', {});
    expect(reload).not.toHaveBeenCalled();
    es().emit('reload', { version: 5 });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('every view follows saves even when the page never calls use("page")', async () => {
    declare({ page: {}, db: {} });
    boot();
    await flush();
    await flush();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(es().url).toBe('/__lager/db/events');
    es().emit('reload', { version: 1 });
    expect(reload).not.toHaveBeenCalled();
    es().emit('reload', { version: 2 });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a page that declares neither opens no stream and reads the session only once', async () => {
    declare({ db: {}, user: {} });
    const lager = boot();
    await flush();
    await flush();
    expect(FakeEventSource.instances).toHaveLength(0);
    await lager.use('user');
    await lager.use('db');
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(calls.filter(([u]) => u === '/__lager/session')).toHaveLength(1);
  });

  it('a stream that db listeners opened before use("page") still catches up on a missed version', async () => {
    declare({ db: {}, page: {} });
    const lager = boot();
    // No timer turn in between: the listener opens the stream before the runtime's own session read would.
    const db = await lager.use('db');
    const off = db.doc('a/b').onSnapshot(() => {});
    es().emit('open');
    session = { status: 200, body: { ...(sessionOf(OWNER).body as any), capabilities: { db: {}, page: {} }, instance: { id: 'i1', slug: 'demo', appSlug: 'demo', version: 3 } } };
    await lager.use('page');
    await new Promise((r) => setTimeout(r, 0));
    expect(reload).toHaveBeenCalledTimes(1);
    off();
  });

  it('is null when not declared, and shows up in permissions when declared', async () => {
    declare({});
    expect(await boot().use('page')).toBeNull();
    expect(await boot().use('artifact')).toBeNull();
    expect(await boot().use('self')).toBeNull();
    declare();
    const p = await boot().use('permissions');
    expect(await p.state('page')).toBe('granted');
  });

  it('publish:false stops saving for everyone', async () => {
    for (const caps of [{ page: { publish: false } }]) {
      for (const viewer of [OWNER, READER]) {
        declare(caps, viewer);
        const page = await boot().use('page');
        expect(page).not.toBeNull();
        expect((await failure(page.publish(DOC))).code).toBe('not_granted');
      }
    }
    expect(calls.some(([u]) => u === '/__lager/page')).toBe(false);
    pageReply = () => json({ error: { code: 'not_granted', message: 'x' } }, 403);
    declare();
    expect((await failure((await boot().use('page')).publish(DOC))).code).toBe('not_granted');
  });

  it('a conflict reloads this view once, and still rejects', async () => {
    declare();
    const page = await boot().use('page');
    pageReply = () => json({ error: { code: 'conflict', message: 'x' } }, 409);
    expect((await failure(page.publish(DOC))).code).toBe('conflict');
    expect((await failure(page.publish(DOC))).code).toBe('conflict');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a publish before the stream is open still ends in a reload; with an open stream the event does it', async () => {
    declare();
    const page = await boot().use('page');
    await page.publish(DOC);
    expect(reload).toHaveBeenCalledTimes(1);
    declare();
    reload.mockClear();
    const second = await boot().use('page');
    es().emit('open');
    await flush();
    await second.publish(DOC);
    expect(reload).not.toHaveBeenCalled();
    es().emit('reload', { version: 2 });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('when the stream (re)opens and the live version differs, the view reloads once', async () => {
    declare();
    await boot().use('page');
    es().emit('open');
    await flush();
    expect(reload).not.toHaveBeenCalled();
    expect(calls.filter(([u]) => u === '/__lager/session').length).toBe(2);
    session = { status: 200, body: { ...(sessionOf(OWNER).body as any), capabilities: { page: {} }, instance: { id: 'i1', slug: 'demo', appSlug: 'demo', version: 4 } } };
    es().emit('error');
    es().emit('open');
    await flush();
    es().emit('open');
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('downloads', () => {
  const declare = (caps: Record<string, unknown> = { downloads: {} }): void => {
    session = { status: 200, body: { ...(sessionOf(OWNER).body as object), capabilities: caps } };
  };
  let confirm: ReturnType<typeof vi.fn>;
  let created: Blob[];
  let revoked: string[];
  let clicked: Array<{ download: string; href: string }>;
  beforeEach(() => {
    confirm = vi.fn(() => true);
    created = []; revoked = []; clicked = [];
    g.__lagerHost = { confirm };
    g.URL.createObjectURL = (b: Blob) => { created.push(b); return 'blob:test/' + created.length; };
    g.URL.revokeObjectURL = (u: string) => { revoked.push(u); };
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ download: this.download, href: this.href });
    });
    vi.useFakeTimers({ toFake: ['setTimeout'] });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); delete g.URL.createObjectURL; delete g.URL.revokeObjectURL; });
  const code = (p: Promise<unknown>): Promise<string> => p.then(() => 'resolved', (e: { code: string }) => e.code);

  it('the confirmation is worded in the viewer\'s locale and falls back to English', async () => {
    const asking = async (locale: unknown): Promise<string> => {
      session = { status: 200, body: { ...(sessionOf({ ...OWNER, locale }).body as object), capabilities: { downloads: {} } } };
      confirm.mockClear();
      await (await boot().use('downloads')).save({ filename: 'plan.txt', data: 'x' });
      return confirm.mock.calls[0][0] as string;
    };
    // The confirmation names the file and its size (data 'x' is one byte).
    expect(await asking('en')).toBe('Save file \u201Cplan.txt\u201D (1\u00A0B)?');
    expect(await asking('de')).toBe('Datei \u201Eplan.txt\u201C (1\u00A0B) speichern?');
    expect(await asking('fr')).toBe('Enregistrer le fichier \u00AB\u00A0plan.txt\u00A0\u00BB (1\u00A0B)\u00A0?');
    expect(await asking('es')).toBe('\u00BFGuardar el archivo \u00ABplan.txt\u00BB (1\u00A0B)?');
    expect(await asking('ja')).toBe('Save file \u201Cplan.txt\u201D (1\u00A0B)?');
    expect(await asking(undefined)).toBe('Save file \u201Cplan.txt\u201D (1\u00A0B)?');
    expect(await asking('constructor')).toBe('Save file \u201Cplan.txt\u201D (1\u00A0B)?');
  });

  it('downloads.save confirms, sanitises the filename and saves through a temporary link', async () => {
    declare();
    const downloads = await boot().use('downloads');
    expect(Object.isFrozen(downloads)).toBe(true);
    expect(await downloads.save({ filename: 'data/..\\export\u0007.csv', data: 'a,b\n' })).toEqual({ status: 'saved' });
    expect(confirm).toHaveBeenCalledWith('Save file \u201Cexport.csv\u201D (4\u00A0B)?');
    expect(clicked).toEqual([{ download: 'export.csv', href: 'blob:test/1' }]);
    expect(await created[0].text()).toBe('a,b\n');
    expect(document.querySelector('a[download]')).toBeNull();
    expect(revoked).toEqual([]);
    vi.advanceTimersByTime(1500);
    expect(revoked).toEqual(['blob:test/1']);
    // other data types
    await downloads.save({ filename: 'a.zip', data: new Uint8Array([1, 2, 3]) });
    await downloads.save({ filename: 'b.zip', data: new Uint8Array([1, 2, 3, 4]).buffer });
    await downloads.save({ filename: 'c.txt', data: new Blob(['xyz']) });
    expect(created.slice(1).map((b) => b.size)).toEqual([3, 4, 3]);
  });

  it('declining rejects declined and builds nothing', async () => {
    declare();
    confirm.mockReturnValue(false);
    const downloads = await boot().use('downloads');
    expect(await code(downloads.save({ filename: 'x.txt', data: 'x' }))).toBe('declined');
    expect(created).toEqual([]);
    expect(clicked).toEqual([]);
  });

  it('blocked extensions, size and bad requests are refused before asking', async () => {
    declare();
    const downloads = await boot().use('downloads');
    for (const name of ['a.exe', 'a.BAT', 'a.cmd', 'a.scr', 'a.js', 'a.msi', 'a.dmg', 'a.app', 'a.sh', 'dir/a.exe', 'a.exe.', 'a.sh  ', 'a.txt.exe', 'a.php', 'a.htm', 'README', 'archive.tar', 'a.']) {
      expect(await code(downloads.save({ filename: name, data: 'x' })), name).toBe('rejected_extension');
    }
    expect(await code(downloads.save({ filename: 'a.exe.txt', data: 'x' }))).toBe('resolved');
    expect(await code(downloads.save({ filename: 'big.zip', data: new Blob([new Uint8Array(1)]) }))).toBe('resolved');
    const huge = Object.create(ArrayBuffer.prototype, { byteLength: { value: 50 * 1024 * 1024 + 1 } });
    expect(await code(downloads.save({ filename: 'big.zip', data: huge }))).toBe('too_large');
    expect(await code(downloads.save({ filename: 'big.zip', data: 'x'.repeat(50 * 1024 * 1024 + 1) }))).toBe('too_large');
    expect(await code(downloads.save({ filename: '', data: 'x' }))).toBe('bad_request');
    expect(await code(downloads.save({ filename: '///', data: 'x' }))).toBe('bad_request');
    expect(await code(downloads.save({ filename: 5, data: 'x' } as never))).toBe('bad_request');
    expect(await code(downloads.save({ filename: 'a.txt', data: 5 } as never))).toBe('bad_request');
    expect(await code(downloads.save({ filename: 'a.txt', data: '' }))).toBe('bad_request');
    expect(await code(downloads.save(null as never))).toBe('bad_request');
    // 3 UTF-8 bytes per character: under the character count, over the byte limit
    expect(await code(downloads.save({ filename: 'euro.txt', data: '€'.repeat(18 * 1024 * 1024) }))).toBe('too_large');
    // only the two accepted saves above reached the prompt
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('refuses names over 240 bytes, bare extensions and unknown export requests', async () => {
    declare();
    const downloads = await boot().use('downloads');
    expect(await code(downloads.save({ filename: `${'a'.repeat(236)}.txt`, data: 'x' }))).toBe('resolved');
    expect(await code(downloads.save({ filename: `${'a'.repeat(237)}.txt`, data: 'x' }))).toBe('bad_request');
    // 3 bytes per character: 78 characters and the extension are 238 bytes, 81 are 247
    expect(await code(downloads.save({ filename: `${'\u20AC'.repeat(78)}.txt`, data: 'x' }))).toBe('resolved');
    expect(await code(downloads.save({ filename: `${'\u20AC'.repeat(81)}.txt`, data: 'x' }))).toBe('bad_request');
    for (const name of ['.txt', ' .csv', 'dir/.json']) expect(await code(downloads.save({ filename: name, data: 'x' })), name).toBe('rejected_extension');
    confirm.mockClear();
    expect(await code(downloads.save({ filename: 'a.txt', data: 'x', request: 'tok-1' } as never))).toBe('request_unknown');
    expect(await code(downloads.save({ filename: 'a.txt', data: 'x', request: 7 } as never))).toBe('bad_request');
    expect(await code(downloads.save({ filename: 'a.txt', data: 'x', request: null } as never))).toBe('resolved');
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('the confirmation shows the size in readable units', async () => {
    declare();
    const downloads = await boot().use('downloads');
    await downloads.save({ filename: 'a.zip', data: new Uint8Array(1536) });
    await downloads.save({ filename: 'b.zip', data: new Uint8Array(3 * 1024 * 1024) });
    expect(confirm.mock.calls.map((c) => c[0])).toEqual([
      'Save file \u201Ca.zip\u201D (1.5\u00A0KB)?', 'Save file \u201Cb.zip\u201D (3\u00A0MB)?',
    ]);
  });

  it('every allowed extension is accepted, and invisible or bidi characters never reach the name', async () => {
    declare();
    const downloads = await boot().use('downloads');
    for (const ext of 'gif png jpg jpeg webp mp4 webm mov txt json md docx pptx epub csv ttf html svg pdf xlsx zip fig'.split(' ')) {
      expect(await code(downloads.save({ filename: 'f.' + ext.toUpperCase(), data: 'x' })), ext).toBe('resolved');
    }
    confirm.mockClear();
    await downloads.save({ filename: 'in\u202Evoice\u200B  gnp\u2066.\uFEFFtxt', data: 'x' });
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/^Save file \u201Cinvoice gnp\.txt\u201D \(\d+\u00A0B\)\?$/));
    // the bidi override that would make "fdp.exe" read as "exe.pdf" is gone, so the real extension is checked
    expect(await code(downloads.save({ filename: 'a\u202Efdp.exe', data: 'x' }))).toBe('rejected_extension');
  });

  it('is null when not declared', async () => {
    declare({});
    expect(await boot().use('downloads')).toBeNull();
    declare();
    const p = await boot().use('permissions');
    expect(await p.state('downloads')).toBe('granted');
    const downloads = await boot().use('downloads');
    expect(await downloads.save({ filename: 'README.md', data: 'x' })).toEqual({ status: 'saved' });
  });
});
